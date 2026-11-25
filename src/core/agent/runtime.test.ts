import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { FakeLLM } from '../../llm/fake';
import { AgentMeter, MeteredLLM } from '../metrics';
import type { ChatMessage } from '../types';
import { AgentOutputError, AgentStepLimitError, type AgentTool, extractJson, runAgent } from './runtime';
import { type TraceEntry, TraceWriter } from './trace';

const addTool: AgentTool<{ a: number; b: number }> = {
  spec: {
    name: 'add',
    description: 'Soma dois números',
    parameters: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] },
  },
  argsSchema: z.object({ a: z.number(), b: z.number() }),
  run: async ({ a, b }) => ({ sum: a + b }),
};

const boomTool: AgentTool<Record<string, never>> = {
  spec: { name: 'boom', description: 'Sempre falha', parameters: { type: 'object', properties: {} } },
  argsSchema: z.object({}),
  run: async () => {
    throw new Error('disco cheio');
  },
};

const finalSchema = z.object({ answer: z.number() });
const call = (id: string, name: string, args: Record<string, unknown>) => ({ toolCalls: [{ id, name, arguments: args }] });
const toolMsgs = (msgs: ChatMessage[]) => msgs.filter((m): m is Extract<ChatMessage, { role: 'tool' }> => m.role === 'tool');

