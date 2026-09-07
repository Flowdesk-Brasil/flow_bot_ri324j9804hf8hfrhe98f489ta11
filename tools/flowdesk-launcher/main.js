const {
  app,
  BrowserWindow,
  ipcMain,
  shell,
  safeStorage,
  Tray,
  Menu,
  nativeImage,
} = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { exec } = require("child_process");
const { executeJob, sanitizeError } = require("./executor");

const PROTOCOL = "flowdesk-launcher";
const PRODUCTION_API_BASES = ["https://www.flwdesk.com", "https://account.flwdesk.com"];
const LOCAL_API_BASE = "http://localhost:3000";
const UPDATE_FEED_URL = "https://www.flwdesk.com/api/launcher/update";
let resolvedApiBase = process.env.FLOWDESK_API_BASE || PRODUCTION_API_BASES[0];

let mainWindow = null;
let tray = null;
let pollTimer = null;
let syncTimer = null;
let heartbeatTimer = null;
let updateTimer = null;
let backoffMs = 400;
const runtime = {
  view: "boot",
  message: "Preparando...",
  loginCode: null,
  user: null,
  servers: [],
  guildId: null,
  connection: "offline",
  hostname: os.hostname(),
  loginUrl: null,
  lastError: null,
  publicIp: null,
  update: { status: "idle", version: null },
};

function userDataFile(name) {
  return path.join(app.getPath("userData"), name);
}

function logLine(message) {
  const line = `[${new Date().toISOString()}] ${String(message).slice(0, 500)}\n`;
  fs.appendFile(userDataFile("launcher.log"), line, () => null);
}

function readVault() {
  try {
    const raw = fs.readFileSync(userDataFile("session.bin"));
    if (!safeStorage.isEncryptionAvailable()) {
      return JSON.parse(raw.toString("utf8"));
    }
    return JSON.parse(safeStorage.decryptString(raw));
  } catch {
    return {};
  }
}

function writeVault(payload) {
  const json = JSON.stringify(payload);
  const encoded = safeStorage.isEncryptionAvailable()
    ? safeStorage.encryptString(json)
    : Buffer.from(json, "utf8");
  fs.writeFileSync(userDataFile("session.bin"), encoded);
}

function getInstallId() {
  const vault = readVault();
  if (vault.installId) return vault.installId;
  const installId = require("crypto").randomUUID();
  writeVault({ ...vault, installId });
  return installId;
}

function publicState() {
  return {
    view: runtime.view,
    message: runtime.message,
    loginCode: runtime.loginCode,
    user: runtime.user,
    servers: runtime.servers,
    guildId: runtime.guildId,
    connection: runtime.connection,
    hostname: runtime.hostname,
    canOpenLogin: Boolean(runtime.loginUrl),
    lastError: runtime.lastError,
    publicIp: runtime.publicIp,
    update: runtime.update,
  };
}

function emitState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("launcher:state", publicState());
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 460,
    height: 760,
    minWidth: 440,
    minHeight: 700,
    frame: false,
    transparent: false,
    backgroundColor: "#050505",
    resizable: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
  mainWindow.on("close", (event) => {
    if (!app.isQuiting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  const image = nativeImage.createFromDataURL(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAGUlEQVR4nO3BMQEAAAgDoJvc6F9hJxP0AA8OBgAB/wM+WwAAAABJRU5ErkJggg==",
  );
  tray = new Tray(image);
  tray.setToolTip("Flowdesk Launcher");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Abrir", click: () => mainWindow?.show() },
      { type: "separator" },
      {
        label: "Sair",
        click: () => {
          app.isQuiting = true;
          app.quit();
        },
      },
    ]),
  );
  tray.on("click", () => mainWindow?.show());
}

function apiBases() {
  const list = [];
  const envBase = String(process.env.FLOWDESK_API_BASE || "").replace(/\/+$/, "");
  if (envBase) list.push(envBase);
  if (resolvedApiBase) list.push(String(resolvedApiBase).replace(/\/+$/, ""));
  if (!app.isPackaged) list.push(LOCAL_API_BASE);
  list.push(...PRODUCTION_API_BASES);
  list.push(LOCAL_API_BASE);
  return [...new Set(list.filter(Boolean))];
}

function isSafeHttpUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function openBrowser(targetUrl) {
  if (!isSafeHttpUrl(targetUrl)) return false;
  logLine("Abrindo o login no navegador.");
  if (process.platform === "win32") {
    exec(`cmd /c start "" "${String(targetUrl).replace(/"/g, "")}"`, (error) => {
      if (error) logLine(`Falha ao abrir o navegador: ${error.message}`);
    });
    return true;
  }
  void shell.openExternal(targetUrl).catch((error) => {
    logLine(`Falha ao abrir o navegador: ${error.message}`);
  });
  return true;
}

