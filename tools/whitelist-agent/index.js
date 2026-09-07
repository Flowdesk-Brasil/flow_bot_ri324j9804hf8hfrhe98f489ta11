const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { exec } = require("child_process");
const { executeJob, sanitizeError } = require("./executor");

const PORT = Number(process.env.FLOWDESK_AGENT_PORT || 8733);
const CONFIG_PATH = process.env.FLOWDESK_AGENT_CONFIG
  ? path.resolve(process.env.FLOWDESK_AGENT_CONFIG)
  : path.join(process.cwd(), "agent.json");

const DEFAULT_CONFIG = {
  apiUrl: "https://www.flwdesk.com/api/whitelist-agent/sync",
  publicId: "",
  token: "",
  db: {
    engine: "mysql",
    host: "127.0.0.1",
    port: 3306,
    database: "",
    user: "",
    password: "",
    ssl: false,
  },
};

let config = loadConfig();
let lastStatus = {
  online: false,
  message: "Aguardando pareamento.",
  publicIp: "",
  localIp: localAddresses().join(", "),
  lastSyncAt: null,
  jobsDone: 0,
};

function loadConfig() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
    return {
      ...DEFAULT_CONFIG,
      ...parsed,
      db: { ...DEFAULT_CONFIG.db, ...(parsed.db || {}) },
    };
  } catch {
    return { ...DEFAULT_CONFIG, db: { ...DEFAULT_CONFIG.db } };
  }
}

function saveConfig(next) {
  config = {
    ...DEFAULT_CONFIG,
    ...next,
    db: { ...DEFAULT_CONFIG.db, ...(next.db || {}) },
  };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
}

function localAddresses() {
  const nets = os.networkInterfaces();
  const found = [];
  for (const entries of Object.values(nets)) {
    for (const item of entries || []) {
      if (item.family === "IPv4" && !item.internal) found.push(item.address);
    }
  }
  return found;
}

function dbTarget() {
  return {
    engine: config.db.engine === "postgres" ? "postgres" : "mysql",
    host: config.db.host || "127.0.0.1",
    port: Number(config.db.port || 3306),
    database: config.db.database,
    user: config.db.user,
    password: config.db.password,
    ssl: config.db.ssl === true,
  };
}

async function fetchPublicIp() {
  try {
    const response = await fetch("https://api.ipify.org?format=json", {
      signal: AbortSignal.timeout(5000),
    });
    const payload = await response.json();
    lastStatus.publicIp = String(payload.ip || "");
  } catch {
    lastStatus.publicIp = lastStatus.publicIp || "";
  }
}

async function syncWithFlowDesk() {
  if (!config.publicId || !config.token || !config.apiUrl) {
    lastStatus.online = false;
    lastStatus.message = "Cole o ID publico e o token gerados no dashboard.";
    return;
  }

  const results = [];
  const body = {
    publicId: config.publicId,
    token: config.token,
    claim: true,
    status: {
      publicIp: lastStatus.publicIp,
      localIp: lastStatus.localIp,
      dbHost: config.db.host,
      dbPort: Number(config.db.port || 3306),
    },
    results: [],
  };

  const first = await postJson(config.apiUrl, body);
  const jobs = Array.isArray(first.jobs) ? first.jobs : [];
  for (const job of jobs) {
    try {
      const result = await executeJob(dbTarget(), String(job.operation || ""), job.payload || {});
      results.push({
        id: job.id,
        ok: result.ok !== false,
        result,
        errorMessage: result.ok === false ? result.message : null,
      });
    } catch (error) {
      const sanitized = sanitizeError(error);
      results.push({
        id: job.id,
        ok: false,
        result: sanitized,
        errorMessage: sanitized.message,
      });
    }
  }

  if (results.length) {
    const second = await postJson(config.apiUrl, {
      ...body,
      claim: true,
      results,
    });
    lastStatus.jobsDone += results.length;
    lastStatus.online = second.ok !== false;
    lastStatus.message = second.message || `Sincronizado. ${results.length} job(s).`;
    lastStatus.lastSyncAt = new Date().toISOString();
    return;
  }

  lastStatus.online = first.ok !== false;
  lastStatus.message = first.message || "Conectado. Aguardando jobs da FlowDesk.";
  lastStatus.lastSyncAt = new Date().toISOString();
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(20000),
  });
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return { ok: false, message: text || `HTTP ${response.status}` };
  }
}

