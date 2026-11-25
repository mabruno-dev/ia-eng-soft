import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { candidateModels, chooseModel, formatModel, type ModelInfo } from './modelChoice';

const m = (id: string, family = id): ModelInfo => ({ id, family, name: id.toUpperCase(), maxInputTokens: 64_000 });
const MODELS = [m('gpt-4.1'), m('gpt-4o'), m('gpt-4o-mini'), m('claude-sonnet-4')];

describe('chooseModel', () => {
  it('com reactest.model vazio, escolhe o primeiro que passa no teste de tool calling (testados em ordem)', async () => {
    const tested: string[] = [];
    const r = await chooseModel(MODELS, '', async (x) => {
      tested.push(x.id);
      return x.id === 'gpt-4o' ? { ok: true } : { ok: false, error: 'sem tools' };
    });
    expect(r.ok && r.model.id).toBe('gpt-4o');
    expect(tested).toEqual(['gpt-4.1', 'gpt-4o']); // para no primeiro que passa
    expect(r.attempts).toEqual([
      { id: 'gpt-4.1', family: 'gpt-4.1', ok: false, error: 'sem tools' },
      { id: 'gpt-4o', family: 'gpt-4o', ok: true },
    ]);
  });

  it('com reactest.model, só a família pedida (sem caixa) é aceita, e precisa passar no teste', async () => {
    const r = await chooseModel(MODELS, 'GPT-4o', async () => ({ ok: true }));
    expect(r.ok && r.model.id).toBe('gpt-4o');
    const bad = await chooseModel(MODELS, 'gpt-4o', async () => ({ ok: false, error: 'tool calling recusado' }));
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.error).toMatch(/família "gpt-4o" passou no teste de tool calling: gpt-4o \(tool calling recusado\)/);
  });

  it('família inexistente, lista vazia e exceção no teste geram erro claro', async () => {
    const none = await chooseModel(MODELS, 'o3', async () => ({ ok: true }));
    expect(!none.ok && none.error).toMatch(/Nenhum modelo do Copilot da família "o3". Disponíveis: gpt-4.1, gpt-4o, gpt-4o-mini, claude-sonnet-4/);
    const empty = await chooseModel([], '', async () => ({ ok: true }));
    expect(!empty.ok && empty.error).toMatch(/Nenhum modelo de linguagem do Copilot/);
    const thrown = await chooseModel([m('a'), m('b')], '', async (x) => {
      if (x.id === 'a') throw new Error('Blocked');
      return { ok: true };
    });
    expect(thrown.ok && thrown.model.id).toBe('b');
    expect(thrown.attempts[0]).toEqual({ id: 'a', family: 'a', ok: false, error: 'Blocked' });
  });

  it('candidateModels aceita family ou id; formatModel mostra id, family, name e maxInputTokens', () => {
    expect(candidateModels([m('gpt-4o-2024', 'gpt-4o')], 'gpt-4o-2024').map((x) => x.id)).toEqual(['gpt-4o-2024']);
    expect(formatModel(m('gpt-4o'))).toMatch(/^gpt-4o\s+family=gpt-4o\s+name=GPT-4O · maxInputTokens=64000$/);
  });
});

describe('comandos da extensão', () => {
  it('todo comando contribuído no package.json é registrado em extension.ts, e vice-versa', () => {
    const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
      contributes: { commands: { command: string; title: string }[] };
    };
    const src = readFileSync(new URL('../extension/extension.ts', import.meta.url), 'utf8');
    const registered = [...src.matchAll(/registerCommand\('([^']+)'/g)].map((x) => x[1]).sort();
    const contributed = pkg.contributes.commands.map((c) => c.command).sort();
    expect(registered).toEqual(contributed);
    const titles = Object.fromEntries(pkg.contributes.commands.map((c) => [c.command, c.title]));
    expect(titles['reactest.listCopilotModels']).toBe('Listar modelos do Copilot');
    expect(titles['reactest.runEvaluation']).toBe('Rodar avaliação (Copilot)');
  });
});
