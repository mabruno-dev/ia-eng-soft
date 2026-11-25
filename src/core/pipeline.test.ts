import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FakeLLM, type FakeReply } from '../llm/fake';
import { GENERATOR_CODE_AGENT, GENERATOR_PLAN_AGENT } from './agents/generator';
import { REPAIRER_AGENT } from './agents/repairer';
import { type PipelineEvent, runFiles, runPipeline } from './pipeline';
import { renderReport } from './report';
import { call, execs, final, GOOD, scriptedExecutor, TEST_FILE, tempWorkspace } from './testing/healFixtures';
import type { PipelineConfig, RunRecord } from './types';

let ws: ReturnType<typeof tempWorkspace>;
beforeEach(() => {
  ws = tempWorkspace();
});
afterEach(() => ws.cleanup());

const COMPONENT = 'src/components/LoginForm.tsx';
const config = (o: Partial<PipelineConfig> = {}): PipelineConfig => ({
  heal: true, elicit: false, verify: false, maxIterations: 3, maxAgentSteps: 8, model: 'fake', provider: 'openai', ...o,
});

/** Roteiro do Contexto: obtém os caminhos via relative_specifier e responde o ContextResult. */
const contextScript = (): FakeReply[] => [
  call('relative_specifier', { fromTestFile: TEST_FILE, targetFile: COMPONENT }),
  call('relative_specifier', { fromTestFile: TEST_FILE, targetFile: 'src/services/authApi.ts' }),
  JSON.stringify({
    componentName: 'LoginForm',
    allowedImports: [
      { name: 'LoginForm', specifier: './LoginForm', kind: 'named', isExternal: false },
      { name: 'login', specifier: '../services/authApi', kind: 'named', isExternal: false },
    ],
    dependencies: [{ path: 'src/services/authApi.ts', depth: 1 }],
    hooks: ['useState'],
    apiCalls: ['login (@/services/authApi)'],
    mockTargets: ['../services/authApi'],
  }),
];
const plan = JSON.stringify({
  scenarios: [
    { name: 'renderiza o botão Entrar', kind: 'render', description: 'estado inicial', mocks: [], fromRules: [] },
    { name: 'mostra boas-vindas no sucesso', kind: 'async', description: 'login resolve', mocks: ['../services/authApi'], fromRules: [] },
    { name: 'rejeita senha com 7 caracteres', kind: 'edge', description: 'limite', mocks: [], fromRules: [] },
  ],
});
/** O Gerador entrega `code` (o validate_imports só reporta; quem barra caminho errado é o checkGeneratedCode). */
const generatorScript = (code: string) => ({
  [GENERATOR_PLAN_AGENT]: [plan],
  [GENERATOR_CODE_AGENT]: [call('validate_imports', { code }), JSON.stringify({ code })],
});

const savedRecord = (r: RunRecord) => JSON.parse(readFileSync(runFiles(ws.root, r.runId).record, 'utf8')) as RunRecord;

