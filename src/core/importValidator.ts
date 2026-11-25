import { ts } from 'ts-morph';
import { getWorkspace, isRelativeSpecifier, packageName } from './tools/workspace';
import type { ContextResult } from './types';

export interface ModuleReference {
  specifier: string;
  line: number; // 1-based
  via: 'import' | 'export' | 'require' | 'jest.mock' | 'dynamic-import';
}

export interface ImportValidation {
  valid: boolean;
  unresolved: { specifier: string; line: number }[];
}

const JEST_MODULE_FNS = new Set(['mock', 'requireActual', 'requireMock', 'doMock', 'unmock', 'dontMock', 'createMockFromModule']);

/**
 * Todas as referências a módulos no código: import/export ... from, require('x'),
 * import('x') e o primeiro argumento de jest.mock / jest.requireActual (e afins).
 */
export function extractModuleReferences(code: string, fileName = 'test.tsx'): ModuleReference[] {
  const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const refs: ModuleReference[] = [];
  const add = (lit: ts.Node | undefined, via: ModuleReference['via']) => {
    if (lit && (ts.isStringLiteral(lit) || ts.isNoSubstitutionTemplateLiteral(lit))) {
      refs.push({ specifier: lit.text, line: sf.getLineAndCharacterOfPosition(lit.getStart(sf)).line + 1, via });
    }
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) add(node.moduleSpecifier, 'import');
    else if (ts.isExportDeclaration(node)) add(node.moduleSpecifier, 'export');
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      add(node.moduleReference.expression, 'require');
    } else if (ts.isCallExpression(node)) {
      const e = node.expression;
      if (e.kind === ts.SyntaxKind.ImportKeyword) add(node.arguments[0], 'dynamic-import');
      else if (ts.isIdentifier(e) && e.text === 'require') add(node.arguments[0], 'require');
      else if (
        ts.isPropertyAccessExpression(e) &&
        ts.isIdentifier(e.expression) &&
        e.expression.text === 'jest' &&
        JEST_MODULE_FNS.has(e.name.text)
      ) {
        add(node.arguments[0], 'jest.mock');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return refs;
}

/**
 * Guardrail determinístico: cada módulo referenciado no teste precisa existir.
 * Válido se: (1) relativo/alias que resolve para arquivo existente a partir do diretório do teste;
 * (2) dependência do package.json (inclusive subcaminhos); (3) builtin do Node; ou (4) consta em allowedImports.
 */
export function validateImports(testCode: string, ctx: ContextResult, workspaceRoot: string): ImportValidation {
  const ws = getWorkspace(workspaceRoot);
  const testFile = ws.abs(ctx.testFilePath);
  const allowed = new Set(ctx.allowedImports.map((i) => i.specifier));
  const unresolved: ImportValidation['unresolved'] = [];

  for (const ref of extractModuleReferences(testCode, testFile)) {
    const s = ref.specifier;
    const ok =
      allowed.has(s) ||
      ws.resolveLocal(testFile, s) !== undefined ||
      (!isRelativeSpecifier(s) && !s.startsWith('/') && (ws.isBuiltin(s) || ws.hasDependency(packageName(s))));
    if (!ok) unresolved.push({ specifier: s, line: ref.line });
  }
  return { valid: unresolved.length === 0, unresolved };
}
