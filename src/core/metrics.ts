import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { LLMClient, LLMRequest, LLMResponse, RunRecord } from './types';

export interface TagStats {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  ms: number;
}

type Clock = () => number;
const defaultClock: Clock = () => performance.now();
const emptyStats = (): TagStats => ({ calls: 0, inputTokens: 0, outputTokens: 0, ms: 0 });

/** Decorator de LLMClient que contabiliza chamadas, tokens e tempo por `tag` (RQ5). */
export class MeteredLLM implements LLMClient {
  private readonly stats = new Map<string, TagStats>();

  constructor(private readonly inner: LLMClient, private readonly now: Clock = defaultClock) {}

  get supportsJsonMode(): boolean {
    return this.inner.supportsJsonMode === true;
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    let s = this.stats.get(req.tag);
    if (!s) this.stats.set(req.tag, (s = emptyStats()));
    s.calls++;
    const start = this.now();
    try {
      const res = await this.inner.complete(req);
      s.inputTokens += res.inputTokens;
      s.outputTokens += res.outputTokens;
      return res;
    } finally {
      s.ms += this.now() - start;
    }
  }

  byTag(): Record<string, TagStats> {
    return Object.fromEntries([...this.stats].map(([tag, s]) => [tag, { ...s }]));
  }

  totals(): RunRecord['llm'] {
    const t = { calls: 0, inputTokens: 0, outputTokens: 0 };
    for (const s of this.stats.values()) {
      t.calls += s.calls;
      t.inputTokens += s.inputTokens;
      t.outputTokens += s.outputTokens;
    }
    return t;
  }
}

/** Mede o tempo de parede de cada agente (acumula se o mesmo nome rodar várias vezes). */
export class StageTimer {
  private readonly perAgent: Record<string, number> = {};
  private readonly startedAt: number;

  constructor(private readonly now: Clock = defaultClock) {
    this.startedAt = now();
  }

  async time<T>(agentName: string, fn: () => T | Promise<T>): Promise<T> {
    const start = this.now();
    try {
      return await fn();
    } finally {
      this.perAgent[agentName] = (this.perAgent[agentName] ?? 0) + (this.now() - start);
    }
  }

  timings(): RunRecord['timings'] {
    return { totalMs: this.now() - this.startedAt, perAgentMs: { ...this.perAgent } };
  }
}

export type AgentStats = RunRecord['agents'][string];

/** Acumula passos e chamadas de ferramenta por agente (RQ5). Soma se o mesmo agente rodar várias vezes. */
export class AgentMeter {
  private readonly stats = new Map<string, AgentStats>();

  record(agent: string, s: AgentStats): void {
    const cur = this.stats.get(agent) ?? { steps: 0, toolCalls: 0 };
    this.stats.set(agent, { steps: cur.steps + s.steps, toolCalls: cur.toolCalls + s.toolCalls });
  }

  agents(): RunRecord['agents'] {
    return Object.fromEntries([...this.stats].map(([agent, s]) => [agent, { ...s }]));
  }
}

/** runId = timestamp UTC seguro para nome de arquivo + sufixo aleatório. Ex.: 20261124T221530123Z-a1b2c3 */
export function newRunId(date: Date = new Date()): string {
  const ts = date.toISOString().replace(/[-:.]/g, '');
  return `${ts}-${randomBytes(3).toString('hex')}`;
}

/**
 * Grava `.reactest/runs/<runId>.json` no workspace e retorna o caminho do arquivo.
 * Se um AgentMeter for passado, `agents` é mesclado com o que ele registrou (números vêm do runtime).
 */
export async function writeRunRecord(workspaceRoot: string, record: RunRecord, meter?: AgentMeter): Promise<string> {
  if (meter) {
    const merged = new AgentMeter();
    for (const [agent, s] of Object.entries(record.agents ?? {})) merged.record(agent, s);
    for (const [agent, s] of Object.entries(meter.agents())) merged.record(agent, s);
    record = { ...record, agents: merged.agents() };
  }
  const dir = join(workspaceRoot, '.reactest', 'runs');
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${record.runId}.json`);
  await writeFile(file, JSON.stringify(record, null, 2) + '\n', 'utf8');
  return file;
}
