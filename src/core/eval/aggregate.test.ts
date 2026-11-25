import { describe, expect, it } from 'vitest';
import type { RunRecord } from '../types';
import { agentStat, agentTimeStat, type EvalRun, fmtStat, ND, renderSummary, stat, type SummaryMeta, toCsv } from './aggregate';

function rec(over: Partial<RunRecord> & { component?: string } = {}): RunRecord {
  return {
    runId: 'r',
    component: 'src/components/Button.tsx',
    config: { heal: true, elicit: true, verify: true, maxIterations: 3, maxAgentSteps: 8, model: 'gpt-4o', provider: 'openai' },
    status: 'PASSED',
    iterations: 0,
    generated: { code: 'a\nb', lines: 10 },
    final: { code: 'a\nb', lines: 10 },
    modificationRate: 0,
    coverage: { statements: 100, branches: 50, functions: 100, lines: 100 },
    rejectedRepairs: 0,
    alignedToBehavior: 0,
    llm: { calls: 5, inputTokens: 1000, outputTokens: 200 },
    agents: { context: { steps: 2, toolCalls: 3 }, 'generator.plan': { steps: 1, toolCalls: 0 }, executor: { steps: 1, toolCalls: 1 } },
    timings: { totalMs: 10_000, perAgentMs: { context: 2000, generator: 5000, executor: 3000, verifier: 0.01, elicitation: 0.02 } },
    ...over,
  };
}

const meta: SummaryMeta = {
  date: '2026-11-25',
  workspace: 'fixtures/sample-app',
  model: 'gpt-4o',
  runsPerConfig: 2,
  maxIterations: 3,
  maxAgentSteps: 8,
  components: ['src/components/Button.tsx', 'src/components/LoginForm.tsx'],
};

/** Extrai a linha de uma tabela markdown que começa com as células dadas. */
function row(md: string, section: string, ...prefix: string[]): string[] {
  const start = md.indexOf(`## ${section}`);
  const end = md.indexOf('\n## ', start + 1);
  const lines = md.slice(start, end === -1 ? undefined : end).split('\n');
  const line = lines.find((l) => l.startsWith(`| ${prefix.join(' | ')} |`));
  if (!line) throw new Error(`linha ${prefix.join('|')} não encontrada em ${section}`);
  return line.slice(2, -2).split(' | ');
}

describe('stat / fmtStat', () => {
  it('média e desvio amostral, ignorando ausentes', () => {
    const s = stat([2, 4, undefined, 6, null]);
    expect(s).toEqual({ n: 3, mean: 4, sd: 2 });
    expect(fmtStat(s)).toBe('4,0 ± 2,0');
  });
  it('um valor: só a média; nenhum: n/d', () => {
    expect(fmtStat(stat([0.25]), { scale: 100, suffix: '%' })).toBe('25,0%');
    expect(fmtStat(stat([undefined]))).toBe(ND);
    expect(stat([])).toBeNull();
  });
});

describe('métricas por agente', () => {
  it('agente ausente em todos os runs → n/d; ausente em alguns → 0', () => {
    const a = rec({ agents: { repairer: { steps: 4, toolCalls: 6 } } });
    const b = rec({ agents: {} });
    expect(agentStat([a, b], 'repairer', 'steps')).toEqual({ n: 2, mean: 2, sd: expect.closeTo(2.828, 2) });
    expect(agentStat([a, b], 'verifier', 'steps')).toBeNull();
  });
  it('tempo de estágio no-op (sem passos) não vira 0 s; generator cobre generator.*', () => {
    const r = rec();
    expect(agentTimeStat([r], 'verifier')).toBeNull();
    expect(agentTimeStat([r], 'generator')).toEqual({ n: 1, mean: 5000, sd: 0 });
  });
});