function parseApiPayload(response, text) {
  try {
    return JSON.parse(text);
  } catch {
    return {
      ok: false,
      message: `A Flowdesk respondeu HTTP ${response.status} sem JSON.`,
    };
  }
}

function looksLikeMissingRoute(payload) {
  const httpStatus = Number(payload.httpStatus || payload.status || 0);
  return (
    httpStatus === 404 ||
    /HTTP 404|sem JSON|nao esta no ar|nao encontrada|_not-found/i.test(
      String(payload.message || ""),
    )
  );
}

async function fetchApi(base, pathname, options, vault) {
  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  };
  if (vault.accessToken && options.auth !== false) {
    headers.Authorization = `Bearer ${vault.accessToken}`;
  }
  const isLocal = /localhost|127\.0\.0\.1/.test(base);
  const response = await fetch(`${base}${pathname}`, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(options.timeoutMs || (isLocal ? 2500 : 12000)),
    redirect: "manual",
  });
  const contentType = String(response.headers.get("content-type") || "");
  const matchedPath = String(response.headers.get("x-matched-path") || "");
  if (
    matchedPath.includes("_not-found") ||
    (contentType.includes("text/html") && !contentType.includes("json"))
  ) {
    return {
      ok: false,
      httpStatus: 404,
      message: "API do launcher ainda nao esta no ar neste endereco.",
    };
  }
  if (response.status >= 300 && response.status < 400) {
    return {
      ok: false,
      httpStatus: response.status,
      message: `A API redirecionou em vez de responder (${response.status}).`,
    };
  }
  const text = await response.text();
  const payload = parseApiPayload(response, text);
  payload.httpStatus = response.status;
  if (payload.ok !== true && !payload.message && !response.ok) {
    payload.message = `Nao foi possivel falar com a Flowdesk (HTTP ${response.status}).`;
  }
  return payload;
}

async function api(pathname, options = {}) {
  const vault = readVault();
  const bases = apiBases();
  let lastPayload = { ok: false, message: "Nao foi possivel conectar a Flowdesk." };
  for (const base of bases) {
    try {
      const payload = await fetchApi(base, pathname, options, vault);
      if (looksLikeMissingRoute(payload) && bases.length > 1) {
        lastPayload = payload;
        continue;
      }
      resolvedApiBase = base;
      if (
        payload.httpStatus === 401 &&
        vault.refreshToken &&
        options.auth !== false &&
        !options.isRefresh
      ) {
        const refreshed = await api("/api/launcher/session", {
          method: "POST",
          auth: false,
          isRefresh: true,
          body: { action: "refresh", refreshToken: vault.refreshToken },
        });
        if (refreshed.ok && refreshed.accessToken) {
          writeVault({
            ...readVault(),
            accessToken: refreshed.accessToken,
            refreshToken: refreshed.refreshToken,
          });
          return api(pathname, options);
        }
        writeVault({ installId: getInstallId() });
        runtime.view = "login";
        runtime.connection = "offline";
        runtime.message = "Sessao expirada. Entre novamente.";
        runtime.lastError = refreshed.message || "Sessao expirada.";
        emitState();
      }
      return payload;
    } catch (error) {
      lastPayload = {
        ok: false,
        message: `Nao foi possivel conectar a ${base.replace(/^https?:\/\//, "")}.`,
      };
      logLine(`${pathname} via ${base}: ${sanitizeError(error).message}`);
    }
  }
  return lastPayload;
}

function markOnline(message) {
  runtime.connection = "online";
  runtime.message = message || "Conectado ao painel.";
  runtime.lastError = null;
  emitState();
}

function markReconnecting(errorMessage) {
  runtime.connection = runtime.user && runtime.guildId ? "reconnecting" : "offline";
  runtime.lastError = errorMessage || null;
  runtime.message = errorMessage || "Reconectando com a Flowdesk...";
  emitState();
}

