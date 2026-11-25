import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { TraceWriter } from './agent/trace';
import { type Diagnosis, executeTests } from './agents/executor';
import { type RepairStatus, type RepairTestOptions, type RepairTestResult, repairTest } from './agents/repairer';
import type { AgentMeter } from './metrics';
import type { RunJestFn } from './tools/jest';
import { getWorkspace } from './tools/workspace';
import type { ContextResult, ExecResult, FailureCategory, LLMClient } from './types';

export type HealStatus = 'PASSED' | 'FAILED' | 'SUSPECTED_COMPONENT_BUG';
/** A mesma assinatura de erro em N execuções consecutivas encerra o loop. */
export const REPEATED_ERROR_LIMIT = 3;

export type StopReason = 'PASSED' | 'MAX_ITERATIONS' | 'REPEATED_ERROR' | 'SUSPECTED_COMPONENT_BUG' | 'GAVE_UP';

export interface HealIteration {
  iteration: number; // 1-based: nº do reparo
  category: FailureCategory | null;
  summary: string;
  signature: string;
  numTests: number;
  numFailed: number;
  repairStatus: RepairStatus;
  reasoning: string;
  rejectedRepairs: number; // recusas do guardrail nesta iteração
  wrote: boolean;
  /** O Reparador alinhou a expectativa ao comportamento observado (sem evidência de defeito). */
  alignedToBehavior: boolean;
}

export interface HealResult {
  status: HealStatus;
  stopReason: StopReason;
  finalCode: string;
  iterations: number;
  rejectedRepairs: number;
  /** Nº de iterações em que a expectativa foi alinhada ao comportamento observado. */
  alignedToBehavior: number;
  history: HealIteration[];
  modificationRate: number;
  /** Última execução do Executor (números das ferramentas). */
  exec: ExecResult;
  diagnosis: Diagnosis;
}

export type ExecuteFn = (o: { iteration: number }) => Promise<{ exec: ExecResult; diagnosis: Diagnosis }>;
export type RepairFn = (o: RepairTestOptions) => Promise<RepairTestResult>;

export interface HealLoopOptions {
  ctx: ContextResult;
  workspaceRoot: string;
  /** Padrão: ctx.testFilePath. */
  testFilePath?: string;
  /** Código gerado pelo Gerador (03); é gravado no arquivo de teste no início. */
  generatedCode: string;
  llm: LLMClient;
  maxIterations: number;
  rules?: string;
  maxSteps?: number;
  trace?: TraceWriter;
  meter?: AgentMeter;
  /** Jest injetável (usado pelo Executor e Reparador padrão). */
  runJest?: RunJestFn;
  /** Executor injetável (padrão: agente 04). */
  execute?: ExecuteFn;
  /** Reparador injetável (padrão: agente 05). */
  repair?: RepairFn;
  /** Chamado ao fim de cada iteração de reparo (progresso). */
  onIteration?: (h: HealIteration) => void;
}

// ---- Funções puras ----

/** Primeira linha significativa da falha (pula "● Test suite failed to run" e linhas vazias). */
export function firstErrorLine(exec: ExecResult): string {
  const text = exec.suiteError ?? exec.failures[0]?.message ?? '';
  const line = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith('●'));
  return line ?? '';
}

/** Assinatura de erro: categoria + teste que falhou + primeira linha da mensagem. */
export function errorSignature(exec: ExecResult, category: FailureCategory | null): string {
  return `${category ?? 'NONE'}|${exec.failures[0]?.testName ?? ''}|${firstErrorLine(exec)}`;
}

const toLines = (s: string) => {
  const lines = s.replace(/\r\n/g, '\n').split('\n').map((l) => l.trimEnd());
  while (lines.length && lines.at(-1) === '') lines.pop();
  return lines;
};

/** Diff linha a linha (LCS). changed = max(adicionadas, removidas): uma linha substituída conta uma vez. */
export function lineDiff(before: string, after: string): { added: number; removed: number; changed: number } {
  const a = toLines(before);
  const b = toLines(after);
  const m = a.length;
  const n = b.length;
  let prev = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    const cur = new Array<number>(n + 1).fill(0);
    for (let j = 1; j <= n; j++) cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
    prev = cur;
  }
  const lcs = prev[n]!;
  const added = n - lcs;
  const removed = m - lcs;
  return { added, removed, changed: Math.max(added, removed) };
}

/** RQ2: linhas alteradas pelo healing / linhas do código gerado inicial (4 casas decimais). */
export function modificationRate(generated: string, final: string): number {
  const total = toLines(generated).length;
  if (total === 0) return 0;
  return Math.round((lineDiff(generated, final).changed / total) * 10_000) / 10_000;
}

/**
 * Garante que o arquivo de teste em disco é o que esta execução gravou por último. Se ele sumiu ou foi alterado
 * por fora (outro processo no mesmo workspace), regrava `code` e devolve o aviso; senão devolve undefined.
 */
export function syncTestFile(abs: string, code: string): string | undefined {
  const onDisk = existsSync(abs) ? readFileSync(abs, 'utf8') : undefined;
  if (onDisk === code) return undefined;
  writeFileSync(abs, code, 'utf8');
  return onDisk === undefined
    ? 'o arquivo de teste sumiu durante a execução (outro processo?); regravado com a última versão desta execução'
    : 'o arquivo de teste foi alterado por fora durante a execução (outro processo?); restaurada a última versão desta execução';
}

