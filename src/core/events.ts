// Eventos por agente (agent_start / tool_call / agent_end): metadados e conversão de passos do trace.
// Sem `vscode`: consumidos pelo CLI, pela extensão (painel, barra de status, progresso) e pelos testes.
import type { TraceEntry } from './agent/trace';
import { formatArgs, formatToolResult } from './progressFormat';
import type { AgentId, PipelineEvent } from './types';

/** Os 6 agentes na ordem fixa do orquestrador (índice 1-based = posição na linha do tempo). */
export const PIPELINE_AGENTS: readonly { id: AgentId; label: string }[] = [
  { id: 'context', label: 'Contexto' },
  { id: 'elicitation', label: 'Elicitação' },
  { id: 'generator', label: 'Gerador' },
  { id: 'executor', label: 'Executor' },
  { id: 'repairer', label: 'Reparador' },
  { id: 'verifier', label: 'Verificador' },
];

export const agentIndex = (id: AgentId) => PIPELINE_AGENTS.findIndex((a) => a.id === id) + 1;
export const agentLabel = (id: AgentId) => PIPELINE_AGENTS.find((a) => a.id === id)!.label;

/** Tag técnica do LLM/trace (ex.: 'generator.plan') → agente da pipeline; undefined para 'pipeline' etc. */
export function agentOf(tag: string): AgentId | undefined {
  const base = tag.split('.')[0];
  return PIPELINE_AGENTS.find((a) => a.id === base)?.id;
}

const clip = (s: string, max: number) => {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length > max ? `${t.slice(0, max)}…` : t;
};

/** Um evento tool_call por ferramenta chamada num passo do trace. */
export function toolCallEvents(entry: TraceEntry): PipelineEvent[] {
  const agent = agentOf(entry.agent);
  if (!agent || entry.kind !== 'tool_calls' || !entry.tools?.length) return [];
  return entry.tools.map((t) => {
    const formatted = formatToolResult(t.name, t.ok, t.result);
    return {
      type: 'tool_call' as const,
      agent,
      label: agentLabel(agent),
      tool: t.name,
      argsSummary: clip(formatArgs(t.args), 160),
      // "✓ passou (15 testes)" → ok=true, summary="passou (15 testes)"
      ok: t.ok && !formatted.startsWith('✗'),
      summary: clip(formatted.replace(/^[✓✗→]\s*/, ''), 200),
    };
  });
}
