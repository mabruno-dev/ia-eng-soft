import { type CallExpression, Node, Project, type SourceFile, SyntaxKind, ts } from 'ts-morph';
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

// ---------------------------------------------------------------------------
// Guardrail do oráculo: checkRepair(antes, depois) — análise por AST (ts-morph).
// O Reparador não pode "curar" um teste apagando asserções, pulando testes ou afrouxando expectativas.
// ---------------------------------------------------------------------------

const TEST_FNS = new Set(['it', 'test']);
const SUITE_FNS = new Set(['describe']);
const FOCUS_SKIP_FNS = new Set(['xit', 'xtest', 'xdescribe', 'fit', 'fdescribe']);
const FORBIDDEN_PROPS = new Set(['skip', 'only', 'todo']);
const TRIVIAL_MATCHERS = new Set(['toBeTruthy', 'toBeDefined']);
/** Matchers que só são triviais quando negados: expect(x).not.toBeNull(), .not.toBeUndefined(), .not.toBeFalsy(). */
const TRIVIAL_NEGATED_MATCHERS = new Set(['toBeNull', 'toBeUndefined', 'toBeFalsy']);
const OUTSIDE_TESTS = '(fora de it/test)';

export interface AssertionInfo {
  /** Texto da asserção, ex.: expect(screen.getByRole('status')).toHaveTextContent('Ok'). */
  text: string;
  matcher: string | null;
  trivial: boolean;
}
export interface TestCaseInfo {
  /** Nome completo: describe > ... > it (com sufixo #n se repetido). */
  name: string;
  assertions: AssertionInfo[];
}
export interface TestCodeAnalysis {
  expectCalls: number;
  testCases: number;
  /** Ocorrências de .skip/.only/.todo/xit/xtest/xdescribe/fit/fdescribe (ex.: "it.skip", "xit"). */
  forbidden: string[];
  tests: TestCaseInfo[];
}

let guardProject: Project | undefined;
function parseTest(code: string): SourceFile {
  guardProject ??= new Project({ useInMemoryFileSystem: true, compilerOptions: { jsx: ts.JsxEmit.ReactJSX, allowJs: true } });
  return guardProject.createSourceFile('/__guard__.test.tsx', code, { overwrite: true });
}

/** Desce por a.b.c(...)(...) até o identificador raiz. Ex.: it.each(t)('x') → { root: 'it', props: ['each'] }. */
function calleeChain(expr: Node): { root: string | null; props: string[] } {
  const props: string[] = [];
  let e: Node = expr;
  while (true) {
    if (Node.isPropertyAccessExpression(e)) {
      props.unshift(e.getName());
      e = e.getExpression();
    } else if (Node.isCallExpression(e) || Node.isNonNullExpression(e) || Node.isParenthesizedExpression(e)) {
      e = e.getExpression();
    } else break;
  }
  return { root: Node.isIdentifier(e) ? e.getText() : null, props };
}

function stringArg(call: CallExpression): string | null {
  const a = call.getArguments()[0];
  if (!a) return null;
  if (Node.isStringLiteral(a) || Node.isNoSubstitutionTemplateLiteral(a)) return a.getLiteralText();
  if (Node.isTemplateExpression(a)) return a.getText().slice(1, -1);
  return null;
}

/** Chamada que define um caso de teste executável (it/test com nome; skip/todo não contam). */
function isTestCall(call: CallExpression): boolean {
  const { root, props } = calleeChain(call.getExpression());
  if (!root || !TEST_FNS.has(root)) return false;
  if (props.includes('skip') || props.includes('todo')) return false;
  return stringArg(call) !== null;
}

function isSuiteCall(call: CallExpression): boolean {
  const { root } = calleeChain(call.getExpression());
  return !!root && SUITE_FNS.has(root) && stringArg(call) !== null;
}

/** `it.each(t)` dentro de `it.each(t)('x', fn)`: a chamada interna de uma cadeia curried. */
function isInnerCurriedCall(call: CallExpression): boolean {
  const parent = call.getParent();
  return !!parent && Node.isCallExpression(parent) && parent.getExpression() === call;
}

const isExpectCall = (call: CallExpression) => {
  const callee = call.getExpression();
  return Node.isIdentifier(callee) && callee.getText() === 'expect';
};

const LITERAL_SUBJECT = /^(?:true|false|null|undefined|-?\d+(?:\.\d+)?|'[^']*'|"[^"]*"|`[^`$]*`)$/;

function describeAssertion(expectCall: CallExpression): AssertionInfo {
  const subject = (expectCall.getArguments()[0]?.getText() ?? '').trim();
  const mods: string[] = [];
  let node: Node = expectCall;
  let top: Node = expectCall;
  let matcher: string | null = null;
  let matcherArgs: string[] = [];
  while (true) {
    const parent = node.getParent();
    if (!parent || !Node.isPropertyAccessExpression(parent) || parent.getExpression() !== node) break;
    const grand = parent.getParent();
    if (grand && Node.isCallExpression(grand) && grand.getExpression() === parent) {
      matcher = parent.getName();
      matcherArgs = grand.getArguments().map((a) => a.getText().trim());
      top = grand;
      break;
    }
    mods.push(parent.getName()); // not / resolves / rejects
    node = parent;
    top = parent;
  }
  const negated = mods.includes('not');
  const trivial =
    matcher === null ||
    subject === '' ||
    LITERAL_SUBJECT.test(subject) ||
    (!negated && TRIVIAL_MATCHERS.has(matcher)) ||
    (negated && TRIVIAL_NEGATED_MATCHERS.has(matcher)) ||
    matcherArgs.some((a) => a === 'expect.anything()') ||
    (matcherArgs.length === 1 && matcherArgs[0] === subject); // expect(x).toBe(x)
  return { text: top.getText().replace(/\s+/g, ' '), matcher, trivial };
}

