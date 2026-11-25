import * as vscode from 'vscode';
import type { Asker, AskerQuestion } from '../core/types';

/** Perguntas da Elicitação na UI: showInputBox com o "why" como prompt. Esc ou vazio = pular. */
export class VSCodeAsker implements Asker {
  async ask(q: AskerQuestion): Promise<string | undefined> {
    const a = await vscode.window.showInputBox({
      title: `ReacTest — regra de negócio (${q.id}): ${q.question}`,
      prompt: q.why,
      placeHolder: 'Sua resposta (Esc para pular)',
      ignoreFocusOut: true,
    });
    return a?.trim() || undefined;
  }
}
