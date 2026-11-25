// Roda o loop de self-healing (Executor ⇄ Reparador) no workspace e mostra o histórico e o trace do Reparador.
// Uso: npm run heal -- <componente> [--workspace fixtures/sample-app] [--max-iter 3] [--model gpt-4o] [--keep]
//
// Com OPENAI_API_KEY: Contexto (01) → Gerador (03) → healLoop, tudo com LLM real.
// Sem a chave (só LoginForm): Jest REAL + LLM roteirizado. O teste inicial tem um bug de async e o Reparador
// roteirizado primeiro tenta "curar" apagando uma asserção (o guardrail recusa) e depois corrige de verdade.
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Command } from 'commander';
import { TraceWriter } from '../src/core/agent/trace';
import { buildContext } from '../src/core/agents/context';
import { EXECUTOR_AGENT } from '../src/core/agents/executor';
import { generateTest } from '../src/core/agents/generator';
import { REPAIRER_AGENT } from '../src/core/agents/repairer';
import { healLoop } from '../src/core/healLoop';
import { AgentMeter, MeteredLLM, newRunId } from '../src/core/metrics';
import { ASYNC_FIX_DELETING_ASSERTION, BAD_ASYNC, GOOD, loginCtx } from '../src/core/testing/healFixtures';
import type { ContextResult, LLMClient, LLMRequest } from '../src/core/types';
import { FakeLLM } from '../src/llm/fake';
import { OpenAIClient } from '../src/llm/openai';

/** LLM roteirizado para o modo sem chave (Executor e Reparador). */
function scriptedLLM(ctx: ContextResult): LLMClient {
  const toolMsgs = (req: LLMRequest) => req.messages.filter((m) => m.role === 'tool');
  return new FakeLLM({
    [EXECUTOR_AGENT]: (req) =>
      toolMsgs(req).length === 0
        ? { toolCalls: [{ id: 'x1', name: 'run_jest', arguments: { testFile: ctx.testFilePath, componentFile: ctx.componentPath } }] }
        : JSON.stringify({ category: null, summary: '(roteirizado) categoria decidida pela verificação cruzada', flaky: false }),
    [REPAIRER_AGENT]: (req) => {
      const n = toolMsgs(req).length;
      if (n === 0) return { toolCalls: [{ id: 'r1', name: 'write_test', arguments: { code: ASYNC_FIX_DELETING_ASSERTION } }] };
      if (n === 1) return { toolCalls: [{ id: 'r2', name: 'run_jest', arguments: { code: GOOD } }] };
      if (n === 2) return { toolCalls: [{ id: 'r3', name: 'write_test', arguments: { code: GOOD } }] };
      return JSON.stringify({ status: 'REPAIRED', note: '(roteirizado) O status só aparece após o login resolver: getByRole → await findByRole, mantendo todas as asserções.' });
    },
  });
}

const program = new Command()
  .argument('<component>', 'caminho do componente, relativo ao workspace')
  .option('--workspace <dir>', 'raiz do workspace', 'fixtures/sample-app')
  .option('--max-iter <n>', 'máximo de iterações de reparo', '3')
  .option('--model <model>', 'modelo OpenAI', process.env.OPENAI_MODEL ?? 'gpt-4o')
  .option('--keep', 'mantém o arquivo de teste gerado no workspace')
  .action(async (component: string, opts: { workspace: string; maxIter: string; model: string; keep?: boolean }) => {
    const real = !!process.env.OPENAI_API_KEY;
    const runId = newRunId();
    const trace = new TraceWriter(opts.workspace, runId);
    const meter = new AgentMeter();
    let ctx: ContextResult;
    let generatedCode: string;
    let llm: MeteredLLM;

    if (real) {
      llm = new MeteredLLM(new OpenAIClient({ model: opts.model }));
      ctx = await buildContext({ workspaceRoot: opts.workspace, componentPath: component, llm, trace, meter });
      generatedCode = (await generateTest({ ctx, workspaceRoot: opts.workspace, llm, trace, meter })).code;
    } else {
      if (!component.endsWith('LoginForm.tsx')) throw new Error('Sem OPENAI_API_KEY só há roteiro para src/components/LoginForm.tsx.');
      ctx = loginCtx(opts.workspace);
      generatedCode = BAD_ASYNC;
      llm = new MeteredLLM(scriptedLLM(ctx));
    }

    const r = await healLoop({ ctx, workspaceRoot: opts.workspace, generatedCode, llm, maxIterations: Number(opts.maxIter), trace, meter });
    await trace.flush();

    console.log(`LLM: ${real ? opts.model : 'ROTEIRIZADO (sem OPENAI_API_KEY) — Jest real'}`);
    console.log(`\n== Resultado: ${r.status} (${r.stopReason}) ==`);
    console.log(JSON.stringify({ iterations: r.iterations, rejectedRepairs: r.rejectedRepairs, modificationRate: r.modificationRate, final: { passed: r.exec.passed, numTests: r.exec.numTests, numFailed: r.exec.numFailed, coverage: r.exec.coverage } }, null, 2));
    console.log('\n== Histórico ==');
    for (const h of r.history) {
      console.log(`#${h.iteration} [${h.category}] ${h.numFailed}/${h.numTests} falhas — ${h.summary}`);
      console.log(`   reparo: ${h.repairStatus} (gravou: ${h.wrote}, recusas: ${h.rejectedRepairs}) — ${h.note}`);
    }
    console.log('\n== Trace do Reparador ==', trace.file);
    for (const line of (await readFile(trace.file, 'utf8')).trim().split('\n')) {
      const e = JSON.parse(line) as { agent: string; step: number; kind: string; text?: string; tools?: { name: string; args: Record<string, unknown>; ok: boolean; result: string }[]; error?: string };
      if (e.agent !== REPAIRER_AGENT) continue;
      const tools = e.tools?.map((t) => {
        const args = Object.fromEntries(Object.entries(t.args).map(([k, v]) => [k, typeof v === 'string' && v.length > 60 ? `<${v.length} chars>` : v]));
        return `\n     ${t.ok ? '' : '✗ '}${t.name}(${JSON.stringify(args)}) → ${t.result.slice(0, 220)}`;
      }).join('');
      console.log(`#${e.step} ${e.kind}${tools ?? ''}${e.kind !== 'tool_calls' && e.text ? `\n     ${e.text.slice(0, 300)}` : ''}${e.error ? ` — ${e.error}` : ''}`);
    }
    console.log('\n== Métricas ==', JSON.stringify({ llm: llm.byTag(), agents: meter.agents() }));
    if (!opts.keep) await rm(join(opts.workspace, ctx.testFilePath), { force: true });
  });

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
