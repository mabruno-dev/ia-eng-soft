# ReacTest-Agent

Extensão do VS Code (com CLI compartilhando o mesmo núcleo) que gera testes **Jest + React Testing Library** para componentes React/TypeScript através de uma **pipeline agêntica de 6 agentes com self-healing**.

É a evolução da ReacTest v1 (TCC, UFF), que era *single-shot* e "cega": gerava o teste, mas não executava, não verificava e não perguntava nada. Projeto da disciplina de IA para Engenharia de Software (IC/UFF, 2026).

## Pipeline

```
Componente → 01 Contexto → 02 Elicitação → 03 Gerador → 04 Executor ⇄ 05 Reparador (máx. N iterações) → 06 Verificador → suíte validada
```

| # | Agente | Responsabilidade | Usa LLM? |
|---|--------|------------------|----------|
| 01 | Contexto | Grafo de dependências do workspace (ts-morph), imports exatos relativos ao arquivo de teste, o que mockar | **Não** (determinístico) |
| 02 | Elicitação | Pergunta regras de negócio ao dev; persiste em `.reactest/rules.md` e reaproveita | Sim |
| 03 | Gerador | Plano de teste (CoT) e depois código Jest/RTL (prompt AUTOMAT + CoT + few-shot) | Sim |
| 04 | Executor | Roda Jest com cobertura no workspace e coleta erros/relatórios | **Não** |
| 05 | Reparador | Classifica a falha (IMPORT, MOCK, ASYNC, ASSERTION, SYNTAX_TYPE) e corrige em até N iterações | Sim + guardrail determinístico |
| 06 | Verificador | Mutation testing (Stryker) e detecção de test smells | **Não** (exceto relatório) |

## Regras inegociáveis

1. **`src/core` nunca importa `vscode`.** Só `src/extension/**` e `src/llm/vscodeLm.ts` podem. O núcleo roda via CLI e é testável com vitest.
2. **O LLM nunca adivinha caminho de import.** O Contexto resolve imports de forma determinística e `validateImports()` rejeita qualquer import do teste que não resolva (arquivo existente, dependência do package.json, builtin do Node ou item de `allowedImports`).
3. **Guardrail do oráculo (em código, não só no prompt):** o Reparador não pode "curar" um teste apagando asserções ou usando `skip`. `checkRepair(antes, depois)` rejeita o patch se: o nº de `expect(` diminuir; o nº de casos de teste (`it`/`test`) diminuir; aparecer `.skip`, `xit`, `xdescribe`, `test.todo` ou `.only`. Se a falha parecer um **defeito real do componente**, o agente para com status `SUSPECTED_COMPONENT_BUG`, **não altera o teste** e sinaliza ao dev.
4. **Toda chamada de LLM passa por `MeteredLLM`**, que registra tokens, nº de chamadas e tempo por agente (RQ5).
5. **Toda execução grava `.reactest/runs/<runId>.json`** no formato `RunRecord` (abaixo). A avaliação lê só esses arquivos.
6. **Tudo que é interativo tem modo não-interativo** (arquivo de respostas / flags), senão não dá para avaliar em lote.
7. Cada agente é uma função pura de entrada→saída tipada, em `src/core/agents/<nome>.ts`, com teste vitest usando `FakeLLM` (sem rede).

## Convenções

- TypeScript `strict`, Node 20+, código e identificadores em **inglês**; mensagens para o usuário em **pt-BR**.
- Bundle da extensão com esbuild (CJS). Testes do próprio projeto com **vitest**.
- Sem dependências desnecessárias. Dependências esperadas: `ts-morph`, `openai`, `commander`, `zod`, `p-limit` (opcional), `@types/vscode`, `esbuild`, `vitest`.
- Commits pequenos, um por etapa, mensagem no imperativo.

## Estrutura alvo

```
src/
  core/
    types.ts            # contratos abaixo
    pipeline.ts         # orquestrador
    agents/             # context.ts elicitation.ts generator.ts executor.ts repairer.ts verifier.ts
    guardrail.ts        # checkRepair + classificação de falhas
    importValidator.ts  # validateImports
    metrics.ts          # MeteredLLM + RunRecord writer
    prompts/            # templates AUTOMAT, CoT, few-shot, reparo
  llm/                  # openai.ts  vscodeLm.ts  fake.ts
  cli.ts
  extension/extension.ts
eval/                   # config, runner, resultados
fixtures/sample-app/    # app React de demonstração (MC2 e MC4)
```

## Contratos (implementar em `src/core/types.ts`)

```ts
export interface LLMRequest {
  system: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  temperature?: number;
  jsonMode?: boolean;
  tag: string; // nome do agente, para métricas
}
export interface LLMResponse { text: string; inputTokens: number; outputTokens: number }
export interface LLMClient { complete(req: LLMRequest): Promise<LLMResponse> }

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
