import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import * as vscode from 'vscode';
import { type PipelineEvent, runFiles, runPipeline } from '../core/pipeline';
import { formatEvent } from '../core/progressFormat';
import { componentName, renderReport } from '../core/report';
import type { LLMClient, LLMRequest, PipelineConfig, RunRecord } from '../core/types';
import { VSCodeAsker } from './vscodeAsker';
import { OpenAIClient } from '../llm/openai';
import { VSCodeLmClient } from '../llm/vscodeLm';

const SECRET_KEY = 'reactest.openaiApiKey';
const DEFAULT_OPENAI_MODEL = 'gpt-4o';

let output: vscode.OutputChannel;
let running = false;

export function activate(context: vscode.ExtensionContext): void {
  output = vscode.window.createOutputChannel('ReacTest-Agent');
  context.subscriptions.push(
    output,
    vscode.commands.registerCommand('reactest.generate', (uri?: vscode.Uri) => generate(context, uri)),
    vscode.commands.registerCommand('reactest.setOpenAIKey', () => setOpenAIKey(context)),
    vscode.commands.registerCommand('reactest.showOutput', () => output.show(true)),
  );
}

export function deactivate(): void {}

// ---------------------------------------------------------------------------

async function setOpenAIKey(context: vscode.ExtensionContext): Promise<boolean> {
  const key = await vscode.window.showInputBox({
    title: 'ReacTest: chave da API OpenAI',
    prompt: 'A chave fica no SecretStorage do VS Code (não é gravada em arquivos). Deixe vazio para remover.',
    password: true,
    ignoreFocusOut: true,
    placeHolder: 'sk-...',
  });
  if (key === undefined) return false;
  if (!key.trim()) {
    await context.secrets.delete(SECRET_KEY);
    void vscode.window.showInformationMessage('ReacTest: chave OpenAI removida.');
    return false;
  }
  await context.secrets.store(SECRET_KEY, key.trim());
  void vscode.window.showInformationMessage('ReacTest: chave OpenAI salva.');
  return true;
}

/** Diretório mais próximo do arquivo (até a pasta do workspace) que tenha package.json. */
function findProjectRoot(file: vscode.Uri): string | undefined {
  const folder = vscode.workspace.getWorkspaceFolder(file)?.uri.fsPath;
  let dir = dirname(file.fsPath);
  while (true) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir || (folder && relative(folder, dir) === '')) return folder && existsSync(join(folder, 'package.json')) ? folder : undefined;
    dir = parent;
  }
}

/** Interrompe a execução quando o usuário cancela (verificado antes de cada chamada ao LLM). */
function cancellable(inner: LLMClient, token: vscode.CancellationToken): LLMClient {
  return {
    complete: (req: LLMRequest) => {
      if (token.isCancellationRequested) return Promise.reject(new Error('Execução cancelada pelo usuário.'));
      return inner.complete(req);
    },
  };
}

async function createLLM(context: vscode.ExtensionContext, provider: PipelineConfig['provider'], model: string, token: vscode.CancellationToken): Promise<LLMClient | undefined> {
  if (provider === 'vscode') {
    return new VSCodeLmClient({ ...(model ? { family: model } : {}), cancellationToken: token });
  }
  let apiKey = (await context.secrets.get(SECRET_KEY)) ?? process.env.OPENAI_API_KEY;
  if (!apiKey) {
    const choice = await vscode.window.showWarningMessage('ReacTest: nenhuma chave OpenAI definida.', 'Definir chave', 'Usar Copilot nesta execução');
    if (choice === 'Usar Copilot nesta execução') return new VSCodeLmClient({ cancellationToken: token });
    if (choice !== 'Definir chave' || !(await setOpenAIKey(context))) return undefined;
    apiKey = await context.secrets.get(SECRET_KEY);
  }
  return new OpenAIClient({ model: model || DEFAULT_OPENAI_MODEL, ...(apiKey ? { apiKey } : {}) });
}


const STATUS_MSG: Record<RunRecord['status'], string> = {
  PASSED: 'a suíte gerada passou',
  FAILED: 'a suíte não passou dentro do limite de iterações',
  SUSPECTED_COMPONENT_BUG: 'possível defeito no componente',
  ERROR: 'a execução falhou',
};

