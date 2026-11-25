import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  analyzeComponentTool,
  globToRegExp,
  listImportsTool,
  readFileTool,
  READ_FILE_MAX,
  relativeSpecifierTool,
  resolveImportTool,
  searchCodeTool,
  type ComponentAnalysis,
  type ImportEntry,
} from './code';
import { Workspace } from './workspace';

const FIXTURE = fileURLToPath(new URL('../../../fixtures/sample-app', import.meta.url));
const ws = new Workspace(FIXTURE);

describe('confinamento ao workspace', () => {
  it('rejeita caminhos fora do workspace em todas as ferramentas de arquivo', async () => {
    await expect(readFileTool(ws).run({ path: '../../package.json' })).rejects.toThrow(/fora do workspace/);
    await expect(readFileTool(ws).run({ path: join(FIXTURE, '..', '..', 'CLAUDE.md') })).rejects.toThrow(/fora do workspace/);
    await expect(listImportsTool(ws).run({ file: '../../src/cli.ts' })).rejects.toThrow(/fora do workspace/);
    await expect(analyzeComponentTool(ws).run({ file: '../../src/cli.ts' })).rejects.toThrow(/fora do workspace/);
    await expect(
      relativeSpecifierTool(ws).run({ fromTestFile: 'src/components/X.test.tsx', targetFile: '../../src/cli.ts' }),
    ).rejects.toThrow(/fora do workspace/);
    await expect(resolveImportTool(ws).run({ fromFile: 'src/components/Button.tsx', specifier: '../../../../src/cli' })).rejects.toThrow(
      /não foi possível resolver/,
    );
  });
});

describe('read_file', () => {
  it('lê o arquivo e informa se truncou', async () => {
    const r = (await readFileTool(ws).run({ path: 'src/components/Button.tsx' })) as { content: string; truncated: boolean };
    expect(r.truncated).toBe(false);
    expect(r.content).toContain('export function Button');
    const lock = (await readFileTool(ws).run({ path: 'package-lock.json' })) as { content: string; truncated: boolean; totalChars: number };
    expect(lock.truncated).toBe(true);
    expect(lock.content).toHaveLength(READ_FILE_MAX);
    expect(lock.totalChars).toBeGreaterThan(READ_FILE_MAX);
  });

  it('erro claro para arquivo inexistente', async () => {
    await expect(readFileTool(ws).run({ path: 'src/nao-existe.ts' })).rejects.toThrow(/não encontrado/);
  });
});

describe('list_imports', () => {
  it('resolve alias @/ e imports relativos; identifica pacotes externos', async () => {
    const r = (await listImportsTool(ws).run({ file: 'src/components/LoginForm.tsx' })) as { imports: ImportEntry[] };
    const by = Object.fromEntries(r.imports.map((i) => [i.specifier, i]));
    expect(by.react).toMatchObject({ package: 'react', kind: 'named' });
    expect(by['@/services/authApi']).toMatchObject({ resolvedPath: 'src/services/authApi.ts', symbols: ['login', 'LoginResponse'] });
    expect(by['../utils/validation']).toMatchObject({ resolvedPath: 'src/utils/validation.ts' });
    expect(by['./Button']).toMatchObject({ resolvedPath: 'src/components/Button.tsx', namedImports: ['Button'] });
  });

  it('marca import type e encontra a linha', async () => {
    const r = (await listImportsTool(ws).run({ file: 'src/services/userApi.ts' })) as { imports: ImportEntry[] };
    expect(r.imports[0]).toMatchObject({ specifier: '@/types/user', typeOnly: true, line: 1, resolvedPath: 'src/types/user.ts' });
  });
});

describe('resolve_import', () => {
  const run = (fromFile: string, specifier: string) => resolveImportTool(ws).run({ fromFile, specifier });

  it('resolve alias, relativo, extensões e pacote do package.json', async () => {
    await expect(run('src/components/CartSummary.tsx', '@/state/CartContext')).resolves.toMatchObject({
      resolvedPath: 'src/state/CartContext.tsx',
      isExternal: false,
    });
    await expect(run('src/components/CartSummary.tsx', '../types/cart')).resolves.toMatchObject({ resolvedPath: 'src/types/cart.ts' });
    await expect(run('src/components/X.test.tsx', '@testing-library/jest-dom/vitest')).resolves.toMatchObject({
      isExternal: true,
      package: '@testing-library/jest-dom',
    });
    await expect(run('src/components/X.test.tsx', 'node:path')).resolves.toMatchObject({ builtin: true });
  });

  it('erro claro quando não resolve', async () => {
    await expect(run('src/components/CartSummary.tsx', '@/state/naoExiste')).rejects.toThrow(/não foi possível resolver "@\/state\/naoExiste"/);
    await expect(run('src/components/CartSummary.tsx', 'left-pad')).rejects.toThrow(/não é arquivo local nem dependência/);
  });
});

