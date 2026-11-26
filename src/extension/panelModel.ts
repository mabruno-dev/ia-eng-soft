// Mapeamento PURO evento da pipeline → mensagem do painel / textos de progresso e barra de status.
// Não importa `vscode` (testado com vitest). Todo texto passa por redactSecrets antes de chegar à UI.
import { PIPELINE_AGENTS } from '../core/events';
import type { AgentId, PipelineConfig, PipelineEvent, RunRecord, VerifierSuggestion } from '../core/types';
import { redactSecrets } from '../llm/claudeCli';

export type AgentState = 'waiting' | 'running' | 'done' | 'error' | 'skipped';
export type ResultTone = 'success' | 'warning' | 'error';

export type PanelMessage =
  | {
      kind: 'init';
      component: string;
      provider: string;
      model: string;
      flags: string;
      agents: { id: AgentId; label: string; index: number }[];
    }
  | { kind: 'agent'; agent: AgentId; label: string; index: number; total: number; state: AgentState; ms?: number; summary?: string }
  | { kind: 'tool'; agent: AgentId; tool: string; args: string; ok: boolean; summary: string }
  | { kind: 'question'; id: string; text: string; why: string; counter: string }
  | { kind: 'question_closed'; id: string; answer?: string; via: 'panel' | 'inputBox' }
  | { kind: 'iteration'; n: number; category: string; summary: string }
  | {
      kind: 'result';
      status: RunRecord['status'];
      tone: ResultTone;
      headline: string;
      note?: string;
      metrics: { label: string; value: string }[];
      suggestions: { title: string; description: string; assertion: string }[];
      hasTest: boolean;
      error?: string;
    }
  | { kind: 'error'; message: string };

/** Mensagens do webview para a extensão. */
export type PanelInbound =
  | { type: 'ready' }
  | { type: 'answer'; id: string; text: string }
  | { type: 'skip'; id: string }
  | { type: 'openTest' }
  | { type: 'openTrace' };

const MAX_TEXT = 400;
const clean = (s: string, max = MAX_TEXT) => {
  const t = redactSecrets(s).trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
};

const num = (n: number) => n.toLocaleString('pt-BR');
const seconds = (ms: number) => `${(ms / 1000).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} s`;
const pct = (n: number) => `${n.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`;

export function initMessage(o: { component: string; config: PipelineConfig }): PanelMessage {
  const { config } = o;
  const flags = [
    `cura ${config.heal ? `ligada (máx. ${config.maxIterations})` : 'desligada'}`,
    `elicitação ${config.elicit ? 'ligada' : 'desligada'}`,
    `Verificador ${config.verify ? 'ligado' : 'desligado'}`,
  ].join(' · ');
  return {
    kind: 'init',
    component: clean(o.component),
    provider: config.provider,
    model: clean(config.model || 'padrão'),
    flags,
    agents: PIPELINE_AGENTS.map((a, i) => ({ id: a.id, label: a.label, index: i + 1 })),
  };
}

const STATE_OF = { done: 'done', error: 'error', skipped: 'skipped' } as const;

const RESULT_TEXT: Record<RunRecord['status'], { tone: ResultTone; headline: string; note?: string }> = {
  PASSED: { tone: 'success', headline: 'PASSED · a suíte gerada passou' },
  SUSPECTED_COMPONENT_BUG: {
    tone: 'warning',
    headline: 'SUSPECTED_COMPONENT_BUG · possível defeito no componente',
    note: 'O teste NÃO foi alterado: o Reparador encontrou evidência de que o componente não cumpre a expectativa. Revise o componente.',
  },
  FAILED: { tone: 'error', headline: 'FAILED · a suíte não passou dentro do limite de iterações' },
  ERROR: { tone: 'error', headline: 'ERROR · a execução falhou' },
};

function suggestionView(s: VerifierSuggestion) {
  return {
    title: `Mutante ${clean(s.mutantId, 20)} · ${clean(s.mutator, 40)} · linha ${s.line}`,
    description: clean(s.description),
    assertion: clean(s.suggestedAssertion),
  };
}

