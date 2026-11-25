import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FakeLLM } from '../../llm/fake';
import { AgentMeter } from '../metrics';
import { EXECUTOR_SYSTEM_PROMPT } from '../prompts/executor';
import type { RunJestArgs } from '../tools/jest';
import type { ChatMessage, ContextResult, ExecResult, ToolCall } from '../types';
import { EXECUTOR_AGENT, EXECUTOR_MAX_RUNS, executeTests } from './executor';

const FIXTURE = fileURLToPath(new URL('../../../fixtures/sample-app', import.meta.url));
const TEST_FILE = 'src/components/Button.test.tsx';
const ctx: ContextResult = {
  componentPath: 'src/components/Button.tsx',
  componentName: 'Button',
  componentSource: '',
  testFilePath: TEST_FILE,
  allowedImports: [{ name: 'Button', specifier: './Button', kind: 'named', isExternal: false }],
  dependencies: [],
  props: '',
  hooks: [],
  contexts: [],
  stores: [],
  apiCalls: [],
  mockTargets: [],
};

const COV = { statements: 87.5, branches: 75, functions: 100, lines: 87.5 };
const ok: ExecResult = { passed: true, numTests: 3, numFailed: 0, failures: [], coverage: COV, rawOutput: 'PASS src/components/Button.test.tsx' };
const timeout: ExecResult = {
  passed: false,
  numTests: 3,
  numFailed: 1,
  failures: [{ testName: 'Button chama onClick', message: 'Error: thrown: "Exceeded timeout of 5000 ms for a test."' }],
  coverage: COV,
  rawOutput: 'FAIL ...',
};
const assertion: ExecResult = {
  passed: false,
  numTests: 3,
  numFailed: 1,
  failures: [{ testName: 'Button usa a variante danger', message: 'Error: expect(received).toBe(expected) // Object.is equality\n\nExpected: "btn btn-primary"\nReceived: "btn btn-danger"' }],
  coverage: { statements: 60, branches: 50, functions: 100, lines: 60 },
  rawOutput: 'FAIL ...',
};

/** run_jest falsa: devolve os resultados em sequência e registra os argumentos. */
function fakeRunner(...results: ExecResult[]) {
  const calls: RunJestArgs[] = [];
  const runner = async (_root: string, args: RunJestArgs) => {
    calls.push(args);
    return results[Math.min(calls.length - 1, results.length - 1)]!;
  };
  return { runner, calls };
}

let n = 0;
const call = (args: Record<string, unknown> = {}): { toolCalls: ToolCall[] } => ({
  toolCalls: [{ id: `c${++n}`, name: 'run_jest', arguments: { testFile: TEST_FILE, componentFile: ctx.componentPath, ...args } }],
});
const toolResults = (msgs: ChatMessage[]) =>
  msgs.filter((m): m is Extract<ChatMessage, { role: 'tool' }> => m.role === 'tool').map((m) => JSON.parse(m.content) as Record<string, unknown>);

