// Utilitários dos testes do Reparador / healLoop (sem rede, sem Jest real).
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Diagnosis } from '../agents/executor';
import { classifyFailure } from '../guardrail';
import type { ContextResult, ExecResult, ToolCall } from '../types';

export const FIXTURE = fileURLToPath(new URL('../../../fixtures/sample-app', import.meta.url));
export const TEST_FILE = 'src/components/LoginForm.test.tsx';

/** Cópia do fixture (sem node_modules) num diretório temporário: as ferramentas gravam aqui. */
export function tempWorkspace(): { root: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), 'reactest-heal-'));
  for (const f of ['package.json', 'tsconfig.json']) cpSync(join(FIXTURE, f), join(root, f));
  cpSync(join(FIXTURE, 'src'), join(root, 'src'), { recursive: true, filter: (p) => !/\.test\.tsx?$/.test(p) });
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

export function loginCtx(root: string): ContextResult {
  return {
    componentPath: 'src/components/LoginForm.tsx',
    componentName: 'LoginForm',
    componentSource: readFileSync(join(root, 'src/components/LoginForm.tsx'), 'utf8'),
    testFilePath: TEST_FILE,
    allowedImports: [
      { name: 'LoginForm', specifier: './LoginForm', kind: 'named', isExternal: false },
      { name: 'login', specifier: '../services/authApi', kind: 'named', isExternal: false },
    ],
    dependencies: [{ path: 'src/services/authApi.ts', depth: 1, source: '' }],
    props: 'export interface LoginFormProps { onSuccess?: (result: LoginResponse) => void }',
    hooks: ['useState'],
    contexts: [],
    stores: [],
    apiCalls: ['login (@/services/authApi)'],
    mockTargets: ['../services/authApi'],
  };
}

export const GOOD = `import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoginForm } from './LoginForm';
import { login } from '../services/authApi';

jest.mock('../services/authApi');
const mockedLogin = jest.mocked(login);

describe('LoginForm', () => {
  beforeEach(() => mockedLogin.mockReset());

  it('renderiza o botão Entrar', () => {
    render(<LoginForm />);
    expect(screen.getByRole('button', { name: 'Entrar' })).toBeEnabled();
  });

  it('mostra boas-vindas no sucesso', async () => {
    // a API responde com latência: o status só aparece depois que a promessa resolve
    mockedLogin.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve({ token: 't', user: { id: 1, name: 'Ana' } }), 50)));
    const user = userEvent.setup();
    render(<LoginForm />);
    await user.type(screen.getByLabelText('E-mail'), 'ana@x.com');
    await user.type(screen.getByLabelText('Senha'), '12345678');
    await user.click(screen.getByRole('button', { name: 'Entrar' }));
    expect(await screen.findByRole('status')).toHaveTextContent('Bem-vindo, Ana!');
    expect(mockedLogin).toHaveBeenCalledWith({ email: 'ana@x.com', password: '12345678' });
  });

  it('rejeita senha com 7 caracteres', async () => {
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

const sub = (code: string, from: string, to: string) => {
  if (!code.includes(from)) throw new Error(`trecho não encontrado: ${from}`);
  return code.replace(from, to);
};
const FIND = "expect(await screen.findByRole('status'))";
const GET = "expect(screen.getByRole('status'))";
const CALLED_WITH = "    expect(mockedLogin).toHaveBeenCalledWith({ email: 'ana@x.com', password: '12345678' });\n";

/** Import errado (gerador escreveu LoginFrom). */
export const BAD_IMPORT = sub(GOOD, "from './LoginForm'", "from './LoginFrom'");
/** getByRole para algo que só aparece depois do login (falta await findBy). */
export const BAD_ASYNC = sub(GOOD, FIND, GET);
/** "Reparo" ilegítimo: corrige o async mas APAGA a asserção toHaveBeenCalledWith. */
export const ASYNC_FIX_DELETING_ASSERTION = sub(GOOD, CALLED_WITH, '');
/** "Reparo" com import inventado. */
export const FIX_WITH_BAD_IMPORT = sub(GOOD, "import { login } from '../services/authApi';", "import { login } from '../services/authApi';\nimport { renderWithProviders } from '../test/renderWithProviders';");
/** Mudança legítima pequena (uma asserção a mais). */
export const withExtraAssertion = (code: string, n: number) =>
  sub(code, "    expect(screen.getByRole('button', { name: 'Entrar' })).toBeEnabled();\n", `    expect(screen.getByRole('button', { name: 'Entrar' })).toBeEnabled();\n    expect(screen.getByLabelText('E-mail')).toHaveValue(''); // extra ${n}\n`);

const ZERO = { statements: 0, branches: 0, functions: 0, lines: 0 };
const COV = { statements: 90, branches: 80, functions: 100, lines: 90 };
export const execs = {
  pass: (): ExecResult => ({ passed: true, numTests: 3, numFailed: 0, failures: [], coverage: COV, rawOutput: 'PASS' }),
  importFail: (): ExecResult => ({
    passed: false,
    numTests: 0,
    numFailed: 0,
    failures: [],
    suiteError: "● Test suite failed to run\n\n    src/components/LoginForm.test.tsx:3:27 - error TS2307: Cannot find module './LoginFrom' or its corresponding type declarations.",
    coverage: ZERO,
    rawOutput: 'FAIL',
  }),
  asyncFail: (): ExecResult => ({
    passed: false,
    numTests: 3,
    numFailed: 1,
    failures: [{ testName: 'LoginForm mostra boas-vindas no sucesso', message: 'TestingLibraryElementError: Unable to find an accessible element with the role "status"' }],
    coverage: COV,
    rawOutput: 'FAIL',
  }),
  assertionFail: (msg = 'Error: expect(element).toHaveTextContent()\n\nExpected element to have text content:\n  Bem-vindo, Ana!\nReceived:\n  Bem-vindo, !'): ExecResult => ({
    passed: false,
    numTests: 3,
    numFailed: 1,
    failures: [{ testName: 'LoginForm mostra boas-vindas no sucesso', message: msg }],
    coverage: COV,
    rawOutput: 'FAIL',
  }),
};

/**
 * Executor falso que olha o arquivo de teste REAL em disco e devolve o resultado roteirizado
 * (assim o loop enxerga o efeito de write_test). Conta as chamadas.
 */
export function scriptedExecutor(root: string, decide: (code: string, call: number) => ExecResult) {
  let calls = 0;
  const execute = async () => {
    const code = readFileSync(join(root, TEST_FILE), 'utf8');
    const exec = decide(code, ++calls);
    const diagnosis: Diagnosis = { category: classifyFailure(exec), summary: exec.passed ? 'passou' : `falhou: ${exec.failures[0]?.testName ?? 'suíte'}`, flaky: false };
    return { exec, diagnosis };
  };
  return { execute, calls: () => calls };
}

let n = 0;
export const call = (name: string, args: Record<string, unknown>): { toolCalls: ToolCall[] } => ({
  toolCalls: [{ id: `r${++n}`, name, arguments: args }],
});
export const final = (status: string, reasoning: string, extra: { evidence?: string; alignedToBehavior?: boolean } = {}) =>
  JSON.stringify({ status, reasoning, ...extra });
