// Único arquivo fora de src/extension autorizado a importar `vscode`.
import * as vscode from 'vscode';
import type { LLMClient, LLMRequest, LLMResponse } from '../core/types';

export interface VSCodeLmClientOptions {
  /** Filtra o modelo do Copilot por família (ex.: 'gpt-4o'). */
  family?: string;
  /** Token de cancelamento opcional, repassado ao sendRequest/countTokens. */
  cancellationToken?: vscode.CancellationToken;
}

export class VSCodeLmClient implements LLMClient {
  private model: vscode.LanguageModelChat | undefined;

  constructor(private readonly opts: VSCodeLmClientOptions = {}) {}

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

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const model = await this.getModel();

    // A API vscode.lm não tem papel "system": o system vai como primeira mensagem do usuário.
    const messages: vscode.LanguageModelChatMessage[] = [];
    if (req.system) messages.push(vscode.LanguageModelChatMessage.User(req.system));
    for (const m of req.messages) {
      messages.push(
        m.role === 'user'
          ? vscode.LanguageModelChatMessage.User(m.content)
          : vscode.LanguageModelChatMessage.Assistant(m.content),
      );
    }
    if (req.jsonMode) {
      // Não há response_format na API: reforçamos via instrução.
      messages.push(vscode.LanguageModelChatMessage.User('Responda apenas com um objeto JSON válido, sem texto adicional.'));
    }

    const token = this.opts.cancellationToken ?? new vscode.CancellationTokenSource().token;
    const options: vscode.LanguageModelChatRequestOptions =
      req.temperature !== undefined ? { modelOptions: { temperature: req.temperature } } : {};
    const response = await model.sendRequest(messages, options, token);

    let text = '';
    for await (const chunk of response.text) text += chunk;

    const inputCounts = await Promise.all(messages.map((m) => model.countTokens(m, token)));
    const inputTokens = inputCounts.reduce((a, b) => a + b, 0);
    const outputTokens = text ? await model.countTokens(text, token) : 0;

    return { text, inputTokens, outputTokens };
  }
}
