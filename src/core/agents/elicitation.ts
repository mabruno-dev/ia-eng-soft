import { z } from 'zod';
import { AgentOutputError, AgentStepLimitError, runAgent } from '../agent/runtime';
import type { TraceWriter } from '../agent/trace';
import type { AgentMeter } from '../metrics';
import { ELICITATION_SYSTEM_PROMPT, elicitationUserPrompt } from '../prompts/elicitation';
import {
  askUserTool,
  createElicitationState,
  DEFAULT_MAX_QUESTIONS,
  type ElicitationState,
  readRulesTool,
  type Rule,
  saveRuleTool,
  SKIPPED,
} from '../tools/rules';
import type { Asker, ContextResult, LLMClient } from '../types';

export const ELICITATION_AGENT = 'elicitation';

export interface ElicitRulesOptions {
  ctx: ContextResult;
  workspaceRoot: string;
  llm: LLMClient;
  asker: Asker;
  maxQuestions?: number;
  /** Padrão: max(8, 2 × maxQuestions + 4) — cada pergunta tende a custar um passo de ask_user e outro de save_rule. */
  maxSteps?: number;
  trace?: TraceWriter;
  meter?: AgentMeter;
}

export interface ElicitationStats {
  questions: number; // perguntas feitas ao dev (contadas pela ferramenta)
  answered: number; // perguntas respondidas (não puladas)
  reused: number; // regras reaproveitadas de .reactest/rules.md
}

export interface ElicitRulesResult {
  rules: Rule[];
  /** Regras numeradas para o Gerador ("- R1: pergunta → resposta"). Vazio = nenhuma regra. */
  rulesText: string;
  stats: ElicitationStats;
}

const ruleSchema = z.object({
  id: z.string().regex(/^R\d+$/, 'ids R1, R2, ...'),
  question: z.string().min(1),
  answer: z.string().min(1),
});

export function renderRulesText(rules: Rule[]): string {
  return rules.map((r) => `- ${r.id}: ${r.question.trim()} → ${r.answer.trim()}`).join('\n');
}

function stats(state: ElicitationState, rules: Rule[]): ElicitationStats {
  const stored = new Map(state.stored.map((r) => [r.id, r]));
  return {
    questions: state.asked.length,
    answered: state.asked.filter((a) => a.answer !== SKIPPED).length,
    reused: rules.filter((r) => !state.saved.has(r.id) && stored.get(r.id)?.answer === r.answer).length,
  };
}

/** Agente 02 — Elicitação: o LLM decide o que perguntar; as ferramentas perguntam, limitam e persistem; o código confere a procedência. */
export async function elicitRules(opts: ElicitRulesOptions): Promise<ElicitRulesResult> {
  const { ctx, workspaceRoot, llm } = opts;
  const maxQuestions = opts.maxQuestions ?? DEFAULT_MAX_QUESTIONS;
  const state = createElicitationState({ workspaceRoot, component: ctx.componentPath, componentSource: ctx.componentSource, asker: opts.asker, maxQuestions });

  const finalSchema = z.object({ rules: z.array(ruleSchema) }).superRefine((out, issue) => {
    if (!state.readCalled) issue.addIssue({ code: 'custom', path: ['rules'], message: 'chame read_rules antes de concluir (reaproveite o que já foi respondido)' });
    const ids = new Set<string>();
    const stored = new Map(state.stored.map((r) => [r.id, r]));
    out.rules.forEach((r, i) => {
      if (ids.has(r.id)) issue.addIssue({ code: 'custom', path: ['rules', i, 'id'], message: `id ${r.id} repetido` });
      ids.add(r.id);
      if (r.answer.trim() === SKIPPED) issue.addIssue({ code: 'custom', path: ['rules', i, 'answer'], message: 'pergunta pulada não é regra; remova-a' });
      // Procedência: a regra precisa vir do dev (salva nesta sessão ou lida de rules.md).
      const saved = state.saved.get(r.id);
      const fromStore = stored.get(r.id);
      if (!(saved && saved.answer === r.answer) && !(fromStore && fromStore.answer === r.answer)) {
        issue.addIssue({
          code: 'custom',
          path: ['rules', i],
          message: `${r.id} não foi salva com save_rule nesta sessão nem lida por read_rules com esta resposta; salve-a (com a resposta do dev) ou remova-a`,
        });
      }
    });
  });

  let rules: Rule[];
  try {
    const run = await runAgent({
      name: ELICITATION_AGENT,
      system: ELICITATION_SYSTEM_PROMPT,
      input: elicitationUserPrompt(ctx, maxQuestions),
      tools: [readRulesTool(state), askUserTool(state), saveRuleTool(state)],
      llm,
      finalSchema,
      maxRepairs: 2,
      maxSteps: opts.maxSteps ?? Math.max(8, 2 * maxQuestions + 4),
      temperature: 0.2,
      ...(opts.trace ? { trace: opts.trace } : {}),
      ...(opts.meter ? { meter: opts.meter } : {}),
    });
    rules = run.output.rules;
  } catch (err) {
    if (!(err instanceof AgentStepLimitError || err instanceof AgentOutputError)) throw err;
    // Não perde o que o dev respondeu: usa as regras salvas nesta sessão + as reaproveitáveis do arquivo.
    const merged = new Map(state.stored.map((r) => [r.id, r]));
    for (const r of state.saved.values()) merged.set(r.id, r);
    rules = [...merged.values()];
    await opts.trace?.write({
      agent: ELICITATION_AGENT,
      step: 0,
      kind: 'warning',
      text: `a Elicitação não concluiu (${err.message}); usando ${rules.length} regra(s) salvas/lidas`,
      llmMs: 0,
      ms: 0,
    });
  }

  rules = [...rules].sort((a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1)));
  return { rules, rulesText: renderRulesText(rules), stats: stats(state, rules) };
}
