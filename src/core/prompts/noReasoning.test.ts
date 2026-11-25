// Nenhum agente pede raciocínio interno (CoT, "explique", "justifique") nem tem campo de raciocínio
// no JSON de saída: o Claude Code recusa isso ("safeguards flagged … [reasoning_extraction]").
// Campos factuais curtos (description do cenário, summary, note, evidence literal) continuam.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONTEXT_SYSTEM_PROMPT } from './context';
import { ELICITATION_SYSTEM_PROMPT } from './elicitation';
import { EXECUTOR_SYSTEM_PROMPT } from './executor';
import { GENERATOR_CODE_SYSTEM_PROMPT, GENERATOR_PLAN_SYSTEM_PROMPT, planUserPrompt } from './generator';
import { REPAIR_SYSTEM_PROMPT } from './repair';
import { VERIFIER_SYSTEM_PROMPT, verifierUserPrompt } from './verifier';
import type { ContextResult } from '../types';

const REASONING_REQUEST = /racioc[ií]n|raciocine|passo a passo|step by step|chain.of.thought|\bCoT\b|justifi|explique|explicando|pense\b|think|\breasoning\b|\brationale\b|\bthoughts?\b|"analysis"/i;

const ctx: ContextResult = {
  componentPath: 'src/X.tsx', componentName: 'X', componentSource: 'export const X = () => null;', testFilePath: 'src/X.test.tsx',
  allowedImports: [], dependencies: [], props: '', hooks: [], contexts: [], stores: [], apiCalls: [], mockTargets: [],
};

describe('prompts sem pedido de raciocínio interno', () => {
  const prompts: Record<string, string> = {
    context: CONTEXT_SYSTEM_PROMPT,
    elicitation: ELICITATION_SYSTEM_PROMPT,
    'generator.plan': GENERATOR_PLAN_SYSTEM_PROMPT,
    'generator.code': GENERATOR_CODE_SYSTEM_PROMPT,
    executor: EXECUTOR_SYSTEM_PROMPT,
    repairer: REPAIR_SYSTEM_PROMPT,
    verifier: VERIFIER_SYSTEM_PROMPT,
    'verifier (usuário)': verifierUserPrompt(ctx, 'src/X.test.tsx', "it('x', () => {});"),
    'generator.plan (usuário)': planUserPrompt(ctx, 'R1: algo'),
  };
  for (const [name, text] of Object.entries(prompts)) {
    it(name, () => expect(text.match(REASONING_REQUEST)?.[0]).toBeUndefined());
  }

  it('os schemas zod dos agentes não têm campos reasoning/rationale/thoughts/analysis', () => {
    const dir = fileURLToPath(new URL('../agents/', import.meta.url));
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.ts') && !n.endsWith('.test.ts'))) {
      expect(readFileSync(dir + f, 'utf8'), f).not.toMatch(/\b(reasoning|rationale|thoughts?|analysis)\s*:\s*z\./);
    }
  });
});
