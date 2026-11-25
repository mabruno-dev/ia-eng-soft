import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeLLM } from '../../llm/fake';
import { REPAIR_SYSTEM_PROMPT } from '../prompts/repair';
import {
  ASYNC_FIX_DELETING_ASSERTION,
  BAD_ASYNC,
  call,
  execs,
  final,
  GOOD,
  loginCtx,
  TEST_FILE,
  tempWorkspace,
} from '../testing/healFixtures';
import type { RunJestArgs } from '../tools/jest';
import { checkRepairTool, createRepairState, REPAIR_MAX_RUNS, repairRunJestTool, writeTestTool } from '../tools/repair';
import type { ChatMessage, ExecResult } from '../types';
import { REPAIRER_AGENT, repairTest } from './repairer';

let ws: ReturnType<typeof tempWorkspace>;
beforeEach(() => {
  ws = tempWorkspace();
  writeFileSync(join(ws.root, TEST_FILE), BAD_ASYNC);
});
afterEach(() => ws.cleanup());

const onDisk = () => readFileSync(join(ws.root, TEST_FILE), 'utf8');
const toolResults = (msgs: ChatMessage[]) =>
  msgs.filter((m): m is Extract<ChatMessage, { role: 'tool' }> => m.role === 'tool').map((m) => JSON.parse(m.content) as Record<string, unknown>);
const diagnosis = { category: 'ASYNC' as const, summary: 'getByRole("status") roda antes de o login resolver.', flaky: false };

function base(llm: FakeLLM, extra: Partial<Parameters<typeof repairTest>[0]> = {}) {
  return { ctx: loginCtx(ws.root), workspaceRoot: ws.root, testFilePath: TEST_FILE, exec: execs.asyncFail(), diagnosis, llm, ...extra };
}

