import { describe, expect, it } from 'vitest';
import { classifyFailure, crossCheckCategory } from './guardrail';
import type { ExecResult, FailureCategory } from './types';

const ZERO = { statements: 0, branches: 0, functions: 0, lines: 0 };
const suite = (suiteError: string): ExecResult => ({ passed: false, numTests: 0, numFailed: 0, failures: [], suiteError, coverage: ZERO, rawOutput: '' });
const failing = (message: string): ExecResult => ({
  passed: false,
  numTests: 1,
  numFailed: 1,
  failures: [{ testName: 'Comp caso', message }],
  coverage: ZERO,
  rawOutput: '',
});

// Amostras REAIS de saída do Jest 30 + ts-jest no fixtures/sample-app (capturadas via run_jest; stack traces internos já removidos).
const SAMPLES: [string, ExecResult, FailureCategory][] = [
  [
    'TS2307 Cannot find module',
    suite(
      "● Test suite failed to run\n\n    src/components/__sample_nomod.test.tsx:1:19 - error TS2307: Cannot find module '../utils/naoExiste' or its corresponding type declarations.\n\n    1 import { x } from '../utils/naoExiste';\n                        ~~~~~~~~~~~~~~~~~~~~",
    ),
    'IMPORT',
  ],
  [
    'TS2614 has no exported member',
    suite(
      "● Test suite failed to run\n\n    src/components/__sample_notexported.test.tsx:1:10 - error TS2614: Module '\"./Button\"' has no exported member 'Botao'. Did you mean to use 'import Botao from \"./Button\"' instead?\n\n    1 import { Botao } from './Button';\n               ~~~~~",
    ),
    'IMPORT',
  ],
  [
    'runtime Cannot find module (babel/JS)',
    suite("● Test suite failed to run\n\n    Cannot find module '../hooks/useAuth' from 'src/components/LoginForm.test.tsx'"),
    'IMPORT',
  ],
  [
    'TS1134 erro de sintaxe',
    suite(
      "● Test suite failed to run\n\n    src/components/__sample_syntax.test.tsx:2:45 - error TS1134: Variable declaration expected.\n\n    2 describe('x', () => { it('a', () => { const = 1; }); });\n                                                  ~",
    ),
    'SYNTAX_TYPE',
  ],
  [
    'TS2322 erro de tipo',
    suite(
      "● Test suite failed to run\n\n    src/components/__sample_tstype.test.tsx:3:54 - error TS2322: Type '\"giant\"' is not assignable to type 'ButtonVariant | undefined'.",
    ),
    'SYNTAX_TYPE',
  ],
  [
    'SyntaxError de runtime',
    suite('● Test suite failed to run\n\n    SyntaxError: Unexpected token, expected "," (4:12)'),
    'SYNTAX_TYPE',
  ],
  [
    'mockResolvedValue is not a function (módulo não mockado)',
    failing(
      'TypeError: userApi_1.fetchUsers.mockResolvedValue is not a function\n    at Object.<anonymous> (C:\\dev\\ia-eng-soft\\fixtures\\sample-app\\src\\components\\__sample_mock.test.tsx:4:65)',
    ),
    'MOCK',
  ],
  [
    'função do serviço mockado sem implementação',
    failing(
      'TypeError: (0 , userApi_1.fetchUsers) is not a function\n    at C:\\dev\\ia-eng-soft\\fixtures\\sample-app\\src\\components\\UserList.tsx:16:15',
    ),
    'MOCK',
  ],
  [
    'Unable to find (getBy antes de o fetch resolver)',
    failing(
      'TestingLibraryElementError: Unable to find an element with the text: Nenhum usuário cadastrado.. This could be because the text is broken up by multiple elements.\n\nIgnored nodes: comments, script, style\n<body>\n  <div>\n    <p\n      role="status"\n    >\n      Carregando usuários...\n    </p>\n  </div>\n</body>',
    ),
    'ASYNC',
  ],
  [
    'Exceeded timeout do Jest',
    failing(
      'Error: thrown: "Exceeded timeout of 300 ms for a test.\nAdd a timeout value to this test to increase the timeout, if this is a long-running test. See https://jestjs.io/docs/api#testname-fn-timeout."',
    ),
    'ASYNC',
  ],
  [
    'not wrapped in act',
    failing(
      'Warning: An update to UserList inside a test was not wrapped in act(...).\n\nWhen testing, code that causes React state updates should be wrapped into act(...)',
    ),
    'ASYNC',
  ],
  [
    'timeout do processo (run_jest)',
    suite('Timeout: o Jest excedeu o tempo limite de 120s e o processo foi encerrado (possível loop infinito, promessa nunca resolvida ou teste travado).'),
    'ASYNC',
  ],
  [
    'expect(received).toBe',
    failing('Error: expect(received).toBe(expected) // Object.is equality\n\nExpected: "btn btn-primary"\nReceived: "btn btn-danger"'),
    'ASSERTION',
  ],
  [
    'toHaveBeenCalled',
    failing('Error: expect(jest.fn()).toHaveBeenCalled()\n\nExpected number of calls: >= 1\nReceived number of calls:    0'),
    'ASSERTION',
  ],
  [
    'toEqual',
    failing('Error: expect(received).toEqual(expected) // deep equality\n\n- Expected  - 1\n+ Received  + 1\n\n- 3\n+ 2'),
    'ASSERTION',
  ],
  ['sem padrão conhecido', failing('Error: algo completamente diferente aconteceu'), 'UNKNOWN'],
];

