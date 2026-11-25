import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import type { AgentTool } from '../agent/runtime';
import { stripCodeFences } from '../agents/generator';
import { checkRepair } from '../guardrail';
import { validateImports } from '../importValidator';
import type { ContextResult, ExecResult } from '../types';
import { execForLLM, type RunJestFn, runJest } from './jest';
import { getWorkspace } from './workspace';

/** Execuções de run_jest permitidas por sessão do Reparador (atual + hipóteses). */
export const REPAIR_MAX_RUNS = 4;

/**
 * Estado compartilhado pelas ferramentas de uma sessão do Reparador.
 * `current` é sempre o conteúdo do arquivo de teste em disco; só `write_test` o altera.
 */
export interface RepairState {
  readonly workspaceRoot: string;
  readonly ctx: ContextResult; // testFilePath já é o arquivo reparado
  /** Conteúdo do arquivo no início da sessão (para restaurar, se preciso). */
  readonly original: string;
  current: string;
  writes: number;
  rejectedRepairs: number;
  runs: number;
  lastExec?: ExecResult;
}

export function createRepairState(workspaceRoot: string, ctx: ContextResult, testFilePath: string): RepairState {
  const ws = getWorkspace(workspaceRoot);
  const abs = ws.abs(testFilePath);
  if (!existsSync(abs)) throw new Error(`Arquivo de teste não encontrado: ${testFilePath}`);
  const content = readFileSync(abs, 'utf8');
  return { workspaceRoot, ctx: { ...ctx, testFilePath }, original: content, current: content, writes: 0, rejectedRepairs: 0, runs: 0 };
}

/** Restaura o arquivo de teste ao conteúdo do início da sessão. */
export function restoreOriginal(state: RepairState): void {
  writeFileSync(getWorkspace(state.workspaceRoot).abs(state.ctx.testFilePath), state.original, 'utf8');
  state.current = state.original;
}

const codeParam = {
  type: 'object',
  properties: { code: { type: 'string', description: 'Código COMPLETO do novo arquivo de teste' } },
  required: ['code'],
  additionalProperties: false,
} as const;
const codeArgs = z.object({ code: z.string().min(1) });

/** Guardrail completo de um patch: oráculo (checkRepair) + imports (validateImports). */
export function guardPatch(state: RepairState, code: string) {
  const oracle = checkRepair(state.current, code);
  const imports = validateImports(code, state.ctx, state.workspaceRoot);
  const violations = [
    ...oracle.violations,
    ...imports.unresolved.map((u) => `import não resolvido na linha ${u.line}: "${u.specifier}" (use apenas allowedImports / caminhos devolvidos pelas ferramentas)`),
  ];
  return { ok: violations.length === 0, violations, oracle, imports };
}

/** `check_repair({ code })`: dry-run de checkRepair(codigoAtual, code). Não grava nada. */
export function checkRepairTool(state: RepairState): AgentTool<{ code: string }> {
  return {
    spec: {
      name: 'check_repair',
      description:
        'Dry-run do guardrail do oráculo: compara o código proposto com o arquivo de teste atual e lista as violações ' +
        '(asserções apagadas, testes apagados/pulados, .skip/.only/.todo, asserção específica trocada por trivial). Não grava.',
      parameters: codeParam,
    },
    argsSchema: codeArgs,
    run: async ({ code }) => checkRepair(state.current, stripCodeFences(code)),
  };
}

/**
 * `write_test({ code })`: grava o arquivo de teste SOMENTE se checkRepair e validateImports passarem.
 * Cada recusa incrementa `rejectedRepairs`. A imposição é da ferramenta: o LLM não consegue contorná-la.
 */
export function writeTestTool(state: RepairState): AgentTool<{ code: string }> {
  const ws = getWorkspace(state.workspaceRoot);
  return {
    spec: {
      name: 'write_test',
      description:
        'Grava o novo código do arquivo de teste. Só grava se passar no guardrail do oráculo (check_repair) e na validação de imports; ' +
        'caso contrário devolve { written: false, violations } e o arquivo NÃO é alterado (a recusa é contabilizada).',
      parameters: codeParam,
    },
    argsSchema: codeArgs,
    run: async ({ code: raw }) => {
      const code = stripCodeFences(raw);
      if (code === state.current) return { written: false, violations: [], note: 'código idêntico ao arquivo atual; nada a gravar' };
      const g = guardPatch(state, code);
      if (!g.ok) {
        state.rejectedRepairs++;
        return { written: false, violations: g.violations, rejectedRepairs: state.rejectedRepairs };
      }
      writeFileSync(ws.abs(state.ctx.testFilePath), code, 'utf8');
      state.current = code;
      state.writes++;
      return { written: true, path: state.ctx.testFilePath };
    },
  };
}

function draftPath(testFilePath: string): string {
  const m = /^(.*?)(\.(?:test|spec))?(\.[cm]?[jt]sx?)$/.exec(testFilePath);
  if (!m) return `${testFilePath}.reactest-draft.test.tsx`;
  return `${m[1]}.reactest-draft${m[2] ?? '.test'}${m[3]}`;
}

/**
 * `run_jest` do Reparador: roda o arquivo de teste atual, ou — com `code` — um rascunho gravado num arquivo
 * temporário ao lado do teste (mesmos caminhos relativos), para testar uma hipótese sem alterar o teste.
 */
export function repairRunJestTool(state: RepairState, runner: RunJestFn = (root, a) => runJest(root, a)): AgentTool<{ code?: string; runInBand?: boolean; testNamePattern?: string }> {
  const ws = getWorkspace(state.workspaceRoot);
  return {
    spec: {
      name: 'run_jest',
      description:
        'Executa o Jest. Sem "code", roda o arquivo de teste atual. Com "code", roda esse rascunho num arquivo temporário ao lado do teste ' +
        `(testa uma hipótese sem gravar). Máximo de ${REPAIR_MAX_RUNS} execuções por sessão.`,
      parameters: {
        type: 'object',
        properties: {
          code: { type: 'string', description: 'Rascunho completo do arquivo de teste (opcional)' },
          runInBand: { type: 'boolean' },
          testNamePattern: { type: 'string' },
        },
        additionalProperties: false,
      },
    },
    argsSchema: z.object({ code: z.string().min(1).optional(), runInBand: z.boolean().optional(), testNamePattern: z.string().min(1).optional() }),
    run: async ({ code, runInBand, testNamePattern }) => {
      if (state.runs >= REPAIR_MAX_RUNS) throw new Error(`limite de ${REPAIR_MAX_RUNS} execuções de run_jest atingido nesta sessão`);
      state.runs++;
      const extra = { ...(runInBand !== undefined ? { runInBand } : {}), ...(testNamePattern ? { testNamePattern } : {}) };
      const componentFile = state.ctx.componentPath;
      if (!code) {
        const exec = await runner(state.workspaceRoot, { testFile: state.ctx.testFilePath, componentFile, ...extra });
        state.lastExec = exec;
        return { target: 'arquivo atual', ...execForLLM(exec) };
      }
      const draft = draftPath(state.ctx.testFilePath);
      const abs = ws.abs(draft);
      writeFileSync(abs, stripCodeFences(code), 'utf8');
      try {
        const exec = await runner(state.workspaceRoot, { testFile: draft, componentFile, ...extra });
        return { target: 'rascunho (não gravado)', ...execForLLM(exec) };
      } finally {
        rmSync(abs, { force: true });
      }
    },
  };
}
