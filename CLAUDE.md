# ReacTest-Agent

Extensão do VS Code (com CLI compartilhando o mesmo núcleo) que gera testes **Jest + React Testing Library** para componentes React/TypeScript através de uma **pipeline de 6 agentes de IA com self-healing**.

É a evolução da ReacTest v1 (TCC, UFF), que era *single-shot* e "cega": gerava o teste, mas não executava, não verificava e não perguntava nada. Projeto da disciplina de IA para Engenharia de Software (IC/UFF, 2026).

## Pipeline

```
Componente → 01 Contexto → 02 Elicitação → 03 Gerador → 04 Executor ⇄ 05 Reparador (máx. N iterações) → 06 Verificador → suíte validada
```

**Todos os agentes são agentes de IA**: cada um é um LLM com um papel (system prompt) e um conjunto de **ferramentas** que ele decide chamar, em loop, até produzir uma resposta final estruturada. A ordem entre os agentes é fixa e controlada pelo orquestrador (código); dentro de cada agente, quem decide quais ferramentas chamar e quando parar é o LLM.

| # | Agente | Papel (o que o LLM decide) | Ferramentas (código determinístico) |
|---|--------|----------------------------|-------------------------------------|
| 01 | Contexto | Explora o grafo de dependências do componente e decide o que é relevante para testá-lo | `read_file`, `list_imports`, `resolve_import`, `relative_specifier`, `search_code`, `analyze_component` |
| 02 | Elicitação | Decide quais regras de negócio perguntar, e se precisa de pergunta de acompanhamento | `read_rules`, `ask_user`, `save_rule` |
| 03 | Gerador | Planeja os cenários (CoT) e escreve o teste; confere os imports antes de entregar | `read_file`, `validate_imports` |
| 04 | Executor | Roda o Jest, interpreta a saída, decide se reexecuta (flaky/timeout) e diagnostica a categoria da falha | `run_jest`, `read_file` |
| 05 | Reparador | Decide a correção, se testa a hipótese e se é defeito do componente | `read_file`, `run_jest`, `validate_imports`, `check_repair`, `write_test` |
| 06 | Verificador | Interpreta mutantes sobreviventes e test smells e recomenda melhorias | `run_stryker`, `detect_smells`, `read_file` |

## Regras inegociáveis

1. **`src/core` nunca importa `vscode`.** Só `src/extension/**` e `src/llm/vscodeLm.ts` podem. O núcleo roda via CLI e é testável com vitest.
2. **O LLM decide, as ferramentas executam, o código garante.** Todo agente roda via `runAgent()` (`src/core/agent/runtime.ts`): loop de tool calling com `maxSteps` (padrão 8), resposta final validada por zod. Ferramentas são funções determinísticas em `src/core/tools/`.
3. **O LLM nunca escreve caminho de import que nenhuma ferramenta tenha devolvido.** Os caminhos vêm de `resolve_import` / `relative_specifier` e são re-verificados em código por `validateImports()` (arquivo existente, dependência do package.json, builtin do Node ou item de `allowedImports`).
4. **Números vêm das ferramentas, nunca do texto do LLM.** `ExecResult`, cobertura e mutation score são lidos do resultado das ferramentas e mesclados em código; o LLM só acrescenta diagnóstico, categoria e recomendações.
5. **Guardrail do oráculo (em código, não só no prompt):** o Reparador não pode "curar" um teste apagando asserções ou usando `skip`. `checkRepair(antes, depois)` rejeita o patch se: o nº de `expect(` diminuir; o nº de casos de teste (`it`/`test`) diminuir; aparecer `.skip`, `xit`, `xdescribe`, `test.todo` ou `.only`; ou uma asserção específica for trocada por uma trivial. A ferramenta `write_test` só grava o arquivo se `checkRepair` passar — isso é imposto na ferramenta, o LLM não consegue contornar. Se a falha parecer **defeito real do componente**, o agente para com status `SUSPECTED_COMPONENT_BUG`, **não altera o teste** e sinaliza ao dev.
6. **Toda chamada de LLM passa por `MeteredLLM`**, que registra tokens, nº de chamadas e tempo por agente (RQ5). `runAgent` também registra passos e chamadas de ferramenta por agente e grava o trace em `.reactest/runs/<runId>.trace.jsonl`.
7. **Toda execução grava `.reactest/runs/<runId>.json`** no formato `RunRecord` (abaixo). A avaliação lê só esses arquivos.
8. **Tudo que é interativo tem modo não-interativo** (arquivo de respostas / flags), senão não dá para avaliar em lote.
9. Cada agente fica em `src/core/agents/<nome>.ts`, suas ferramentas em `src/core/tools/`, com teste vitest usando `FakeLLM` roteirizado (sem rede), incluindo chamadas de ferramenta.

## Convenções

- TypeScript `strict`, Node 20+, código e identificadores em **inglês**; mensagens para o usuário em **pt-BR**.
- Bundle da extensão com esbuild (CJS). Testes do próprio projeto com **vitest**.
- Sem dependências desnecessárias. Dependências esperadas: `ts-morph`, `openai`, `commander`, `zod`, `@types/vscode`, `esbuild`, `vitest`, `tsx`.
- Commits pequenos, um por etapa, mensagem no imperativo.