describe('repairTest (agente 05)', () => {
  it('testa a hipótese com run_jest(code), autoverifica com check_repair e grava com write_test', async () => {
    const runs: { args: RunJestArgs; content: string }[] = [];
    const runJest = async (root: string, args: RunJestArgs): Promise<ExecResult> => {
      runs.push({ args, content: readFileSync(join(root, args.testFile), 'utf8') });
      return execs.pass();
    };
    const fake = new FakeLLM({
      [REPAIRER_AGENT]: [
        call('run_jest', { code: GOOD }),
        call('check_repair', { code: GOOD }),
        call('write_test', { code: '```tsx\n' + GOOD + '```' }),
        final('REPAIRED', 'Troquei getByRole por await findByRole.'),
      ],
    });

    const r = await repairTest(base(fake, { runJest }));

    expect(r).toEqual({ status: 'REPAIRED', reasoning: 'Troquei getByRole por await findByRole.', wrote: true, rejectedRepairs: 0, code: GOOD, alignedToBehavior: false });
    expect(onDisk()).toBe(GOOD);
    // o rascunho roda num arquivo temporário ao lado do teste e é apagado; o teste real não muda no dry-run
    expect(runs[0]!.args).toEqual({ testFile: 'src/components/LoginForm.reactest-draft.test.tsx', componentFile: 'src/components/LoginForm.tsx' });
    expect(runs[0]!.content).toBe(GOOD);
    expect(existsSync(join(ws.root, 'src/components/LoginForm.reactest-draft.test.tsx'))).toBe(false);
    const results = toolResults(fake.requestsFor(REPAIRER_AGENT).at(-1)!.messages);
    expect(results[0]).toMatchObject({ target: 'rascunho (não gravado)', passed: true });
    expect(results[1]).toEqual({ ok: true, violations: [] });
    expect(results[2]).toEqual({ written: true, path: TEST_FILE });
  });

  it('o prompt traz a regra de não afrouxar, instruções por categoria e o contexto da falha', async () => {
    const fake = new FakeLLM({ [REPAIRER_AGENT]: [final('GAVE_UP', 'nada')] });
    await repairTest(base(fake, { rules: '- R1: e-mail válido', previousAttempts: ['iteração 1 [IMPORT] x → REPAIRED: y'] }));
    const req = fake.requestsFor(REPAIRER_AGENT)[0]!;
    expect(req.system).toBe(REPAIR_SYSTEM_PROMPT);
    for (const s of ['É PROIBIDO apagar', 'IMPORT: use APENAS os especificadores de allowedImports', 'MOCK: mocke exatamente os módulos de mockTargets', 'ASYNC:', 'e NÃO chame write_test', 'SUSPECTED_COMPONENT_BUG']) {
      expect(req.system).toContain(s);
    }
    const prompt = req.messages[0]!.content;
    expect(prompt).toContain('categoria: ASYNC');
    expect(prompt).toContain('Unable to find an accessible element with the role "status"');
    expect(prompt).toContain("mockTargets (use em jest.mock exatamente assim): '../services/authApi'");
    expect(prompt).toContain('R1: e-mail válido');
    expect(prompt).toContain('## Tentativas anteriores (não repita)');
    expect(prompt).toContain('O reparo anterior NÃO resolveu a falha. Tente uma abordagem DIFERENTE');
    expect(prompt).toContain('- iteração 1 [IMPORT] x → REPAIRED: y');
    expect(prompt).toContain(BAD_ASYNC.trimEnd());
    expect(prompt).toContain('export function LoginForm');
  });

  it('(a) SUSPECTED_COMPONENT_BUG sem evidência é rejeitado e devolvido ao agente', async () => {
    const fake = new FakeLLM({
      [REPAIRER_AGENT]: [
        final('SUSPECTED_COMPONENT_BUG', 'O componente deveria mostrar o nome.'),
        final('SUSPECTED_COMPONENT_BUG', 'A regra R3 exige o nome.', { evidence: 'R3: após o login, mostrar   "Bem-vindo, <nome>!"' }),
      ],
    });
    const r = await repairTest(base(fake, { exec: execs.assertionFail(), rules: '- R3: após o login, mostrar "Bem-vindo, <nome>!"' }));
    const feedback = fake.requestsFor(REPAIRER_AGENT)[1]!.messages.at(-1)!.content;
    expect(feedback).toMatch(/SUSPECTED_COMPONENT_BUG exige "evidence"/);
    expect(feedback).toMatch(/alignedToBehavior/);
    // espaços colapsados, mas o texto tem de ser literal
    expect(r).toMatchObject({ status: 'SUSPECTED_COMPONENT_BUG', evidence: 'R3: após o login, mostrar   "Bem-vindo, <nome>!"', alignedToBehavior: false });
    expect(onDisk()).toBe(BAD_ASYNC);
  });

  it('(a) erro de formato na evidence pode ser corrigido duas vezes (maxRepairs = 2)', async () => {
    const fake = new FakeLLM({
      [REPAIRER_AGENT]: [
        final('SUSPECTED_COMPONENT_BUG', 'x'),
        final('SUSPECTED_COMPONENT_BUG', 'x', { evidence: 'mostrar Bem-vindo com o nome' }),
        final('SUSPECTED_COMPONENT_BUG', 'x', { evidence: 'mostrar "Bem-vindo, <nome>!"' }),
      ],
    });
    const r = await repairTest(base(fake, { rules: '- R3: após o login, mostrar "Bem-vindo, <nome>!"' }));
    expect(fake.requestsFor(REPAIRER_AGENT)).toHaveLength(3);
    expect(r).toMatchObject({ status: 'SUSPECTED_COMPONENT_BUG', evidence: 'mostrar "Bem-vindo, <nome>!"' });
  });

  it('(a) evidência parafraseada (não literal) é rejeitada', async () => {
    const fake = new FakeLLM({
      [REPAIRER_AGENT]: [
        final('SUSPECTED_COMPONENT_BUG', 'x', { evidence: 'o componente deve exibir o nome completo' }),
        call('write_test', { code: GOOD }),
        final('REPAIRED', 'Alinhei ao comportamento observado.', { alignedToBehavior: true }),
      ],
    });
    const r = await repairTest(base(fake, { rules: '- R3: após o login, mostrar "Bem-vindo, <nome>!"' }));
    expect(fake.requestsFor(REPAIRER_AGENT)[1]!.messages.at(-1)!.content).toMatch(/"evidence" não aparece literalmente/);
    expect(r).toMatchObject({ status: 'REPAIRED', alignedToBehavior: true });
  });

  it('(a) evidência pode vir do código do componente; insistir sem evidência vira GAVE_UP', async () => {
    const ok = new FakeLLM({ [REPAIRER_AGENT]: [final('SUSPECTED_COMPONENT_BUG', 'x', { evidence: '<p role="status">Bem-vindo, {userName}!</p>' })] });
    expect((await repairTest(base(ok))).status).toBe('SUSPECTED_COMPONENT_BUG');

    const stubborn = new FakeLLM({ [REPAIRER_AGENT]: () => final('SUSPECTED_COMPONENT_BUG', 'confie em mim', { evidence: '   ' }) });
    const r = await repairTest(base(stubborn));
    expect(r.status).toBe('GAVE_UP');
    expect(onDisk()).toBe(BAD_ASYNC);
  });

  it('(b) REPAIRED com alignedToBehavior é registrado; alignedToBehavior sem REPAIRED é recusado', async () => {
    const fake = new FakeLLM({
      [REPAIRER_AGENT]: [
        final('GAVE_UP', 'nada', { alignedToBehavior: true }),
        call('write_test', { code: GOOD }),
        final('REPAIRED', 'Sem regra sobre o texto; alinhei ao texto exato renderizado.', { alignedToBehavior: true }),
      ],
    });
    const r = await repairTest(base(fake));
    expect(fake.requestsFor(REPAIRER_AGENT)[1]!.messages.at(-1)!.content).toMatch(/"alignedToBehavior": true só vale com status REPAIRED/);
    expect(r).toMatchObject({ status: 'REPAIRED', alignedToBehavior: true, wrote: true });
  });

  it('o prompt exige evidência para SUSPECTED_COMPONENT_BUG e orienta o alinhamento ao comportamento', () => {
    expect(REPAIR_SYSTEM_PROMPT).toContain('"evidence" é OBRIGATÓRIO');
    expect(REPAIR_SYSTEM_PROMPT).toContain('"alignedToBehavior": true');
    expect(REPAIR_SYSTEM_PROMPT).toContain('igualmente ESPECÍFICA');
  });

  it('REPAIRED sem write_test aceito é devolvido ao LLM', async () => {
    const fake = new FakeLLM({
      [REPAIRER_AGENT]: [final('REPAIRED', 'corrigi'), call('write_test', { code: GOOD }), final('REPAIRED', 'corrigi de verdade')],
    });
    const r = await repairTest(base(fake));
    expect(fake.requestsFor(REPAIRER_AGENT)[1]!.messages.at(-1)!.content).toMatch(/REPAIRED exige um write_test aceito/);
    expect(r.status).toBe('REPAIRED');
  });

  it('REPAIRED insistente sem gravar vira GAVE_UP (o código não aceita a palavra do LLM)', async () => {
    const fake = new FakeLLM({ [REPAIRER_AGENT]: [final('REPAIRED', 'corrigi'), final('REPAIRED', 'corrigi mesmo'), final('REPAIRED', 'juro')] });
    const r = await repairTest(base(fake));
    expect(r.status).toBe('GAVE_UP');
    expect(r.wrote).toBe(false);
    expect(onDisk()).toBe(BAD_ASYNC);
  });

  it('estouro de passos vira GAVE_UP com as recusas contadas', async () => {
    const fake = new FakeLLM({ [REPAIRER_AGENT]: () => call('write_test', { code: ASYNC_FIX_DELETING_ASSERTION }) });
    const r = await repairTest(base(fake, { maxSteps: 3 }));
    expect(r).toMatchObject({ status: 'GAVE_UP', wrote: false, rejectedRepairs: 3 });
    expect(r.reasoning).toMatch(/excedeu o limite de 3 passos/);
    expect(onDisk()).toBe(BAD_ASYNC);
  });
});

