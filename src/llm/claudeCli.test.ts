// ClaudeCliClient contra um executável `claude` FALSO posto no PATH (script Node que imita a saída
// JSON do `claude -p --output-format json`). Sem rede e sem a assinatura.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classifyInfraError } from '../core/llmErrors';
import { MeteredLLM } from '../core/metrics';
import type { LLMRequest, ToolSpec } from '../core/types';
import { buildPrompt, ClaudeCliClient, ClaudeCliError, ClaudeSafeguardError, extractJsonObject, parseModelReply, redactSecrets, resolveCommand, SAFEGUARD_RETRY_LINE } from './claudeCli';

/**
 * Fake: lê o roteiro (FAKE_CLAUDE_SCRIPT), consome uma resposta por chamada (contador em arquivo),
 * grava argv, cwd, stdin e horários em FAKE_CLAUDE_LOG e imprime o JSON de resultado.
 */
const FAKE = String.raw`
const fs = require('node:fs');
const script = JSON.parse(fs.readFileSync(process.env.FAKE_CLAUDE_SCRIPT, 'utf8'));
const counter = process.env.FAKE_CLAUDE_SCRIPT + '.n';
const n = fs.existsSync(counter) ? Number(fs.readFileSync(counter, 'utf8')) : 0;
fs.writeFileSync(counter, String(n + 1));
const step = script[Math.min(n, script.length - 1)];
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (stdin += d));
process.stdin.on('end', () => {
  const start = Date.now();
  setTimeout(() => {
    fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), cwdFiles: fs.readdirSync(process.cwd()), stdin, start, end: Date.now(), env: { CLAUDECODE: process.env.CLAUDECODE ?? null, OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? null } }) + '\n');
    if (step.stderr) process.stderr.write(step.stderr);
    if (step.raw !== undefined) process.stdout.write(step.raw);
    else process.stdout.write(JSON.stringify({ type: 'result', subtype: step.isError ? 'error' : 'success', is_error: !!step.isError, result: step.result, session_id: 'abc', total_cost_usd: step.cost, ...(step.usage ? { usage: step.usage } : {}) }));
    process.exitCode = step.exitCode ?? 0;
  }, step.delayMs ?? 0);
});
`;

interface Step {
  result?: string;
  usage?: Record<string, number>;
  cost?: number;
  delayMs?: number;
  isError?: boolean;
  exitCode?: number;
  stderr?: string;
  raw?: string;
}

let dir: string;
let binDir: string;
let scriptFile: string;
let logFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fake-claude-test-'));
  binDir = join(dir, 'bin');
  mkdirSync(binDir);
  // No Windows o spawn sem shell não roda .cmd: o fake é um script Node "claude.js" (o resolvedor
  // o executa com o node). Em POSIX também vale "claude.js".
  writeFileSync(join(binDir, 'claude.js'), FAKE);
  scriptFile = join(dir, 'script.json');
  logFile = join(dir, 'log.jsonl');
  writeFileSync(logFile, '');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH';
function client(steps: Step[], extra: { timeoutMs?: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {}) {
  writeFileSync(scriptFile, JSON.stringify(steps));
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    [pathKey]: `${binDir}${delimiter}${process.env[pathKey] ?? ''}`, // o fake vem ANTES do claude real
    FAKE_CLAUDE_SCRIPT: scriptFile,
    FAKE_CLAUDE_LOG: logFile,
    ...extra.env,
  };
  return new ClaudeCliClient({ env, ...(extra.timeoutMs ? { timeoutMs: extra.timeoutMs } : {}), ...(extra.signal ? { signal: extra.signal } : {}) });
}
const calls = () =>
  readFileSync(logFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { argv: string[]; cwd: string; cwdFiles: string[]; stdin: string; start: number; end: number; env: Record<string, string | null> });

const tools: ToolSpec[] = [
  { name: 'read_file', description: 'Lê um arquivo do workspace.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
];
const req: LLMRequest = {
  system: 'Você é o agente de Contexto.',
  messages: [
    { role: 'user', content: 'Analise src/Button.tsx' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'read_file', arguments: { path: 'src/Button.tsx' } }] },
    { role: 'tool', toolCallId: 'c1', name: 'read_file', content: 'export function Button() {}' },
  ],
  tools,
  tag: 'context',
};
const usage = { input_tokens: 10, cache_creation_input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 20 };

