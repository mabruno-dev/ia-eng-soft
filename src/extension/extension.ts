import * as vscode from 'vscode';

// Esqueleto da extensão: o comando será ligado à pipeline nas próximas etapas.
export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('reactest.generate', () => {
      void vscode.window.showInformationMessage('ReacTest-Agent: pipeline ainda não implementada.');
    }),
  );
}

export function deactivate(): void {}
