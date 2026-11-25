// Avaliação em lote: componente × configuração (C1/C2) × repetição, concorrência 1.
// Lê só RunRecords; grava runs.csv e summary.md em <outDir>. Não importa `vscode`.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { answersFileAsker } from '../askers';
import { defaultTestFilePath } from '../agents/context';
import { type PipelineEvent, runPipeline as defaultRunPipeline, type RunPipelineOptions } from '../pipeline';
import type { Asker, LLMClient, PipelineConfig, RunRecord } from '../types';
import { componentName, type EvalRun, renderSummary, type SummaryMeta, toCsv } from './aggregate';
import { currentLock, describeLock } from '../runLock';
import { CONFIG_LABELS, type ConfigLabel, type EvalConfig, pipelineConfigFor } from './config';

export type EvalProgress =
  | { type: 'run-start'; component: string; config: ConfigLabel; repetition: number; index: number; total: number }
  | { type: 'run-end'; component: string; config: ConfigLabel; repetition: number; index: number; total: number; record: RunRecord }
  | { type: 'run-reused'; component: string; config: ConfigLabel; repetition: number; index: number; total: number; record: RunRecord }
  | { type: 'backup'; component: string; testFile: string; backup: string }
  | { type: 'restore'; component: string; testFile: string };

export interface EvaluateOptions {
  /** Configuração já resolvida (`workspace`/`answersFile` absolutos — ver loadEvalConfig). */
  config: EvalConfig;
  /** Diretório de resultados, ex.: eval/results/2026-11-25. */
  outDir: string;
  /** LLM (ou fábrica, chamada a cada run). */
  llm: LLMClient | (() => LLMClient);
  provider: PipelineConfig['provider'];
  /** Restringe a componentes (nome, ex.: "LoginForm", ou caminho). */
  only?: string[];
  /** Sobrescreve config.runsPerConfig. */
  runs?: number;
  /** Reaproveita RunRecords já existentes em <outDir>/records. */
  resume?: boolean;
  /** Configurações a rodar (padrão: C1 e C2). */
  configs?: ConfigLabel[];
  onProgress?: (e: EvalProgress) => void;
  onEvent?: (e: PipelineEvent) => void;
  /** Injetável (testes). */
  runPipeline?: (o: RunPipelineOptions) => Promise<RunRecord>;
  /** Data exibida no summary (padrão: hoje). */
  date?: string;
}

export interface EvaluateResult {
  runs: EvalRun[];
  csvPath: string;
  summaryPath: string;
  summary: string;
}

/** Arquivo salvo por run em <outDir>/records. */
interface StoredRun extends EvalRun { component: string }

const slug = (component: string) => component.replace(/\.[^./\\]+$/, '').replace(/[\\/]+/g, '_').replace(/[^A-Za-z0-9_-]/g, '-');
export const recordFileName = (component: string, config: ConfigLabel, repetition: number) => `${slug(component)}__${config}__r${repetition}.json`;

