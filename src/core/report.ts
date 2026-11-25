import { AGENT_LABELS } from './pipeline';
import type { RunRecord } from './types';

const STATUS_TEXT: Record<RunRecord['status'], string> = {
  PASSED: '✅ PASSED — a suíte gerada passou',
  FAILED: '❌ FAILED — a suíte não passou dentro do limite de iterações',
  SUSPECTED_COMPONENT_BUG: '⚠️ SUSPECTED_COMPONENT_BUG — o componente pode ter um defeito (o teste NÃO foi alterado)',
  ERROR: '💥 ERROR — a execução foi interrompida por um erro',
};

const ms = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${Math.round(v)} ms`);
const pct = (v: number) => `${Number.isInteger(v) ? v : v.toFixed(2)}%`;
const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

export function componentName(record: RunRecord): string {
  return record.component.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, '');
}

/** Relatório Markdown de uma execução (gravado pela extensão em .reactest/reports/<Componente>.md). */
export function renderReport(record: RunRecord): string {
  const c = record.coverage;
  const lines = [
    `# ReacTest-Agent — ${componentName(record)}`,
    '',
    `**Status:** ${STATUS_TEXT[record.status]}`,
    '',
    `- Componente: \`${record.component}\``,
    ...(record.testFilePath ? [`- Teste: \`${record.testFilePath}\``] : []),
    `- Execução: \`${record.runId}\` (\`.reactest/runs/${record.runId}.json\`)`,
    `- Configuração: heal=${record.config.heal}, elicit=${record.config.elicit}, verify=${record.config.verify}, ` +
      `maxIterations=${record.config.maxIterations}, maxAgentSteps=${record.config.maxAgentSteps}, ` +
      `${record.config.provider}${record.config.model ? `/${record.config.model}` : ''}`,
    ...(record.error ? ['', `> **Erro:** ${record.error}`] : []),
    '',
    '## Self-healing',
    '',
    `Iterações de reparo: **${record.iterations}** · reparos recusados pelo guardrail: **${record.rejectedRepairs}** · ` +
      `taxa de modificação: **${(record.modificationRate * 100).toFixed(1)}%** (${record.generated.lines} → ${record.final.lines} linhas)`,
    '',
  ];
  if (record.history?.length) {
    lines.push('| # | Categoria da falha | Diagnóstico | Reparo | Recusas |', '|---|---|---|---|---|');
    for (const h of record.history) {
      lines.push(`| ${h.iteration} | ${h.category ?? '—'} | ${cell(h.summary)} | **${h.repairStatus}**: ${cell(h.reasoning)} | ${h.rejectedRepairs} |`);
    }
  } else {
    lines.push(record.config.heal ? '_Nenhum reparo foi necessário._' : '_Self-healing desativado (baseline)._');
  }
  lines.push(
    '',
    '## Cobertura do componente',
    '',
    '| Statements | Branches | Functions | Lines |',
    '|---|---|---|---|',
    `| ${pct(c.statements)} | ${pct(c.branches)} | ${pct(c.functions)} | ${pct(c.lines)} |`,
    '',
    '## Custo',
    '',
    `Chamadas ao LLM: **${record.llm.calls}** · tokens de entrada: **${record.llm.inputTokens}** · tokens de saída: **${record.llm.outputTokens}** · tempo total: **${ms(record.timings.totalMs)}**`,
    '',
    '| Agente | Passos | Ferramentas |',
    '|---|---|---|',
    ...Object.entries(record.agents).map(([a, s]) => `| ${AGENT_LABELS[a] ?? a} | ${s.steps} | ${s.toolCalls} |`),
    '',
    '| Etapa | Tempo |',
    '|---|---|',
    ...Object.entries(record.timings.perAgentMs).map(([a, v]) => `| ${AGENT_LABELS[a] ?? a} | ${ms(v)} |`),
    '',
  );
  return lines.join('\n');
}
