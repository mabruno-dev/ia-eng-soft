// Retentativa com espera para erros de limite de taxa (ex.: Copilot via vscode.lm, que não retenta sozinho).
import { isRateLimitError } from './llmErrors';
import type { LLMClient, LLMRequest, LLMResponse } from './types';

/** Esperas antes da 1ª, 2ª e 3ª nova tentativa (ms). Depois disso o erro sobe. */
export const RATE_LIMIT_DELAYS_MS = [20_000, 60_000, 120_000];

export interface RetryOptions {
  delaysMs?: number[];
  /** Espera (injetável: testes com timers falsos; a extensão interrompe no cancelamento). */
  sleep?: (ms: number) => Promise<void>;
  /** Avisado antes de cada espera. */
  onRetry?: (info: { attempt: number; delayMs: number; error: string; tag: string }) => void;
  shouldRetry?: (err: unknown) => boolean;
}

export const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** LLMClient que repete a chamada após 20 s, 60 s e 120 s quando o erro é de limite de taxa. */
export function withRateLimitRetry(inner: LLMClient, opts: RetryOptions = {}): LLMClient {
  const delays = opts.delaysMs ?? RATE_LIMIT_DELAYS_MS;
  const sleep = opts.sleep ?? defaultSleep;
  const shouldRetry = opts.shouldRetry ?? isRateLimitError;
  return {
    ...(inner.supportsJsonMode !== undefined ? { supportsJsonMode: inner.supportsJsonMode } : {}),
    async complete(req: LLMRequest): Promise<LLMResponse> {
      for (let attempt = 0; ; attempt++) {
        try {
          return await inner.complete(req);
        } catch (err) {
          const delayMs = delays[attempt];
          if (delayMs === undefined || !shouldRetry(err)) throw err;
          opts.onRetry?.({ attempt: attempt + 1, delayMs, error: err instanceof Error ? err.message : String(err), tag: req.tag });
          await sleep(delayMs);
        }
      }
    },
  };
}