// ---- Loop ----

/**
 * Self-healing: Executor → passou? fim → Reparador → (SUSPECTED_COMPONENT_BUG? para) → Executor → ...
 * até maxIterations reparos. Para cedo se a mesma assinatura de erro aparecer em REPEATED_ERROR_LIMIT (3) execuções seguidas.
 * Cada reparo recebe `previousAttempts`: o que os reparos anteriores tentaram e se a falha persistiu.
 */
export async function healLoop(opts: HealLoopOptions): Promise<HealResult> {
  const { ctx, workspaceRoot, llm } = opts;
  const testFilePath = opts.testFilePath ?? ctx.testFilePath;
  const abs = getWorkspace(workspaceRoot).abs(testFilePath);
  writeFileSync(abs, opts.generatedCode, 'utf8');

  const common = {
    ...(opts.maxSteps !== undefined ? { maxSteps: opts.maxSteps } : {}),
    ...(opts.trace ? { trace: opts.trace } : {}),
    ...(opts.meter ? { meter: opts.meter } : {}),
    ...(opts.runJest ? { runJest: opts.runJest } : {}),
  };
  const execute: ExecuteFn = opts.execute ?? (() => executeTests({ ctx, workspaceRoot, testFilePath, llm, ...common }));
  const repair: RepairFn = opts.repair ?? repairTest;
  // Última versão do teste gravada por ESTA execução: antes de cada Executor/Reparador o disco é conferido contra ela.
  let currentCode = opts.generatedCode;
  const ensureFile = async () => {
    const warning = syncTestFile(abs, currentCode);
    if (warning) await opts.trace?.write({ agent: 'healLoop', step: 0, kind: 'warning', text: `${warning}: ${testFilePath}`, llmMs: 0, ms: 0 });
  };

  const history: HealIteration[] = [];
  const previousAttempts: string[] = [];
  let rejectedRepairs = 0;
  let iterations = 0;
  let prevSignature: string | undefined;
  let sameSignatureCount = 0;
  let stopReason: StopReason;
  let status: HealStatus;
  await ensureFile();
  let { exec, diagnosis } = await execute({ iteration: 0 });

  while (true) {
    if (exec.passed) {
      [status, stopReason] = ['PASSED', 'PASSED'];
      break;
    }
    const signature = errorSignature(exec, diagnosis.category);
    sameSignatureCount = signature === prevSignature ? sameSignatureCount + 1 : 1;
    if (previousAttempts.length) {
      // resultado do último reparo, visto na reexecução
      previousAttempts[previousAttempts.length - 1] += signature === prevSignature ? ' ⇒ a MESMA falha persistiu.' : ` ⇒ a falha mudou para: ${firstErrorLine(exec)}`;
    }
    prevSignature = signature;
    if (sameSignatureCount >= REPEATED_ERROR_LIMIT) {
      [status, stopReason] = ['FAILED', 'REPEATED_ERROR'];
      break;
    }
    if (iterations >= opts.maxIterations) {
      [status, stopReason] = ['FAILED', 'MAX_ITERATIONS'];
      break;
    }

    iterations++;
    await ensureFile();
    const r = await repair({
      ctx,
      workspaceRoot,
      testFilePath,
      exec,
      diagnosis,
      llm,
      ...(opts.rules ? { rules: opts.rules } : {}),
      ...(previousAttempts.length ? { previousAttempts: [...previousAttempts] } : {}),
      ...common,
    });
    rejectedRepairs += r.rejectedRepairs;
    currentCode = r.code;
    history.push({
      iteration: iterations,
      category: diagnosis.category,
      summary: diagnosis.summary,
      signature,
      numTests: exec.numTests,
      numFailed: exec.numFailed,
      repairStatus: r.status,
      reasoning: r.reasoning,
      rejectedRepairs: r.rejectedRepairs,
      wrote: r.wrote,
      alignedToBehavior: r.alignedToBehavior,
    });
    opts.onIteration?.(history.at(-1)!);
    previousAttempts.push(
      `iteração ${iterations} [${diagnosis.category ?? '-'}] ${firstErrorLine(exec)} → ${r.status}${r.alignedToBehavior ? ' (alinhado ao comportamento)' : ''}: ${r.reasoning}`,
    );

    if (r.status === 'SUSPECTED_COMPONENT_BUG') {
      [status, stopReason] = ['SUSPECTED_COMPONENT_BUG', 'SUSPECTED_COMPONENT_BUG'];
      break;
    }
    if (!r.wrote) {
      // Nada mudou no arquivo: reexecutar daria o mesmo resultado.
      [status, stopReason] = ['FAILED', 'GAVE_UP'];
      break;
    }
    await ensureFile();
    ({ exec, diagnosis } = await execute({ iteration: iterations }));
  }

  const finalCode = readFileSync(abs, 'utf8');
  return {
    status,
    stopReason,
    finalCode,
    iterations,
    rejectedRepairs,
    alignedToBehavior: history.filter((h) => h.alignedToBehavior).length,
    history,
    modificationRate: modificationRate(opts.generatedCode, finalCode),
    exec,
    diagnosis,
  };
}
