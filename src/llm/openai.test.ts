import type { ChatCompletion, ChatCompletionCreateParamsNonStreaming } from 'openai/resources/chat/completions';
import { describe, expect, it } from 'vitest';
import type { LLMRequest } from '../core/types';
import { type ChatCompletionsApi, OpenAIClient } from './openai';

/** Cliente OpenAI mockado: registra os parâmetros e devolve completions roteirizadas (sem rede). */
function mockClient(replies: ChatCompletion['choices'][number]['message'][]) {
  const calls: ChatCompletionCreateParamsNonStreaming[] = [];
  const client: ChatCompletionsApi = {
    chat: {
      completions: {
        create: async (params) => {
          calls.push(params);
          const message = replies.shift();
          if (!message) throw new Error('sem resposta');
          return {
            id: 'x',
            object: 'chat.completion',
            created: 0,
            model: params.model,
            choices: [{ index: 0, finish_reason: 'tool_calls', logprobs: null, message }],
            usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
          };
        },
      },
    },
  };
  return { client, calls };
}

const msg = (content: string | null, tool_calls?: { id: string; name: string; arguments: string }[]) => ({
  role: 'assistant' as const,
  content,
  refusal: null,
  ...(tool_calls
    ? { tool_calls: tool_calls.map((t) => ({ id: t.id, type: 'function' as const, function: { name: t.name, arguments: t.arguments } })) }
    : {}),
});

describe('OpenAIClient (tool calling)', () => {
  it('mapeia tools, mensagens assistant com toolCalls e mensagens tool', async () => {
    const { client, calls } = mockClient([msg(null, [{ id: 'call_2', name: 'read_file', arguments: '{"path":"b.ts"}' }])]);
    const llm = new OpenAIClient({ model: 'gpt-test', client });
    const req: LLMRequest = {
      system: 'você é o agente',
      tag: 'context',
      temperature: 0,
      tools: [{ name: 'read_file', description: 'Lê um arquivo', parameters: { type: 'object', properties: { path: { type: 'string' } } } }],
      messages: [
        { role: 'user', content: 'teste X' },
        { role: 'assistant', content: '', toolCalls: [{ id: 'call_1', name: 'read_file', arguments: { path: 'a.ts' } }] },
        { role: 'tool', toolCallId: 'call_1', name: 'read_file', content: '"conteúdo"' },
      ],
    };

    const res = await llm.complete(req);

    expect(calls[0]).toEqual({
      model: 'gpt-test',
      temperature: 0,
      tools: [
        {
          type: 'function',
          function: { name: 'read_file', description: 'Lê um arquivo', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
        },
      ],
      messages: [
        { role: 'system', content: 'você é o agente' },
        { role: 'user', content: 'teste X' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: '"conteúdo"' },
      ],
    });
    expect(res).toEqual({
      text: '',
      toolCalls: [{ id: 'call_2', name: 'read_file', arguments: { path: 'b.ts' } }],
      inputTokens: 11,
      outputTokens: 7,
    });
  });

  it('argumentos JSON inválidos viram {} e o erro vai para o texto', async () => {
    const { client } = mockClient([msg('pensando', [{ id: 'c', name: 'run_jest', arguments: '{"file": ' }])]);
    const res = await new OpenAIClient({ model: 'm', client }).complete({ system: 's', tag: 't', messages: [] });
    expect(res.toolCalls).toEqual([{ id: 'c', name: 'run_jest', arguments: {} }]);
    expect(res.text).toMatch(/^pensando\n\[erro ao interpretar argumentos da ferramenta "run_jest" \(c\)/);
  });

  it('sem tools e sem toolCalls: requisição e resposta simples', async () => {
    const { client, calls } = mockClient([msg('{"ok":true}')]);
    const res = await new OpenAIClient({ model: 'm', client }).complete({
      system: 's',
      tag: 't',
      jsonMode: true,
      messages: [{ role: 'user', content: 'u' }],
    });
    expect(calls[0]).not.toHaveProperty('tools');
    expect(calls[0]!.response_format).toEqual({ type: 'json_object' });
    expect(res).toEqual({ text: '{"ok":true}', inputTokens: 11, outputTokens: 7 });
  });
});
