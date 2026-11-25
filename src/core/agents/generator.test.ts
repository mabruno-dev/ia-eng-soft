import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FakeLLM } from '../../llm/fake';
import { AgentMeter } from '../metrics';
import { FEW_SHOT_EXAMPLES } from '../prompts/fewshot';
import { GENERATOR_CODE_SYSTEM_PROMPT, GENERATOR_PLAN_SYSTEM_PROMPT } from '../prompts/generator';
import type { ChatMessage, ContextResult, TestPlan, ToolCall } from '../types';
import { checkGeneratedCode, GENERATOR_CODE_AGENT, GENERATOR_PLAN_AGENT, generateTest, knownRuleIds, stripCodeFences } from './generator';

const FIXTURE = fileURLToPath(new URL('../../../fixtures/sample-app', import.meta.url));

const ctx: ContextResult = {
  componentPath: 'src/components/LoginForm.tsx',
  componentName: 'LoginForm',
  componentSource: readFileSync(join(FIXTURE, 'src/components/LoginForm.tsx'), 'utf8'),
  testFilePath: 'src/components/LoginForm.test.tsx',
  allowedImports: [
    { name: 'LoginForm', specifier: './LoginForm', kind: 'named', isExternal: false },
    { name: 'login', specifier: '../services/authApi', kind: 'named', isExternal: false },
  ],
  dependencies: [{ path: 'src/services/authApi.ts', depth: 1, source: readFileSync(join(FIXTURE, 'src/services/authApi.ts'), 'utf8') }],
  props: 'export interface LoginFormProps { onSuccess?: (result: LoginResponse) => void }',
  hooks: ['useState'],
  contexts: [],
  stores: [],
  apiCalls: ['login (@/services/authApi)'],
  mockTargets: ['../services/authApi'],
};

const scenarios = [
  { name: 'renderiza os campos e o botão Entrar', kind: 'render', description: 'estado inicial', mocks: [], fromRules: [] },
  { name: 'mostra erro de e-mail inválido', kind: 'validation', description: 'digita e-mail inválido', mocks: [], fromRules: ['R1'] },
  { name: 'mostra Entrando... durante o login e boas-vindas no sucesso', kind: 'async', description: 'login resolve', mocks: ['../services/authApi'], fromRules: [] },
  { name: 'mostra a mensagem da API quando o login falha', kind: 'async', description: 'login rejeita', mocks: ['../services/authApi'], fromRules: ['R9'] },
  { name: 'senha com 7 caracteres é rejeitada', kind: 'edge', description: 'limite', mocks: [], fromRules: ['R2'] },
];
const planJson = (overrides: Record<string, unknown> = {}) => JSON.stringify({ analysis: '1. renderiza... 2. valida...', scenarios, ...overrides });

const goodCode = `import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import { LoginForm } from './LoginForm';
import { login } from '../services/authApi';

jest.mock('../services/authApi');
const mockedLogin = jest.mocked(login);

describe('LoginForm', () => {
  beforeEach(() => mockedLogin.mockReset());

  it('renderiza os campos e o botão Entrar', () => {
    render(<LoginForm />);
    expect(screen.getByRole('button', { name: 'Entrar' })).toBeEnabled();
  });

  it('mostra erro de e-mail inválido', async () => {
    const user = userEvent.setup();
    render(<LoginForm />);
    await user.type(screen.getByLabelText('E-mail'), 'x');
    await user.click(screen.getByRole('button', { name: 'Entrar' }));
    expect(screen.getByText('E-mail inválido.')).toBeInTheDocument();
  });

  it('mostra Entrando... durante o login e boas-vindas no sucesso', async () => {
    mockedLogin.mockResolvedValue({ token: 't', user: { id: 1, name: 'Ana' } });
    const user = userEvent.setup();
    render(<LoginForm />);
    await user.type(screen.getByLabelText('E-mail'), 'ana@x.com');
    await user.type(screen.getByLabelText('Senha'), '12345678');
    await user.click(screen.getByRole('button', { name: 'Entrar' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Bem-vindo, Ana!');
  });

  it('mostra a mensagem da API quando o login falha', async () => {
    mockedLogin.mockRejectedValue(new Error('Credenciais inválidas'));
    const user = userEvent.setup();
    render(<LoginForm />);
    await user.type(screen.getByLabelText('E-mail'), 'ana@x.com');
    await user.type(screen.getByLabelText('Senha'), '12345678');
    await user.click(screen.getByRole('button', { name: 'Entrar' }));
    expect(await screen.findByText('Credenciais inválidas')).toBeInTheDocument();
  });

  it('senha com 7 caracteres é rejeitada', async () => {
    const user = userEvent.setup();
    render(<LoginForm />);
    await user.type(screen.getByLabelText('E-mail'), 'ana@x.com');
    await user.type(screen.getByLabelText('Senha'), '1234567');
    await user.click(screen.getByRole('button', { name: 'Entrar' }));
    expect(screen.getByText('A senha deve ter pelo menos 8 caracteres.')).toBeInTheDocument();
    expect(mockedLogin).not.toHaveBeenCalled();
  });
});
`;
const draftWithBadImport = goodCode.replace(
  "import { login } from '../services/authApi';",
  "import { login } from '../services/authApi';\nimport { x } from '../componentes/inexistente';",
);

