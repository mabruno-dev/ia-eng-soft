// Painel Webview "ReacTest Pipeline": linha do tempo dos 6 agentes, ferramentas ao vivo, perguntas da
// Elicitação, cartões da cura e resultado. Falhas da UI nunca derrubam a geração: vão para o OutputChannel.
import { randomBytes } from 'node:crypto';
import * as vscode from 'vscode';
import type { Asker, AskerQuestion } from '../core/types';
import { renderPanelHtml } from './panelHtml';
import type { PanelInbound, PanelMessage } from './panelModel';

type Log = (line: string) => void;
let log: Log = () => undefined;

export class PipelinePanel {
  private static current: PipelinePanel | undefined;
  /** Mensagens da execução atual: reenviadas se o painel for fechado e reaberto no meio do run. */
  private static history: PanelMessage[] = [];
  private static files: { test?: string; trace?: string } = {};

  private ready = false;
  private queue: PanelMessage[] = [];
  private pending: { id: string; resolve: (answer: string | undefined) => void; reject: (err: Error) => void } | undefined;

  private constructor(private readonly panel: vscode.WebviewPanel) {
    const nonce = randomBytes(16).toString('base64');
    panel.webview.html = renderPanelHtml({ nonce, cspSource: panel.webview.cspSource });
    panel.webview.onDidReceiveMessage((m: PanelInbound) => this.onMessage(m));
    panel.onDidDispose(() => {
      if (PipelinePanel.current === this) PipelinePanel.current = undefined;
      this.pending?.reject(new Error('painel fechado'));
      this.pending = undefined;
    });
  }

  /** Abre (ou revela) o painel ao lado do editor, sem roubar o foco. */
  static show(logger?: Log): PipelinePanel | undefined {
    if (logger) log = logger;
    return safe(() => {
      if (PipelinePanel.current) {
        PipelinePanel.current.panel.reveal(vscode.ViewColumn.Beside, true);
        return PipelinePanel.current;
      }
      const panel = vscode.window.createWebviewPanel(
        'reactest.pipeline',
        'ReacTest Pipeline',
        { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
        { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] },
      );
      const p = new PipelinePanel(panel);
      PipelinePanel.current = p;
      for (const m of PipelinePanel.history) p.post(m);
      return p;
    });
  }

  static get active(): PipelinePanel | undefined {
    return PipelinePanel.current;
  }

  /** Começa uma nova execução: zera o histórico e envia o cabeçalho. */
  static start(init: PanelMessage): void {
    PipelinePanel.history = [];
    PipelinePanel.files = {};
    PipelinePanel.broadcast(init);
  }

  /** Envia ao painel (se aberto) e guarda no histórico da execução. */
  static broadcast(m: PanelMessage): void {
    PipelinePanel.history.push(m);
    PipelinePanel.current?.post(m);
  }

  static setFiles(files: { test?: string; trace?: string }): void {
    PipelinePanel.files = files;
  }

  get visible(): boolean {
    return this.panel.visible;
  }

  /** Pergunta no painel; resolve com a resposta ou undefined (Pular / cancelamento). Rejeita se o painel fechar. */
  ask(q: AskerQuestion, token?: vscode.CancellationToken): Promise<string | undefined> {
    this.pending?.resolve(undefined);
    return new Promise((resolve, reject) => {
      this.pending = { id: q.id, resolve, reject };
      token?.onCancellationRequested(() => {
        if (this.pending?.id === q.id) {
          this.pending = undefined;
          resolve(undefined);
        }
      });
    });
  }

  private post(m: PanelMessage): void {
    if (!this.ready) {
      this.queue.push(m);
      return;
    }
    this.panel.webview.postMessage(m).then(undefined, (err: unknown) => log(`⚠ painel: ${String(err)}`));
  }

  private onMessage(m: PanelInbound): void {
    safe(() => {
      switch (m.type) {
        case 'ready': {
          this.ready = true;
          const q = this.queue;
          this.queue = [];
          for (const x of q) this.post(x);
          break;
        }
        case 'answer':
        case 'skip': {
          if (!this.pending || this.pending.id !== m.id) break;
          const { resolve } = this.pending;
          this.pending = undefined;
          resolve(m.type === 'answer' ? m.text.trim() || undefined : undefined);
          break;
        }
        case 'openTest':
          void openFile(PipelinePanel.files.test, 'teste');
          break;
        case 'openTrace':
          void openFile(PipelinePanel.files.trace, 'trace');
          break;
      }
    });
  }
}

async function openFile(path: string | undefined, what: string): Promise<void> {
  if (!path) {
    void vscode.window.showWarningMessage(`ReacTest: arquivo de ${what} indisponível nesta execução.`);
    return;
  }
  try {
    await vscode.window.showTextDocument(vscode.Uri.file(path), { viewColumn: vscode.ViewColumn.One, preview: false });
  } catch (err) {
    log(`⚠ painel: não consegui abrir ${path}: ${String(err)}`);
  }
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch (err) {
    log(`⚠ painel: ${err instanceof Error ? err.message : String(err)}`);
    return undefined;
  }
}

/**
 * Asker da Elicitação: responde no painel quando ele está visível; senão (ou se o painel fechar
 * no meio da pergunta) usa o showInputBox de sempre.
 */
export class PanelAsker implements Asker {
  constructor(
    private readonly fallback: Asker,
    private readonly token: vscode.CancellationToken,
    private readonly log: Log,
  ) {}

  async ask(q: AskerQuestion): Promise<string | undefined> {
    if (this.token.isCancellationRequested) return undefined;
    const panel = PipelinePanel.active;
    if (panel?.visible) {
      try {
        const answer = await panel.ask(q, this.token);
        PipelinePanel.broadcast({ kind: 'question_closed', id: q.id, ...(answer ? { answer } : {}), via: 'panel' });
        return answer;
      } catch (err) {
        this.log(`⚠ painel: ${err instanceof Error ? err.message : String(err)}; usando a caixa de entrada`);
      }
    }
    const answer = await this.fallback.ask(q);
    PipelinePanel.broadcast({ kind: 'question_closed', id: q.id, ...(answer ? { answer } : {}), via: 'inputBox' });
    return answer;
  }
}
