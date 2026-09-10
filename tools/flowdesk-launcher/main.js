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
const { healCityMysql } = require("./cityHeal");

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
let backoffMs = 120;
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
  heal: { ok: null, mysql: "unknown", message: "Procurando o MySQL local..." },
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
    heal: runtime.heal,
    version: app.getVersion(),
  };
}

function emitState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("launcher:state", publicState());
  }
}

function resolveAppIconPath() {
  const candidates = [
    path.join(__dirname, "assets", "icon.ico"),
    path.join(__dirname, "assets", "icon.png"),
    path.join(__dirname, "renderer", "assets", "logo.png"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function loadAppIcon(size) {
  const iconPath = resolveAppIconPath();
  if (!iconPath) return nativeImage.createEmpty();
  let image = nativeImage.createFromPath(iconPath);
  if (image.isEmpty()) return image;
  if (size && size > 0) {
    image = image.resize({ width: size, height: size, quality: "best" });
  }
  return image;
}

function applyAppBranding() {
  if (process.platform === "win32") {
    app.setAppUserModelId("com.flowdesk.launcher");
  }
  const icon = loadAppIcon();
  if (!icon.isEmpty()) {
    app.dock?.setIcon?.(icon);
  }
}

function startedHidden() {
  return (
    process.argv.includes("--hidden") ||
    process.argv.includes("--hidden-start") ||
    Boolean(app.getLoginItemSettings?.().wasOpenedAtLogin)
  );
}

function ensureAutoStart() {
  if (!app.isPackaged) return;
  try {
    app.setLoginItemSettings({
      openAtLogin: true,
      openAsHidden: true,
      path: process.execPath,
      args: ["--hidden"],
    });
  } catch (error) {
    logLine(`Falha ao registrar inicio automatico: ${sanitizeError(error).message}`);
  }
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.setSkipTaskbar(false);
  mainWindow.show();
  mainWindow.focus();
}

function hideMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.hide();
  mainWindow.setSkipTaskbar(true);
}

function createWindow() {
  const icon = loadAppIcon();
  const hidden = startedHidden();
  mainWindow = new BrowserWindow({
    width: 460,
    height: 760,
    minWidth: 440,
    minHeight: 700,
    frame: false,
    transparent: false,
    backgroundColor: "#050505",
    resizable: false,
    show: !hidden,
    skipTaskbar: hidden,
    autoHideMenuBar: true,
    icon: icon.isEmpty() ? undefined : icon,
    title: "Flowdesk Launcher Pro",
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
      hideMainWindow();
    }
  });
}

function createTray() {
  const image = loadAppIcon(32);
  if (image.isEmpty()) return;
  tray = new Tray(image);
  tray.setToolTip(`Flowdesk Launcher Pro v${app.getVersion()}`);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Abrir", click: () => showMainWindow() },
      { label: "Corrigir MySQL", click: () => void runHeal({ elevate: true, force: true }) },
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
  tray.on("click", () => showMainWindow());
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
  runtime.cityDb = vault.cityDb && typeof vault.cityDb === "object" ? vault.cityDb : runtime.cityDb;
  markOnline("Conectado ao painel.");
  startHeartbeatLoop();
  startSyncLoop();
  startWatchdog();
  void observePublicIp().then((ip) => {
    if (ip) markOnline(`VPS vinculada. IP publico ${ip}.`);
  });
  void runHeal({ elevate: true });
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
  startWatchdog();
  void runHeal({ elevate: true });
  return { ok: true };
}

function firstFilled(...values) {
  for (const value of values) {
    if (value == null) continue;
    const text = String(value).trim();
    if (text) return value;
  }
  return "";
}

function rememberCityDb(target) {
  if (!target?.user || !target?.database) return;
  const cityDb = {
    engine: target.engine === "postgres" ? "postgres" : "mysql",
    port: Number(target.port || 3306),
    database: String(target.database),
    user: String(target.user),
    password: String(target.password || ""),
    savedAt: new Date().toISOString(),
  };
  runtime.cityDb = cityDb;
  writeVault({ ...readVault(), cityDb });
}

function dbTarget(payload) {
  const fromJob = payload && typeof payload.cityDb === "object" && payload.cityDb ? payload.cityDb : {};
  const fromSync = runtime.config && typeof runtime.config === "object" ? runtime.config : {};
  const fromSyncDb = fromSync.db && typeof fromSync.db === "object" ? fromSync.db : {};
  const fromVault = (runtime.cityDb && typeof runtime.cityDb === "object" ? runtime.cityDb : null) ||
    readVault().cityDb ||
    {};
  const engine = firstFilled(fromJob.engine, fromSync.engine, fromSyncDb.engine, fromVault.engine);
  return {
    engine: engine === "postgres" ? "postgres" : "mysql",
    host: "127.0.0.1",
    port: Number(firstFilled(fromJob.port, fromSync.port, fromSyncDb.port, fromVault.port, 3306)) || 3306,
    database: String(firstFilled(fromJob.database, fromSync.database, fromSyncDb.database, fromVault.database)),
    user: String(firstFilled(fromJob.user, fromSync.user, fromSyncDb.user, fromVault.user)).trim(),
    password: String(firstFilled(fromJob.password, fromSync.password, fromSyncDb.password, fromVault.password)),
    ssl: false,
  };
}

function looksLikeIpv4(value) {
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(String(value || "").trim());
}

let lastPublicIpAt = 0;

async function observePublicIp() {
  if (runtime.publicIp && Date.now() - lastPublicIpAt < 20_000) {
    return runtime.publicIp;
  }
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
    { url: "https://api.seeip.org", parse: (text) => text },
  ];
  const attempts = endpoints.map(async (endpoint) => {
    const response = await fetch(endpoint.url, { signal: AbortSignal.timeout(3500) });
    const ip = String(endpoint.parse((await response.text()).trim()) || "").trim();
    if (!looksLikeIpv4(ip) || ip.startsWith("127.")) {
      throw new Error("ip invalido");
    }
    return ip;
  });
  try {
    const ip = await Promise.any(attempts);
    runtime.publicIp = ip;
    lastPublicIpAt = Date.now();
    return ip;
  } catch {
    return String(runtime.publicIp || "");
  }
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
      backoffMs = Math.min(Math.max(Math.round(backoffMs * 1.6), 500), 15000);
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
    if (synced.config) {
      runtime.config = synced.config;
      if (synced.config.user && synced.config.database) {
        rememberCityDb({
          engine: synced.config.engine,
          port: synced.config.port,
          database: synced.config.database,
          user: synced.config.user,
          password: synced.config.password,
        });
      }
    }
    const results = [];
    for (const job of synced.jobs || []) {
      const target = dbTarget(job.payload || {});
      try {
        let result = await executeJob(target, String(job.operation || ""), job.payload || {});
        if (result.ok === false && /offline|timeout|access denied|unknown database/i.test(String(result.message || result.code || ""))) {
          await runHeal({ elevate: true });
          result = await executeJob(target, String(job.operation || ""), job.payload || {});
        }
        if (result.ok !== false) rememberCityDb(target);
        results.push({
          id: job.id,
          ok: result.ok !== false,
          result,
          errorMessage: result.ok === false ? result.message : null,
        });
      } catch (error) {
        await runHeal({ elevate: true });
        try {
          const retry = await executeJob(target, String(job.operation || ""), job.payload || {});
          if (retry.ok !== false) rememberCityDb(target);
          results.push({
            id: job.id,
            ok: retry.ok !== false,
            result: retry,
            errorMessage: retry.ok === false ? retry.message : null,
          });
        } catch (retryError) {
          const sanitized = sanitizeError(retryError);
          results.push({
            id: job.id,
            ok: false,
            result: sanitized,
            errorMessage: sanitized.message,
          });
        }
      }
    }
    if (results.length) {
      await api("/api/launcher/session", {
        method: "POST",
        body: { action: "sync", results, observedIp: publicIp, appVersion: app.getVersion() },
      });
    } else if (Date.now() - lastHealthAt > 20000) {
      try {
        const target = dbTarget({});
        if (target.user && target.database) {
          const health = await executeJob(target, "HEALTH_CHECK", {});
          if (health.ok !== false) {
            rememberCityDb(target);
            lastHealthAt = Date.now();
          }
        }
        } catch {
          void runHeal({ elevate: false });
        }
    }
    backoffMs = results.length ? 80 : 180;
    if (runtime.heal?.ok === false) {
      runtime.message = runtime.heal.message || "Corrigindo o MySQL local...";
      emitState();
    } else {
      markOnline(
        runtime.publicIp
          ? `VPS no ar. IP ${runtime.publicIp}. MySQL local pronto.`
          : "VPS no ar. MySQL local pronto neste computador.",
      );
    }
  } catch (error) {
    backoffMs = Math.min(Math.max(Math.round(backoffMs * 1.6), 500), 15000);
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
  }, 5000);
}