let n = 0;
const call = (name: string, args: Record<string, unknown>): { toolCalls: ToolCall[] } => ({
  toolCalls: [{ id: `c${++n}`, name, arguments: args }],
});
const lastToolResult = (msgs: ChatMessage[]) => {
  const tools = msgs.filter((m): m is Extract<ChatMessage, { role: 'tool' }> => m.role === 'tool');
  return JSON.parse(tools.at(-1)!.content) as unknown;
};
const RULES = '- R1: e-mail precisa ser válido\n- R2: senha com no mínimo 8 caracteres';

describe('generateTest (agente 03)', () => {
  it('plano válido; o agente de código chama validate_imports, vê unresolved, corrige e entrega', async () => {
    const fake = new FakeLLM({
      [GENERATOR_PLAN_AGENT]: ['```json\n' + planJson() + '\n```'],
      [GENERATOR_CODE_AGENT]: [
        call('validate_imports', { code: draftWithBadImport }),
        call('validate_imports', { code: goodCode }),
        JSON.stringify({ code: goodCode }),
      ],
    });
    const meter = new AgentMeter();

    const res = await generateTest({ ctx, workspaceRoot: FIXTURE, rules: RULES, llm: fake, meter });

    const codeReqs = fake.requestsFor(GENERATOR_CODE_AGENT);
    expect(lastToolResult(codeReqs[1]!.messages)).toEqual({
      valid: false,
      unresolved: [{ specifier: '../componentes/inexistente', line: 6 }],
    });
    expect(lastToolResult(codeReqs[2]!.messages)).toEqual({ valid: true, unresolved: [] });
    expect(res.code).toBe(goodCode);
    expect(res.plan.scenarios).toHaveLength(5);
    // R9 não existe nas regras: descartado pelo código.
    expect(res.plan.scenarios.map((s) => s.fromRules)).toEqual([[], ['R1'], [], [], ['R2']]);
    expect(meter.agents()).toEqual({
      [GENERATOR_PLAN_AGENT]: { steps: 1, toolCalls: 0 },
      [GENERATOR_CODE_AGENT]: { steps: 3, toolCalls: 2 },
    });
    expect(codeReqs[0]!.tools!.map((t) => t.name)).toEqual(['read_file', 'validate_imports']);
  });

  it('plano inválido é reparado uma vez', async () => {
    const bad = planJson({ scenarios: scenarios.filter((s) => s.kind !== 'edge').map((s, i) => (i === 0 ? { ...s, kind: 'snapshot' } : s)) });
    const fake = new FakeLLM({
      [GENERATOR_PLAN_AGENT]: [bad, planJson()],
      [GENERATOR_CODE_AGENT]: [call('validate_imports', { code: goodCode }), JSON.stringify({ code: goodCode })],
    });

    const res = await generateTest({ ctx, workspaceRoot: FIXTURE, llm: fake });

    const planReqs = fake.requestsFor(GENERATOR_PLAN_AGENT);
    expect(planReqs).toHaveLength(2);
    const repair = planReqs[1]!.messages.at(-1)!.content;
    expect(repair).toMatch(/não passou na validação/);
    expect(repair).toMatch(/kind/);
    // sem regras, fromRules é sempre vazio
    expect(res.plan.scenarios.every((s) => s.fromRules.length === 0)).toBe(true);
  });

  it('plano sem cenário async para componente com API é devolvido ao agente', async () => {
    const noAsync = planJson({ scenarios: scenarios.filter((s) => s.kind !== 'async') });
    const fake = new FakeLLM({
      [GENERATOR_PLAN_AGENT]: [noAsync, planJson()],
      [GENERATOR_CODE_AGENT]: [call('validate_imports', { code: goodCode }), JSON.stringify({ code: goodCode })],
    });
    await generateTest({ ctx, workspaceRoot: FIXTURE, llm: fake });
    expect(fake.requestsFor(GENERATOR_PLAN_AGENT)[1]!.messages.at(-1)!.content).toMatch(/inclua cenários "async"/);
  });

  it('código entregue sem chamar validate_imports é recusado', async () => {
    const fake = new FakeLLM({
      [GENERATOR_PLAN_AGENT]: [planJson()],
      [GENERATOR_CODE_AGENT]: [JSON.stringify({ code: goodCode }), call('validate_imports', { code: goodCode }), JSON.stringify({ code: goodCode })],
    });
    await generateTest({ ctx, workspaceRoot: FIXTURE, llm: fake });
    expect(fake.requestsFor(GENERATOR_CODE_AGENT)[1]!.messages.at(-1)!.content).toMatch(/chame a ferramenta validate_imports/);
  });

  it('o prompt contém os specifiers de allowedImports, os mockTargets e as regras', async () => {
    const fake = new FakeLLM({
      [GENERATOR_PLAN_AGENT]: [planJson()],
      [GENERATOR_CODE_AGENT]: [call('validate_imports', { code: goodCode }), JSON.stringify({ code: goodCode })],
    });
    await generateTest({ ctx, workspaceRoot: FIXTURE, rules: RULES, llm: fake });

    const planPrompt = fake.requestsFor(GENERATOR_PLAN_AGENT)[0]!.messages[0]!.content;
    const codePrompt = fake.requestsFor(GENERATOR_CODE_AGENT)[0]!.messages[0]!.content;
    for (const p of [planPrompt, codePrompt]) {
      expect(p).toContain("import { LoginForm } from './LoginForm'");
      expect(p).toContain("import { login } from '../services/authApi'");
      expect(p).toContain("mockTargets (use em jest.mock exatamente assim): '../services/authApi'");
      expect(p).toContain(ctx.componentSource.trim().split('\n')[0]!);
    }
    expect(planPrompt).toContain('R1: e-mail precisa ser válido');
    expect(planPrompt).toContain('R2: senha com no mínimo 8 caracteres');
    expect(codePrompt).toContain('[edge] senha com 7 caracteres é rejeitada');
    expect(fake.requestsFor(GENERATOR_PLAN_AGENT)[0]!.system).toBe(GENERATOR_PLAN_SYSTEM_PROMPT);
  });
});

