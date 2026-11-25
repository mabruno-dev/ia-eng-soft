import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyInfraError, isRateLimitError } from './llmErrors';
import { RATE_LIMIT_DELAYS_MS, withRateLimitRetry } from './llmRetry';
import type { LLMClient, LLMRequest, LLMResponse } from './types';

const req: LLMRequest = { system: 's', messages: [{ role: 'user', content: 'oi' }], tag: 'generator' };
const ok: LLMResponse = { text: 'ok', inputTokens: 1, outputTokens: 1 };

/** LLM que falha com as mensagens dadas (na ordem) e depois responde ok. */
function flaky(errors: string[]): LLMClient & { calls: number } {
  const c = {
    calls: 0,
    async complete(): Promise<LLMResponse> {
      const e = errors[c.calls++];
      if (e) throw new Error(e);
      return ok;
    },
  };
  return c;
}

describe('withRateLimitRetry (timers falsos)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('espera 20 s, 60 s e 120 s entre as tentativas e devolve a resposta quando o limite passa', async () => {
    const inner = flaky(['Rate limit exceeded', 'Rate limit exceeded', 'Rate limit exceeded']);
    const retries: number[] = [];
    const llm = withRateLimitRetry(inner, { onRetry: (r) => retries.push(r.delayMs) });
    const p = llm.complete(req);

    await vi.advanceTimersByTimeAsync(0);
    expect(inner.calls).toBe(1);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(inner.calls).toBe(1); // ainda esperando os 20 s
    await vi.advanceTimersByTimeAsync(1);
    expect(inner.calls).toBe(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(inner.calls).toBe(3);
    await vi.advanceTimersByTimeAsync(119_000);
    expect(inner.calls).toBe(3);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(p).resolves.toEqual(ok);
    expect(inner.calls).toBe(4);
    expect(retries).toEqual(RATE_LIMIT_DELAYS_MS);
  });

  it('depois da 3ª espera o erro de limite de taxa sobe (e vira abort na avaliação)', async () => {
    const inner = flaky(['429 Too Many Requests', '429 Too Many Requests', '429 Too Many Requests', '429 Too Many Requests']);
    const p = withRateLimitRetry(inner).complete(req);
    const settled = p.catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(200_000);
    const err = await settled;
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('429 Too Many Requests');
    expect(inner.calls).toBe(4);
    expect(classifyInfraError((err as Error).message)?.kind).toBe('rate_limit');
  });

  it('cota, falta de modelo e erros comuns não são repetidos', async () => {
    for (const msg of ['You have exceeded your quota', 'Nenhum modelo de linguagem do Copilot está disponível.', 'falha qualquer']) {
      const inner = flaky([msg]);
      await expect(withRateLimitRetry(inner).complete(req)).rejects.toThrow(msg);
      expect(inner.calls).toBe(1);
    }
  });

  it('repassa supportsJsonMode', () => {
    expect(withRateLimitRetry({ supportsJsonMode: true, complete: async () => ok }).supportsJsonMode).toBe(true);
  });
});

describe('classifyInfraError (Copilot)', () => {
  it('reconhece quota, rate limit, ausência de modelo e falta de permissão', () => {
    expect(classifyInfraError('Request failed: quota exceeded for this month')?.kind).toBe('quota');
    expect(classifyInfraError('Server error: rate limit reached')?.kind).toBe('rate_limit');
    expect(classifyInfraError('Nenhum modelo de linguagem do Copilot da família "gpt-4o" está disponível.')?.kind).toBe('no_model');
    expect(classifyInfraError('Access denied [NoPermissions]')?.kind).toBe('auth');
    expect(isRateLimitError(new Error('Rate limit exceeded'))).toBe(true);
    expect(isRateLimitError(new Error('quota exceeded'))).toBe(false);
  });
});
