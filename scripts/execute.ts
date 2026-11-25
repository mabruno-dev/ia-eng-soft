// Executa só o agente Executor (04) sobre um arquivo de teste existente e mostra ExecResult + diagnóstico.
// Uso: npm run execute -- <componente> <arquivoDeTeste> [--workspace fixtures/sample-app] [--model gpt-4o-mini]
// Sem OPENAI_API_KEY usa um LLM substituto mecânico (chama run_jest uma vez e devolve category null),
// útil para ver o Jest real + a verificação cruzada do regex sem rede.
import { Command } from 'commander';
import { executeTests } from '../src/core/agents/executor';
import { AgentMeter, MeteredLLM } from '../src/core/metrics';
import type { ContextResult, LLMClient } from '../src/core/types';
import { FakeLLM } from '../src/llm/fake';
import { OpenAIClient } from '../src/llm/openai';

function standInLLM(testFile: string, componentFile: string): LLMClient {
  return new FakeLLM((req) => {
    const ran = req.messages.some((m) => m.role === 'tool');
    if (!ran) return { toolCalls: [{ id: 'run1', name: 'run_jest', arguments: { testFile, componentFile } }] };
    return JSON.stringify({ category: null, summary: '(LLM substituto: sem diagnóstico; categoria decidida pelo regex)', flaky: false });
  });
}

const program = new Command()
  .argument('<component>', 'caminho do componente, relativo ao workspace')
  .argument('<testFile>', 'arquivo de teste, relativo ao workspace')
  .option('--workspace <dir>', 'raiz do workspace', 'fixtures/sample-app')
  .option('--model <model>', 'modelo OpenAI', process.env.OPENAI_MODEL ?? 'gpt-4o-mini')
  .action(async (component: string, testFile: string, opts: { workspace: string; model: string }) => {
    const real = !!process.env.OPENAI_API_KEY;
    const llm = new MeteredLLM(real ? new OpenAIClient({ model: opts.model }) : standInLLM(testFile, component));
    const meter = new AgentMeter();
    const name = component.split('/').pop()!.replace(/\.\w+$/, '');
    const ctx: ContextResult = {
      componentPath: component, componentName: name, componentSource: '', testFilePath: testFile,
      allowedImports: [], dependencies: [], props: '', hooks: [], contexts: [], stores: [], apiCalls: [], mockTargets: [],
    };

    const res = await executeTests({ ctx, workspaceRoot: opts.workspace, testFilePath: testFile, llm, meter });

    console.log(`LLM: ${real ? opts.model : 'substituto (sem OPENAI_API_KEY)'}`);
    console.log('== ExecResult ==');
    console.log(JSON.stringify({ ...res.exec, rawOutput: `<${res.exec.rawOutput.length} caracteres>` }, null, 2));
    console.log('== Diagnóstico ==');
    console.log(JSON.stringify(res.diagnosis, null, 2));
    console.log('== Verificação cruzada ==', JSON.stringify(res.crossCheck));
    console.log('== Métricas ==', JSON.stringify({ runs: res.runs, llm: llm.totals(), agents: meter.agents() }));
  });

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
