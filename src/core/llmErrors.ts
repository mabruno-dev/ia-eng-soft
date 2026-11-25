// Classificação de erros de infraestrutura do provedor de LLM (não são falhas da pipeline).
// O SDK da OpenAI formata APIError como "<status> <mensagem>" e já faz retentativas
// (429/conexão) antes de lançar. Para o Copilot (vscode.lm), withRateLimitRetry faz as
// retentativas — então um erro destes que chega à pipeline é persistente.

export type InfraErrorKind = 'quota' | 'auth' | 'rate_limit' | 'network' | 'no_model';

export interface InfraError {
  kind: InfraErrorKind;
  /** Descrição curta em pt-BR. */
  label: string;
}

const RULES: [InfraErrorKind, string, RegExp][] = [
  ['quota', 'sem créditos/cota no provedor (HTTP 429 insufficient_quota / quota)', /insufficient_quota|exceeded your current quota|billing details|out of credits|\bquota\b/i],
  ['no_model', 'nenhum modelo de linguagem disponível', /Nenhum modelo de linguagem do Copilot|no (?:language )?models? (?:are )?available/i],
  ['auth', 'acesso ao modelo recusado (HTTP 401 / sem permissão)', /(^|:\s*)401\s|incorrect api key|invalid api key|invalid_api_key|OPENAI_API_KEY não definida|NoPermissions/i],
  ['rate_limit', 'limite de requisições persistente (HTTP 429 / rate limit)', /(^|:\s*)429\s|rate.?limit|too many requests/i],
  ['network', 'erro de rede persistente', /connection error|request timed out|fetch failed|socket hang up|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN/i],
];

/** Erro de infraestrutura (cota, autenticação, rate limit, rede ou sem modelo) ou undefined. */
export function classifyInfraError(message: string | undefined): InfraError | undefined {
  if (!message) return undefined;
  for (const [kind, label, re] of RULES) if (re.test(message)) return { kind, label };
  return undefined;
}

/** Só limite de taxa vale nova tentativa (cota, autenticação e ausência de modelo não melhoram esperando). */
export const isRateLimitError = (err: unknown): boolean =>
  classifyInfraError(err instanceof Error ? err.message : String(err))?.kind === 'rate_limit';
