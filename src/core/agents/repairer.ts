import { z } from 'zod';
import { AgentOutputError, AgentStepLimitError, runAgent } from '../agent/runtime';
import type { TraceWriter } from '../agent/trace';
import type { AgentMeter } from '../metrics';
import { REPAIR_SYSTEM_PROMPT, repairUserPrompt } from '../prompts/repair';
import { readFileTool } from '../tools/code';
import type { RunJestFn } from '../tools/jest';
import { checkRepairTool, createRepairState, repairRunJestTool, restoreOriginal, writeTestTool } from '../tools/repair';
import { validateImportsTool } from '../tools/validateImports';
import { getWorkspace } from '../tools/workspace';
import type { ContextResult, ExecResult, LLMClient } from '../types';
import type { Diagnosis } from './executor';

export const REPAIRER_AGENT = 'repairer';

export type RepairStatus = 'REPAIRED' | 'SUSPECTED_COMPONENT_BUG' | 'GAVE_UP';

export interface RepairTestOptions {
  ctx: ContextResult;
  workspaceRoot: string;
  testFilePath: string;
  exec: ExecResult;
  diagnosis: Diagnosis;
  llm: LLMClient;
  rules?: string;
  previousAttempts?: string[];
  maxSteps?: number;
  trace?: TraceWriter;
  meter?: AgentMeter;
  /** Injetável para testes; padrão: Jest real do workspace. */
  runJest?: RunJestFn;
}

export interface RepairTestResult {
  status: RepairStatus;
  note: string;
  /** Algum write_test foi aceito (o arquivo mudou). */
  wrote: boolean;
  /** Patches recusados pelo guardrail nesta sessão. */
  rejectedRepairs: number;
  /** Conteúdo do arquivo de teste ao final da sessão. */
  code: string;
  /** REPAIRED alinhando a expectativa ao comportamento observado do componente (sem evidência de defeito). */
  alignedToBehavior: boolean;
  /** Trecho literal (regras/componente) que sustenta SUSPECTED_COMPONENT_BUG. */
  evidence?: string;
}

export const REPAIR_MAX_STEPS = 10;
/** Correções do JSON final permitidas (ex.: `evidence` não literal pode ser corrigida mais de uma vez). */
export const REPAIR_MAX_OUTPUT_REPAIRS = 2;

const finalBase = z.object({
  status: z.enum(['REPAIRED', 'SUSPECTED_COMPONENT_BUG', 'GAVE_UP']),
  note: z.string().min(1),
  evidence: z.string().optional(),
  alignedToBehavior: z.boolean().optional(),
});

/** Espaços em branco (inclusive quebras de linha) colapsados: a evidência continua literal, só não depende de indentação. */
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * SUSPECTED_COMPONENT_BUG só com evidência explícita: `evidence` não vazio e presente literalmente
 * nas regras de negócio ou no código-fonte do componente. Devolve a mensagem de erro, ou null se ok.
 */
export function checkEvidence(evidence: string | undefined, sources: { rules?: string; componentSource: string }): string | null {
  const ev = squash(evidence ?? '');
  const hint =
    'Sem evidência, não é defeito do componente: se o comportamento observado for plausível, alinhe a expectativa a ele com uma asserção ESPECÍFICA ' +
    '(write_test; o guardrail continua valendo) e responda REPAIRED com "alignedToBehavior": true.';
  if (!ev) {
    return `SUSPECTED_COMPONENT_BUG exige "evidence": trecho LITERAL das regras de negócio, de comentário/JSDoc do componente ou de contrato de tipos que sustente a expectativa do teste. ${hint}`;
  }
  const found = [sources.rules ?? '', sources.componentSource].some((src) => squash(src).includes(ev));
  if (!found) {
    return `"evidence" não aparece literalmente nas regras de negócio nem no código do componente: copie o trecho exato (sem parafrasear). ${hint}`;
  }
  return null;
}

