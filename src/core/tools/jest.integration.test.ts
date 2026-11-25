// Teste de INTEGRAÇÃO: roda o Jest real do fixtures/sample-app (lento, ~10s por caso).
// Pule com SKIP_INTEGRATION=1 (ou `npm run test:unit`).
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyFailure } from '../guardrail';
import { findJestBin, runJest } from './jest';

const FIXTURE = fileURLToPath(new URL('../../../fixtures/sample-app', import.meta.url));
const COMPONENT = 'src/components/Button.tsx';
const skip = !!process.env.SKIP_INTEGRATION || !findJestBin(FIXTURE);

const created: string[] = [];
function writeTest(name: string, code: string): string {
  const rel = `src/components/__reactest_it_${name}_${process.pid}.test.tsx`;
  writeFileSync(join(FIXTURE, rel), code);
  created.push(join(FIXTURE, rel));
  return rel;
}
afterEach(() => {
  for (const f of created.splice(0)) if (existsSync(f)) rmSync(f);
});

const header = `import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Button } from './Button';
`;

describe.skipIf(skip)('run_jest (integration) no fixtures/sample-app', { timeout: 150_000 }, () => {
  it('(a) teste correto para Button → passed e coverage > 0', async () => {
    const testFile = writeTest(
      'ok',
      `${header}
describe('Button', () => {
  it('renderiza o texto com a variante primary por padrão', () => {
    render(<Button>Salvar</Button>);
    expect(screen.getByRole('button', { name: 'Salvar' })).toHaveClass('btn', 'btn-primary');
  });
  it('chama onClick ao clicar', async () => {
    const onClick = jest.fn();
    render(<Button onClick={onClick}>Ok</Button>);
    await userEvent.click(screen.getByRole('button', { name: 'Ok' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
`,
    );
    const r = await runJest(FIXTURE, { testFile, componentFile: COMPONENT });
    expect(r).toMatchObject({ passed: true, numTests: 2, numFailed: 0, failures: [] });
    expect(r.suiteError).toBeUndefined();
    expect(r.coverage.statements).toBeGreaterThan(0);
    expect(r.coverage.lines).toBeGreaterThan(0);
    expect(classifyFailure(r)).toBeNull();
  });

  it('(b) asserção errada → failures com a mensagem do expect', async () => {
    const testFile = writeTest(
      'assert',
      `${header}
describe('Button', () => {
  it('usa a variante danger', () => {
    render(<Button variant="danger">Excluir</Button>);
    expect(screen.getByRole('button').className).toBe('btn btn-primary');
  });
});
`,
    );
    const r = await runJest(FIXTURE, { testFile, componentFile: COMPONENT });
    expect(r).toMatchObject({ passed: false, numTests: 1, numFailed: 1 });
    expect(r.suiteError).toBeUndefined();
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0]!.testName).toBe('Button usa a variante danger');
    expect(r.failures[0]!.message).toContain('expect(received).toBe(expected)');
    expect(r.failures[0]!.message).toContain('Expected: "btn btn-primary"');
    expect(r.failures[0]!.message).toContain('Received: "btn btn-danger"');
    expect(r.failures[0]!.message).not.toMatch(/\u001b\[/); // sem ANSI
    expect(r.coverage.statements).toBeGreaterThan(0);
    expect(classifyFailure(r)).toBe('ASSERTION');
  });

  it('(c) import inexistente → suiteError com "Cannot find module"', async () => {
    const testFile = writeTest(
      'import',
      `${header}import { formatCurrency } from '../utils/naoExiste';

describe('Button', () => {
  it('renderiza', () => {
    render(<Button>{formatCurrency(1)}</Button>);
    expect(screen.getByRole('button')).toBeInTheDocument();
  });
});
`,
    );
    const r = await runJest(FIXTURE, { testFile, componentFile: COMPONENT });
    expect(r).toMatchObject({ passed: false, numTests: 0, numFailed: 0, failures: [] });
    expect(r.suiteError).toContain('Cannot find module');
    expect(r.coverage).toEqual({ statements: 0, branches: 0, functions: 0, lines: 0 });
    expect(classifyFailure(r)).toBe('IMPORT');
  });

  it('timeout do processo → passed:false com suiteError explicando', async () => {
    const testFile = writeTest('hang', `describe('x', () => { it('trava', () => { while (true) {} }); });\n`);
    const r = await runJest(FIXTURE, { testFile, componentFile: COMPONENT }, { timeoutMs: 3_000 });
    expect(r.passed).toBe(false);
    expect(r.suiteError).toMatch(/Timeout: o Jest excedeu o tempo limite de 3s/);
    expect(classifyFailure(r)).toBe('ASYNC');
  });
});

