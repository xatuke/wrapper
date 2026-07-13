// Single-file dashboard: no framework, no external assets, binds to localhost.
export function pageHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>wrapper — agent console</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Ctext x='1' y='13' font-family='monospace' font-size='14' fill='%23b98fd6'%3E[%3C/text%3E%3Ctext x='9' y='13' font-family='monospace' font-size='14' fill='%23b98fd6'%3E]%3C/text%3E%3C/svg%3E">
<style>
  :root {
    --bg: #14161f; --surface: #1d2029; --line: #2a2e3d; --ink: #e9e7e0;
    --muted: #9095a8; --accent: #b98fd6; --ok: #7ec695; --warn: #e3b660; --err: #e08573;
    --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  * { box-sizing: border-box; margin: 0; }
  body { background: var(--bg); color: var(--ink); font-family: var(--sans); min-height: 100vh; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  button { font: inherit; cursor: pointer; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  header {
    display: flex; align-items: center; justify-content: space-between; gap: 16px;
    padding: 20px 28px; border-bottom: 1px solid var(--line); flex-wrap: wrap;
  }
  .wordmark { font-family: var(--mono); font-size: 20px; letter-spacing: 0.02em; }
  .wordmark .bracket { color: var(--accent); }
  .stack { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
  .stack .pill { display: flex; align-items: center; gap: 6px; font-family: var(--mono); font-size: 11px; color: var(--muted); }

  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); flex: none; }
  .dot.ok { background: var(--ok); }
  .dot.err { background: var(--err); }
  .dot.warn { background: var(--warn); }
  @media (prefers-reduced-motion: no-preference) {
    .dot.ok.live { animation: pulse 2.4s ease-in-out infinite; }
    @keyframes pulse { 50% { box-shadow: 0 0 0 5px rgba(126, 198, 149, 0.15); } }
  }

  main { padding: 28px; max-width: 1100px; margin: 0 auto; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 20px; }

  .card {
    position: relative; background: var(--surface); padding: 22px 24px;
    border: 1px solid var(--line);
  }
  /* bracket corners — the container motif */
  .card::before, .card::after {
    content: ""; position: absolute; width: 14px; height: 14px; pointer-events: none;
  }
  .card::before { top: -1px; left: -1px; border-top: 2px solid var(--accent); border-left: 2px solid var(--accent); }
  .card::after { bottom: -1px; right: -1px; border-bottom: 2px solid var(--accent); border-right: 2px solid var(--accent); }

  .card h2 { font-size: 17px; font-weight: 650; letter-spacing: -0.01em; margin-bottom: 10px; }
  .meta { font-family: var(--mono); font-size: 12px; color: var(--muted); display: grid; gap: 4px; margin-bottom: 14px; }
  .meta .warnrow { color: var(--warn); }
  .statusline { display: flex; align-items: center; gap: 8px; font-family: var(--mono); font-size: 12px; margin-bottom: 16px; }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .actions button, .actions a {
    background: none; border: 1px solid var(--line); color: var(--ink);
    font-family: var(--mono); font-size: 12px; padding: 6px 12px;
  }
  .actions button:hover:not(:disabled) { border-color: var(--accent); }
  .actions button:disabled { opacity: 0.4; cursor: wait; }
  .actions .primary { border-color: var(--accent); color: var(--accent); }

  .empty { border: 1px dashed var(--line); padding: 48px; text-align: center; color: var(--muted); }
  .empty code { font-family: var(--mono); color: var(--ink); }

  .drawer {
    position: fixed; inset: 0 0 0 auto; width: min(680px, 100vw); background: var(--surface);
    border-left: 1px solid var(--line); display: none; flex-direction: column; z-index: 10;
  }
  .drawer.open { display: flex; }
  .drawer header { padding: 16px 20px; }
  .drawer h3 { font-family: var(--mono); font-size: 14px; font-weight: 500; }
  .drawer .body { flex: 1; overflow: auto; padding: 16px 20px; }
  .drawer pre { font-family: var(--mono); font-size: 11px; line-height: 1.55; white-space: pre-wrap; word-break: break-all; }
  .scrim { position: fixed; inset: 0; background: rgba(0,0,0,0.5); display: none; z-index: 9; }
  .scrim.open { display: block; }

  table { width: 100%; border-collapse: collapse; font-family: var(--mono); font-size: 12px; }
  td { padding: 7px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  td.k { color: var(--accent); white-space: nowrap; }
  td.v { color: var(--muted); word-break: break-all; }
  td.x { width: 30px; text-align: right; }
  td.x button { background: none; border: none; color: var(--err); font-family: var(--mono); }
  .envform { display: flex; gap: 8px; margin-top: 14px; }
  .envform input {
    flex: 1; background: var(--bg); border: 1px solid var(--line); color: var(--ink);
    font-family: var(--mono); font-size: 12px; padding: 8px 10px;
  }
  .hint { font-family: var(--mono); font-size: 11px; color: var(--warn); margin-top: 10px; min-height: 14px; }
  .toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: var(--surface);
    border: 1px solid var(--err); color: var(--err); font-family: var(--mono); font-size: 12px;
    padding: 10px 16px; display: none; z-index: 20; }
</style>
</head>
<body>
<header>
  <div class="wordmark"><span class="bracket">[</span> wrapper <span class="bracket">]</span></div>
  <div class="stack" id="stack" aria-label="infrastructure health"></div>
</header>
<main>
  <div id="agents" class="grid" aria-live="polite"></div>
  <div id="empty" class="empty" hidden>
    No agents yet. Create one with <code>wrapper agent add &lt;name&gt; --channels "#channel"</code>
  </div>
</main>

<div class="scrim" id="scrim" onclick="closeDrawer()"></div>
<div class="drawer" id="drawer" role="dialog" aria-modal="true">
  <header>
    <h3 id="drawer-title"></h3>
    <button class="close" onclick="closeDrawer()" aria-label="Close" style="background:none;border:none;color:var(--muted);font-size:18px">✕</button>
  </header>
  <div class="body" id="drawer-body"></div>
</div>
<div class="toast" id="toast" role="alert"></div>

<script>
var drawerMode = null, drawerAgent = null, logsTimer = null, busy = {};

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function toast(msg) {
  var t = document.getElementById('toast');
  t.textContent = msg; t.style.display = 'block';
  setTimeout(function () { t.style.display = 'none'; }, 5000);
}
function api(path, opts) {
  return fetch(path, opts).then(function (r) {
    return r.json().then(function (d) {
      if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
      return d;
    });
  });
}

function render(state) {
  var stack = document.getElementById('stack');
  var pills = state.stack.map(function (s) {
    return '<span class="pill"><span class="dot ' + (s.up ? 'ok' : 'err') + '"></span>' + esc(s.service) + '</span>';
  });
  pills.push('<span class="pill"><a href="' + esc(state.langfuse.baseUrl) + '" target="_blank">traces ↗</a></span>');
  stack.innerHTML = pills.join('');

  var grid = document.getElementById('agents');
  document.getElementById('empty').hidden = state.agents.length > 0;
  grid.innerHTML = state.agents.map(function (a) {
    var running = a.state === 'running';
    var dotCls = running ? 'ok live' : (a.state === 'missing' ? '' : 'err');
    var isBusy = busy[a.name];
    return '<article class="card">' +
      '<h2>' + esc(a.name) + '</h2>' +
      '<div class="meta">' +
        '<span>' + esc(a.model) + '</span>' +
        '<span>' + (a.channels.length ? esc(a.channels.join('  ')) : 'DMs + anywhere invited') + '</span>' +
        (a.hasSlack ? '' : '<span class="warnrow">no slack tokens — finish setup</span>') +
      '</div>' +
      '<div class="statusline"><span class="dot ' + dotCls + '"></span>' + esc(a.status) + '</div>' +
      '<div class="actions">' +
        (running
          ? '<button onclick="act(\\'' + a.name + '\\',\\'down\\')"' + (isBusy ? ' disabled' : '') + '>Stop</button>' +
            '<button onclick="act(\\'' + a.name + '\\',\\'restart\\')"' + (isBusy ? ' disabled' : '') + '>Restart</button>'
          : '<button class="primary" onclick="act(\\'' + a.name + '\\',\\'up\\')"' + (isBusy ? ' disabled' : '') + '>Start</button>') +
        '<button onclick="openLogs(\\'' + a.name + '\\')">Logs</button>' +
        '<button onclick="openEnv(\\'' + a.name + '\\')">Env</button>' +
        '<a href="' + esc(state.langfuse.baseUrl) + '" target="_blank">Traces</a>' +
      '</div></article>';
  }).join('');
}

function refresh() {
  api('/api/state').then(render).catch(function () {});
}

function act(name, op) {
  busy[name] = true; refresh();
  api('/api/agents/' + name + '/action', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ op: op })
  }).catch(function (e) { toast(name + ': ' + e.message); })
    .then(function () { busy[name] = false; refresh(); });
}

