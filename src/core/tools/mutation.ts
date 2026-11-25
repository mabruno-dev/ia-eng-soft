// Ferramentas do Verificador (06): mutação com o Stryker só no arquivo do componente, usando apenas o
// teste gerado. Os números (score, killed, survived…) vêm do relatório JSON do Stryker, nunca do LLM.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import type { AgentTool } from '../agent/runtime';
import type { ContextResult } from '../types';
import { clip, killTree, stripAnsi } from './jest';
import { canonicalPath, getWorkspace } from './workspace';

export const MUTATION_TIMEOUT_MS = 300_000;
export const MUTATION_CONCURRENCY = 2;
export const MAX_SURVIVORS = 15;
export const SOURCE_LINES_MAX = 60;

export interface SurvivingMutant {
  id: string;
  mutator: string;
  line: number;
  original: string;
  replacement: string;
  status: 'Survived' | 'NoCoverage';
}

export interface MutationCounts {
  /** (killed + timeout) / (killed + timeout + survived + noCoverage), em %, 2 casas. */
  score: number;
  killed: number;
  survived: number;
  timeout: number;
  noCoverage: number;
  /** Mutantes válidos (sem CompileError/RuntimeError/Ignored). */
  total: number;
}

export interface MutationResult extends MutationCounts {
  /** Até 15 sobreviventes (Survived/NoCoverage), os primeiros por linha. */
  survivors: SurvivingMutant[];
  /** Quantos sobreviventes existem no total (a lista é cortada em 15). */
  survivorsTotal: number;
  reportFile: string;
  ms: number;
}

/** Stryker não rodou (ausente, falhou, timeout, relatório ilegível): a pipeline segue com mutação n/d. */
export class MutationInfraError extends Error {
  /** Saída bruta (só para o trace). */
  readonly rawText?: string;
  constructor(message: string, rawText?: string) {
    super(message);
    this.name = 'MutationInfraError';
    if (rawText) this.rawText = rawText;
  }
}

// ---------------------------------------------------------------------------
// Relatório JSON (mutation-testing-report-schema)
// ---------------------------------------------------------------------------

const positionSchema = z.object({ line: z.number(), column: z.number() });
const reportSchema = z.object({
  files: z.record(
    z.string(),
    z.object({
      source: z.string().optional(),
      mutants: z.array(
        z.object({
          id: z.union([z.string(), z.number()]).transform(String),
          mutatorName: z.string(),
          replacement: z.string().optional(),
          status: z.string(),
          location: z.object({ start: positionSchema, end: positionSchema }),
        }),
      ),
    }),
  ),
});

const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
const short = (s: string, max = 120) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
};

/** Trecho original do mutante a partir do `source` do relatório (linhas e colunas 1-based). */
function originalText(source: string | undefined, loc: { start: { line: number; column: number }; end: { line: number; column: number } }): string {
  if (!source) return '';
  const lines = source.split(/\r?\n/);
  const { start, end } = loc;
  if (start.line === end.line) return (lines[start.line - 1] ?? '').slice(start.column - 1, end.column - 1);
  const parts = [(lines[start.line - 1] ?? '').slice(start.column - 1), ...lines.slice(start.line, end.line - 1), (lines[end.line - 1] ?? '').slice(0, end.column - 1)];
  return parts.join('\n');
}

/** Lê o relatório do Stryker e conta os mutantes do componente. Lança MutationInfraError se ilegível. */
export function parseStrykerReport(json: unknown, componentFile: string): Omit<MutationResult, 'reportFile' | 'ms'> {
  const parsed = reportSchema.safeParse(json);
  if (!parsed.success) throw new MutationInfraError(`relatório do Stryker em formato inesperado: ${parsed.error.issues[0]?.message ?? 'inválido'}`);
  const target = norm(componentFile);
  const entries = Object.entries(parsed.data.files);
  const file = entries.find(([k]) => norm(k) === target || norm(k).endsWith(`/${target}`)) ?? (entries.length === 1 ? entries[0] : undefined);
  if (!file) throw new MutationInfraError(`o relatório do Stryker não tem o arquivo ${componentFile}`);
  const [, data] = file;
  const c = { killed: 0, survived: 0, timeout: 0, noCoverage: 0 };
  const survivors: SurvivingMutant[] = [];
  for (const m of data.mutants) {
    if (m.status === 'Killed') c.killed++;
    else if (m.status === 'Timeout') c.timeout++;
    else if (m.status === 'Survived' || m.status === 'NoCoverage') {
      if (m.status === 'Survived') c.survived++;
      else c.noCoverage++;
      survivors.push({
        id: m.id,
        mutator: m.mutatorName,
        line: m.location.start.line,
        original: short(originalText(data.source, m.location)),
        replacement: short(m.replacement ?? ''),
        status: m.status,
      });
    }
    // CompileError, RuntimeError, Ignored, Pending: não entram no score (como no Stryker).
  }
  const total = c.killed + c.timeout + c.survived + c.noCoverage;
  survivors.sort((a, b) => a.line - b.line || a.id.localeCompare(b.id, undefined, { numeric: true }));
  return {
    ...c,
    total,
    score: total ? Math.round(((c.killed + c.timeout) / total) * 10_000) / 100 : 0,
    survivors: survivors.slice(0, MAX_SURVIVORS),
    survivorsTotal: survivors.length,
  };
}

