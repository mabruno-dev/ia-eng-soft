// Provedor "claude-cli": usa o Claude Code (`claude`, já logado com a assinatura) em modo headless.
// O CLI não expõe tool calling para ferramentas externas, então ele é EMULADO: o system prompt, o
// histórico e as ToolSpecs vão serializados num único prompt (stdin) e o modelo responde SOMENTE
// em JSON — {"toolCalls":[...]} ou {"text":"..."}. O parser é tolerante e confere os nomes das
// ferramentas contra as ToolSpecs; ferramenta desconhecida nunca chega a ser executada.
import { spawn } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, extname, isAbsolute, join } from 'node:path';
import type { LLMClient, LLMRequest, LLMResponse, ToolCall, ToolSpec } from '../core/types';

export const CLAUDE_CLI_DEFAULT_MODEL = 'sonnet';
/** Modelo usado quando o filtro de segurança recusa o modelo configurado duas vezes. */
export const CLAUDE_CLI_FALLBACK_MODEL = 'opus';
export const CLAUDE_CLI_TIMEOUT_MS = 180_000;
/** Linha neutra acrescentada ao prompt na nova tentativa após uma recusa do filtro de segurança. */
export const SAFEGUARD_RETRY_LINE = 'Responda apenas com o JSON pedido, sem comentários.';
const SAFEGUARD_RE = /safeguards|reasoning_extraction/i;

export interface ClaudeCliClientOptions {
  /** Modelo do Claude Code (alias como 'sonnet'/'opus' ou nome completo). Padrão: 'sonnet'. */
  model?: string;
  /** Executável (procurado no PATH se não tiver caminho). Padrão: 'claude'. */
  command?: string;
  /** Tempo máximo de cada processo `claude` (ms). Padrão: 180 s. */
  timeoutMs?: number;
  /** Novas tentativas quando a resposta não é o JSON exigido (padrão: 1). */
  formatRetries?: number;
  /** Ambiente do processo (padrão: process.env). O PATH dele é usado para achar o executável. */
  env?: NodeJS.ProcessEnv;
  /** Interrompe o processo em andamento (ex.: cancelamento na extensão). */
  signal?: AbortSignal;
  /** Modelo de fallback após 2 recusas do filtro de segurança (padrão: 'opus'; '' desativa). */
  fallbackModel?: string;
  /** Avisos curtos em pt-BR (recusa do filtro, nova tentativa, fallback). Nunca recebe segredos. */
  onLog?: (line: string) => void;
}