async function restoreSession() {
  const vault = readVault();
  if (!vault.accessToken) {
    runtime.view = "login";
    runtime.message = "Entre com a sua conta Flowdesk.";
    emitState();
    return;
  }
  runtime.view = "login";
  runtime.message = "Restaurando sessao...";
  emitState();
  const me = await api("/api/launcher/session");
  if (!me.ok) {
    runtime.view = "login";
    runtime.message = me.message || "Entre com a sua conta Flowdesk.";
    runtime.lastError = me.message || null;
    emitState();
    return;
  }
  runtime.user = me.user;
  runtime.servers = me.servers || [];
  runtime.guildId = me.device?.guildId || null;
  if (!runtime.guildId && runtime.servers.length === 1) {
    await bindServer(runtime.servers[0].guildId);
    return;
  }
  if (!runtime.guildId) {
    runtime.view = "servers";
    runtime.message = "Escolha o servidor que este computador vai conectar.";
    runtime.connection = "awaiting";
    emitState();
    return;
  }
  runtime.view = "home";
  markOnline("Conectado ao painel.");
  startHeartbeatLoop();
  startSyncLoop();
  void observePublicIp().then((ip) => {
    if (ip) markOnline(`VPS vinculada. IP publico ${ip}.`);
  });
  void prepareFirewall();
}

async function startLogin() {
  runtime.view = "login";
  runtime.message = "Abrindo o login da Flowdesk...";
  runtime.loginUrl = null;
  emitState();
  const started = await api("/api/launcher/login/start", {
    method: "POST",
    auth: false,
    body: {
      deviceLabel: "Flowdesk Launcher",
      hostname: os.hostname(),
      platform: process.platform,
      installId: getInstallId(),
      appVersion: app.getVersion(),
    },
  });
  if (!started.ok) {
    runtime.view = "login";
    runtime.message = started.message || "Nao foi possivel iniciar o login.";
    runtime.lastError = started.message || null;
    emitState();
    return { ok: false };
  }
  const loginUrl = started.loginUrl || started.verificationUrl;
  runtime.loginUrl = loginUrl;
  runtime.loginCode = null;
  runtime.view = "waiting";
  runtime.message = "Entre na Flowdesk. Este computador valida e vincula sozinho.";
  emitState();
  if (!openBrowser(loginUrl)) {
    runtime.message = "Nao deu para abrir o navegador. Clique em Abrir login.";
    emitState();
  }
  clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    void pollLogin(started.pollToken);
  }, 1000);
  return { ok: true, loginCode: started.loginCode };
}

async function pollLogin(pollToken) {
  const polled = await api("/api/launcher/login/poll", {
    method: "POST",
    auth: false,
    body: { pollToken },
  });
  if (polled.status !== "completed" || !polled.accessToken) return;
  clearInterval(pollTimer);
  writeVault({
    installId: getInstallId(),
    accessToken: polled.accessToken,
    refreshToken: polled.refreshToken,
  });
  runtime.user = polled.user;
  runtime.loginCode = null;
  await restoreSession();
}

async function bindServer(guildId) {
  const publicIp = await observePublicIp();
  if (publicIp) runtime.publicIp = publicIp;
  const result = await api("/api/launcher/session", {
    method: "POST",
    body: { action: "bind", guildId, observedIp: publicIp },
  });
  if (!result.ok) {
    runtime.message = result.message || "Nao foi possivel conectar este servidor.";
    runtime.lastError = result.message || null;
    emitState();
    return result;
  }
  runtime.guildId = guildId;
  runtime.view = "home";
  markOnline(
    publicIp
      ? `VPS vinculada. IP publico ${publicIp}.`
      : "VPS vinculada. Detectando IP publico...",
  );
  startHeartbeatLoop();
  startSyncLoop();
  void prepareFirewall();
  return { ok: true };
}

function dbTarget(payload) {
  const config = runtime.config || {};
  const cityDb = payload && typeof payload.cityDb === "object" && payload.cityDb ? payload.cityDb : {};
  const user = String(cityDb.user || config.user || "usuariodeteste").trim() || "usuariodeteste";
  const typed = cityDb.password || config.password || "";
  return {
    engine: cityDb.engine === "postgres" || config.engine === "postgres" ? "postgres" : "mysql",
    host: "localhost",
    port: Number(cityDb.port || config.port || 3306),
    database: cityDb.database || config.database,
    user,
    password: typed || (user === "usuariodeteste" ? "12345" : ""),
    ssl: false,
  };
}

function looksLikeIpv4(value) {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(String(value || "").trim());
}

