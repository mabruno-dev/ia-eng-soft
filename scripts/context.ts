// Executa só o agente de Contexto (01) com LLM real e mostra o resultado resumido e o trace.
// Uso: npm run context -- <componente> [--workspace fixtures/sample-app] [--model gpt-4o]
import { readFile } from 'node:fs/promises';
import { Command } from 'commander';
import { TraceWriter } from '../src/core/agent/trace';
import { buildContext } from '../src/core/agents/context';
import { AgentMeter, MeteredLLM, newRunId } from '../src/core/metrics';
import { OpenAIClient } from '../src/llm/openai';

const program = new Command()
  .argument('<component>', 'caminho do componente, relativo ao workspace')
  .option('--workspace <dir>', 'raiz do workspace', 'fixtures/sample-app')
  .option('--model <model>', 'modelo OpenAI', process.env.OPENAI_MODEL ?? 'gpt-4o')
  .action(async (component: string, opts: { workspace: string; model: string }) => {
    const runId = newRunId();
    const trace = new TraceWriter(opts.workspace, runId);
    const llm = new MeteredLLM(new OpenAIClient({ model: opts.model }));
    const meter = new AgentMeter();

    const ctx = await buildContext({ workspaceRoot: opts.workspace, componentPath: component, llm, trace, meter });
    await trace.flush();

    const { componentSource, dependencies, ...rest } = ctx;
    console.log('== ContextResult (resumido) ==');
    console.log(
      JSON.stringify(
        { ...rest, componentSource: `<${componentSource.length} caracteres>`, dependencies: dependencies.map((d) => `${d.path} (depth ${d.depth})`) },
        null,
        2,
      ),
    );
    console.log('\n== Trace ==', trace.file);
    for (const line of (await readFile(trace.file, 'utf8')).trim().split('\n')) {
      const e = JSON.parse(line) as { step: number; kind: string; tools?: { name: string; args: unknown; ok: boolean }[]; error?: string };
      const tools = e.tools?.map((t) => `${t.ok ? '' : '✗ '}${t.name}(${JSON.stringify(t.args)})`).join(', ');
      console.log(`#${e.step} ${e.kind}${tools ? `: ${tools}` : ''}${e.error ? ` — ${e.error}` : ''}`);
    }
    console.log('\n== Métricas ==', JSON.stringify({ llm: llm.totals(), agents: meter.agents() }));
  });

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