describe('executeTests (agente 04)', () => {
  it('caminho feliz: roda uma vez, passou, categoria null', async () => {
    const { runner, calls } = fakeRunner(ok);
    const fake = new FakeLLM({ [EXECUTOR_AGENT]: [call(), JSON.stringify({ category: null, summary: 'Todos os 3 testes passaram.', flaky: false })] });
    const meter = new AgentMeter();

    const res = await executeTests({ ctx, workspaceRoot: FIXTURE, testFilePath: TEST_FILE, llm: fake, runJest: runner, meter });

    expect(res.exec).toBe(ok);
    expect(res.diagnosis).toEqual({ category: null, summary: 'Todos os 3 testes passaram.', flaky: false });
    expect(res.runs).toBe(1);
    expect(calls).toEqual([{ testFile: TEST_FILE, componentFile: ctx.componentPath }]);
    expect(meter.agents()).toEqual({ [EXECUTOR_AGENT]: { steps: 2, toolCalls: 1 } });
    const req = fake.requestsFor(EXECUTOR_AGENT)[0]!;
    expect(req.system).toBe(EXECUTOR_SYSTEM_PROMPT);
    expect(req.tools!.map((t) => t.name)).toEqual(['run_jest', 'read_file']);
    expect(req.messages[0]!.content).toContain(`"testFile": "${TEST_FILE}"`);
  });

  it('reexecuta com runInBand ao ver timeout; exec é o da segunda execução', async () => {
    const { runner, calls } = fakeRunner(timeout, ok);
    const fake = new FakeLLM({
      [EXECUTOR_AGENT]: [
        call(),
        call({ runInBand: true }),
        JSON.stringify({ category: null, summary: 'Timeout na 1ª execução; passou ao reexecutar em série (flaky).', flaky: true }),
      ],
    });

    const res = await executeTests({ ctx, workspaceRoot: FIXTURE, testFilePath: TEST_FILE, llm: fake, runJest: runner });

    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ runInBand: true });
    // o LLM viu o timeout no resultado da 1ª chamada antes de decidir reexecutar
    expect(toolResults(fake.requestsFor(EXECUTOR_AGENT)[1]!.messages)[0]).toMatchObject({ passed: false, numFailed: 1 });
    expect(res.exec).toBe(ok);
    expect(res.runs).toBe(2);
    expect(res.diagnosis).toEqual({ category: null, summary: expect.stringContaining('Timeout'), flaky: true });
  });

  it('exec é o da ÚLTIMA chamada de run_jest mesmo que o LLM invente números no JSON final', async () => {
    const { runner } = fakeRunner(assertion);
    const fake = new FakeLLM({
      [EXECUTOR_AGENT]: [
        call(),
        JSON.stringify({
          category: 'ASSERTION',
          summary: 'O teste espera btn-primary, mas o botão danger recebe btn-danger.',
          flaky: false,
          // números inventados: devem ser ignorados
          passed: true,
          numTests: 99,
          numFailed: 0,
          coverage: { statements: 100, branches: 100, functions: 100, lines: 100 },
        }),
      ],
    });

    const res = await executeTests({ ctx, workspaceRoot: FIXTURE, testFilePath: TEST_FILE, llm: fake, runJest: runner });

    expect(res.exec).toBe(assertion);
    expect(res.exec).toMatchObject({ passed: false, numTests: 3, numFailed: 1, coverage: { statements: 60, branches: 50 } });
    expect(res.diagnosis).toEqual({ category: 'ASSERTION', summary: expect.any(String), flaky: false });
    expect(Object.keys(res.diagnosis).sort()).toEqual(['category', 'flaky', 'summary']);
  });

  it('LLM diz category null com falhas: o regex prevalece e flaky sem reexecução vira false', async () => {
    const { runner } = fakeRunner(assertion);
    const fake = new FakeLLM({ [EXECUTOR_AGENT]: [call(), JSON.stringify({ category: null, summary: 'Parece ok.', flaky: true })] });

    const res = await executeTests({ ctx, workspaceRoot: FIXTURE, testFilePath: TEST_FILE, llm: fake, runJest: runner });

    expect(res.diagnosis.category).toBe('ASSERTION');
    expect(res.diagnosis.flaky).toBe(false);
    expect(res.crossCheck).toMatchObject({ llmCategory: null, regexCategory: 'ASSERTION', overridden: true });
  });

  it(`no máximo ${EXECUTOR_MAX_RUNS} execuções; arquivo diferente é recusado`, async () => {
    const { runner, calls } = fakeRunner(timeout);
    const fake = new FakeLLM({
      [EXECUTOR_AGENT]: [
        call({ testFile: 'src/components/LoginForm.test.tsx' }),
        call(),
        call({ runInBand: true }),
        call({ runInBand: true }),
        call({ runInBand: true }),
        JSON.stringify({ category: 'ASYNC', summary: 'Timeout persistente em "Button chama onClick".', flaky: false }),
      ],
    });

    const res = await executeTests({ ctx, workspaceRoot: FIXTURE, testFilePath: TEST_FILE, llm: fake, runJest: runner });

    expect(calls).toHaveLength(EXECUTOR_MAX_RUNS);
    const results = toolResults(fake.requestsFor(EXECUTOR_AGENT).at(-1)!.messages);
    expect(results[0]!.error).toMatch(/testFile deve ser/);
    expect(results.at(-1)!.error).toMatch(/limite de 3 execuções/);
    expect(res.runs).toBe(EXECUTOR_MAX_RUNS);
    expect(res.diagnosis.category).toBe('ASYNC');
  });

  it('resposta final sem chamar run_jest é recusada', async () => {
    const { runner } = fakeRunner(ok);
    const fake = new FakeLLM({
      [EXECUTOR_AGENT]: [JSON.stringify({ category: null, summary: 'passou', flaky: false }), call(), JSON.stringify({ category: null, summary: 'passou', flaky: false })],
    });
    const res = await executeTests({ ctx, workspaceRoot: FIXTURE, testFilePath: TEST_FILE, llm: fake, runJest: runner });
    expect(fake.requestsFor(EXECUTOR_AGENT)[1]!.messages.at(-1)!.content).toMatch(/chame a ferramenta run_jest/);
    expect(res.exec).toBe(ok);
  });
});
