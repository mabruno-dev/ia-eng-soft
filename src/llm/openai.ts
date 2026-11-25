import OpenAI from 'openai';
import type { LLMClient, LLMRequest, LLMResponse } from '../core/types';

export interface OpenAIClientOptions {
  model: string;
  /** Padrão: process.env.OPENAI_API_KEY */
  apiKey?: string;
  /** Padrão: process.env.OPENAI_BASE_URL (opcional, p.ex. endpoints compatíveis com OpenAI) */
  baseURL?: string;
}

export class OpenAIClient implements LLMClient {
  private readonly client: OpenAI;
  private readonly model: string;

  constructor(opts: OpenAIClientOptions) {
    const apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('OPENAI_API_KEY não definida. Configure a variável de ambiente ou use o provider "vscode".');
    }
    const baseURL = opts.baseURL ?? process.env.OPENAI_BASE_URL;
    this.client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
    this.model = opts.model;
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const completion = await this.client.chat.completions.create({
      model: this.model,
      messages: [
        { role: 'system', content: req.system },
        ...req.messages.map((m) => ({ role: m.role, content: m.content })),
      ],
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.jsonMode ? { response_format: { type: 'json_object' as const } } : {}),
    });

    return {
      text: completion.choices[0]?.message?.content ?? '',
      inputTokens: completion.usage?.prompt_tokens ?? 0,
      outputTokens: completion.usage?.completion_tokens ?? 0,
    };
  }
}
