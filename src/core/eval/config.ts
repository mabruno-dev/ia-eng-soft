import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { canonicalPath } from '../tools/workspace';
import type { PipelineConfig } from '../types';

/** `eval/config.json`. Caminhos relativos são resolvidos a partir de `baseDir` (padrão: cwd). */
export const evalConfigSchema = z.object({
  workspace: z.string().min(1),
  components: z.array(z.string().min(1)).min(1),
  runsPerConfig: z.number().int().min(1).default(3),
  maxIterations: z.number().int().min(0).default(3),
  maxAgentSteps: z.number().int().min(1).default(8),
  model: z.string().min(1).default('gpt-4o'),
  answersFile: z.string().min(1).optional(),
});
export type EvalConfig = z.infer<typeof evalConfigSchema>;

export type ConfigLabel = 'C1' | 'C2';
export const CONFIG_LABELS: ConfigLabel[] = ['C1', 'C2'];

export const CONFIG_DESCRIPTIONS: Record<ConfigLabel, string> = {
  C1: 'baseline estilo v1 (heal=false, elicit=false; Verificador só mede)',
  C2: 'pipeline completa (heal=true, elicit=true com answersFile, verify=true)',
};

/** Flags de cada configuração comparada. O Verificador nunca altera o teste, então C1 o liga só para medir. */
export function pipelineConfigFor(label: ConfigLabel, cfg: EvalConfig, provider: PipelineConfig['provider']): PipelineConfig {
  const full = label === 'C2';
  return {
    heal: full,
    elicit: full,
    verify: true,
    maxIterations: cfg.maxIterations,
    maxAgentSteps: cfg.maxAgentSteps,
    model: cfg.model,
    provider,
  };
}

/** Lê e valida o JSON; `workspace` e `answersFile` voltam absolutos. */
export function loadEvalConfig(path: string, baseDir: string = process.cwd()): EvalConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Não foi possível ler a configuração da avaliação "${path}": ${err instanceof Error ? err.message : String(err)}`);
  }
  const parsed = evalConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Configuração da avaliação inválida (${path}): ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const cfg = parsed.data;
  return {
    ...cfg,
    // Forma real do disco (drive em maiúscula): cwd/rootDir do Jest — ver canonicalPath.
    workspace: canonicalPath(resolve(baseDir, cfg.workspace)),
    ...(cfg.answersFile ? { answersFile: resolve(baseDir, cfg.answersFile) } : {}),
  };
}
