import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeLLM } from '../../llm/fake';
import type { RunPipelineOptions } from '../pipeline';
import type { RunRecord } from '../types';
import type { EvalConfig } from './config';
import { acquireTestFileLock } from '../runLock';
import { evaluate, matchesOnly } from './evaluate';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'reactest-eval-'));
  const ws = join(root, 'app');
  mkdirSync(join(ws, 'src'), { recursive: true });
  const answers = join(root, 'answers.json');
  writeFileSync(answers, JSON.stringify({ regra: 'resposta' }));
  const config: EvalConfig = {
    workspace: ws,
    components: ['src/A.tsx', 'src/B.tsx'],
    runsPerConfig: 2,
    maxIterations: 3,
    maxAgentSteps: 8,
    model: 'gpt-4o',
    answersFile: answers,
  };
  return { root, ws, config, outDir: join(root, 'out') };
}

/** Pipeline falso: grava o arquivo de teste (como a real) e devolve um RunRecord sintético. */
function fakePipeline(ws: string, calls: RunPipelineOptions[]) {
  return async (o: RunPipelineOptions): Promise<RunRecord> => {
    calls.push(o);
    const testFilePath = o.componentPath.replace(/\.tsx$/, '.test.tsx');
    expect(existsSync(join(ws, testFilePath))).toBe(false); // cada run parte limpo
    writeFileSync(join(ws, testFilePath), 'gerado');
    return {
      runId: `run${calls.length}`,
      component: o.componentPath,
      config: o.config,
      status: o.config.heal ? 'PASSED' : 'FAILED',
      iterations: o.config.heal ? 1 : 0,
      generated: { code: 'x', lines: 1 },
      final: { code: 'x', lines: 1 },
      modificationRate: 0,
      coverage: { statements: 1, branches: 1, functions: 1, lines: 1 },
      rejectedRepairs: 0,
      alignedToBehavior: 0,
      llm: { calls: 1, inputTokens: 1, outputTokens: 1 },
      agents: {},
      timings: { totalMs: 1, perAgentMs: {} },
      testFilePath,
    };
  };
}

describe('evaluate', () => {
  it('roda componente × C1/C2 × runs, limpa testes, preserva teste pré-existente e grava CSV/summary', async () => {
    const { ws, config, outDir } = setup();
    writeFileSync(join(ws, 'src/A.test.tsx'), 'teste do dev');
    const calls: RunPipelineOptions[] = [];
    const res = await evaluate({ config, outDir, llm: new FakeLLM(), provider: 'openai', runPipeline: fakePipeline(ws, calls), date: '2026-11-25' });

    expect(calls).toHaveLength(8);
    const c1 = calls.filter((c) => !c.config.heal);
    const c2 = calls.filter((c) => c.config.heal);
    expect(c1.every((c) => !c.config.elicit && c.config.verify && !c.asker)).toBe(true);
    expect(c2.every((c) => c.config.elicit && c.config.verify && c.asker)).toBe(true);
    expect(await c2[0]!.asker!.ask('Qual a regra?')).toBe('resposta');

    expect(readFileSync(join(ws, 'src/A.test.tsx'), 'utf8')).toBe('teste do dev');
    expect(existsSync(join(ws, 'src/B.test.tsx'))).toBe(false);
    expect(res.runs).toHaveLength(8);
    expect(readFileSync(res.csvPath, 'utf8').trimEnd().split('\n')).toHaveLength(9);
    expect(res.summary).toContain('| **Agregado** | C2 | 100,0% (4/4) |');
    expect(res.summary).toContain('| **Agregado** | C1 | 0,0% (0/4) |');
  });

  it('--resume reaproveita RunRecords; --only e --runs restringem', async () => {
    const { ws, config, outDir } = setup();
    const first: RunPipelineOptions[] = [];
    await evaluate({ config, outDir, llm: new FakeLLM(), provider: 'openai', runPipeline: fakePipeline(ws, first), only: ['A'], runs: 1 });
    expect(first.map((c) => c.componentPath)).toEqual(['src/A.tsx', 'src/A.tsx']);

    const second: RunPipelineOptions[] = [];
    const res = await evaluate({ config, outDir, llm: new FakeLLM(), provider: 'openai', runPipeline: fakePipeline(ws, second), runs: 1, resume: true });
    expect(second.map((c) => c.componentPath)).toEqual(['src/B.tsx', 'src/B.tsx']);
    expect(res.runs).toHaveLength(4);
  });

  it('--only sem correspondência é erro', async () => {
    const { ws, config, outDir } = setup();
    await expect(evaluate({ config, outDir, llm: new FakeLLM(), provider: 'openai', runPipeline: fakePipeline(ws, []), only: ['Z'] })).rejects.toThrow(/Nenhum componente/);
  });

  it('não apaga o arquivo de teste se outra execução estiver com a trava dele', async () => {
    const { ws, config, outDir } = setup();
    writeFileSync(join(ws, 'src/A.test.tsx'), 'em uso');
    const release = acquireTestFileLock(ws, 'src/A.test.tsx', 'cli-run');
    try {
      const calls: RunPipelineOptions[] = [];
      await expect(evaluate({ config, outDir, llm: new FakeLLM(), provider: 'openai', runPipeline: fakePipeline(ws, calls), only: ['A'] })).rejects.toThrow(
        /outra execução \(runId cli-run/,
      );
      expect(calls).toHaveLength(0);
      expect(readFileSync(join(ws, 'src/A.test.tsx'), 'utf8')).toBe('em uso');
    } finally {
      release();
    }
  });

  it('matchesOnly aceita nome (sem caixa) ou caminho', () => {
    expect(matchesOnly('src/components/LoginForm.tsx', ['loginform'])).toBe(true);
    expect(matchesOnly('src/components/LoginForm.tsx', ['src\\components\\LoginForm.tsx'])).toBe(true);
    expect(matchesOnly('src/components/LoginForm.tsx', ['Login'])).toBe(false);
  });
});
