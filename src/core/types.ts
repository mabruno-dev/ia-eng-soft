// Contratos compartilhados da pipeline ReacTest-Agent (ver CLAUDE.md, seção "Contratos").
// Este arquivo não pode importar `vscode`.

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
  alignedToBehavior: number;              // RQ1: reparos que alinharam a expectativa ao comportamento observado (sem evidência de defeito)
  llm: { calls: number; inputTokens: number; outputTokens: number }; // RQ5
  agents: Record<string, { steps: number; toolCalls: number }>;      // RQ5
  timings: { totalMs: number; perAgentMs: Record<string, number> };  // RQ5
  elicitation?: { questions: number; answered: number; derivedCases: number }; // RQ4
  // ---- Campos auxiliares (opcionais; a avaliação não depende deles) ----
  testFilePath?: string;                  // arquivo de teste gravado (relativo ao workspace)
  history?: RunIteration[];               // uma entrada por iteração de reparo
  error?: string;                         // mensagem quando status = 'ERROR'
}

export interface RunIteration {
  iteration: number;
  category: FailureCategory | null;
  summary: string;
  repairStatus: 'REPAIRED' | 'SUSPECTED_COMPONENT_BUG' | 'GAVE_UP';
  reasoning: string;
  rejectedRepairs: number;
  alignedToBehavior: boolean;
}

/** Pergunta ao desenvolvedor (UI da extensão, terminal ou arquivo de respostas). undefined = sem resposta. */
export interface Asker {
  ask(question: string, options?: string[]): Promise<string | undefined>;
}
