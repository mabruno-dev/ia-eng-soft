// Mapeamento evento → mensagem do painel (função pura, sem vscode) e HTML do webview.
import { describe, expect, it } from 'vitest';
import type { PipelineEvent } from '../core/types';
import { renderPanelHtml } from './panelHtml';
import { eventToMessage, initMessage, progressMessage, statusBarText } from './panelModel';

const result = (o: Partial<Extract<PipelineEvent, { type: 'result' }>> = {}): PipelineEvent => ({
  type: 'result', runId: 'r1', component: 'src/components/CartSummary.tsx', status: 'PASSED',
  coverage: { statements: 100, branches: 96.5, functions: 100, lines: 100 },
  mutation: { score: 90.24, killed: 37, survived: 4, timeout: 0, noCoverage: 0, total: 41 },
  iterations: 1, tokens: { input: 134819, output: 19105, estimated: false }, costUsd: 0.7302, ms: 223_500,
  suggestions: [{ mutantId: '3', line: 13, mutator: 'CallExpression', description: 'falta o preventDefault', suggestedAssertion: 'expect(x).toBe(false)' }],
  testFilePath: 'src/components/CartSummary.test.tsx', recordPath: 'r.json', tracePath: 'r.trace.jsonl', ...o,
});

describe('eventToMessage', () => {
  it('agent_start / agent_end → estado do agente na linha do tempo', () => {
    expect(eventToMessage({ type: 'agent_start', agent: 'generator', label: 'Gerador', index: 3, total: 6 }))
      .toEqual({ kind: 'agent', agent: 'generator', label: 'Gerador', index: 3, total: 6, state: 'running' });
    expect(eventToMessage({ type: 'agent_end', agent: 'generator', label: 'Gerador', index: 3, total: 6, ms: 65600, status: 'done', summary: '15 cenários' }))
      .toMatchObject({ kind: 'agent', state: 'done', ms: 65600, summary: '15 cenários' });
    expect(eventToMessage({ type: 'agent_end', agent: 'verifier', label: 'Verificador', index: 6, total: 6, ms: 0, status: 'skipped', summary: 'só roda com a suíte passando' }))
      .toMatchObject({ state: 'skipped' });
    expect(eventToMessage({ type: 'agent_end', agent: 'context', label: 'Contexto', index: 1, total: 6, ms: 5, status: 'error', summary: 'falhou' }))
      .toMatchObject({ state: 'error' });
  });

  it('tool_call → item ao vivo com ✓/✗ e resumo curto', () => {
    expect(eventToMessage({ type: 'tool_call', agent: 'executor', label: 'Executor', tool: 'run_jest', argsSummary: 'testFile=a.test.tsx', ok: false, summary: '2/15 falharam' }))
      .toEqual({ kind: 'tool', agent: 'executor', tool: 'run_jest', args: 'testFile=a.test.tsx', ok: false, summary: '2/15 falharam' });
    const long = eventToMessage({ type: 'tool_call', agent: 'context', label: 'Contexto', tool: 'read_file', argsSummary: 'x'.repeat(500), ok: true, summary: 'y'.repeat(500) });
    expect(long).toMatchObject({ args: expect.stringMatching(/^x{160}…$/), summary: expect.stringMatching(/^y{200}…$/) });
  });

  it('question → pergunta com o porquê e o contador "Pergunta 2 de 5"', () => {
    expect(eventToMessage({ type: 'question', id: 'Q2', text: 'Há cupom mínimo?', why: 'define o valor-limite', index: 2, total: 5 }))
      .toEqual({ kind: 'question', id: 'Q2', text: 'Há cupom mínimo?', why: 'define o valor-limite', counter: 'Pergunta 2 de 5' });
    expect(eventToMessage({ type: 'question', id: 'Q1', text: 't', why: 'w', index: 1 })).toMatchObject({ counter: 'Pergunta 1' });
  });

  it('iteration → cartão da cura com categoria e resumo', () => {
    const it1 = { iteration: 1 } as Extract<PipelineEvent, { type: 'iteration' }>['iteration'];
    expect(eventToMessage({ type: 'iteration', n: 1, category: 'IMPORT', summary: 'módulo não encontrado', iteration: it1 }))
      .toEqual({ kind: 'iteration', n: 1, category: 'IMPORT', summary: 'módulo não encontrado' });
    expect(eventToMessage({ type: 'iteration', n: 2, category: null, summary: 's', iteration: it1 })).toMatchObject({ category: 'sem categoria' });
  });

  it('result PASSED → selo verde, métricas (mutação killed/total, tokens, tempo) e sugestões', () => {
    const m = eventToMessage(result());
    expect(m).toMatchObject({ kind: 'result', status: 'PASSED', tone: 'success', hasTest: true });
    expect(m && m.kind === 'result' && m.note).toBeFalsy();
    const metrics = Object.fromEntries((m as Extract<typeof m, { kind: 'result' }>).metrics.map((x) => [x.label, x.value]));
    expect(metrics).toEqual({
      'Iterações de cura': '1',
      Cobertura: 'branches 96,5% · linhas 100%',
      'Mutação': '90,24% (37/41)',
      Tokens: '134.819 entrada · 19.105 saída',
      Tempo: '223,5 s',
      Custo: 'US$ 0.7302',
    });
    expect((m as Extract<typeof m, { kind: 'result' }>).suggestions).toEqual([
      { title: 'Mutante 3 · CallExpression · linha 13', description: 'falta o preventDefault', assertion: 'expect(x).toBe(false)' },
    ]);
  });

  it('SUSPECTED_COMPONENT_BUG → amarelo com "o teste NÃO foi alterado"; FAILED/ERROR → vermelho; mutação n/d', () => {
    const bug = eventToMessage(result({ status: 'SUSPECTED_COMPONENT_BUG', suggestions: [] }));
    expect(bug).toMatchObject({ tone: 'warning', note: expect.stringContaining('O teste NÃO foi alterado') });
    const { mutation: _m, ...noMutation } = result({ status: 'FAILED' }) as Extract<PipelineEvent, { type: 'result' }>;
    const failed = eventToMessage(noMutation);
    expect(failed).toMatchObject({ tone: 'error' });
    expect((failed as Extract<typeof failed, { kind: 'result' }>).metrics.find((x) => x.label === 'Mutação')?.value).toBe('n/d');
    const { testFilePath: _t, ...noTest } = result({ status: 'ERROR', error: 'falhou' }) as Extract<PipelineEvent, { type: 'result' }>;
    expect(eventToMessage(noTest)).toMatchObject({ tone: 'error', hasTest: false, error: 'falhou' });
    expect(eventToMessage(result({ tokens: { input: 10, output: 2, estimated: true } }))).toMatchObject({
      metrics: expect.arrayContaining([{ label: 'Tokens', value: '10 entrada · 2 saída (estimados)' }]),
    });
  });

  it('nenhuma chave ou token chega ao painel', () => {
    const key = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
    const msgs = [
      eventToMessage({ type: 'error', message: `falhou com ${key}` }),
      eventToMessage({ type: 'tool_call', agent: 'context', label: 'Contexto', tool: 'read_file', argsSummary: `OPENAI_API_KEY=sk-proj-1234567890abcdefghij`, ok: true, summary: `Bearer abcdefghijklmnop1234` }),
      eventToMessage({ type: 'agent_end', agent: 'context', label: 'Contexto', index: 1, total: 6, ms: 1, status: 'error', summary: key }),
      eventToMessage(result({ status: 'ERROR', error: key })),
    ];
    const text = JSON.stringify(msgs);
    expect(text).not.toContain('AbCdEfGhIjKlMnOp');
    expect(text).not.toContain('sk-proj-1234567890');
    expect(text).not.toContain('abcdefghijklmnop1234');
    expect(text).toContain('[REDACTED]');
  });

  it('eventos só do terminal não geram mensagem', () => {
    expect(eventToMessage({ type: 'stage-start', stage: 'context', label: 'Contexto' })).toBeUndefined();
    expect(eventToMessage({ type: 'agent-step', agent: 'context', label: 'Contexto', entry: { ts: '', agent: 'context', step: 1, kind: 'final', llmMs: 0, ms: 0 } })).toBeUndefined();
  });
});

