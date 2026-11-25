// Classificação de erros de infraestrutura do provedor de LLM (não são falhas da pipeline).
// O SDK da OpenAI formata APIError como "<status> <mensagem>" e já faz retentativas
// (429/conexão) antes de lançar — então um erro destes aqui é persistente.

export type InfraErrorKind = 'quota' | 'auth' | 'rate_limit' | 'network';

export interface InfraError {
  kind: InfraErrorKind;
  /** Descrição curta em pt-BR. */
  label: string;
}

const RULES: [InfraErrorKind, string, RegExp][] = [
  ['quota', 'sem créditos/cota na conta do provedor (HTTP 429 insufficient_quota)', /insufficient_quota|exceeded your current quota|billing details|out of credits/i],
  ['auth', 'chave de API recusada (HTTP 401)', /(^|:\s*)401\s|incorrect api key|invalid api key|invalid_api_key|OPENAI_API_KEY não definida/i],
  ['rate_limit', 'limite de requisições persistente (HTTP 429)', /(^|:\s*)429\s|rate limit/i],
  ['network', 'erro de rede persistente', /connection error|request timed out|fetch failed|socket hang up|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN/i],
];

/** Erro de infraestrutura (cota, autenticação, rate limit ou rede) ou undefined. */
export function classifyInfraError(message: string | undefined): InfraError | undefined {
  if (!message) return undefined;
  for (const [kind, label, re] of RULES) if (re.test(message)) return { kind, label };
  return undefined;
}
