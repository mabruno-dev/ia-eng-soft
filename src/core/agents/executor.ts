import { z } from 'zod';
import { type AgentTool, runAgent } from '../agent/runtime';
import type { TraceWriter } from '../agent/trace';
import { type CrossCheck, crossCheckCategory } from '../guardrail';
import type { AgentMeter } from '../metrics';
import { EXECUTOR_MAX_RERUNS, EXECUTOR_SYSTEM_PROMPT, executorUserPrompt } from '../prompts/executor';
import { readFileTool } from '../tools/code';
import { type RunJestArgs, type RunJestFn, runJestTool } from '../tools/jest';
import { getWorkspace } from '../tools/workspace';
import type { ContextResult, ExecResult, FailureCategory, LLMClient } from '../types';

export const EXECUTOR_AGENT = 'executor';
/** 1 execução + até EXECUTOR_MAX_RERUNS reexecuções. */
export const EXECUTOR_MAX_RUNS = 1 + EXECUTOR_MAX_RERUNS;

export interface Diagnosis {
  category: FailureCategory | null;
  summary: string;
  flaky: boolean;
}

export interface ExecuteTestsOptions {
  ctx: ContextResult;
  workspaceRoot: string;
  testFilePath: string;
  llm: LLMClient;
  maxSteps?: number;
  trace?: TraceWriter;
  meter?: AgentMeter;
  /** Injetável para testes; padrão: Jest real do workspace. */
  runJest?: RunJestFn;
}

export interface ExecuteTestsResult {
  exec: ExecResult;
  diagnosis: Diagnosis;
  /** Verificação cruzada da categoria do LLM contra o regex de `classifyFailure`. */
  crossCheck: CrossCheck;
  runs: number;
}

const categorySchema = z.enum(['IMPORT', 'MOCK', 'ASYNC', 'ASSERTION', 'SYNTAX_TYPE', 'UNKNOWN']);
const diagnosisSchema = z.object({
  category: categorySchema.nullable(),
  summary: z.string().min(1),
  flaky: z.boolean().default(false),
});

const samePath = (a: string, b: string) => a.replace(/\\/g, '/').replace(/^\.\//, '') === b.replace(/\\/g, '/').replace(/^\.\//, '');

/** Agente 04 — Executor: roda o Jest via ferramenta, decide reexecuções e diagnostica. */
export async function executeTests(opts: ExecuteTestsOptions): Promise<ExecuteTestsResult> {
  const { ctx, workspaceRoot, testFilePath, llm } = opts;
  const ws = getWorkspace(workspaceRoot);

  // Regra 4: o ExecResult vem SEMPRE da última chamada real de run_jest, guardada aqui.
  const execs: ExecResult[] = [];
  const base = runJestTool(workspaceRoot, {
    ...(opts.runJest ? { runner: opts.runJest } : {}),
    onResult: (exec) => execs.push(exec),
  });
  const runJest: AgentTool<RunJestArgs> = {
    ...base,
    run: async (args) => {
      // O código garante: só o arquivo de teste e o componente desta execução, e no máximo N execuções.
      if (!samePath(args.testFile, testFilePath)) {
        throw new Error(`testFile deve ser "${testFilePath}" (recebido "${args.testFile}")`);
      }
      if (!samePath(args.componentFile, ctx.componentPath)) {
        throw new Error(`componentFile deve ser "${ctx.componentPath}" (recebido "${args.componentFile}")`);
      }
      if (execs.length >= EXECUTOR_MAX_RUNS) {
        throw new Error(`limite de ${EXECUTOR_MAX_RUNS} execuções atingido (1 + ${EXECUTOR_MAX_RERUNS} reexecuções); responda o JSON final`);
      }
      return base.run(args);
    },
  };

  const finalSchema = diagnosisSchema.superRefine((_d, issue) => {
    if (execs.length === 0) {
      issue.addIssue({ code: 'custom', path: ['category'], message: 'chame a ferramenta run_jest antes de responder' });
    }
  });

  const run = await runAgent({
    name: EXECUTOR_AGENT,
    system: EXECUTOR_SYSTEM_PROMPT,
    input: executorUserPrompt(ctx, testFilePath),
    tools: [runJest, readFileTool(ws)],
    llm,
    finalSchema,
    temperature: 0,
    ...(opts.maxSteps !== undefined ? { maxSteps: opts.maxSteps } : {}),
    ...(opts.trace ? { trace: opts.trace } : {}),
    ...(opts.meter ? { meter: opts.meter } : {}),
  });

  const exec = execs.at(-1)!;
  const crossCheck = crossCheckCategory(run.output.category, exec);
  // flaky só é crível se houve reexecução com resultados diferentes.
  const observedFlaky = new Set(execs.map((e) => `${e.passed}|${e.numFailed}|${e.suiteError ? 1 : 0}`)).size > 1;
  const diagnosis: Diagnosis = {
    category: crossCheck.final,
    summary: run.output.summary,
    flaky: run.output.flaky ? execs.length > 1 : observedFlaky,
  };
  if (crossCheck.note || diagnosis.flaky !== run.output.flaky) {
    const notes = [crossCheck.note, diagnosis.flaky !== run.output.flaky ? `flaky do LLM (${run.output.flaky}) ajustado para ${diagnosis.flaky}` : undefined];
    await opts.trace?.write({
      agent: EXECUTOR_AGENT,
      step: run.steps,
      kind: 'final',
      text: `verificação cruzada: ${notes.filter(Boolean).join('; ')}`,
      llmMs: 0,
      ms: 0,
    });
  }
  return { exec, diagnosis, crossCheck, runs: execs.length };
}