describe('initMessage, progresso e barra de status', () => {
  it('cabeçalho com os 6 agentes na ordem fixa, provedor/modelo e flags em pt-BR', () => {
    const m = initMessage({ component: 'src/components/Button.tsx', config: { heal: true, elicit: true, verify: false, maxIterations: 3, maxAgentSteps: 8, model: 'sonnet', provider: 'claude-cli' } });
    expect(m).toMatchObject({ kind: 'init', component: 'src/components/Button.tsx', provider: 'claude-cli', model: 'sonnet', flags: 'cura ligada (máx. 3) · elicitação ligada · Verificador desligado' });
    expect((m as Extract<typeof m, { kind: 'init' }>).agents.map((a) => `${a.index}.${a.label}`)).toEqual(['1.Contexto', '2.Elicitação', '3.Gerador', '4.Executor', '5.Reparador', '6.Verificador']);
  });

  it('"Agente 3/6 · Gerador" na notificação e "ReacTest: Gerador…" na barra de status', () => {
    const start: PipelineEvent = { type: 'agent_start', agent: 'generator', label: 'Gerador', index: 3, total: 6 };
    expect(progressMessage(start)).toBe('Agente 3/6 · Gerador');
    expect(progressMessage({ type: 'tool_call', agent: 'generator', label: 'Gerador', tool: 'typecheck_test', argsSummary: '', ok: true, summary: '' })).toBe('Agente 3/6 · Gerador · typecheck_test');
    expect(statusBarText(start)?.text).toBe('$(sync~spin) ReacTest: Gerador…');
    expect(statusBarText(result({ status: 'SUSPECTED_COMPONENT_BUG' }))?.text).toBe('$(warning) ReacTest: SUSPECTED_COMPONENT_BUG');
    expect(progressMessage({ type: 'stage-start', stage: 'write', label: 'Gravação' })).toBeUndefined();
  });
});

describe('renderPanelHtml', () => {
  it('CSP com nonce, sem recursos externos, sem innerHTML e textos em pt-BR', () => {
    const html = renderPanelHtml({ nonce: 'abc123', cspSource: 'vscode-resource:' });
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("script-src 'nonce-abc123'");
    expect(html).toContain('<script nonce="abc123">');
    expect(html).toContain('<style nonce="abc123">');
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toContain('innerHTML');
    expect(html).not.toContain('${'); // nenhuma interpolação esquecida no JS do webview
    for (const t of ['Responder', 'Pular', 'Abrir teste', 'Abrir trace', 'LLM + ferramentas', 'Sugestões do Verificador']) expect(html).toContain(t);
    expect(html).toContain('var(--vscode-');
    // o JS do webview é uma string: garante que pelo menos compila
    const js = /<script nonce="abc123">([\s\S]*)<\/script>/.exec(html)?.[1] ?? '';
    expect(js.length).toBeGreaterThan(1000);
    expect(() => new Function(js)).not.toThrow();
  });
});
