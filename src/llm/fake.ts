import type { LLMClient, LLMRequest, LLMResponse } from '../core/types';

export type FakeReply = string | LLMResponse;
export type FakeResponder = (req: LLMRequest) => FakeReply | Promise<FakeReply>;
export type FakeSource =
  | FakeReply[]
  | Record<string, FakeReply | FakeReply[] | FakeResponder>
  | FakeResponder;

/** Estimativa grosseira (~4 caracteres por token), suficiente para testes. */
const estimateTokens = (s: string): number => Math.ceil(s.length / 4);

/**
 * LLM falso para testes (sem rede). Aceita:
 *  - uma fila de respostas, consumidas em ordem;
 *  - um mapa `tag -> resposta | fila | função` (cai na fila global se a tag esgotar);
 *  - uma função `(req) => resposta`.
 * Respostas em string recebem contagem de tokens estimada.
 * Todas as requisições recebidas ficam em `requests`.
 */
export class FakeLLM implements LLMClient {
  readonly requests: LLMRequest[] = [];
  private readonly queue: FakeReply[] = [];
  private readonly byTag = new Map<string, FakeReply[] | FakeResponder>();
  private readonly responder?: FakeResponder;

  constructor(source: FakeSource = []) {
    if (typeof source === 'function') {
      this.responder = source;
    } else if (Array.isArray(source)) {
      this.queue.push(...source);
    } else {
      for (const [tag, v] of Object.entries(source)) {
        this.byTag.set(tag, typeof v === 'function' ? v : Array.isArray(v) ? [...v] : [v]);
      }
    }
  }

  /** Requisições recebidas com uma tag específica. */
  requestsFor(tag: string): LLMRequest[] {
    return this.requests.filter((r) => r.tag === tag);
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    this.requests.push(req);
    const reply = await this.next(req);
    if (typeof reply !== 'string') return reply;
    const input = req.system + req.messages.map((m) => m.content).join('');
    return { text: reply, inputTokens: estimateTokens(input), outputTokens: estimateTokens(reply) };
  }

  private async next(req: LLMRequest): Promise<FakeReply> {
    if (this.responder) return this.responder(req);
    const tagged = this.byTag.get(req.tag);
    if (typeof tagged === 'function') return tagged(req);
    const fromTag = tagged?.shift();
    if (fromTag !== undefined) return fromTag;
    const fromQueue = this.queue.shift();
    if (fromQueue !== undefined) return fromQueue;
    throw new Error(`FakeLLM: nenhuma resposta configurada para a tag "${req.tag}" (requisição #${this.requests.length}).`);
  }
}
