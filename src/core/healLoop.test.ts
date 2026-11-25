import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeLLM } from '../llm/fake';
import { REPAIRER_AGENT } from './agents/repairer';
import { errorSignature, firstErrorLine, healLoop, lineDiff, modificationRate } from './healLoop';
import { AgentMeter } from './metrics';
import {
  ASYNC_FIX_DELETING_ASSERTION,
  BAD_ASYNC,
  BAD_IMPORT,
  call,
  execs,
  FIX_WITH_BAD_IMPORT,
  final,
  GOOD,
  loginCtx,
  scriptedExecutor,
  TEST_FILE,
  tempWorkspace,
  withExtraAssertion,
} from './testing/healFixtures';
import type { ChatMessage } from './types';

let ws: ReturnType<typeof tempWorkspace>;
beforeEach(() => {
  ws = tempWorkspace();
});
afterEach(() => ws.cleanup());

const onDisk = () => readFileSync(join(ws.root, TEST_FILE), 'utf8');
const toolResults = (msgs: ChatMessage[]) =>
  msgs.filter((m): m is Extract<ChatMessage, { role: 'tool' }> => m.role === 'tool').map((m) => JSON.parse(m.content) as Record<string, unknown>);
const lines = (s: string) => s.trimEnd().split('\n').length;

