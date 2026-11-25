import { z } from 'zod';
import { runAgent } from '../agent/runtime';
import type { TraceWriter } from '../agent/trace';
import type { AgentMeter } from '../metrics';
import { VERIFIER_MAX_SUGGESTIONS, VERIFIER_SYSTEM_PROMPT, verifierUserPrompt } from '../prompts/verifier';
import {
  createMutationState,
  getSurvivingMutantsTool,
  measureMutation,
  type MutationCounts,
  type MutationResult,
  type RunMutationFn,
  readSourceLinesTool,
  runMutation as defaultRunMutation,
  runMutationTool,
  type SurvivingMutant,
} from '../tools/mutation';
import type { ContextResult, LLMClient, VerifierSuggestion } from '../types';

export const VERIFIER_AGENT = 'verifier';
export const VERIFIER_MAX_STEPS = 6;

/** full: agente (Stryker + sugestões); measure: só o Stryker, sem LLM (baseline C1). */
export type VerifierMode = 'full' | 'measure';

export interface VerifyTestOptions {
  ctx: ContextResult;
  workspaceRoot: string;
  testFilePath: string;
  testCode: string;
  runId: string;
  llm: LLMClient;
  mode?: VerifierMode;
  maxSteps?: number;
  trace?: TraceWriter;
  meter?: AgentMeter;
  /** Injetável para testes; padrão: Stryker real do workspace. */
  runMutation?: RunMutationFn;
  excludedMutations?: string[];
  mutationTimeoutMs?: number;
}

export interface VerifyTestResult {
  /** Números lidos do relatório do Stryker; undefined = n/d (Stryker não rodou). */
  mutation?: MutationCounts;
  suggestions: VerifierSuggestion[];
  /** Sugestões descartadas pelo código (mutantId inexistente ou acima do limite). */
  discarded: number;
  /** Erro de infraestrutura da mutação ou do agente (o run segue). */
  error?: string;
}

const suggestionSchema = z.object({
  mutantId: z.union([z.string(), z.number()]).transform(String),
  line: z.number().int().optional(),
  description: z.string().min(1).max(400),
  suggestedAssertion: z.string().min(1).max(600),
});
const finalSchema = z.object({ suggestions: z.array(suggestionSchema).max(10) });

/**
 * Mantém só sugestões ligadas a mutantes devolvidos pela ferramenta (no máximo 3, sem ids repetidos).
 * A linha vem do mutante (número da ferramenta), não do texto do LLM.
 */
export function filterSuggestions(raw: z.infer<typeof suggestionSchema>[], survivors: SurvivingMutant[]): { kept: VerifierSuggestion[]; discarded: number } {
  const byId = new Map(survivors.map((m) => [m.id, m]));
  const kept: VerifierSuggestion[] = [];
  const seen = new Set<string>();
  for (const s of raw) {
    const m = byId.get(s.mutantId);
    if (!m || seen.has(m.id) || kept.length >= VERIFIER_MAX_SUGGESTIONS) continue;
    seen.add(m.id);
    kept.push({ mutantId: m.id, line: m.line, mutator: m.mutator, description: s.description.trim(), suggestedAssertion: s.suggestedAssertion.trim() });
  }
  return { kept, discarded: raw.length - kept.length };
}

const counts = (r: MutationResult): MutationCounts => ({
  score: r.score,
  killed: r.killed,
  survived: r.survived,
  timeout: r.timeout,
  noCoverage: r.noCoverage,
  total: r.total,
});

/**
 * Agente 06 — Verificador. Mede a suíte com mutação e sugere até 3 casos que faltam.
 * Nunca lança e nunca altera o teste: erro de infraestrutura do Stryker → mutation undefined (n/d).
 */
export async function verifyTest(opts: VerifyTestOptions): Promise<VerifyTestResult> {
  const state = createMutationState({
    ctx: opts.ctx,
    workspaceRoot: opts.workspaceRoot,
    testFilePath: opts.testFilePath,
    runId: opts.runId,
    run: opts.runMutation ?? defaultRunMutation,
    ...(opts.excludedMutations ? { excludedMutations: opts.excludedMutations } : {}),
    ...(opts.mutationTimeoutMs ? { timeoutMs: opts.mutationTimeoutMs } : {}),
  });
  let suggestions: VerifierSuggestion[] = [];
  let discarded = 0;
  let agentError: string | undefined;

  if ((opts.mode ?? 'full') === 'full') {
    try {
      const run = await runAgent({
        name: VERIFIER_AGENT,
        system: VERIFIER_SYSTEM_PROMPT,
        input: verifierUserPrompt(opts.ctx, opts.testFilePath, opts.testCode),
        tools: [runMutationTool(state), readSourceLinesTool(state), getSurvivingMutantsTool(state)],
        llm: opts.llm,
        finalSchema,
        temperature: 0.2,
        maxSteps: opts.maxSteps ?? VERIFIER_MAX_STEPS,
        maxRepairs: 1,
        ...(opts.trace ? { trace: opts.trace } : {}),
        ...(opts.meter ? { meter: opts.meter } : {}),
      });
      ({ kept: suggestions, discarded } = filterSuggestions(run.output.suggestions, state.last?.survivors ?? []));
      if (discarded) {
        await opts.trace?.write({
          agent: VERIFIER_AGENT,
          step: 0,
          kind: 'warning',
          text: `${discarded} sugestão(ões) descartada(s) (mutantId inexistente, repetido ou acima do limite de ${VERIFIER_MAX_SUGGESTIONS})`,
          llmMs: 0,
          ms: 0,
        });
      }
    } catch (err) {
      agentError = `o Verificador não concluiu: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // O código garante a medição: se o agente não chamou run_mutation (ou no modo measure), roda aqui.
  if (!state.last && !state.error) {
    try {
      await measureMutation(state);
    } catch {
      /* fica em state.error */
    }
  }
  if (state.error) {
    await opts.trace?.write({
      agent: VERIFIER_AGENT,
      step: 0,
      kind: 'warning',
      text: `mutação n/d: ${state.error.message}`,
      ...(state.error.rawText ? { error: state.error.rawText } : {}),
      llmMs: 0,
      ms: 0,
    });
  }
  const error = state.error ? `mutação n/d: ${state.error.message}` : agentError;
  return {
    ...(state.last ? { mutation: counts(state.last) } : {}),
    suggestions: state.last ? suggestions : [],
    discarded,
    ...(error ? { error } : {}),
  };
}