function openDrawer(title) {
  document.getElementById('drawer-title').textContent = title;
  document.getElementById('drawer').classList.add('open');
  document.getElementById('scrim').classList.add('open');
}
function closeDrawer() {
  document.getElementById('drawer').classList.remove('open');
  document.getElementById('scrim').classList.remove('open');
  drawerMode = null; drawerAgent = null;
  if (logsTimer) { clearInterval(logsTimer); logsTimer = null; }
}
document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeDrawer(); });

function openLogs(name) {
  drawerMode = 'logs'; drawerAgent = name;
  openDrawer(name + ' — logs (tail 300)');
  var body = document.getElementById('drawer-body');
  body.innerHTML = '<pre id="logtext">loading…</pre>';
  var load = function () {
    if (drawerMode !== 'logs') return;
    api('/api/agents/' + name + '/logs').then(function (d) {
      var el = document.getElementById('logtext');
      if (!el) return;
      var stick = body.scrollTop + body.clientHeight >= body.scrollHeight - 40;
      el.textContent = d.text || '(no output)';
      if (stick) body.scrollTop = body.scrollHeight;
    }).catch(function (e) { toast(e.message); });
  };
  load();
  logsTimer = setInterval(load, 3000);
}

function openEnv(name) {
  drawerMode = 'env'; drawerAgent = name;
  openDrawer(name + ' — environment');
  loadEnv(name);
}
function loadEnv(name) {
  api('/api/agents/' + name + '/env').then(function (d) {
    var rows = d.vars.map(function (v) {
      return '<tr><td class="k">' + esc(v.key) + '</td><td class="v">' + esc(v.value) + '</td>' +
        '<td class="x"><button title="Remove" onclick="unsetVar(\\'' + esc(v.key) + '\\')">✕</button></td></tr>';
    }).join('');
    document.getElementById('drawer-body').innerHTML =
      '<table>' + (rows || '<tr><td class="v">(empty)</td></tr>') + '</table>' +
      '<form class="envform" onsubmit="return setVar(event)">' +
        '<input id="envpair" placeholder="KEY=VALUE" autocomplete="off" spellcheck="false">' +
        '<button class="primary" style="border:1px solid var(--accent);background:none;color:var(--accent);padding:8px 14px;font-family:var(--mono);font-size:12px">Save</button>' +
      '</form><div class="hint" id="envhint"></div>';
  }).catch(function (e) { toast(e.message); });
}
function setVar(e) {
  e.preventDefault();
  var pair = document.getElementById('envpair').value;
  var i = pair.indexOf('=');
  if (i < 1) { toast('Expected KEY=VALUE'); return false; }
  var set = {}; set[pair.slice(0, i)] = pair.slice(i + 1);
  api('/api/agents/' + drawerAgent + '/env', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ set: set })
  }).then(function () {
    loadEnv(drawerAgent);
    document.getElementById('envhint').textContent = 'saved — restart the agent to apply';
  }).catch(function (err) { toast(err.message); });
  return false;
}
function unsetVar(key) {
  api('/api/agents/' + drawerAgent + '/env', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ unset: [key] })
  }).then(function () {
    loadEnv(drawerAgent);
    document.getElementById('envhint').textContent = 'removed — restart the agent to apply';
  }).catch(function (err) { toast(err.message); });
}

refresh();
setInterval(function () { if (!drawerMode) refresh(); }, 4000);
</script>
</body>
</html>`;
}
