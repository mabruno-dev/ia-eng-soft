import { describe, expect, it } from 'vitest';
import { analyzeTestCode, checkRepair } from './guardrail';

// Teste "antes" do reparo: 3 casos, 4 expect, falha por import errado e findBy ausente.
const BEFORE = `import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LoginForm } from './LoginFrom';
import { login } from '../services/authApi';

jest.mock('../services/authApi');
const mockedLogin = jest.mocked(login);

describe('LoginForm', () => {
  it('renderiza o botão Entrar', () => {
    render(<LoginForm />);
    expect(screen.getByRole('button', { name: 'Entrar' })).toBeEnabled();
  });

  it('mostra boas-vindas no sucesso', async () => {
    mockedLogin.mockResolvedValue({ token: 't', user: { id: 1, name: 'Ana' } });
    render(<LoginForm />);
    await userEvent.click(screen.getByRole('button', { name: 'Entrar' }));
    expect(screen.getByRole('status')).toHaveTextContent('Bem-vindo, Ana!');
    expect(mockedLogin).toHaveBeenCalledWith({ email: 'ana@x.com', password: '12345678' });
  });

  it('rejeita senha curta', async () => {
    render(<LoginForm />);
    expect(screen.queryByText('A senha deve ter pelo menos 8 caracteres.')).not.toBeInTheDocument();
  });
});
`;

const replace = (code: string, from: string, to: string) => {
  expect(code).toContain(from);
  return code.replace(from, to);
};

describe('checkRepair — reparos legítimos passam', () => {
  it('corrigir import e trocar getBy por findBy (await) é permitido', () => {
    let after = replace(BEFORE, "from './LoginFrom'", "from './LoginForm'");
    after = replace(after, "expect(screen.getByRole('status'))", "expect(await screen.findByRole('status'))");
    expect(checkRepair(BEFORE, after)).toEqual({ ok: true, violations: [] });
  });

  it('acrescentar asserções e testes é permitido', () => {
    const after = replace(
      BEFORE,
      "  it('rejeita senha curta'",
      "  it('novo caso', () => {\n    render(<LoginForm />);\n    expect(screen.getByLabelText('E-mail')).toHaveValue('');\n  });\n\n  it('rejeita senha curta'",
    );
    expect(checkRepair(BEFORE, after).ok).toBe(true);
  });

  it('trocar o valor esperado por outro valor específico não é trivialização', () => {
    const after = replace(BEFORE, "toHaveTextContent('Bem-vindo, Ana!')", "toHaveTextContent('Olá, Ana!')");
    expect(checkRepair(BEFORE, after).ok).toBe(true);
  });

  it('código idêntico passa', () => {
    expect(checkRepair(BEFORE, BEFORE).ok).toBe(true);
  });
});