describe('relative_specifier', () => {
  const run = (fromTestFile: string, targetFile: string) =>
    relativeSpecifierTool(ws).run({ fromTestFile, targetFile }) as Promise<{ specifier: string }>;

  it('gera ./ ou ../ com /, sem extensão', async () => {
    expect((await run('src/components/CartSummary.test.tsx', 'src/components/CartSummary.tsx')).specifier).toBe('./CartSummary');
    expect((await run('src/components/CartSummary.test.tsx', 'src/state/CartContext.tsx')).specifier).toBe('../state/CartContext');
    expect((await run('src/__tests__/deep/A.test.tsx', 'src/services/authApi')).specifier).toBe('../../services/authApi');
  });

  it('exige que o alvo exista', async () => {
    await expect(run('src/components/A.test.tsx', 'src/components/Inexistente.tsx')).rejects.toThrow(/não encontrado/);
  });
});

describe('search_code', () => {
  it('encontra ocorrências por regex com filtro glob', async () => {
    const r = (await searchCodeTool(ws).run({ pattern: 'createContext', glob: 'src/**/*.tsx' })) as {
      matches: { file: string; line: number; text: string }[];
    };
    expect(r.matches.length).toBeGreaterThan(0);
    expect(r.matches.every((m) => m.file.endsWith('.tsx'))).toBe(true);
    expect(r.matches[0]).toMatchObject({ file: 'src/state/CartContext.tsx' });
  });

  it('limita a 20 ocorrências e rejeita regex inválida', async () => {
    const r = (await searchCodeTool(ws).run({ pattern: '.' })) as { matches: unknown[]; truncated: boolean };
    expect(r.matches).toHaveLength(20);
    expect(r.truncated).toBe(true);
    await expect(searchCodeTool(ws).run({ pattern: '(' })).rejects.toThrow(/regex inválida/);
  });

  it('globToRegExp', () => {
    expect(globToRegExp('src/**/*.tsx').test('src/a/b/C.tsx')).toBe(true);
    expect(globToRegExp('src/**/*.tsx').test('src/C.tsx')).toBe(true);
    expect(globToRegExp('*.{ts,tsx}').test('a.ts')).toBe(true);
    expect(globToRegExp('*.ts').test('src/a.ts')).toBe(false);
  });
});

describe('analyze_component', () => {
  const run = (file: string) => analyzeComponentTool(ws).run({ file }) as Promise<ComponentAnalysis>;

  it('LoginForm: props, hooks e chamada de API em /services', async () => {
    const a = await run('src/components/LoginForm.tsx');
    expect(a.componentName).toBe('LoginForm');
    expect(a.exportKind).toBe('named');
    expect(a.props).toContain('interface LoginFormProps');
    expect(a.hooks).toContain('useState');
    expect(a.apiCalls).toEqual(['login (@/services/authApi)']);
  });

  it('CartSummary: context via hook customizado', async () => {
    const a = await run('src/components/CartSummary.tsx');
    expect(a.contexts).toEqual(['useCart (@/state/CartContext)']);
    expect(a.apiCalls).toEqual([]);
  });

  it('ThemeToggle: store zustand; UserList: API relativa; Button: export nomeado e default', async () => {
    expect((await run('src/components/ThemeToggle.tsx')).stores).toEqual(['useThemeStore (../state/themeStore)']);
    expect((await run('src/components/UserList.tsx')).apiCalls).toEqual(['fetchUsers (../services/userApi)']);
    expect((await run('src/components/Button.tsx')).exportKind).toBe('both');
  });
});

describe('ciclos de import', () => {
  let dir: string;
  let cyc: Workspace;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'reactest-cycle-'));
    await writeFile(join(dir, 'package.json'), '{"dependencies":{"react":"*"}}');
    await writeFile(join(dir, 'a.ts'), "import { b } from './b';\nexport const a = () => b;\n");
    await writeFile(join(dir, 'b.ts'), "import { a } from './a';\nexport const b = () => a;\n");
    cyc = new Workspace(dir);
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('list_imports resolve os dois lados do ciclo sem recursão', async () => {
    const ra = (await listImportsTool(cyc).run({ file: 'a.ts' })) as { imports: ImportEntry[] };
    const rb = (await listImportsTool(cyc).run({ file: 'b' })) as { file: string; imports: ImportEntry[] };
    expect(ra.imports[0]!.resolvedPath).toBe('b.ts');
    expect(rb.file).toBe('b.ts');
    expect(rb.imports[0]!.resolvedPath).toBe('a.ts');
  });
});