/** Evento da pipeline → mensagem do painel (undefined = o painel ignora o evento). */
export function eventToMessage(e: PipelineEvent): PanelMessage | undefined {
  switch (e.type) {
    case 'agent_start':
      return { kind: 'agent', agent: e.agent, label: e.label, index: e.index, total: e.total, state: 'running' };
    case 'agent_end':
      return { kind: 'agent', agent: e.agent, label: e.label, index: e.index, total: e.total, state: STATE_OF[e.status], ms: e.ms, summary: clean(e.summary) };
    case 'tool_call':
      return { kind: 'tool', agent: e.agent, tool: e.tool, args: clean(e.argsSummary, 160), ok: e.ok, summary: clean(e.summary, 200) };
    case 'question':
      return { kind: 'question', id: e.id, text: clean(e.text), why: clean(e.why), counter: e.total ? `Pergunta ${e.index} de ${e.total}` : `Pergunta ${e.index}` };
    case 'iteration':
      return { kind: 'iteration', n: e.n, category: e.category ?? 'sem categoria', summary: clean(e.summary) };
    case 'result': {
      const t = RESULT_TEXT[e.status];
      const m = e.mutation;
      const mutation = m
        ? `${pct(m.score)} (${m.killed}${m.timeout ? ` + ${m.timeout} timeout` : ''}/${m.total ?? m.killed + m.survived + m.timeout})`
        : 'n/d';
      const c = e.coverage;
      const metrics = [
        { label: 'Iterações de cura', value: String(e.iterations) },
        { label: 'Cobertura', value: `branches ${pct(c.branches)} · linhas ${pct(c.lines)}` },
        { label: 'Mutação', value: mutation },
        { label: 'Tokens', value: `${num(e.tokens.input)} entrada · ${num(e.tokens.output)} saída${e.tokens.estimated ? ' (estimados)' : ''}` },
        { label: 'Tempo', value: seconds(e.ms) },
        ...(e.costUsd !== undefined ? [{ label: 'Custo', value: `US$ ${e.costUsd.toFixed(4)}` }] : []),
      ];
      return {
        kind: 'result',
        status: e.status,
        tone: t.tone,
        headline: t.headline,
        ...(t.note ? { note: t.note } : {}),
        metrics,
        suggestions: e.suggestions.map(suggestionView),
        hasTest: !!e.testFilePath,
        ...(e.error ? { error: clean(e.error) } : {}),
      };
    }
    case 'error':
      return { kind: 'error', message: clean(e.message) };
    default:
      return undefined;
  }
}

/** Texto da notificação de progresso ("Agente 3/6 · Gerador"); undefined = não muda. */
export function progressMessage(e: PipelineEvent): string | undefined {
  switch (e.type) {
    case 'agent_start':
      return `Agente ${e.index}/${e.total} · ${e.label}`;
    case 'tool_call':
      return `Agente ${PIPELINE_AGENTS.findIndex((a) => a.id === e.agent) + 1}/${PIPELINE_AGENTS.length} · ${e.label} · ${e.tool}`;
    case 'question':
      return `Agente 2/${PIPELINE_AGENTS.length} · Elicitação · aguardando resposta (${e.total ? `${e.index} de ${e.total}` : e.index})`;
    case 'iteration':
      return `Cura · iteração ${e.n}${e.category ? ` (${e.category})` : ''}`;
    case 'result':
      return `Concluído: ${e.status}`;
    default:
      return undefined;
  }
}

/** Texto da barra de status ("ReacTest: Gerador…"); undefined = não muda. */
export function statusBarText(e: PipelineEvent): { text: string; tooltip: string } | undefined {
  switch (e.type) {
    case 'agent_start':
      return { text: `$(sync~spin) ReacTest: ${e.label}…`, tooltip: `Agente ${e.index}/${e.total} · ${e.label} (clique para abrir o painel)` };
    case 'question':
      return { text: '$(comment-discussion) ReacTest: pergunta…', tooltip: 'A Elicitação aguarda sua resposta no painel' };
    case 'result': {
      const icon = e.status === 'PASSED' ? '$(pass)' : e.status === 'SUSPECTED_COMPONENT_BUG' ? '$(warning)' : '$(error)';
      return { text: `${icon} ReacTest: ${e.status}`, tooltip: 'Resultado da última geração (clique para abrir o painel)' };
    }
    default:
      return undefined;
  }
}
