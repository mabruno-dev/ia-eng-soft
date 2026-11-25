import { z } from 'zod';
import type { AgentMeter } from '../metrics';
import type { ChatMessage, LLMClient, ToolCall, ToolSpec } from '../types';
import { TRACE_RESULT_MAX, type TraceToolCall, type TraceWriter, truncate } from './trace';

export const DEFAULT_MAX_STEPS = 8;
export const TOOL_RESULT_MAX = 8000;

export interface AgentTool<A = any> {
  spec: ToolSpec;
  argsSchema: z.ZodType<A>;
  run(args: A): Promise<unknown>; // resultado vira string JSON para o LLM (truncado em 8000 caracteres)
}

export interface RunAgentOptions<T> {
  name: string; // vira o `tag` das chamadas ao LLM
  system: string;
  input: string; // primeira mensagem do usuário
  tools: AgentTool[];
  /** Deve ser o MeteredLLM da execução, para contabilizar tokens/tempo com tag = name. */
  llm: LLMClient;
  maxSteps?: number; // padrão 8
  finalSchema: z.ZodType<T>; // a resposta FINAL (texto sem toolCalls) é JSON validado por este schema
  /** Quantas vezes devolver o erro de validação da resposta final ao LLM (padrão 1). */
  maxRepairs?: number;
  trace?: TraceWriter;
  /** Acumula { steps, toolCalls } por agente para o RunRecord. */
  meter?: AgentMeter;
  temperature?: number;
  /** Pede JSON estrito ao provider (só é enviado se `llm.supportsJsonMode`). */
  jsonMode?: boolean;
  now?: () => number;
}

export interface RunAgentResult<T> {
  output: T;
  steps: number;
  toolCalls: number;
}

export class AgentStepLimitError extends Error {
  constructor(readonly agent: string, readonly maxSteps: number) {
    super(`Agente "${agent}" excedeu o limite de ${maxSteps} passos sem produzir a resposta final.`);
    this.name = 'AgentStepLimitError';
  }
}

export class AgentOutputError extends Error {
  constructor(readonly agent: string, readonly validationError: string, readonly rawText: string) {
    super(`Agente "${agent}" produziu uma resposta final inválida mesmo após a tentativa de reparo: ${validationError}`);
    this.name = 'AgentOutputError';
  }
}

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Serializa o resultado de uma ferramenta para o LLM (string JSON, truncada). */
export function serializeToolResult(result: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(result) ?? 'null';
  } catch (err) {
    s = JSON.stringify({ error: `resultado não serializável: ${errMsg(err)}` });
  }
  return truncate(s, TOOL_RESULT_MAX);
}

/**
 * Extrai o JSON da resposta final: aceita bloco ```json ... ```, JSON puro, ou o primeiro
 * objeto/array delimitado por chaves/colchetes no texto.
 */
