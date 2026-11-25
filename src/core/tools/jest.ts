import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import type { AgentTool } from '../agent/runtime';
import type { Coverage, ExecResult, JestFailure } from '../types';
import { getWorkspace } from './workspace';

export const JEST_TIMEOUT_MS = 120_000;
export const RAW_OUTPUT_MAX = 20_000;
/** Quanto da saída bruta vai para o LLM (o ExecResult completo fica com o código). */
export const RAW_OUTPUT_FOR_LLM = 3_000;

export interface RunJestArgs {
  testFile: string; // relativo à raiz do workspace
  componentFile: string; // relativo à raiz do workspace
  runInBand?: boolean;
  testNamePattern?: string;
}
export type RunJestFn = (workspaceRoot: string, args: RunJestArgs) => Promise<ExecResult>;

export class JestNotFoundError extends Error {
  constructor(workspaceRoot: string) {
    super(
      `Jest não encontrado no workspace "${workspaceRoot}". Instale-o (ex.: npm install --save-dev jest ts-jest jest-environment-jsdom) e tente novamente.`,
    );
    this.name = 'JestNotFoundError';
  }
}

const ZERO_COVERAGE: Coverage = { statements: 0, branches: 0, functions: 0, lines: 0 };

// eslint-disable-next-line no-control-regex
const ANSI_RE = /[\u001b\u009b][[()#;?]*(?:\d{1,4}(?:;\d{0,4})*)?[0-9A-ORZcf-nqry=><]/g;
export const stripAnsi = (s: string): string => s.replace(ANSI_RE, '');

/** Remove códigos ANSI e frames de stack trace internos (node_modules / runtime do Node). */
export function cleanMessage(s: string): string {
  return stripAnsi(s)
    .split(/\r?\n/)
    .filter((l) => !/^\s+at\s/.test(l) || !/node_modules|node:internal|\(<anonymous>\)|\(native\)/.test(l))
    .join('\n')
    .trim();
}

/** Mantém o começo e o fim de uma saída longa (o fim costuma ter o resumo do Jest). */
export function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.4);
  const tail = max - head;
  return `${s.slice(0, head)}\n… [${s.length - max} caracteres omitidos] …\n${s.slice(-tail)}`;
}

/** Procura `node_modules/jest/bin/jest.js` a partir do workspace, subindo diretórios. */
export function findJestBin(workspaceRoot: string): string | undefined {
  let dir = resolve(workspaceRoot);
  while (true) {
    const bin = join(dir, 'node_modules', 'jest', 'bin', 'jest.js');
    if (existsSync(bin)) return bin;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

// ---- Parse do JSON do Jest ----

interface JestJson {
  success?: boolean;
  numTotalTests?: number;
  numFailedTests?: number;
  numRuntimeErrorTestSuites?: number;
  testResults?: {
    name?: string;
    status?: string;
    message?: string;
    assertionResults?: { fullName?: string; title?: string; status?: string; failureMessages?: string[] }[];
  }[];
}
type CoverageSummary = Record<string, Record<'statements' | 'branches' | 'functions' | 'lines', { pct: number | string }>>;

const normPath = (p: string) => {
  const n = resolve(p).replace(/\\/g, '/');
  return process.platform === 'win32' ? n.toLowerCase() : n;
};
const pct = (v: { pct: number | string } | undefined) => (typeof v?.pct === 'number' && Number.isFinite(v.pct) ? v.pct : 0);

/** Cobertura do componente no coverage-summary.json (zeros se ausente). */
export function coverageFor(summary: CoverageSummary | undefined, componentAbs: string): Coverage {
  if (!summary) return { ...ZERO_COVERAGE };
  const target = normPath(componentAbs);
  const key = Object.keys(summary).find((k) => k !== 'total' && normPath(k) === target);
  const entry = key ? summary[key] : undefined;
  if (!entry) return { ...ZERO_COVERAGE };
  return { statements: pct(entry.statements), branches: pct(entry.branches), functions: pct(entry.functions), lines: pct(entry.lines) };
}

/** Converte o JSON do Jest (+ cobertura) em ExecResult. */
export function parseJestJson(json: JestJson, coverage: Coverage, rawOutput: string): ExecResult {
  const failures: JestFailure[] = [];
  const suiteErrors: string[] = [];
  for (const suite of json.testResults ?? []) {
    const assertions = suite.assertionResults ?? [];
    for (const a of assertions) {
      if (a.status !== 'failed') continue;
      failures.push({
        testName: a.fullName || a.title || '(sem nome)',
        message: cleanMessage((a.failureMessages ?? []).join('\n')),
      });
    }
    // Suíte que falhou sem nenhuma asserção falha: erro de compilação/import (nenhum teste rodou).
    if (suite.status === 'failed' && !assertions.some((a) => a.status === 'failed') && suite.message) {
      suiteErrors.push(cleanMessage(suite.message));
    }
  }
  const numTests = json.numTotalTests ?? 0;
  const numFailed = json.numFailedTests ?? failures.length;
  const suiteError = suiteErrors.length ? suiteErrors.join('\n\n') : undefined;
  return {
    passed: !suiteError && numFailed === 0 && numTests > 0 && json.success !== false,
    numTests,
    numFailed,
    failures,
    ...(suiteError ? { suiteError } : {}),
    coverage,
    rawOutput,
  };
}

// ---- Execução ----

function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => undefined);
  } else {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* já terminou */
      }
    }
  }
}