// ---------------------------------------------------------------------------
// Segredos: nada que pareça chave/token sai em mensagens de erro ou logs.
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: [RegExp, string][] = [
  [/sk-ant-[A-Za-z0-9_-]{8,}/g, 'sk-ant-[REDACTED]'],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, 'sk-[REDACTED]'],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [REDACTED]'],
  [/\b([A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)\s*[=:]\s*["']?[^\s"',;]+/gi, '$1=[REDACTED]'],
  [/("(?:[a-z_]*(?:api_?key|token|secret|password|authorization)[a-z_]*)"\s*:\s*)"[^"]*"/gi, '$1"[REDACTED]"'],
  [/\b(x-api-key|authorization)\s*:\s*\S+/gi, '$1: [REDACTED]'],
];

/** Mascara chaves de API, tokens OAuth/Bearer e pares NOME_DA_CHAVE=valor. */
export function redactSecrets(s: string): string {
  let out = s;
  for (const [re, rep] of SECRET_PATTERNS) out = out.replace(re, rep);
  return out;
}

/** Erro do provider: `message` curta em pt-BR (vai para a UI e o RunRecord); `rawText` bruto (só no trace). */
export class ClaudeCliError extends Error {
  readonly rawText?: string;
  constructor(message: string, rawText?: string) {
    super(redactSecrets(message));
    this.name = 'ClaudeCliError';
    if (rawText) this.rawText = redactSecrets(rawText);
  }
}

/** O filtro de segurança do Claude recusou a requisição ("safeguards flagged … [reasoning_extraction]"). */
export class ClaudeSafeguardError extends ClaudeCliError {
  readonly models: string[];
  constructor(models: string[], rawText: string) {
    super(`o filtro de segurança do Claude recusou a requisição (modelo${models.length > 1 ? 's' : ''} ${models.join(', ')})`, rawText);
    this.name = 'ClaudeSafeguardError';
    this.models = models;
  }
}

/** Mensagem curta em pt-BR para uma falha do CLI (sem request ID nem links); o texto bruto vai em rawText. */
export function cliErrorMessage(code: number | null, raw: string): string {
  if (/not logged in|please run \/login|invalid api key|invalid x-api-key|authentication_error|oauth token/i.test(raw)) {
    return 'o Claude Code não está logado ou a credencial foi recusada (rode "claude" no terminal e faça login)';
  }
  if (/usage limit|limit reached|credit balance/i.test(raw)) return 'limite de uso da assinatura do Claude atingido (usage limit reached)';
  if (/rate.?limit|\b429\b|too many requests/i.test(raw)) return 'limite de requisições do Claude (rate limit)';
  if (/overloaded|\b529\b/i.test(raw)) return 'o Claude está sobrecarregado (overloaded); tente mais tarde';
  const first = raw.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? 'sem saída';
  const clean = first
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[([{]?\s*"?request[_ -]?id"?\s*[:=]\s*"?[\w-]+"?\s*[)\]}]?/gi, '')
    .replace(/\breq_[A-Za-z0-9]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return `o Claude Code falhou (código ${code ?? 'sinal'}): ${clean.length > 160 ? `${clean.slice(0, 160)}…` : clean}`;
}

// ---------------------------------------------------------------------------
// Prompt (tool calling emulado)
// ---------------------------------------------------------------------------

/** System prompt curto do processo `claude` (substitui o do Claude Code; o papel do agente vai no prompt). */
export const CLI_SYSTEM_PROMPT =
  'Você é o motor de linguagem de uma pipeline automatizada. Você NÃO tem ferramentas próprias e não acessa arquivos: ' +
  'quando precisar de uma ferramenta, peça a chamada no formato JSON indicado e o resultado virá na próxima rodada. ' +
  'Responda SEMPRE e SOMENTE com um único objeto JSON válido, sem texto antes ou depois.';

const replyFormat = (tools: ToolSpec[] | undefined): string => {
  const lines = ['# Formato da resposta (OBRIGATÓRIO)', 'Responda SOMENTE com UM objeto JSON (sem cercas ```, sem texto fora dele), em uma destas formas:'];
  if (tools?.length) {
    lines.push('- Para chamar ferramenta(s): {"toolCalls":[{"name":"<nome da ferramenta>","arguments":{...}}]}');
    lines.push(`  Use apenas estas ferramentas: ${tools.map((t) => t.name).join(', ')}. "arguments" deve seguir o JSON Schema da ferramenta.`);
  }
  lines.push('- Para a resposta final: {"text":"<sua resposta>"}. Se a resposta final pedida for um objeto JSON, coloque o objeto diretamente em "text" (ex.: {"text":{"campo":1}}).');
  return lines.join('\n');
};

const toolCallsJson = (calls: ToolCall[]) => JSON.stringify({ toolCalls: calls.map((c) => ({ name: c.name, arguments: c.arguments })) });

/** Serializa system prompt, histórico e ToolSpecs num único prompt. */
export function buildPrompt(req: LLMRequest): string {
  const parts: string[] = [];
  if (req.system.trim()) parts.push(`# Instruções do sistema\n${req.system.trim()}`);
  if (req.tools?.length) {
    parts.push(
      '# Ferramentas disponíveis\n' +
        req.tools.map((t) => `## ${t.name}\n${t.description}\nParâmetros (JSON Schema): ${JSON.stringify(t.parameters)}`).join('\n\n'),
    );
  }
  const conv = req.messages.map((m) => {
    if (m.role === 'tool') return `## Resultado da ferramenta ${m.name} (chamada ${m.toolCallId})\n${m.content}`;
    if (m.role === 'user') return `## Usuário\n${m.content}`;
    return `## Assistente\n${m.toolCalls?.length ? toolCallsJson(m.toolCalls) : JSON.stringify({ text: m.content })}`;
  });
  parts.push(`# Conversa\n${conv.join('\n\n')}`);
  parts.push(replyFormat(req.tools));
  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Parser tolerante
// ---------------------------------------------------------------------------

/** Remove cercas ``` e devolve o primeiro objeto JSON balanceado do texto (respeitando strings). */
export function extractJsonObject(raw: string): string | undefined {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const s = fenced ? fenced[1]! : raw;
  const start = s.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return s.slice(start, i + 1);
  }
  return undefined;
}

export class ReplyFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplyFormatError';
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

let callSeq = 0;
const nextCallId = () => `cc_${Date.now().toString(36)}_${++callSeq}`;

/** Interpreta a resposta do modelo: {"toolCalls":[...]} | {"text":...}. Lança ReplyFormatError (mensagem vai ao modelo). */
export function parseModelReply(raw: string, tools: ToolSpec[] | undefined): { text: string; toolCalls?: ToolCall[] } {
  const json = extractJsonObject(raw);
  if (!json) throw new ReplyFormatError('a resposta não contém um objeto JSON');
  let obj: unknown;
  try {
    obj = JSON.parse(json);
  } catch (err) {
    throw new ReplyFormatError(`JSON inválido (${err instanceof Error ? err.message : String(err)})`);
  }
  if (!isObject(obj)) throw new ReplyFormatError('a resposta deve ser um objeto JSON');
  const names = new Set((tools ?? []).map((t) => t.name));
  const valid = names.size ? [...names].join(', ') : '(nenhuma ferramenta disponível nesta etapa)';

  // Tolerância: {"name":"<ferramenta>","arguments":{...}} sozinho vale como uma chamada.
  const rawCalls = Array.isArray(obj.toolCalls) ? obj.toolCalls : typeof obj.name === 'string' && names.has(obj.name) && !('text' in obj) ? [obj] : undefined;
  if (rawCalls?.length) {
    const toolCalls = rawCalls.map((c, i): ToolCall => {
      if (!isObject(c) || typeof c.name !== 'string') throw new ReplyFormatError(`toolCalls[${i}] deve ser {"name": string, "arguments": objeto}`);
      if (!names.has(c.name)) throw new ReplyFormatError(`ferramenta desconhecida "${c.name}" (não foi executada). Ferramentas válidas: ${valid}`);
      const args = c.arguments ?? {};
      if (!isObject(args)) throw new ReplyFormatError(`toolCalls[${i}].arguments deve ser um objeto JSON`);
      return { id: nextCallId(), name: c.name, arguments: args };
    });
    const text = typeof obj.text === 'string' ? obj.text : '';
    return { text, toolCalls };
  }
  if ('text' in obj) {
    const t = obj.text;
    if (typeof t === 'string') {
      if (!t.trim()) throw new ReplyFormatError('"text" está vazio');
      return { text: t };
    }
    if (isObject(t) || Array.isArray(t)) return { text: JSON.stringify(t) };
    throw new ReplyFormatError('"text" deve ser uma string (ou o objeto JSON da resposta final)');
  }
  if (Array.isArray(obj.toolCalls)) throw new ReplyFormatError('"toolCalls" está vazio');
  // Objeto sem envelope: é a própria resposta final em JSON (a validação do agente decide se serve).
  return { text: json };
}

// ---------------------------------------------------------------------------
// Saída JSON do `claude -p --output-format json`
// ---------------------------------------------------------------------------

export interface CliResult {
  result: string;
  isError: boolean;
  inputTokens?: number;
  outputTokens?: number;
  costUsd?: number;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

/** Lê o objeto de resultado do CLI (também aceita a forma em array de mensagens). */
export function parseCliOutput(stdout: string): CliResult {
  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    const obj = extractJsonObject(stdout);
    try {
      data = obj ? JSON.parse(obj) : undefined;
    } catch {
      data = undefined;
    }
  }
  if (Array.isArray(data)) data = [...data].reverse().find((m) => isObject(m) && m.type === 'result');
  if (!isObject(data)) throw new ClaudeCliError(`saída do claude não é o JSON esperado (--output-format json): ${stdout.slice(0, 300)}`);
  const usage = isObject(data.usage) ? data.usage : undefined;
  const input = usage ? (num(usage.input_tokens) ?? 0) + (num(usage.cache_creation_input_tokens) ?? 0) + (num(usage.cache_read_input_tokens) ?? 0) : undefined;
  const output = usage ? num(usage.output_tokens) : undefined;
  const costUsd = num(data.total_cost_usd) ?? num(data.cost_usd);
  return {
    result: typeof data.result === 'string' ? data.result : '',
    isError: data.is_error === true || (typeof data.subtype === 'string' && data.subtype !== 'success'),
    ...(usage && input !== undefined ? { inputTokens: input } : {}),
    ...(output !== undefined ? { outputTokens: output } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

// ---------------------------------------------------------------------------
// Processo
// ---------------------------------------------------------------------------

const pathOf = (env: NodeJS.ProcessEnv) => env[Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'] ?? '';
const SCRIPT_EXT = new Set(['.js', '.mjs', '.cjs']);

/**
 * Resolve o executável sem shell: procura no PATH (no Windows: .exe e scripts Node .js/.mjs).
 * Shims .cmd/.bat (instalação via npm no Windows) só rodariam com shell — erro com instrução.
 */
export function resolveCommand(command: string, env: NodeJS.ProcessEnv): { file: string; prefixArgs: string[]; script: boolean } {
  const exts = process.platform === 'win32' ? ['.exe', '.js', '.mjs', '.cmd', '.bat'] : ['', '.js', '.mjs'];
  const isFile = (p: string) => {
    try {
      return statSync(p).isFile();
    } catch {
      return false;
    }
  };
  let found: string | undefined;
  if (isAbsolute(command) || /[\\/]/.test(command)) {
    found = [command, ...exts.map((e) => command + e)].find(isFile);
  } else {
    for (const dir of pathOf(env).split(delimiter).filter(Boolean)) {
      found = exts.map((e) => join(dir, command + e)).find(isFile);
      if (found) break;
    }
  }
  if (!found) {
    throw new ClaudeCliError(`comando "${command}" não encontrado no PATH. Instale o Claude Code (build nativo: "claude install") e faça login com "claude" uma vez.`);
  }
  const ext = extname(found).toLowerCase();
  if (ext === '.cmd' || ext === '.bat') {
    throw new ClaudeCliError(`"${found}" é um script ${ext} e não pode ser executado sem shell. Instale o build nativo do Claude Code ("claude install").`);
  }
  if (SCRIPT_EXT.has(ext)) return { file: process.execPath, prefixArgs: [found], script: true };
  return { file: found, prefixArgs: [], script: false };
}

/** Fila global: no máximo 1 processo `claude` por vez (todas as instâncias compartilham). */
let queueTail: Promise<unknown> = Promise.resolve();
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = queueTail.then(job, job);
  queueTail = run.catch(() => undefined);
  return run;
}

interface ProcResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

function runProcess(file: string, args: string[], input: string, opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; signal?: AbortSignal }): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new ClaudeCliError('Execução cancelada pelo usuário.'));
    const child = spawn(file, args, { cwd: opts.cwd, env: opts.env, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => reject(new ClaudeCliError(`o claude não respondeu em ${Math.round(opts.timeoutMs / 1000)} s (timeout); processo encerrado.`)));
    }, opts.timeoutMs);
    const onAbort = () => {
      child.kill();
      finish(() => reject(new ClaudeCliError('Execução cancelada pelo usuário.')));
    };
    opts.signal?.addEventListener('abort', onAbort);
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.on('error', (err) => finish(() => reject(new ClaudeCliError(`falha ao iniciar o claude: ${err.message}`))));
    child.on('close', (code) => finish(() => resolve({ stdout, stderr, code })));
    child.stdin.on('error', () => undefined); // processo pode fechar antes de ler tudo; o erro real vem do exit code
    child.stdin.end(input, 'utf8');
  });
}

