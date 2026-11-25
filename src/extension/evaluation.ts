// Comandos de avaliação com os modelos do Copilot (provider `vscode`), dentro da Extension Development Host.
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { componentName } from '../core/eval/aggregate';
import { loadEvalConfig } from '../core/eval/config';
import { EvalInfraError, evaluate, type EvalProgress } from '../core/eval/evaluate';
import { classifyInfraError } from '../core/llmErrors';
import { withRateLimitRetry } from '../core/llmRetry';
import { candidateModels, chooseModel, formatModel, type ModelChoice, type ModelInfo, modelPickItems, modelRefusal, type ToolProbe } from '../core/modelChoice';
import { runPipeline, type RunPipelineOptions } from '../core/pipeline';
import { formatEvent } from '../core/progressFormat';
import type { LLMClient, LLMRequest, RunRecord } from '../core/types';
import { probeToolCalling, VSCodeLmClient } from '../llm/vscodeLm';

type CopilotModel = vscode.LanguageModelChat & ModelInfo;

let evaluating = false;

const preferredModel = () => vscode.workspace.getConfiguration('reactest').get<string>('model', '').trim();

async function copilotModels(): Promise<CopilotModel[]> {
  return (await vscode.lm.selectChatModels({ vendor: 'copilot' })) as CopilotModel[];
}

function logAttempts(output: vscode.OutputChannel, choice: ModelChoice<CopilotModel>): void {
  for (const a of choice.attempts) {
    output.appendLine(`  ${a.ok ? '✓' : '✗'} ${a.id} (${a.family}): ${a.ok ? 'tool calling OK' : `tool calling NÃO suportado — ${a.error ?? 'sem chamada de ferramenta'}`}`);
  }
}

