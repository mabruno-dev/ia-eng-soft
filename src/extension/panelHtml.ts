// HTML do painel "ReacTest Pipeline" (webview). Sem frameworks; CSS/JS inline autorizados por nonce (CSP).
// Cores só por variáveis de tema do VS Code (claro/escuro/alto contraste). O DOM é montado com textContent
// (nunca innerHTML com dados), então texto vindo do LLM não injeta marcação. Sem `vscode`: testável.

export function renderPanelHtml(o: { nonce: string; cspSource: string }): string {
  const { nonce, cspSource } = o;
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${cspSource} data:; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>ReacTest Pipeline</title>
<style nonce="${nonce}">${CSS}</style>
</head>
<body>
<header class="head">
  <div class="title-row">
    <h1 id="component">ReacTest Pipeline</h1>
    <span id="provider" class="chip"></span>
  </div>
  <div id="flags" class="muted small"></div>
  <div class="progress-row">
    <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="6" aria-valuenow="0" id="bar"><div class="fill" id="fill"></div></div>
    <span id="progress-label" class="small">Aguardando início…</span>
  </div>
</header>

<section id="question" class="card question hidden" aria-live="polite">
  <div class="q-head"><span class="chip accent">Elicitação</span><span id="q-counter" class="small muted"></span></div>
  <p id="q-text" class="q-text"></p>
  <p id="q-why" class="small muted"></p>
  <textarea id="q-input" rows="3" placeholder="Sua resposta (Ctrl+Enter para responder)"></textarea>
  <div class="actions">
    <button id="q-answer">Responder</button>
    <button id="q-skip" class="secondary">Pular</button>
  </div>
</section>

<ol id="timeline" class="timeline"></ol>

<section id="heal" class="hidden">
  <h2>Cura (Executor ⇄ Reparador)</h2>
  <div id="iterations"></div>
</section>

<section id="result" class="hidden">
  <div id="result-badge" class="badge"></div>
  <p id="result-note" class="note hidden"></p>
  <p id="result-error" class="small error-text hidden"></p>
  <dl id="metrics" class="metrics"></dl>
  <div id="suggestions-box" class="hidden">
    <h2>Sugestões do Verificador</h2>
    <p class="small muted">Casos que matariam mutantes sobreviventes. Não são aplicadas automaticamente ao teste.</p>
    <ol id="suggestions" class="suggestions"></ol>
  </div>
  <div class="actions">
    <button id="open-test">Abrir teste</button>
    <button id="open-trace" class="secondary">Abrir trace</button>
  </div>
</section>

<script nonce="${nonce}">${JS}</script>
</body>
</html>`;
}

const CSS = `
:root { color-scheme: light dark; }
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground);
  background: var(--vscode-editor-background); padding: 12px 16px 32px; line-height: 1.45; }
h1 { font-size: 1.35em; margin: 0; }
h2 { font-size: 1.05em; margin: 18px 0 8px; }
.hidden { display: none !important; }
.muted { color: var(--vscode-descriptionForeground); }
.small { font-size: 0.9em; }
.chip { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 0.85em;
  background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); white-space: nowrap; }
.chip.accent { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
.chip.llm { background: transparent; border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, currentColor));
  color: var(--vscode-descriptionForeground); }
.head { position: sticky; top: 0; background: var(--vscode-editor-background); padding-bottom: 10px; z-index: 1;
  border-bottom: 1px solid var(--vscode-panel-border, transparent); }
.title-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.progress-row { display: flex; gap: 10px; align-items: center; margin-top: 8px; }
.bar { flex: 1; height: 6px; border-radius: 3px; background: var(--vscode-input-background); overflow: hidden;
  border: 1px solid var(--vscode-input-border, transparent); }
.fill { height: 100%; width: 0; background: var(--vscode-progressBar-background); transition: width .3s ease; }
.card { border: 1px solid var(--vscode-panel-border, var(--vscode-widget-border, transparent)); border-radius: 6px;
  padding: 10px 12px; margin: 10px 0; background: var(--vscode-sideBar-background, transparent); }