const estimateTokens = (s: string) => Math.ceil(s.length / 4);

export class ClaudeCliClient implements LLMClient {
  readonly model: string;
  private readonly command: string;
  private readonly timeoutMs: number;
  private readonly formatRetries: number;
  private readonly env: NodeJS.ProcessEnv;
  private readonly fallbackModel: string;

  constructor(private readonly opts: ClaudeCliClientOptions = {}) {
    this.model = opts.model?.trim() || CLAUDE_CLI_DEFAULT_MODEL;
    if (!/^[A-Za-z0-9._:[\]-]+$/.test(this.model)) throw new ClaudeCliError(`modelo inválido para o claude: "${this.model}"`);
    this.command = opts.command ?? 'claude';
    this.timeoutMs = opts.timeoutMs ?? CLAUDE_CLI_TIMEOUT_MS;
    this.formatRetries = opts.formatRetries ?? 1;
    this.env = opts.env ?? process.env;
    this.fallbackModel = (opts.fallbackModel ?? CLAUDE_CLI_FALLBACK_MODEL).trim();
    if (this.fallbackModel && !/^[A-Za-z0-9._:[\]-]+$/.test(this.fallbackModel)) throw new ClaudeCliError(`modelo de fallback inválido: "${this.fallbackModel}"`);
  }

