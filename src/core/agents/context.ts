import { readFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { z } from 'zod';
import { type AgentTool, runAgent } from '../agent/runtime';
import type { TraceWriter } from '../agent/trace';
import type { AgentMeter } from '../metrics';
import { CONTEXT_SYSTEM_PROMPT, contextUserPrompt } from '../prompts/context';
import { createCodeTools } from '../tools/code';
import { getWorkspace, isRelativeSpecifier, packageName, type Workspace, WorkspaceError } from '../tools/workspace';
import type { ContextResult, ImportInfo, LLMClient } from '../types';

export const CONTEXT_AGENT = 'context';
export const DEFAULT_MAX_DEPTH = 3;
/** Rodadas em que o erro de validação dos caminhos é devolvido ao agente. */
const CONTEXT_MAX_REPAIRS = 2;

export interface BuildContextOptions {
  workspaceRoot: string;
  componentPath: string;
  testFilePath?: string;
  maxDepth?: number;
  llm: LLMClient;
  maxSteps?: number;
  trace?: TraceWriter;
  meter?: AgentMeter;
}

const importInfoSchema = z.object({
  name: z.string().min(1),
  specifier: z.string().min(1),
  kind: z.enum(['default', 'named', 'namespace', 'side-effect']),
  isExternal: z.boolean(),
});

const finalSchemaBase = z.object({
  componentName: z.string().min(1),
  allowedImports: z.array(importInfoSchema).min(1),
  dependencies: z.array(z.object({ path: z.string().min(1), depth: z.number().int().min(0) })).default([]),
  props: z.string().default(''),
  hooks: z.array(z.string()).default([]),
  contexts: z.array(z.string()).default([]),
  stores: z.array(z.string()).default([]),
  apiCalls: z.array(z.string()).default([]),
  mockTargets: z.array(z.string()).default([]),
});
type ContextAnswer = z.infer<typeof finalSchemaBase>;

/** `<dir do componente>/<Nome>.test.tsx` */
export function defaultTestFilePath(componentPath: string): string {
  const stem = basename(componentPath, extname(componentPath));
  return join(dirname(componentPath), `${stem}.test.tsx`);
}

/** Envolve as ferramentas para registrar todo especificador que elas devolveram (procedência dos caminhos). */
function recordSpecifiers(tools: AgentTool[], seen: Set<string>): AgentTool[] {
  const collect = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(collect);
    else if (v && typeof v === 'object') {
      for (const [k, val] of Object.entries(v)) {
        if (k === 'specifier' && typeof val === 'string') seen.add(val);
        else collect(val);
      }
    }
  };
  return tools.map((t) => ({
    ...t,
    run: async (args: unknown) => {
      const out = await t.run(args);
      collect(out);
      return out;
    },
  }));
}

/**
 * Problema de um especificador do ponto de vista do arquivo de teste, ou undefined se ele é válido.
 * Local: precisa resolver e ter sido devolvido por alguma ferramenta. Externo: package.json ou builtin.
 */
function specifierProblem(ws: Workspace, testFileAbs: string, specifier: string, toolSpecifiers: Set<string>): string | undefined {
  const local = ws.resolveLocal(testFileAbs, specifier);
  if (local) {
    return toolSpecifiers.has(specifier)
      ? undefined
      : `"${specifier}" não foi devolvido por nenhuma ferramenta; use relative_specifier para obter o caminho`;
  }
  if (isRelativeSpecifier(specifier) || specifier.startsWith('/') || ws.isAlias(specifier)) {
    return `"${specifier}" não resolve para nenhum arquivo a partir do arquivo de teste`;
  }
  if (ws.isBuiltin(specifier) || ws.hasDependency(packageName(specifier))) return undefined;
  return `"${specifier}" não é arquivo local nem dependência do package.json`;
}

