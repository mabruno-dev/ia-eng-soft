// Formatação textual dos eventos da pipeline (CLI e OutputChannel da extensão).
import type { TraceEntry } from './agent/trace';
import type { PipelineEvent } from './types';

export interface FormatOptions {
  /** Quantos caracteres do "raciocínio" (texto do LLM) mostrar por passo. */
  reasoningChars?: number;
}

const short = (v: unknown, max = 60): string => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  if (s.length <= max) return s;
  return typeof v === 'string' ? `<${s.length} caracteres>` : `${s.slice(0, max)}…`;
};
const oneLine = (s: string, max: number) => {
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length > max ? `${t.slice(0, max)}…` : t;
};

export const formatArgs = (args: Record<string, unknown>) =>
  Object.entries(args)
    .map(([k, v]) => `${k}=${short(v)}`)
    .join(' ');

/** Resumo de uma linha do resultado de uma ferramenta (o trace guarda até 500 caracteres dele). */
export function formatToolResult(name: string, ok: boolean, result: string): string {
  if (!ok) {
    try {
      return `✗ ${(JSON.parse(result) as { error: string }).error.split('\n')[0]}`;
    } catch {
      return `✗ ${result.slice(0, 120)}`;
    }
  }
  const pick = (re: RegExp) => re.exec(result)?.[1];
  switch (name) {
    case 'write_test':
      return /"written":true/.test(result) ? '✓ gravado' : `✗ recusado: ${pick(/"violations":\["([^"]+)/) ?? 'nada a gravar'}`;
    case 'check_repair':
      return /"ok":true/.test(result) ? '✓ guardrail ok' : `✗ ${pick(/"violations":\["([^"]+)/) ?? 'violações'}`;
    case 'ask_user':
      return /"error"/.test(result) ? `✗ ${pick(/"error":"([^"]+)/) ?? 'limite atingido'}` : `→ ${pick(/"answer":"((?:[^"\\]|\\.)*)"/) ?? '?'}`;
    case 'save_rule':
      return `✓ ${pick(/"id":"([^"]+)/) ?? ''} salva`;
    case 'read_rules':
      return `✓ ${(result.match(/"id":"/g) ?? []).length} regra(s)${/"hashChanged":true/.test(result) ? ' (código mudou)' : ''}`;
    case 'validate_imports':
      return /"valid":true/.test(result) ? '✓ imports ok' : `✗ não resolvidos: ${pick(/"unresolved":(\[[^\]]*\])/) ?? ''}`;
    case 'run_jest':
      if (/"passed":true/.test(result)) return `✓ passou (${pick(/"numTests":(\d+)/)} testes)`;
      return /"suiteError"/.test(result) ? '✗ a suíte não rodou' : `✗ ${pick(/"numFailed":(\d+)/)}/${pick(/"numTests":(\d+)/)} falharam`;
    default:
      return '✓';
  }
}

export function formatStep(label: string, e: TraceEntry, opts: FormatOptions = {}): string[] {
  const n = opts.reasoningChars ?? 200;
  const tag = `  [${label}]`;
  switch (e.kind) {
    case 'tool_calls':
      return [
        ...(e.text?.trim() ? [`${tag} 💭 ${oneLine(e.text, n)}`] : []),
        ...(e.tools ?? []).map((t) => `${tag} ${t.name} ${formatArgs(t.args)} → ${formatToolResult(t.name, t.ok, t.result)}`),
      ];
    case 'final':
      return [`${tag} ✔ ${e.text ? oneLine(e.text, Math.max(n, 240)) : 'resposta final'}`];
    case 'invalid_final':
      return [`${tag} ↺ resposta final recusada pela validação: ${(e.error ?? '').split('\n')[0]}`];
    case 'step_limit':
      return [`${tag} ⛔ ${e.error}`];
    case 'warning':
      return [`${tag} ⚠ ${oneLine(e.text ?? '', Math.max(n, 240))}`];
    case 'error':
      return [];
  }
}

/** Linhas de texto para um evento (vazio = nada a mostrar). */
export function formatEvent(e: PipelineEvent, opts: FormatOptions = {}): string[] {
  switch (e.type) {
    case 'stage-start':
      return e.stage === 'record' ? [] : ['', `▶ ${e.label}`];
    case 'stage-end':
      return e.stage === 'record' && e.ok ? [] : [`${e.ok ? '✓' : '✗'} ${e.label} (${(e.ms / 1000).toFixed(1)} s)${e.summary ? ` — ${e.summary}` : ''}`];
    case 'agent-step':
      return formatStep(e.label, e.entry, opts);
    case 'iteration': {
      const h = e.iteration;
      return [
        `  ⟳ iteração ${h.iteration}: [${h.category ?? '—'}] ${oneLine(h.summary, 200)}`,
        `    → ${h.repairStatus}${h.rejectedRepairs ? ` (${h.rejectedRepairs} reparo(s) recusado(s) pelo guardrail)` : ''}: ${oneLine(h.note, 300)}`,
      ];
    }
    case 'error':
      return ['', `✗ Erro: ${e.message}`];
    // Eventos por agente: o terminal já mostra o mesmo conteúdo pelos eventos detalhados acima.
    case 'agent_start':
    case 'tool_call':
    case 'agent_end':
    case 'question':
    case 'result':
      return [];
  }
}