/** "ReacTest: Listar modelos do Copilot" — lista os modelos e testa tool calling no modelo de reactest.model. */
export async function listCopilotModels(output: vscode.OutputChannel): Promise<void> {
  output.show(true);
  output.appendLine(`\n══════ Modelos do Copilot · ${new Date().toLocaleString('pt-BR')} ══════`);
  let models: CopilotModel[];
  try {
    models = await copilotModels();
  } catch (err) {
    output.appendLine(`✗ Erro ao listar modelos: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (!models.length) {
    output.appendLine('✗ Nenhum modelo do Copilot disponível (GitHub Copilot Chat instalado e autenticado?).');
    return;
  }
  for (const m of models) output.appendLine(`  ${formatModel(m)}`);

  const pref = preferredModel();
  output.appendLine('');
  output.appendLine(pref ? `Teste de tool calling (reactest.model = "${pref}"):` : 'Teste de tool calling (reactest.model vazio: primeiro modelo que passar):');
  const choice = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'ReacTest: testando tool calling…', cancellable: true },
    (_p, token) => chooseModel(models, pref, (m) => probeToolCalling(m, token)),
  );
  logAttempts(output, choice);
  if (choice.ok) {
    output.appendLine(`→ tool calling OK em ${choice.model.id} (family ${choice.model.family}).`);
    void vscode.window.showInformationMessage(`ReacTest: tool calling OK em ${choice.model.id}.`);
  } else {
    output.appendLine(`→ tool calling NÃO suportado: ${choice.error}`);
    void vscode.window.showErrorMessage(`ReacTest: tool calling NÃO suportado — ${choice.error}`);
  }
}

// ---------------------------------------------------------------------------

const stamp = (d = new Date()) => {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
};

function latestDir(resultsDir: string): string | undefined {
  if (!existsSync(resultsDir)) return undefined;
  const last = readdirSync(resultsDir)
    .filter((d) => statSync(join(resultsDir, d)).isDirectory())
    .sort()
    .at(-1);
  return last ? join(resultsDir, last) : undefined;
}

/** Espera interrompida pelo cancelamento (a chamada seguinte ao LLM então falha como cancelada). */
const cancellableSleep = (token: vscode.CancellationToken) => (ms: number) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(done, ms);
    const sub = token.onCancellationRequested(done);
    function done() {
      clearTimeout(t);
      sub.dispose();
      resolve();
    }
  });

const CANCELLED = 'Avaliação cancelada pelo usuário.';

function cancellable(inner: LLMClient, token: vscode.CancellationToken): LLMClient {
  return {
    ...(inner.supportsJsonMode !== undefined ? { supportsJsonMode: inner.supportsJsonMode } : {}),
    complete: (req: LLMRequest) => (token.isCancellationRequested ? Promise.reject(new Error(CANCELLED)) : inner.complete(req)),
  };
}

const fmt = (n: number) => n.toLocaleString('pt-BR');

/** "ReacTest: Rodar avaliação (Copilot)" — C1 × C2 com evaluate() do núcleo e o VSCodeLmClient. */
export async function runCopilotEvaluation(context: vscode.ExtensionContext, output: vscode.OutputChannel): Promise<void> {
  if (evaluating) {
    void vscode.window.showWarningMessage('ReacTest: já há uma avaliação em andamento.');
    return;
  }
  const root = context.extensionPath;
  let config;
  try {
    config = loadEvalConfig(join(root, 'eval', 'config.json'), root);
  } catch (err) {
    void vscode.window.showErrorMessage(`ReacTest: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  if (!config.answersFile) config = { ...config, answersFile: join(root, 'eval', 'answers.json') };

  const reps = await vscode.window.showInputBox({
    title: 'ReacTest: avaliação C1 × C2 (Copilot)',
    prompt: `Repetições por configuração (${config.components.length} componentes × 2 configurações × N runs)`,
    value: '1',
    ignoreFocusOut: true,
    validateInput: (v) => (/^\s*[1-9]\d*\s*$/.test(v) ? undefined : 'Informe um inteiro ≥ 1'),
  });
  if (reps === undefined) return;
  const runs = Number.parseInt(reps, 10);

  const resultsDir = join(root, 'eval', 'results');
  const last = latestDir(resultsDir);
  let outDir = join(resultsDir, stamp());
  let resume = false;
  if (last) {
    const pick = await vscode.window.showQuickPick(
      [
        { label: 'Nova avaliação', description: outDir, value: 'new' },
        { label: 'Retomar a última', description: `${last} (runs com ERROR são refeitos)`, value: 'resume' },
      ],
      { title: 'ReacTest: avaliação', ignoreFocusOut: true },
    );
    if (!pick) return;
    if (pick.value === 'resume') {
      outDir = last;
      resume = true;
    }
  }

  evaluating = true;
  output.show(true);
  output.appendLine(`\n══════ Avaliação C1 × C2 (Copilot) · ${new Date().toLocaleString('pt-BR')} ══════`);
  output.appendLine(`Workspace: ${config.workspace} · ${config.components.length} componentes · ${runs} run(s)/config · resultados em ${outDir}${resume ? ' (retomando)' : ''}`);
  const total = { input: 0, output: 0, calls: 0 };
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'ReacTest: avaliação (Copilot)', cancellable: true },
      async (progress, token) => {
        // 1) Modelo: reactest.model (family) ou escolha explícita no QuickPick (nunca automática).
        progress.report({ message: 'escolhendo o modelo do Copilot…' });
        const model = await selectEvalModel(output, token);
        output.appendLine(`▶ Modelo usado nesta avaliação: ${model.id} · family ${model.family} · ${model.name} · provider vscode`);

        const llm = () =>
          withRateLimitRetry(cancellable(new VSCodeLmClient({ model, cancellationToken: token }), token), {
            sleep: cancellableSleep(token),
            onRetry: ({ attempt, delayMs, error, tag }) =>
              output.appendLine(`  ⏳ limite de taxa em ${tag} (${error.split('\n')[0]}): nova tentativa ${attempt}/3 em ${delayMs / 1000} s`),
          });

        // Cancelamento: o run interrompido não é gravado (evaluate restaura o teste original no finally).
        const guardedPipeline = async (o: RunPipelineOptions): Promise<RunRecord> => {
          if (token.isCancellationRequested) throw new Error(CANCELLED);
          const r = await runPipeline(o);
          if (token.isCancellationRequested) throw new Error(CANCELLED);
          return r;
        };

        const onProgress = (e: EvalProgress) => {
          if (!('index' in e)) {
            output.appendLine(e.type === 'backup' ? `Teste pré-existente guardado: ${e.testFile}` : `Teste pré-existente restaurado: ${e.testFile}`);
            return;
          }
          const tag = `[${e.index}/${e.total}] ${componentName(e.component)} ${e.config} #${e.repetition}`;
          if (e.type === 'run-start') {
            output.appendLine(`\n━━━━ ${tag} ━━━━`);
            progress.report({ message: tag });
            return;
          }
          const r = e.record;
          if (e.type === 'run-reused') {
            output.appendLine(`↺ ${tag}: reaproveitado (${r.status})`);
            return;
          }
          total.input += r.llm.inputTokens;
          total.output += r.llm.outputTokens;
          total.calls += r.llm.calls;
          output.appendLine(`→ ${tag}: ${r.status}${r.error ? ` — ${r.error.split('\n')[0]}` : ''} · ${r.iterations} iteração(ões) · branches ${r.coverage.branches}% · ${(r.timings.totalMs / 1000).toFixed(1)} s`);
          output.appendLine(
            `  Tokens do run: ${fmt(r.llm.inputTokens)} entrada + ${fmt(r.llm.outputTokens)} saída (${r.llm.calls} chamadas) · ` +
              `acumulado: ${fmt(total.input)} entrada + ${fmt(total.output)} saída (${total.calls} chamadas)`,
          );
        };

        const result = await evaluate({
          // O modelo e o provider escolhidos vão para cada RunRecord (config.model / provider).
          config: { ...config, model: model.id },
          outDir,
          llm,
          provider: 'vscode',
          runs,
          resume,
          runPipeline: guardedPipeline,
          onProgress,
          onEvent: (ev) => formatEvent(ev).forEach((l) => output.appendLine(`  ${l}`)),
        });

        output.appendLine('');
        output.appendLine(`Runs: ${result.runs.length} · tokens desta sessão: ${fmt(total.input)} entrada + ${fmt(total.output)} saída (${total.calls} chamadas)`);
        output.appendLine(`CSV:    ${result.csvPath}`);
        output.appendLine(`Resumo: ${result.summaryPath}`);
        const open = await vscode.window.showInformationMessage(`ReacTest: avaliação concluída (${result.runs.length} runs).`, 'Abrir resumo');
        if (open) await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(result.summaryPath));
      },
    );
  } catch (err) {
    output.appendLine(`Tokens até aqui: ${fmt(total.input)} entrada + ${fmt(total.output)} saída (${total.calls} chamadas)`);
    const resumeHint = `Para retomar, rode "ReacTest: Rodar avaliação (Copilot)" e escolha "Retomar a última" (${outDir}).`;
    if (err instanceof EvalInfraError) {
      output.appendLine(`\n✗ Avaliação ABORTADA em ${componentName(err.component)} ${err.config} #${err.repetition}: ${err.label}.`);
      output.appendLine(`  Erro: ${err.detail.split('\n')[0]}`);
      output.appendLine('  O RunRecord deste run NÃO foi gravado.');
      output.appendLine(`  ${resumeHint}`);
      void vscode.window.showErrorMessage(`ReacTest: avaliação abortada — ${err.label}. ${resumeHint}`);
      return;
    }
    const msg = err instanceof Error ? err.message : String(err);
    if (msg === CANCELLED) {
      output.appendLine(`\n■ ${CANCELLED} O run em andamento não foi gravado. ${resumeHint}`);
      return;
    }
    const infra = err instanceof EvalSetupError ? { label: 'modelo indisponível' } : classifyInfraError(msg);
    output.appendLine(`\n✗ Avaliação ${infra ? 'ABORTADA' : 'interrompida'}: ${msg}`);
    void vscode.window.showErrorMessage(`ReacTest: ${msg}`);
  } finally {
    evaluating = false;
  }
}