describe('runAgent', () => {
  it('(a) chama uma ferramenta, recebe o resultado e responde o JSON final', async () => {
    const fake = new FakeLLM([call('c1', 'add', { a: 2, b: 3 }), '```json\n{"answer": 5}\n```']);
    const llm = new MeteredLLM(fake);
    const meter = new AgentMeter();

    const res = await runAgent({ name: 'calc', system: 'sys', input: 'quanto é 2+3?', tools: [addTool], llm, finalSchema, meter });

    expect(res).toEqual({ output: { answer: 5 }, steps: 2, toolCalls: 1 });
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests.every((r) => r.tag === 'calc')).toBe(true);
    expect(fake.requests[0]!.tools?.map((t) => t.name)).toEqual(['add']);
    expect(fake.requests[0]!.messages).toEqual([{ role: 'user', content: 'quanto é 2+3?' }]);
    const second = fake.requests[1]!.messages;
    expect(second[1]).toMatchObject({ role: 'assistant', toolCalls: [{ id: 'c1', name: 'add' }] });
    expect(second[2]).toEqual({ role: 'tool', toolCallId: 'c1', name: 'add', content: '{"sum":5}' });
    expect(llm.byTag().calc?.calls).toBe(2);
    expect(meter.agents()).toEqual({ calc: { steps: 2, toolCalls: 1 } });
  });

  it('(b) argumentos inválidos geram {"error"} e o LLM corrige na chamada seguinte', async () => {
    const fake = new FakeLLM([call('c1', 'add', { a: 'dois', b: 3 }), call('c2', 'add', { a: 2, b: 3 }), '{"answer": 5}']);

    const res = await runAgent({ name: 'calc', system: 's', input: 'i', tools: [addTool], llm: fake, finalSchema });

    expect(res).toEqual({ output: { answer: 5 }, steps: 3, toolCalls: 2 });
    const [bad, good] = toolMsgs(fake.requests[2]!.messages);
    const err = JSON.parse(bad!.content) as { error: string };
    expect(err.error).toMatch(/argumentos inválidos para "add"/);
    expect(good!.content).toBe('{"sum":5}');
  });

  it('ferramenta desconhecida também vira {"error"}', async () => {
    const fake = new FakeLLM([call('c1', 'mul', {}), '{"answer": 1}']);
    await runAgent({ name: 'calc', system: 's', input: 'i', tools: [addTool], llm: fake, finalSchema });
    expect(JSON.parse(toolMsgs(fake.requests[1]!.messages)[0]!.content)).toEqual({
      error: 'ferramenta desconhecida "mul". Disponíveis: add',
    });
  });

  it('(c) exceção da ferramenta não derruba o loop', async () => {
    const fake = new FakeLLM([call('c1', 'boom', {}), '{"answer": 0}']);

    const res = await runAgent({ name: 'x', system: 's', input: 'i', tools: [boomTool], llm: fake, finalSchema });

    expect(res.output).toEqual({ answer: 0 });
    expect(JSON.parse(toolMsgs(fake.requests[1]!.messages)[0]!.content)).toEqual({
      error: 'a ferramenta "boom" falhou: disco cheio',
    });
  });

  it('(d) JSON final inválido é reparado uma vez', async () => {
    const fake = new FakeLLM(['{"answer": "cinco"}', 'Claro! {"answer": 5}']);

    const res = await runAgent({ name: 'x', system: 's', input: 'i', tools: [], llm: fake, finalSchema });

    expect(res).toEqual({ output: { answer: 5 }, steps: 2, toolCalls: 0 });
    const repairMsg = fake.requests[1]!.messages.at(-1)!;
    expect(repairMsg.role).toBe('user');
    expect(repairMsg.content).toMatch(/não passou na validação/);
    expect(repairMsg.content).toMatch(/answer/);
  });

  it('(d) segunda resposta final inválida lança AgentOutputError (só uma tentativa de reparo)', async () => {
    const fake = new FakeLLM(['não sei', 'ainda não sei', '{"answer": 1}']);
    await expect(runAgent({ name: 'x', system: 's', input: 'i', tools: [], llm: fake, finalSchema })).rejects.toBeInstanceOf(
      AgentOutputError,
    );
    expect(fake.requests).toHaveLength(2);
  });

  it('(e) estouro de maxSteps lança AgentStepLimitError com o nome do agente', async () => {
    const fake = new FakeLLM(() => call('c', 'add', { a: 1, b: 1 }));
    const meter = new AgentMeter();

    const p = runAgent({ name: 'repairer', system: 's', input: 'i', tools: [addTool], llm: fake, finalSchema, maxSteps: 3, meter });

    await expect(p).rejects.toThrow(AgentStepLimitError);
    await expect(p).rejects.toMatchObject({ agent: 'repairer', maxSteps: 3 });
    expect(fake.requests).toHaveLength(3);
    expect(meter.agents()).toEqual({ repairer: { steps: 3, toolCalls: 3 } });
  });

  it('usa maxSteps = 8 por padrão', async () => {
    const fake = new FakeLLM(() => call('c', 'add', { a: 1, b: 1 }));
    await expect(runAgent({ name: 'x', system: 's', input: 'i', tools: [addTool], llm: fake, finalSchema })).rejects.toThrow(
      /limite de 8 passos/,
    );
    expect(fake.requests).toHaveLength(8);
  });

  it('trunca o resultado da ferramenta em 8000 caracteres', async () => {
    const big: AgentTool<Record<string, never>> = {
      spec: { name: 'big', description: '', parameters: { type: 'object' } },
      argsSchema: z.object({}),
      run: async () => 'x'.repeat(20_000),
    };
    const fake = new FakeLLM([call('c1', 'big', {}), '{"answer": 1}']);
    await runAgent({ name: 'x', system: 's', input: 'i', tools: [big], llm: fake, finalSchema });
    const content = toolMsgs(fake.requests[1]!.messages)[0]!.content;
    expect(content.startsWith('"xxx')).toBe(true);
    expect(content.length).toBeLessThan(8100);
    expect(content).toMatch(/\[\+\d+ caracteres\]$/);
  });

  describe('(f) trace', () => {
    let dir: string | undefined;
    afterEach(async () => {
      if (dir) await rm(dir, { recursive: true, force: true });
    });

    it('grava uma linha por passo em .reactest/runs/<runId>.trace.jsonl', async () => {
      dir = await mkdtemp(join(tmpdir(), 'reactest-trace-'));
      const trace = new TraceWriter(dir, 'run-1');
      const fake = new FakeLLM([
        { text: 'Vou somar.', ...call('c1', 'add', { a: 2, b: 3 }) },
        call('c2', 'boom', {}),
        '{"answer": "x"}',
        '{"answer": 5}',
      ]);
      let t = 0;
      await runAgent({
        name: 'calc',
        system: 's',
        input: 'i',
        tools: [addTool, boomTool],
        llm: fake,
        finalSchema,
        trace,
        now: () => (t += 5),
      });
      await trace.flush();

      expect(trace.file).toBe(join(dir, '.reactest', 'runs', 'run-1.trace.jsonl'));
      const lines = (await readFile(trace.file, 'utf8'))
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as TraceEntry);
      expect(lines.map((l) => [l.agent, l.step, l.kind])).toEqual([
        ['calc', 1, 'tool_calls'],
        ['calc', 2, 'tool_calls'],
        ['calc', 3, 'invalid_final'],
        ['calc', 4, 'final'],
      ]);
      expect(lines[0]).toMatchObject({
        text: 'Vou somar.',
        tools: [{ name: 'add', args: { a: 2, b: 3 }, ok: true, result: '{"sum":5}' }],
      });
      expect(lines[0]!.ms).toBeGreaterThan(0);
      expect(lines[0]!.tools![0]!.ms).toBeGreaterThan(0);
      expect(lines[1]!.tools![0]).toMatchObject({ name: 'boom', ok: false });
      expect(lines[1]!.tools![0]!.result).toMatch(/disco cheio/);
      expect(lines[2]!.error).toMatch(/answer/);
      expect(lines[3]!.text).toBe('{"answer": 5}');
      for (const l of lines) expect(typeof l.ts).toBe('string');
    });

    it('trunca o resumo do resultado em 500 caracteres', async () => {
      dir = await mkdtemp(join(tmpdir(), 'reactest-trace-'));
      const trace = new TraceWriter(dir, 'run-2');
      const big: AgentTool<Record<string, never>> = {
        spec: { name: 'big', description: '', parameters: { type: 'object' } },
        argsSchema: z.object({}),
        run: async () => 'y'.repeat(2000),
      };
      const fake = new FakeLLM([call('c1', 'big', {}), '{"answer": 1}']);
      await runAgent({ name: 'x', system: 's', input: 'i', tools: [big], llm: fake, finalSchema, trace });
      await trace.flush();
      const first = JSON.parse((await readFile(trace.file, 'utf8')).split('\n')[0]!) as TraceEntry;
      expect(first.tools![0]!.result.length).toBeLessThan(530);
    });
  });
});

describe('extractJson', () => {
  it('aceita bloco ```json, JSON puro e JSON cercado de texto', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('Resultado: {"a":{"b":2}} fim.')).toEqual({ a: { b: 2 } });
    expect(() => extractJson('nada aqui')).toThrow(/JSON válido/);
  });
});
