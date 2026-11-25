import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { extractModuleReferences, validateImports } from './importValidator';
import { validateImportsTool } from './tools/validateImports';
import type { ContextResult } from './types';

const FIXTURE = fileURLToPath(new URL('../../fixtures/sample-app', import.meta.url));

const ctx: ContextResult = {
  componentPath: 'src/components/LoginForm.tsx',
  componentName: 'LoginForm',
  componentSource: '',
  testFilePath: 'src/components/LoginForm.test.tsx',
  allowedImports: [{ name: 'virtual', specifier: 'virtual-module', kind: 'named', isExternal: true }],
  dependencies: [],
  props: '',
  hooks: [],
  contexts: [],
  stores: [],
  apiCalls: [],
  mockTargets: ['../services/authApi'],
};

const goodTest = `import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom';
import path from 'node:path';
import { LoginForm } from './LoginForm';
import { login } from '../services/authApi';
import type { User } from '@/types/user';
import { virtual } from 'virtual-module';

jest.mock('../services/authApi');
const actual = jest.requireActual('@/utils/validation');
const fs = require('fs');

it('renderiza', () => {
  render(<LoginForm />);
});
`;

describe('validateImports', () => {
  it('aceita teste com imports relativos, alias, pacotes (com subcaminho), builtins e allowedImports', () => {
    expect(validateImports(goodTest, ctx, FIXTURE)).toEqual({ valid: true, unresolved: [] });
  });

  it('rejeita import inexistente informando a linha', () => {
    const bad = `import { render } from '@testing-library/react';
import { LoginForm } from './LoginForm';
import { x } from '../componentes/inexistente';
`;
    expect(validateImports(bad, ctx, FIXTURE)).toEqual({
      valid: false,
      unresolved: [{ specifier: '../componentes/inexistente', line: 3 }],
    });
  });

  it('confere jest.mock, jest.requireActual, require, alias quebrado e pacote fora do package.json', () => {
    const bad = `import { a } from '@/nao/existe';
jest.mock('../services/naoExiste');
const r = jest.requireActual('./Fantasma');
const p = require('left-pad');
`;
    expect(validateImports(bad, ctx, FIXTURE).unresolved).toEqual([
      { specifier: '@/nao/existe', line: 1 },
      { specifier: '../services/naoExiste', line: 2 },
      { specifier: './Fantasma', line: 3 },
      { specifier: 'left-pad', line: 4 },
    ]);
  });

  it('extractModuleReferences identifica a origem de cada referência', () => {
    expect(extractModuleReferences(goodTest).map((r) => r.via)).toEqual([
      'import',
      'import',
      'import',
      'import',
      'import',
      'import',
      'import',
      'import',
      'jest.mock',
      'jest.mock',
      'require',
    ]);
  });

  it('ferramenta validate_imports devolve o mesmo resultado', async () => {
    const tool = validateImportsTool(ctx, FIXTURE);
    await expect(tool.run({ code: "import x from './nada';" })).resolves.toEqual({
      valid: false,
      unresolved: [{ specifier: './nada', line: 1 }],
    });
  });
});
