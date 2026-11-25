import { readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative, sep } from 'node:path';
import { Node, SyntaxKind, type SourceFile } from 'ts-morph';
import { z } from 'zod';
import type { AgentTool } from '../agent/runtime';
import { isRelativeSpecifier, packageName, type Workspace, WorkspaceError } from './workspace';

export const READ_FILE_MAX = 8000;
const SEARCH_MAX_RESULTS = 20;
const SEARCH_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.json']);
const SEARCH_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.reactest', '.stryker-tmp', 'reports']);

// ---------------------------------------------------------------------------
// Funções puras (usadas pelas ferramentas e por outros módulos)
// ---------------------------------------------------------------------------

export interface ImportEntry {
  specifier: string;
  kind: 'default' | 'named' | 'namespace' | 'side-effect';
  symbols: string[];
  defaultImport?: string;
  namedImports: string[];
  namespaceImport?: string;
  typeOnly: boolean;
  line: number;
  resolvedPath?: string; // arquivo local (relativo à raiz do workspace)
  package?: string; // pacote externo
  unresolved?: true; // parece local (relativo/alias) mas não resolveu
}

/** Imports estáticos (import ... from / export ... from) de um arquivo. */
export function listImports(ws: Workspace, absFile: string): ImportEntry[] {
  const sf = ws.sourceFile(absFile);
  const out: ImportEntry[] = [];
  const locate = (specifier: string): Pick<ImportEntry, 'resolvedPath' | 'package' | 'unresolved'> => {
    const local = ws.resolveLocal(absFile, specifier);
    if (local) return { resolvedPath: ws.rel(local) };
    if (isRelativeSpecifier(specifier) || ws.isAlias(specifier)) return { unresolved: true };
    return { package: ws.isBuiltin(specifier) ? specifier : packageName(specifier) };
  };

  for (const d of sf.getImportDeclarations()) {
    const specifier = d.getModuleSpecifierValue();
    const def = d.getDefaultImport()?.getText();
    const ns = d.getNamespaceImport()?.getText();
    const named = d.getNamedImports().map((n) => n.getAliasNode()?.getText() ?? n.getName());
    const kind: ImportEntry['kind'] = ns ? 'namespace' : def ? 'default' : named.length ? 'named' : 'side-effect';
    out.push({
      specifier,
      kind,
      symbols: [...(def ? [def] : []), ...(ns ? [ns] : []), ...named],
      ...(def ? { defaultImport: def } : {}),
      namedImports: named,
      ...(ns ? { namespaceImport: ns } : {}),
      typeOnly: d.isTypeOnly(),
      line: d.getStartLineNumber(),
      ...locate(specifier),
    });
  }
  for (const d of sf.getExportDeclarations()) {
    const specifier = d.getModuleSpecifierValue();
    if (!specifier) continue;
    const named = d.getNamedExports().map((n) => n.getName());
    out.push({
      specifier,
      kind: named.length ? 'named' : 'namespace',
      symbols: named,
      namedImports: named,
      typeOnly: d.isTypeOnly(),
      line: d.getStartLineNumber(),
      ...locate(specifier),
    });
  }
  return out;
}

/** Especificador relativo de `fromTestFile` para `targetFile` (absolutos): '/', prefixo './' ou '../', sem extensão TS/JS. */
export function relativeSpecifier(fromTestFile: string, targetFile: string): string {
  let rel = relative(dirname(fromTestFile), targetFile).split(sep).join('/');
  rel = rel.replace(/\.(d\.ts|tsx?|jsx?|mjs|cjs)$/, '');
  if (!rel.startsWith('.')) rel = `./${rel}`;
  return rel;
}

/** Converte um glob simples (**, *, ?) em regex sobre caminhos relativos com '/'. */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = glob.indexOf('}', i);
      if (end > i) {
        re += `(?:${glob.slice(i + 1, end).split(',').map((s) => s.replace(/[.+^$()|[\]\\]/g, '\\$&')).join('|')})`;
        i = end;
      } else re += '\\{';
    } else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

function* walk(ws: Workspace, dir: string): Generator<string> {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      if (!SEARCH_SKIP_DIRS.has(ent.name)) yield* walk(ws, join(dir, ent.name));
    } else if (ent.isFile() && SEARCH_EXTENSIONS.has(extname(ent.name))) {
      yield join(dir, ent.name);
    }
  }
}

export interface SearchHit {
  file: string;
  line: number;
  text: string;
}