describe('prompts do Gerador', () => {
  it('seguem AUTOMAT, com CoT no plano e few-shot no código', () => {
    for (const h of ['# Act as', '# User persona', '# Targeted action', '# Output definition', '# Mode of interaction', '# Atypical cases', '# Topic whitelisting']) {
      expect(GENERATOR_PLAN_SYSTEM_PROMPT).toContain(h);
      expect(GENERATOR_CODE_SYSTEM_PROMPT).toContain(h.replace('# Mode of interaction', 'Mode of interaction'));
    }
    expect(GENERATOR_PLAN_SYSTEM_PROMPT).toMatch(/passo a passo/);
    expect(GENERATOR_CODE_SYSTEM_PROMPT).toContain('NewsletterSignup');
    expect(GENERATOR_CODE_SYSTEM_PROMPT).toContain('NotificationBell');
  });

  it('exemplos few-shot não usam os componentes do fixture', () => {
    const fixtureComponents = ['Button', 'LoginForm', 'UserList', 'CartSummary', 'ThemeToggle', 'PasswordField'];
    for (const ex of FEW_SHOT_EXAMPLES) {
      expect(fixtureComponents).not.toContain(ex.componentName);
      const all = ex.files.map((f) => f.source).join('\n') + ex.test.code;
      for (const c of fixtureComponents) expect(all).not.toMatch(new RegExp(`\\b${c}\\b`));
    }
  });
});

describe('guardrails do código gerado', () => {
  const plan: TestPlan = { scenarios: scenarios.map((s) => ({ ...s, kind: s.kind as TestPlan['scenarios'][number]['kind'] })) };

  it('aceita o código correto', () => {
    expect(checkGeneratedCode(goodCode, ctx, plan, FIXTURE)).toEqual([]);
  });

  it('aponta asserção trivial, skip, mock faltando, mock local extra, describe e casos insuficientes', () => {
    const bad = `import { render } from '@testing-library/react';
import { LoginForm } from './LoginForm';
jest.mock('./Button');
describe('Outro', () => {
  it.skip('a', () => { expect(true).toBe(true); });
});
`;
    const problems = checkGeneratedCode(bad, ctx, plan, FIXTURE).join('\n');
    expect(problems).toMatch(/describe\('LoginForm'/);
    expect(problems).toMatch(/5 cenários, mas o código tem 0/);
    expect(problems).toMatch(/asserção trivial/);
    expect(problems).toMatch(/\.skip/);
    expect(problems).toMatch(/falta jest.mock\('..\/services\/authApi'\)/);
    expect(problems).toMatch(/jest.mock\('.\/Button'\) mocka um módulo local fora de mockTargets/);
  });

  it('stripCodeFences e knownRuleIds', () => {
    expect(stripCodeFences('```tsx\nconst a = 1;\n```')).toBe('const a = 1;\n');
    expect(stripCodeFences('const a = 1;')).toBe('const a = 1;\n');
    expect(knownRuleIds(['R1', 'R10', 'R1'], '- R1: x')).toEqual(['R1']);
    expect(knownRuleIds(['R1'], undefined)).toEqual([]);
  });
});
