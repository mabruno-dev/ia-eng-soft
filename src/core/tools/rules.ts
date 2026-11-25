// Ferramentas da Elicitação (agente 02): regras de negócio respondidas pelo dev, persistidas em `.reactest/rules.md`.
//
// Formato:
//   # Regras de negócio (ReacTest-Agent)
//
//   ## src/components/PasswordField.tsx
//   <!-- hash: 1a2b3c4d5e6f -->
//   - [R1] Pergunta → Resposta
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { AgentTool } from '../agent/runtime';
import type { Asker } from '../types';

export interface Rule {
  id: string;
  question: string;
  answer: string;
}
export interface RuleSection {
  component: string;
  hash: string;
  rules: Rule[];
}

export const SKIPPED = '(pulou)';
export const DEFAULT_MAX_QUESTIONS = 5;
const ARROW = ' → ';

export const rulesFile = (workspaceRoot: string) => join(workspaceRoot, '.reactest', 'rules.md');

/** Hash curto do código-fonte (quebras de linha normalizadas). */
export function sourceHash(source: string): string {
  return createHash('sha256').update(source.replace(/\r\n/g, '\n')).digest('hex').slice(0, 12);
}

const oneLine = (s: string) => s.replace(/\s*\r?\n\s*/g, ' ').trim();

export function parseRulesMd(text: string): RuleSection[] {
  const sections: RuleSection[] = [];
  let cur: RuleSection | undefined;
  for (const line of text.split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) {
      cur = { component: h[1]!, hash: '', rules: [] };
      sections.push(cur);
      continue;
    }
    if (!cur) continue;
    const hash = /^<!--\s*hash:\s*([0-9a-f]+)\s*-->/.exec(line);
    if (hash) {
      cur.hash = hash[1]!;
      continue;
    }
    const item = /^-\s*\[([^\]]+)\]\s*(.*)$/.exec(line);
    if (item) {
      const body = item[2]!;
      const at = body.lastIndexOf(ARROW);
      cur.rules.push(at >= 0 ? { id: item[1]!, question: body.slice(0, at).trim(), answer: body.slice(at + ARROW.length).trim() } : { id: item[1]!, question: body.trim(), answer: '' });
    }
  }
  return sections;
}

export function renderRulesMd(sections: RuleSection[]): string {
  const out = ['# Regras de negócio (ReacTest-Agent)', '', 'Respostas do desenvolvedor às perguntas da Elicitação. Editável à mão: um item por regra, `- [id] pergunta → resposta`.', ''];
  for (const s of sections) {
    out.push(`## ${s.component}`, `<!-- hash: ${s.hash} -->`, ...s.rules.map((r) => `- [${r.id}] ${oneLine(r.question)}${ARROW}${oneLine(r.answer)}`), '');
  }
  return out.join('\n');
}

export function loadRules(workspaceRoot: string): RuleSection[] {
  const f = rulesFile(workspaceRoot);
  return existsSync(f) ? parseRulesMd(readFileSync(f, 'utf8')) : [];
}

/** Insere/atualiza a regra (por id) na seção do componente e grava o hash atual do código. */
export function upsertRule(workspaceRoot: string, component: string, hash: string, rule: Rule): void {
  const sections = loadRules(workspaceRoot);
  let s = sections.find((x) => x.component === component);
  if (!s) sections.push((s = { component, hash, rules: [] }));
  s.hash = hash;
  const i = s.rules.findIndex((r) => r.id === rule.id);
  if (i >= 0) s.rules[i] = rule;
  else s.rules.push(rule);
  const f = rulesFile(workspaceRoot);
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, renderRulesMd(sections), 'utf8');
}

/** Estado de uma sessão da Elicitação (o código conta perguntas e respostas: os números não vêm do LLM). */
export interface ElicitationState {
  workspaceRoot: string;
  component: string; // relativo ao workspace
  hash: string; // hash atual do código-fonte do componente
  asker: Asker;
  maxQuestions: number;
  asked: { id: string; question: string; answer: string }[]; // perguntas feitas ao dev (answer = SKIPPED se pulou)
  refused: number; // chamadas a ask_user recusadas pelo limite
  stored: Rule[]; // regras lidas por read_rules
  hashChanged: boolean;
  readCalled: boolean;
  saved: Map<string, Rule>;
}