export function searchCode(ws: Workspace, pattern: string, glob?: string): { matches: SearchHit[]; truncated: boolean } {
  let re: RegExp;
  try {
    re = new RegExp(pattern);
  } catch (err) {
    throw new Error(`regex inválida: ${err instanceof Error ? err.message : String(err)}`);
  }
  const globRe = glob ? globToRegExp(glob) : undefined;
  const matches: SearchHit[] = [];
  for (const file of walk(ws, ws.root)) {
    const rel = ws.rel(file);
    if (globRe && !globRe.test(rel) && !globRe.test(basename(rel))) continue;
    const lines = readFileSync(file, 'utf8').split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (re.test(lines[i]!)) {
        if (matches.length >= SEARCH_MAX_RESULTS) return { matches, truncated: true };
        matches.push({ file: rel, line: i + 1, text: lines[i]!.trim().slice(0, 200) });
      }
    }
  }
  return { matches, truncated: false };
}

export interface ComponentAnalysis {
  file: string;
  componentName: string;
  exportKind: 'named' | 'default' | 'both' | 'none';
  props: string;
  hooks: string[];
  contexts: string[];
  stores: string[];
  apiCalls: string[];
}

const STORE_PACKAGES = new Set(['zustand', 'redux', 'react-redux', '@reduxjs/toolkit', 'jotai', 'recoil', 'mobx', 'valtio']);
const REDUX_HOOKS = new Set(['useSelector', 'useDispatch', 'useStore', 'useAppSelector', 'useAppDispatch']);
const HTTP_PACKAGES = new Set(['axios', 'ky', 'ofetch', 'superagent']);

/** Classificação de um módulo local importado: define contexto, store ou API? */
function classifyModule(ws: Workspace, absPath: string): { context: boolean; store: boolean; api: boolean } {
  const relPath = `/${ws.rel(absPath)}`;
  let text = '';
  try {
    text = readFileSync(absPath, 'utf8');
  } catch {
    // ignore
  }
  const importsFrom = (pkgs: Set<string>) =>
    [...text.matchAll(/from\s+['"]([^'"]+)['"]/g)].some((m) => pkgs.has(packageName(m[1]!)));
  return {
    context: /\bcreateContext\s*[<(]/.test(text),
    store: importsFrom(STORE_PACKAGES),
    api: /\/(services|api)\//i.test(relPath) || /\bfetch\s*\(/.test(text) || importsFrom(HTTP_PACKAGES),
  };
}

function findComponent(sf: SourceFile): { name: string; exportKind: ComponentAnalysis['exportKind']; node?: Node } {
  const fileStem = basename(sf.getFilePath()).replace(/\.[^.]+$/, '');
  const candidates: { name: string; node: Node; isDefault: boolean; named: boolean }[] = [];
  for (const fn of sf.getFunctions()) {
    const name = fn.getName();
    if (name && /^[A-Z]/.test(name)) candidates.push({ name, node: fn, isDefault: fn.isDefaultExport(), named: fn.hasExportKeyword() && !fn.hasDefaultKeyword() });
  }
  for (const v of sf.getVariableDeclarations()) {
    const init = v.getInitializer();
    const name = v.getName();
    if (!/^[A-Z]/.test(name) || !init) continue;
    const fn = Node.isArrowFunction(init) || Node.isFunctionExpression(init) ? init : init.getFirstDescendant((d) => Node.isArrowFunction(d) || Node.isFunctionExpression(d));
    if (fn) candidates.push({ name, node: fn, isDefault: v.isDefaultExport(), named: v.getVariableStatement()?.hasExportKeyword() === true });
  }
  const pick =
    candidates.find((c) => c.name === fileStem) ?? candidates.find((c) => c.isDefault) ?? candidates.find((c) => c.named) ?? candidates[0];
  if (!pick) return { name: fileStem, exportKind: 'none' };
  const exportKind = pick.named && pick.isDefault ? 'both' : pick.named ? 'named' : pick.isDefault ? 'default' : 'none';
  return { name: pick.name, exportKind, node: pick.node };
}

function propsText(sf: SourceFile, fnNode: Node | undefined): string {
  if (!fnNode || !(Node.isFunctionDeclaration(fnNode) || Node.isArrowFunction(fnNode) || Node.isFunctionExpression(fnNode))) return '';
  const param = fnNode.getParameters()[0];
  if (!param) return '';
  const typeNode = param.getTypeNode();
  if (!typeNode) return `(sem anotação) ${param.getType().getText(param)}`;
  const text = typeNode.getText();
  const decl = sf.getInterface(text) ?? sf.getTypeAlias(text);
  return decl ? decl.getText() : text;
}

/** Análise estática do componente com ts-morph. */
export function analyzeComponent(ws: Workspace, absFile: string): ComponentAnalysis {
  const sf = ws.sourceFile(absFile);
  const { name, exportKind, node } = findComponent(sf);

  // símbolo importado -> módulo
  const importOf = new Map<string, { specifier: string; abs?: string }>();
  for (const d of sf.getImportDeclarations()) {
    const specifier = d.getModuleSpecifierValue();
    const abs = ws.resolveLocal(absFile, specifier);
    const syms = [d.getDefaultImport()?.getText(), d.getNamespaceImport()?.getText(), ...d.getNamedImports().map((n) => n.getAliasNode()?.getText() ?? n.getName())];
    for (const s of syms) if (s) importOf.set(s, { specifier, ...(abs ? { abs } : {}) });
  }

  const hooks = new Set<string>();
  const contexts = new Set<string>();
  const stores = new Set<string>();
  const apiCalls = new Set<string>();
  const moduleKind = new Map<string, ReturnType<typeof classifyModule>>();
  const kindOf = (abs: string) => {
    let k = moduleKind.get(abs);
    if (!k) moduleKind.set(abs, (k = classifyModule(ws, abs)));
    return k;
  };

  for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
    const expr = call.getExpression();
    let callee: string | undefined;
    let root: string | undefined;
    if (Node.isIdentifier(expr)) callee = root = expr.getText();
    else if (Node.isPropertyAccessExpression(expr)) {
      callee = expr.getName();
      root = expr.getExpression().getText();
    }
    if (!callee) continue;
    const label = (sym: string) => {
      const imp = importOf.get(sym);
      return imp ? `${sym} (${imp.specifier})` : sym;
    };

    if (/^use[A-Z0-9]/.test(callee)) hooks.add(callee);

    if (callee === 'createContext') {
      const v = call.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
      contexts.add(v ? v.getName() : 'createContext');
    }
    if (callee === 'useContext') {
      const arg = call.getArguments()[0]?.getText();
      if (arg) contexts.add(label(arg));
    }
    if (REDUX_HOOKS.has(callee)) stores.add(label(callee));
    if (callee === 'create' && importOf.get('create')?.specifier.startsWith('zustand')) stores.add('create (zustand)');
    if (callee === 'fetch' && root === 'fetch') apiCalls.add('fetch');

    const rootImport = root ? importOf.get(root) : undefined;
    if (rootImport && !rootImport.abs && HTTP_PACKAGES.has(packageName(rootImport.specifier))) {
      apiCalls.add(Node.isPropertyAccessExpression(expr) ? `${root}.${callee} (${rootImport.specifier})` : `${root} (${rootImport.specifier})`);
    }
    if (rootImport?.abs && root) {
      const k = kindOf(rootImport.abs);
      if (k.context && /^use[A-Z]/.test(root)) contexts.add(label(root));
      if (k.store && /^use[A-Z]/.test(root)) stores.add(label(root));
      if (k.api && !k.context && !k.store) apiCalls.add(label(root));
    }
  }

  return {
    file: ws.rel(absFile),
    componentName: name,
    exportKind,
    props: propsText(sf, node),
    hooks: [...hooks],
    contexts: [...contexts],
    stores: [...stores],
    apiCalls: [...apiCalls],
  };
}

