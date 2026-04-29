#!/usr/bin/env node
import http from "node:http";
import { loadConfig, VERSION } from "../core/config.js";
import { CrossReviewOrchestrator } from "../core/orchestrator.js";
import { sessionReportMarkdown } from "../core/reports.js";
import { EventLog } from "../observability/logger.js";
import { safeErrorMessage } from "../security/redact.js";

const config = loadConfig();
const eventLog = new EventLog(config);
const holder: { orchestrator?: CrossReviewOrchestrator } = {};
const orchestrator = new CrossReviewOrchestrator(config, (event) => {
  eventLog.emit(event);
  holder.orchestrator?.store.appendEvent(event);
});
holder.orchestrator = orchestrator;

function sendJson(response: http.ServerResponse, value: unknown): void {
  response.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(value, null, 2));
}

function sendHtml(response: http.ServerResponse, html: string): void {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(html);
}

function notFound(response: http.ServerResponse): void {
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("Not found");
}

function html(): string {
  return `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Cross Review MCP</title>
  <style>
    :root { color-scheme: light; font-family: Inter, Segoe UI, Arial, sans-serif; color: #102033; background: #f6f8fb; }
    body { margin: 0; }
    main { max-width: 1120px; margin: 0 auto; padding: 32px; }
    header { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 24px; }
    h1 { margin: 0; font-size: 28px; }
    .badge { border: 1px solid #cbd7e8; border-radius: 999px; padding: 6px 12px; background: white; font-weight: 700; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; }
    .card { background: white; border: 1px solid #d8e1ee; border-radius: 8px; padding: 18px; box-shadow: 0 8px 20px rgb(16 32 51 / 0.05); }
    .muted { color: #52647b; }
    .sessions { display: grid; gap: 12px; margin-top: 18px; }
    .session { background: white; border: 1px solid #d8e1ee; border-radius: 8px; padding: 14px; }
    .session strong { display: block; margin-bottom: 6px; }
    .row { display: flex; gap: 12px; flex-wrap: wrap; color: #52647b; font-size: 14px; }
    pre { max-height: 460px; overflow: auto; white-space: pre-wrap; background: #0f172a; color: #e5e7eb; border-radius: 8px; padding: 16px; }
    button { border: 0; border-radius: 8px; padding: 10px 14px; font-weight: 800; color: white; background: #1f6feb; cursor: pointer; }
    button:hover { transform: translateY(-1px); }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>Cross Review MCP</h1>
        <div class="muted">API-only, SDKs oficiais, unanimidade obrigatoria</div>
      </div>
      <div class="badge">v${VERSION}</div>
    </header>
    <section class="grid">
      <article class="card"><strong>Dados</strong><p class="muted">${config.data_dir}</p></article>
      <article class="card"><strong>Logs</strong><p class="muted">${eventLog.path()}</p></article>
      <article class="card"><strong>Credentials</strong><p class="muted">Windows environment variables only</p></article>
    </section>
    <p><button id="refresh">Atualizar sessoes</button></p>
    <section id="sessions" class="sessions">Carregando...</section>
    <pre id="details">Selecione uma sessao para ver detalhes.</pre>
  </main>
  <script>
    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
    }
    async function refresh() {
      const data = await fetch('/api/sessions').then(r => r.json());
      const container = document.getElementById('sessions');
      if (!data.length) {
        container.textContent = 'Nenhuma sessao registrada.';
        return;
      }
      container.innerHTML = data.map(session => {
        const health = session.convergence_health || {};
        const cost = session.totals?.cost?.total_cost;
        return \`<article class="session" data-session="\${session.session_id}">
          <strong>\${escapeHtml(session.session_id)}</strong>
          <div class="row">
            <span>estado: \${escapeHtml(session.outcome || health.state || 'em andamento')}</span>
            <span>rodadas: \${session.rounds?.length || 0}</span>
            <span>custo: \${cost == null ? 'desconhecido' : '$' + Number(cost).toFixed(6)}</span>
          </div>
          <div class="muted">\${escapeHtml(health.detail || '')}</div>
        </article>\`;
      }).join('');
      for (const node of container.querySelectorAll('.session')) {
        node.addEventListener('click', async () => {
          const id = node.dataset.session;
          const [session, events] = await Promise.all([
            fetch('/api/sessions/' + id).then(r => r.json()),
            fetch('/api/sessions/' + id + '/events').then(r => r.json()),
          ]);
          document.getElementById('details').textContent = JSON.stringify({ session, events }, null, 2);
        });
      }
    }
    document.getElementById('refresh').addEventListener('click', refresh);
    refresh();
  </script>
</body>
</html>`;
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
  try {
    if (url.pathname === "/") {
      sendHtml(response, html());
      return;
    }
    if (url.pathname === "/api/health") {
      sendJson(response, {
        ok: true,
        version: VERSION,
        data_dir: config.data_dir,
        log_file: eventLog.path(),
        stub: config.stub,
      });
      return;
    }
    if (url.pathname === "/api/probe") {
      sendJson(response, await orchestrator.probeAll());
      return;
    }
    if (url.pathname === "/api/sessions") {
      sendJson(response, orchestrator.store.list());
      return;
    }
    const sessionMatch = url.pathname.match(/^\/api\/sessions\/([a-f0-9-]{36})$/);
    if (sessionMatch) {
      sendJson(response, orchestrator.store.read(sessionMatch[1]));
      return;
    }
    const eventsMatch = url.pathname.match(/^\/api\/sessions\/([a-f0-9-]{36})\/events$/);
    if (eventsMatch) {
      const since = Number(url.searchParams.get("since_seq") ?? 0);
      sendJson(response, orchestrator.store.readEvents(eventsMatch[1], since));
      return;
    }
    const reportMatch = url.pathname.match(/^\/api\/sessions\/([a-f0-9-]{36})\/report$/);
    if (reportMatch) {
      const session = orchestrator.store.read(reportMatch[1]);
      const markdown = sessionReportMarkdown(
        session,
        orchestrator.store.readEvents(reportMatch[1]),
      );
      orchestrator.store.saveReport(reportMatch[1], markdown);
      response.writeHead(200, {
        "content-type": "text/markdown; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(markdown);
      return;
    }
    notFound(response);
  } catch (error) {
    console.error(`dashboard_request_failed: ${safeErrorMessage(error)}`);
    response.writeHead(500, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: false, error: "internal_server_error" }));
  }
});

server.listen(config.dashboard_port, "127.0.0.1", () => {
  console.log(`Cross Review MCP dashboard: http://127.0.0.1:${config.dashboard_port}`);
});