describe('ferramentas do Reparador', () => {
  it('check_repair é dry-run: não grava nem conta recusa', async () => {
    const state = createRepairState(ws.root, loginCtx(ws.root), TEST_FILE);
    const r = (await checkRepairTool(state).run({ code: ASYNC_FIX_DELETING_ASSERTION })) as { ok: boolean };
    expect(r.ok).toBe(false);
    expect(state.rejectedRepairs).toBe(0);
    expect(onDisk()).toBe(BAD_ASYNC);
  });

  it('write_test: recusa conta e não grava; código idêntico não grava nem conta; o guardrail compara com o conteúdo atual', async () => {
    const state = createRepairState(ws.root, loginCtx(ws.root), TEST_FILE);
    const tool = writeTestTool(state);
    expect(await tool.run({ code: ASYNC_FIX_DELETING_ASSERTION })).toMatchObject({ written: false, rejectedRepairs: 1 });
    expect(onDisk()).toBe(BAD_ASYNC);
    expect(await tool.run({ code: BAD_ASYNC })).toMatchObject({ written: false, violations: [] });
    expect(state.rejectedRepairs).toBe(1);
    expect(await tool.run({ code: GOOD })).toEqual({ written: true, path: TEST_FILE });
    // depois de gravar GOOD (5 expects), apagar uma asserção continua proibido
    expect(await tool.run({ code: ASYNC_FIX_DELETING_ASSERTION })).toMatchObject({ written: false, rejectedRepairs: 2 });
    expect(onDisk()).toBe(GOOD);
    expect(state.writes).toBe(1);
  });

  it(`run_jest: sem code roda o arquivo atual; limite de ${REPAIR_MAX_RUNS} execuções`, async () => {
    const state = createRepairState(ws.root, loginCtx(ws.root), TEST_FILE);
    const seen: string[] = [];
    const tool = repairRunJestTool(state, async (_r, a) => {
      seen.push(a.testFile);
      return execs.asyncFail();
    });
    for (let i = 0; i < REPAIR_MAX_RUNS; i++) await tool.run({});
    expect(seen).toEqual(Array(REPAIR_MAX_RUNS).fill(TEST_FILE));
    expect(state.lastExec?.numFailed).toBe(1);
    await expect(tool.run({})).rejects.toThrow(/limite de 4 execuções/);
  });

  it('run_jest com code apaga o rascunho mesmo se o Jest falhar', async () => {
    const state = createRepairState(ws.root, loginCtx(ws.root), TEST_FILE);
    const tool = repairRunJestTool(state, async () => {
      throw new Error('jest explodiu');
    });
    await expect(tool.run({ code: GOOD })).rejects.toThrow('jest explodiu');
    expect(existsSync(join(ws.root, 'src/components/LoginForm.reactest-draft.test.tsx'))).toBe(false);
    expect(onDisk()).toBe(BAD_ASYNC);
  });
});