/**
 * Modelo da avaliação. Com reactest.model: essa família (precisa passar no teste de tool calling).
 * Vazio: testa os modelos e mostra um QuickPick (family + resultado do teste); a escolha é gravada em
 * reactest.model (configuração global). Famílias "mini" são recusadas salvo reactest.allowMiniModels.
 */
async function selectEvalModel(output: vscode.OutputChannel, token: vscode.CancellationToken): Promise<CopilotModel> {
  const cfg = vscode.workspace.getConfiguration('reactest');
  const allowMini = cfg.get<boolean>('allowMiniModels', false);
  const models = await copilotModels();
  if (!models.length) throw new EvalSetupError('Nenhum modelo de linguagem do Copilot está disponível (GitHub Copilot Chat instalado e autenticado?).');
  const pref = preferredModel();

  if (pref) {
    const cands = candidateModels(models, pref);
    const refused = cands.find((m) => modelRefusal(m, allowMini));
    if (refused) throw new EvalSetupError(`Modelo recusado: ${modelRefusal(refused, allowMini)}. Ajuste reactest.model.`);
    output.appendLine(`reactest.model = "${pref}"`);
    const choice = await chooseModel(models, pref, (m) => probeToolCalling(m, token));
    logAttempts(output, choice);
    if (!choice.ok) throw new EvalSetupError(choice.error);
    return choice.model;
  }

  output.appendLine('reactest.model vazio: testando tool calling nos modelos do Copilot para você escolher…');
  const probes = new Map<string, ToolProbe>();
  for (const m of models) {
    if (modelRefusal(m, allowMini)) continue; // não gasta requisição com modelo recusado
    if (token.isCancellationRequested) throw new Error(CANCELLED);
    const r = await probeToolCalling(m, token);
    probes.set(m.id, r);
    output.appendLine(`  ${r.ok ? '✓' : '✗'} ${m.id} (${m.family}): ${r.ok ? 'tool calling OK' : `tool calling NÃO suportado — ${r.error ?? ''}`}`);
  }
  const items = modelPickItems(models, probes, allowMini);
  const pick = await vscode.window.showQuickPick(
    items.map((i) => ({ label: i.label, description: i.description, detail: i.detail, item: i })),
    { title: 'ReacTest: modelo do Copilot para a avaliação', placeHolder: 'Escolha a família (a escolha é gravada em reactest.model)', ignoreFocusOut: true, matchOnDescription: true },
  );
  if (!pick) throw new Error(CANCELLED);
  if (!pick.item.selectable) throw new EvalSetupError(`Modelo ${pick.item.model.family} recusado: ${pick.item.reason}.`);
  const chosen = pick.item.model;
  await cfg.update('model', chosen.family, vscode.ConfigurationTarget.Global);
  output.appendLine(`reactest.model ← "${chosen.family}" (gravado nas configurações globais)`);
  return chosen;
}

/** Falha antes do 1º run (sem modelo / sem tool calling / modelo recusado). */
class EvalSetupError extends Error {}
