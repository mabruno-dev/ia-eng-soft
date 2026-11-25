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
import { classifyModule, readFileTool } from '../tools/code';
import { createTypechecker, type TypecheckFn, type TypecheckResult, typecheckTestTool } from '../tools/typecheck';
import { validateImportsTool } from '../tools/validateImports';
import { getWorkspace, isRelativeSpecifier, packageName, type Workspace } from '../tools/workspace';
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
  /** Typechecker injetável (testes); padrão: ts-morph em memória com o tsconfig do workspace. */
  typecheck?: TypecheckFn;
}

export interface GenerateTestResult {
  plan: TestPlan;
  code: string;
  /** Correções determinísticas feitas pelo código no plano (também vão para o trace). */
  warnings: string[];
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
  // Cenários "edge" que só poderiam ser escritos violando o tipo das props podem ser descartados.
  const required = plan.scenarios.filter((s) => s.kind !== 'edge').length;
  if (cases < required) {
    problems.push(
      `o plano tem ${plan.scenarios.length} cenários (${required} fora de "edge"), mas o código tem ${cases} casos it/test (cada cenário vira pelo menos um it; só "edge" pode ser descartado)`,
    );
  }
  if (!/\bexpect\s*\(/.test(code)) problems.push('não há nenhuma asserção expect(...)');
  if (TRIVIAL_ASSERTION.test(code)) problems.push('asserção trivial encontrada (ex.: expect(true)); verifique comportamento real');
  if (FORBIDDEN.test(code)) problems.push('uso proibido de .skip/.only/.todo/xit/fit');

  const mocked = new Set(
    extractModuleReferences(code)
      .filter((r) => r.via === 'jest.mock' && (r.jestFn === 'mock' || r.jestFn === 'doMock'))
      .map((r) => r.specifier),
  );
  const ws = getWorkspace(workspaceRoot);
  const testAbs = ws.abs(ctx.testFilePath);
  for (const target of ctx.mockTargets) {
    if (requiresJestMock(ws, testAbs, target) && !mocked.has(target)) problems.push(`mockTarget não mockado: falta jest.mock('${target}')`);
  }
  for (const spec of mocked) {
    if (!ctx.mockTargets.includes(spec) && ws.resolveLocal(testAbs, spec)) {
      problems.push(`jest.mock('${spec}') mocka um módulo local fora de mockTargets`);
    }
  }
  return problems;
}

/**
 * Um mockTarget exige jest.mock só se for módulo de I/O (rede/API). Stores globais e Contexts ficam reais:
 * o teste reseta o store (setState) ou renderiza dentro do Provider.
 */
export function requiresJestMock(ws: Workspace, testAbs: string, target: string): boolean {
  const local = ws.resolveLocal(testAbs, target);
  if (!local) return true; // pacote externo (ex.: axios) listado como mockTarget
  const c = classifyModule(ws, local);
  return c.api && !c.store && !c.context;
}

/** A entrada de `mocks` parece um especificador de módulo (e não um nome de hook/store/função)? */
export function looksLikeModuleSpecifier(ws: Workspace, entry: string): boolean {
  const s = entry.trim();
  if (isRelativeSpecifier(s) || s.startsWith('@/')) return true;
  if (/\s/.test(s) || !s) return false;
  return ws.isBuiltin(s) || ws.hasDependency(packageName(s));
}

/**
 * Correções determinísticas do plano (não recusam a resposta): descarta de `mocks` os especificadores
 * fora de mockTargets e avisa se falta cenário "edge". Nomes de hooks/stores/funções são texto livre.
 */
export function normalizePlan(plan: TestPlan, ctx: ContextResult, ws: Workspace): { plan: TestPlan; warnings: string[] } {
  const warnings: string[] = [];
  const scenarios = plan.scenarios.map((s) => {
    const mocks = s.mocks.filter((m) => {
      if (!looksLikeModuleSpecifier(ws, m) || ctx.mockTargets.includes(m)) return true;
      warnings.push(`plano: mock "${m}" do cenário "${s.name}" descartado (fora de mockTargets: ${ctx.mockTargets.join(', ') || 'vazio'})`);
      return false;
    });
    return { ...s, mocks };
  });
  if (!scenarios.some((s) => s.kind === 'edge')) warnings.push('plano sem cenário "edge" (caso de borda); seguindo assim mesmo');
  return { plan: { scenarios }, warnings };
}

/** Agente 03 — Gerador: plano (CoT) e depois código, cada fase via runAgent. */
export async function generateTest(opts: GenerateTestOptions): Promise<GenerateTestResult> {
  const { ctx, workspaceRoot, rules, llm } = opts;
  const ws = getWorkspace(workspaceRoot);
  const common = {
    llm,
    temperature: 0.2,
    jsonMode: true, // JSON estrito nas respostas finais quando o provider suporta
    ...(opts.maxSteps !== undefined ? { maxSteps: opts.maxSteps } : {}),
    ...(opts.trace ? { trace: opts.trace } : {}),
    ...(opts.meter ? { meter: opts.meter } : {}),
  };

  // ---- Fase 1: plano ----
  const planSchema = planSchemaBase.superRefine((p, issue) => {
    const kinds = new Set(p.scenarios.map((s) => s.kind));
    if (!kinds.has('render')) issue.addIssue({ code: 'custom', path: ['scenarios'], message: 'inclua pelo menos um cenário "render"' });
    if (ctx.apiCalls.length && !kinds.has('async')) {
      issue.addIssue({ code: 'custom', path: ['scenarios'], message: `o componente chama API (${ctx.apiCalls.join(', ')}): inclua cenários "async" (loading, erro e sucesso)` });
    }
  });

  const planRun = await runAgent({
    ...common,
    name: GENERATOR_PLAN_AGENT,
    system: GENERATOR_PLAN_SYSTEM_PROMPT,
    input: planUserPrompt(ctx, rules),
    tools: [readFileTool(ws)],
    finalSchema: planSchema,
  });
  // O código garante: ids de regra inexistentes e mocks fora de mockTargets são descartados (com aviso).
  const normalized = normalizePlan(
    { scenarios: planRun.output.scenarios.map((s): Scenario => ({ ...s, fromRules: knownRuleIds(s.fromRules, rules) })) },
    ctx,
    ws,
  );
  const plan = normalized.plan;
  for (const w of normalized.warnings) {
    await opts.trace?.write({ agent: GENERATOR_PLAN_AGENT, step: 0, kind: 'warning', text: w, llmMs: 0, ms: 0 });
  }

  // ---- Fase 2: código ----
  let validateCalls = 0;
  const validateTool = validateImportsTool(ctx, workspaceRoot);
  // Resultado do typecheck por código (normalizado): a entrega final precisa ter sido checada e estar sem erros.
  const typechecked = new Map<string, TypecheckResult>();
  const check = opts.typecheck ?? createTypechecker(workspaceRoot, ctx.testFilePath);
  const typecheckTool = typecheckTestTool(async (code) => {
    const r = await check(code);
    typechecked.set(code, r);
    return r;
  });
  const tools: AgentTool[] = [
    readFileTool(ws),
    {
      ...validateTool,
      run: async (args: { code: string }) => {
        validateCalls++;
        return validateTool.run({ code: stripCodeFences(args.code) });
      },
    },
    { ...typecheckTool, run: async (args: { code: string }) => typecheckTool.run({ code: stripCodeFences(args.code) }) },
  ];
  const codeSchema = z.object({ code: z.string().min(1) }).superRefine((out, issue) => {
    if (validateCalls === 0) {
      issue.addIssue({ code: 'custom', path: ['code'], message: 'chame a ferramenta validate_imports com o rascunho antes de entregar' });
    }
    const code = stripCodeFences(out.code);
    const tc = typechecked.get(code);
    if (!tc) {
      issue.addIssue({ code: 'custom', path: ['code'], message: 'chame typecheck_test com o código final EXATO que vai entregar (e corrija os erros) antes de responder' });
    } else if (!tc.ok) {
      const list = tc.diagnostics.map((d) => `${d.location} ${d.code}: ${d.message}`).join('; ');
      issue.addIssue({ code: 'custom', path: ['code'], message: `o código final tem ${tc.errors} erro(s) de tipo: ${list}. Corrija (nunca omita props obrigatórias) e chame typecheck_test de novo` });
    }
    for (const p of checkGeneratedCode(code, ctx, plan, workspaceRoot)) {
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

  return { plan, code: stripCodeFences(codeRun.output.code), warnings: normalized.warnings };
}