// ---------------------------------------------------------------------------
// Ferramentas (AgentTool) — determinísticas e confinadas ao workspace
// ---------------------------------------------------------------------------

const objectSchema = (properties: Record<string, unknown>, required: string[]) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const str = (description: string) => ({ type: 'string', description });

/** Arquivo existente no workspace (tenta extensões/index se o caminho vier sem extensão). */
function existingFile(ws: Workspace, p: string): string {
  const abs = ws.abs(p);
  const hit = ws.probe(abs);
  if (!hit) throw new WorkspaceError(`Arquivo não encontrado no workspace: ${p}`);
  return ws.abs(hit);
}

export function readFileTool(ws: Workspace): AgentTool<{ path: string }> {
  return {
    spec: {
      name: 'read_file',
      description: `Lê um arquivo do workspace (caminho relativo à raiz). Conteúdo truncado em ${READ_FILE_MAX} caracteres.`,
      parameters: objectSchema({ path: str('Caminho do arquivo, relativo à raiz do workspace') }, ['path']),
    },
    argsSchema: z.object({ path: z.string().min(1) }),
    run: async ({ path }) => {
      const abs = existingFile(ws, path);
      const content = readFileSync(abs, 'utf8');
      const truncated = content.length > READ_FILE_MAX;
      return { path: ws.rel(abs), content: truncated ? content.slice(0, READ_FILE_MAX) : content, truncated, totalChars: content.length };
    },
  };
}