## Estrutura alvo

```
src/
  core/
    types.ts            # contratos abaixo
    pipeline.ts         # orquestrador (ordem fixa dos agentes)
    agent/runtime.ts    # runAgent: loop de tool calling + trace
    agents/             # context.ts elicitation.ts generator.ts executor.ts repairer.ts verifier.ts
    tools/              # read_file, resolve_import, run_jest, check_repair, write_test, run_stryker...
    guardrail.ts        # checkRepair + classificação de falhas (fallback/validação)
    importValidator.ts  # validateImports
    metrics.ts          # MeteredLLM + RunRecord writer
    prompts/            # system prompts por agente, AUTOMAT, CoT, few-shot
  llm/                  # openai.ts  vscodeLm.ts  fake.ts  (todos com tool calling)
  cli.ts
  extension/extension.ts
eval/                   # config, runner, resultados
fixtures/sample-app/    # app React de demonstração (MC2 e MC4)
```

## Contratos (implementar em `src/core/types.ts`)

```ts
// ---- LLM com tool calling ----
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema (type: 'object')
}
export interface ToolCall { id: string; name: string; arguments: Record<string, unknown> }
export type ChatMessage =
  | { role: 'user' | 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };

export interface LLMRequest {
  system: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  temperature?: number;
  jsonMode?: boolean;
  tag: string; // nome do agente, para métricas
}
export interface LLMResponse {
  text: string;
  toolCalls?: ToolCall[];
  inputTokens: number;
  outputTokens: number;
}
export interface LLMClient { complete(req: LLMRequest): Promise<LLMResponse> }

// ---- Domínio ----
export interface ImportInfo {
  name: string;
  specifier: string; // JÁ relativo ao testFilePath quando for arquivo local
  kind: 'default' | 'named' | 'namespace' | 'side-effect';
  isExternal: boolean;
}
export interface ContextResult {
  componentPath: string;
  componentName: string;
  componentSource: string;
  testFilePath: string;
  allowedImports: ImportInfo[];
  dependencies: { path: string; source: string; depth: number }[];
  props: string;
  hooks: string[];
  contexts: string[];
  stores: string[];
  apiCalls: string[];
  mockTargets: string[]; // especificadores exatos de módulos que devem ser mockados
}

export interface Scenario {
  name: string;
  kind: 'render' | 'interaction' | 'validation' | 'async' | 'edge';
  description: string;
  mocks: string[];
  fromRules: string[]; // ids das regras de negócio que originaram o cenário
}
export interface TestPlan { scenarios: Scenario[] }

export interface Coverage { statements: number; branches: number; functions: number; lines: number }
export interface JestFailure { testName: string; message: string }
export interface ExecResult {
  passed: boolean;
  numTests: number;
  numFailed: number;
  failures: JestFailure[];
  suiteError?: string; // erro de compilação/import quando nenhum teste chegou a rodar
  coverage: Coverage;
  rawOutput: string;
}

export type FailureCategory = 'IMPORT' | 'MOCK' | 'ASYNC' | 'ASSERTION' | 'SYNTAX_TYPE' | 'UNKNOWN';

export interface PipelineConfig {
  heal: boolean;
  elicit: boolean;
  verify: boolean;
  maxIterations: number;
  maxAgentSteps: number;
  model: string;
  provider: 'openai' | 'vscode';
}

export interface RunRecord {
  runId: string;
  component: string;
  config: PipelineConfig;
  status: 'PASSED' | 'FAILED' | 'SUSPECTED_COMPONENT_BUG' | 'ERROR';
  iterations: number;                     // RQ1
  generated: { code: string; lines: number };
  final: { code: string; lines: number };
  modificationRate: number;               // RQ2: linhas alteradas pelo healing / linhas geradas
  coverage: Coverage;                     // RQ3 (branches)
  mutation?: { score: number; killed: number; survived: number; timeout: number }; // RQ3
  smells?: string[];
  rejectedRepairs: number;                // RQ1: reparos indevidos barrados pelo guardrail
  llm: { calls: number; inputTokens: number; outputTokens: number }; // RQ5
  agents: Record<string, { steps: number; toolCalls: number }>;      // RQ5
  timings: { totalMs: number; perAgentMs: Record<string, number> };  // RQ5
  elicitation?: { questions: number; answered: number; derivedCases: number }; // RQ4
}
```

## Comandos

```
npm run build        # esbuild da extensão + tsc --noEmit
npm test             # vitest
npm run cli -- <componente> --workspace <dir> [--no-heal] [--no-elicit] [--no-verify] [--max-iter 3]
```

## Definição de pronto de cada etapa

`npm run build` e `npm test` passam, a etapa tem teste vitest com `FakeLLM`, e o resultado foi demonstrado rodando o CLI no `fixtures/sample-app` quando aplicável.