async function observePublicIp() {
  const endpoints = [
    {
      url: "https://api.ipify.org?format=json",
      parse: (text) => {
        try {
          return String(JSON.parse(text).ip || "");
        } catch {
          return "";
        }
      },
    },
    { url: "https://ifconfig.me/ip", parse: (text) => text },
    { url: "https://icanhazip.com", parse: (text) => text },
  ];
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint.url, { signal: AbortSignal.timeout(4000) });
      const ip = String(endpoint.parse((await response.text()).trim()) || "").trim();
      if (looksLikeIpv4(ip) && !ip.startsWith("127.")) {
        runtime.publicIp = ip;
        return ip;
      }
    } catch {
      /* try the next public-IP service */
    }
  }
  return String(runtime.publicIp || "");
}

async function runHeartbeat() {
  if (!readVault().accessToken || runtime.view !== "home") return false;
  const publicIp = await observePublicIp();
  if (publicIp) emitState();
  const heartbeat = await api("/api/launcher/session", {
    method: "POST",
    body: {
      action: "heartbeat",
      observedIp: publicIp,
      appVersion: app.getVersion(),
    },
  });
  if (heartbeat.ok) {
    if (heartbeat.guildId && !runtime.guildId) runtime.guildId = heartbeat.guildId;
    markOnline("Conectado ao painel.");
    return true;
  }
  const me = await api("/api/launcher/session");
  if (me.ok && me.device?.guildId) {
    runtime.guildId = me.device.guildId;
    runtime.user = me.user || runtime.user;
    markOnline("Sessao ativa. Reenviando sinal ao painel...");
    return true;
  }
  markReconnecting(heartbeat.message || me.message || "Reconectando com a Flowdesk...");
  return false;
}

async function runSync() {
  try {
    const alive = await runHeartbeat();
    if (!alive) {
      backoffMs = Math.min(backoffMs * 2, 30000);
      return;
    }
    const publicIp = await observePublicIp();
    const synced = await api("/api/launcher/session", {
      method: "POST",
      body: {
        action: "sync",
        observedIp: publicIp,
        appVersion: app.getVersion(),
        results: [],
      },
    });
    if (!synced.ok) {
      backoffMs = Math.min(backoffMs + 2000, 15000);
      runtime.message = "Conectado. Sincronizando tarefas...";
      runtime.lastError = synced.message || null;
      emitState();
      return;
    }
    if (synced.config) runtime.config = synced.config;
    const results = [];
    for (const job of synced.jobs || []) {
      try {
        const result = await executeJob(dbTarget(job.payload || {}), String(job.operation || ""), job.payload || {});
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
        if (sanitized.code === "timeout" || sanitized.code === "offline") {
          void prepareFirewall();
        }
      }
    }
    if (results.length) {
      await api("/api/launcher/session", {
        method: "POST",
        body: { action: "sync", results, observedIp: publicIp, appVersion: app.getVersion() },
      });
    }
    backoffMs = results.length ? 250 : 400;
    markOnline(
      runtime.publicIp
        ? `VPS no ar. IP ${runtime.publicIp}. MySQL pronto neste computador.`
        : "VPS no ar. MySQL pronto neste computador.",
    );
  } catch (error) {
    backoffMs = Math.min(backoffMs * 2, 30000);
    const message = sanitizeError(error).message;
    logLine(message);
    if (runtime.connection === "online") {
      runtime.message = "Conectado. Tentando sincronizar de novo...";
      runtime.lastError = message;
      emitState();
      return;
    }
    markReconnecting(message);
  }
}

function startHeartbeatLoop() {
  clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    void runHeartbeat();
  }, 8000);
}

function startSyncLoop() {
  clearTimeout(syncTimer);
  const tick = async () => {
    await runSync();
    syncTimer = setTimeout(tick, backoffMs);
  };
  void tick();
}

function loadAutoUpdater() {
  try {
    return require("electron-updater").autoUpdater;
  } catch (error) {
    logLine(`Auto-update indisponivel: ${sanitizeError(error).message}`);
    return null;
  }
}

async function startAutoUpdate() {
  if (!app.isPackaged) return;
  const autoUpdater = loadAutoUpdater();
  if (!autoUpdater) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;
  autoUpdater.setFeedURL({
    provider: "generic",
    url: UPDATE_FEED_URL,
  });
  autoUpdater.on("checking-for-update", () => {
    runtime.update = { status: "checking", version: runtime.update.version };
    emitState();
  });
  autoUpdater.on("update-available", (info) => {
    runtime.update = { status: "available", version: info.version || null };
    emitState();
  });
  autoUpdater.on("update-not-available", () => {
    if (runtime.update.status !== "ready") {
      runtime.update = { status: "idle", version: null };
      emitState();
    }
  });
  autoUpdater.on("update-downloaded", (info) => {
    runtime.update = { status: "ready", version: info.version || null };
    emitState();
  });
  autoUpdater.on("error", (error) => {
    logLine(`Falha no auto-update: ${sanitizeError(error).message}`);
  });
  try {
    await autoUpdater.checkForUpdates();
  } catch (error) {
    logLine(`Falha ao procurar atualizacao: ${sanitizeError(error).message}`);
  }
  clearInterval(updateTimer);
  updateTimer = setInterval(() => {
    void autoUpdater.checkForUpdates().catch((error) => {
      logLine(`Falha ao procurar atualizacao: ${sanitizeError(error).message}`);
    });
  }, 30 * 60 * 1000);
}