  private log(line: string): void {
    this.opts.onLog?.(redactSecrets(line));
  }

  /** Flags do `claude`: headless, JSON, sem sessão salva, sem ferramentas internas, sem MCP/skills. */
  cliArgs(model = this.model): string[] {
    return [
      '-p',
      '--output-format', 'json',
      '--model', model,
      '--no-session-persistence',
      '--tools', '',
      '--strict-mcp-config',
      '--disable-slash-commands',
      '--system-prompt', CLI_SYSTEM_PROMPT,
    ];
  }

  async complete(req: LLMRequest): Promise<LLMResponse> {
    const base = buildPrompt(req);
    let prompt = base;
    let inputTokens = 0;
    let outputTokens = 0;
    let costUsd = 0;
    let estimated = false;
    const notices: string[] = [];
    for (let attempt = 0; ; attempt++) {
      const { r, model } = await this.runGuarded(prompt, req.tag, notices);
      inputTokens += r.inputTokens ?? estimateTokens(CLI_SYSTEM_PROMPT + prompt);
      outputTokens += r.outputTokens ?? estimateTokens(r.result);
      costUsd += r.costUsd ?? 0;
      estimated ||= r.inputTokens === undefined || r.outputTokens === undefined;
      try {
        const reply = parseModelReply(r.result, req.tools);
        return {
          ...reply,
          inputTokens,
          outputTokens,
          ...(estimated ? { tokensEstimated: true } : {}),
          ...(costUsd ? { costUsd } : {}),
          model,
          ...(notices.length ? { notices } : {}),
        };
      } catch (err) {
        if (!(err instanceof ReplyFormatError)) throw err;
        if (attempt >= this.formatRetries) {
          throw new ClaudeCliError(`resposta do modelo fora do formato JSON exigido após ${attempt + 1} tentativa(s) (agente "${req.tag}"): ${err.message}`, r.result);
        }
        prompt =
          `${base}\n\n# Correção necessária\nSua resposta anterior foi recusada: ${err.message}.\n` +
          `Resposta anterior (início): ${r.result.slice(0, 1500)}\n` +
          'Responda novamente SOMENTE com o objeto JSON no formato obrigatório acima.';
      }
    }
  }

