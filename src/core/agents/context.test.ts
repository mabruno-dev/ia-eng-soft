import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FakeLLM } from '../../llm/fake';
import { AgentOutputError } from '../agent/runtime';
import { AgentMeter, MeteredLLM } from '../metrics';
import type { ChatMessage, ToolCall } from '../types';
import { CONTEXT_SYSTEM_PROMPT } from '../prompts/context';
import { buildContext, defaultTestFilePath } from './context';

const FIXTURE = fileURLToPath(new URL('../../../fixtures/sample-app', import.meta.url));
const COMPONENT = 'src/components/CartSummary.tsx';
const TEST_FILE = 'src/components/CartSummary.test.tsx';

let n = 0;
const call = (name: string, args: Record<string, unknown>): { toolCalls: ToolCall[] } => ({
  toolCalls: [{ id: `call_${++n}`, name, arguments: args }],
});
const toolResults = (msgs: ChatMessage[]) =>
  msgs.filter((m): m is Extract<ChatMessage, { role: 'tool' }> => m.role === 'tool').map((m) => JSON.parse(m.content) as Record<string, unknown>);

const finalAnswer = (overrides: Record<string, unknown> = {}) =>
  '```json\n' +
  JSON.stringify({
    componentName: 'CartSummary',
    componentSource: 'O LLM NÃO DEVE CONSEGUIR SOBRESCREVER ISTO',
    allowedImports: [
      { name: 'CartSummary', specifier: './CartSummary', kind: 'named', isExternal: false },
      { name: 'CartProvider', specifier: '../state/CartContext', kind: 'named', isExternal: true },
      { name: 'render', specifier: '@testing-library/react', kind: 'named', isExternal: true },
    ],
    dependencies: [
      { path: 'src/state/CartContext.tsx', depth: 1, source: 'inventado' },
      { path: 'src/state/cartReducer.ts', depth: 2 },
      { path: 'src/state/cartReducer.ts', depth: 1 },
      { path: 'src/components/CartSummary.tsx', depth: 2 },
      { path: 'src/types/cart.ts', depth: 9 },
    ],
    props: '',
    hooks: ['useCart', 'useState', 'useState'],
    contexts: ['CartContext'],
    stores: [],
    apiCalls: [],
    mockTargets: [],
    ...overrides,
  }) +
  '\n```';

const exploration = () => [
  call('list_imports', { file: COMPONENT }),
  call('resolve_import', { fromFile: TEST_FILE, specifier: '@/state/CartContext' }),
  call('relative_specifier', { fromTestFile: TEST_FILE, targetFile: 'src/components/CartSummary.tsx' }),
  call('relative_specifier', { fromTestFile: TEST_FILE, targetFile: 'src/state/CartContext.tsx' }),
];