describe('runPipeline', () => {
  it('(a) caminho feliz: Contexto → Gerador → grava → healLoop passa sem reparo → RunRecord + trace', async () => {
    const fake = new FakeLLM({ context: contextScript(), ...generatorScript(GOOD) });
    const ex = scriptedExecutor(ws.root, () => execs.pass());
    const events: PipelineEvent[] = [];

    const r = await runPipeline({ workspaceRoot: ws.root, componentPath: COMPONENT, config: config(), llm: fake, execute: ex.execute, onEvent: (e) => events.push(e) });

    expect(r).toMatchObject({
      status: 'PASSED', component: COMPONENT, iterations: 0, rejectedRepairs: 0, modificationRate: 0, testFilePath: TEST_FILE,
      coverage: { statements: 90, branches: 80, functions: 100, lines: 90 },
      generated: { code: GOOD, lines: GOOD.trimEnd().split('\n').length },
      final: { code: GOOD },
      history: [],
    });
    expect(r.error).toBeUndefined();
    expect(readFileSync(join(ws.root, TEST_FILE), 'utf8')).toBe(GOOD);
    // métricas vêm do MeteredLLM / AgentMeter / StageTimer
    expect(r.llm.calls).toBe(6);
    expect(r.agents).toEqual({
      context: { steps: 3, toolCalls: 2 },
      [GENERATOR_PLAN_AGENT]: { steps: 1, toolCalls: 0 },
      [GENERATOR_CODE_AGENT]: { steps: 2, toolCalls: 1 },
    });
    expect(Object.keys(r.timings.perAgentMs).sort()).toEqual(['context', 'executor', 'generator']);
    expect(r.timings.totalMs).toBeGreaterThan(0);
    // arquivos gravados
    expect(savedRecord(r)).toEqual(r);
    const trace = readFileSync(runFiles(ws.root, r.runId).trace, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { agent: string });
    expect(new Set(trace.map((t) => t.agent))).toEqual(new Set(['context', GENERATOR_PLAN_AGENT, GENERATOR_CODE_AGENT]));
    // eventos: ordem fixa das etapas + passos dos agentes
    const stages = events.filter((e) => e.type === 'stage-start').map((e) => (e as { stage: string }).stage);
    expect(stages).toEqual(['context', 'generator', 'write', 'heal', 'record']);
    expect(events.filter((e) => e.type === 'agent-step')).toHaveLength(6);
    expect(events.find((e) => e.type === 'agent-step' && e.entry.tools?.[0]?.name === 'relative_specifier')).toMatchObject({ label: 'Contexto' });
    expect(renderReport(r)).toContain('✅ PASSED');
  });

  it('(a) com reparo: import errado corrigido; history, modificationRate e evento iteration', async () => {
    const fake = new FakeLLM({
      context: contextScript(),
      [GENERATOR_PLAN_AGENT]: [plan],
      // o checkGeneratedCode do Gerador recusaria um import errado; aqui o executor roteirizado reporta a falha de import
      // na 1ª execução e só passa depois que o Reparador gravar a revisão
      [GENERATOR_CODE_AGENT]: [call('validate_imports', { code: GOOD }), JSON.stringify({ code: GOOD })],
      [REPAIRER_AGENT]: [call('write_test', { code: `${GOOD}// revisado\n` }), final('REPAIRED', 'Corrigido.')],
    });
    let first = true;
    const ex = scriptedExecutor(ws.root, (code) => {
      if (first) {
        first = false;
        return execs.importFail();
      }
      return code.includes('// revisado') ? execs.pass() : execs.importFail();
    });
    const events: PipelineEvent[] = [];

    const r = await runPipeline({ workspaceRoot: ws.root, componentPath: COMPONENT, config: config(), llm: fake, execute: ex.execute, onEvent: (e) => events.push(e) });

    expect(r).toMatchObject({ status: 'PASSED', iterations: 1, rejectedRepairs: 0 });
    expect(r.history).toEqual([expect.objectContaining({ iteration: 1, category: 'IMPORT', repairStatus: 'REPAIRED' })]);
    expect(r.modificationRate).toBeGreaterThan(0);
    expect(r.final.code).toContain('// revisado');
    expect(r.agents[REPAIRER_AGENT]).toEqual({ steps: 2, toolCalls: 1 });
    expect(r.timings.perAgentMs.repairer).toBeGreaterThanOrEqual(0);
    expect(events.filter((e) => e.type === 'iteration')).toHaveLength(1);
    expect(renderReport(r)).toMatch(/\| 1 \| IMPORT \|/);
  });

  it('(b) C1 (heal:false, elicit:false): uma execução só, sem reparo, RunRecord gravado', async () => {
    const fake = new FakeLLM({ context: contextScript(), ...generatorScript(GOOD) });
    const ex = scriptedExecutor(ws.root, () => execs.asyncFail());
    const events: PipelineEvent[] = [];

    const r = await runPipeline({ workspaceRoot: ws.root, componentPath: COMPONENT, config: config({ heal: false }), llm: fake, execute: ex.execute, onEvent: (e) => events.push(e) });

    expect(r).toMatchObject({ status: 'FAILED', iterations: 0, rejectedRepairs: 0, modificationRate: 0, history: [], config: { heal: false, elicit: false } });
    expect(r.final.code).toBe(r.generated.code);
    expect(ex.calls()).toBe(1);
    expect(fake.requestsFor(REPAIRER_AGENT)).toHaveLength(0);
    expect(r.agents[REPAIRER_AGENT]).toBeUndefined();
    expect(events.filter((e) => e.type === 'stage-start').map((e) => (e as { stage: string }).stage)).toEqual(['context', 'generator', 'write', 'executor', 'record']);
    expect(savedRecord(r).status).toBe('FAILED');
    expect(renderReport(r)).toContain('Self-healing desativado (baseline)');
  });

  it('elicit e verify ligados são pontos de extensão no-op (só com asker para a elicitação)', async () => {
    const fake = new FakeLLM({ context: contextScript(), ...generatorScript(GOOD) });
    const events: PipelineEvent[] = [];
    const asker = { ask: async () => 'sim' };
    const r = await runPipeline({
      workspaceRoot: ws.root, componentPath: COMPONENT, config: config({ elicit: true, verify: true }), llm: fake, asker,
      execute: scriptedExecutor(ws.root, () => execs.pass()).execute, onEvent: (e) => events.push(e),
    });
    expect(r.status).toBe('PASSED');
    expect(events.filter((e) => e.type === 'stage-start').map((e) => (e as { stage: string }).stage)).toEqual(['context', 'elicitation', 'generator', 'write', 'heal', 'verifier', 'record']);
  });

  it('(c) erro inesperado vira status ERROR com registro gravado (sem exceção solta)', async () => {
    const fake = new FakeLLM({ context: contextScript(), ...generatorScript(GOOD) });
    const events: PipelineEvent[] = [];
    const r = await runPipeline({
      workspaceRoot: ws.root, componentPath: COMPONENT, config: config(), llm: fake,
      execute: async () => {
        throw new Error('disco cheio');
      },
      onEvent: (e) => events.push(e),
    });
    expect(r).toMatchObject({ status: 'ERROR', error: 'disco cheio', testFilePath: TEST_FILE, generated: { code: GOOD }, final: { code: GOOD } });
    expect(r.coverage).toEqual({ statements: 0, branches: 0, functions: 0, lines: 0 });
    expect(savedRecord(r)).toMatchObject({ status: 'ERROR', error: 'disco cheio' });
    expect(events).toContainEqual({ type: 'error', message: 'disco cheio' });
    expect(events.find((e) => e.type === 'stage-end' && e.stage === 'heal')).toMatchObject({ ok: false });
    expect(renderReport(r)).toContain('> **Erro:** disco cheio');
  });

  it('(c) AgentStepLimitError do Contexto vira ERROR com registro e trace', async () => {
    const fake = new FakeLLM({ context: () => call('list_imports', { file: COMPONENT }) }); // nunca responde o final
    const r = await runPipeline({ workspaceRoot: ws.root, componentPath: COMPONENT, config: config({ maxAgentSteps: 3 }), llm: fake });
    expect(r.status).toBe('ERROR');
    expect(r.error).toMatch(/^AgentStepLimitError: Agente "context" excedeu o limite de 3 passos/);
    expect(r.generated).toEqual({ code: '', lines: 0 });
    expect(r.agents.context).toEqual({ steps: 3, toolCalls: 3 });
    expect(r.llm.calls).toBe(3);
    expect(savedRecord(r).status).toBe('ERROR');
    expect(readFileSync(runFiles(ws.root, r.runId).trace, 'utf8')).toContain('"kind":"step_limit"');
    expect(existsSync(join(ws.root, TEST_FILE))).toBe(false);
  });

  it('(c) componente fora do workspace e onEvent que lança não derrubam a pipeline', async () => {
    const r = await runPipeline({
      workspaceRoot: ws.root, componentPath: '../fora.tsx', config: config(), llm: new FakeLLM(),
      onEvent: () => {
        throw new Error('observador quebrado');
      },
    });
    expect(r.status).toBe('ERROR');
    expect(r.error).toMatch(/fora do workspace/);
  });
});
