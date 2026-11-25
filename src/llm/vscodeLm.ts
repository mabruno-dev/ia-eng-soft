// Único arquivo fora de src/extension autorizado a importar `vscode`.
// Tool calling (LanguageModelChatTool / ToolCallPart / ToolResultPart) exige VS Code >= 1.95.
import * as vscode from 'vscode';
import { withEmptyResponseRetry } from '../core/llmRetry';
import type { LLMClient, LLMRequest, LLMResponse, ToolCall } from '../core/types';

export interface VSCodeLmClientOptions {
  /** Filtra o modelo do Copilot por família (ex.: 'gpt-4o'). */
  family?: string;
  /** Token de cancelamento opcional, repassado ao sendRequest/countTokens. */
  cancellationToken?: vscode.CancellationToken;
  /** Modelo já escolhido (ex.: o que passou no teste de tool calling); dispensa a seleção por família. */
  model?: vscode.LanguageModelChat;
}

export class VSCodeLmClient implements LLMClient {
  private model: vscode.LanguageModelChat | undefined;

  constructor(private readonly opts: VSCodeLmClientOptions = {}) {
    this.model = opts.model;
  }

  private async getModel(): Promise<vscode.LanguageModelChat> {
    if (this.model) return this.model;
    const selector: vscode.LanguageModelChatSelector = { vendor: 'copilot' };
    if (this.opts.family) selector.family = this.opts.family;
    const [model] = await vscode.lm.selectChatModels(selector);
    if (!model) {
      const qual = this.opts.family ? ` da família "${this.opts.family}"` : '';
      throw new Error(
        `Nenhum modelo de linguagem do Copilot${qual} está disponível. ` +
          'Verifique se o GitHub Copilot Chat está instalado e autenticado, ou use o provider "openai".',
      );
    }
    this.model = model;
    return model;
  }

  /** Resposta vazia do Copilot (sem texto e sem toolCalls): até 2 novas tentativas antes de lançar. */
  private readonly retrying = withEmptyResponseRetry({ complete: (req) => this.completeOnce(req) });

  complete(req: LLMRequest): Promise<LLMResponse> {
    return this.retrying.complete(req);
  }

  private async completeOnce(req: LLMRequest): Promise<LLMResponse> {
    const model = await this.getModel();
    const messages = toVSCodeMessages(req);

    const token = this.opts.cancellationToken ?? new vscode.CancellationTokenSource().token;
    const options: vscode.LanguageModelChatRequestOptions = {};
    if (req.temperature !== undefined) options.modelOptions = { temperature: req.temperature };
    if (req.tools?.length) {
      options.tools = req.tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.parameters }));
    }
    const response = await model.sendRequest(messages, options, token);

    let text = '';
    const toolCalls: ToolCall[] = [];
    for await (const part of response.stream) {
      if (part instanceof vscode.LanguageModelTextPart) {
        text += part.value;
      } else if (part instanceof vscode.LanguageModelToolCallPart) {
        toolCalls.push({ id: part.callId, name: part.name, arguments: { ...(part.input as Record<string, unknown>) } });
      }
    }

    const count = async (m: string | vscode.LanguageModelChatMessage): Promise<number> => {
      try {
        return await model.countTokens(m, token);
      } catch {
        // Alguns modelos não contam mensagens com partes de ferramenta: estimativa ~4 caracteres/token.
        return Math.ceil(JSON.stringify(m).length / 4);
      }
    };
    const inputTokens = (await Promise.all(messages.map(count))).reduce((a, b) => a + b, 0);
    const outputText = text + (toolCalls.length ? JSON.stringify(toolCalls) : '');
    const outputTokens = outputText ? await count(outputText) : 0;

    // countTokens é contagem local, não o uso cobrado pelo provedor.
    return { text, ...(toolCalls.length ? { toolCalls } : {}), inputTokens, outputTokens, tokensEstimated: true };
  }
}

/**
 * ChatMessage[] → mensagens da API vscode.lm.
 * - Não há papel "system": ele vai como primeira mensagem do usuário.
 * - toolCalls do assistente viram LanguageModelToolCallPart.
 * - Mensagens `tool` consecutivas viram LanguageModelToolResultPart dentro de UMA mensagem de usuário.
 */
function toVSCodeMessages(req: LLMRequest): vscode.LanguageModelChatMessage[] {
  const out: vscode.LanguageModelChatMessage[] = [];
  if (req.system) out.push(vscode.LanguageModelChatMessage.User(req.system));
  let pendingResults: vscode.LanguageModelToolResultPart[] = [];
  const flush = () => {
    if (pendingResults.length) out.push(vscode.LanguageModelChatMessage.User(pendingResults));
    pendingResults = [];
  };
  for (const m of req.messages) {
    if (m.role === 'tool') {
      pendingResults.push(
        new vscode.LanguageModelToolResultPart(m.toolCallId, [new vscode.LanguageModelTextPart(m.content)]),
      );
      continue;
    }
    flush();
    if (m.role === 'user') {
      out.push(vscode.LanguageModelChatMessage.User(m.content));
    } else if (m.toolCalls?.length) {
      const parts: (vscode.LanguageModelTextPart | vscode.LanguageModelToolCallPart)[] = [];
      if (m.content) parts.push(new vscode.LanguageModelTextPart(m.content));
      for (const c of m.toolCalls) parts.push(new vscode.LanguageModelToolCallPart(c.id, c.name, c.arguments));
      out.push(vscode.LanguageModelChatMessage.Assistant(parts));
    } else {
      out.push(vscode.LanguageModelChatMessage.Assistant(m.content));
    }
  }
  flush();
  if (req.jsonMode) {
    // Não há response_format na API: reforçamos via instrução.
    out.push(vscode.LanguageModelChatMessage.User('Responda apenas com um objeto JSON válido, sem texto adicional.'));
  }
  return out;
}

/**
 * Testa tool calling: pede ao modelo que chame a ferramenta `echo` com o texto "ok".
 * ok = o modelo devolveu um LanguageModelToolCallPart de `echo`.
 */
export async function probeToolCalling(
  model: vscode.LanguageModelChat,
  token: vscode.CancellationToken = new vscode.CancellationTokenSource().token,
): Promise<{ ok: boolean; error?: string; input?: unknown }> {
  try {
    const response = await model.sendRequest(
      [vscode.LanguageModelChatMessage.User('Chame a ferramenta "echo" com o texto "ok". Não responda com texto.')],
      {
        tools: [
          {
            name: 'echo',
            description: 'Devolve o texto recebido.',
            inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
          },
        ],
        toolMode: vscode.LanguageModelChatToolMode.Required,
      },
      token,
    );
    let text = '';
    for await (const part of response.stream) {
      if (part instanceof vscode.LanguageModelToolCallPart && part.name === 'echo') return { ok: true, input: part.input };
      if (part instanceof vscode.LanguageModelTextPart) text += part.value;
    }
    return { ok: false, error: `o modelo respondeu sem chamar a ferramenta${text ? `: "${text.slice(0, 120)}"` : ''}` };
  } catch (err) {
    const code = err instanceof vscode.LanguageModelError && err.code ? ` [${err.code}]` : '';
    return { ok: false, error: `${err instanceof Error ? err.message : String(err)}${code}` };
  }
}