/** Agente 01 — Contexto: o LLM explora o grafo de dependências; o código re-verifica caminhos e lê fontes do disco. */
export async function buildContext(opts: BuildContextOptions): Promise<ContextResult> {
  const ws = getWorkspace(opts.workspaceRoot);
  const componentAbs = ws.abs(opts.componentPath);
  const componentSource = (() => {
    try {
      return readFileSync(componentAbs, 'utf8');
    } catch {
      throw new WorkspaceError(`Componente não encontrado: ${opts.componentPath}`);
    }
  })();
  const testFileAbs = ws.abs(opts.testFilePath ?? defaultTestFilePath(componentAbs));
  const componentPath = ws.rel(componentAbs);
  const testFilePath = ws.rel(testFileAbs);
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const guessedName = basename(componentAbs, extname(componentAbs));

  const toolSpecifiers = new Set<string>();
  const tools = recordSpecifiers(createCodeTools(ws), toolSpecifiers);

  // Validação semântica dentro do loop: os erros voltam ao agente, que ainda pode chamar ferramentas.
  const finalSchema = finalSchemaBase.superRefine((ans, ctx) => {
    ans.allowedImports.forEach((imp, i) => {
      const problem = specifierProblem(ws, testFileAbs, imp.specifier, toolSpecifiers);
      if (problem) ctx.addIssue({ code: 'custom', path: ['allowedImports', i, 'specifier'], message: problem });
    });
    ans.mockTargets.forEach((spec, i) => {
      const problem = specifierProblem(ws, testFileAbs, spec, toolSpecifiers);
      if (problem) ctx.addIssue({ code: 'custom', path: ['mockTargets', i], message: problem });
    });
    ans.dependencies.forEach((dep, i) => {
      try {
        if (!ws.probe(ws.abs(dep.path))) throw new Error();
      } catch {
        ctx.addIssue({ code: 'custom', path: ['dependencies', i, 'path'], message: `arquivo "${dep.path}" não existe no workspace` });
      }
    });
  });

  const { output } = await runAgent<ContextAnswer>({
    name: CONTEXT_AGENT,
    system: CONTEXT_SYSTEM_PROMPT,
    input: contextUserPrompt({ componentPath, testFilePath, componentName: guessedName, maxDepth }),
    tools,
    llm: opts.llm,
    finalSchema,
    maxRepairs: CONTEXT_MAX_REPAIRS,
    ...(opts.maxSteps !== undefined ? { maxSteps: opts.maxSteps } : {}),
    ...(opts.trace ? { trace: opts.trace } : {}),
    ...(opts.meter ? { meter: opts.meter } : {}),
    temperature: 0,
  });

  return assembleContext(ws, output, { componentPath, componentSource, testFileAbs, testFilePath, maxDepth });
}

/** Monta o ContextResult: números/caminhos/fontes vêm do código; o LLM contribui com a seleção. */
function assembleContext(
  ws: Workspace,
  ans: ContextAnswer,
  base: { componentPath: string; componentSource: string; testFileAbs: string; testFilePath: string; maxDepth: number },
): ContextResult {
  const allowedImports: ImportInfo[] = [];
  const seenImports = new Set<string>();
  for (const imp of ans.allowedImports) {
    const key = `${imp.specifier}\0${imp.name}\0${imp.kind}`;
    if (seenImports.has(key)) continue;
    seenImports.add(key);
    allowedImports.push({ ...imp, isExternal: ws.resolveLocal(base.testFileAbs, imp.specifier) === undefined });
  }

  // Dependências: dedup (ciclos), menor profundidade, sem o componente, respeitando maxDepth; fonte lida do disco.
  const deps = new Map<string, number>();
  for (const d of ans.dependencies) {
    const abs = ws.probe(ws.abs(d.path))!;
    const rel = ws.rel(abs);
    if (rel === base.componentPath || d.depth > base.maxDepth) continue;
    deps.set(rel, Math.min(deps.get(rel) ?? Infinity, Math.max(1, d.depth)));
  }
  const dependencies = [...deps]
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .map(([path, depth]) => ({ path, depth, source: readFileSync(ws.abs(path), 'utf8') }));

  const uniq = (xs: string[]) => [...new Set(xs)];
  return {
    componentPath: base.componentPath,
    componentName: ans.componentName,
    componentSource: base.componentSource,
    testFilePath: base.testFilePath,
    allowedImports,
    dependencies,
    props: ans.props,
    hooks: uniq(ans.hooks),
    contexts: uniq(ans.contexts),
    stores: uniq(ans.stores),
    apiCalls: uniq(ans.apiCalls),
    mockTargets: uniq(ans.mockTargets),
  };
}
