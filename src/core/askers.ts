import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import type { Asker } from './types';

/**
 * Asker não interativo (regra 8): lê um JSON `{ "<pergunta ou trecho/id>": "resposta" }`
 * (ou `{ "answers": { ... } }`). Casa pela pergunta exata ou por chave contida na pergunta (sem caixa).
 */
export function answersFileAsker(path: string): Asker & { answers: Record<string, string> } {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Não foi possível ler o arquivo de respostas "${path}": ${err instanceof Error ? err.message : String(err)}`);
  }
  const obj = (raw && typeof raw === 'object' && 'answers' in raw ? (raw as { answers: unknown }).answers : raw) as Record<string, unknown>;
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) throw new Error(`Arquivo de respostas "${path}" deve ser um objeto JSON { pergunta: resposta }.`);
  const answers = Object.fromEntries(Object.entries(obj).filter((e): e is [string, string] => typeof e[1] === 'string'));
  return {
    answers,
    ask: async (question) => {
      if (question in answers) return answers[question];
      const q = question.toLowerCase();
      const key = Object.keys(answers).find((k) => q.includes(k.toLowerCase()));
      return key === undefined ? undefined : answers[key];
    },
  };
}

/** Asker interativo no terminal (só quando stdin é TTY). Resposta vazia = sem resposta. */
export function terminalAsker(): Asker {
  return {
    ask: async (question, options) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        const hint = options?.length ? ` [${options.join(' / ')}]` : '';
        const a = (await rl.question(`\n? ${question}${hint}\n> `)).trim();
        return a || undefined;
      } finally {
        rl.close();
      }
    },
  };
}