function applyFirewall() {
  if (process.platform === "win32") {
    exec(
      `powershell -NoProfile -Command "Start-Process netsh -Verb RunAs -ArgumentList 'advfirewall firewall add rule name=\\"FlowDesk Whitelist Agent HTTPS\\" dir=out action=allow protocol=TCP remoteport=443 enable=yes'"`,
    );
    return "Pedido de elevacao enviado. Libera saida HTTPS (443). A porta 3306 nao precisa ficar publica no modo Agent.";
  }
  exec("ufw allow out 443/tcp >/dev/null 2>&1 || true");
  return "Regra de saida 443 aplicada se o ufw estiver ativo. MySQL continua so em localhost.";
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  response.end(body);
}

function sendHtml(response) {
  const html = renderHtml();
  response.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(html),
  });
  response.end(html);
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url || "/", `http://127.0.0.1:${PORT}`);
  try {
    if (request.method === "GET" && url.pathname === "/") {
      sendHtml(response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/state") {
      sendJson(response, 200, { ok: true, config: publicConfig(), status: lastStatus });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/save") {
      const body = await readBody(request);
      saveConfig({
        apiUrl: String(body.apiUrl || config.apiUrl).trim(),
        publicId: String(body.publicId || "").trim(),
        token: String(body.token || config.token).trim(),
        db: {
          engine: body.engine || config.db.engine,
          host: String(body.host || "127.0.0.1").trim(),
          port: Number(body.port || 3306),
          database: String(body.database || "").trim(),
          user: String(body.user || "").trim(),
          password: String(body.password || config.db.password),
          ssl: body.ssl === true,
        },
      });
      sendJson(response, 200, { ok: true, message: "Configuracao salva neste PC/VPS." });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/test-db") {
      const result = await executeJob(dbTarget(), "TEST_CONNECTION", {});
      sendJson(response, result.ok === false ? 400 : 200, result);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/sync") {
      await fetchPublicIp();
      await syncWithFlowDesk();
      sendJson(response, lastStatus.online ? 200 : 400, lastStatus);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/firewall") {
      sendJson(response, 200, { ok: true, message: applyFirewall() });
      return;
    }
    response.writeHead(404);
    response.end("Not found");
  } catch (error) {
    sendJson(response, 400, sanitizeError(error));
  }
});

function publicConfig() {
  return {
    apiUrl: config.apiUrl,
    publicId: config.publicId,
    hasToken: Boolean(config.token),
    engine: config.db.engine,
    host: config.db.host,
    port: config.db.port,
    database: config.db.database,
    user: config.db.user,
    ssl: config.db.ssl,
  };
}

