// Regressões da avaliação dentro da extensão (Copilot): drive em minúscula, "No tests found",
// resposta vazia do modelo e escolha do modelo.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FakeLLM } from '../llm/fake';
import { executeTests } from './agents/executor';
import { classifyInfraError } from './llmErrors';
import { EmptyResponseError, withEmptyResponseRetry } from './llmRetry';
import { isMiniModel, type ModelInfo, modelPickItems, modelRefusal, type ToolProbe } from './modelChoice';
import { isNoTestsFound, JestNoTestsFoundError, noTestsFoundMessage } from './tools/jest';
import { canonicalPath, getWorkspace, upperDriveLetter } from './tools/workspace';
import type { ContextResult, ExecResult, LLMClient, LLMRequest, LLMResponse } from './types';

const FIXTURE = fileURLToPath(new URL('../../fixtures/sample-app', import.meta.url));
const lowerDrive = (p: string) => p.replace(/^([A-Z]):/, (_m, d: string) => `${d.toLowerCase()}:`);

describe('workspace na forma real do disco (drive em maiúscula)', () => {
  it('canonicalPath usa realpathSync.native e põe o drive em maiúscula (simulado)', () => {
    expect(canonicalPath('c:\\dev\\app', () => 'c:\\dev\\App')).toBe('C:\\dev\\App');
    const missing = () => {
      throw new Error('ENOENT');
    };
    expect(canonicalPath('c:\\dev\\novo', missing)).toMatch(/^C:[\\/]dev[\\/]novo$/);
    expect(upperDriveLetter('d:/x')).toBe('D:/x');
    expect(upperDriveLetter('/home/x')).toBe('/home/x');
  });

  it.skipIf(process.platform !== 'win32')('workspace aberto com "c:\\…" vira "C:\\…" na raiz (cwd do Jest) e em abs() (arquivo do --runTestsByPath)', () => {
    const lower = lowerDrive(FIXTURE);
    expect(lower).not.toBe(FIXTURE);
    const ws = getWorkspace(lower);
    expect(ws.root).toBe(realpathSync.native(FIXTURE));
    expect(ws.root).toMatch(/^[A-Z]:/);
    const testAbs = ws.abs(`${lower}\\src\\components\\Button.test.tsx`);
    expect(testAbs.startsWith(ws.root)).toBe(true);
    expect(testAbs).toMatch(/^[A-Z]:\\.*\\src\\components\\Button\.test\.tsx$/);
    expect(getWorkspace(FIXTURE)).toBe(ws); // mesmo cache para as duas grafias
  });
});

describe('"No tests found" é erro de infraestrutura, não FAILED', () => {
  const ctx: ContextResult = {
    componentPath: 'src/components/Button.tsx',
    componentName: 'Button',
    componentSource: '',
    testFilePath: 'src/components/Button.test.tsx',
    allowedImports: [],
    dependencies: [],
    props: '',
    hooks: [],
    contexts: [],
    stores: [],
    apiCalls: [],
    mockTargets: [],
  };
  const noTests: ExecResult = {
    passed: false,
    numTests: 0,
    numFailed: 0,
    failures: [],
    suiteError: noTestsFoundMessage('c:\\app\\src\\components\\Button.test.tsx', 'C:\\app'),
    coverage: { statements: 0, branches: 0, functions: 0, lines: 0 },
    rawOutput: 'No tests found, exiting with code 0',
  };

  it('o Executor lança JestNoTestsFoundError (a pipeline termina com ERROR) e a avaliação classifica como infraestrutura', async () => {
    expect(isNoTestsFound(noTests)).toBe(true);
    const fake = new FakeLLM({
      executor: [
        { toolCalls: [{ id: 'c1', name: 'run_jest', arguments: { testFile: ctx.testFilePath, componentFile: ctx.componentPath } }] },
        JSON.stringify({ category: 'IMPORT', summary: 'nenhum teste encontrado', flaky: false }),
      ],
    });
    const err = await executeTests({ ctx, workspaceRoot: FIXTURE, testFilePath: ctx.testFilePath, llm: fake, runJest: async () => noTests }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JestNoTestsFoundError);
    expect((err as Error).message).toMatch(/^O Jest não encontrou o arquivo de teste \(No tests found\)/);
    expect((err as Error).message).toMatch(/confira o caminho do workspace e o rootDir/);
    // mensagem como fica no RunRecord (errMsg inclui o nome do erro)
    expect(classifyInfraError(`JestNoTestsFoundError: ${(err as Error).message}`)?.kind).toBe('jest_discovery');
    expect(classifyInfraError('No tests found, exiting with code 0')?.kind).toBe('jest_discovery');
  });
});

