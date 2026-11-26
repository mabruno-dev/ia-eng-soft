import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { TraceWriter } from './agent/trace';
import type { TraceEntry } from './agent/trace';
import { NoopAsker } from './askers';
import { buildContext, defaultTestFilePath } from './agents/context';
import { elicitRules, type ElicitationStats } from './agents/elicitation';
import { type Diagnosis, executeTests } from './agents/executor';
import { generateTest } from './agents/generator';
import { type RepairTestOptions, repairTest } from './agents/repairer';
import { healLoop, syncTestFile } from './healLoop';
import { AgentMeter, MeteredLLM, newRunId, StageTimer, writeRunRecord } from './metrics';
import { acquireTestFileLock } from './runLock';
import type { RunJestFn } from './tools/jest';
import { VERIFIER_MAX_STEPS, type VerifierMode, verifyTest } from './agents/verifier';
import type { RunMutationFn } from './tools/mutation';
import type { TypecheckFn } from './tools/typecheck';
import { canonicalPath, getWorkspace } from './tools/workspace';
import type { AgentId, Asker, ContextResult, Coverage, ExecResult, LLMClient, PipelineConfig, PipelineEvent, RunRecord, Stage } from './types';
import { PIPELINE_AGENTS, agentOf, toolCallEvents } from './events';

export type { PipelineEvent, Stage } from './types';

export const STAGE_LABELS: Record<Stage, string> = {
  context: 'Contexto',
  elicitation: 'Elicitação',
  generator: 'Gerador',
  write: 'Gravação do teste',
  heal: 'Self-healing (Executor ⇄ Reparador)',
  executor: 'Executor (sem reparo)',
  verifier: 'Verificador',
  record: 'RunRecord',
};

/** Rótulo pt-BR do nome técnico de um agente (tag do LLM). */
export const AGENT_LABELS: Record<string, string> = {
  context: 'Contexto',
  elicitation: 'Elicitação',
  'generator.plan': 'Gerador/plano',
  'generator.code': 'Gerador/código',
  executor: 'Executor',
  repairer: 'Reparador',
  verifier: 'Verificador',
};

export interface RunPipelineOptions {
  workspaceRoot: string;
  componentPath: string;
  config: PipelineConfig;
  llm: LLMClient;
  /** Quem responde às perguntas da Elicitação (padrão: NoopAsker — todas puladas). */
  asker?: Asker;
  /** Limite de perguntas da Elicitação (padrão 5, imposto pela ferramenta ask_user). */
  maxQuestions?: number;
  onEvent?: (e: PipelineEvent) => void;
  /** Padrão: newRunId(). */
  runId?: string;
  /** Jest injetável (Executor/Reparador padrão). */
  runJest?: RunJestFn;
  /** Executor injetável (padrão: agente 04). */
  execute?: (o: { ctx: ContextResult; testFilePath: string; iteration: number }) => Promise<{ exec: ExecResult; diagnosis: Diagnosis }>;
  /** Typechecker do Gerador injetável (padrão: ts-morph com o tsconfig do workspace). */
  typecheck?: TypecheckFn;
  /** Verificador: 'full' (agente: mutação + sugestões, padrão) ou 'measure' (só mutação, sem LLM: baseline C1). */
  verifierMode?: VerifierMode;
  /** Stryker injetável (padrão: o do workspace). */
  runMutation?: RunMutationFn;
  /** Mutators desativados no Stryker (ex.: ['StringLiteral']). */
  excludedMutations?: string[];
}

export function runFiles(workspaceRoot: string, runId: string) {
  const dir = join(workspaceRoot, '.reactest', 'runs');
  return { record: join(dir, `${runId}.json`), trace: join(dir, `${runId}.trace.jsonl`) };
}

