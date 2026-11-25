import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeLLM } from '../../llm/fake';
import { FileAsker, NoopAsker } from '../askers';
import { AgentMeter } from '../metrics';
import { ELICITATION_SYSTEM_PROMPT } from '../prompts/elicitation';
import { call, tempWorkspace } from '../testing/healFixtures';
import { loadRules, parseRulesMd, renderRulesMd, rulesFile, sourceHash } from '../tools/rules';
import type { Asker, AskerQuestion, ChatMessage, ContextResult } from '../types';
import { ELICITATION_AGENT, elicitRules } from './elicitation';

let ws: ReturnType<typeof tempWorkspace>;
beforeEach(() => {
  ws = tempWorkspace();
});
afterEach(() => ws.cleanup());

const COMPONENT = 'src/components/PasswordField.tsx';
const ctx = (): ContextResult => ({
  componentPath: COMPONENT,
  componentName: 'PasswordField',
  componentSource: readFileSync(join(ws.root, COMPONENT), 'utf8'),
  testFilePath: 'src/components/PasswordField.test.tsx',
  allowedImports: [{ name: 'PasswordField', specifier: './PasswordField', kind: 'named', isExternal: false }],
  dependencies: [],
  props: 'export interface PasswordFieldProps { label?: string; value: string; onChange: (value: string) => void }',
  hooks: ['useId', 'useState'],
  contexts: [],
  stores: [],
  apiCalls: [],
  mockTargets: [],
});

/** Asker roteirizado que registra as perguntas. */
function scriptedAsker(answers: (string | undefined)[]): Asker & { asked: AskerQuestion[] } {
  const asked: AskerQuestion[] = [];
  return {
    asked,
    ask: async (q) => {
      asked.push(q);
      return answers.shift();
    },
  };
}
const toolResults = (msgs: ChatMessage[]) =>
  msgs.filter((m): m is Extract<ChatMessage, { role: 'tool' }> => m.role === 'tool').map((m) => JSON.parse(m.content) as Record<string, unknown>);
const final = (rules: { id: string; question: string; answer: string }[]) => JSON.stringify({ rules });

const Q_FORTE = 'Qual é o critério exato para a senha ser classificada como forte?';
const A_FORTE = 'Pelo menos 12 caracteres, com número e símbolo.';

function seedRules(hash: string) {
  mkdirSync(join(ws.root, '.reactest'), { recursive: true });
  writeFileSync(
    rulesFile(ws.root),
    renderRulesMd([{ component: COMPONENT, hash, rules: [{ id: 'R1', question: Q_FORTE, answer: A_FORTE }] }]),
  );
}

