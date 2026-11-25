import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createTypechecker, pickTsconfig, typecheckTestTool } from './typecheck';

const FIXTURE = fileURLToPath(new URL('../../../fixtures/sample-app', import.meta.url));
// Arquivo que não existe no fixture: prova de que nada é gravado em disco.
const PROBE = 'src/components/__reactest_typecheck_probe.test.tsx';
const hasDeps = existsSync(join(FIXTURE, 'node_modules', '@types', 'react'));

const header = `import { render, screen } from '@testing-library/react';
import { Button } from './Button';
`;

describe('pickTsconfig', () => {
  it('prefere o tsconfig do ts-jest', () => {
    expect(pickTsconfig(FIXTURE)).toBe(join(FIXTURE, 'tsconfig.jest.json'));
  });
});

// Só leitura: o código candidato existe apenas no projeto ts-morph em memória.
describe.skipIf(!hasDeps)('typecheck_test (ts-morph em memória, fixture real)', { timeout: 120_000 }, () => {
  const check = createTypechecker(FIXTURE, PROBE);

  it('acusa TS2741 quando o teste omite a prop obrigatória children (caso do Button)', async () => {
    const r = await check(`${header}describe('Button', () => {\n  it('x', () => {\n    render(<Button></Button>);\n    expect(screen.getByRole('button')).toBeInTheDocument();\n  });\n});\n`);
    expect(r.ok).toBe(false);
    expect(r.diagnostics[0]).toMatchObject({ code: 'TS2741', location: `${PROBE}:5` });
    expect(r.diagnostics[0]!.message).toMatch(/Property 'children' is missing/);
    expect(existsSync(join(FIXTURE, PROBE))).toBe(false);
  });

  it('aceita o código corrigido (children={null}) com globais do Jest e matchers do jest-dom', async () => {
    const r = await check(`${header}describe('Button', () => {\n  it('x', () => {\n    const onClick = jest.fn();\n    render(<Button onClick={onClick}>{null}</Button>);\n    expect(screen.getByRole('button')).toBeInTheDocument();\n  });\n});\n`);
    expect(r).toEqual({ ok: true, errors: 0, diagnostics: [] });
  });

  it('a ferramenta devolve no máximo 10 diagnósticos e o total', async () => {
    const many = Array.from({ length: 12 }, (_, i) => `const v${i}: number = 'x';`).join('\n');
    const r = (await typecheckTestTool(check).run({ code: `${many}\n` })) as { ok: boolean; errors: number; diagnostics: unknown[] };
    expect(r.ok).toBe(false);
    expect(r.errors).toBe(12);
    expect(r.diagnostics).toHaveLength(10);
  });
});
