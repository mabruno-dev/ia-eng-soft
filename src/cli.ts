import { readFile } from 'node:fs/promises';
import { Command } from 'commander';
import { TraceWriter } from './core/agent/trace';
import { buildContext } from './core/agents/context';
import { generateTest } from './core/agents/generator';
import { AgentMeter, MeteredLLM, newRunId, StageTimer } from './core/metrics';
import { OpenAIClient } from './llm/openai';

const DEFAULT_MODEL = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';

const program = new Command()
  .name('reactest')
  .description('Gera testes Jest + RTL para um componente React com uma pipeline de agentes de IA.');

// Comando principal: a pipeline completa será conectada nas próximas etapas.
program
  .command('run <component>', { isDefault: true })
  .description('pipeline completa (ainda não implementada)')
  .option('--workspace <dir>', 'raiz do workspace do app React', process.cwd())
  .option('--no-heal', 'desativa o self-healing (Executor ⇄ Reparador)')
  .option('--no-elicit', 'desativa a elicitação de regras de negócio')
  .option('--no-verify', 'desativa o Verificador (mutation testing / smells)')
  .option('--max-iter <n>', 'máximo de iterações de reparo', (v: string) => Number.parseInt(v, 10), 3)
  .action((component: string, opts: Record<string, unknown>) => {
    console.log('ReacTest-Agent: pipeline ainda não implementada. Use "generate" para contexto → gerador.');
    console.log(JSON.stringify({ component, ...opts }, null, 2));
  });

// PROVISÓRIO: só Contexto → Gerador; imprime o plano, o código e o trace. Não grava o teste.
program
  .command('generate <component>')
  .description('[provisório] roda só Contexto → Gerador e imprime o teste gerado')
  .option('--workspace <dir>', 'raiz do workspace do app React', process.cwd())
  .option('--model <model>', 'modelo OpenAI', DEFAULT_MODEL)
  .option('--rules <file>', 'arquivo com regras de negócio (ids como R1, R2...)')
  .option('--max-steps <n>', 'máximo de passos por agente', (v: string) => Number.parseInt(v, 10), 8)
  .action(async (component: string, opts: { workspace: string; model: string; rules?: string; maxSteps: number }) => {
    const runId = newRunId();
    const trace = new TraceWriter(opts.workspace, runId);
    const llm = new MeteredLLM(new OpenAIClient({ model: opts.model }));
    const meter = new AgentMeter();
    const timer = new StageTimer();
    const rules = opts.rules ? await readFile(opts.rules, 'utf8') : undefined;
    const common = { llm, trace, meter, maxSteps: opts.maxSteps };

    try {
      const ctx = await timer.time('context', () => buildContext({ ...common, workspaceRoot: opts.workspace, componentPath: component }));
      console.error(`[contexto] ${ctx.allowedImports.length} imports permitidos, mocks: ${ctx.mockTargets.join(', ') || '(nenhum)'}`);
      const { plan, code } = await timer.time('generator', () =>
        generateTest({ ...common, ctx, workspaceRoot: opts.workspace, ...(rules ? { rules } : {}) }),
      );

      console.log(`== Plano (${plan.scenarios.length} cenários) ==`);
      for (const s of plan.scenarios) console.log(`- [${s.kind}] ${s.name}${s.fromRules.length ? ` (${s.fromRules.join(', ')})` : ''}`);
      console.log(`\n== ${ctx.testFilePath} ==\n${code}`);
    } finally {
      await trace.flush();
      console.error(`\n[trace] ${trace.file}`);
      console.error(`[métricas] ${JSON.stringify({ llm: llm.totals(), agents: meter.agents(), timings: timer.timings() })}`);
    }
  });

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
