// Ferramentas de mutação contra um Stryker FALSO (script Node que escreve um relatório JSON de exemplo).
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextResult } from '../types';
import {
  createMutationState,
  getSurvivingMutantsTool,
  MAX_SURVIVORS,
  MutationInfraError,
  parseStrykerReport,
  readSourceLinesTool,
  runMutation,
  runMutationTool,
  strykerConfigFor,
} from './mutation';

const SOURCE = [
  "export function CartSummary({ items }: { items: number[] }) {", // 1
  '  const total = items.reduce((a, b) => a + b, 0);', // 2
  '  if (total > 100) return <p>Frete grátis</p>;', // 3
  "  return <p>Total: {total}</p>;", // 4
  '}', // 5
].join('\n');

type M = { id: string | number; mutatorName: string; status: string; replacement?: string; location: { start: { line: number; column: number }; end: { line: number; column: number } } };
const mut = (id: string | number, status: string, line: number, startCol: number, endCol: number, mutatorName = 'EqualityOperator', replacement = 'total >= 100'): M => ({
  id, mutatorName, status, replacement, location: { start: { line, column: startCol }, end: { line, column: endCol } },
});
const report = (mutants: M[], file = 'src/components/CartSummary.tsx') => ({ schemaVersion: '1', thresholds: { high: 80, low: 60 }, files: { [file]: { language: 'typescript', source: SOURCE, mutants } } });

const SAMPLE = report([
  mut('1', 'Killed', 2, 17, 49, 'MethodExpression', 'items'),
  mut('2', 'Survived', 3, 7, 18), // "total > 100"
  mut('3', 'Timeout', 2, 40, 45, 'ArithmeticOperator', 'a - b'),
  mut('4', 'NoCoverage', 4, 10, 31, 'StringLiteral', '""'),
  mut('5', 'CompileError', 1, 1, 5),
  mut('6', 'Killed', 3, 7, 18, 'ConditionalExpression', 'true'),
  mut('7', 'Ignored', 5, 1, 2),
]);

describe('parseStrykerReport', () => {
  it('conta killed/survived/timeout/noCoverage, ignora CompileError/Ignored e calcula o score como o Stryker', () => {
    const r = parseStrykerReport(SAMPLE, 'src/components/CartSummary.tsx');
    expect(r).toMatchObject({ killed: 2, survived: 1, timeout: 1, noCoverage: 1, total: 5, score: 60, survivorsTotal: 2 });
    expect(r.survivors).toEqual([
      { id: '2', mutator: 'EqualityOperator', line: 3, original: 'total > 100', replacement: 'total >= 100', status: 'Survived' },
      { id: '4', mutator: 'StringLiteral', line: 4, original: '<p>Total: {total}</p>', replacement: '""', status: 'NoCoverage' },
    ]);
  });

  it(`no máximo ${MAX_SURVIVORS} sobreviventes, os primeiros por linha (survivorsTotal guarda o total)`, () => {
    const many = Array.from({ length: 20 }, (_, i) => mut(String(100 + i), 'Survived', 20 - i, 1, 2));
    const r = parseStrykerReport(report(many), 'src\\components\\CartSummary.tsx'); // separador do Windows
    expect(r.survivors).toHaveLength(MAX_SURVIVORS);
    expect(r.survivorsTotal).toBe(20);
    expect(r.survivors.map((s) => s.line)).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
    expect(r.score).toBe(0);
  });

  it('relatório inválido ou sem o arquivo → MutationInfraError', () => {
    expect(() => parseStrykerReport({ nada: 1 }, 'x.tsx')).toThrow(MutationInfraError);
    expect(() => parseStrykerReport({ files: { 'a.tsx': { mutants: [] }, 'b.tsx': { mutants: [] } } }, 'src/x.tsx')).toThrow(/não tem o arquivo/);
  });
});

// ---------------------------------------------------------------------------

const FAKE_STRYKER = String.raw`
const fs = require('node:fs');
const path = require('node:path');
const [cmd, configPath] = process.argv.slice(2);
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
fs.writeFileSync(process.env.FAKE_STRYKER_LOG, JSON.stringify({ cmd, configPath, cwd: process.cwd(), config }));
const mode = process.env.FAKE_STRYKER_MODE;
if (mode === 'hang') setTimeout(() => {}, 60000);
else if (mode === 'fail') { console.error('ERROR Stryker: Something went wrong in the initial test run'); process.exit(1); }
else {
  const out = path.join(process.cwd(), config.jsonReporter.fileName);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.copyFileSync(process.env.FAKE_STRYKER_REPORT, out);
}
`;

let ws: string;
let bin: string;
let logFile: string;
const COMPONENT = 'src/components/CartSummary.tsx';
const TEST = 'src/components/CartSummary.test.tsx';

beforeEach(() => {
  ws = mkdtempSync(join(tmpdir(), 'reactest-mutation-'));
  mkdirSync(join(ws, 'src', 'components'), { recursive: true });
  writeFileSync(join(ws, COMPONENT), SOURCE);
  writeFileSync(join(ws, TEST), "it('x', () => expect(1).toBe(1));");
  writeFileSync(join(ws, 'src', 'components', 'Other.tsx'), 'export const Other = 1;\n');
  writeFileSync(join(ws, 'jest.config.cjs'), 'module.exports = {};');
  writeFileSync(join(ws, 'stryker.config.json'), JSON.stringify({ $schema: 'x', testRunner: 'jest', jest: { configFile: 'jest.config.cjs' }, mutate: ['src/**/*.tsx'], reporters: ['html'], tempDirName: '.stryker-tmp', thresholds: { high: 90 } }));
  bin = join(ws, 'fake-stryker.cjs');
  writeFileSync(bin, FAKE_STRYKER);
  logFile = join(ws, 'stryker-call.json');
  const reportFile = join(ws, 'sample-report.json');
  writeFileSync(reportFile, JSON.stringify(SAMPLE));
  vi.stubEnv('FAKE_STRYKER_LOG', logFile);
  vi.stubEnv('FAKE_STRYKER_REPORT', reportFile);
  vi.stubEnv('FAKE_STRYKER_MODE', 'ok');
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(ws, { recursive: true, force: true });
});