async function generate(context: vscode.ExtensionContext, uri?: vscode.Uri): Promise<void> {
  const target = uri ?? vscode.window.activeTextEditor?.document.uri;
  if (!target || !target.fsPath.endsWith('.tsx')) {
    void vscode.window.showErrorMessage('ReacTest: abra ou selecione um componente React (.tsx).');
    return;
  }
  if (running) {
    void vscode.window.showWarningMessage('ReacTest: já há uma geração em andamento.');
    return;
  }
  const workspaceRoot = findProjectRoot(target);
  if (!workspaceRoot) {
    void vscode.window.showErrorMessage('ReacTest: não encontrei o package.json do projeto deste componente.');
    return;
  }
  const componentPath = relative(workspaceRoot, target.fsPath).split('\\').join('/');

  const cfg = vscode.workspace.getConfiguration('reactest', target);
  const provider = cfg.get<PipelineConfig['provider']>('provider', 'vscode');
  const model = cfg.get<string>('model', '');
  const config: PipelineConfig = {
    heal: cfg.get<number>('maxIterations', 3) > 0,
    elicit: cfg.get<boolean>('enableElicitation', true),
    verify: cfg.get<boolean>('enableVerifier', true),
    maxIterations: cfg.get<number>('maxIterations', 3),
    maxAgentSteps: cfg.get<number>('maxAgentSteps', 8),
    model: model || (provider === 'openai' ? DEFAULT_OPENAI_MODEL : ''),
    provider,
  };

  running = true;
  try {
    const record = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `ReacTest: ${componentPath}`, cancellable: true },
      async (progress, token) => {
        const llm = await createLLM(context, provider, model, token);
        if (!llm) return undefined;
        output.show(true);
        output.appendLine(`\n══════ ${new Date().toLocaleString('pt-BR')} · ${componentPath} · ${provider}${config.model ? `/${config.model}` : ''} ══════`);
        output.appendLine(`heal=${config.heal} elicit=${config.elicit} verify=${config.verify} maxIterations=${config.maxIterations} maxAgentSteps=${config.maxAgentSteps}`);
        const onEvent = (e: PipelineEvent) => {
          for (const line of formatEvent(e, { reasoningChars: 1200 })) output.appendLine(line);
          if (e.type === 'stage-start' && e.stage !== 'record') progress.report({ message: e.label });
          else if (e.type === 'agent-step' && e.entry.tools?.length) progress.report({ message: `${e.label}: ${e.entry.tools.map((t) => t.name).join(', ')}` });
          else if (e.type === 'iteration') progress.report({ message: `iteração ${e.iteration.iteration}: ${e.iteration.repairStatus}` });
        };
        return runPipeline({ workspaceRoot, componentPath, config, llm: cancellable(llm, token), ...(config.elicit ? { asker: new VSCodeAsker() } : {}), onEvent });
      },
    );
    if (record) await finish(workspaceRoot, record);
  } catch (err) {
    // runPipeline não lança; isto cobre falhas da própria UI.
    void vscode.window.showErrorMessage(`ReacTest: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    running = false;
  }
}

async function finish(workspaceRoot: string, record: RunRecord): Promise<void> {
  const files = runFiles(workspaceRoot, record.runId);
  const reportPath = join(workspaceRoot, '.reactest', 'reports', `${componentName(record)}.md`);
  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, renderReport(record), 'utf8');

  output.appendLine('');
  output.appendLine(`Status: ${record.status}${record.error ? ` — ${record.error}` : ''} · iterações: ${record.iterations} · branches: ${record.coverage.branches}%`);
  output.appendLine(`LLM: ${record.llm.calls} chamadas, ${record.llm.inputTokens}+${record.llm.outputTokens} tokens · ${(record.timings.totalMs / 1000).toFixed(1)} s`);
  output.appendLine(`RunRecord: ${files.record}`);
  output.appendLine(`Trace: ${files.trace}`);
  output.appendLine(`Relatório: ${reportPath}`);

  const testAbs = record.testFilePath ? join(workspaceRoot, record.testFilePath) : undefined;
  if (testAbs && existsSync(testAbs)) {
    await vscode.window.showTextDocument(vscode.Uri.file(testAbs), { preview: false });
  }

  const openReport = 'Abrir relatório';
  const showLog = 'Ver log dos agentes';
  let choice: string | undefined;
  if (record.status === 'SUSPECTED_COMPONENT_BUG') {
    const last = record.history?.at(-1);
    choice = await vscode.window.showWarningMessage(
      `ReacTest: o componente ${componentName(record)} pode ter um DEFEITO.`,
      {
        modal: true,
        detail:
          'O Reparador concluiu que a expectativa do teste está correta e que o componente não a satisfaz. ' +
          'O teste NÃO foi alterado — revise o componente.' +
          (last ? `\n\n${last.reasoning}` : ''),
      },
      openReport,
      showLog,
    );
  } else if (record.status === 'PASSED') {
    choice = await vscode.window.showInformationMessage(
      `ReacTest: ${STATUS_MSG.PASSED} (${record.iterations} iteração(ões) de reparo, branches ${record.coverage.branches}%).`,
      openReport,
      showLog,
    );
  } else {
    choice = await vscode.window.showErrorMessage(`ReacTest: ${STATUS_MSG[record.status]}${record.error ? ` — ${record.error}` : ''}.`, openReport, showLog);
  }
  if (choice === openReport) await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(reportPath));
  else if (choice === showLog) output.show(true);
}
