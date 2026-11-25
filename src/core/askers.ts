import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import type { Asker, AskerQuestion } from './types';

/** Asker que sempre "pula" (sem TTY e sem arquivo de respostas). */
export class NoopAsker implements Asker {
  async ask(): Promise<string | undefined> {
    return undefined;
  }
}

/** Asker interativo no terminal (readline). Resposta vazia = pulou. */
export class CliAsker implements Asker {
  constructor(
    private readonly input: NodeJS.ReadableStream = process.stdin,
    private readonly output: NodeJS.WritableStream = process.stderr,
  ) {}

  async ask(q: AskerQuestion): Promise<string | undefined> {
    const rl = createInterface({ input: this.input, output: this.output });
    try {
      const a = (await rl.question(`\n? [${q.id}] ${q.question}\n  (${q.why})\n  Enter vazio = pular\n> `)).trim();
      return a || undefined;
    } finally {
      rl.close();
    }
  }
}

// ---------------------------------------------------------------------------
// FileAsker — modo não interativo (avaliação em lote)
// ---------------------------------------------------------------------------

const STOPWORDS = new Set(
  ('que qual quais para com uma umas uns por como deve devem pode podem quando onde esse essa este esta isso isto ser sao tem ter ' +
    'mais menos sobre entre seu sua seus suas dos das nos nas pelo pela pelos pelas qualquer algum alguma existe existem caso ' +
    'componente teste regra regras valor valores the and for with what which').split(' '),
);

/** Normaliza para comparação: minúsculas, sem acento, tokens alfanuméricos ≥ 3 letras, sem stopwords, "radical" de 5 letras. */
export function keywords(text: string): Set<string> {
  const plain = text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  return new Set(
    plain
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3 && !STOPWORDS.has(t))
      .map((t) => t.slice(0, 5)),
  );
}

const componentKey = (s: string) => s.replace(/\\/g, '/').split('/').pop()!.replace(/\.[^.]+$/, '').toLowerCase();

/**
 * Melhor resposta para a pergunta entre `entries` (chave → resposta). Uma chave pode ter alternativas
 * separadas por "|" ("cupom|promo10|desconto"); uma alternativa casa se TODAS as suas palavras-chave aparecem
 * na pergunta (ou no "why"). Vence a chave com mais alternativas casadas; empate = a primeira. Sem casamento: undefined.
 */
export function matchAnswer(entries: [string, string][], q: AskerQuestion): string | undefined {
  const exact = entries.find(([k]) => k === q.id || k.trim().toLowerCase() === q.question.trim().toLowerCase());
  if (exact) return exact[1];
  const words = keywords(`${q.question} ${q.why}`);
  let best: { score: number; answer: string } | undefined;
  for (const [key, answer] of entries) {
    const score = key
      .split('|')
      .map((alt) => keywords(alt))
      .filter((alt) => alt.size > 0 && [...alt].every((w) => words.has(w))).length;
    if (score > 0 && (!best || score > best.score)) best = { score, answer };
  }
  return best?.answer;
}

/**
 * Lê respostas de um JSON. Formatos aceitos:
 *  - por componente: `{ "PasswordField": { "força|forte": "resposta", ... }, "*": { ... } }`;
 *  - plano: `{ "<id ou pergunta ou palavras-chave>": "resposta" }` (vale para qualquer componente);
 *  - legado: `{ "answers": { ... } }`.
 * Casa pela pergunta exata/id ou por palavras-chave (ver matchAnswer), primeiro na seção do componente.
 * Sem casamento: undefined (= "(pulou)").
 */
export class FileAsker implements Asker {
  readonly global: [string, string][] = [];
  readonly byComponent = new Map<string, [string, string][]>();

  constructor(readonly path: string) {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      throw new Error(`Não foi possível ler o arquivo de respostas "${path}": ${err instanceof Error ? err.message : String(err)}`);
    }
    const root = (raw && typeof raw === 'object' && 'answers' in raw ? (raw as { answers: unknown }).answers : raw) as Record<string, unknown>;
    if (!root || typeof root !== 'object' || Array.isArray(root)) throw new Error(`Arquivo de respostas "${path}" deve ser um objeto JSON.`);
    for (const [k, v] of Object.entries(root)) {
      if (typeof v === 'string') this.global.push([k, v]);
      else if (v && typeof v === 'object' && !Array.isArray(v)) {
        const entries = Object.entries(v).filter((e): e is [string, string] => typeof e[1] === 'string');
        if (k === '*') this.global.push(...entries);
        else this.byComponent.set(componentKey(k), entries);
      }
    }
  }

  async ask(q: AskerQuestion): Promise<string | undefined> {
    const scoped = q.component ? this.byComponent.get(componentKey(q.component)) ?? [] : [];
    return matchAnswer(scoped, q) ?? matchAnswer(this.global, q);
  }
}
