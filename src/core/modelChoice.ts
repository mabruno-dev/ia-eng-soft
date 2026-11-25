// Escolha do modelo do Copilot (puro: a extensão injeta a lista e o teste de tool calling).

export interface ModelInfo {
  id: string;
  family: string;
  name: string;
  maxInputTokens: number;
}

export interface ToolProbe {
  ok: boolean;
  error?: string;
}

export interface ModelAttempt {
  id: string;
  family: string;
  ok: boolean;
  error?: string;
}

export type ModelChoice<M extends ModelInfo> =
  | { ok: true; model: M; attempts: ModelAttempt[] }
  | { ok: false; error: string; attempts: ModelAttempt[] };

/** Modelos candidatos: os da família (ou id) pedida; sem preferência, todos, na ordem do VS Code. */
export function candidateModels<M extends ModelInfo>(models: M[], preferred: string | undefined): M[] {
  const pref = preferred?.trim().toLowerCase();
  if (!pref) return [...models];
  return models.filter((m) => m.family.toLowerCase() === pref || m.id.toLowerCase() === pref);
}

/**
 * Escolhe o primeiro candidato que passa no teste de tool calling (testados em ordem, um de cada vez).
 * Com `preferred` (reactest.model), só a família pedida é aceita.
 */
export async function chooseModel<M extends ModelInfo>(
  models: M[],
  preferred: string | undefined,
  probe: (m: M) => Promise<ToolProbe>,
): Promise<ModelChoice<M>> {
  const attempts: ModelAttempt[] = [];
  if (!models.length) {
    return { ok: false, error: 'Nenhum modelo de linguagem do Copilot está disponível (verifique se o GitHub Copilot Chat está instalado e autenticado).', attempts };
  }
  const candidates = candidateModels(models, preferred);
  if (!candidates.length) {
    const families = [...new Set(models.map((m) => m.family))].join(', ');
    return { ok: false, error: `Nenhum modelo do Copilot da família "${preferred}". Disponíveis: ${families}. Ajuste reactest.model.`, attempts };
  }
  for (const m of candidates) {
    let r: ToolProbe;
    try {
      r = await probe(m);
    } catch (err) {
      r = { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    attempts.push({ id: m.id, family: m.family, ok: r.ok, ...(r.error ? { error: r.error } : {}) });
    if (r.ok) return { ok: true, model: m, attempts };
  }
  const which = preferred?.trim() ? `da família "${preferred}"` : 'do Copilot';
  return { ok: false, error: `Nenhum modelo ${which} passou no teste de tool calling: ${attempts.map((a) => `${a.id} (${a.error ?? 'não chamou a ferramenta'})`).join('; ')}`, attempts };
}

/** Linha de listagem: id, family, name e maxInputTokens. */
export const formatModel = (m: ModelInfo) => `${m.id.padEnd(28)} family=${m.family.padEnd(20)} name=${m.name} · maxInputTokens=${m.maxInputTokens}`;

// ---------------------------------------------------------------------------
// Escolha interativa (QuickPick) na avaliação
// ---------------------------------------------------------------------------

/** Família "mini" (ex.: gpt-4o-mini, o4-mini): recusada na avaliação salvo reactest.allowMiniModels. */
export const isMiniModel = (m: Pick<ModelInfo, 'family' | 'id'>) => /mini/i.test(m.family) || /mini/i.test(m.id);

/** Motivo de recusa do modelo para a avaliação, ou undefined se permitido. */
export function modelRefusal(m: Pick<ModelInfo, 'family' | 'id'>, allowMini: boolean): string | undefined {
  return !allowMini && isMiniModel(m) ? `família "${m.family}" é "mini" (habilite reactest.allowMiniModels para permitir)` : undefined;
}

export interface ModelPickItem<M extends ModelInfo> {
  model: M;
  label: string;
  description: string;
  detail: string;
  /** Pode ser escolhido (passou no teste de tool calling e não é recusado). */
  selectable: boolean;
  reason?: string;
}

/** Itens do QuickPick: family, se passou no teste de tool calling e se é recusado (mini). Selecionáveis primeiro. */
export function modelPickItems<M extends ModelInfo>(models: M[], probes: Map<string, ToolProbe>, allowMini: boolean): ModelPickItem<M>[] {
  const items = models.map((m): ModelPickItem<M> => {
    const refusal = modelRefusal(m, allowMini);
    const probe = probes.get(m.id);
    const reason = refusal ?? (probe && !probe.ok ? `tool calling NÃO suportado${probe.error ? `: ${probe.error}` : ''}` : probe ? undefined : 'não testado');
    return {
      model: m,
      label: `${reason ? '$(circle-slash)' : '$(check)'} ${m.family}`,
      description: `${m.id} · ${refusal ? 'recusado (mini)' : probe?.ok ? 'tool calling OK' : probe ? 'tool calling NÃO suportado' : 'não testado'}`,
      detail: `${m.name} · maxInputTokens=${m.maxInputTokens}${reason ? ` — ${reason}` : ''}`,
      selectable: !reason,
      ...(reason ? { reason } : {}),
    };
  });
  return [...items.filter((i) => i.selectable), ...items.filter((i) => !i.selectable)];
}
