import { isAbsolute, relative, resolve } from 'node:path';
import { Command, InvalidArgumentError, Option } from 'commander';
import { answersFileAsker, terminalAsker } from './core/askers';
import { AGENT_LABELS, type PipelineEvent, runFiles, runPipeline } from './core/pipeline';
import { formatEvent } from './core/progressFormat';
import type { Asker, LLMClient, PipelineConfig, RunRecord } from './core/types';
import { OpenAIClient } from './llm/openai';

const DEFAULT_MODEL = process.env.OPENAI_MODEL ?? 'gpt-4o-mini';

const int = (name: string, min: number) => (v: string) => {
  const n = Number.parseInt(v, 10);
  if (!Number.isInteger(n) || n < min) throw new InvalidArgumentError(`${name} deve ser um inteiro >= ${min}`);
  return n;
};

function onEvent(e: PipelineEvent): void {
  for (const line of formatEvent(e)) console.log(line);
}

function printSummary(r: RunRecord, workspaceRoot: string): void {
  const files = runFiles(workspaceRoot, r.runId);
  const c = r.coverage;
  console.log('\n══════════════ Resumo ══════════════');
  console.log(`Status:      ${r.status}${r.error ? ` — ${r.error}` : ''}`);
  if (r.status === 'SUSPECTED_COMPONENT_BUG') console.log('             ⚠ o componente pode ter defeito; o teste NÃO foi alterado.');
  console.log(`Iterações:   ${r.iterations} (reparos recusados pelo guardrail: ${r.rejectedRepairs}; modificação: ${(r.modificationRate * 100).toFixed(1)}%)`);
  console.log(`Cobertura:   statements ${c.statements}% · branches ${c.branches}% · functions ${c.functions}% · lines ${c.lines}%`);
  console.log(`LLM:         ${r.llm.calls} chamadas · ${r.llm.inputTokens} tokens de entrada · ${r.llm.outputTokens} de saída`);
  console.log('Agentes:');
  for (const [a, s] of Object.entries(r.agents)) {
    const ms = r.timings.perAgentMs[a.split('.')[0]!];
    console.log(`  ${(AGENT_LABELS[a] ?? a).padEnd(16)} ${String(s.steps).padStart(3)} passos · ${String(s.toolCalls).padStart(3)} ferramentas${ms !== undefined && !a.includes('.') ? ` · ${(ms / 1000).toFixed(1)} s` : ''}`);
  }
  if (r.timings.perAgentMs.generator !== undefined) console.log(`  (Gerador total: ${(r.timings.perAgentMs.generator / 1000).toFixed(1)} s)`);
  console.log(`Tempo total: ${(r.timings.totalMs / 1000).toFixed(1)} s`);
  console.log(`RunRecord:   ${files.record}`);
  console.log(`Trace:       ${files.trace}`);
  if (r.testFilePath) console.log(`Teste:       ${resolve(workspaceRoot, r.testFilePath)}`);
}

// ---- Comando ----

interface CliOptions {
  workspace: string;
  heal: boolean;
  elicit: boolean;
  verify: boolean;
  maxIter: number;
  maxSteps: number;
  model: string;
  provider: 'openai' | 'vscode';
  answers?: string;
}

const program = new Command()
  .name('reactest')
  .description('Gera testes Jest + React Testing Library para um componente React com uma pipeline de 6 agentes de IA (com self-healing).')
  .argument('<component>', 'componente (.tsx), relativo ao workspace')
  .option('--workspace <dir>', 'raiz do app React (onde está o package.json com Jest)', process.cwd())
  .option('--no-heal', 'desativa o self-healing (Executor ⇄ Reparador); baseline C1 com --no-elicit')
  .option('--no-elicit', 'desativa a elicitação de regras de negócio')
  .option('--no-verify', 'desativa o Verificador (mutation testing / smells)')
  .option('--max-iter <n>', 'máximo de iterações de reparo', int('--max-iter', 0), 3)
  .option('--max-steps <n>', 'máximo de passos (chamadas ao LLM) por agente', int('--max-steps', 1), 8)
  .option('--model <model>', 'modelo do LLM', DEFAULT_MODEL)
  .addOption(new Option('--provider <provider>', 'provedor do LLM').choices(['openai', 'vscode']).default('openai'))
  .option('--answers <arquivo.json>', 'respostas da elicitação (modo não interativo)')
  .action(async (component: string, opts: CliOptions) => {
    const workspaceRoot = resolve(opts.workspace);
    const componentPath = isAbsolute(component) ? relative(workspaceRoot, component).split('\\').join('/') : component;
    if (opts.provider === 'vscode') {
      throw new Error('O provider "vscode" (Copilot) só está disponível dentro da extensão do VS Code. Use --provider openai no CLI.');
    }
    const llm: LLMClient = new OpenAIClient({ model: opts.model });
    let asker: Asker | undefined;
    if (opts.elicit) asker = opts.answers ? answersFileAsker(opts.answers) : process.stdin.isTTY ? terminalAsker() : undefined;

    const config: PipelineConfig = {
      heal: opts.heal,
      elicit: opts.elicit,
      verify: opts.verify,
      maxIterations: opts.maxIter,
      maxAgentSteps: opts.maxSteps,
      model: opts.model,
      provider: opts.provider,
    };
    console.log(`ReacTest-Agent · ${componentPath} · ${opts.provider}/${opts.model} · heal=${config.heal} elicit=${config.elicit} verify=${config.verify} · max-iter=${config.maxIterations}`);

    const record = await runPipeline({ workspaceRoot, componentPath, config, llm, ...(asker ? { asker } : {}), onEvent });
    printSummary(record, workspaceRoot);
    process.exitCode = record.status === 'PASSED' ? 0 : 1;
  });

program.parseAsync().catch((err: unknown) => {
  console.error(`Erro: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