describe('toCsv', () => {
  it('uma linha por run, colunas dinâmicas de agentes e células vazias para ausentes', () => {
    const runs: EvalRun[] = [
      { config: 'C2', repetition: 1, record: rec({ runId: 'b', agents: { repairer: { steps: 3, toolCalls: 4 } }, smells: ['Assertion Roulette', 'x, "y"'] }) },
      { config: 'C1', repetition: 1, record: rec({ runId: 'a', mutation: { score: 72.5, killed: 29, survived: 11, timeout: 0 } }) },
    ];
    const lines = toCsv(runs).trimEnd().split('\n');
    expect(lines).toHaveLength(3);
    const header = lines[0]!.split(',');
    expect(header).toContain('steps_context');
    expect(header).toContain('toolCalls_repairer');
    expect(header).toContain('ms_generator');
    expect(header.indexOf('steps_context')).toBeLessThan(header.indexOf('steps_repairer'));
    // ordenado por componente, config, repetição → C1 primeiro
    expect(lines[1]!.startsWith('a,src/components/Button.tsx,C1,1,PASSED,')).toBe(true);
    const c1 = Object.fromEntries(header.map((h, i) => [h, lines[1]!.split(',')[i]]));
    expect(c1.mutationScore).toBe('72.5');
    expect(c1.ms_verifier).toBe(''); // no-op: não conta
    expect(c1.elicitationDerivedCases).toBe('');
    expect(lines[2]).toContain('"Assertion Roulette; x, ""y"""');
  });
  it('run com ERROR: cobertura vazia (não 0)', () => {
    const lines = toCsv([{ config: 'C2', repetition: 1, record: rec({ status: 'ERROR', error: 'boom', coverage: { statements: 0, branches: 0, functions: 0, lines: 0 } }) }]).split('\n');
    const header = lines[0]!.split(',');
    const v = lines[1]!.split(',');
    expect(v[header.indexOf('coverageBranches')]).toBe('');
    expect(v[header.indexOf('error')]).toBe('boom');
  });
});