  /**
   * Recusa do filtro de segurança: 1 nova tentativa com o mesmo modelo e uma linha neutra no prompt;
   * se recusar de novo, fallback para `fallbackModel`. O texto bruto de cada recusa vai em `notices` (trace).
   */
  private async runGuarded(prompt: string, tag: string, notices: string[]): Promise<{ r: CliResult; model: string }> {
    const retryPrompt = `${prompt}\n\n${SAFEGUARD_RETRY_LINE}`;
    const plan = [
      { model: this.model, prompt },
      { model: this.model, prompt: retryPrompt },
      ...(this.fallbackModel && this.fallbackModel !== this.model ? [{ model: this.fallbackModel, prompt: retryPrompt }] : []),
    ];
    const refused: string[] = [];
    const raws: string[] = [];
    for (const [i, step] of plan.entries()) {
      if (i > 0) {
        const prev = refused.at(-1);
        this.log(`claude-cli [${tag}]: o filtro de segurança recusou (modelo ${prev}); ${step.model === prev ? 'nova tentativa com o mesmo modelo' : `fallback para o modelo ${step.model}`}.`);
      }
      try {
        const r = await this.runOnce(step.prompt, step.model);
        if (i > 0) this.log(`claude-cli [${tag}]: respondido pelo modelo ${step.model}.`);
        return { r, model: step.model };
      } catch (err) {
        if (!(err instanceof ClaudeSafeguardError)) throw err;
        refused.push(step.model);
        raws.push(`[${step.model}] ${err.rawText ?? err.message}`);
        notices.push(`recusa do filtro de segurança (modelo ${step.model}): ${err.rawText ?? err.message}`);
      }
    }
    throw new ClaudeSafeguardError([...new Set(refused)], raws.join('\n'));
  }

