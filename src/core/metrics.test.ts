import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeLLM } from '../llm/fake';
import { MeteredLLM, StageTimer, newRunId, writeRunRecord } from './metrics';
import type { LLMRequest, RunRecord } from './types';

const req = (tag: string): LLMRequest => ({ system: 's', messages: [{ role: 'user', content: 'u' }], tag });

/** Relógio controlado: cada leitura avança `step` ms. */
const steppingClock = (step: number) => {
  let t = 0;
  return () => (t += step);
};

describe('MeteredLLM', () => {
  it('soma chamadas e tokens por tag', async () => {
    const fake = new FakeLLM([
      { text: 'a', inputTokens: 10, outputTokens: 1 },
      { text: 'b', inputTokens: 20, outputTokens: 2 },
      { text: 'c', inputTokens: 5, outputTokens: 7 },
    ]);
    const llm = new MeteredLLM(fake, steppingClock(3));

    await llm.complete(req('generator'));
    await llm.complete(req('repairer'));
    await llm.complete(req('generator'));

    const byTag = llm.byTag();
    expect(byTag.generator).toEqual({ calls: 2, inputTokens: 15, outputTokens: 8, ms: 6 });
    expect(byTag.repairer).toEqual({ calls: 1, inputTokens: 20, outputTokens: 2, ms: 3 });
    expect(llm.totals()).toEqual({ calls: 3, inputTokens: 35, outputTokens: 10 });
    expect(fake.requests.map((r) => r.tag)).toEqual(['generator', 'repairer', 'generator']);
  });

  it('conta a chamada e o tempo mesmo quando o LLM falha', async () => {
    const llm = new MeteredLLM(new FakeLLM([]), steppingClock(1));
    await expect(llm.complete(req('elicitation'))).rejects.toThrow(/FakeLLM/);
    expect(llm.byTag().elicitation).toEqual({ calls: 1, inputTokens: 0, outputTokens: 0, ms: 1 });
  });
});

describe('StageTimer', () => {
  it('acumula o tempo por agente', async () => {
    const timer = new StageTimer(steppingClock(10));
    const out = await timer.time('context', () => 42);
    await timer.time('executor', async () => undefined);
    await timer.time('context', () => undefined);
    expect(out).toBe(42);
    expect(timer.timings().perAgentMs).toEqual({ context: 20, executor: 10 });
  });
});

describe('writeRunRecord', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('grava .reactest/runs/<runId>.json com JSON válido', async () => {
    dir = await mkdtemp(join(tmpdir(), 'reactest-'));
    const record: RunRecord = {
      runId: newRunId(new Date('2026-11-24T22:15:30.123Z')),
      component: 'src/components/LoginForm.tsx',
      config: { heal: true, elicit: false, verify: false, maxIterations: 3, model: 'gpt-4o-mini', provider: 'openai' },
      status: 'PASSED',
      iterations: 1,
      generated: { code: 'it("x", () => {})', lines: 1 },
      final: { code: 'it("x", () => {})', lines: 1 },
      modificationRate: 0,
      coverage: { statements: 90, branches: 80, functions: 100, lines: 90 },
      rejectedRepairs: 0,
      llm: { calls: 2, inputTokens: 100, outputTokens: 50 },
      timings: { totalMs: 1234, perAgentMs: { generator: 800 } },
    };

    const file = await writeRunRecord(dir, record);

    expect(record.runId).toMatch(/^20261124T221530123Z-[0-9a-f]{6}$/);
    expect(file).toBe(join(dir, '.reactest', 'runs', `${record.runId}.json`));
    expect(await readdir(join(dir, '.reactest', 'runs'))).toEqual([`${record.runId}.json`]);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(record);
  });
});