export function createElicitationState(o: { workspaceRoot: string; component: string; componentSource: string; asker: Asker; maxQuestions?: number }): ElicitationState {
  return {
    workspaceRoot: o.workspaceRoot,
    component: o.component,
    hash: sourceHash(o.componentSource),
    asker: o.asker,
    maxQuestions: o.maxQuestions ?? DEFAULT_MAX_QUESTIONS,
    asked: [],
    refused: 0,
    stored: [],
    hashChanged: false,
    readCalled: false,
    saved: new Map(),
  };
}

const norm = (p: string) => p.replace(/\\/g, '/').replace(/^\.\//, '');

export function readRulesTool(state: ElicitationState): AgentTool<{ component?: string | undefined }> {
  return {
    spec: {
      name: 'read_rules',
      description:
        'Lê as regras de negócio já respondidas pelo dev para este componente (.reactest/rules.md). ' +
        'Devolve { component, rules: [{ id, question, answer }], hashChanged } — hashChanged = true se o código do componente mudou desde que as regras foram salvas.',
      parameters: { type: 'object', properties: { component: { type: 'string', description: 'caminho do componente (relativo à raiz)' } } },
    },
    argsSchema: z.object({ component: z.string().optional() }),
    run: async ({ component }) => {
      // Escopo: sempre o componente desta execução.
      const section = loadRules(state.workspaceRoot).find((s) => norm(s.component) === norm(state.component));
      state.stored = section?.rules.filter((r) => r.answer && r.answer !== SKIPPED) ?? [];
      state.hashChanged = !!section && section.hash !== state.hash;
      state.readCalled = true;
      return {
        component: state.component,
        ...(component && norm(component) !== norm(state.component) ? { note: `só as regras de ${state.component} estão disponíveis nesta execução` } : {}),
        rules: state.stored,
        hashChanged: state.hashChanged,
        ...(state.hashChanged ? { hint: 'o código mudou desde que estas regras foram respondidas: reconfirme com ask_user as que dependem do trecho alterado' } : {}),
      };
    },
  };
}

export function askUserTool(state: ElicitationState): AgentTool<{ question: string; why: string }> {
  return {
    spec: {
      name: 'ask_user',
      description:
        `Faz UMA pergunta de regra de negócio ao desenvolvedor e devolve a resposta (ou "${SKIPPED}"). ` +
        `No máximo ${state.maxQuestions} perguntas por execução (imposto pela ferramenta).`,
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'pergunta objetiva, em pt-BR' },
          why: { type: 'string', description: 'por que a resposta importa para o teste (mostrado ao dev)' },
        },
        required: ['question', 'why'],
      },
    },
    argsSchema: z.object({ question: z.string().min(1), why: z.string().min(1) }),
    run: async ({ question, why }) => {
      if (state.asked.length >= state.maxQuestions) {
        state.refused++;
        return { error: `limite de ${state.maxQuestions} perguntas atingido: não pergunte mais; salve o que tem e responda o JSON final`, remaining: 0 };
      }
      const id = `Q${state.asked.length + 1}`;
      const raw = await state.asker.ask({ id, question, why, component: state.component });
      const answer = raw?.trim() ? raw.trim() : SKIPPED;
      state.asked.push({ id, question, answer });
      return { id, answer, remaining: state.maxQuestions - state.asked.length };
    },
  };
}

export function saveRuleTool(state: ElicitationState): AgentTool<{ id: string; question: string; answer: string }> {
  return {
    spec: {
      name: 'save_rule',
      description: 'Persiste em .reactest/rules.md uma regra respondida pelo dev ({ id: "R1", question, answer }). Reusar um id atualiza a regra.',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string', description: 'R1, R2, ...' }, question: { type: 'string' }, answer: { type: 'string' } },
        required: ['id', 'question', 'answer'],
      },
    },
    argsSchema: z.object({ id: z.string().regex(/^R\d+$/, 'use ids R1, R2, ...'), question: z.string().min(1), answer: z.string().min(1) }),
    run: async (rule) => {
      if (rule.answer.trim() === SKIPPED) throw new Error('pergunta pulada não vira regra: não salve respostas "(pulou)"');
      upsertRule(state.workspaceRoot, state.component, state.hash, rule);
      state.saved.set(rule.id, rule);
      return { saved: true, id: rule.id };
    },
  };
}