describe('checkRepair — violações', () => {
  it('(a) apagar uma asserção', () => {
    const after = replace(BEFORE, "    expect(mockedLogin).toHaveBeenCalledWith({ email: 'ana@x.com', password: '12345678' });\n", '');
    const r = checkRepair(BEFORE, after);
    expect(r.ok).toBe(false);
    expect(r.violations).toEqual([expect.stringMatching(/expect\( diminuiu de 4 para 3/)]);
  });

  it('(a) comentar a asserção também conta (AST ignora comentários)', () => {
    const after = replace(BEFORE, "    expect(screen.getByRole('button', { name: 'Entrar' })).toBeEnabled();", "    // expect(screen.getByRole('button', { name: 'Entrar' })).toBeEnabled();");
    expect(checkRepair(BEFORE, after).violations[0]).toMatch(/diminuiu de 4 para 3/);
  });

  it('(a) "expect(" dentro de uma string não engana a contagem', () => {
    const after = replace(BEFORE, "    expect(mockedLogin).toHaveBeenCalledWith({ email: 'ana@x.com', password: '12345678' });", "    const s = 'expect(mockedLogin)';");
    expect(checkRepair(BEFORE, after).ok).toBe(false);
  });

  it('(b) apagar um caso de teste inteiro', () => {
    const start = BEFORE.indexOf("  it('rejeita senha curta'");
    const end = BEFORE.indexOf('  });\n', start) + '  });\n'.length;
    const after = BEFORE.slice(0, start) + BEFORE.slice(end);
    const r = checkRepair(BEFORE, after);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => /casos it\/test diminuiu de 3 para 2/.test(v))).toBe(true);
  });

  it.each([
    ['it.skip', "  it.skip('rejeita senha curta'"],
    ['it.only', "  it.only('rejeita senha curta'"],
    ['xit', "  xit('rejeita senha curta'"],
    ['test.only', "  test.only('rejeita senha curta'"],
  ])('(c) %s', (what, line) => {
    const after = replace(BEFORE, "  it('rejeita senha curta'", line);
    const r = checkRepair(BEFORE, after);
    expect(r.ok).toBe(false);
    expect(r.violations.some((v) => v.includes(`uso proibido de ${what}`))).toBe(true);
  });

  it('(c) xdescribe, describe.skip, xtest e it.todo', () => {
    for (const [what, after] of [
      ['xdescribe', replace(BEFORE, "describe('LoginForm'", "xdescribe('LoginForm'")],
      ['describe.skip', replace(BEFORE, "describe('LoginForm'", "describe.skip('LoginForm'")],
      ['xtest', replace(BEFORE, "  it('rejeita senha curta'", "  xtest('rejeita senha curta'")],
      ['it.todo', replace(BEFORE, "  it('renderiza o botão Entrar', () => {", "  it.todo('pendente');\n  it('renderiza o botão Entrar', () => {")],
      ['test.todo', replace(BEFORE, "  it('renderiza o botão Entrar', () => {", "  test.todo('pendente');\n  it('renderiza o botão Entrar', () => {")],
    ] as const) {
      const r = checkRepair(BEFORE, after);
      expect(r.ok, what).toBe(false);
      expect(r.violations.some((v) => v.includes(`uso proibido de ${what}`)), `${what}: ${r.violations.join(' | ')}`).toBe(true);
    }
  });

  it('(c) skip que já existia antes não é violação nova', () => {
    const withSkip = replace(BEFORE, "  it('rejeita senha curta'", "  it.skip('rejeita senha curta'");
    expect(checkRepair(withSkip, withSkip).ok).toBe(true);
  });

  it('(d) toHaveTextContent trocado por toBeTruthy no mesmo teste', () => {
    const after = replace(BEFORE, "expect(screen.getByRole('status')).toHaveTextContent('Bem-vindo, Ana!')", "expect(screen.getByRole('status')).toBeTruthy()");
    const r = checkRepair(BEFORE, after);
    expect(r.ok).toBe(false);
    expect(r.violations).toEqual([
      expect.stringMatching(/no teste "LoginForm > mostra boas-vindas no sucesso", uma asserção específica foi trocada por uma trivial: expect\(screen.getByRole\('status'\)\).toHaveTextContent\('Bem-vindo, Ana!'\) → expect\(screen.getByRole\('status'\)\).toBeTruthy\(\)/),
    ]);
  });

  it.each([
    ['toBeDefined', "expect(mockedLogin).toBeDefined()"],
    ['expect(true)', 'expect(true).toBe(true)'],
    ['not.toBeNull', "expect(mockedLogin).not.toBeNull()"],
    ['expect.anything', 'expect(mockedLogin).toHaveBeenCalledWith(expect.anything())'],
  ])('(d) toHaveBeenCalledWith trocado por %s', (_name, trivial) => {
    const after = replace(BEFORE, "expect(mockedLogin).toHaveBeenCalledWith({ email: 'ana@x.com', password: '12345678' })", trivial);
    const r = checkRepair(BEFORE, after);
    expect(r.ok).toBe(false);
    expect(r.violations[0]).toMatch(/asserção específica foi trocada por uma trivial/);
  });

  it('(d) trivialização + teste renomeado é pega pelo fallback global', () => {
    let after = replace(BEFORE, "it('mostra boas-vindas no sucesso'", "it('sucesso'");
    after = replace(after, "expect(screen.getByRole('status')).toHaveTextContent('Bem-vindo, Ana!')", 'expect(true).toBeTruthy()');
    const r = checkRepair(BEFORE, after);
    expect(r.ok).toBe(false);
    expect(r.violations[0]).toMatch(/específicas foram trocadas por triviais/);
  });

  it('(d) mover a asserção para outro teste e trivializar a original é pego por teste', () => {
    let after = replace(BEFORE, "expect(screen.getByRole('status')).toHaveTextContent('Bem-vindo, Ana!');", 'expect(screen.getByRole(\'status\')).toBeDefined();');
    after = replace(after, "    expect(screen.queryByText(", "    expect(screen.getByRole('status')).toHaveTextContent('Bem-vindo, Ana!');\n    expect(screen.queryByText(");
    expect(checkRepair(BEFORE, after).ok).toBe(false);
  });

  it('acumula várias violações', () => {
    let after = replace(BEFORE, "    expect(mockedLogin).toHaveBeenCalledWith({ email: 'ana@x.com', password: '12345678' });\n", '');
    after = replace(after, "  it('rejeita senha curta'", "  it.skip('rejeita senha curta'");
    const r = checkRepair(BEFORE, after);
    expect(r.violations).toHaveLength(3); // expect, casos (skip não conta) e uso de it.skip
  });
});

describe('analyzeTestCode', () => {
  it('conta casos, expects e agrupa asserções por nome completo', () => {
    const a = analyzeTestCode(BEFORE);
    expect(a.testCases).toBe(3);
    expect(a.expectCalls).toBe(4);
    expect(a.forbidden).toEqual([]);
    expect(a.tests.map((t) => [t.name, t.assertions.length])).toEqual([
      ['LoginForm > renderiza o botão Entrar', 1],
      ['LoginForm > mostra boas-vindas no sucesso', 2],
      ['LoginForm > rejeita senha curta', 1],
    ]);
    expect(a.tests.flatMap((t) => t.assertions).every((x) => !x.trivial)).toBe(true);
  });

  it('it.each conta como caso e it.skip.each(t)(...) aparece uma vez como proibido', () => {
    const a = analyzeTestCode("describe('X', () => {\n  it.each([1, 2])('caso %s', (n) => { expect(n).toBeGreaterThan(0); });\n  it.skip.each([1])('pulado %s', () => {});\n});\n");
    expect(a.testCases).toBe(1);
    expect(a.forbidden).toEqual(['it.skip']);
  });
});