export function localDate(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function matchesOnly(component: string, only: string[] | undefined): boolean {
  if (!only?.length) return true;
  const norm = component.replace(/\\/g, '/');
  return only.some((o) => {
    const q = o.replace(/\\/g, '/');
    return q === norm || q.toLowerCase() === componentName(component).toLowerCase();
  });
}

/** Lê todos os runs gravados em <outDir>/records (arquivos ilegíveis são ignorados). */
export function loadStoredRuns(outDir: string): EvalRun[] {
  const dir = join(outDir, 'records');
  if (!existsSync(dir)) return [];
  const out: EvalRun[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.json')).sort()) {
    try {
      const s = JSON.parse(readFileSync(join(dir, f), 'utf8')) as StoredRun;
      if (s?.record?.runId && CONFIG_LABELS.includes(s.config)) out.push({ config: s.config, repetition: s.repetition, record: s.record });
    } catch {
      /* ignora */
    }
  }
  return out;
}

export async function evaluate(opts: EvaluateOptions): Promise<EvaluateResult> {
  const { config, outDir } = opts;
  const runPipeline = opts.runPipeline ?? defaultRunPipeline;
  const runsPerConfig = opts.runs ?? config.runsPerConfig;
  const configs = opts.configs ?? CONFIG_LABELS;
  const components = config.components.filter((c) => matchesOnly(c, opts.only));
  if (opts.only?.length && components.length === 0) {
    throw new Error(`Nenhum componente da configuração corresponde a --only ${opts.only.join(', ')}. Disponíveis: ${config.components.map(componentName).join(', ')}`);
  }
  const recordsDir = join(outDir, 'records');
  const backupsDir = join(outDir, 'backups');
  mkdirSync(recordsDir, { recursive: true });

  const total = components.length * configs.length * runsPerConfig;
  let index = 0;

  for (const component of components) {
    const testRel = defaultTestFilePath(component);
    const testAbs = join(config.workspace, testRel);
    // Nunca apagar/mexer no arquivo de teste enquanto outra execução (CLI/extensão) o usa.
    const owner = currentLock(config.workspace, testRel.replace(/\\/g, '/'));
    if (owner) throw new Error(`Avaliação interrompida antes de ${componentName(component)}: ${describeLock(owner)}.`);
    const backup = join(backupsDir, `${slug(component)}.test-original${testRel.match(/\.[^.]+$/)?.[0] ?? ''}`);
    // Teste pré-existente (do dev ou de uma execução anterior): guardado e restaurado ao fim do componente.
    // Se já existe backup (execução interrompida), o arquivo atual é gerado e o backup é preservado.
    if (existsSync(testAbs) && !existsSync(backup)) {
      mkdirSync(backupsDir, { recursive: true });
      copyFileSync(testAbs, backup);
      opts.onProgress?.({ type: 'backup', component, testFile: testAbs, backup });
    }
    try {
      for (const label of configs) {
        for (let repetition = 1; repetition <= runsPerConfig; repetition++) {
          index++;
          const file = join(recordsDir, recordFileName(component, label, repetition));
          if (opts.resume && existsSync(file)) {
            const stored = loadStoredRuns(outDir).find((r) => r.record.component === component && r.config === label && r.repetition === repetition);
            if (stored) {
              opts.onProgress?.({ type: 'run-reused', component, config: label, repetition, index, total, record: stored.record });
              continue;
            }
          }
          opts.onProgress?.({ type: 'run-start', component, config: label, repetition, index, total });
          const busy = currentLock(config.workspace, testRel.replace(/\\/g, '/'));
          if (busy) throw new Error(`Avaliação interrompida antes de ${componentName(component)} ${label} #${repetition}: ${describeLock(busy)}.`);
          rmSync(testAbs, { force: true }); // cada run parte do zero
          const pipelineConfig = pipelineConfigFor(label, config, opts.provider);
          let asker: Asker | undefined;
          if (pipelineConfig.elicit && config.answersFile) asker = answersFileAsker(config.answersFile);
          const record = await runPipeline({
            workspaceRoot: config.workspace,
            componentPath: component,
            config: pipelineConfig,
            llm: typeof opts.llm === 'function' ? opts.llm() : opts.llm,
            ...(asker ? { asker } : {}),
            ...(opts.onEvent ? { onEvent: opts.onEvent } : {}),
          });
          const stored: StoredRun = { component, config: label, repetition, record };
          writeFileSync(file, JSON.stringify(stored, null, 2) + '\n', 'utf8');
          rmSync(join(config.workspace, record.testFilePath ?? testRel), { force: true });
          opts.onProgress?.({ type: 'run-end', component, config: label, repetition, index, total, record });
        }
      }
    } finally {
      rmSync(testAbs, { force: true });
      if (existsSync(backup)) {
        mkdirSync(dirname(testAbs), { recursive: true });
        copyFileSync(backup, testAbs);
        rmSync(backup, { force: true });
        opts.onProgress?.({ type: 'restore', component, testFile: testAbs });
      }
    }
  }

  // O resumo considera todos os runs gravados no diretório para os componentes da configuração
  // (permite --only em várias etapas e --resume).
  const runs = loadStoredRuns(outDir).filter((r) => config.components.includes(r.record.component));
  return writeResults(outDir, runs, {
    date: opts.date ?? localDate(),
    workspace: config.workspace,
    model: config.model,
    runsPerConfig,
    maxIterations: config.maxIterations,
    maxAgentSteps: config.maxAgentSteps,
    ...(config.answersFile ? { answersFile: config.answersFile } : {}),
    components: config.components,
  });
}

/** Grava runs.csv e summary.md a partir de runs já carregados. */
export function writeResults(outDir: string, runs: EvalRun[], meta: SummaryMeta): EvaluateResult {
  mkdirSync(outDir, { recursive: true });
  const csvPath = join(outDir, 'runs.csv');
  const summaryPath = join(outDir, 'summary.md');
  const summary = renderSummary(runs, meta);
  writeFileSync(csvPath, toCsv(runs), 'utf8');
  writeFileSync(summaryPath, summary, 'utf8');
  return { runs, csvPath, summaryPath, summary };
}
