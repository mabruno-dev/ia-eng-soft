import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { Project, ts, type SourceFile } from 'ts-morph';

export const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.json'];
const INDEX_FILES = ['index.ts', 'index.tsx', 'index.js', 'index.jsx'];

export class WorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceError';
  }
}

const toPosix = (p: string) => p.split(sep).join('/');

/** Letra do drive em maiúscula (Windows): "c:\x" → "C:\x". */
export const upperDriveLetter = (p: string) => p.replace(/^([a-z]):/, (_m, d: string) => `${d.toUpperCase()}:`);

/**
 * Forma real do caminho no disco (fs.realpathSync.native: caixa real e letra do drive em maiúscula).
 * Dentro do VS Code o caminho chega como "c:\..."; o Jest no Windows não acha os testes com
 * --runTestsByPath quando rootDir/cwd e o arquivo divergem na caixa do drive ("No tests found").
 */
export function canonicalPath(p: string, realpath: (p: string) => string = realpathSync.native): string {
  const abs = resolve(p);
  try {
    return upperDriveLetter(realpath(abs));
  } catch {
    return upperDriveLetter(abs); // ainda não existe: ao menos o drive normalizado
  }
}
const isFile = (p: string) => {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
};

/** Nome do pacote de um especificador externo: '@scope/pkg/sub' → '@scope/pkg'; 'pkg/sub' → 'pkg'. */
export function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!;
}

export const isRelativeSpecifier = (s: string) => s === '.' || s === '..' || s.startsWith('./') || s.startsWith('../');

interface PathMapping {
  prefix: string;
  suffix: string;
  hasWildcard: boolean;
  targets: string[]; // absolutos, podendo conter '*'
}

/**
 * Raiz do workspace-alvo: confinamento de caminhos, resolução de imports
 * (relativos, `paths`/`baseUrl` do tsconfig) e dependências do package.json.
 */
export class Workspace {
  readonly root: string;
  private readonly mappings: PathMapping[] = [];
  private readonly baseUrl: string | undefined;
  private readonly deps: Set<string>;
  private projectInstance: Project | undefined;
  private readonly compilerOptions: ts.CompilerOptions;

  constructor(root: string) {
    this.root = canonicalPath(root);
    if (!existsSync(this.root)) throw new WorkspaceError(`Workspace não encontrado: ${this.root}`);

    this.compilerOptions = { jsx: ts.JsxEmit.ReactJSX, allowJs: true };
    const tsconfig = join(this.root, 'tsconfig.json');
    if (existsSync(tsconfig)) {
      const read = ts.readConfigFile(tsconfig, ts.sys.readFile);
      if (!read.error) {
        const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, this.root);
        this.compilerOptions = { ...parsed.options, noEmit: true };
        this.baseUrl = parsed.options.baseUrl;
        const base = parsed.options.baseUrl ?? (parsed.options as { pathsBasePath?: string }).pathsBasePath ?? this.root;
        for (const [pattern, targets] of Object.entries(parsed.options.paths ?? {})) {
          const star = pattern.indexOf('*');
          this.mappings.push({
            prefix: star >= 0 ? pattern.slice(0, star) : pattern,
            suffix: star >= 0 ? pattern.slice(star + 1) : '',
            hasWildcard: star >= 0,
            targets: targets.map((t) => resolve(base, t)),
          });
        }
        // Padrões mais específicos (prefixo maior) primeiro, como o tsc.
        this.mappings.sort((a, b) => b.prefix.length - a.prefix.length);
      }
    }

