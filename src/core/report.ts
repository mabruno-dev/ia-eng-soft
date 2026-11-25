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

/** "Mutação: score X% (killed/total), N sugestões" — ou o motivo de n/d. */
export function mutationLine(record: RunRecord): string {
  const m = record.mutation;
  const n = record.verification?.suggestions.length ?? 0;
  if (!m) {
    const why = !record.config.verify ? 'Verificador desligado' : record.status !== 'PASSED' ? 'só é medida com a suíte passando' : record.verification?.error ?? 'Stryker não rodou';
    return `Mutação: n/d (${why})`;
  }
  const detected = m.timeout ? `${m.killed} mortos + ${m.timeout} timeout` : `${m.killed}`;
  return `Mutação: score ${pct(m.score)} (${detected}/${m.total ?? m.killed + m.survived + m.timeout}), ${n} sugestão(ões)`;
}

/** Sugestões do Verificador, uma por linha (vazio se não houver). */
export function suggestionLines(record: RunRecord): string[] {
  return (record.verification?.suggestions ?? []).map(
    (s, i) => `${i + 1}. [mutante ${s.mutantId} · ${s.mutator} · linha ${s.line}] ${s.description}
   → ${s.suggestedAssertion}`,
  );
}

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
      `expectativas alinhadas ao comportamento observado: **${record.alignedToBehavior ?? 0}** · ` +
      `taxa de modificação: **${(record.modificationRate * 100).toFixed(1)}%** (${record.generated.lines} → ${record.final.lines} linhas)`,
    '',
  ];
  if (record.history?.length) {
    lines.push('| # | Categoria da falha | Diagnóstico | Reparo | Recusas |', '|---|---|---|---|---|');
    for (const h of record.history) {
      lines.push(`| ${h.iteration} | ${h.category ?? '—'} | ${cell(h.summary)} | **${h.repairStatus}**${h.alignedToBehavior ? ' (alinhado ao comportamento)' : ''}: ${cell(h.note)} | ${h.rejectedRepairs} |`);
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
    '## Mutação (Verificador)',
    '',
    mutationLine(record),
    ...(record.mutation ? ['', `Sobreviventes: ${record.mutation.survived} · sem cobertura: ${record.mutation.noCoverage ?? 0} · timeout: ${record.mutation.timeout}`] : []),
    ...(record.verification?.suggestions.length
      ? [
          '',
          '| Mutante | Linha | Caso que falta | Asserção sugerida |',
          '|---|---|---|---|',
          ...record.verification.suggestions.map((s) => `| ${s.mutantId} (${s.mutator}) | ${s.line} | ${cell(s.description)} | \`${cell(s.suggestedAssertion)}\` |`),
          '',
          '_Sugestões não são aplicadas automaticamente ao teste._',
        ]
      : []),
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