  private runOnce(prompt: string, model = this.model): Promise<CliResult> {
    return enqueue(async () => {
      const { file, prefixArgs, script } = resolveCommand(this.command, this.env);
      const env: NodeJS.ProcessEnv = { ...this.env };
      // Fora de uma sessão do Claude Code; a chave da OpenAI não interessa ao processo.
      for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'OPENAI_API_KEY']) delete env[k];
      if (script && process.versions.electron) env.ELECTRON_RUN_AS_NODE = '1';
      // Pasta temporária VAZIA: o Claude Code não lê CLAUDE.md nem o repositório.
      const cwd = await mkdtemp(join(tmpdir(), 'reactest-claude-'));
      try {
        const p = await runProcess(file, [...prefixArgs, ...this.cliArgs(model)], prompt, {
          cwd,
          env,
          timeoutMs: this.timeoutMs,
          ...(this.opts.signal ? { signal: this.opts.signal } : {}),
        });
        let parsed: CliResult | undefined;
        try {
          parsed = parseCliOutput(p.stdout);
        } catch (err) {
          if (p.code === 0) throw err;
        }
        if (p.code !== 0 || !parsed || parsed.isError) {
          const raw = [parsed?.result, p.stderr.trim(), parsed ? '' : p.stdout.trim()].filter(Boolean).join('\n') || 'sem saída';
          if (SAFEGUARD_RE.test(raw)) throw new ClaudeSafeguardError([model], raw);
          throw new ClaudeCliError(cliErrorMessage(p.code, raw), raw);
        }
        if (/safeguards flagged|reasoning_extraction/i.test(parsed.result)) throw new ClaudeSafeguardError([model], parsed.result);
        return parsed;
      } finally {
        await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
      }
    });
  }
}

/** Existe um `claude` resolvível no PATH? (para mensagens na extensão/CLI). */
export function claudeCliAvailable(command = 'claude', env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return existsSync(resolveCommand(command, env).file);
  } catch {
    return false;
  }
}
