import { z } from 'zod';
import { type AgentTool, runAgent } from '../agent/runtime';
import type { TraceWriter } from '../agent/trace';
import { extractModuleReferences, validateImports } from '../importValidator';
import type { AgentMeter } from '../metrics';
import {
  codeUserPrompt,
  GENERATOR_CODE_SYSTEM_PROMPT,
  GENERATOR_PLAN_SYSTEM_PROMPT,
  planUserPrompt,
} from '../prompts/generator';
import { readFileTool } from '../tools/code';
import { validateImportsTool } from '../tools/validateImports';
import { getWorkspace } from '../tools/workspace';
import type { ContextResult, LLMClient, Scenario, TestPlan } from '../types';

export const GENERATOR_PLAN_AGENT = 'generator.plan';
export const GENERATOR_CODE_AGENT = 'generator.code';
const CODE_MAX_REPAIRS = 2;

export interface GenerateTestOptions {
  ctx: ContextResult;
  workspaceRoot: string;
  rules?: string;
  llm: LLMClient;
  maxSteps?: number;
  trace?: TraceWriter;
  meter?: AgentMeter;
}

export interface GenerateTestResult {
  plan: TestPlan;
  code: string;
}

const scenarioSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(['render', 'interaction', 'validation', 'async', 'edge']),
  description: z.string().min(1),
  mocks: z.array(z.string()).default([]),
  fromRules: z.array(z.string()).default([]),
});
const planSchemaBase = z.object({
  analysis: z.string().optional(),
  scenarios: z.array(scenarioSchema).min(1),
});

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Ids de regra citados em `fromRules` que realmente aparecem no texto das regras. */
export function knownRuleIds(ids: string[], rules?: string): string[] {
  if (!rules?.trim()) return [];
  return [...new Set(ids)].filter((id) => new RegExp(`(^|[^\\w-])${escapeRe(id)}(?![\\w-])`).test(rules));
}

/** Remove cercas ``` caso o LLM as tenha colocado dentro da string do código. */
export function stripCodeFences(code: string): string {
  const m = /^\s*```[\w-]*\s*\n([\s\S]*?)\n?```\s*$/.exec(code);
  return (m ? m[1]! : code).replace(/\r\n/g, '\n').trimEnd() + '\n';
}