let lastSyncTick = 0;
let watchdogTimer = null;

function startSyncLoop() {
  clearTimeout(syncTimer);
  const tick = async () => {
    lastSyncTick = Date.now();
    await runSync();
    lastSyncTick = Date.now();
    syncTimer = setTimeout(tick, backoffMs);
  };
  void tick();
}

function startWatchdog() {
  clearInterval(watchdogTimer);
  watchdogTimer = setInterval(() => {
    if (runtime.view !== "home") return;
    if (Date.now() - lastSyncTick > 25_000) {
      logLine("Watchdog: sync parou. Reiniciando loops.");
      startHeartbeatLoop();
      startSyncLoop();
      void runHeal({ elevate: true });
    }
  }, 8000);
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

let lastHealthAt = 0;
let lastElevateAt = 0;
let lastHealAt = 0;
let healTimer = null;
let healInFlight = false;
const ELEVATE_COOLDOWN_MS = 4 * 60 * 60 * 1000;
const HEAL_LOOP_MS = 15_000;

function writeFallbackHealCmd(dest) {
  const script = [
    "@echo off",
    "net session >nul 2>&1",
    "if not %errorLevel%==0 (powershell -NoProfile -Command \"Start-Process -FilePath '%~f0' -Verb RunAs -WindowStyle Hidden\" & exit /b)",
    "netsh advfirewall firewall add rule name=\"Flowdesk City MySQL\" dir=in action=allow protocol=TCP localport=3306 enable=yes profile=any",
    "netsh advfirewall firewall add rule name=\"Flowdesk City MariaDB\" dir=in action=allow protocol=TCP localport=3307 enable=yes profile=any",
    "netsh advfirewall firewall add rule name=\"Flowdesk City Postgres\" dir=in action=allow protocol=TCP localport=5432 enable=yes profile=any",
    "for %%S in (MySQL MySQL80 MySQL57 MariaDB) do (sc config %%S start= auto >nul 2>&1 & sc start %%S >nul 2>&1)",
    "if exist C:\\xampp\\mysql_start.bat start \"\" /b cmd /c C:\\xampp\\mysql_start.bat",
    "exit /b 0",
    "",
  ].join("\r\n");
  fs.writeFileSync(dest, script, "utf8");
}

function requestElevatedHeal() {
  if (process.platform !== "win32") return { ok: true };
  const dest = userDataFile("heal-mysql.cmd");
  const packaged = path.join(process.resourcesPath || "", "heal-mysql.cmd");
  const local = path.join(__dirname, "heal-mysql.cmd");
  const fallback = path.join(__dirname, "open-db-ports.cmd");
  const source = fs.existsSync(packaged)
    ? packaged
    : fs.existsSync(local)
      ? local
      : fs.existsSync(fallback)
        ? fallback
        : "";
  try {
    if (source) fs.copyFileSync(source, dest);
    else writeFallbackHealCmd(dest);
  } catch {
    writeFallbackHealCmd(dest);
  }
  const escaped = dest.replace(/'/g, "''");
  exec(
    `powershell -NoProfile -Command "Start-Process -FilePath '${escaped}' -Verb RunAs -WindowStyle Hidden"`,
  );
  lastElevateAt = Date.now();
  const vault = readVault();
  writeVault({ ...vault, lastElevateAt });
  runtime.heal = {
    ...(runtime.heal || {}),
    mysql: "starting",
    message: "Corrigindo MySQL, firewall e inicio automatico do servico.",
  };
  runtime.message = "Corrigindo o MySQL desta VPS. Aceite a permissao do Windows se aparecer.";
  emitState();
  return { ok: true, message: runtime.message };
}

async function runHeal(options = {}) {
  if (healInFlight && !options.force) return runtime.heal;
  healInFlight = true;
  lastHealAt = Date.now();
  try {
    runtime.heal = {
      ok: runtime.heal?.ok ?? null,
      mysql: "starting",
      message: "Procurando e ligando o MySQL local...",
    };
    emitState();
    const healed = await healCityMysql(dbTarget({}));
    runtime.heal = healed;
    if (healed.ok) {
      lastHealthAt = Date.now();
      if (runtime.view === "home") {
        runtime.message = runtime.publicIp
          ? `VPS no ar. IP ${runtime.publicIp}. MySQL local pronto.`
          : "VPS no ar. MySQL local pronto neste computador.";
      }
      emitState();
      return healed;
    }
    const vault = readVault();
    const lastKnownElevate = Number(vault.lastElevateAt || lastElevateAt || 0);
    const canElevate =
      options.elevate &&
      (options.force || Date.now() - lastKnownElevate > ELEVATE_COOLDOWN_MS);
    if (canElevate) {
      requestElevatedHeal();
      await new Promise((resolve) => setTimeout(resolve, 3500));
      const retry = await healCityMysql(dbTarget({}));
      runtime.heal = retry;
      if (retry.ok && runtime.view === "home") {
        runtime.message = "MySQL corrigido. A Flowdesk ja consegue sincronizar por este launcher.";
      } else if (runtime.view === "home") {
        runtime.message = retry.message || healed.message;
        runtime.lastError = retry.message || healed.message;
      }
      emitState();
      return retry;
    }
    if (runtime.view === "home") {
      runtime.message = healed.message;
      runtime.lastError = healed.message;
    }
    emitState();
    return healed;
  } catch (error) {
    const message = sanitizeError(error).message;
    runtime.heal = { ok: false, mysql: "down", message };
    logLine(`Heal MySQL: ${message}`);
    emitState();
    return runtime.heal;
  } finally {
    healInFlight = false;
  }
}

function prepareFirewall() {
  return runHeal({ elevate: true, force: true });
}

function startHealLoop() {
  clearInterval(healTimer);
  void runHeal({ elevate: true });
  healTimer = setInterval(() => {
    if (Date.now() - lastHealAt < HEAL_LOOP_MS - 250) return;
    const mysqlDown = runtime.heal?.ok !== true;
    void runHeal({ elevate: mysqlDown });
  }, HEAL_LOOP_MS);
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => showMainWindow());
  if (process.defaultApp) {
    if (process.argv.length >= 2) {
      app.setAsDefaultProtocolClient(PROTOCOL, process.execPath, [path.resolve(process.argv[1])]);
    }
  } else {
    app.setAsDefaultProtocolClient(PROTOCOL);
  }

  process.on("uncaughtException", (error) => {
    logLine(`uncaughtException: ${sanitizeError(error).message}`);
    void runHeal({ elevate: false });
  });
  process.on("unhandledRejection", (reason) => {
    logLine(`unhandledRejection: ${sanitizeError(reason).message}`);
  });

  app.whenReady().then(async () => {
    applyAppBranding();
    ensureAutoStart();
    createWindow();
    createTray();
    startHealLoop();
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
ipcMain.on("launcher:minimize", () => hideMainWindow());
ipcMain.on("launcher:close", () => hideMainWindow());