/** Analisa um arquivo de teste: nº de expect(, casos it/test, usos proibidos e asserções por teste. */
export function analyzeTestCode(code: string): TestCodeAnalysis {
  const sf = parseTest(code);
  const calls = sf.getDescendantsOfKind(SyntaxKind.CallExpression);
  const forbidden: string[] = [];
  const testNodes = new Map<CallExpression, TestCaseInfo>();
  const seen = new Map<string, number>();
  let expectCalls = 0;

  for (const call of calls) {
    const callee = call.getExpression();
    const { root, props } = calleeChain(callee);
    if (root && !isInnerCurriedCall(call)) {
      if (FOCUS_SKIP_FNS.has(root)) forbidden.push(root);
      else if (TEST_FNS.has(root) || SUITE_FNS.has(root)) {
        const bad = props.find((p) => FORBIDDEN_PROPS.has(p));
        if (bad) forbidden.push(`${root}.${bad}`);
      }
    }
    if (isExpectCall(call)) expectCalls++;
    if (isTestCall(call)) {
      const path = call
        .getAncestors()
        .filter((a): a is CallExpression => Node.isCallExpression(a) && isSuiteCall(a))
        .reverse()
        .map((a) => stringArg(a)!);
      let name = [...path, stringArg(call)!].join(' > ');
      const n = (seen.get(name) ?? 0) + 1;
      seen.set(name, n);
      if (n > 1) name = `${name} #${n}`;
      testNodes.set(call, { name, assertions: [] });
    }
  }

  const outside: TestCaseInfo = { name: OUTSIDE_TESTS, assertions: [] };
  for (const call of calls) {
    if (!isExpectCall(call)) continue;
    const owner = call.getAncestors().find((a): a is CallExpression => Node.isCallExpression(a) && testNodes.has(a));
    (owner ? testNodes.get(owner)! : outside).assertions.push(describeAssertion(call));
  }
  const tests = [...testNodes.values()];
  if (outside.assertions.length) tests.push(outside);
  return { expectCalls, testCases: testNodes.size, forbidden, tests };
}

export interface RepairCheck {
  ok: boolean;
  violations: string[];
}

const countBy = (xs: string[]) => xs.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map<string, number>());
const specificCount = (as: AssertionInfo[]) => as.filter((x) => !x.trivial).length;
const trivialCount = (as: AssertionInfo[]) => as.filter((x) => x.trivial).length;

/**
 * Guardrail do oráculo (regra 5 do CLAUDE.md). Rejeita o patch `after` se, em relação a `before`:
 *  (a) o nº de chamadas expect( diminuir;
 *  (b) o nº de casos it/test diminuir (it.skip/it.todo não contam como caso);
 *  (c) surgir .skip, .only, .todo, xit, xtest, xdescribe, fit ou fdescribe;
 *  (d) uma asserção específica for trocada por uma trivial (toBeTruthy, toBeDefined, expect(true)...),
 *      comparando teste a teste pelo nome completo (com fallback global para testes renomeados).
 */
export function checkRepair(before: string, after: string): RepairCheck {
  const a = analyzeTestCode(before);
  const b = analyzeTestCode(after);
  const violations: string[] = [];

  if (b.expectCalls < a.expectCalls) {
    violations.push(`o número de asserções expect( diminuiu de ${a.expectCalls} para ${b.expectCalls}; é proibido apagar asserções`);
  }
  if (b.testCases < a.testCases) {
    violations.push(`o número de casos it/test diminuiu de ${a.testCases} para ${b.testCases}; é proibido apagar ou desativar testes`);
  }
  const fa = countBy(a.forbidden);
  for (const [what, n] of countBy(b.forbidden)) {
    if (n > (fa.get(what) ?? 0)) violations.push(`uso proibido de ${what}: pular, focar ou adiar testes não é reparo`);
  }

  const beforeTests = new Map(a.tests.map((t) => [t.name, t]));
  let flagged = false;
  for (const t of b.tests) {
    const old = beforeTests.get(t.name);
    if (!old) continue;
    if (specificCount(t.assertions) < specificCount(old.assertions) && trivialCount(t.assertions) > trivialCount(old.assertions)) {
      flagged = true;
      const lost = old.assertions.find((x) => !x.trivial && !t.assertions.some((y) => y.text === x.text));
      const added = t.assertions.find((x) => x.trivial && !old.assertions.some((y) => y.text === x.text));
      violations.push(
        `no teste "${t.name}", uma asserção específica foi trocada por uma trivial` +
          (lost ? `: ${lost.text}` : '') +
          (added ? ` → ${added.text}` : ''),
      );
    }
  }
  if (!flagged) {
    const all = (x: TestCodeAnalysis) => x.tests.flatMap((t) => t.assertions);
    if (specificCount(all(b)) < specificCount(all(a)) && trivialCount(all(b)) > trivialCount(all(a))) {
      violations.push(
        `asserções específicas foram trocadas por triviais (específicas ${specificCount(all(a))} → ${specificCount(all(b))}; triviais ${trivialCount(all(a))} → ${trivialCount(all(b))})`,
      );
    }
  }
  return { ok: violations.length === 0, violations };
}