const TRIVIAL_ASSERTION = /expect\(\s*(true|false|1|0|null|undefined|'[^']*'|"[^"]*")\s*\)/;
const FORBIDDEN = /\b(?:it|test|describe)\.(?:skip|only|todo)\b|\b(?:xit|xtest|xdescribe|fit|fdescribe)\s*\(/;

/** Guardrails determinísticos do arquivo de teste gerado (lista de problemas; vazia = ok). */
export function checkGeneratedCode(code: string, ctx: ContextResult, plan: TestPlan, workspaceRoot: string): string[] {
  const problems: string[] = [];
  const { unresolved } = validateImports(code, ctx, workspaceRoot);
  for (const u of unresolved) problems.push(`import não resolvido na linha ${u.line}: "${u.specifier}" (use apenas allowedImports)`);

  const describeRe = new RegExp(`\\bdescribe\\s*\\(\\s*(['"\`])${escapeRe(ctx.componentName)}\\1`);
  if (!describeRe.test(code)) problems.push(`falta o describe('${ctx.componentName}', ...) envolvendo os testes`);

  const cases = code.match(/\b(?:it|test)\s*\(/g)?.length ?? 0;
  if (cases < plan.scenarios.length) {
    problems.push(`o plano tem ${plan.scenarios.length} cenários, mas o código tem ${cases} casos it/test (cada cenário vira pelo menos um it)`);
  }
  if (!/\bexpect\s*\(/.test(code)) problems.push('não há nenhuma asserção expect(...)');
  if (TRIVIAL_ASSERTION.test(code)) problems.push('asserção trivial encontrada (ex.: expect(true)); verifique comportamento real');
  if (FORBIDDEN.test(code)) problems.push('uso proibido de .skip/.only/.todo/xit/fit');

  const mocked = new Set(
    extractModuleReferences(code)
      .filter((r) => r.via === 'jest.mock' && (r.jestFn === 'mock' || r.jestFn === 'doMock'))
      .map((r) => r.specifier),
  );
  for (const target of ctx.mockTargets) {
    if (!mocked.has(target)) problems.push(`mockTarget não mockado: falta jest.mock('${target}')`);
  }
  const ws = getWorkspace(workspaceRoot);
  const testAbs = ws.abs(ctx.testFilePath);
  for (const spec of mocked) {
    if (!ctx.mockTargets.includes(spec) && ws.resolveLocal(testAbs, spec)) {
      problems.push(`jest.mock('${spec}') mocka um módulo local fora de mockTargets`);
    }
  }
  return problems;
}

/** Agente 03 — Gerador: plano (CoT) e depois código, cada fase via runAgent. */
export async function generateTest(opts: GenerateTestOptions): Promise<GenerateTestResult> {
  const { ctx, workspaceRoot, rules, llm } = opts;
  const ws = getWorkspace(workspaceRoot);
  const common = {
    llm,
    temperature: 0.2,
    ...(opts.maxSteps !== undefined ? { maxSteps: opts.maxSteps } : {}),
    ...(opts.trace ? { trace: opts.trace } : {}),
    ...(opts.meter ? { meter: opts.meter } : {}),
  };

  // ---- Fase 1: plano ----
  const planSchema = planSchemaBase.superRefine((p, issue) => {
    const kinds = new Set(p.scenarios.map((s) => s.kind));
    if (!kinds.has('render')) issue.addIssue({ code: 'custom', path: ['scenarios'], message: 'inclua pelo menos um cenário "render"' });
    if (!kinds.has('edge')) issue.addIssue({ code: 'custom', path: ['scenarios'], message: 'inclua pelo menos um cenário "edge" (caso de borda)' });
    if (ctx.apiCalls.length && !kinds.has('async')) {
      issue.addIssue({ code: 'custom', path: ['scenarios'], message: `o componente chama API (${ctx.apiCalls.join(', ')}): inclua cenários "async" (loading, erro e sucesso)` });
    }
    p.scenarios.forEach((s, i) => {
      for (const m of s.mocks) {
        if (!ctx.mockTargets.includes(m)) {
          issue.addIssue({ code: 'custom', path: ['scenarios', i, 'mocks'], message: `"${m}" não está em mockTargets (${ctx.mockTargets.join(', ') || 'vazio'})` });
        }
      }
    });
  });

  const planRun = await runAgent({
    ...common,
    name: GENERATOR_PLAN_AGENT,
    system: GENERATOR_PLAN_SYSTEM_PROMPT,
    input: planUserPrompt(ctx, rules),
    tools: [readFileTool(ws)],
    finalSchema: planSchema,
  });
  // O código garante: ids de regra inexistentes são descartados.
  const plan: TestPlan = {
    scenarios: planRun.output.scenarios.map(
      (s): Scenario => ({ ...s, fromRules: knownRuleIds(s.fromRules, rules) }),
    ),
  };

  // ---- Fase 2: código ----
  let validateCalls = 0;
  const validateTool = validateImportsTool(ctx, workspaceRoot);
  const tools: AgentTool[] = [
    readFileTool(ws),
    {
      ...validateTool,
      run: async (args: { code: string }) => {
        validateCalls++;
        return validateTool.run({ code: stripCodeFences(args.code) });
      },
    },
  ];
  const codeSchema = z.object({ code: z.string().min(1) }).superRefine((out, issue) => {
    if (validateCalls === 0) {
      issue.addIssue({ code: 'custom', path: ['code'], message: 'chame a ferramenta validate_imports com o rascunho antes de entregar' });
    }
    for (const p of checkGeneratedCode(stripCodeFences(out.code), ctx, plan, workspaceRoot)) {
      issue.addIssue({ code: 'custom', path: ['code'], message: p });
    }
  });

  const codeRun = await runAgent({
    ...common,
    name: GENERATOR_CODE_AGENT,
    system: GENERATOR_CODE_SYSTEM_PROMPT,
    input: codeUserPrompt(ctx, plan, rules),
    tools,
    finalSchema: codeSchema,
    maxRepairs: CODE_MAX_REPAIRS,
  });

  return { plan, code: stripCodeFences(codeRun.output.code) };
}