describe('classifyFailure', () => {
  it.each(SAMPLES)('%s → categoria esperada', (_name, exec, expected) => {
    expect(classifyFailure(exec)).toBe(expected);
  });

  it('execução que passou → null', () => {
    expect(classifyFailure({ passed: true, numTests: 2, numFailed: 0, failures: [], coverage: ZERO, rawOutput: '' })).toBeNull();
  });

  it('sem failures nem suiteError, usa rawOutput', () => {
    expect(classifyFailure({ ...failing(''), failures: [], rawOutput: "Cannot find module 'x'" })).toBe('IMPORT');
  });
});

describe('crossCheckCategory', () => {
  const assertion = failing('Error: expect(received).toBe(expected)\n\nExpected: 1\nReceived: 2');
  const importErr = SAMPLES[0]![1];

  it('concordância: mantém', () => {
    expect(crossCheckCategory('ASSERTION', assertion)).toMatchObject({ final: 'ASSERTION', overridden: false });
  });
  it('LLM diz null mas há falhas: usa o regex e registra', () => {
    const c = crossCheckCategory(null, assertion);
    expect(c).toMatchObject({ final: 'ASSERTION', overridden: true });
    expect(c.note).toMatch(/usado o regex/);
  });
  it('LLM diz categoria mas passou: null', () => {
    expect(crossCheckCategory('MOCK', { ...assertion, passed: true, numFailed: 0, failures: [] })).toMatchObject({ final: null, overridden: true });
  });
  it('LLM diz UNKNOWN e regex é específico: regex', () => {
    expect(crossCheckCategory('UNKNOWN', assertion)).toMatchObject({ final: 'ASSERTION', overridden: true });
  });
  it('suíte nem rodou e LLM diz ASSERTION: regex (IMPORT)', () => {
    expect(crossCheckCategory('ASSERTION', importErr)).toMatchObject({ final: 'IMPORT', overridden: true });
  });
  it('divergência razoável: mantém o LLM e registra', () => {
    const c = crossCheckCategory('MOCK', assertion);
    expect(c).toMatchObject({ final: 'MOCK', overridden: false, regexCategory: 'ASSERTION' });
    expect(c.note).toMatch(/divergência/);
  });
});