/** Agente 05 — Reparador: decide a correção, testa hipóteses e grava via write_test (guardrail na ferramenta). */
export async function repairTest(opts: RepairTestOptions): Promise<RepairTestResult> {
  const { ctx, workspaceRoot, testFilePath, llm } = opts;
  const ws = getWorkspace(workspaceRoot);
  const state = createRepairState(workspaceRoot, ctx, testFilePath);

  const finalSchema = finalBase.superRefine((out, issue) => {
    if (out.status === 'REPAIRED' && state.writes === 0) {
      issue.addIssue({
        code: 'custom',
        path: ['status'],
        message: 'status REPAIRED exige um write_test aceito ({ "written": true }); grave a correção ou use GAVE_UP / SUSPECTED_COMPONENT_BUG',
      });
    }
    if (out.status === 'SUSPECTED_COMPONENT_BUG') {
      const err = checkEvidence(out.evidence, { ...(opts.rules ? { rules: opts.rules } : {}), componentSource: ctx.componentSource });
      if (err) issue.addIssue({ code: 'custom', path: ['evidence'], message: err });
    }
    if (out.alignedToBehavior && out.status !== 'REPAIRED') {
      issue.addIssue({
        code: 'custom',
        path: ['alignedToBehavior'],
        message: '"alignedToBehavior": true só vale com status REPAIRED (a expectativa foi alinhada e gravada com write_test)',
      });
    }
  });

  const result = (status: RepairStatus, note: string, extra: { alignedToBehavior?: boolean; evidence?: string } = {}): RepairTestResult => ({
    status,
    note,
    wrote: state.current !== state.original,
    rejectedRepairs: state.rejectedRepairs,
    code: state.current,
    alignedToBehavior: status === 'REPAIRED' && extra.alignedToBehavior === true,
    ...(extra.evidence ? { evidence: extra.evidence } : {}),
  });

  let output: z.infer<typeof finalBase>;
  try {
    const run = await runAgent({
      name: REPAIRER_AGENT,
      system: REPAIR_SYSTEM_PROMPT,
      input: repairUserPrompt({
        ctx,
        testFilePath,
        testCode: state.current,
        exec: opts.exec,
        diagnosis: opts.diagnosis,
        ...(opts.rules ? { rules: opts.rules } : {}),
        ...(opts.previousAttempts ? { previousAttempts: opts.previousAttempts } : {}),
      }),
      tools: [
        readFileTool(ws),
        repairRunJestTool(state, opts.runJest),
        validateImportsTool(state.ctx, workspaceRoot),
        checkRepairTool(state),
        writeTestTool(state),
      ],
      llm,
      finalSchema,
      temperature: 0.2,
      maxSteps: opts.maxSteps ?? REPAIR_MAX_STEPS,
      maxRepairs: REPAIR_MAX_OUTPUT_REPAIRS,
      ...(opts.trace ? { trace: opts.trace } : {}),
      ...(opts.meter ? { meter: opts.meter } : {}),
    });
    output = run.output;
  } catch (err) {
    if (err instanceof AgentStepLimitError || err instanceof AgentOutputError) {
      return result('GAVE_UP', `O Reparador não concluiu: ${err.message}`);
    }
    throw err;
  }

  if (output.status === 'SUSPECTED_COMPONENT_BUG' && state.current !== state.original) {
    // O código garante: com suspeita de defeito do componente, o teste fica intacto.
    restoreOriginal(state);
    await opts.trace?.write({
      agent: REPAIRER_AGENT,
      step: 0,
      kind: 'final',
      text: 'SUSPECTED_COMPONENT_BUG após write_test: arquivo de teste restaurado ao conteúdo original',
      llmMs: 0,
      ms: 0,
    });
    return result('SUSPECTED_COMPONENT_BUG', `${output.note} (alterações feitas antes da conclusão foram desfeitas)`, {
      ...(output.evidence ? { evidence: output.evidence } : {}),
    });
  }
  return result(output.status, output.note, {
    ...(output.alignedToBehavior !== undefined ? { alignedToBehavior: output.alignedToBehavior } : {}),
    ...(output.status === 'SUSPECTED_COMPONENT_BUG' && output.evidence ? { evidence: output.evidence } : {}),
  });
}
