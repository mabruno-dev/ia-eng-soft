// Agregação da avaliação: funções puras sobre RunRecords → runs.csv e summary.md.
// Regra: nenhum número é inventado. Métrica ausente no RunRecord = "n/d" no markdown e célula vazia no CSV.
import type { RunRecord } from '../types';
import { CONFIG_DESCRIPTIONS, CONFIG_LABELS, type ConfigLabel } from './config';

export interface EvalRun {
  config: ConfigLabel;
  repetition: number; // 1-based
  record: RunRecord;
}

export interface SummaryMeta {
  date: string;
  workspace: string;
  model: string;
  runsPerConfig: number;
  maxIterations: number;
  maxAgentSteps: number;
  answersFile?: string;
  components: string[]; // caminhos dos componentes, na ordem da configuração
}

export const ND = 'n/d';
export const MANUAL = 'a preencher manualmente';

/** Ordem de exibição dos agentes conhecidos; outros vêm depois, em ordem alfabética. */
export const AGENT_ORDER = ['context', 'elicitation', 'generator.plan', 'generator.code', 'executor', 'repairer', 'verifier'];
const AGENT_NAMES: Record<string, string> = {
  context: 'Contexto',
  elicitation: 'Elicitação',
  generator: 'Gerador',
  'generator.plan': 'Gerador/plano',
  'generator.code': 'Gerador/código',
  executor: 'Executor',
  repairer: 'Reparador',
  verifier: 'Verificador',
};
const TIME_ORDER = ['context', 'elicitation', 'generator', 'executor', 'repairer', 'verifier'];

export function componentName(path: string): string {
  return path.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, '');
}

// ---- Estatística ----

export interface Stat { n: number; mean: number; sd: number }

/** Média e desvio-padrão amostral (n−1) dos valores definidos; null se não houver nenhum. */
export function stat(values: (number | undefined | null)[]): Stat | null {
  const xs = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (xs.length === 0) return null;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const sd = xs.length > 1 ? Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / (xs.length - 1)) : 0;
  return { n: xs.length, mean, sd };
}

/** Número em pt-BR (vírgula decimal, sem separador de milhar). */
export function num(v: number, decimals = 1): string {
  const fixed = v.toFixed(decimals);
  return (fixed === `-${(0).toFixed(decimals)}` ? (0).toFixed(decimals) : fixed).replace('.', ',');
}

/** "média" (n=1) ou "média ± dp" (n>1); "n/d" quando não há valores. */
export function fmtStat(s: Stat | null, opts: { decimals?: number; suffix?: string; scale?: number } = {}): string {
  if (!s) return ND;
  const { decimals = 1, suffix = '', scale = 1 } = opts;
  const m = `${num(s.mean * scale, decimals)}${suffix}`;
  return s.n > 1 ? `${m} ± ${num(s.sd * scale, decimals)}${suffix}` : m;
}

// ---- Extratores (undefined = métrica ausente) ----

const ok = (r: RunRecord) => r.status !== 'ERROR';

export const metrics = {
  passed: (r: RunRecord) => (r.status === 'PASSED' ? 1 : 0),
  itersToSuccess: (r: RunRecord) => (r.status === 'PASSED' ? r.iterations : undefined),
  rejectedRepairs: (r: RunRecord) => r.rejectedRepairs,
  // RunRecords anteriores ao campo não o têm: n/d, não 0.
  alignedToBehavior: (r: RunRecord) => (typeof r.alignedToBehavior === 'number' ? r.alignedToBehavior : undefined),
  modificationRate: (r: RunRecord) => (ok(r) && r.generated.lines > 0 ? r.modificationRate : undefined),
  mutationScore: (r: RunRecord) => r.mutation?.score,
  branches: (r: RunRecord) => (ok(r) ? r.coverage.branches : undefined),
  lines: (r: RunRecord) => (ok(r) ? r.coverage.lines : undefined),
  questions: (r: RunRecord) => r.elicitation?.questions,
  answered: (r: RunRecord) => r.elicitation?.answered,
  derivedCases: (r: RunRecord) => r.elicitation?.derivedCases,
  inputTokens: (r: RunRecord) => r.llm.inputTokens,
  outputTokens: (r: RunRecord) => r.llm.outputTokens,
  llmCalls: (r: RunRecord) => r.llm.calls,
  totalMs: (r: RunRecord) => r.timings.totalMs,
};

/** O agente rodou neste registro (tem passos registrados pelo runtime)? `generator` cobre `generator.*`. */
function agentRan(r: RunRecord, agent: string): boolean {
  return Object.keys(r.agents).some((k) => k === agent || k.startsWith(`${agent}.`));
}