    this.deps = new Set();
    const pkgPath = join(this.root, 'package.json');
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, Record<string, string> | undefined>;
      for (const field of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
        for (const name of Object.keys(pkg[field] ?? {})) this.deps.add(name);
      }
    }
  }

  /** Caminho absoluto confinado ao workspace (aceita relativo à raiz ou absoluto). */
  abs(p: string): string {
    const full = isAbsolute(p) ? resolve(p) : resolve(this.root, p);
    const rel = relative(this.root, full);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new WorkspaceError(`Caminho fora do workspace não é permitido: ${p}`);
    }
    // Sempre com o prefixo canônico da raiz (um absoluto "c:\..." vira "C:\...").
    return rel ? join(this.root, rel) : this.root;
  }

  /** Caminho relativo à raiz, com '/'. */
  rel(absPath: string): string {
    return toPosix(relative(this.root, absPath));
  }

  /** Testa o caminho exato, extensões e index.* — devolve o arquivo absoluto existente ou undefined. */
  probe(base: string): string | undefined {
    if (isFile(base)) return base;
    for (const ext of RESOLVE_EXTENSIONS) if (isFile(base + ext)) return base + ext;
    // './x.js' escrito em código TS apontando para x.ts / x.tsx
    const js = /\.(c|m)?jsx?$/.exec(base);
    if (js) {
      const stem = base.slice(0, -js[0].length);
      for (const ext of ['.ts', '.tsx']) if (isFile(stem + ext)) return stem + ext;
    }
    for (const idx of INDEX_FILES) if (isFile(join(base, idx))) return join(base, idx);
    return undefined;
  }

  /** Bases candidatas para um especificador não relativo via `paths`/`baseUrl`. */
  private aliasCandidates(specifier: string): string[] {
    const out: string[] = [];
    for (const m of this.mappings) {
      if (m.hasWildcard) {
        if (specifier.startsWith(m.prefix) && specifier.endsWith(m.suffix) && specifier.length >= m.prefix.length + m.suffix.length) {
          const captured = specifier.slice(m.prefix.length, specifier.length - m.suffix.length);
          out.push(...m.targets.map((t) => t.replace('*', captured)));
        }
      } else if (specifier === m.prefix) {
        out.push(...m.targets);
      }
    }
    if (this.baseUrl) out.push(resolve(this.baseUrl, specifier));
    return out;
  }

  /** true se o especificador casa com algum padrão de `paths` (mesmo que não resolva). */
  isAlias(specifier: string): boolean {
    return this.mappings.some((m) =>
      m.hasWildcard ? specifier.startsWith(m.prefix) && specifier.endsWith(m.suffix) : specifier === m.prefix,
    );
  }

  /**
   * Resolve um especificador local (relativo ou alias) a partir de `fromFile` (absoluto).
   * Devolve o caminho absoluto existente dentro do workspace, ou undefined.
   */
  resolveLocal(fromFile: string, specifier: string): string | undefined {
    const bases = isRelativeSpecifier(specifier) ? [resolve(dirname(fromFile), specifier)] : this.aliasCandidates(specifier);
    for (const b of bases) {
      const hit = this.probe(b);
      if (hit) {
        try {
          return this.abs(hit);
        } catch {
          return undefined;
        }
      }
    }
    return undefined;
  }

  hasDependency(pkg: string): boolean {
    return this.deps.has(pkg);
  }

  isBuiltin(specifier: string): boolean {
    return isBuiltin(specifier);
  }

  /** Projeto ts-morph com as opções do tsconfig do workspace (sem carregar todos os arquivos). */
  get project(): Project {
    this.projectInstance ??= new Project({ compilerOptions: this.compilerOptions, skipAddingFilesFromTsConfig: true });
    return this.projectInstance;
  }

  /** Parseia o arquivo a partir do disco (sempre o conteúdo atual). */
  sourceFile(absPath: string): SourceFile {
    return this.project.createSourceFile(absPath, readFileSync(absPath, 'utf8'), { overwrite: true });
  }

  /** Parseia um código arbitrário como se estivesse em `absPath` (não grava em disco). */
  sourceFromText(absPath: string, text: string): SourceFile {
    return this.project.createSourceFile(absPath, text, { overwrite: true });
  }
}

const cache = new Map<string, Workspace>();
/** Workspace em cache por raiz (o tsconfig/package.json são lidos uma vez). */
export function getWorkspace(root: string): Workspace {
  const key = canonicalPath(root);
  let ws = cache.get(key);
  if (!ws) cache.set(key, (ws = new Workspace(key)));
  return ws;
}
