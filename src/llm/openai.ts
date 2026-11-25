import OpenAI from 'openai';
import type {
  ChatCompletion,
  ChatCompletionCreateParamsNonStreaming,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';
import type { ChatMessage, LLMClient, LLMRequest, LLMResponse, ToolCall } from '../core/types';

/** Subconjunto do SDK usado aqui — permite injetar um cliente mockado nos testes. */
export interface ChatCompletionsApi {
  chat: { completions: { create(params: ChatCompletionCreateParamsNonStreaming): Promise<ChatCompletion> } };
}

export interface OpenAIClientOptions {
  model: string;
  /** Padrão: process.env.OPENAI_API_KEY */
  apiKey?: string;
  /** Padrão: process.env.OPENAI_BASE_URL (opcional, p.ex. endpoints compatíveis com OpenAI) */
  baseURL?: string;
  /** Cliente já construído (testes). Quando presente, apiKey/baseURL são ignorados. */
  client?: ChatCompletionsApi;
}

function toOpenAIMessage(m: ChatMessage): ChatCompletionMessageParam {
  if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return {
      role: 'assistant',
      content: m.content || null,
      tool_calls: m.toolCalls.map((c) => ({
        id: c.id,
        type: 'function' as const,
        function: { name: c.name, arguments: JSON.stringify(c.arguments) },
      })),
    };
  }
  return { role: m.role, content: m.content };
}

/** LLMRequest → parâmetros do chat.completions.create. */
export function toOpenAIParams(model: string, req: LLMRequest): ChatCompletionCreateParamsNonStreaming {
  return {
    model,
    messages: [{ role: 'system', content: req.system }, ...req.messages.map(toOpenAIMessage)],
    ...(req.tools?.length
      ? {
          tools: req.tools.map((t) => ({
            type: 'function' as const,
            function: { name: t.name, description: t.description, parameters: t.parameters },
          })),
        }
      : {}),
    ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    ...(req.jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
  };
}

/** ChatCompletion → LLMResponse. Argumentos inválidos viram `{}` e o erro é anexado ao texto. */
export function fromOpenAICompletion(completion: ChatCompletion): LLMResponse {
  const msg = completion.choices[0]?.message;
  let text = msg?.content ?? '';
  const toolCalls: ToolCall[] = [];
  for (const tc of msg?.tool_calls ?? []) {
    if (tc.type !== 'function') continue;
    let args: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(tc.function.arguments || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        args = parsed as Record<string, unknown>;
      } else {
        throw new Error('argumentos não são um objeto JSON');
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      text += `${text ? '\n' : ''}[erro ao interpretar argumentos da ferramenta "${tc.function.name}" (${tc.id}): ${reason}]`;
    }
    toolCalls.push({ id: tc.id, name: tc.function.name, arguments: args });
  }
  return {
    text,
    ...(toolCalls.length ? { toolCalls } : {}),
    inputTokens: completion.usage?.prompt_tokens ?? 0,
    outputTokens: completion.usage?.completion_tokens ?? 0,
  };
}

export class OpenAIClient implements LLMClient {
  private readonly client: ChatCompletionsApi;
  private readonly model: string;
  readonly supportsJsonMode = true;

  constructor(opts: OpenAIClientOptions) {
    this.model = opts.model;
    if (opts.client) {
      this.client = opts.client;
      return;
    }
    const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY não definida. Configure a variável de ambiente ou use o provider "vscode".');
    }
    const baseURL = opts.baseURL ?? process.env.OPENAI_BASE_URL;
    this.client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const completion = await this.client.chat.completions.create(toOpenAIParams(this.model, req));
    return fromOpenAICompletion(completion);
  }
}