describe('buildContext (agente 01)', () => {
  it('explora com list_imports/resolve_import/relative_specifier e devolve o ContextResult verificado', async () => {
    const fake = new FakeLLM({ context: [...exploration(), finalAnswer()] });
    const meter = new AgentMeter();
    const llm = new MeteredLLM(fake);

    const ctx = await buildContext({ workspaceRoot: FIXTURE, componentPath: COMPONENT, llm, meter });

    // As ferramentas receberam resultados reais do fixture.
    const results = toolResults(fake.requests.at(-1)!.messages);
    expect((results[0]!.imports as { specifier: string }[]).map((i) => i.specifier)).toContain('@/state/CartContext');
    expect(results[1]).toMatchObject({ resolvedPath: 'src/state/CartContext.tsx' });
    expect(results[2]).toEqual({ specifier: './CartSummary', targetFile: 'src/components/CartSummary.tsx' });
    expect(results[3]).toEqual({ specifier: '../state/CartContext', targetFile: 'src/state/CartContext.tsx' });

    // Caminhos e fontes vêm do código, não do LLM.
    expect(ctx.componentPath).toBe(COMPONENT);
    expect(ctx.testFilePath).toBe(TEST_FILE);
    expect(ctx.componentSource).toBe(readFileSync(join(FIXTURE, COMPONENT), 'utf8'));
    expect(ctx.dependencies.map((d) => [d.path, d.depth])).toEqual([
      ['src/state/CartContext.tsx', 1],
      ['src/state/cartReducer.ts', 1],
    ]);
    expect(ctx.dependencies[0]!.source).toBe(readFileSync(join(FIXTURE, 'src/state/CartContext.tsx'), 'utf8'));
    // isExternal recalculado pelo código
    expect(ctx.allowedImports.find((i) => i.name === 'CartProvider')!.isExternal).toBe(false);
    expect(ctx.hooks).toEqual(['useCart', 'useState']);

    expect(fake.requests.every((r) => r.tag === 'context')).toBe(true);
    expect(fake.requests[0]!.tools!.map((t) => t.name).sort()).toEqual(
      ['analyze_component', 'list_imports', 'read_file', 'relative_specifier', 'resolve_import', 'search_code'].sort(),
    );
    expect(meter.agents()).toEqual({ context: { steps: 5, toolCalls: 4 } });
    expect(llm.byTag().context!.calls).toBe(5);
  });

  it('list_imports/relative_specifier: erro curto para pacote externo, alias e arquivo inexistente; chamada repetida vem do cache', async () => {
    const fake = new FakeLLM({
      context: [
        call('list_imports', { file: 'react' }),
        call('list_imports', { file: '@/state/CartContext' }),
        call('list_imports', { file: 'src/services/cartApi.ts' }),
        call('relative_specifier', { fromTestFile: TEST_FILE, targetFile: '@testing-library/react' }),
        ...exploration(),
        call('list_imports', { file: COMPONENT }), // repetida (mesmos argumentos)
        call('list_imports', { file: 'react' }), // erro repetido
        call('list_imports', { file: 'src\\components\\CartSummary.tsx ' }), // mesmos argumentos após normalizar
        finalAnswer(),
      ],
    });
    const meter = new AgentMeter();

    const ctx = await buildContext({ workspaceRoot: FIXTURE, componentPath: COMPONENT, llm: fake, meter, maxSteps: 12 });

    const errors = toolResults(fake.requests.at(-1)!.messages).map((r) => r.error as string | undefined);
    expect(errors[0]).toBe('a ferramenta "list_imports" falhou: react é pacote externo: use resolve_import');
    expect(errors[1]).toMatch(/@\/state\/CartContext é alias de import: use resolve_import/);
    expect(errors[2]).toMatch(/src\/services\/cartApi\.ts não existe no workspace: use os caminhos devolvidos por list_imports\/resolve_import$/);
    expect(errors[3]).toMatch(/@testing-library\/react é pacote externo: use resolve_import/);
    expect(errors.slice(4, 8)).toEqual([undefined, undefined, undefined, undefined]);
    expect(errors[9]).toBe('a ferramenta "list_imports" falhou: chamada repetida: use o resultado anterior — react é pacote externo: use resolve_import');

    const results = toolResults(fake.requests.at(-1)!.messages);
    const { warning, ...cached } = results[8]!;
    expect(warning).toBe('chamada repetida: use o resultado anterior');
    expect(cached).toEqual(results[4]); // mesmo resultado da 1ª chamada
    expect(results[10]!.warning).toBe('chamada repetida: use o resultado anterior');

    expect(ctx.componentName).toBe('CartSummary');
    expect(meter.agents()).toEqual({ context: { steps: 12, toolCalls: 11 } });
  });

  it('rejeita specifier inventado e devolve o erro ao agente, que corrige com a ferramenta', async () => {
    const fake = new FakeLLM({
      context: [
        ...exploration(),
        finalAnswer({ mockTargets: ['../services/cartApi'] }), // não existe no fixture
        call('search_code', { pattern: 'cart', glob: 'src/services/**' }),
        finalAnswer({ mockTargets: [] }),
      ],
    });

    const ctx = await buildContext({ workspaceRoot: FIXTURE, componentPath: COMPONENT, llm: fake });

    const repair = fake.requests[5]!.messages.at(-1)!;
    expect(repair.role).toBe('user');
    expect(repair.content).toMatch(/"\.\.\/services\/cartApi" não resolve/);
    expect(repair.content).toMatch(/mockTargets/);
    expect(ctx.mockTargets).toEqual([]);
  });

  it('rejeita caminho que existe mas não foi devolvido por nenhuma ferramenta', async () => {
    const invented = finalAnswer({
      allowedImports: [
        { name: 'CartSummary', specifier: './CartSummary', kind: 'named', isExternal: false },
        { name: 'formatCurrency', specifier: '../utils/format', kind: 'named', isExternal: false },
      ],
    });
    const fake = new FakeLLM({ context: [...exploration(), invented, invented, invented] });

    const err = await buildContext({ workspaceRoot: FIXTURE, componentPath: COMPONENT, llm: fake }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AgentOutputError);
    expect((err as Error).message).toMatch(/"\.\.\/utils\/format" não foi devolvido por nenhuma ferramenta/);
    // 1 resposta inicial + 2 rodadas de correção
    expect(fake.requests).toHaveLength(exploration().length + 3);
  });

  it('valida dependências inexistentes e componente fora do workspace', async () => {
    const fake = new FakeLLM({
      context: [...exploration(), finalAnswer({ dependencies: [{ path: 'src/state/naoExiste.ts', depth: 1 }] }), finalAnswer()],
    });
    await buildContext({ workspaceRoot: FIXTURE, componentPath: COMPONENT, llm: fake });
    expect(fake.requests.at(-1)!.messages.at(-1)!.content).toMatch(/"src\/state\/naoExiste.ts" não existe/);

    await expect(buildContext({ workspaceRoot: FIXTURE, componentPath: '../../src/cli.ts', llm: new FakeLLM() })).rejects.toThrow(
      /fora do workspace/,
    );
  });

  it('defaultTestFilePath', () => {
    expect(defaultTestFilePath('src/components/LoginForm.tsx').replace(/\\/g, '/')).toBe('src/components/LoginForm.test.tsx');
  });

  it('(fecho) Button sem imports locais: mockTarget sugerido fora do grafo é recusado e o resultado volta vazio', async () => {
    const BTN = 'src/components/Button.tsx';
    const BTN_TEST = 'src/components/Button.test.tsx';
    const answer = (mockTargets: string[]) =>
      JSON.stringify({
        componentName: 'Button',
        allowedImports: [{ name: 'Button', specifier: './Button', kind: 'named', isExternal: false }],
        dependencies: [],
        props: 'export interface ButtonProps { children: ReactNode }',
        mockTargets,
      });
    const fake = new FakeLLM({
      context: [
        call('list_imports', { file: BTN }),
        call('relative_specifier', { fromTestFile: BTN_TEST, targetFile: BTN }),
        // o caminho existe e foi devolvido por ferramenta, mas está fora do grafo de imports do Button
        call('relative_specifier', { fromTestFile: BTN_TEST, targetFile: 'src/services/authApi.ts' }),
        answer(['../services/authApi']),
        answer([]),
      ],
    });

    const ctx = await buildContext({ workspaceRoot: FIXTURE, componentPath: BTN, llm: fake });

    expect(ctx.mockTargets).toEqual([]);
    const feedback = fake.requestsFor('context').at(-1)!.messages.at(-1)!.content;
    expect(feedback).toMatch(/"\.\.\/services\/authApi" \(src\/services\/authApi\.ts\) está fora do grafo de dependências do componente/);
  });

  it('(fecho) allowedImports de módulo fora do grafo (ex.: App.tsx) é recusado; dependência indireta é aceita', async () => {
    const fake = new FakeLLM({
      context: [
        ...exploration(),
        call('relative_specifier', { fromTestFile: TEST_FILE, targetFile: 'src/App.tsx' }),
        call('relative_specifier', { fromTestFile: TEST_FILE, targetFile: 'src/state/cartReducer.ts' }),
        finalAnswer({
          allowedImports: [
            { name: 'CartSummary', specifier: './CartSummary', kind: 'named', isExternal: false },
            { name: 'App', specifier: '../App', kind: 'named', isExternal: false },
          ],
        }),
        finalAnswer({
          allowedImports: [
            { name: 'CartSummary', specifier: './CartSummary', kind: 'named', isExternal: false },
            { name: 'cartTotal', specifier: '../state/cartReducer', kind: 'named', isExternal: false }, // profundidade 2
          ],
        }),
      ],
    });
    const ctx = await buildContext({ workspaceRoot: FIXTURE, componentPath: COMPONENT, llm: fake });
    expect(ctx.allowedImports.map((i) => i.specifier)).toEqual(['./CartSummary', '../state/cartReducer']);
    expect(fake.requestsFor('context').at(-1)!.messages.at(-1)!.content).toMatch(/"\.\.\/App" \(src\/App\.tsx\) está fora do grafo/);
  });

  it('o prompt proíbe procurar usos do componente e define mockTargets por I/O/estado global', () => {
    expect(CONTEXT_SYSTEM_PROMPT).toContain('NÃO procure quem usa o componente');
    expect(CONTEXT_SYSTEM_PROMPT).toContain('App.tsx');
    expect(CONTEXT_SYSTEM_PROMPT).toMatch(/Componentes puros .* têm mockTargets VAZIO/);
  });
});

