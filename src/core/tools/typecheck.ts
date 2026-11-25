import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Project, ts } from 'ts-morph';
import { z } from 'zod';
import type { AgentTool } from '../agent/runtime';
import { getWorkspace } from './workspace';

export const TYPECHECK_MAX_DIAGNOSTICS = 10;

export interface TypeDiagnostic {
  /** arquivo:linha (relativo ao workspace) */
  location: string;
  /** ex.: TS2741 */
  code: string;
  message: string;
}
export interface TypecheckResult {
  ok: boolean;
  errors: number; // total de erros (a lista traz no máximo 10)
  diagnostics: TypeDiagnostic[];
}
/** Checa os tipos de um código candidato como se ele estivesse em `testFilePath`. */
export type TypecheckFn = (code: string) => Promise<TypecheckResult> | TypecheckResult;

/** tsconfig usado pelo ts-jest, quando existir (ex.: tsconfig.jest.json); senão o tsconfig.json. */
export function pickTsconfig(workspaceRoot: string): string | undefined {
  return ['tsconfig.jest.json', 'tsconfig.test.json', 'tsconfig.spec.json', 'tsconfig.json']
    .map((f) => join(workspaceRoot, f))
    .find((f) => existsSync(f));
}

/**
 * Typechecker em memória (ts-morph) com o tsconfig do workspace. O código candidato vira um SourceFile
 * em `testFilePath` só no projeto em memória: nada é gravado em disco.
 */
export function createTypechecker(workspaceRoot: string, testFilePath: string): TypecheckFn {
  const ws = getWorkspace(workspaceRoot);
  const testAbs = ws.abs(testFilePath);
  let project: Project | undefined;
  const getProject = () => {
    if (project) return project;
    const tsConfigFilePath = pickTsconfig(ws.root);
    project = tsConfigFilePath
      ? new Project({ tsConfigFilePath, compilerOptions: { noEmit: true } })
      : new Project({ compilerOptions: { jsx: ts.JsxEmit.ReactJSX, strict: true, esModuleInterop: true, noEmit: true } });
    return project;
  };
  return (code: string): TypecheckResult => {
    const p = getProject();
    const sf = p.createSourceFile(testAbs, code, { overwrite: true }); // apenas em memória (nunca chamamos save)
    const all = sf
      .getPreEmitDiagnostics()
      .filter((d) => d.getCategory() === ts.DiagnosticCategory.Error)
      // Só o arquivo de teste: diagnósticos globais (ex.: TS5101 "baseUrl is deprecated" do TS recente) não são do teste.
      .filter((d) => d.getSourceFile()?.getFilePath() === sf.getFilePath());
    const diagnostics = all.slice(0, TYPECHECK_MAX_DIAGNOSTICS).map((d): TypeDiagnostic => {
      const f = d.getSourceFile();
      const location = f ? `${ws.rel(f.getFilePath())}:${d.getLineNumber() ?? '?'}` : '(global)';
      return { location, code: `TS${d.getCode()}`, message: ts.flattenDiagnosticMessageText(d.compilerObject.messageText, '\n') };
    });
    return { ok: all.length === 0, errors: all.length, diagnostics };
  };
}

export function typecheckTestTool(check: TypecheckFn): AgentTool<{ code: string }> {
  return {
    spec: {
      name: 'typecheck_test',
      description:
        'Checa os tipos TypeScript do código COMPLETO do teste (em memória, com o tsconfig do workspace, no caminho do arquivo de teste). ' +
        `Devolve { ok, errors, diagnostics: [{ location, code, message }] } com no máximo ${TYPECHECK_MAX_DIAGNOSTICS} diagnósticos. Não grava nada.`,
      parameters: {
        type: 'object',
        properties: { code: { type: 'string', description: 'conteúdo completo do arquivo de teste' } },
        required: ['code'],
      },
    },
    argsSchema: z.object({ code: z.string().min(1) }),
    run: async ({ code }) => check(code),
  };
}
