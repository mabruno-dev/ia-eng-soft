// Contratos compartilhados da pipeline ReacTest-Agent (ver CLAUDE.md, seção "Contratos").
// Este arquivo não pode importar `vscode`.

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