/**
 * Passos/tool calls de um agente num grupo de runs: se o agente não rodou em NENHUM run do grupo → n/d;
 * senão, runs em que ele não rodou contam 0 (ex.: Reparador quando o teste passou de primeira).
 */
export function agentStat(runs: RunRecord[], agent: string, field: 'steps' | 'toolCalls'): Stat | null {
  if (!runs.some((r) => r.agents[agent])) return null;
  return stat(runs.map((r) => r.agents[agent]?.[field] ?? 0));
}

/** Tempo de um agente: só conta runs em que ele de fato rodou (estágios no-op não viram "0 s"). */
export function agentTimeStat(runs: RunRecord[], agent: string): Stat | null {
  return stat(runs.map((r) => (agentRan(r, agent) ? r.timings.perAgentMs[agent] : undefined)));
}

function sortAgents(keys: Iterable<string>, order: string[]): string[] {
  const set = new Set(keys);
  return [...order.filter((a) => set.has(a)), ...[...set].filter((a) => !order.includes(a)).sort()];
}

// ---- CSV ----

function csvCell(v: unknown): string {
  if (v === undefined || v === null) return '';
  const s = typeof v === 'number' ? (Number.isFinite(v) ? String(Math.round(v * 10_000) / 10_000) : '') : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Uma linha por run, com todas as métricas do RunRecord (inclui passos/tool calls e tempo por agente). */
export function toCsv(runs: EvalRun[]): string {
  const agentKeys = sortAgents(runs.flatMap((r) => Object.keys(r.record.agents)), AGENT_ORDER);
  const timeKeys = sortAgents(runs.flatMap((r) => Object.keys(r.record.timings.perAgentMs)), TIME_ORDER);
  const header = [
    'runId', 'component', 'config', 'repetition', 'status', 'heal', 'elicit', 'verify', 'model', 'provider',
    'maxIterations', 'maxAgentSteps', 'iterations', 'rejectedRepairs', 'alignedToBehavior', 'generatedLines', 'finalLines', 'modificationRate',
    'coverageStatements', 'coverageBranches', 'coverageFunctions', 'coverageLines',
    'mutationScore', 'mutationKilled', 'mutationSurvived', 'mutationTimeout', 'smellsCount', 'smells',
    'elicitationQuestions', 'elicitationAnswered', 'elicitationDerivedCases',
    'llmCalls', 'llmInputTokens', 'llmOutputTokens', 'totalMs',
    ...agentKeys.flatMap((a) => [`steps_${a}`, `toolCalls_${a}`]),
    ...timeKeys.map((a) => `ms_${a}`),
    'error',
  ];
  const sorted = [...runs].sort(compareRuns);
  const rows = sorted.map(({ config, repetition, record: r }) => {
    const ran = ok(r);
    return [
      r.runId, r.component, config, repetition, r.status, r.config.heal, r.config.elicit, r.config.verify, r.config.model, r.config.provider,
      r.config.maxIterations, r.config.maxAgentSteps, r.iterations, r.rejectedRepairs, metrics.alignedToBehavior(r), r.generated.lines, r.final.lines, metrics.modificationRate(r),
      ran ? r.coverage.statements : undefined, ran ? r.coverage.branches : undefined, ran ? r.coverage.functions : undefined, ran ? r.coverage.lines : undefined,
      r.mutation?.score, r.mutation?.killed, r.mutation?.survived, r.mutation?.timeout, r.smells?.length, r.smells?.join('; '),
      r.elicitation?.questions, r.elicitation?.answered, r.elicitation?.derivedCases,
      r.llm.calls, r.llm.inputTokens, r.llm.outputTokens, r.timings.totalMs,
      ...agentKeys.flatMap((a) => [r.agents[a]?.steps, r.agents[a]?.toolCalls]),
      ...timeKeys.map((a) => (agentRan(r, a) ? r.timings.perAgentMs[a] : undefined)),
      r.error,
    ].map(csvCell).join(',');
  });
  return [header.join(','), ...rows].join('\n') + '\n';
}

function compareRuns(a: EvalRun, b: EvalRun): number {
  return a.record.component.localeCompare(b.record.component) || a.config.localeCompare(b.config) || a.repetition - b.repetition;
}

// ---- Markdown ----

const cell = (s: string) => s.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

function table(header: string[], rows: string[][]): string[] {
  return [`| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)];
}

interface Group { label: string; config: ConfigLabel; records: RunRecord[] }

/** Grupos componente × configuração (na ordem da configuração) + agregado por configuração. */
function groups(runs: EvalRun[], components: string[]): Group[] {
  const comps = [...components];
  for (const r of runs) if (!comps.includes(r.record.component)) comps.push(r.record.component);
  const out: Group[] = [];
  for (const comp of comps) {
    for (const config of CONFIG_LABELS) {
      const records = runs.filter((r) => r.record.component === comp && r.config === config).map((r) => r.record);
      if (records.length) out.push({ label: componentName(comp), config, records });
    }
  }
  for (const config of CONFIG_LABELS) {
    const records = runs.filter((r) => r.config === config).map((r) => r.record);
    if (records.length) out.push({ label: '**Agregado**', config, records });
  }
  return out;
}

const s = (g: Group, f: (r: RunRecord) => number | undefined) => stat(g.records.map(f));

function passRate(g: Group): string {
  const passed = g.records.filter((r) => r.status === 'PASSED').length;
  return `${num((passed / g.records.length) * 100)}% (${passed}/${g.records.length})`;
}

function statusCount(g: Group, status: RunRecord['status']): string {
  return String(g.records.filter((r) => r.status === status).length);
}

/** summary.md (pt-BR): uma tabela por RQ comparando C1 × C2, por componente e agregado. */
export function renderSummary(runs: EvalRun[], meta: SummaryMeta): string {
  const gs = groups(runs, meta.components);
  const multi = runs.length > 0 && gs.some((g) => g.records.length > 1);
  const L: string[] = [];

  L.push(
    `# Avaliação ReacTest-Agent — ${meta.date}`,
    '',
    `- Workspace: \`${meta.workspace}\``,
    `- Modelo: \`${meta.model}\` · runs por configuração: ${meta.runsPerConfig} · maxIterations: ${meta.maxIterations} · maxAgentSteps: ${meta.maxAgentSteps}`,
    `- Arquivo de respostas (C2): ${meta.answersFile ? `\`${meta.answersFile}\`` : 'nenhum (Elicitação sem respostas)'}`,
    `- Componentes: ${meta.components.map((c) => `\`${c}\``).join(', ')}`,
    `- Total de runs: ${runs.length}`,
    '',
    '**Configurações**',
    '',
    ...CONFIG_LABELS.map((c) => `- **${c}** — ${CONFIG_DESCRIPTIONS[c]}`),
    '',
    `Valores: ${multi ? 'média ± desvio-padrão amostral entre os runs' : 'média (± desvio-padrão quando há mais de um run)'}. ` +
      `**${ND}** = a métrica não existe nos RunRecords (ex.: agente ainda não implementado ou run com ERROR); nenhum valor é estimado.`,
    '',
  );

  if (runs.length === 0) {
    L.push('_Nenhum RunRecord encontrado._', '');
    return L.join('\n');
  }

  L.push('## Status das execuções', '');
  L.push(...table(
    ['Componente', 'Config.', 'Runs', 'PASSED', 'FAILED', 'SUSPECTED_COMPONENT_BUG', 'ERROR'],
    gs.map((g) => [g.label, g.config, String(g.records.length), statusCount(g, 'PASSED'), statusCount(g, 'FAILED'), statusCount(g, 'SUSPECTED_COMPONENT_BUG'), statusCount(g, 'ERROR')]),
  ));
  const errors = runs.filter((r) => r.record.error);
  if (errors.length) {
    L.push('', '<details><summary>Erros</summary>', '');
    for (const e of errors.sort(compareRuns)) L.push(`- ${componentName(e.record.component)} ${e.config} #${e.repetition} (\`${e.record.runId}\`): ${cell(e.record.error!)}`);
    L.push('', '</details>');
  }
  L.push('');

  L.push('## RQ1 — Corretude', '');
  L.push(...table(
    ['Componente', 'Config.', 'Suítes que compilam e passam', 'Iterações até o sucesso', 'Reparos indevidos barrados', 'Expectativas alinhadas ao comportamento'],
    gs.map((g) => [g.label, g.config, passRate(g), fmtStat(s(g, metrics.itersToSuccess)), fmtStat(s(g, metrics.rejectedRepairs)), fmtStat(s(g, metrics.alignedToBehavior))]),
  ));
  L.push('', '_Iterações até o sucesso_: média só entre as suítes que passaram (0 = passou de primeira). _Reparos barrados_: patches recusados pelo guardrail do oráculo (`checkRepair`). _Expectativas alinhadas_: reparos que, sem evidência de defeito do componente, alinharam a expectativa ao comportamento observado (n/d em RunRecords gravados antes desse campo existir).', '');

  L.push('## RQ2 — Esforço', '');
  L.push(...table(
    ['Componente', 'Config.', 'MR automático (linhas alteradas pelo healing / geradas)', 'Linhas geradas', 'Tempo de revisão'],
    gs.map((g) => [g.label, g.config, fmtStat(s(g, metrics.modificationRate), { scale: 100, suffix: '%' }), fmtStat(s(g, (r) => (ok(r) ? r.generated.lines : undefined))), MANUAL]),
  ));
  L.push('', '> ⚠️ O MR da ReacTest v1 foi medido **manualmente** (edições do desenvolvedor); aqui o MR é **automático** (diff do healing). C1 não tem healing, então seu MR é 0 por construção. Os números não são diretamente comparáveis com o TCC. O tempo de revisão fica **a preencher manualmente**.', '');

  L.push('## RQ3 — Eficácia', '');
  L.push(...table(
    ['Componente', 'Config.', 'Mutation score', 'Cobertura de branches', 'Cobertura de linhas'],
    gs.map((g) => [g.label, g.config, fmtStat(s(g, metrics.mutationScore), { suffix: '%' }), fmtStat(s(g, metrics.branches), { suffix: '%' }), fmtStat(s(g, metrics.lines), { suffix: '%' })]),
  ));
  L.push('', '_Cobertura_ do componente-alvo, lida do Jest (suítes que não chegaram a rodar contam 0%). _Mutation score_ vem do Verificador (Stryker).', '');

  L.push('## RQ4 — Regras de negócio', '');
  L.push(...table(
    ['Componente', 'Config.', 'Perguntas', 'Respondidas', 'Casos derivados das respostas', 'Mutantes mortos em validações', 'Relevância (Likert)'],
    gs.map((g) => [g.label, g.config, fmtStat(s(g, metrics.questions)), fmtStat(s(g, metrics.answered)), fmtStat(s(g, metrics.derivedCases)), ND, MANUAL]),
  ));
  L.push('', '_Mutantes mortos em validações_: o RunRecord ainda não detalha mutantes por cenário, por isso fica n/d. A relevância das regras (Likert) fica **a preencher manualmente**.', '');

  L.push('## RQ5 — Custo', '');
  L.push(...table(
    ['Componente', 'Config.', 'Tokens de entrada', 'Tokens de saída', 'Chamadas ao LLM', 'Tempo total (s)'],
    gs.map((g) => [
      g.label, g.config,
      fmtStat(s(g, metrics.inputTokens), { decimals: 0 }),
      fmtStat(s(g, metrics.outputTokens), { decimals: 0 }),
      fmtStat(s(g, metrics.llmCalls)),
      fmtStat(s(g, metrics.totalMs), { scale: 1 / 1000 }),
    ]),
  ));
  L.push('');

  const byConfig = CONFIG_LABELS.map((c) => ({ c, records: runs.filter((r) => r.config === c).map((r) => r.record) })).filter((x) => x.records.length);
  const allRecords = runs.map((r) => r.record);
  const agents = sortAgents(new Set([...AGENT_ORDER, ...allRecords.flatMap((r) => Object.keys(r.agents))]), AGENT_ORDER);
  L.push('**Passos e chamadas de ferramenta por agente (agregado, por run)**', '');
  L.push(...table(
    ['Agente', ...byConfig.flatMap(({ c }) => [`${c} passos`, `${c} tool calls`])],
    agents.map((a) => [AGENT_NAMES[a] ?? a, ...byConfig.flatMap(({ records }) => [fmtStat(agentStat(records, a, 'steps')), fmtStat(agentStat(records, a, 'toolCalls'))])]),
  ));
  L.push('');
  const timeAgents = sortAgents(new Set([...TIME_ORDER, ...allRecords.flatMap((r) => Object.keys(r.timings.perAgentMs))]), TIME_ORDER);
  L.push('**Tempo por agente (s, agregado, por run em que o agente rodou)**', '');
  L.push(...table(
    ['Agente', ...byConfig.map(({ c }) => c)],
    timeAgents.map((a) => [AGENT_NAMES[a] ?? a, ...byConfig.map(({ records }) => fmtStat(agentTimeStat(records, a), { scale: 1 / 1000 }))]),
  ));
  L.push('', '_Passos_ = chamadas ao LLM dentro do loop do agente; detalhes por componente e por run em `runs.csv`.', '');

  return L.join('\n');
}