describe('healLoop', () => {
  it('(a) falha de import corrigida em 1 iteração', async () => {
    const ex = scriptedExecutor(ws.root, (code) => (code.includes('./LoginFrom') ? execs.importFail() : execs.pass()));
    const fake = new FakeLLM({
      [REPAIRER_AGENT]: [
        call('validate_imports', { code: GOOD }),
        call('write_test', { code: GOOD }),
        final('REPAIRED', 'O import usava ./LoginFrom; troquei pelo especificador de allowedImports ./LoginForm.'),
      ],
    });
    const meter = new AgentMeter();

    const r = await healLoop({ ctx: loginCtx(ws.root), workspaceRoot: ws.root, generatedCode: BAD_IMPORT, llm: fake, maxIterations: 3, execute: ex.execute, meter });

    expect(r).toMatchObject({ status: 'PASSED', stopReason: 'PASSED', iterations: 1, rejectedRepairs: 0, finalCode: GOOD });
    expect(onDisk()).toBe(GOOD);
    expect(ex.calls()).toBe(2);
    expect(r.history).toEqual([
      expect.objectContaining({ iteration: 1, category: 'IMPORT', repairStatus: 'REPAIRED', wrote: true, rejectedRepairs: 0 }),
    ]);
    expect(r.modificationRate).toBe(Math.round((1 / lines(BAD_IMPORT)) * 10_000) / 10_000);
    expect(r.exec.passed).toBe(true);
    // o prompt do Reparador recebeu a falha, o diagnóstico e os allowedImports
    const prompt = fake.requestsFor(REPAIRER_AGENT)[0]!.messages[0]!.content;
    expect(prompt).toContain("Cannot find module './LoginFrom'");
    expect(prompt).toContain('categoria: IMPORT');
    expect(prompt).toContain("import { LoginForm } from './LoginForm'");
    expect(fake.requestsFor(REPAIRER_AGENT)[0]!.tools!.map((t) => t.name)).toEqual(['read_file', 'run_jest', 'validate_imports', 'check_repair', 'write_test']);
    expect(meter.agents()[REPAIRER_AGENT]).toEqual({ steps: 3, toolCalls: 2 });
  });

  it('(b) write_test que apaga asserção é recusado e contado; a 2ª tentativa legítima grava', async () => {
    const ex = scriptedExecutor(ws.root, (code) => (code.includes("expect(screen.getByRole('status'))") ? execs.asyncFail() : execs.pass()));
    const fake = new FakeLLM({
      [REPAIRER_AGENT]: [
        call('write_test', { code: ASYNC_FIX_DELETING_ASSERTION }),
        call('write_test', { code: GOOD }),
        final('REPAIRED', 'O status só aparece após o login resolver; troquei getByRole por await findByRole mantendo todas as asserções.'),
      ],
    });

    const r = await healLoop({ ctx: loginCtx(ws.root), workspaceRoot: ws.root, generatedCode: BAD_ASYNC, llm: fake, maxIterations: 3, execute: ex.execute });

    const reqs = fake.requestsFor(REPAIRER_AGENT);
    const first = toolResults(reqs[1]!.messages)[0]!;
    expect(first).toMatchObject({ written: false, rejectedRepairs: 1 });
    expect(first.violations).toEqual([expect.stringMatching(/expect\( diminuiu de 5 para 4/)]);
    expect(toolResults(reqs[2]!.messages)[1]).toEqual({ written: true, path: TEST_FILE });
    expect(r).toMatchObject({ status: 'PASSED', iterations: 1, rejectedRepairs: 1, finalCode: GOOD });
    expect(r.history[0]).toMatchObject({ category: 'ASYNC', repairStatus: 'REPAIRED', rejectedRepairs: 1 });
  });

  it('(c) SUSPECTED_COMPONENT_BUG interrompe sem tocar no arquivo', async () => {
    const ex = scriptedExecutor(ws.root, () => execs.assertionFail());
    const fake = new FakeLLM({
      [REPAIRER_AGENT]: [
        call('read_file', { path: 'src/services/authApi.ts' }),
        final('SUSPECTED_COMPONENT_BUG', 'A regra R3 e o código exigem "Bem-vindo, <nome>!", mas o componente renderiza o nome vazio; a expectativa está correta.'),
      ],
    });

    const r = await healLoop({ ctx: loginCtx(ws.root), workspaceRoot: ws.root, generatedCode: GOOD, llm: fake, maxIterations: 3, execute: ex.execute, rules: '- R3: após o login, mostrar "Bem-vindo, <nome>!"' });

    expect(r).toMatchObject({ status: 'SUSPECTED_COMPONENT_BUG', stopReason: 'SUSPECTED_COMPONENT_BUG', iterations: 1, finalCode: GOOD, modificationRate: 0 });
    expect(onDisk()).toBe(GOOD);
    expect(ex.calls()).toBe(1); // não reexecuta
    expect(fake.requestsFor(REPAIRER_AGENT)[0]!.messages[0]!.content).toContain('R3: após o login');
  });

  it('(c) SUSPECTED_COMPONENT_BUG depois de um write_test: o código restaura o teste original', async () => {
    const ex = scriptedExecutor(ws.root, () => execs.assertionFail());
    const fake = new FakeLLM({
      [REPAIRER_AGENT]: [call('write_test', { code: withExtraAssertion(GOOD, 1) }), final('SUSPECTED_COMPONENT_BUG', 'O componente não mostra o nome.')],
    });
    const r = await healLoop({ ctx: loginCtx(ws.root), workspaceRoot: ws.root, generatedCode: GOOD, llm: fake, maxIterations: 3, execute: ex.execute });
    expect(r.status).toBe('SUSPECTED_COMPONENT_BUG');
    expect(onDisk()).toBe(GOOD);
    expect(r.history[0]!.wrote).toBe(false);
    expect(r.history[0]!.reasoning).toMatch(/foram desfeitas/);
  });

  it('(d) para em maxIterations', async () => {
    // cada execução falha com uma mensagem diferente (sem repetição de assinatura)
    const ex = scriptedExecutor(ws.root, (_code, n) => execs.assertionFail(`Error: expect(received).toHaveLength(${n})\n\nExpected length: ${n}\nReceived length: 0`));
    let k = 0;
    const fake = new FakeLLM({
      [REPAIRER_AGENT]: (req) => {
        const wrote = req.messages.some((m) => m.role === 'tool');
        if (wrote) return final('REPAIRED', 'Ajustei o teste.');
        const current = /## Teste atual\n```tsx\n([\s\S]*)\n```$/.exec(req.messages[0]!.content)![1]! + '\n';
        return call('write_test', { code: withExtraAssertion(current, ++k) });
      },
    });

    const r = await healLoop({ ctx: loginCtx(ws.root), workspaceRoot: ws.root, generatedCode: GOOD, llm: fake, maxIterations: 2, execute: ex.execute });

    expect(r).toMatchObject({ status: 'FAILED', stopReason: 'MAX_ITERATIONS', iterations: 2 });
    expect(ex.calls()).toBe(3); // execução inicial + 1 após cada reparo
    expect(r.history.map((h) => h.repairStatus)).toEqual(['REPAIRED', 'REPAIRED']);
    expect(r.finalCode).toContain('// extra 2');
    // a 2ª chamada do Reparador recebeu a tentativa anterior
    expect(fake.requestsFor(REPAIRER_AGENT).at(-2)!.messages[0]!.content).toMatch(/## Tentativas anteriores[\s\S]*iteração 1 \[ASSERTION\] Error: expect\(received\)\.toHaveLength\(1\) → REPAIRED/);
  });

  it('(e) para cedo quando a mesma assinatura de erro se repete', async () => {
    const ex = scriptedExecutor(ws.root, () => execs.asyncFail());
    const fake = new FakeLLM({
      [REPAIRER_AGENT]: [call('write_test', { code: withExtraAssertion(GOOD.replace("expect(await screen.findByRole('status'))", "expect(screen.getByRole('status'))"), 1) }), final('REPAIRED', 'Tentei.')],
    });

    const r = await healLoop({ ctx: loginCtx(ws.root), workspaceRoot: ws.root, generatedCode: BAD_ASYNC, llm: fake, maxIterations: 5, execute: ex.execute });

    expect(r).toMatchObject({ status: 'FAILED', stopReason: 'REPEATED_ERROR', iterations: 1 });
    expect(ex.calls()).toBe(2);
    expect(fake.requestsFor(REPAIRER_AGENT)).toHaveLength(2);
  });

  it('(g) write_test com import inválido é recusado; GAVE_UP sem gravar encerra o loop', async () => {
    const ex = scriptedExecutor(ws.root, () => execs.asyncFail());
    const fake = new FakeLLM({
      [REPAIRER_AGENT]: [call('write_test', { code: FIX_WITH_BAD_IMPORT }), final('GAVE_UP', 'Não encontrei correção válida.')],
    });

    const r = await healLoop({ ctx: loginCtx(ws.root), workspaceRoot: ws.root, generatedCode: BAD_ASYNC, llm: fake, maxIterations: 3, execute: ex.execute });

    const res = toolResults(fake.requestsFor(REPAIRER_AGENT)[1]!.messages)[0]!;
    expect(res).toMatchObject({ written: false, rejectedRepairs: 1 });
    expect(res.violations).toEqual([expect.stringMatching(/import não resolvido na linha 5: "\.\.\/test\/renderWithProviders"/)]);
    expect(onDisk()).toBe(BAD_ASYNC);
    expect(r).toMatchObject({ status: 'FAILED', stopReason: 'GAVE_UP', iterations: 1, rejectedRepairs: 1, modificationRate: 0 });
  });

  it('maxIterations 0 (heal desligado): só executa', async () => {
    const ex = scriptedExecutor(ws.root, () => execs.importFail());
    const r = await healLoop({ ctx: loginCtx(ws.root), workspaceRoot: ws.root, generatedCode: BAD_IMPORT, llm: new FakeLLM(), maxIterations: 0, execute: ex.execute });
    expect(r).toMatchObject({ status: 'FAILED', stopReason: 'MAX_ITERATIONS', iterations: 0, history: [] });
  });

  it('rejectedRepairs soma as recusas de todas as iterações', async () => {
    const ex = scriptedExecutor(ws.root, (_c, n) => (n >= 3 ? execs.pass() : execs.assertionFail(`Error: expect(received).toHaveLength(${n})`)));
    const fake = new FakeLLM({
      [REPAIRER_AGENT]: [
        call('write_test', { code: GOOD.replace(/it\('rejeita/, "it.skip('rejeita") }),
        call('write_test', { code: withExtraAssertion(GOOD, 1) }),
        final('REPAIRED', 'a'),
        call('write_test', { code: withExtraAssertion(GOOD, 1).replace("toHaveTextContent('Bem-vindo, Ana!')", 'toBeTruthy()') }),
        call('write_test', { code: withExtraAssertion(withExtraAssertion(GOOD, 1), 2) }),
        final('REPAIRED', 'b'),
      ],
    });
    const r = await healLoop({ ctx: loginCtx(ws.root), workspaceRoot: ws.root, generatedCode: GOOD, llm: fake, maxIterations: 3, execute: ex.execute });
    expect(r).toMatchObject({ status: 'PASSED', iterations: 2, rejectedRepairs: 2 });
    expect(r.history.map((h) => h.rejectedRepairs)).toEqual([1, 1]);
  });
});

describe('(f) modificationRate e diff de linhas', () => {
  it('linha substituída conta 1; adições e remoções somam pelo máximo', () => {
    expect(lineDiff('a\nb\nc\n', 'a\nb\nc\n')).toEqual({ added: 0, removed: 0, changed: 0 });
    expect(lineDiff('a\nb\nc\n', 'a\nB\nc\n')).toEqual({ added: 1, removed: 1, changed: 1 });
    expect(lineDiff('a\nb\nc\n', 'a\nb\nx\nc\ny\n')).toEqual({ added: 2, removed: 0, changed: 2 });
    expect(lineDiff('a\nb\nc\nd\n', 'a\nd\n')).toEqual({ added: 0, removed: 2, changed: 2 });
    expect(lineDiff('a\r\nb  \n', 'a\nb\n').changed).toBe(0); // CRLF e espaços finais não contam
  });

  it('taxa = linhas alteradas / linhas do código gerado inicial', () => {
    expect(modificationRate('a\nb\nc\nd\n', 'a\nB\nc\nd\n')).toBe(0.25);
    expect(modificationRate('a\nb\nc\nd\n', 'a\nb\nc\nd\ne\nf\n')).toBe(0.5);
    expect(modificationRate('a\nb\nc\n', 'a\nb\nc\n')).toBe(0);
    expect(modificationRate('', 'x')).toBe(0);
    expect(modificationRate(BAD_ASYNC, GOOD)).toBe(Math.round((1 / lines(BAD_ASYNC)) * 10_000) / 10_000);
  });
});

describe('assinatura de erro', () => {
  it('pula "● Test suite failed to run" e combina categoria + teste + 1ª linha', () => {
    expect(firstErrorLine(execs.importFail())).toMatch(/^src\/components\/LoginForm\.test\.tsx:3:27 - error TS2307/);
    expect(errorSignature(execs.asyncFail(), 'ASYNC')).toBe('ASYNC|LoginForm mostra boas-vindas no sucesso|TestingLibraryElementError: Unable to find an accessible element with the role "status"');
    expect(errorSignature(execs.asyncFail(), 'ASYNC')).not.toBe(errorSignature(execs.asyncFail(), 'MOCK'));
  });
});