// ---------------------------------------------------------------------------
// Execução do Stryker
// ---------------------------------------------------------------------------

/** Procura `node_modules/@stryker-mutator/core/bin/stryker.js` a partir do workspace, subindo diretórios. */
export function findStrykerBin(workspaceRoot: string): string | undefined {
  let dir = resolve(workspaceRoot);
  while (true) {
    const bin = join(dir, 'node_modules', '@stryker-mutator', 'core', 'bin', 'stryker.js');
    if (existsSync(bin)) return bin;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export interface RunMutationOptions {
  workspaceRoot: string;
  /** Componente (relativo ao workspace): único arquivo mutado. */
  componentFile: string;
  /** Teste gerado (relativo ao workspace): único teste executado. */
  testFile: string;
  runId: string;
  timeoutMs?: number;
  /** Executável do Stryker (padrão: o do workspace). Testes injetam um falso. */
  strykerBin?: string;
  /** Mutators desativados (ex.: ['StringLiteral'] para acelerar). */
  excludedMutations?: string[];
}
export type RunMutationFn = (opts: RunMutationOptions) => Promise<MutationResult>;

const readJson = (p: string): Record<string, unknown> => {
  try {
    const v = JSON.parse(readFileSync(p, 'utf8')) as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

/** Pasta dos artefatos do Stryker de um run (fora do código versionado: `.reactest/` é ignorado). */
export const strykerDir = (workspaceRoot: string, runId: string) => join(workspaceRoot, '.reactest', 'stryker', runId);

/**
 * Config do Stryker para um run: parte do stryker.config.json do workspace (se houver) e força
 * --mutate no componente, só o teste gerado, jest + perTest, concorrência 2, reporter json e
 * temp/relatório em `.reactest/stryker/<runId>`.
 */
export function strykerConfigFor(opts: RunMutationOptions): Record<string, unknown> {
  const base = readJson(join(opts.workspaceRoot, 'stryker.config.json'));
  const baseJest = base.jest && typeof base.jest === 'object' ? (base.jest as Record<string, unknown>) : {};
  const configFile = baseJest.configFile ?? ['jest.config.cjs', 'jest.config.js', 'jest.config.ts', 'jest.config.mjs'].find((f) => existsSync(join(opts.workspaceRoot, f)));
  const rel = `.reactest/stryker/${opts.runId}`;
  const { $schema: _s, mutate: _m, reporters: _r, tempDirName: _t, ...rest } = base;
  return {
    ...rest,
    testRunner: 'jest',
    jest: {
      ...baseJest,
      ...(configFile ? { configFile } : {}),
      // Só o teste gerado (no sandbox do Stryker os caminhos absolutos mudam; o nome do arquivo não).
      config: { testMatch: [`**/${basename(opts.testFile)}`] },
      enableFindRelatedTests: false,
    },
    mutate: [opts.componentFile.replace(/\\/g, '/')],
    reporters: ['json'],
    jsonReporter: { fileName: `${rel}/mutation.json` },
    coverageAnalysis: 'perTest',
    concurrency: MUTATION_CONCURRENCY,
    tempDirName: `${rel}/tmp`,
    cleanTempDir: true,
    incremental: false,
    fileLogLevel: 'off',
    logLevel: 'warn',
    ignorePatterns: ['.reactest', 'coverage', 'dist'],
    ...(opts.excludedMutations?.length ? { mutator: { ...((base.mutator as object) ?? {}), excludedMutations: opts.excludedMutations } } : {}),
  };
}

/** Roda o Stryker e devolve as contagens do relatório. Erros de infraestrutura viram MutationInfraError (pt-BR). */
export async function runMutation(opts: RunMutationOptions): Promise<MutationResult> {
  const root = existsSync(opts.workspaceRoot) ? canonicalPath(opts.workspaceRoot) : opts.workspaceRoot;
  const o = { ...opts, workspaceRoot: root };
  const bin = o.strykerBin ?? findStrykerBin(root);
  if (!bin || !existsSync(bin)) {
    throw new MutationInfraError(`Stryker não encontrado no workspace "${root}" (instale @stryker-mutator/core e @stryker-mutator/jest-runner).`);
  }
  if (!existsSync(join(root, o.testFile))) throw new MutationInfraError(`arquivo de teste não encontrado para a mutação: ${o.testFile}`);
  const dir = strykerDir(root, o.runId);
  await mkdir(dir, { recursive: true });
  const configPath = join(dir, 'stryker.config.json');
  const reportFile = join(dir, 'mutation.json');
  await rm(reportFile, { force: true });
  await writeFile(configPath, JSON.stringify(strykerConfigFor(o), null, 2), 'utf8');

  const timeoutMs = o.timeoutMs ?? MUTATION_TIMEOUT_MS;
  const t0 = performance.now();
  const proc = await new Promise<{ code: number | null; out: string; timedOut: boolean }>((done) => {
    const child = spawn(process.execPath, [bin, 'run', configPath], {
      cwd: root,
      env: { ...process.env, CI: 'true', FORCE_COLOR: '0', NODE_ENV: 'test', ...(process.versions.electron ? { ELECTRON_RUN_AS_NODE: '1' } : {}) },
      windowsHide: true,
      detached: process.platform !== 'win32', // grupo próprio: killTree mata o Stryker e os workers do Jest
    });
    let out = '';
    let timedOut = false;
    const onData = (d: Buffer) => {
      out += d.toString('utf8');
      if (out.length > 200_000) out = out.slice(-100_000);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      done({ code: -1, out: `${out}\n${err.message}`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code, out, timedOut });
    });
  });
  const ms = performance.now() - t0;
  const raw = clip(stripAnsi(proc.out), 8_000);
  await rm(join(dir, 'tmp'), { recursive: true, force: true }).catch(() => undefined);
  if (proc.timedOut) {
    throw new MutationInfraError(`o Stryker excedeu o tempo limite de ${Math.round(timeoutMs / 1000)} s e foi encerrado (reduza os mutators, ex.: excluir StringLiteral).`, raw);
  }
  if (proc.code !== 0 || !existsSync(reportFile)) {
    const lastLine = stripAnsi(proc.out).split(/\r?\n/).map((l) => l.trim()).filter((l) => /error|erro|fail/i.test(l)).at(-1) ?? 'sem relatório gerado';
    throw new MutationInfraError(`o Stryker não concluiu (código ${proc.code ?? 'sinal'}): ${short(lastLine, 200)}`, raw);
  }
  let json: unknown;
  try {
    json = JSON.parse(await readFile(reportFile, 'utf8'));
  } catch (err) {
    throw new MutationInfraError(`relatório do Stryker ilegível: ${err instanceof Error ? err.message : String(err)}`, raw);
  }
  return { ...parseStrykerReport(json, o.componentFile), reportFile, ms };
}

// ---------------------------------------------------------------------------
// Ferramentas do agente
// ---------------------------------------------------------------------------

export interface MutationState {
  ctx: ContextResult;
  workspaceRoot: string;
  testFilePath: string;
  runId: string;
  run: RunMutationFn;
  excludedMutations?: string[];
  timeoutMs?: number;
  /** Último resultado (fonte dos números do RunRecord). */
  last?: MutationResult;
  /** Erro de infraestrutura da última tentativa (mutação fica n/d). */
  error?: MutationInfraError;
  /** Execuções reais do Stryker (a ferramenta reaproveita o resultado: o Stryker é caro). */
  runs: number;
}

export function createMutationState(p: Omit<MutationState, 'runs' | 'last' | 'error'>): MutationState {
  return { ...p, runs: 0 };
}

/** Roda o Stryker uma vez por run (resultado/erro reaproveitado nas chamadas seguintes). */
export async function measureMutation(state: MutationState): Promise<MutationResult> {
  if (state.last) return state.last;
  if (state.error) throw state.error;
  state.runs++;
  try {
    state.last = await state.run({
      workspaceRoot: state.workspaceRoot,
      componentFile: state.ctx.componentPath,
      testFile: state.testFilePath,
      runId: state.runId,
      ...(state.timeoutMs ? { timeoutMs: state.timeoutMs } : {}),
      ...(state.excludedMutations?.length ? { excludedMutations: state.excludedMutations } : {}),
    });
    return state.last;
  } catch (err) {
    state.error = err instanceof MutationInfraError ? err : new MutationInfraError(`o Stryker não rodou: ${err instanceof Error ? err.message : String(err)}`);
    throw state.error;
  }
}

const forLLM = (r: MutationResult) => ({
  score: r.score,
  killed: r.killed,
  survived: r.survived,
  timeout: r.timeout,
  noCoverage: r.noCoverage,
  total: r.total,
  survivorsTotal: r.survivorsTotal,
  survivors: r.survivors,
});

export function runMutationTool(state: MutationState): AgentTool<{ componentFile: string }> {
  return {
    spec: {
      name: 'run_mutation',
      description:
        'Roda o Stryker (mutação) só no arquivo do componente, executando apenas o teste gerado. Devolve score, killed, survived, timeout, noCoverage, total e até 15 mutantes sobreviventes {id, mutator, line, original, replacement}. Demora minutos: chame uma vez.',
      parameters: {
        type: 'object',
        properties: { componentFile: { type: 'string', description: 'arquivo do componente, relativo ao workspace' } },
        required: ['componentFile'],
      },
    },
    argsSchema: z.object({ componentFile: z.string().min(1) }),
    run: async ({ componentFile }) => {
      if (norm(componentFile) !== norm(state.ctx.componentPath)) {
        throw new Error(`run_mutation só muta o componente em teste: ${state.ctx.componentPath}`);
      }
      return forLLM(await measureMutation(state));
    },
  };
}

export function getSurvivingMutantsTool(state: MutationState): AgentTool<Record<string, never>> {
  return {
    spec: {
      name: 'get_surviving_mutants',
      description: 'Relê o último relatório de mutação: até 15 sobreviventes {id, mutator, line, original, replacement}.',
      parameters: { type: 'object', properties: {} },
    },
    argsSchema: z.object({}).strict() as unknown as z.ZodType<Record<string, never>>,
    run: async () => {
      if (!state.last) throw new Error(state.error ? `sem relatório: ${state.error.message}` : 'nenhum relatório ainda: chame run_mutation primeiro');
      return { survivorsTotal: state.last.survivorsTotal, survivors: state.last.survivors };
    },
  };
}

/** Trecho de um arquivo do fecho do Contexto (componente + dependências), com números de linha. */
export function readSourceLinesTool(state: MutationState): AgentTool<{ file: string; from: number; to: number }> {
  const ws = getWorkspace(state.workspaceRoot);
  const allowed = new Set([state.ctx.componentPath, ...state.ctx.dependencies.map((d) => d.path)].map(norm));
  return {
    spec: {
      name: 'read_source_lines',
      description: `Lê as linhas [from, to] (1-based, no máximo ${SOURCE_LINES_MAX}) de um arquivo do componente ou de suas dependências.`,
      parameters: {
        type: 'object',
        properties: {
          file: { type: 'string', description: 'arquivo relativo ao workspace (componente ou dependência)' },
          from: { type: 'integer', minimum: 1 },
          to: { type: 'integer', minimum: 1 },
        },
        required: ['file', 'from', 'to'],
      },
    },
    argsSchema: z.object({ file: z.string().min(1), from: z.number().int().min(1), to: z.number().int().min(1) }),
    run: async ({ file, from, to }) => {
      const abs = ws.abs(file);
      const rel = ws.rel(abs);
      if (!allowed.has(norm(rel))) throw new Error(`${file} não pertence ao componente nem às suas dependências (fecho do Contexto)`);
      if (to < from) throw new Error('"to" deve ser >= "from"');
      const end = Math.min(to, from + SOURCE_LINES_MAX - 1);
      const lines = (await readFile(abs, 'utf8')).split(/\r?\n/);
      return {
        file: rel,
        from,
        to: Math.min(end, lines.length),
        lines: lines.slice(from - 1, end).map((l, i) => `${from + i}: ${l}`).join('\n'),
      };
    },
  };
}