function renderHtml() {
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>FlowDesk · Whitelist Agent</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0; font-family: Segoe UI, Inter, sans-serif;
      background: #0b0b0b; color: #d4d4d4;
    }
    header {
      display: flex; align-items: center; justify-content: space-between;
      height: 64px; padding: 0 22px;
      border-bottom: 1px solid #1c1c1c; background: #101010;
    }
    .brand { display: flex; align-items: center; gap: 12px; }
    .mark {
      width: 34px; height: 34px; border-radius: 10px;
      background: #fff; color: #111; display: grid; place-items: center;
      font-weight: 800; font-size: 14px;
    }
    .title { font-size: 15px; font-weight: 650; color: #f2f2f2; }
    .sub { font-size: 12px; color: #7a7a7a; margin-top: 2px; }
    .pill {
      font-size: 12px; padding: 6px 10px; border-radius: 999px;
      border: 1px solid #242424; background: #161616;
    }
    .ok { color: #86d39d; } .wait { color: #d7c27a; }
    main { max-width: 920px; margin: 28px auto; padding: 0 18px 48px; }
    .hero, .card {
      border: 1px solid #1c1c1c; background: #101010;
      border-radius: 18px; padding: 18px;
    }
    .hero { margin-bottom: 14px; }
    .ip { font-size: 28px; letter-spacing: .04em; color: #fff; margin: 8px 0; }
    .hint { color: #808080; font-size: 13px; line-height: 1.55; }
    .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    label { display: block; font-size: 12px; color: #8a8a8a; margin-bottom: 6px; }
    input, select {
      width: 100%; height: 44px; border-radius: 12px; border: 1px solid #222;
      background: #151515; color: #ddd; padding: 0 12px; outline: none;
    }
    .row { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 14px; }
    button {
      height: 42px; border: 0; border-radius: 12px; padding: 0 14px;
      background: #1b1b1b; color: #e8e8e8; cursor: pointer; font-weight: 600;
    }
    button.primary { background: #fff; color: #222; }
    .msg { margin-top: 12px; font-size: 13px; color: #9ad0aa; }
    .err { color: #d39a9a; }
    @media (max-width: 800px) { .grid { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <div class="mark">FD</div>
      <div>
        <div class="title">FlowDesk</div>
        <div class="sub">Whitelist Agent · launcher local</div>
      </div>
    </div>
    <div id="pill" class="pill wait">Iniciando</div>
  </header>
  <main>
    <section class="hero">
      <div class="sub">IP publico desta maquina</div>
      <div class="ip" id="publicIp">...</div>
      <p class="hint">No modo Agent a FlowDesk nao precisa desse IP no campo de banco. Use 127.0.0.1 no MySQL local. Este IP so entra no dashboard se voce insistir em conexao direta e liberar a porta 3306 — o que nao e recomendado.</p>
      <div class="row">
        <button onclick="copyIp()">Copiar IP</button>
        <button onclick="firewall()">Liberar firewall (HTTPS)</button>
        <button class="primary" onclick="syncNow()">Conectar na FlowDesk</button>
      </div>
    </section>
    <section class="card">
      <div class="grid">
        <div><label>API FlowDesk</label><input id="apiUrl" /></div>
        <div><label>ID publico</label><input id="publicId" placeholder="fdwa_..." /></div>
        <div><label>Token</label><input id="token" type="password" placeholder="Cole o token uma vez" /></div>
        <div><label>Host do banco local</label><input id="host" /></div>
        <div><label>Porta</label><input id="port" /></div>
        <div><label>Database</label><input id="database" /></div>
        <div><label>Usuario</label><input id="user" /></div>
        <div><label>Senha local</label><input id="password" type="password" /></div>
        <div>
          <label>Engine</label>
          <select id="engine">
            <option value="mysql">MySQL</option>
            <option value="mariadb">MariaDB</option>
            <option value="postgres">PostgreSQL</option>
          </select>
        </div>
      </div>
      <div class="row">
        <button onclick="saveCfg()">Salvar neste PC</button>
        <button onclick="testDb()">Testar banco local</button>
      </div>
      <div id="msg" class="msg"></div>
    </section>
  </main>
  <script>
    async function api(path, body) {
      const response = await fetch(path, {
        method: body ? "POST" : "GET",
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      return response.json();
    }
    function val(id) { return document.getElementById(id).value; }
    function setMsg(text, ok) {
      const el = document.getElementById("msg");
      el.className = ok ? "msg" : "msg err";
      el.textContent = text || "";
    }
    async function refresh() {
      const state = await api("/api/state");
      const c = state.config || {};
      const s = state.status || {};
      document.getElementById("apiUrl").value = c.apiUrl || "";
      document.getElementById("publicId").value = c.publicId || "";
      document.getElementById("host").value = c.host || "127.0.0.1";
      document.getElementById("port").value = c.port || 3306;
      document.getElementById("database").value = c.database || "";
      document.getElementById("user").value = c.user || "";
      document.getElementById("engine").value = c.engine || "mysql";
      document.getElementById("publicIp").textContent = s.publicIp || "descobrindo...";
      const pill = document.getElementById("pill");
      pill.textContent = s.online ? "Online na FlowDesk" : (s.message || "Offline");
      pill.className = "pill " + (s.online ? "ok" : "wait");
      if (s.message) setMsg(s.message, s.online);
    }
    function payload() {
      return {
        apiUrl: val("apiUrl"),
        publicId: val("publicId"),
        token: val("token"),
        host: val("host"),
        port: Number(val("port") || 3306),
        database: val("database"),
        user: val("user"),
        password: val("password"),
        engine: val("engine"),
      };
    }
    async function saveCfg() {
      const result = await api("/api/save", payload());
      setMsg(result.message || "Salvo.", result.ok);
    }
    async function testDb() {
      await saveCfg();
      const result = await api("/api/test-db", {});
      setMsg(result.ok ? ("Banco local ok (" + (result.latencyMs || 0) + "ms).") : (result.message || "Falha"), result.ok);
    }
    async function syncNow() {
      await saveCfg();
      const result = await api("/api/sync", {});
      setMsg(result.message || JSON.stringify(result), result.online !== false);
      refresh();
    }
    async function firewall() {
      const result = await api("/api/firewall", {});
      setMsg(result.message, true);
    }
    function copyIp() {
      const ip = document.getElementById("publicIp").textContent;
      navigator.clipboard.writeText(ip);
      setMsg("IP copiado: " + ip, true);
    }
    refresh();
    setInterval(refresh, 8000);
  </script>
</body>
</html>`;
}

server.listen(PORT, "127.0.0.1", async () => {
  lastStatus.localIp = localAddresses().join(", ");
  await fetchPublicIp();
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`FlowDesk Whitelist Agent em ${url}`);
  if (process.platform === "win32") exec(`cmd /c start "" "${url}"`);
  else if (process.platform === "darwin") exec(`open "${url}"`);
  setInterval(() => {
    syncWithFlowDesk().catch((error) => {
      lastStatus.online = false;
      lastStatus.message = sanitizeError(error).message;
    });
  }, 4000);
  syncWithFlowDesk().catch(() => null);
});