const opts = (o: Partial<Parameters<typeof runMutation>[0]> = {}) => ({ workspaceRoot: ws, componentFile: COMPONENT, testFile: TEST, runId: 'run-1', strykerBin: bin, ...o });

describe('runMutation (Stryker falso)', () => {
  it('roda só no componente, só com o teste gerado, jest/perTest/concorrência 2, relatório json em .reactest/stryker', async () => {
    const r = await runMutation(opts());
    expect(r).toMatchObject({ score: 60, killed: 2, survived: 1, timeout: 1, noCoverage: 1, total: 5 });
    expect(r.reportFile.replace(/\\/g, '/')).toMatch(/\.reactest\/stryker\/run-1\/mutation\.json$/);

    const call = JSON.parse(readFileSync(logFile, 'utf8')) as { cmd: string; cwd: string; config: Record<string, any> };
    expect(call.cmd).toBe('run');
    expect(call.config).toMatchObject({
      testRunner: 'jest',
      mutate: [COMPONENT],
      coverageAnalysis: 'perTest',
      concurrency: 2,
      reporters: ['json'],
      jsonReporter: { fileName: '.reactest/stryker/run-1/mutation.json' },
      tempDirName: '.reactest/stryker/run-1/tmp',
      jest: { configFile: 'jest.config.cjs', config: { testMatch: ['**/CartSummary.test.tsx'] }, enableFindRelatedTests: false },
      thresholds: { high: 90 }, // demais opções do stryker.config.json do workspace são mantidas
    });
    expect(call.config.$schema).toBeUndefined();
    expect(call.config.mutator).toBeUndefined();
    expect(existsSync(join(ws, '.stryker-tmp'))).toBe(false);
  });

  it('excludedMutations desativa mutators (ex.: StringLiteral)', () => {
    expect(strykerConfigFor(opts({ excludedMutations: ['StringLiteral'] }))).toMatchObject({ mutator: { excludedMutations: ['StringLiteral'] } });
  });

  it('timeout total: mata o processo e lança erro de infraestrutura em pt-BR', async () => {
    vi.stubEnv('FAKE_STRYKER_MODE', 'hang');
    const t0 = Date.now();
    const err = await runMutation(opts({ timeoutMs: 500 })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MutationInfraError);
    expect((err as Error).message).toMatch(/excedeu o tempo limite de 1 s e foi encerrado/);
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  it('Stryker falhou / ausente → MutationInfraError com mensagem curta e saída bruta em rawText', async () => {
    vi.stubEnv('FAKE_STRYKER_MODE', 'fail');
    const err = (await runMutation(opts()).catch((e: unknown) => e)) as MutationInfraError;
    expect(err.message).toBe('o Stryker não concluiu (código 1): ERROR Stryker: Something went wrong in the initial test run');
    expect(err.rawText).toContain('initial test run');
    await expect(runMutation(opts({ strykerBin: join(ws, 'nao-existe.js') }))).rejects.toThrow(/Stryker não encontrado/);
  });
});

describe('ferramentas do Verificador', () => {
  const ctx = (): ContextResult => ({
    componentPath: COMPONENT, componentName: 'CartSummary', componentSource: SOURCE, testFilePath: TEST,
    allowedImports: [], dependencies: [], props: '', hooks: [], contexts: [], stores: [], apiCalls: [], mockTargets: [],
  });

  it('run_mutation roda o Stryker uma vez (resultado reaproveitado) e só aceita o componente em teste', async () => {
    let runs = 0;
    const state = createMutationState({ ctx: ctx(), workspaceRoot: ws, testFilePath: TEST, runId: 'r', run: async (o) => (runs++, runMutation({ ...o, strykerBin: bin })) });
    const tool = runMutationTool(state);
    const a = (await tool.run({ componentFile: COMPONENT })) as { score: number; survivors: unknown[] };
    await tool.run({ componentFile: COMPONENT.replace(/\//g, '\\') });
    expect(runs).toBe(1);
    expect(a.score).toBe(60);
    expect(a.survivors).toHaveLength(2);
    await expect(tool.run({ componentFile: 'src/components/Other.tsx' })).rejects.toThrow(/só muta o componente em teste/);
    const again = (await getSurvivingMutantsTool(state).run({})) as { survivors: { id: string }[] };
    expect(again.survivors.map((s) => s.id)).toEqual(['2', '4']);
  });

  it('get_surviving_mutants sem relatório e read_source_lines confinado ao fecho do Contexto', async () => {
    const state = createMutationState({ ctx: ctx(), workspaceRoot: ws, testFilePath: TEST, runId: 'r', run: async () => { throw new Error('não deveria rodar'); } });
    await expect(getSurvivingMutantsTool(state).run({})).rejects.toThrow(/chame run_mutation primeiro/);
    const read = readSourceLinesTool(state);
    expect(await read.run({ file: COMPONENT, from: 3, to: 4 })).toMatchObject({ from: 3, to: 4, lines: '3:   if (total > 100) return <p>Frete grátis</p>;\n4:   return <p>Total: {total}</p>;' });
    await expect(read.run({ file: 'src/components/Other.tsx', from: 1, to: 1 })).rejects.toThrow(/não pertence ao componente/);
    await expect(read.run({ file: '../fora.ts', from: 1, to: 1 })).rejects.toThrow();
  });
});
