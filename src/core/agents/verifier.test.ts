import { describe, expect, it } from 'vitest';
import { FakeLLM } from '../../llm/fake';
import { FIXTURE } from '../testing/healFixtures';
import { MutationInfraError, type MutationResult, type RunMutationFn } from '../tools/mutation';
import type { ContextResult } from '../types';
import { filterSuggestions, VERIFIER_AGENT, verifyTest } from './verifier';

const ctx: ContextResult = {
  componentPath: 'src/components/CartSummary.tsx',
  componentName: 'CartSummary',
  componentSource: '',
  testFilePath: 'src/components/CartSummary.test.tsx',
  allowedImports: [],
  dependencies: [],
  props: '',
  hooks: [],
  contexts: [],
  stores: [],
  apiCalls: [],
  mockTargets: [],
};

const RESULT: MutationResult = {
  score: 72.73, killed: 7, survived: 2, timeout: 1, noCoverage: 1, total: 11,
  survivors: [
    { id: '12', mutator: 'EqualityOperator', line: 4, original: 'total > 100', replacement: 'total >= 100', status: 'Survived' },
    { id: '15', mutator: 'StringLiteral', line: 6, original: "'Frete grátis'", replacement: '""', status: 'Survived' },
    { id: '20', mutator: 'BlockStatement', line: 9, original: '{ … }', replacement: '{}', status: 'NoCoverage' },
  ],
  survivorsTotal: 3, reportFile: 'x', ms: 10,
};
const fakeStryker = (r: MutationResult = RESULT) => {
  const calls: unknown[] = [];
  const run: RunMutationFn = async (o) => (calls.push(o), r);
  return { run, calls };
};
const call = (name: string, args: Record<string, unknown>, id = name) => ({ toolCalls: [{ id, name, arguments: args }] });
const sug = (mutantId: string, line = 999) => ({ mutantId, line, description: `cobrir ${mutantId}`, suggestedAssertion: `expect(x${mutantId}).toBe(1)` });
const base = { ctx, workspaceRoot: FIXTURE, testFilePath: ctx.testFilePath, testCode: "it('x', () => {});", runId: 'r1' };

describe('Verificador (agente 06)', () => {
  it('chama run_mutation e read_source_lines; números vêm da ferramenta; no máximo 3 sugestões com mutantId real (linha do Stryker)', async () => {
    const stryker = fakeStryker();
    const fake = new FakeLLM({
      [VERIFIER_AGENT]: [
        call('run_mutation', { componentFile: ctx.componentPath }),
        { toolCalls: [
          { id: 'a', name: 'read_source_lines', arguments: { file: ctx.componentPath, from: 1, to: 10 } },
        ] },
        // o LLM "inventa" números no texto e um id inexistente: o código ignora ambos
        JSON.stringify({ score: 100, suggestions: [sug('12'), sug('999'), sug('15'), sug('12'), sug('20'), sug('21')] }),
      ],
    });
    const r = await verifyTest({ ...base, llm: fake, runMutation: stryker.run });
    expect(stryker.calls).toHaveLength(1);
    expect(stryker.calls[0]).toMatchObject({ componentFile: ctx.componentPath, testFile: ctx.testFilePath, runId: 'r1' });
    expect(r.mutation).toEqual({ score: 72.73, killed: 7, survived: 2, timeout: 1, noCoverage: 1, total: 11 });
    expect(r.suggestions.map((s) => [s.mutantId, s.line, s.mutator])).toEqual([['12', 4, 'EqualityOperator'], ['15', 6, 'StringLiteral'], ['20', 9, 'BlockStatement']]);
    expect(r.discarded).toBe(3); // '999' inexistente, '12' repetido, '21' além do limite (e inexistente)
    expect(r.error).toBeUndefined();
    // a 2ª mensagem do agente contém o resultado da ferramenta com os sobreviventes
    const toolMsg = fake.requestsFor(VERIFIER_AGENT)[1]!.messages.find((m) => m.role === 'tool')!;
    expect(toolMsg.content).toContain('"survivors"');
    expect(toolMsg.content).toContain('total > 100');
  });

  it('erro de infraestrutura do Stryker: mutação n/d, sem sugestões, sem lançar', async () => {
    const run: RunMutationFn = async () => {
      throw new MutationInfraError('o Stryker não concluiu (código 1): falhou', 'saída bruta');
    };
    const fake = new FakeLLM({ [VERIFIER_AGENT]: [call('run_mutation', { componentFile: ctx.componentPath }), JSON.stringify({ suggestions: [sug('12')] })] });
    const r = await verifyTest({ ...base, llm: fake, runMutation: run });
    expect(r.mutation).toBeUndefined();
    expect(r.suggestions).toEqual([]);
    expect(r.error).toBe('mutação n/d: o Stryker não concluiu (código 1): falhou');
    expect(fake.requestsFor(VERIFIER_AGENT)[1]!.messages.at(-1)!.content).toContain('o Stryker não concluiu');
  });

  it('se o agente não chamar run_mutation (ou falhar), o código mede mesmo assim', async () => {
    const stryker = fakeStryker();
    const fake = new FakeLLM({ [VERIFIER_AGENT]: ['isto não é JSON', 'nem isto'] });
    const r = await verifyTest({ ...base, llm: fake, runMutation: stryker.run });
    expect(stryker.calls).toHaveLength(1);
    expect(r.mutation?.score).toBe(72.73);
    expect(r.suggestions).toEqual([]);
    expect(r.error).toMatch(/o Verificador não concluiu/);
  });

  it("modo 'measure' (baseline C1): só o Stryker, nenhuma chamada ao LLM", async () => {
    const stryker = fakeStryker();
    const fake = new FakeLLM([]);
    const r = await verifyTest({ ...base, llm: fake, runMutation: stryker.run, mode: 'measure' });
    expect(fake.requests).toHaveLength(0);
    expect(r).toMatchObject({ mutation: { score: 72.73, total: 11 }, suggestions: [] });
  });

  it('filterSuggestions descarta ids inexistentes', () => {
    expect(filterSuggestions([sug('x'), sug('15')], RESULT.survivors)).toMatchObject({ kept: [{ mutantId: '15', line: 6 }], discarded: 1 });
  });
});

describe('resumo da mutação (CLI/extensão/relatório)', () => {
  it('mostra score, detectados/total e sugestões; n/d com o motivo', async () => {
    const { mutationLine, suggestionLines } = await import('../report');
    const rec = {
      status: 'PASSED', config: { verify: true },
      mutation: { score: 72.73, killed: 7, survived: 2, timeout: 1, noCoverage: 1, total: 11 },
      verification: { suggestions: [{ mutantId: '12', line: 4, mutator: 'EqualityOperator', description: 'limite de 100', suggestedAssertion: 'expect(a).toBe(b)' }] },
    } as unknown as import('../types').RunRecord;
    expect(mutationLine(rec)).toBe('Mutação: score 72.73% (7 mortos + 1 timeout/11), 1 sugestão(ões)');
    expect(suggestionLines(rec)).toEqual(['1. [mutante 12 · EqualityOperator · linha 4] limite de 100\n   → expect(a).toBe(b)']);
    expect(mutationLine({ ...rec, mutation: undefined, status: 'SUSPECTED_COMPONENT_BUG' } as typeof rec)).toBe('Mutação: n/d (só é medida com a suíte passando)');
  });
});