describe('renderSummary', () => {
  const runs: EvalRun[] = [
    { config: 'C1', repetition: 1, record: rec({ status: 'FAILED', coverage: { statements: 0, branches: 0, functions: 0, lines: 0 } }) },
    { config: 'C1', repetition: 2, record: rec({ status: 'PASSED', coverage: { statements: 90, branches: 40, functions: 90, lines: 90 } }) },
    { config: 'C2', repetition: 1, record: rec({ status: 'PASSED', iterations: 2, modificationRate: 0.2, rejectedRepairs: 1, alignedToBehavior: 1, agents: { repairer: { steps: 6, toolCalls: 8 } }, timings: { totalMs: 30_000, perAgentMs: { repairer: 12_000 } } }) },
    { config: 'C2', repetition: 2, record: rec({ status: 'PASSED', iterations: 0, modificationRate: 0, elicitation: { questions: 3, answered: 3, derivedCases: 2 } }) },
    { config: 'C2', repetition: 1, record: rec({ component: 'src/components/LoginForm.tsx', status: 'ERROR', error: 'rate | limit', alignedToBehavior: undefined as unknown as number, iterations: 0, coverage: { statements: 0, branches: 0, functions: 0, lines: 0 } }) },
  ];
  const md = renderSummary(runs, meta);

  it('tem uma seção por RQ e o cabeçalho', () => {
    for (const s of ['RQ1 — Corretude', 'RQ2 — Esforço', 'RQ3 — Eficácia', 'RQ4 — Regras de negócio', 'RQ5 — Custo']) expect(md).toContain(`## ${s}`);
    expect(md).toContain('# Avaliação ReacTest-Agent — 2026-11-25');
    expect(md).toContain('Total de runs: 5');
  });

  it('RQ1: % de aprovação, iterações só dos que passaram, reparos barrados', () => {
    expect(row(md, 'RQ1', 'Button', 'C1')).toEqual(['Button', 'C1', '50,0% (1/2)', '0,0', '0,0 ± 0,0', '0,0 ± 0,0']);
    expect(row(md, 'RQ1', 'Button', 'C2')).toEqual(['Button', 'C2', '100,0% (2/2)', '1,0 ± 1,4', '0,5 ± 0,7', '0,5 ± 0,7']);
    expect(row(md, 'RQ1', 'LoginForm', 'C2')).toEqual(['LoginForm', 'C2', '0,0% (0/1)', ND, '0,0', ND]);
    expect(row(md, 'RQ1', '**Agregado**', 'C2')).toEqual(['**Agregado**', 'C2', '66,7% (2/3)', '1,0 ± 1,4', '0,3 ± 0,6', '0,5 ± 0,7']);
  });

  it('RQ2: MR em % e avisos de MR manual / tempo de revisão', () => {
    expect(row(md, 'RQ2', 'Button', 'C2')[2]).toBe('10,0% ± 14,1%');
    expect(row(md, 'RQ2', 'LoginForm', 'C2')[2]).toBe(ND); // run com ERROR não tem MR
    expect(row(md, 'RQ2', 'Button', 'C1')[4]).toBe('a preencher manualmente');
    expect(md).toContain('MR da ReacTest v1 foi medido **manualmente**');
  });

  it('RQ3: mutation n/d quando o Verificador não gravou nada; ERROR fica fora da cobertura', () => {
    expect(row(md, 'RQ3', 'Button', 'C1')).toEqual(['Button', 'C1', ND, ND, ND, '20,0% ± 28,3%', '45,0% ± 63,6%', ND]);
    expect(row(md, 'RQ3', 'LoginForm', 'C2')).toEqual(['LoginForm', 'C2', ND, ND, ND, ND, ND, ND]);
  });

  it('RQ3: mutation score, detectados/válidos e sugestões preenchidos onde o Verificador mediu; n/d onde não', () => {
    const runs: EvalRun[] = [
      { config: 'C2', repetition: 1, record: rec({ mutation: { score: 80, killed: 7, survived: 2, timeout: 1, noCoverage: 0, total: 10 }, verification: { suggestions: [{ mutantId: '3', line: 4, mutator: 'EqualityOperator', description: 'd', suggestedAssertion: 'a' }] } }) },
      { config: 'C2', repetition: 2, record: rec({ mutation: { score: 60, killed: 6, survived: 4, timeout: 0, noCoverage: 0, total: 10 }, verification: { suggestions: [] } }) },
      { config: 'C1', repetition: 1, record: rec({ status: 'FAILED' }) },
    ];
    const out = renderSummary(runs, meta);
    expect(row(out, 'RQ3', 'Button', 'C2').slice(2, 5)).toEqual(['70,0% ± 14,1%', '7,0 ± 1,4', '10,0 ± 0,0']);
    expect(row(out, 'RQ3', 'Button', 'C2')[7]).toBe('0,5 ± 0,7');
    expect(row(out, 'RQ3', 'Button', 'C1').slice(2, 5)).toEqual([ND, ND, ND]);
    expect(toCsv(runs).split('\n')[0]).toContain('mutationTotal');
  });

  it('RQ4: casos derivados quando existem, n/d caso contrário, Likert manual', () => {
    expect(row(md, 'RQ4', 'Button', 'C2')).toEqual(['Button', 'C2', '3,0', '3,0', '2,0', ND, 'a preencher manualmente']);
    expect(row(md, 'RQ4', 'Button', 'C1')).toEqual(['Button', 'C1', ND, ND, ND, ND, 'a preencher manualmente']);
  });

  it('RQ5: tokens, chamadas, tempo e tabela por agente', () => {
    expect(row(md, 'RQ5', 'Button', 'C2')).toEqual(['Button', 'C2', '1000 ± 0', '200 ± 0', '5,0 ± 0,0', '20,0 ± 14,1']);
    expect(row(md, 'RQ5', 'Reparador')).toEqual(['Reparador', ND, ND, '2,0 ± 3,5', '2,7 ± 4,6']);
    expect(row(md, 'RQ5', 'Verificador')).toEqual(['Verificador', ND, ND, ND, ND]);
  });

  it('escapa | nos erros e lista erros', () => {
    expect(md).toContain('rate \\| limit');
  });

  it('sem runs: avisa e não quebra', () => {
    expect(renderSummary([], meta)).toContain('Nenhum RunRecord encontrado');
  });
});