describe('elicitRules (agente 02)', () => {
  it('pergunta, salva em .reactest/rules.md e devolve rulesText R1..Rn com as estatísticas contadas pelo código', async () => {
    const asker = scriptedAsker([A_FORTE, undefined]);
    const fake = new FakeLLM({
      [ELICITATION_AGENT]: [
        call('read_rules', { component: COMPONENT }),
        call('ask_user', { question: Q_FORTE, why: 'O indicador depende desse limite; o teste precisa dos valores-limite.' }),
        call('save_rule', { id: 'R1', question: Q_FORTE, answer: A_FORTE }),
        call('ask_user', { question: 'O rótulo padrão pode ser traduzido?', why: 'texto exibido' }),
        final([{ id: 'R1', question: Q_FORTE, answer: A_FORTE }]),
      ],
    });
    const meter = new AgentMeter();

    const r = await elicitRules({ ctx: ctx(), workspaceRoot: ws.root, llm: fake, asker, meter });

    expect(r.rulesText).toBe(`- R1: ${Q_FORTE} → ${A_FORTE}`);
    expect(r.stats).toEqual({ questions: 2, answered: 1, reused: 0 });
    expect(asker.asked[0]).toMatchObject({ id: 'Q1', question: Q_FORTE, component: COMPONENT });
    const results = toolResults(fake.requestsFor(ELICITATION_AGENT).at(-1)!.messages);
    expect(results[0]).toMatchObject({ rules: [], hashChanged: false });
    expect(results[1]).toEqual({ id: 'Q1', answer: A_FORTE, remaining: 4 });
    expect(results[3]).toEqual({ id: 'Q2', answer: '(pulou)', remaining: 3 });
    const saved = loadRules(ws.root);
    expect(saved).toEqual([{ component: COMPONENT, hash: sourceHash(ctx().componentSource), rules: [{ id: 'R1', question: Q_FORTE, answer: A_FORTE }] }]);
    expect(readFileSync(rulesFile(ws.root), 'utf8')).toContain(`## ${COMPONENT}`);
    expect(meter.agents()[ELICITATION_AGENT]).toEqual({ steps: 5, toolCalls: 4 });
    expect(fake.requestsFor(ELICITATION_AGENT)[0]!.system).toBe(ELICITATION_SYSTEM_PROMPT);
  });

  it('reaproveita regras já respondidas (mesmo hash) sem perguntar de novo', async () => {
    seedRules(sourceHash(ctx().componentSource));
    const asker = scriptedAsker([]);
    const fake = new FakeLLM({
      [ELICITATION_AGENT]: [call('read_rules', { component: COMPONENT }), final([{ id: 'R1', question: Q_FORTE, answer: A_FORTE }])],
    });
    const r = await elicitRules({ ctx: ctx(), workspaceRoot: ws.root, llm: fake, asker });
    expect(asker.asked).toHaveLength(0);
    expect(r.stats).toEqual({ questions: 0, answered: 0, reused: 1 });
    expect(r.rulesText).toContain('R1:');
    expect(toolResults(fake.requestsFor(ELICITATION_AGENT)[1]!.messages)[0]).toMatchObject({ hashChanged: false, rules: [{ id: 'R1' }] });
  });

  it('hash alterado: read_rules avisa e o agente reconfirma; o hash salvo é atualizado', async () => {
    seedRules('000000000000');
    const asker = scriptedAsker(['Agora são 14 caracteres, com número e símbolo.']);
    const fake = new FakeLLM({
      [ELICITATION_AGENT]: [
        call('read_rules', { component: COMPONENT }),
        call('ask_user', { question: `${Q_FORTE} (o código mudou; ainda vale?)`, why: 'reconfirmar' }),
        call('save_rule', { id: 'R1', question: Q_FORTE, answer: 'Agora são 14 caracteres, com número e símbolo.' }),
        final([{ id: 'R1', question: Q_FORTE, answer: 'Agora são 14 caracteres, com número e símbolo.' }]),
      ],
    });
    const r = await elicitRules({ ctx: ctx(), workspaceRoot: ws.root, llm: fake, asker });
    const read = toolResults(fake.requestsFor(ELICITATION_AGENT)[1]!.messages)[0]!;
    expect(read).toMatchObject({ hashChanged: true });
    expect(read.hint).toMatch(/reconfirme/);
    expect(r.stats).toEqual({ questions: 1, answered: 1, reused: 0 });
    expect(loadRules(ws.root)[0]).toMatchObject({ hash: sourceHash(ctx().componentSource), rules: [{ id: 'R1', answer: 'Agora são 14 caracteres, com número e símbolo.' }] });
  });

  it('o limite de perguntas é imposto pela ferramenta (o asker não é chamado além dele)', async () => {
    const asker = scriptedAsker(['a', 'b', 'c']);
    const fake = new FakeLLM({
      [ELICITATION_AGENT]: [
        call('read_rules', {}),
        call('ask_user', { question: 'P1?', why: 'w' }),
        call('ask_user', { question: 'P2?', why: 'w' }),
        call('ask_user', { question: 'P3?', why: 'w' }),
        final([]),
      ],
    });
    const r = await elicitRules({ ctx: ctx(), workspaceRoot: ws.root, llm: fake, asker, maxQuestions: 2 });
    expect(asker.asked.map((q) => q.question)).toEqual(['P1?', 'P2?']);
    expect(toolResults(fake.requestsFor(ELICITATION_AGENT).at(-1)!.messages)[3]).toMatchObject({ error: expect.stringMatching(/limite de 2 perguntas atingido/), remaining: 0 });
    expect(r.stats.questions).toBe(2);
    expect(fake.requestsFor(ELICITATION_AGENT)[0]!.messages[0]!.content).toContain('Limite de perguntas nesta execução: 2');
  });

  it('pergunta de acompanhamento quando a resposta é vaga; a regra combina as duas respostas', async () => {
    const asker = scriptedAsker(['Depende, tem que ser bem longa.', '12 ou mais caracteres, com número e símbolo.']);
    const rule = { id: 'R1', question: Q_FORTE, answer: 'Bem longa: 12 ou mais caracteres, com número e símbolo.' };
    const fake = new FakeLLM({
      [ELICITATION_AGENT]: [
        call('read_rules', {}),
        call('ask_user', { question: Q_FORTE, why: 'limites do indicador' }),
        { text: 'A resposta foi vaga ("bem longa"); vou pedir o número exato.', toolCalls: call('ask_user', { question: 'Quantos caracteres, no mínimo, para ser forte? Exige número e símbolo?', why: 'valor-limite exato' }).toolCalls },
        call('save_rule', rule),
        final([rule]),
      ],
    });
    const r = await elicitRules({ ctx: ctx(), workspaceRoot: ws.root, llm: fake, asker });
    expect(asker.asked.map((q) => q.id)).toEqual(['Q1', 'Q2']);
    expect(r.stats).toEqual({ questions: 2, answered: 2, reused: 0 });
    expect(r.rules).toEqual([rule]);
    expect(ELICITATION_SYSTEM_PROMPT).toContain('pergunta de acompanhamento');
  });

  it('regra que não veio do dev (nem salva nem lida) é recusada e volta ao agente', async () => {
    const fake = new FakeLLM({
      [ELICITATION_AGENT]: [
        call('read_rules', {}),
        final([{ id: 'R1', question: 'Senha forte?', answer: 'Inventei: 10 caracteres.' }]),
        final([]),
      ],
    });
    const r = await elicitRules({ ctx: ctx(), workspaceRoot: ws.root, llm: fake, asker: new NoopAsker() });
    expect(fake.requestsFor(ELICITATION_AGENT)[2]!.messages.at(-1)!.content).toMatch(/R1 não foi salva com save_rule/);
    expect(r).toEqual({ rules: [], rulesText: '', stats: { questions: 0, answered: 0, reused: 0 } });
    expect(existsSync(rulesFile(ws.root))).toBe(false);
  });

  it('sem read_rules a conclusão é recusada; save_rule recusa resposta "(pulou)"', async () => {
    const fake = new FakeLLM({
      [ELICITATION_AGENT]: [final([]), call('read_rules', {}), call('save_rule', { id: 'R1', question: 'x', answer: '(pulou)' }), final([])],
    });
    await elicitRules({ ctx: ctx(), workspaceRoot: ws.root, llm: fake, asker: new NoopAsker() });
    const reqs = fake.requestsFor(ELICITATION_AGENT);
    expect(reqs[1]!.messages.at(-1)!.content).toMatch(/chame read_rules antes de concluir/);
    expect(toolResults(reqs[3]!.messages).at(-1)!.error).toMatch(/pergunta pulada não vira regra/);
  });

  it('estouro de passos não perde as respostas: usa as regras salvas na sessão', async () => {
    const fake = new FakeLLM({
      [ELICITATION_AGENT]: [
        call('read_rules', {}),
        call('ask_user', { question: Q_FORTE, why: 'w' }),
        call('save_rule', { id: 'R1', question: Q_FORTE, answer: A_FORTE }),
        call('read_rules', {}),
      ],
    });
    const r = await elicitRules({ ctx: ctx(), workspaceRoot: ws.root, llm: fake, asker: scriptedAsker([A_FORTE]), maxSteps: 4 });
    expect(r.rules).toEqual([{ id: 'R1', question: Q_FORTE, answer: A_FORTE }]);
  });

  it('modo não interativo com FileAsker: responde por palavras-chave do componente; sem casamento = "(pulou)"', async () => {
    const file = join(ws.root, 'answers.json');
    writeFileSync(file, JSON.stringify({ PasswordField: { 'forte|força|criterio': A_FORTE }, LoginForm: { senha: 'mínimo 8' } }));
    const fake = new FakeLLM({
      [ELICITATION_AGENT]: [
        call('read_rules', {}),
        call('ask_user', { question: 'Qual é o critério para a força ser considerada forte?', why: 'limites' }),
        call('ask_user', { question: 'Qual a cor do indicador?', why: 'estilo' }),
        call('save_rule', { id: 'R1', question: Q_FORTE, answer: A_FORTE }),
        final([{ id: 'R1', question: Q_FORTE, answer: A_FORTE }]),
      ],
    });
    const r = await elicitRules({ ctx: ctx(), workspaceRoot: ws.root, llm: fake, asker: new FileAsker(file) });
    const results = toolResults(fake.requestsFor(ELICITATION_AGENT).at(-1)!.messages);
    expect(results[1]).toMatchObject({ answer: A_FORTE });
    expect(results[2]).toMatchObject({ answer: '(pulou)' });
    expect(r.stats).toEqual({ questions: 2, answered: 1, reused: 0 });
  });
});

describe('rules.md', () => {
  it('parse ↔ render (várias seções, setas na pergunta)', () => {
    const sections = [
      { component: 'src/A.tsx', hash: 'abc123abc123', rules: [{ id: 'R1', question: 'Q → com seta?', answer: 'sim' }] },
      { component: 'src/B.tsx', hash: 'def456def456', rules: [{ id: 'R1', question: 'Q2', answer: 'R → 2' }, { id: 'R2', question: 'Q3', answer: 'x' }] },
    ];
    const parsed = parseRulesMd(renderRulesMd(sections));
    expect(parsed.map((s) => s.component)).toEqual(['src/A.tsx', 'src/B.tsx']);
    expect(parsed[1]!.rules[1]).toEqual({ id: 'R2', question: 'Q3', answer: 'x' });
    expect(parsed[0]!.hash).toBe('abc123abc123');
  });
});
