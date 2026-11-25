import type { ExecResult, FailureCategory } from './types';

// Classificação determinística de falhas do Jest (fallback / verificação cruzada do Executor).
// A ordem importa: a primeira categoria cujo padrão casar vence.
const PATTERNS: [Exclude<FailureCategory, 'UNKNOWN'>, RegExp[]][] = [
  [
    'IMPORT',
    [
      /Cannot find module/i,
      /is not exported/i,
      /has no exported member/i, // TS2305 / TS2614
      /does not provide an export named/i,
      /Could not locate module .* mapped as/i,
    ],
  ],
  ['SYNTAX_TYPE', [/\bSyntaxError\b/, /\bTS\d{4}\b/, /Unexpected token/]],
  [
    'MOCK',
    [
      /\bjest\.mock\b/,
      /\bmock(?:Resolved|Rejected|Return)Value(?:Once)?\b.* is not a function/,
      /\bmockImplementation(?:Once)?\b.* is not a function/,
      /\bjest\.mocked\b/,
      /\(0\s*,\s*[\w$]+\.[\w$]+\) is not a function/, // função importada de módulo mockado sem implementação
      /\b[\w$]*(?:api|Api|API|service|Service)[\w$]*\.[\w$]+ is not a function/,
      /received value must be a mock or spy function/,
    ],
  ],
  [
    'ASYNC',
    [/not wrapped in act/, /Unable to find/, /\bwaitFor\b/, /Timeout|timeout of \d+ ?ms|Exceeded timeout/],
  ],
  [
    'ASSERTION',
    [/expect\((?:received|element)\)/, /\.(?:not\.)?toBe\b/, /\btoEqual\b/, /\btoHaveBeenCalled\w*/, /Expected:[\s\S]*Received:/],
  ],
];

/** Texto onde a classificação procura: erro de suíte + mensagens de falha (ou a saída bruta, se não houver nada). */
function failureText(exec: ExecResult): string {
  const parts = [exec.suiteError ?? '', ...exec.failures.map((f) => f.message)].filter(Boolean);
  return parts.length ? parts.join('\n') : exec.rawOutput;
}

/** Categoria de falha por regex. `null` quando a execução passou. */
export function classifyFailure(exec: ExecResult): FailureCategory | null {
  if (exec.passed) return null;
  const text = failureText(exec);
  for (const [category, res] of PATTERNS) {
    if (res.some((re) => re.test(text))) return category;
  }
  return 'UNKNOWN';
}

export interface CrossCheck {
  llmCategory: FailureCategory | null;
  regexCategory: FailureCategory | null;
  final: FailureCategory | null;
  overridden: boolean;
  note?: string;
}

/**
 * Verificação cruzada da categoria do LLM contra o regex. O código decide:
 *  - passou → categoria null (o LLM não pode inventar falha);
 *  - falhou e o LLM disse null → usa o regex;
 *  - falhou, LLM disse UNKNOWN e o regex achou algo específico → usa o regex;
 *  - suíte nem rodou (suiteError) e o regex diz IMPORT/SYNTAX_TYPE, mas o LLM diz ASSERTION/ASYNC → usa o regex
 *    (asserções e esperas não podem falhar se nenhum teste rodou);
 *  - demais divergências: mantém o LLM (ele leu a saída inteira) e registra.
 */
export function crossCheckCategory(llmCategory: FailureCategory | null, exec: ExecResult): CrossCheck {
  const regexCategory = classifyFailure(exec);
  const base = { llmCategory, regexCategory };
  if (exec.passed) {
    return llmCategory === null
      ? { ...base, final: null, overridden: false }
      : { ...base, final: null, overridden: true, note: `execução passou; categoria "${llmCategory}" do LLM descartada` };
  }
  if (llmCategory === null) {
    return { ...base, final: regexCategory, overridden: true, note: `há falhas mas o LLM não deu categoria; usado o regex (${regexCategory})` };
  }
  if (llmCategory === regexCategory) return { ...base, final: llmCategory, overridden: false };
  if (llmCategory === 'UNKNOWN' && regexCategory !== 'UNKNOWN') {
    return { ...base, final: regexCategory, overridden: true, note: `LLM disse UNKNOWN; regex identificou ${regexCategory}` };
  }
  if (
    exec.suiteError &&
    exec.numTests === 0 &&
    (regexCategory === 'IMPORT' || regexCategory === 'SYNTAX_TYPE') &&
    (llmCategory === 'ASSERTION' || llmCategory === 'ASYNC')
  ) {
    return {
      ...base,
      final: regexCategory,
      overridden: true,
      note: `nenhum teste rodou (suiteError); "${llmCategory}" é incompatível, usado o regex (${regexCategory})`,
    };
  }
  return { ...base, final: llmCategory, overridden: false, note: `divergência: LLM=${llmCategory}, regex=${regexCategory}; mantido o LLM` };
}