.timeline { list-style: none; padding: 0; margin: 12px 0; }
.agent { border-left: 3px solid var(--vscode-panel-border, var(--vscode-descriptionForeground)); padding: 6px 0 8px 12px; margin-left: 8px; position: relative; }
.agent .row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.agent .icon { width: 18px; text-align: center; font-weight: bold; }
.agent .name { font-weight: 600; }
.agent .state { margin-left: auto; }
.agent .summary { margin: 2px 0 0 26px; }
.agent.waiting { opacity: .65; }
.agent.running { border-left-color: var(--vscode-progressBar-background); }
.agent.done { border-left-color: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); }
.agent.done .icon { color: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); }
.agent.error { border-left-color: var(--vscode-testing-iconFailed, var(--vscode-errorForeground)); }
.agent.error .icon { color: var(--vscode-testing-iconFailed, var(--vscode-errorForeground)); }
.agent.skipped { opacity: .55; border-left-style: dashed; }
.spinner { display: inline-block; width: 12px; height: 12px; border-radius: 50%;
  border: 2px solid var(--vscode-progressBar-background); border-right-color: transparent; animation: spin .8s linear infinite; vertical-align: middle; }
@keyframes spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .spinner { animation: none; } .fill { transition: none; } }
.tools { list-style: none; margin: 6px 0 0 26px; padding: 0; font-family: var(--vscode-editor-font-family); font-size: 0.88em; }
.tools li { display: flex; gap: 6px; padding: 1px 0; }
.tools .ok { color: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); }
.tools .fail { color: var(--vscode-testing-iconFailed, var(--vscode-errorForeground)); }
.tools .tname { font-weight: 600; white-space: nowrap; }
.tools .tsum { color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.question { border-color: var(--vscode-focusBorder); }
.q-head { display: flex; justify-content: space-between; align-items: center; }
.q-text { font-size: 1.15em; font-weight: 600; margin: 8px 0 4px; }
textarea { width: 100%; box-sizing: border-box; margin-top: 6px; font-family: inherit; font-size: inherit; resize: vertical;
  color: var(--vscode-input-foreground); background: var(--vscode-input-background);
  border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; padding: 6px; }
textarea:focus { outline: 1px solid var(--vscode-focusBorder); }
.actions { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
button { font-family: inherit; font-size: inherit; padding: 5px 14px; border-radius: 3px; cursor: pointer;
  border: 1px solid var(--vscode-button-border, transparent); color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
button:hover { background: var(--vscode-button-hoverBackground); }
button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
button:disabled { opacity: .5; cursor: default; }
.iteration .cat { font-weight: 600; }
.badge { font-size: 1.3em; font-weight: 700; padding: 12px 16px; border-radius: 6px; margin-top: 18px; border: 2px solid; }
.badge.success { color: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); border-color: var(--vscode-testing-iconPassed, var(--vscode-charts-green)); }
.badge.warning { color: var(--vscode-editorWarning-foreground, var(--vscode-charts-yellow)); border-color: var(--vscode-editorWarning-foreground, var(--vscode-charts-yellow)); }
.badge.error { color: var(--vscode-testing-iconFailed, var(--vscode-errorForeground)); border-color: var(--vscode-testing-iconFailed, var(--vscode-errorForeground)); }
.note { font-weight: 600; color: var(--vscode-editorWarning-foreground, var(--vscode-charts-yellow)); }
.error-text { color: var(--vscode-errorForeground); }
.metrics { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 14px 0; }
.metrics dt { color: var(--vscode-descriptionForeground); }
.metrics dd { margin: 0; font-weight: 600; }
.suggestions li { margin-bottom: 8px; }
.suggestions code { display: block; margin-top: 3px; padding: 4px 6px; border-radius: 3px; white-space: pre-wrap; word-break: break-word;
  font-family: var(--vscode-editor-font-family); background: var(--vscode-textCodeBlock-background); }
`;

// JavaScript do webview: sem crases nem interpolação para não colidir com o template acima.
const JS = `
(function () {
  const vscode = acquireVsCodeApi();
  const $ = function (id) { return document.getElementById(id); };
  const el = function (tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = String(text);
    return n;
  };
  const STATE_TEXT = { waiting: 'aguardando', running: 'executando', done: 'concluído', error: 'erro', skipped: 'ignorado' };
  const ICON = { waiting: '○', running: '', done: '✓', error: '✗', skipped: '–' };
  let agents = {};
  let total = 6;
  let currentQuestion = null;

  function secs(ms) { return (ms / 1000).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' s'; }

  function setProgress(index, label) {
    $('fill').style.width = Math.round((index / total) * 100) + '%';
    $('bar').setAttribute('aria-valuenow', String(index));
    $('progress-label').textContent = label;
  }

  function init(m) {
    agents = {};
    total = m.agents.length;
    $('component').textContent = m.component;
    $('provider').textContent = m.provider + ' / ' + m.model;
    $('flags').textContent = m.flags;
    $('bar').setAttribute('aria-valuemax', String(total));
    setProgress(0, 'Iniciando…');
    const tl = $('timeline');
    tl.textContent = '';
    m.agents.forEach(function (a) {
      const li = el('li', 'agent waiting');
      const row = el('div', 'row');
      const icon = el('span', 'icon', ICON.waiting);
      row.appendChild(icon);
      row.appendChild(el('span', 'name', a.index + '. ' + a.label));
      row.appendChild(el('span', 'chip llm', 'LLM + ferramentas'));
      const state = el('span', 'state small muted', STATE_TEXT.waiting);
      row.appendChild(state);
      li.appendChild(row);
      const summary = el('div', 'summary small muted hidden');
      li.appendChild(summary);
      const tools = el('ul', 'tools');
      li.appendChild(tools);
      tl.appendChild(li);
      agents[a.id] = { li: li, icon: icon, state: state, summary: summary, tools: tools, ms: 0, status: 'waiting' };
    });
    $('iterations').textContent = '';
    $('heal').classList.add('hidden');
    $('result').classList.add('hidden');
    hideQuestion();
  }

  function setAgent(m) {
    const a = agents[m.agent];
    if (!a) return;
    a.status = m.state;
    a.li.className = 'agent ' + m.state;
    a.icon.textContent = ICON[m.state];
    if (m.state === 'running') {
      a.icon.textContent = '';
      a.icon.appendChild(el('span', 'spinner'));
      a.state.textContent = STATE_TEXT.running;
      setProgress(m.index - 1, 'Agente ' + m.index + '/' + m.total + ' · ' + m.label);
      return;
    }
    if (typeof m.ms === 'number') a.ms += m.ms;
    a.state.textContent = m.state === 'done' || m.state === 'error' ? STATE_TEXT[m.state] + ' · ' + secs(a.ms) : STATE_TEXT[m.state];
    if (m.summary) { a.summary.textContent = m.summary; a.summary.classList.remove('hidden'); }
    if (m.state !== 'skipped') setProgress(m.index, 'Agente ' + m.index + '/' + m.total + ' · ' + m.label + ' ' + STATE_TEXT[m.state]);
  }

  function addTool(m) {
    const a = agents[m.agent];
    if (!a) return;
    const li = el('li');
    li.appendChild(el('span', m.ok ? 'ok' : 'fail', m.ok ? '✓' : '✗'));
    li.appendChild(el('span', 'tname', m.tool));
    const sum = el('span', 'tsum', m.summary || m.args);
    li.title = m.args + (m.summary ? '\\n→ ' + m.summary : '');
    li.appendChild(sum);
    a.tools.appendChild(li);
    while (a.tools.children.length > 30) a.tools.removeChild(a.tools.firstChild);
  }

  function showQuestion(m) {
    currentQuestion = m.id;
    $('q-counter').textContent = m.counter;
    $('q-text').textContent = m.text;
    $('q-why').textContent = m.why ? 'Por quê: ' + m.why : '';
    $('q-input').value = '';
    $('q-answer').disabled = false;
    $('q-skip').disabled = false;
    $('question').classList.remove('hidden');
    $('q-input').focus();
  }
  function hideQuestion() { currentQuestion = null; $('question').classList.add('hidden'); }
  function closeQuestion(m) {
    if (currentQuestion === m.id) hideQuestion();
    const a = agents.elicitation;
    if (a) {
      const li = el('li');
      li.appendChild(el('span', m.answer ? 'ok' : 'fail', m.answer ? '↳' : '–'));
      li.appendChild(el('span', 'tsum', m.answer ? 'resposta: ' + m.answer : 'pergunta pulada'));
      a.tools.appendChild(li);
    }
  }
  function send(kind) {
    if (!currentQuestion) return;
    const text = $('q-input').value.trim();
    $('q-answer').disabled = true;
    $('q-skip').disabled = true;
    if (kind === 'answer' && text) vscode.postMessage({ type: 'answer', id: currentQuestion, text: text });
    else vscode.postMessage({ type: 'skip', id: currentQuestion });
  }
  $('q-answer').addEventListener('click', function () { send('answer'); });
  $('q-skip').addEventListener('click', function () { send('skip'); });
  $('q-input').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) { ev.preventDefault(); send('answer'); }
  });

  function addIteration(m) {
    $('heal').classList.remove('hidden');
    const card = el('div', 'card iteration');
    const head = el('div');
    head.appendChild(el('span', 'cat', 'Iteração ' + m.n + ' · ' + m.category));
    card.appendChild(head);
    card.appendChild(el('div', 'small', m.summary));
    $('iterations').appendChild(card);
  }

  function showResult(m) {
    hideQuestion();
    Object.keys(agents).forEach(function (id) {
      const a = agents[id];
      if (a.status === 'waiting' || a.status === 'running') {
        a.li.className = 'agent skipped';
        a.icon.textContent = ICON.skipped;
        a.state.textContent = 'não executado';
      }
    });
    setProgress(total, 'Concluído');
    const badge = $('result-badge');
    badge.className = 'badge ' + m.tone;
    badge.textContent = (m.tone === 'success' ? '✓ ' : m.tone === 'warning' ? '⚠ ' : '✗ ') + m.headline;
    $('result-note').textContent = m.note || '';
    $('result-note').classList.toggle('hidden', !m.note);
    $('result-error').textContent = m.error || '';
    $('result-error').classList.toggle('hidden', !m.error);
    const dl = $('metrics');
    dl.textContent = '';
    m.metrics.forEach(function (x) { dl.appendChild(el('dt', '', x.label)); dl.appendChild(el('dd', '', x.value)); });
    const ol = $('suggestions');
    ol.textContent = '';
    m.suggestions.forEach(function (s) {
      const li = el('li');
      li.appendChild(el('div', 'small muted', s.title));
      li.appendChild(el('div', '', s.description));
      li.appendChild(el('code', '', s.assertion));
      ol.appendChild(li);
    });
    $('suggestions-box').classList.toggle('hidden', m.suggestions.length === 0);
    $('open-test').disabled = !m.hasTest;
    $('result').classList.remove('hidden');
    $('result').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function showError(m) {
    const p = el('p', 'card error-text', 'Erro: ' + m.message);
    $('timeline').after(p);
  }

  $('open-test').addEventListener('click', function () { vscode.postMessage({ type: 'openTest' }); });
  $('open-trace').addEventListener('click', function () { vscode.postMessage({ type: 'openTrace' }); });

  window.addEventListener('message', function (ev) {
    const m = ev.data;
    try {
      switch (m && m.kind) {
        case 'init': init(m); break;
        case 'agent': setAgent(m); break;
        case 'tool': addTool(m); break;
        case 'question': showQuestion(m); break;
        case 'question_closed': closeQuestion(m); break;
        case 'iteration': addIteration(m); break;
        case 'result': showResult(m); break;
        case 'error': showError(m); break;
      }
    } catch (err) {
      console.error('[ReacTest] falha ao renderizar mensagem', err);
    }
  });
  vscode.postMessage({ type: 'ready' });
})();
`;