describe('ClaudeCliClient (executável falso no PATH)', () => {
  it('resposta com toolCalls: flags headless, cwd temporário vazio, prompt serializado e usage real', async () => {
    const c = client([{ result: '```json\n{"toolCalls":[{"name":"read_file","arguments":{"path":"src/api.ts"}}]}\n```', usage, cost: 0.0123 }]);
    const r = await c.complete(req);
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls![0]).toMatchObject({ name: 'read_file', arguments: { path: 'src/api.ts' } });
    expect(r.toolCalls![0]!.id).toMatch(/^cc_/);
    expect(r).toMatchObject({ inputTokens: 115, outputTokens: 20, costUsd: 0.0123 });
    expect(r.tokensEstimated).toBeUndefined();

    const [call] = calls();
    const argv = call!.argv;
    expect(argv.slice(0, 5)).toEqual(['-p', '--output-format', 'json', '--model', 'sonnet']);
    expect(argv).toContain('--no-session-persistence');
    expect(argv[argv.indexOf('--tools') + 1]).toBe(''); // nenhuma ferramenta interna do Claude Code
    expect(argv).toContain('--strict-mcp-config');
    expect(argv).toContain('--system-prompt');
    expect(call!.cwdFiles).toEqual([]); // pasta temporária vazia (sem CLAUDE.md nem repo)
    expect(call!.cwd).not.toContain('ia-eng-soft');
    expect(call!.env).toEqual({ CLAUDECODE: null, OPENAI_API_KEY: null });
    // tudo vai no stdin: system, ferramentas (com schema), histórico e formato exigido
    expect(call!.stdin).toContain('Você é o agente de Contexto.');
    expect(call!.stdin).toContain('## read_file');
    expect(call!.stdin).toContain('"required":["path"]');
    expect(call!.stdin).toContain('{"toolCalls":[{"name":"read_file","arguments":{"path":"src/Button.tsx"}}]}');
    expect(call!.stdin).toContain('## Resultado da ferramenta read_file (chamada c1)');
    expect(call!.stdin).toContain('Responda SOMENTE com UM objeto JSON');
  });

  it('resposta com text (string ou objeto JSON) e tokens estimados quando o CLI não manda usage', async () => {
    const c = client([{ result: '{"text":"pronto"}' }, { result: 'Claro! {"text":{"code":"it(1)"}} fim' }]);
    const a = await c.complete({ ...req, tools: undefined });
    expect(a.text).toBe('pronto');
    expect(a.toolCalls).toBeUndefined();
    expect(a.tokensEstimated).toBe(true);
    expect(a.inputTokens).toBeGreaterThan(0);
    const b = await c.complete(req);
    expect(JSON.parse(b.text)).toEqual({ code: 'it(1)' });

    const metered = new MeteredLLM(client([{ result: '{"text":"x"}' }]));
    await metered.complete({ ...req, tag: 'generator' });
    expect(metered.totals()).toMatchObject({ calls: 1, tokensEstimated: true });
  });

  it('JSON inválido: 1 nova tentativa com a mensagem de erro; inválido de novo → erro', async () => {
    const ok = client([{ result: 'não sei responder em JSON', usage }, { result: '{"text":"agora sim"}', usage }]);
    const r = await ok.complete(req);
    expect(r.text).toBe('agora sim');
    expect(r).toMatchObject({ inputTokens: 230, outputTokens: 40 }); // tokens das duas tentativas
    const [, retry] = calls();
    expect(retry!.stdin).toContain('# Correção necessária');
    expect(retry!.stdin).toContain('a resposta não contém um objeto JSON');
    expect(retry!.stdin).toContain('não sei responder em JSON');

    writeFileSync(logFile, '');
    rmSync(`${scriptFile}.n`, { force: true });
    const bad = client([{ result: '{"text": "sem fechar' }]);
    await expect(bad.complete(req)).rejects.toThrow(/fora do formato JSON exigido após 2 tentativa\(s\) \(agente "context"\)/);
    expect(calls()).toHaveLength(2);
  });

  it('ferramenta desconhecida: nunca executada, vira erro para o modelo corrigir', async () => {
    const c = client([
      { result: '{"toolCalls":[{"name":"Bash","arguments":{"command":"rm -rf /"}}]}' },
      { result: '{"toolCalls":[{"name":"read_file","arguments":{"path":"a.ts"}}]}' },
    ]);
    const r = await c.complete(req);
    expect(r.toolCalls!.map((t) => t.name)).toEqual(['read_file']);
    const [, retry] = calls();
    expect(retry!.stdin).toContain('ferramenta desconhecida "Bash" (não foi executada). Ferramentas válidas: read_file');

    rmSync(`${scriptFile}.n`, { force: true });
    await expect(client([{ result: '{"toolCalls":[{"name":"write_file","arguments":{}}]}' }]).complete(req)).rejects.toThrow(/ferramenta desconhecida "write_file"/);
  });

  it('timeout: o processo é encerrado e o erro é claro', async () => {
    const c = client([{ result: '{"text":"tarde demais"}', delayMs: 10_000 }], { timeoutMs: 400 });
    const t0 = Date.now();
    await expect(c.complete(req)).rejects.toThrow(/não respondeu em 0 s \(timeout\)/);
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  it('cancelamento (AbortSignal da extensão): encerra o processo do claude em andamento', async () => {
    const abort = new AbortController();
    const c = client([{ result: '{"text":"tarde demais"}', delayMs: 10_000 }], { signal: abort.signal });
    const t0 = Date.now();
    setTimeout(() => abort.abort(), 300);
    await expect(c.complete(req)).rejects.toThrow(/cancelada pelo usuário/);
    expect(Date.now() - t0).toBeLessThan(5_000);
    // chamadas seguintes com o mesmo sinal falham na hora, sem iniciar processo
    const t1 = Date.now();
    await expect(c.complete(req)).rejects.toThrow(/cancelada pelo usuário/);
    expect(Date.now() - t1).toBeLessThan(1_000);
  });

  it('no máximo 1 processo por vez (fila global entre instâncias)', async () => {
    const steps = [{ result: '{"text":"a"}', delayMs: 300 }];
    const [a, b] = [client(steps), client(steps)];
    await Promise.all([a.complete(req), b.complete(req), a.complete(req)]);
    const log = calls().sort((x, y) => x.start - y.start);
    expect(log).toHaveLength(3);
    for (let i = 1; i < log.length; i++) expect(log[i]!.start).toBeGreaterThanOrEqual(log[i - 1]!.end);
  });

  it('erro do CLI: nenhuma chave ou token aparece na mensagem; login/limite viram erro de infraestrutura', async () => {
    const key = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
    const c = client([{ raw: '', exitCode: 1, stderr: `Error: invalid x-api-key ${key}\nANTHROPIC_API_KEY=${key}\nAuthorization: Bearer abcdefghijklmnop1234` }]);
    const err = (await c.complete(req).catch((e: unknown) => e)) as ClaudeCliError;
    expect(err.message).toBe('o Claude Code não está logado ou a credencial foi recusada (rode "claude" no terminal e faça login)');
    for (const text of [err.message, err.rawText!]) {
      expect(text).not.toContain(key);
      expect(text).not.toContain('abcdefghijklmnop1234');
    }
    expect(err.rawText).toContain('[REDACTED]');
    expect(classifyInfraError(err.message)?.kind).toBe('auth');

    rmSync(`${scriptFile}.n`, { force: true });
    const limit = (await client([{ result: 'Claude AI usage limit reached|1764000000', isError: true, exitCode: 1 }]).complete(req).catch((e: unknown) => e)) as Error;
    expect(classifyInfraError(limit.message)?.kind).toBe('quota');
    rmSync(`${scriptFile}.n`, { force: true });
    const login = (await client([{ result: 'Not logged in · Please run /login', isError: true, exitCode: 1 }]).complete(req).catch((e: unknown) => e)) as Error;
    expect(classifyInfraError(login.message)?.kind).toBe('auth');
  });

  it('erro genérico do CLI: mensagem curta em pt-BR sem request ID/links; texto bruto completo em rawText (trace)', async () => {
    const raw = 'API Error: 500 {"type":"error","error":{"type":"api_error","message":"Internal server error"},"request_id":"req_011CXyz"} see https://docs.anthropic.com/errors';
    const err = (await client([{ result: raw, isError: true, exitCode: 1 }]).complete(req).catch((e: unknown) => e)) as ClaudeCliError;
    expect(err.message).toMatch(/^o Claude Code falhou \(código 1\): API Error: 500/);
    expect(err.message).not.toMatch(/req_011CXyz|https?:|request_id/);
    expect(err.message.length).toBeLessThan(220);
    expect(err.rawText).toBe(raw);
  });

  it('claude ausente do PATH: erro em pt-BR classificado como infraestrutura', async () => {
    const c = new ClaudeCliClient({ command: 'claude-inexistente-xyz', env: { [pathKey]: binDir } });
    await expect(c.complete(req)).rejects.toThrow(/comando "claude-inexistente-xyz" não encontrado no PATH/);
    expect(classifyInfraError('ClaudeCliError: comando "claude" não encontrado no PATH.')?.kind).toBe('no_model');
    expect(resolveCommand('claude', { [pathKey]: binDir })).toMatchObject({ file: process.execPath, script: true });
  });
});

describe('filtro de segurança do Claude (safeguards / reasoning_extraction)', () => {
  const flagged: Step = {
    result: 'API Error: 400 safeguards flagged this request [reasoning_extraction] (request_id: req_abc123) https://support.anthropic.com/x',
    isError: true,
    exitCode: 1,
  };
  const ok: Step = { result: '{"text":"pronto"}', usage };
  const modelOf = (argv: string[]) => argv[argv.indexOf('--model') + 1];
  const withLog = (steps: Step[], fallbackModel?: string) => {
    const lines: string[] = [];
    writeFileSync(scriptFile, JSON.stringify(steps));
    const env = { ...process.env, [pathKey]: `${binDir}${delimiter}${process.env[pathKey] ?? ''}`, FAKE_CLAUDE_SCRIPT: scriptFile, FAKE_CLAUDE_LOG: logFile };
    const c = new ClaudeCliClient({ env, onLog: (l) => lines.push(l), ...(fallbackModel !== undefined ? { fallbackModel } : {}) });
    return { c, lines };
  };

  it('1ª recusa → nova tentativa com o mesmo modelo e a linha neutra; sucesso sem fallback', async () => {
    const { c, lines } = withLog([flagged, ok]);
    const r = await c.complete(req);
    expect(r.text).toBe('pronto');
    expect(r.model).toBe('sonnet');
    const log = calls();
    expect(log.map((l) => modelOf(l.argv))).toEqual(['sonnet', 'sonnet']);
    expect(log[0]!.stdin.endsWith(SAFEGUARD_RETRY_LINE)).toBe(false);
    expect(log[1]!.stdin).toBe(`${log[0]!.stdin}\n\n${SAFEGUARD_RETRY_LINE}`); // mesmo prompt + linha neutra
    expect(r.notices).toHaveLength(1);
    expect(r.notices![0]).toContain('[reasoning_extraction]'); // texto bruto vai para o trace
    expect(lines).toEqual([
      'claude-cli [context]: o filtro de segurança recusou (modelo sonnet); nova tentativa com o mesmo modelo.',
      'claude-cli [context]: respondido pelo modelo sonnet.',
    ]);
  });

  it('2ª recusa → fallback para o modelo configurado (padrão opus), registrado no log e na resposta', async () => {
    const { c, lines } = withLog([flagged, flagged, ok]);
    const r = await c.complete(req);
    expect(r.model).toBe('opus');
    expect(calls().map((l) => modelOf(l.argv))).toEqual(['sonnet', 'sonnet', 'opus']);
    expect(calls()[2]!.stdin).toContain(SAFEGUARD_RETRY_LINE);
    expect(lines).toContain('claude-cli [context]: o filtro de segurança recusou (modelo sonnet); fallback para o modelo opus.');
    expect(lines.at(-1)).toBe('claude-cli [context]: respondido pelo modelo opus.');
    expect(r.notices).toHaveLength(2);
  });

  it('fallback também recusado → ClaudeSafeguardError curto em pt-BR; bruto (com request ID) só em rawText', async () => {
    const { c } = withLog([flagged, flagged, flagged], 'haiku');
    const err = (await c.complete(req).catch((e: unknown) => e)) as ClaudeSafeguardError;
    expect(err).toBeInstanceOf(ClaudeSafeguardError);
    expect(err.message).toBe('o filtro de segurança do Claude recusou a requisição (modelos sonnet, haiku)');
    expect(err.models).toEqual(['sonnet', 'haiku']);
    expect(err.rawText).toContain('req_abc123');
    expect(err.rawText).toContain('[haiku]');
    expect(calls().map((l) => modelOf(l.argv))).toEqual(['sonnet', 'sonnet', 'haiku']);
    expect(classifyInfraError(err.message)).toBeUndefined(); // não é infraestrutura: o run fica ERROR com a mensagem curta
  });

  it('fallbackModel vazio desativa o fallback (2 tentativas)', async () => {
    const { c } = withLog([flagged, flagged, ok], '');
    await expect(c.complete(req)).rejects.toBeInstanceOf(ClaudeSafeguardError);
    expect(calls()).toHaveLength(2);
  });

  it('na pipeline, o RunRecord guarda a mensagem curta e o .trace.jsonl o texto bruto', async () => {
    const { runPipeline } = await import('../core/pipeline');
    const ws = join(dir, 'ws');
    mkdirSync(join(ws, 'src'), { recursive: true });
    writeFileSync(join(ws, 'package.json'), '{"name":"ws"}');
    writeFileSync(join(ws, 'src', 'X.tsx'), 'export const X = () => null;\n');
    const { c } = withLog([flagged], '');
    const record = await runPipeline({
      workspaceRoot: ws,
      componentPath: 'src/X.tsx',
      config: { heal: false, elicit: false, verify: false, maxIterations: 0, maxAgentSteps: 4, model: 'sonnet', provider: 'claude-cli' },
      llm: c,
    });
    expect(record.status).toBe('ERROR');
    expect(record.error).toBe('ClaudeSafeguardError: o filtro de segurança do Claude recusou a requisição (modelo sonnet)');
    const trace = readFileSync(join(ws, '.reactest', 'runs', `${record.runId}.trace.jsonl`), 'utf8');
    expect(trace).toContain('[reasoning_extraction]');
    expect(trace).toContain('req_abc123');
  });
});

describe('peças puras', () => {
  it('extractJsonObject: cercas, texto ao redor e chaves dentro de strings', () => {
    expect(extractJsonObject('ok ```json\n{"a":1}\n``` fim')).toBe('{"a":1}');
    expect(extractJsonObject('x {"a":"}{","b":{"c":2}} y {"z":0}')).toBe('{"a":"}{","b":{"c":2}}');
    expect(extractJsonObject('nada')).toBeUndefined();
  });

  it('parseModelReply: envelope ausente vale como resposta final; {"name","arguments"} vale como chamada', () => {
    expect(parseModelReply('{"code":"x"}', tools)).toEqual({ text: '{"code":"x"}' });
    expect(parseModelReply('{"name":"read_file","arguments":{"path":"a"}}', tools).toolCalls![0]).toMatchObject({ name: 'read_file' });
    expect(() => parseModelReply('{"toolCalls":[{"name":"read_file","arguments":"a"}]}', tools)).toThrow(/arguments deve ser um objeto/);
    expect(() => parseModelReply('{"text":""}', tools)).toThrow(/vazio/);
  });

  it('buildPrompt sem ferramentas só oferece a forma {"text"}', () => {
    const p = buildPrompt({ system: 's', messages: [{ role: 'user', content: 'u' }], tag: 't' });
    expect(p).not.toContain('toolCalls');
    expect(p).toContain('{"text":"<sua resposta>"}');
  });

  it('redactSecrets', () => {
    expect(redactSecrets('OPENAI_API_KEY=sk-proj-1234567890abcdefXYZ e "apiKey": "segredo"')).toBe('OPENAI_API_KEY=[REDACTED] e "apiKey": "[REDACTED]"');
    expect(redactSecrets('token sk-ant-oat01-abcdefghijk')).toBe('token sk-ant-[REDACTED]');
    expect(redactSecrets('sem segredos aqui')).toBe('sem segredos aqui');
  });
});
