// npm run eval -- [--config eval/config.json] [--only LoginForm] [--runs 1] [--resume [dir]] [--out dir]
// Roda C1 (baseline v1) e C2 (pipeline completa) para cada componente e grava eval/results/<data>/{runs.csv,summary.md}.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { Command, InvalidArgumentError } from 'commander';
import { componentName } from '../src/core/eval/aggregate';
import { loadEvalConfig } from '../src/core/eval/config';
import { evaluate, type EvalProgress, localDate } from '../src/core/eval/evaluate';
import { formatEvent } from '../src/core/progressFormat';
import { OpenAIClient } from '../src/llm/openai';

const RESULTS_DIR = resolve('eval', 'results');

const int = (name: string) => (v: string) => {
  const n = Number.parseInt(v, 10);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError(`${name} deve ser um inteiro >= 1`);
  return n;
};
const collect = (v: string, prev: string[] = []) => [...prev, ...v.split(',').map((s) => s.trim()).filter(Boolean)];

function latestResultsDir(): string | undefined {
  if (!existsSync(RESULTS_DIR)) return undefined;
  const last = readdirSync(RESULTS_DIR)
    .filter((d) => statSync(join(RESULTS_DIR, d)).isDirectory())
    .sort()
    .at(-1);
  return last ? join(RESULTS_DIR, last) : undefined;
}

function onProgress(e: EvalProgress): void {
  const tag = 'index' in e ? `[${e.index}/${e.total}] ${componentName(e.component)} ${e.config} #${e.repetition}` : '';
  switch (e.type) {
    case 'run-start':
      console.log(`\n━━━━ ${tag} ━━━━`);
      break;
    case 'run-end':
      console.log(`→ ${tag}: ${e.record.status} · ${e.record.iterations} iteração(ões) · branches ${e.record.coverage.branches}% · ${(e.record.timings.totalMs / 1000).toFixed(1)} s`);
      break;
    case 'run-reused':
      console.log(`↺ ${tag}: reaproveitado (${e.record.status})`);
      break;
    case 'backup':
      console.log(`Teste pré-existente guardado: ${e.testFile} → ${e.backup}`);
      break;
    case 'restore':
      console.log(`Teste pré-existente restaurado: ${e.testFile}`);
      break;
  }
}

interface Opts { config: string; only?: string[]; runs?: number; resume?: string | boolean; out?: string; quiet?: boolean }

const program = new Command()
  .name('eval')
  .description('Avaliação C1 (baseline v1) × C2 (pipeline completa) a partir dos RunRecords.')
  .option('--config <arquivo>', 'configuração da avaliação', 'eval/config.json')
  .option('--only <Componente>', 'roda só estes componentes (nome ou caminho; repetível ou separado por vírgula)', collect)
  .option('--runs <n>', 'runs por configuração (sobrescreve runsPerConfig)', int('--runs'))
  .option('--resume [dir]', 'reaproveita RunRecords já gravados (padrão: o diretório de resultados mais recente)')
  .option('--out <dir>', 'diretório de resultados (padrão: eval/results/<data>)')
  .option('--quiet', 'não mostra o passo a passo dos agentes')
  .action(async (opts: Opts) => {
    const config = loadEvalConfig(opts.config);
    if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY não definida.');
    const outDir = resolve(
      opts.out ??
        (typeof opts.resume === 'string' ? opts.resume : undefined) ??
        (opts.resume ? latestResultsDir() : undefined) ??
        join(RESULTS_DIR, localDate()),
    );
    console.log(`Avaliação · ${relative(process.cwd(), config.workspace) || '.'} · ${config.model} · ${config.components.length} componentes · resultados em ${relative(process.cwd(), outDir)}`);

    const result = await evaluate({
      config,
      outDir,
      llm: () => new OpenAIClient({ model: config.model }),
      provider: 'openai',
      ...(opts.only ? { only: opts.only } : {}),
      ...(opts.runs ? { runs: opts.runs } : {}),
      resume: !!opts.resume,
      onProgress,
      ...(opts.quiet ? {} : { onEvent: (e) => formatEvent(e).forEach((l) => console.log(`  ${l}`)) }),
    });
    console.log(`\nRuns: ${result.runs.length}`);
    console.log(`CSV:     ${result.csvPath}`);
    console.log(`Resumo:  ${result.summaryPath}`);
  });

program.parseAsync().catch((err: unknown) => {
  console.error(`Erro: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
});