export function listImportsTool(ws: Workspace): AgentTool<{ file: string }> {
  return {
    spec: {
      name: 'list_imports',
      description:
        'Lista os imports de um arquivo: especificador original, símbolos, kind, e resolvedPath (arquivo local, relativo à raiz) ou package (externo).',
      parameters: objectSchema({ file: str('Arquivo, relativo à raiz do workspace') }, ['file']),
    },
    argsSchema: z.object({ file: z.string().min(1) }),
    run: async ({ file }) => {
      const abs = existingFile(ws, file);
      return { file: ws.rel(abs), imports: listImports(ws, abs) };
    },
  };
}

export function resolveImportTool(ws: Workspace): AgentTool<{ fromFile: string; specifier: string }> {
  return {
    spec: {
      name: 'resolve_import',
      description:
        'Resolve um especificador (relativo ou alias do tsconfig, como "@/x") a partir de fromFile para um arquivo existente. Para pacotes externos, informa se estão no package.json.',
      parameters: objectSchema(
        { fromFile: str('Arquivo que contém o import (relativo à raiz)'), specifier: str('Especificador, ex.: "../services/api" ou "@/state/store"') },
        ['fromFile', 'specifier'],
      ),
    },
    argsSchema: z.object({ fromFile: z.string().min(1), specifier: z.string().min(1) }),
    run: async ({ fromFile, specifier }) => {
      const from = ws.abs(fromFile);
      const local = ws.resolveLocal(from, specifier);
      if (local) return { specifier, resolvedPath: ws.rel(local), isExternal: false };
      if (isRelativeSpecifier(specifier) || ws.isAlias(specifier)) {
        throw new Error(`não foi possível resolver "${specifier}" a partir de ${ws.rel(from)} (testado .ts/.tsx/.js/.jsx/.json e /index.*)`);
      }
      if (ws.isBuiltin(specifier)) return { specifier, isExternal: true, builtin: true };
      const pkg = packageName(specifier);
      if (!ws.hasDependency(pkg)) throw new Error(`"${specifier}" não é arquivo local nem dependência do package.json (pacote "${pkg}")`);
      return { specifier, isExternal: true, package: pkg };
    },
  };
}

export function relativeSpecifierTool(ws: Workspace): AgentTool<{ fromTestFile: string; targetFile: string }> {
  return {
    spec: {
      name: 'relative_specifier',
      description:
        'Calcula o especificador relativo (pronto para o import no teste) de fromTestFile até targetFile. targetFile deve existir.',
      parameters: objectSchema(
        { fromTestFile: str('Arquivo de teste (relativo à raiz; pode ainda não existir)'), targetFile: str('Arquivo alvo existente (relativo à raiz)') },
        ['fromTestFile', 'targetFile'],
      ),
    },
    argsSchema: z.object({ fromTestFile: z.string().min(1), targetFile: z.string().min(1) }),
    run: async ({ fromTestFile, targetFile }) => {
      const from = ws.abs(fromTestFile);
      const target = existingFile(ws, targetFile);
      return { specifier: relativeSpecifier(from, target), targetFile: ws.rel(target) };
    },
  };
}

export function searchCodeTool(ws: Workspace): AgentTool<{ pattern: string; glob?: string | undefined }> {
  return {
    spec: {
      name: 'search_code',
      description: `Busca por regex (JavaScript) nos arquivos de código do workspace (ignora node_modules). Até ${SEARCH_MAX_RESULTS} ocorrências arquivo:linha:trecho.`,
      parameters: objectSchema(
        { pattern: str('Expressão regular'), glob: str('Filtro opcional de arquivos, ex.: "src/**/*.tsx"') },
        ['pattern'],
      ),
    },
    argsSchema: z.object({ pattern: z.string().min(1), glob: z.string().optional() }),
    run: async ({ pattern, glob }) => searchCode(ws, pattern, glob),
  };
}

export function analyzeComponentTool(ws: Workspace): AgentTool<{ file: string }> {
  return {
    spec: {
      name: 'analyze_component',
      description:
        'Análise estática (ts-morph) de um componente React: tipo das props, hooks chamados, contexts, stores (zustand/redux) e chamadas de API (fetch, axios, funções de /services ou /api).',
      parameters: objectSchema({ file: str('Arquivo do componente (relativo à raiz)') }, ['file']),
    },
    argsSchema: z.object({ file: z.string().min(1) }),
    run: async ({ file }) => analyzeComponent(ws, existingFile(ws, file)),
  };
}

/** As 6 ferramentas do agente de Contexto. */
export function createCodeTools(ws: Workspace): AgentTool[] {
  return [readFileTool(ws), listImportsTool(ws), resolveImportTool(ws), relativeSpecifierTool(ws), searchCodeTool(ws), analyzeComponentTool(ws)];
}