describe('resposta vazia do Copilot', () => {
  const req: LLMRequest = { system: 's', messages: [{ role: 'user', content: 'x' }], tag: 'generator.code' };
  const fakeClient = (responses: LLMResponse[]): LLMClient & { calls: number } => {
    const c = {
      calls: 0,
      async complete() {
        return responses[Math.min(c.calls++, responses.length - 1)]!;
      },
    };
    return c;
  };
  const empty: LLMResponse = { text: '  ', inputTokens: 100, outputTokens: 0 };

  it('tenta de novo até 2 vezes; a 3ª resposta válida é devolvida com os tokens somados', async () => {
    const inner = fakeClient([empty, empty, { text: '{"code":"x"}', inputTokens: 100, outputTokens: 7 }]);
    const retries: number[] = [];
    const r = await withEmptyResponseRetry(inner, { onRetry: (i) => retries.push(i.attempt) }).complete(req);
    expect(r.text).toBe('{"code":"x"}');
    expect(inner.calls).toBe(3);
    expect(retries).toEqual([1, 2]);
    expect(r).toMatchObject({ inputTokens: 300, outputTokens: 7 });
  });

  it('toolCalls sem texto não é resposta vazia; 3 vazias seguidas lançam EmptyResponseError', async () => {
    const tools = fakeClient([{ text: '', toolCalls: [{ id: '1', name: 'read_file', arguments: {} }], inputTokens: 1, outputTokens: 1 }]);
    await withEmptyResponseRetry(tools).complete(req);
    expect(tools.calls).toBe(1);
    const inner = fakeClient([empty]);
    await expect(withEmptyResponseRetry(inner).complete(req)).rejects.toBeInstanceOf(EmptyResponseError);
    expect(inner.calls).toBe(3);
  });
});

describe('escolha do modelo na avaliação', () => {
  const m = (id: string, family = id): ModelInfo => ({ id, family, name: id, maxInputTokens: 128_000 });
  const models = [m('gpt-4o-mini'), m('gpt-4o'), m('o3-mini'), m('claude-sonnet-4'), m('gpt-4.1')];
  const probes = new Map<string, ToolProbe>([
    ['gpt-4o', { ok: true }],
    ['claude-sonnet-4', { ok: false, error: 'sem tools' }],
    ['gpt-4.1', { ok: true }],
  ]);

  it('famílias "mini" são recusadas salvo allowMiniModels', () => {
    expect(isMiniModel(m('gpt-4o-mini'))).toBe(true);
    expect(isMiniModel(m('gpt-4o'))).toBe(false);
    expect(modelRefusal(m('o3-mini'), false)).toMatch(/"mini".*reactest\.allowMiniModels/);
    expect(modelRefusal(m('o3-mini'), true)).toBeUndefined();
  });

  it('QuickPick: selecionáveis primeiro; mostra family, resultado do tool calling e o motivo da recusa', () => {
    const items = modelPickItems(models, probes, false);
    expect(items.map((i) => [i.model.id, i.selectable])).toEqual([
      ['gpt-4o', true],
      ['gpt-4.1', true],
      ['gpt-4o-mini', false],
      ['o3-mini', false],
      ['claude-sonnet-4', false],
    ]);
    expect(items[0]).toMatchObject({ label: '$(check) gpt-4o', description: 'gpt-4o · tool calling OK' });
    expect(items[2]!.description).toBe('gpt-4o-mini · recusado (mini)');
    expect(items[4]!.reason).toBe('tool calling NÃO suportado: sem tools');
    // com allowMiniModels: o mini que passou no teste fica selecionável; o não testado, não
    const allowed = modelPickItems(models, new Map([...probes, ['gpt-4o-mini', { ok: true }]]), true);
    expect(allowed.find((i) => i.model.id === 'gpt-4o-mini')!.selectable).toBe(true);
    expect(allowed.find((i) => i.model.id === 'o3-mini')!.reason).toBe('não testado');
  });
});