export interface RunJestOptions {
  timeoutMs?: number;
}

/**
 * Executa o Jest do workspace para um arquivo de teste e devolve o ExecResult.
 * Ferramenta determinística: nenhum número aqui vem do LLM.
 */
export async function runJest(workspaceRoot: string, args: RunJestArgs, opts: RunJestOptions = {}): Promise<ExecResult> {
  const ws = getWorkspace(workspaceRoot);
  const testAbs = ws.abs(args.testFile); // confinado ao workspace
  const componentAbs = ws.abs(args.componentFile);
  if (!existsSync(testAbs)) throw new Error(`Arquivo de teste não encontrado: ${args.testFile}`);
  const jestBin = findJestBin(ws.root);
  if (!jestBin) throw new JestNotFoundError(ws.root);

  const tmp = await mkdtemp(join(tmpdir(), 'reactest-jest-'));
  const outFile = join(tmp, 'result.json');
  const covDir = join(tmp, 'coverage');
  const componentRel = ws.rel(componentAbs).replace(/\\/g, '/');
  const cliArgs = [
    jestBin,
    '--runTestsByPath',
    testAbs,
    '--coverage',
    `--collectCoverageFrom=${componentRel}`,
    '--coverageReporters=json-summary',
    `--coverageDirectory=${covDir}`,
    '--json',
    `--outputFile=${outFile}`,
    '--silent',
    '--ci',
    '--watchman=false',
    ...(args.runInBand ? ['--runInBand'] : []),
    ...(args.testNamePattern ? ['--testNamePattern', args.testNamePattern] : []),
  ];
  const timeoutMs = opts.timeoutMs ?? JEST_TIMEOUT_MS;

  try {
    const { output, timedOut } = await new Promise<{ output: string; timedOut: boolean }>((done, fail) => {
      const child = spawn(process.execPath, cliArgs, {
        cwd: ws.root,
        env: { ...process.env, CI: 'true', FORCE_COLOR: '0', NODE_ENV: 'test' },
        windowsHide: true,
        detached: process.platform !== 'win32',
      });
      let out = '';
      const onData = (b: Buffer) => {
        out += b.toString('utf8');
        if (out.length > RAW_OUTPUT_MAX * 4) out = out.slice(-RAW_OUTPUT_MAX * 2);
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        killTree(child.pid);
      }, timeoutMs);
      child.on('error', (err) => {
        clearTimeout(timer);
        fail(err);
      });
      child.on('close', () => {
        clearTimeout(timer);
        done({ output: out, timedOut });
      });
    });

    const rawOutput = clip(stripAnsi(output), RAW_OUTPUT_MAX);
    if (timedOut) {
      return {
        passed: false,
        numTests: 0,
        numFailed: 0,
        failures: [],
        suiteError: `Timeout: o Jest excedeu o tempo limite de ${Math.round(timeoutMs / 1000)}s e o processo foi encerrado (possível loop infinito, promessa nunca resolvida ou teste travado).`,
        coverage: { ...ZERO_COVERAGE },
        rawOutput,
      };
    }

    let json: JestJson | undefined;
    try {
      json = JSON.parse(await readFile(outFile, 'utf8')) as JestJson;
    } catch {
      json = undefined;
    }
    if (!json) {
      return {
        passed: false,
        numTests: 0,
        numFailed: 0,
        failures: [],
        suiteError: `O Jest terminou sem produzir o relatório JSON. Saída:\n${clip(rawOutput, 4000)}`,
        coverage: { ...ZERO_COVERAGE },
        rawOutput,
      };
    }

    let summary: CoverageSummary | undefined;
    try {
      summary = JSON.parse(await readFile(join(covDir, 'coverage-summary.json'), 'utf8')) as CoverageSummary;
    } catch {
      summary = undefined;
    }
    return parseJestJson(json, coverageFor(summary, componentAbs), rawOutput);
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** ExecResult resumido para o LLM: rawOutput cortado para caber no limite de resultado de ferramenta. */
export function execForLLM(exec: ExecResult): ExecResult {
  return {
    ...exec,
    failures: exec.failures.map((f) => ({ ...f, message: clip(f.message, 1500) })),
    ...(exec.suiteError ? { suiteError: clip(exec.suiteError, 2500) } : {}),
    rawOutput: clip(exec.rawOutput, RAW_OUTPUT_FOR_LLM),
  };
}

export const runJestArgsSchema = z.object({
  testFile: z.string().min(1),
  componentFile: z.string().min(1),
  runInBand: z.boolean().optional(),
  testNamePattern: z.string().min(1).optional(),
});

/**
 * Ferramenta `run_jest`. `runner` é injetável (testes); `onResult` recebe o ExecResult
 * COMPLETO de cada execução, para o código guardar o último (regra 4).
 */
export function runJestTool(
  workspaceRoot: string,
  opts: { runner?: RunJestFn; onResult?: (exec: ExecResult, args: RunJestArgs) => void } = {},
): AgentTool<RunJestArgs> {
  const runner = opts.runner ?? ((root, args) => runJest(root, args));
  return {
    spec: {
      name: 'run_jest',
      description:
        'Executa o Jest do workspace para um arquivo de teste, com cobertura do componente. Devolve { passed, numTests, numFailed, failures[{testName, message}], suiteError?, coverage, rawOutput }. suiteError indica que a suíte nem rodou (compilação/import). Timeout de 120s.',
      parameters: {
        type: 'object',
        properties: {
          testFile: { type: 'string', description: 'Arquivo de teste, relativo à raiz do workspace' },
          componentFile: { type: 'string', description: 'Componente testado (para a cobertura), relativo à raiz do workspace' },
          runInBand: { type: 'boolean', description: 'Roda em um único processo (útil contra flakiness/timeout por concorrência)' },
          testNamePattern: { type: 'string', description: 'Regex para rodar só os testes cujo nome casa (opcional)' },
        },
        required: ['testFile', 'componentFile'],
        additionalProperties: false,
      },
    },
    argsSchema: runJestArgsSchema as z.ZodType<RunJestArgs>,
    run: async (args) => {
      const exec = await runner(workspaceRoot, args);
      opts.onResult?.(exec, args);
      return execForLLM(exec);
    },
  };
}
