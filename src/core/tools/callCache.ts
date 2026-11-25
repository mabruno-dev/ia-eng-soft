// Cache de chamadas repetidas para ferramentas determinísticas (somente leitura).
// Se o agente repetir a mesma chamada com os mesmos argumentos, responde do cache e avisa,
// em vez de reexecutar — evita loops que estouram o limite de passos.
import type { AgentTool } from '../agent/runtime';

export const REPEATED_CALL = 'chamada repetida: use o resultado anterior';

const norm = (v: unknown): unknown => {
  if (typeof v === 'string') return v.trim().replace(/\\/g, '/');
  if (Array.isArray(v)) return v.map(norm);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.entries(v)
        .filter(([, x]) => x !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => [k, norm(x)]),
    );
  }
  return v;
};

/** Chave estável de uma chamada (nome + argumentos normalizados). */
export const callKey = (name: string, args: unknown) => `${name}:${JSON.stringify(norm(args))}`;

type Cached = { ok: true; value: unknown } | { ok: false; error: string };

/**
 * Envolve as ferramentas com um cache compartilhado por execução do agente. A repetição devolve o mesmo
 * resultado com `warning: "chamada repetida: …"` (ou o mesmo erro, prefixado pelo aviso).
 */
export function withCallCache(tools: AgentTool[]): AgentTool[] {
  const cache = new Map<string, Cached>();
  return tools.map((t) => ({
    ...t,
    run: async (args: unknown) => {
      const key = callKey(t.spec.name, args);
      const hit = cache.get(key);
      if (hit) {
        if (!hit.ok) throw new Error(`${REPEATED_CALL} — ${hit.error}`);
        const v = hit.value;
        return v && typeof v === 'object' && !Array.isArray(v) ? { warning: REPEATED_CALL, ...v } : { warning: REPEATED_CALL, result: v };
      }
      try {
        const value = await t.run(args);
        cache.set(key, { ok: true, value });
        return value;
      } catch (err) {
        cache.set(key, { ok: false, error: err instanceof Error ? err.message : String(err) });
        throw err;
      }
    },
  }));
}