const ZERO: Coverage = { statements: 0, branches: 0, functions: 0, lines: 0 };
const countLines = (code: string) => (code ? code.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n').length : 0);
const errMsg = (e: unknown) => (e instanceof Error ? `${e.name !== 'Error' ? `${e.name}: ` : ''}${e.message}` : String(e));
/** Texto completo do erro para o trace: stack (ou mensagem) + campos extras de erros de agente. */
function fullError(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const extra = e as Error & { validationError?: string; rawText?: string; cause?: unknown };
  return [
    e.stack ?? errMsg(e),
    extra.validationError ? `validationError: ${extra.validationError}` : '',
    extra.rawText ? `rawText: ${extra.rawText}` : '',
    extra.cause !== undefined ? `cause: ${fullError(extra.cause)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** TraceWriter que também emite cada passo como evento `agent-step`. */
class ObservedTraceWriter extends TraceWriter {
  constructor(root: string, runId: string, private readonly onEntry: (e: TraceEntry) => void) {
    super(root, runId);
  }
  override write(entry: Omit<TraceEntry, 'ts'> & { ts?: string }): Promise<void> {
    try {
      this.onEntry({ ts: entry.ts ?? new Date().toISOString(), ...entry });
    } catch {
      /* um observador com defeito não derruba a pipeline */
    }
    return super.write(entry);
  }
}

/**
 * Orquestrador: a ORDEM dos agentes é fixa e controlada por este código.
 * Contexto → (Elicitação) → Gerador → grava o teste → healLoop | uma execução → (Verificador) → RunRecord.
 * Nunca lança: qualquer erro vira status 'ERROR' com o registro gravado.
 */
export async function runPipeline(opts: RunPipelineOptions): Promise<RunRecord> {
  const { componentPath, config } = opts;
  // Forma real do disco (drive em maiúscula): é o cwd/rootDir do Jest e a raiz do typecheck.
  const workspaceRoot = existsSync(opts.workspaceRoot) ? canonicalPath(opts.workspaceRoot) : opts.workspaceRoot;
  const runId = opts.runId ?? newRunId();
  const emit = (e: PipelineEvent) => {
    try {
      opts.onEvent?.(e);
    } catch {
      /* idem */
    }
  };
  const llm = new MeteredLLM(opts.llm);
  const meter = new AgentMeter();
  const timer = new StageTimer();
  const trace = new ObservedTraceWriter(workspaceRoot, runId, (entry) => {
    emit({ type: 'agent-step', agent: entry.agent, label: AGENT_LABELS[entry.agent] ?? entry.agent, entry });
    for (const ev of toolCallEvents(entry)) emit(ev);
  });
  const t0Run = performance.now();
  const total = PIPELINE_AGENTS.length;
  const agentMeta = (agent: AgentId) => {
    const index = PIPELINE_AGENTS.findIndex((a) => a.id === agent) + 1;
    return { agent, label: PIPELINE_AGENTS[index - 1]!.label, index, total };
  };
  /** Envolve a execução de um agente com agent_start / agent_end (só observação: não muda a lógica). */
  const observeAgent = async <T>(agent: AgentId, fn: () => Promise<T>, summarize?: (r: T) => string): Promise<T> => {
    emit({ type: 'agent_start', ...agentMeta(agent) });
    const t0 = performance.now();
    try {
      const r = await fn();
      let summary = '';
      try {
        summary = summarize ? summarize(r) : '';
      } catch {
        /* resumo é só para a UI */
      }
      emit({ type: 'agent_end', ...agentMeta(agent), ms: performance.now() - t0, status: 'done', summary });
      return r;
    } catch (err) {
      emit({ type: 'agent_end', ...agentMeta(agent), ms: performance.now() - t0, status: 'error', summary: errMsg(err) });
      throw err;
    }
  };
  const skipAgent = (agent: AgentId, reason: string) => emit({ type: 'agent_end', ...agentMeta(agent), ms: 0, status: 'skipped', summary: reason });
  const common = { llm, trace, meter, maxSteps: config.maxAgentSteps };

  /** Executa uma etapa emitindo stage-start/stage-end; `agent` é a chave de tempo por agente (se houver). */
  const stage = async <T>(name: Stage, agent: string | null, fn: () => Promise<T>, summarize?: (r: T) => string): Promise<T> => {
    const label = STAGE_LABELS[name];
    emit({ type: 'stage-start', stage: name, label });
    const t0 = performance.now();
    const ui = agent ? agentOf(agent) : undefined;
    const run = ui ? () => observeAgent(ui, fn, summarize) : fn;
    try {
      const r = agent ? await timer.time(agent, run) : await run();
      emit({ type: 'stage-end', stage: name, label, ms: performance.now() - t0, ok: true, ...(summarize ? { summary: summarize(r) } : {}) });
      return r;
    } catch (err) {
      emit({ type: 'stage-end', stage: name, label, ms: performance.now() - t0, ok: false, summary: errMsg(err) });
      throw err;
    }
  };

  let generatedCode = '';
  let testFilePath: string | undefined;
  let partial: Partial<RunRecord> = {};
  let releaseLock: (() => void) | undefined;

  try {
    const ws = getWorkspace(workspaceRoot);
    ws.abs(componentPath); // confinamento: falha cedo se o componente estiver fora do workspace
    // Trava do arquivo de teste: outra execução no mesmo componente apagaria/sobrescreveria o nosso arquivo.
    releaseLock = acquireTestFileLock(workspaceRoot, ws.rel(ws.abs(defaultTestFilePath(componentPath))), runId);

    // 01 — Contexto
    const ctx = await stage('context', 'context', () => buildContext({ ...common, workspaceRoot, componentPath }), (c) =>
      `${c.allowedImports.length} imports permitidos; mocks: ${c.mockTargets.join(', ') || 'nenhum'}`,
    );
    testFilePath = ctx.testFilePath || defaultTestFilePath(componentPath);

    // 02 — Elicitação: regras de negócio que o código não revela (perguntas ao dev via Asker)
    let rules: string | undefined;
    let elicitationStats: ElicitationStats | undefined;
    if (!config.elicit) skipAgent('elicitation', 'elicitação desligada');
    if (config.elicit) {
      const maxQuestions = opts.maxQuestions ?? 5;
      const inner = opts.asker ?? new NoopAsker();
      let asked = 0;
      // Observa cada pergunta (evento 'question') antes de repassá-la ao Asker real.
      const asker: Asker = {
        ask: (q) => {
          asked++;
          emit({ type: 'question', id: q.id, text: q.question, why: q.why, index: asked, total: maxQuestions });
          return inner.ask(q);
        },
      };
      const el = await stage(
        'elicitation',
        'elicitation',
        () =>
          elicitRules({
            ...common,
            ctx,
            workspaceRoot,
            asker,
            maxQuestions,
            maxSteps: Math.max(config.maxAgentSteps, 2 * maxQuestions + 4),
          }),
        (r) => `${r.rules.length} regra(s); ${r.stats.questions} pergunta(s), ${r.stats.answered} respondida(s), ${r.stats.reused} reaproveitada(s)`,
      );
      rules = el.rulesText || undefined;
      elicitationStats = el.stats;
    }

    // 03 — Gerador
    const gen = await stage(
      'generator',
      'generator',
      () => generateTest({ ...common, ctx, workspaceRoot, ...(rules ? { rules } : {}), ...(opts.typecheck ? { typecheck: opts.typecheck } : {}) }),
      (g) => `${g.plan.scenarios.length} cenários; ${countLines(g.code)} linhas${g.warnings.length ? `; ${g.warnings.length} aviso(s)` : ''}`,
    );
    generatedCode = gen.code;
    if (elicitationStats) {
      partial.elicitation = {
        questions: elicitationStats.questions,
        answered: elicitationStats.answered,
        derivedCases: gen.plan.scenarios.filter((s) => s.fromRules.length > 0).length,
      };
    }

    // Grava o arquivo de teste
    const testAbs = ws.abs(testFilePath);
    await stage('write', null, async () => {
      await mkdir(dirname(testAbs), { recursive: true });
      await writeFile(testAbs, generatedCode, 'utf8');
    }, () => testFilePath!);

    // 04/05 — Executor (+ Reparador)
    const tfp = testFilePath;
    const execute = (iteration: number) =>
      timer.time('executor', () =>
        observeAgent(
          'executor',
          () =>
            opts.execute
              ? opts.execute({ ctx, testFilePath: tfp, iteration })
              : executeTests({ ...common, ctx, workspaceRoot, testFilePath: tfp, ...(opts.runJest ? { runJest: opts.runJest } : {}) }),
          (x) => (x.exec.passed ? `passou (${x.exec.numTests} testes)` : `falhou: ${x.exec.numFailed}/${x.exec.numTests}${x.diagnosis.category ? ` · ${x.diagnosis.category}` : ''}`),
        ),
      );
    let repairerRan = false;

    let status: RunRecord['status'];
    let exec: ExecResult;
    let finalCode: string;
    if (config.heal) {
      const heal = await stage('heal', null, () =>
        healLoop({
          ...common,
          ctx,
          workspaceRoot,
          testFilePath: tfp,
          generatedCode,
          maxIterations: config.maxIterations,
          ...(rules ? { rules } : {}),
          ...(opts.runJest ? { runJest: opts.runJest } : {}),
          execute: ({ iteration }) => execute(iteration),
          repair: (o: RepairTestOptions) => {
            repairerRan = true;
            return timer.time('repairer', () => observeAgent('repairer', () => repairTest(o), (r) => `${r.status}${r.rejectedRepairs ? ` · ${r.rejectedRepairs} recusado(s) pelo guardrail` : ''}`));
          },
          onIteration: (h) => emit({ type: 'iteration', n: h.iteration, category: h.category, summary: h.summary, iteration: h }),
        }),
        (h) => `${h.status} (${h.stopReason}) após ${h.iterations} iteração(ões)`,
      );
      if (!repairerRan) skipAgent('repairer', 'não foi necessário');
      status = heal.status;
      exec = heal.exec;
      finalCode = heal.finalCode;
      partial = {
        ...partial,
        iterations: heal.iterations,
        rejectedRepairs: heal.rejectedRepairs,
        alignedToBehavior: heal.alignedToBehavior,
        modificationRate: heal.modificationRate,
        history: heal.history.map(({ iteration, category, summary, repairStatus, note, rejectedRepairs, alignedToBehavior }) => ({
          iteration, category, summary, repairStatus, note, rejectedRepairs, alignedToBehavior,
        })),
      };
    } else {
      // Baseline: uma execução só para medir, sem reparo.
      const r = await stage('executor', null, async () => {
        const warning = syncTestFile(testAbs, generatedCode);
        if (warning) await trace.write({ agent: 'pipeline', step: 0, kind: 'warning', text: `${warning}: ${tfp}`, llmMs: 0, ms: 0 });
        return execute(0);
      }, (x) => (x.exec.passed ? 'passou' : `falhou (${x.diagnosis.category ?? '?'})`));
      skipAgent('repairer', 'cura desligada (baseline)');
      exec = r.exec;
      status = exec.passed ? 'PASSED' : 'FAILED';
      finalCode = generatedCode;
      partial = { ...partial, iterations: 0, rejectedRepairs: 0, alignedToBehavior: 0, modificationRate: 0, history: [] };
    }

    // 06 — Verificador: só com a suíte PASSANDO (o Stryker exige o teste verde). Não altera o teste.
    if (!config.verify) skipAgent('verifier', 'Verificador desligado');
    else if (status !== 'PASSED') skipAgent('verifier', `só roda com a suíte passando (status ${status})`);
    if (config.verify && status === 'PASSED') {
      const finalTestCode = finalCode;
      try {
        const v = await stage(
          'verifier',
          'verifier',
          () =>
            verifyTest({
              ...common,
              maxSteps: Math.max(config.maxAgentSteps, VERIFIER_MAX_STEPS),
              ctx,
              workspaceRoot,
              testFilePath: tfp,
              testCode: finalTestCode,
              runId,
              mode: opts.verifierMode ?? 'full',
              ...(opts.runMutation ? { runMutation: opts.runMutation } : {}),
              ...(opts.excludedMutations ? { excludedMutations: opts.excludedMutations } : {}),
            }),
          (v) =>
            v.mutation
              ? `mutação ${v.mutation.score}% (${v.mutation.killed + v.mutation.timeout}/${v.mutation.total}); ${v.suggestions.length} sugestão(ões)`
              : `mutação n/d${v.error ? ` — ${v.error}` : ''}`,
        );
        if (v.mutation) {
          const { score, killed, survived, timeout, noCoverage, total } = v.mutation;
          partial.mutation = { score, killed, survived, timeout, noCoverage, total };
        }
        partial.verification = { suggestions: v.suggestions, ...(v.error ? { error: v.error } : {}) };
      } catch (err) {
        // O Verificador nunca derruba o run: mutação fica n/d.
        partial.verification = { suggestions: [], error: errMsg(err) };
      }
    }

    const record: RunRecord = {
      ...baseRecord(),
      status,
      iterations: partial.iterations ?? 0,
      generated: { code: generatedCode, lines: countLines(generatedCode) },
      final: { code: finalCode, lines: countLines(finalCode) },
      modificationRate: partial.modificationRate ?? 0,
      coverage: exec.coverage,
      rejectedRepairs: partial.rejectedRepairs ?? 0,
      alignedToBehavior: partial.alignedToBehavior ?? 0,
      testFilePath: tfp,
      history: partial.history ?? [],
      ...(partial.elicitation ? { elicitation: partial.elicitation } : {}),
      ...(partial.mutation ? { mutation: partial.mutation } : {}),
      ...(partial.verification ? { verification: partial.verification } : {}),
    };
    return await finish(record);
  } catch (err) {
    const message = errMsg(err);
    emit({ type: 'error', message });
    await trace.write({ agent: 'pipeline', step: 0, kind: 'error', text: message, error: fullError(err), llmMs: 0, ms: 0 }).catch(() => undefined);
    let finalCode = generatedCode;
    try {
      if (testFilePath) {
        const abs = getWorkspace(workspaceRoot).abs(testFilePath);
        if (existsSync(abs)) finalCode = readFileSync(abs, 'utf8');
      }
    } catch {
      /* mantém o gerado */
    }
    return finish({
      ...baseRecord(),
      status: 'ERROR',
      iterations: partial.iterations ?? 0,
      generated: { code: generatedCode, lines: countLines(generatedCode) },
      final: { code: finalCode, lines: countLines(finalCode) },
      modificationRate: partial.modificationRate ?? 0,
      coverage: { ...ZERO },
      rejectedRepairs: partial.rejectedRepairs ?? 0,
      alignedToBehavior: partial.alignedToBehavior ?? 0,
      ...(testFilePath ? { testFilePath } : {}),
      history: partial.history ?? [],
      ...(partial.elicitation ? { elicitation: partial.elicitation } : {}),
      error: message,
    });
  }

  function baseRecord() {
    return { runId, component: componentPath, config, llm: llm.totals(), agents: {}, timings: timer.timings() };
  }

  /** Atualiza métricas no instante final e grava RunRecord + trace (falha de escrita não vira exceção). */
  async function finish(record: RunRecord): Promise<RunRecord> {
    const done: RunRecord = { ...record, llm: llm.totals(), agents: meter.agents(), timings: timer.timings() };
    emit({ type: 'stage-start', stage: 'record', label: STAGE_LABELS.record });
    const t0 = performance.now();
    try {
      await trace.flush();
      if (existsSync(workspaceRoot)) await writeRunRecord(workspaceRoot, done);
      emit({ type: 'stage-end', stage: 'record', label: STAGE_LABELS.record, ms: performance.now() - t0, ok: true, summary: runFiles(workspaceRoot, runId).record });
    } catch (err) {
      emit({ type: 'stage-end', stage: 'record', label: STAGE_LABELS.record, ms: performance.now() - t0, ok: false, summary: errMsg(err) });
    } finally {
      releaseLock?.();
    }
    const files = runFiles(workspaceRoot, runId);
    emit({
      type: 'result',
      runId,
      component: componentPath,
      status: done.status,
      coverage: done.coverage,
      ...(done.mutation ? { mutation: done.mutation } : {}),
      iterations: done.iterations,
      tokens: { input: done.llm.inputTokens, output: done.llm.outputTokens, estimated: !!done.llm.tokensEstimated },
      ...(done.llm.costUsd !== undefined ? { costUsd: done.llm.costUsd } : {}),
      ms: performance.now() - t0Run,
      suggestions: done.verification?.suggestions ?? [],
      ...(done.testFilePath ? { testFilePath: done.testFilePath } : {}),
      recordPath: files.record,
      tracePath: files.trace,
      ...(done.error ? { error: done.error } : {}),
    });
    return done;
  }
}
