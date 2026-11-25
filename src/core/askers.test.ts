import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { CliAsker, FileAsker, keywords, NoopAsker } from './askers';

const write = (data: unknown) => {
  const f = join(mkdtempSync(join(tmpdir(), 'reactest-ans-')), 'answers.json');
  writeFileSync(f, JSON.stringify(data));
  return f;
};
const q = (question: string, component?: string, why = 'para o teste') => ({ id: 'Q1', question, why, ...(component ? { component } : {}) });

describe('FileAsker', () => {
  it('casa por palavras-chave (sem acento, plural, maiúsculas) dentro do componente', async () => {
    const a = new FileAsker(write({ CartSummary: { 'cupom|promo10|desconto': '10%' }, LoginForm: { 'mail|e-mail': 'obrigatório' } }));
    expect(await a.ask(q('Quais CUPONS de desconto existem?', 'src/components/CartSummary.tsx'))).toBe('10%');
    expect(await a.ask(q('O e-mail é obrigatório?', 'src/components/LoginForm.tsx'))).toBe('obrigatório');
    // escopo por componente: a resposta do CartSummary não vaza para o LoginForm
    expect(await a.ask(q('Existe cupom?', 'src/components/LoginForm.tsx'))).toBeUndefined();
  });

  it('casa pelo id ou pela pergunta exata; formato plano e "*" valem para qualquer componente', async () => {
    const a = new FileAsker(write({ Q1: 'por id', '*': { 'tema escuro': 'global' }, 'Qual o limite?': 'exata' }));
    expect(await a.ask(q('qualquer coisa'))).toBe('por id');
    expect(await a.ask({ id: 'Q9', question: 'Qual o limite?', why: '' })).toBe('exata');
    expect(await a.ask({ id: 'Q9', question: 'O tema escuro é o padrão?', why: '', component: 'src/X.tsx' })).toBe('global');
  });

  it('vence a chave com mais alternativas casadas; sem casamento devolve undefined (= pulou)', async () => {
    const a = new FileAsker(write({ PasswordField: { 'caracteres|tamanho': 'A', 'forte|forca|caracteres': 'B' } }));
    expect(await a.ask(q('Quantos caracteres a senha forte precisa ter?', 'PasswordField.tsx'))).toBe('B');
    expect(await a.ask(q('Qual a cor do botão?', 'PasswordField.tsx'))).toBeUndefined();
  });

  it('também procura no "why" e aceita o formato legado { answers }', async () => {
    const a = new FileAsker(write({ answers: { 'promo10': 'ok' } }));
    expect(await a.ask(q('Qual o valor?', 'X.tsx', 'o código PROMO10 aparece no componente'))).toBe('ok');
  });

  it('arquivo inválido gera erro claro', () => {
    expect(() => new FileAsker('/nao/existe.json')).toThrow(/Não foi possível ler o arquivo de respostas/);
    expect(() => new FileAsker(write([1, 2]))).toThrow(/objeto JSON/);
  });

  it('eval/answers.json casa as perguntas típicas dos componentes do fixture', async () => {
    const a = new FileAsker(fileURLToPath(new URL('../../eval/answers.json', import.meta.url)));
    expect(await a.ask(q('Qual o critério para a senha ser considerada forte?', 'src/components/PasswordField.tsx'))).toMatch(/12 caracteres.*número.*símbolo/);
    expect(await a.ask(q('Qual o percentual de desconto do cupom PROMO10?', 'src/components/CartSummary.tsx'))).toMatch(/10%/);
    expect(await a.ask(q('Quais mensagens de erro devem aparecer para e-mail inválido?', 'src/components/LoginForm.tsx'))).toMatch(/E-mail inválido\./);
  });

  it('keywords: normaliza acentos, descarta stopwords e reduz ao radical', () => {
    expect([...keywords('Qual é o tamanho MÍNIMO da senha?')]).toEqual(['taman', 'minim', 'senha']);
  });
});

describe('CliAsker / NoopAsker', () => {
  it('CliAsker lê a resposta da entrada; vazio = pulou', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const asker = new CliAsker(input, output);
    const p = asker.ask(q('Limite?'));
    input.write('8 caracteres\n');
    expect(await p).toBe('8 caracteres');
    const p2 = asker.ask(q('Outra?'));
    input.write('\n');
    expect(await p2).toBeUndefined();
  });

  it('NoopAsker sempre pula', async () => {
    expect(await new NoopAsker().ask()).toBeUndefined();
  });
});