export function extractJson(text: string): unknown {
  const fence = /```(?:json)?\s*\n?([\s\S]*?)```/i.exec(text);
  const candidates = [fence?.[1], text];
  const first = text.search(/[{[]/);
  if (first >= 0) {
    const close = text[first] === '{' ? '}' : ']';
    const last = text.lastIndexOf(close);
    if (last > first) candidates.push(text.slice(first, last + 1));
  }
  const errors: { src: string; err: unknown }[] = [];
  for (const c of candidates) {
    if (c === undefined || !c.trim()) continue;
    try {
      return JSON.parse(c.trim());
    } catch (err) {
      errors.push({ src: c.trim(), err });
    }
  }
  // O erro mais informativo é o do candidato mais específico: bloco cercado, depois o trecho entre chaves.
  const best = (fence?.[1]?.trim() ? errors[0] : errors.at(-1)) ?? errors[0];
  throw new Error(`a resposta final não contém JSON válido (${best ? describeJsonError(best.err, best.src) : 'texto vazio'})`);
}

/** Mensagem do JSON.parse com linha, coluna e trecho em volta da posição do erro (quando houver posição). */
export function describeJsonError(err: unknown, src: string): string {
  const msg = errMsg(err);
  const m = /position (\d+)/.exec(msg);
  if (!m) return msg;
  const pos = Math.min(Number(m[1]), src.length);
  const before = src.slice(0, pos);
  const line = before.split('\n').length;
  const column = pos - before.lastIndexOf('\n');
  const snippet = `${src.slice(Math.max(0, pos - 40), pos)}⟪aqui⟫${src.slice(pos, pos + 40)}`.replace(/\s+/g, ' ');
  const where = /line \d+ column \d+/.test(msg) ? '' : ` — linha ${line}, coluna ${column}`;
  return `${msg}${where}; trecho: «${snippet}»`;
}

/** Valida a resposta final (assíncrono: o schema pode ter refinamentos async, ex.: typecheck em código). */
async function validateFinal<T>(text: string, schema: z.ZodType<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  let data: unknown;
  try {
    data = extractJson(text);
  } catch (err) {
    return { ok: false, error: errMsg(err) };
  }
  const parsed = await schema.safeParseAsync(data);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, error: z.prettifyError(parsed.error) };
}

/**
 * Loop de tool calling de um agente.
 * O LLM decide quais ferramentas chamar e quando parar; o código valida argumentos,
 * executa as ferramentas, valida a resposta final e impõe o limite de passos.
 */
export async function runAgent<T>(opts: RunAgentOptions<T>): Promise<RunAgentResult<T>> {
  const { name, system, llm, finalSchema, trace } = opts;
  const maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  const now = opts.now ?? (() => performance.now());
  const toolsByName = new Map(opts.tools.map((t) => [t.spec.name, t]));
  const specs = opts.tools.map((t) => t.spec);
  const messages: ChatMessage[] = [{ role: 'user', content: opts.input }];

  let steps = 0;
  let toolCalls = 0;
  const maxRepairs = opts.maxRepairs ?? 1;
  let repairs = 0;

  try {
    while (true) {
      if (steps >= maxSteps) throw new AgentStepLimitError(name, maxSteps);
      steps++;
      const stepStart = now();
      const res = await llm.complete({
        system,
        messages: [...messages],
        ...(specs.length ? { tools: specs } : {}),
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(opts.jsonMode && llm.supportsJsonMode ? { jsonMode: true } : {}),
        tag: name,
      });
      const llmMs = now() - stepStart;
      const text = res.text || undefined;
      const meta = { ...(res.model ? { model: res.model } : {}), ...(res.notices?.length ? { notices: res.notices } : {}) };

      if (res.toolCalls?.length) {
        messages.push({ role: 'assistant', content: res.text, toolCalls: res.toolCalls });
        const traced: TraceToolCall[] = [];
        for (const call of res.toolCalls) {
          toolCalls++;
          const t0 = now();
          const { ok, content } = await executeTool(toolsByName, call);
          messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content });
          traced.push({
            id: call.id,
            name: call.name,
            args: call.arguments,
            ok,
            result: truncate(content, TRACE_RESULT_MAX),
            ms: now() - t0,
          });
        }
        await trace?.write({ agent: name, step: steps, kind: 'tool_calls', text, tools: traced, ...meta, llmMs, ms: now() - stepStart });
        continue;
      }

      const v = await validateFinal(res.text, finalSchema);
      if (v.ok) {
        await trace?.write({ agent: name, step: steps, kind: 'final', text, ...meta, llmMs, ms: now() - stepStart });
        return { output: v.value, steps, toolCalls };
      }
      await trace?.write({ agent: name, step: steps, kind: 'invalid_final', text, error: v.error, ...meta, llmMs, ms: now() - stepStart });
      if (repairs >= maxRepairs) throw new AgentOutputError(name, v.error, res.text);
      repairs++;
      messages.push({ role: 'assistant', content: res.text });
      messages.push({
        role: 'user',
        content:
          `Sua resposta final não passou na validação:\n${v.error}\n\n` +
          'Responda novamente apenas com o objeto JSON final corrigido, no formato pedido.',
      });
    }
  } catch (err) {
    if (err instanceof AgentStepLimitError) {
      await trace?.write({ agent: name, step: steps, kind: 'step_limit', error: err.message, llmMs: 0, ms: 0 });
    }
    throw err;
  } finally {
    opts.meter?.record(name, { steps, toolCalls });
  }
}

/** Valida e executa uma chamada; erros nunca derrubam o loop: viram `{"error": "..."}` para o LLM. */
async function executeTool(
  tools: Map<string, AgentTool>,
  call: ToolCall,
): Promise<{ ok: boolean; content: string }> {
  const fail = (error: string) => ({ ok: false, content: JSON.stringify({ error }) });
  const tool = tools.get(call.name);
  if (!tool) {
    return fail(`ferramenta desconhecida "${call.name}". Disponíveis: ${[...tools.keys()].join(', ') || '(nenhuma)'}`);
  }
  const parsed = tool.argsSchema.safeParse(call.arguments);
  if (!parsed.success) {
    return fail(`argumentos inválidos para "${call.name}":\n${z.prettifyError(parsed.error)}`);
  }
  try {
    return { ok: true, content: serializeToolResult(await tool.run(parsed.data)) };
  } catch (err) {
    return fail(`a ferramenta "${call.name}" falhou: ${errMsg(err)}`);
  }
}

export { TraceWriter } from './trace';
