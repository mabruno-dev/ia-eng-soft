import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export const TRACE_RESULT_MAX = 500;

/** Uma chamada de ferramenta dentro de um passo. */
export interface TraceToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
  /** Resumo do resultado (ou do erro) enviado ao LLM, truncado em 500 caracteres. */
  result: string;
  ms: number;
}

/** Uma linha do `.trace.jsonl`: um passo (= uma chamada ao LLM) de um agente. */
export interface TraceEntry {
  ts: string;
  agent: string;
  step: number; // 1-based
  /** tool_calls: o LLM pediu ferramentas; final: resposta final válida; invalid_final: JSON final rejeitado. */
  kind: 'tool_calls' | 'final' | 'invalid_final' | 'step_limit';
  text?: string;
  tools?: TraceToolCall[];
  error?: string;
  llmMs: number;
  ms: number; // duração total do passo (LLM + ferramentas)
}

export function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}… [+${s.length - max} caracteres]`;
}

/** Grava o trace dos agentes em `.reactest/runs/<runId>.trace.jsonl` (uma linha JSON por passo). */
export class TraceWriter {
  readonly file: string;
  private ready: Promise<unknown> | undefined;
  private chain: Promise<void> = Promise.resolve();

  constructor(workspaceRoot: string, runId: string) {
    this.file = join(workspaceRoot, '.reactest', 'runs', `${runId}.trace.jsonl`);
  }

  /** Acrescenta uma linha. As escritas são serializadas, preservando a ordem dos passos. */
  write(entry: Omit<TraceEntry, 'ts'> & { ts?: string }): Promise<void> {
    const line = JSON.stringify({ ts: entry.ts ?? new Date().toISOString(), ...entry }) + '\n';
    this.ready ??= mkdir(dirname(this.file), { recursive: true });
    const next = this.chain.then(async () => {
      await this.ready;
      await appendFile(this.file, line, 'utf8');
    });
    this.chain = next.catch(() => undefined);
    return next;
  }

  /** Aguarda todas as escritas pendentes. */
  flush(): Promise<void> {
    return this.chain;
  }
}