function installReadyUpdate() {
  const autoUpdater = loadAutoUpdater();
  if (!autoUpdater || runtime.update.status !== "ready") return { ok: false };
  app.isQuiting = true;
  autoUpdater.quitAndInstall();
  return { ok: true };
}

let lastFirewallAt = 0;

function writeFallbackPortsCmd(dest) {
  const script = [
    "@echo off",
    "net session >nul 2>&1",
    "if not %errorLevel%==0 (powershell -NoProfile -Command \"Start-Process -FilePath '%~f0' -Verb RunAs\" & exit /b)",
    "netsh advfirewall firewall add rule name=\"Flowdesk City MySQL\" dir=in action=allow protocol=TCP localport=3306 enable=yes profile=any",
    "netsh advfirewall firewall add rule name=\"Flowdesk City MariaDB\" dir=in action=allow protocol=TCP localport=3307 enable=yes profile=any",
    "netsh advfirewall firewall add rule name=\"Flowdesk City Postgres\" dir=in action=allow protocol=TCP localport=5432 enable=yes profile=any",
    "for %%S in (MySQL MySQL80 MySQL57 MariaDB) do sc start %%S >nul 2>&1",
    "exit /b 0",
    "",
  ].join("\r\n");
  fs.writeFileSync(dest, script, "utf8");
}

function prepareFirewall() {
  if (process.platform !== "win32") return { ok: true };
  if (Date.now() - lastFirewallAt < 60_000) {
    return { ok: true, message: runtime.message };
  }
  lastFirewallAt = Date.now();
  const dest = userDataFile("open-db-ports.cmd");
  const packaged = path.join(process.resourcesPath || "", "open-db-ports.cmd");
  const local = path.join(__dirname, "open-db-ports.cmd");
  const source = fs.existsSync(packaged) ? packaged : fs.existsSync(local) ? local : "";
  try {
    if (source) fs.copyFileSync(source, dest);
    else writeFallbackPortsCmd(dest);
  } catch {
    writeFallbackPortsCmd(dest);
  }
  const escaped = dest.replace(/'/g, "''");
  exec(
    `powershell -NoProfile -Command "Start-Process -FilePath '${escaped}' -Verb RunAs"`,
  );
  runtime.message = runtime.publicIp
    ? `IP ${runtime.publicIp} publicado. Abrindo o script de portas do MySQL.`
    : "Abrindo o script de portas do MySQL nesta VPS.";
  emitState();
  return { ok: true, message: runtime.message };
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => mainWindow?.show());
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
    }
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }

  app.whenReady().then(async () => {
    createWindow();
    createTray();
    await restoreSession();
    void startAutoUpdate();
  });
}

ipcMain.handle("launcher:state", () => publicState());
ipcMain.handle("launcher:login", () => startLogin());
ipcMain.handle("launcher:open-login", () => {
  if (!runtime.loginUrl) return { ok: false };
  return { ok: openBrowser(runtime.loginUrl) };
});
ipcMain.handle("launcher:bind", (_event, guildId) => bindServer(String(guildId || "")));
ipcMain.handle("launcher:logout", async () => {
  await api("/api/launcher/session", { method: "POST", body: { action: "logout" } }).catch(() => null);
  writeVault({ installId: getInstallId() });
  clearTimeout(syncTimer);
  clearInterval(heartbeatTimer);
  runtime.view = "login";
  runtime.user = null;
  runtime.servers = [];
  runtime.guildId = null;
  runtime.config = null;
  runtime.connection = "offline";
  runtime.message = "Sessao encerrada.";
  runtime.lastError = null;
  emitState();
  return { ok: true };
});
ipcMain.handle("launcher:firewall", () => prepareFirewall());
ipcMain.handle("launcher:install-update", () => installReadyUpdate());
ipcMain.on("launcher:minimize", () => mainWindow?.hide());
ipcMain.on("launcher:close", () => {
  app.isQuiting = true;
  app.quit();
});
