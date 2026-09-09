'use strict';
const express = require('express');
const { exec, execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const cors = require('cors');

const app = express();
app.disable("x-powered-by");
app.use(cors({ origin: false }));
app.use(express.json({ limit: "10mb" }));
app.use((req, res, next) => {
  res.setHeader("X-Flowdesk-Agent", "vps-daemon");
  res.setHeader("Cache-Control", "no-store");
  next();
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "flowdesk-vps-daemon",
    uptime: Math.round(process.uptime()),
    ts: new Date().toISOString(),
  });
});
app.get("/ping", (req, res) => res.json({ ok: true }));

// ─── Config ──────────────────────────────────────────────────────────────────
const AUTH_TOKEN =
  process.env.DAEMON_TOKEN ||
  process.env.HOSTING_AGENT_TOKEN ||
  process.env.VPS_AGENT_TOKEN ||
  process.env.FLOWDESK_VPS_AGENT_TOKEN ||
  "flowdesk-super-secret-token-v1";
const PROJECTS_DIR = process.env.PROJECTS_DIR || "/root/flowdesk-projects";
const MINECRAFT_HOSTING_ROOT = process.env.MINECRAFT_HOSTING_ROOT || "/srv/flowdesk-minecraft";
const PORT         = process.env.PORT || 5001;
const FLOWDESK_WEBHOOK_TOKEN = process.env.FLOWDESK_WEBHOOK_TOKEN || AUTH_TOKEN;
const minecraftProcesses = new Map();
const minecraftStartJobs = new Map();

if (!AUTH_TOKEN) {
  throw new Error("Configure DAEMON_TOKEN/HOSTING_AGENT_TOKEN before starting the VPS daemon.");
}

if (!fs.existsSync(PROJECTS_DIR)) {
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
}

if (!fs.existsSync(MINECRAFT_HOSTING_ROOT)) {
  fs.mkdirSync(MINECRAFT_HOSTING_ROOT, { recursive: true });
}

function ensureRuntimePath() {
  const extras = [];
  try {
    const root = "/www/server/nodejs";
    if (fs.existsSync(root)) {
      for (const name of fs.readdirSync(root)) {
        const bin = path.join(root, name, "bin");
        if (fs.existsSync(path.join(bin, "node"))) extras.push(bin);
      }
    }
  } catch {
    /* ignore */
  }
  extras.push("/usr/local/bin", "/usr/bin", "/bin");
  process.env.PATH = [...new Set([...extras, ...(process.env.PATH || "").split(":").filter(Boolean)])].join(":");
}
ensureRuntimePath();

function canonicalizeAgentPath(value) {
  const raw = String(value || "/").split("?")[0];
  return raw.length > 1 && raw.endsWith("/") ? raw.slice(0, -1) : raw || "/";
}

function serializeAgentBody(body) {
  if (body === undefined || body === null) return "{}";
  if (typeof body === "string") {
    const trimmed = body.trim();
    return trimmed || "{}";
  }
  try {
    return JSON.stringify(body);
  } catch {
    return "{}";
  }
}

function signVpsAgentRequest(vpsCode, method, path, serializedBody) {
  return crypto
    .createHmac("sha256", AUTH_TOKEN)
    .update(`${vpsCode}:${method}:${canonicalizeAgentPath(path)}:${serializedBody}`)
    .digest("hex");
}

function signaturesMatch(leftHex, rightHex) {
  const left = Buffer.from(String(leftHex || ""), "utf8");
  const right = Buffer.from(String(rightHex || ""), "utf8");
  if (!left.length || left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

// ─── Auth Middleware ──────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const auth = req.headers['authorization'] || '';
  if (auth !== `Bearer ${AUTH_TOKEN}`) {
    return res.status(401).json({ ok: false, message: "Unauthorized agent token" });
  }
  const signature = String(req.headers['x-flowdesk-signature'] || '');
  const vpsCode = String(req.headers['x-flowdesk-vps'] || req.params?.vpsCode || '');
  if (signature && vpsCode) {
    const serializedBody = serializeAgentBody(req.body);
    const pathCandidates = [...new Set([
      req.originalUrl,
      req.url,
      req.path,
      canonicalizeAgentPath(req.originalUrl),
      canonicalizeAgentPath(req.url),
    ].filter(Boolean))];
    const bodyCandidates = [...new Set([serializedBody, "{}", ""])];
    const accepted = pathCandidates.some((pathValue) =>
      bodyCandidates.some((bodyValue) =>
        signaturesMatch(signature, signVpsAgentRequest(vpsCode, req.method, pathValue, bodyValue)),
      ),
    );
    if (!accepted) {
      return res.status(401).json({ ok: false, message: "Invalid request signature" });
    }
  }
  next();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Executes a shell command and returns its output. */
function runCommand(command, cwd, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...extraEnv };

    // Inject .env file if it exists in cwd
    if (cwd && fs.existsSync(cwd)) {
      const envPath = path.join(cwd, '.env');
      if (fs.existsSync(envPath)) {
        try {
          const lines = fs.readFileSync(envPath, 'utf8').split('\n');
          for (const line of lines) {
            const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
            if (!match) continue;
            const key = match[1];
            let val = (match[2] || '').trim();
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
              val = val.slice(1, -1);
            }
            // Never override system critical vars
            if (!['PATH','HOME','USER','SHELL','LOGNAME'].includes(key)) {
              env[key] = val;
            }
          }
        } catch (_) { /* ignore .env parse errors */ }
      }
    }

    const opts = { env, shell: '/bin/sh', maxBuffer: 128 * 1024 * 1024 };
    if (cwd && fs.existsSync(cwd)) opts.cwd = cwd;

    exec(command, opts, (error, stdout, stderr) => {
      if (error) {
        // pm2 sometimes exits non-zero but operation succeeded
        const out = (stdout || '') + (stderr || '');
        if (stderr && !error.killed) {
          // Non-fatal: return combined output
          return resolve(out);
        }
        return reject(new Error(stderr || error.message));
      }
      resolve(stdout || stderr || '');
    });
  });
}

function runCommandStrict(command, cwd, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...extraEnv };
    const opts = { env, shell: '/bin/sh', maxBuffer: 128 * 1024 * 1024 };
    if (cwd && fs.existsSync(cwd)) opts.cwd = cwd;
    exec(command, opts, (error, stdout, stderr) => {
      const output = (stdout || '') + (stderr || '');
      if (error) return reject(new Error(output || error.message));
      resolve(output);
    });
  });
}

/** Parse all env vars from the project's .env file and return as object */
function loadProjectEnv(projectPath) {
  const envPath = path.join(projectPath, '.env');
  if (!fs.existsSync(envPath)) return {};
  const env = {};
  const lines = fs.readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
    if (!match) continue;
    const key = match[1];
    let val = (match[2] || '').trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!['PATH','HOME','USER','SHELL','LOGNAME'].includes(key)) {
      env[key] = val;
    }
  }
  return env;
}

/** Write an env object to the project's .env file */
function writeProjectEnv(projectPath, envObj) {
  const lines = Object.entries(envObj).map(([k, v]) => {
    const escaped = String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
    return `${k}="${escaped}"`;
  });
  fs.writeFileSync(path.join(projectPath, '.env'), lines.join('\n') + '\n', 'utf8');
}

const MINECRAFT_HIDDEN_FILE_NAMES = new Set(['limits.json', 'domains.json', 'server.json', 'world.json']);

function isHiddenMinecraftFilePath(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/').split('/').filter(Boolean);
  const name = normalized[normalized.length - 1] || '';
  return MINECRAFT_HIDDEN_FILE_NAMES.has(name);
}

/** Recursive file tree walker */
function walkTree(dir, relPrefix = '', options = {}) {
  const result = [];
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return result; }
  for (const name of entries) {
    if (name === '.git' || name === 'node_modules' || name === '.env') continue;
    const full = path.join(dir, name);
    const rel  = relPrefix ? `${relPrefix}/${name}` : name;
    if (options.minecraft && isHiddenMinecraftFilePath(rel)) continue;
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (stat.isDirectory()) {
      result.push({ name, path: rel, type: 'directory', language: null, children: walkTree(full, rel, options) });
    } else {
      result.push({ name, path: rel, type: 'file', language: langFromName(name), children: undefined });
    }
  }
  return result.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function langFromName(name) {
  const ext = name.split('.').pop().toLowerCase();
  const map = { js:'javascript', ts:'typescript', py:'python', json:'json', md:'markdown',
                yml:'yaml', yaml:'yaml', sh:'shell', env:'dotenv', txt:'text', css:'css',
                html:'html', jsx:'javascriptreact', tsx:'typescriptreact' };
  return map[ext] || 'text';
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function projectFileNames(projectPath) {
  try {
    return fs.readdirSync(projectPath).filter((name) => name !== "." && name !== "..");
  } catch {
    return [];
  }
}

function detectFrameworkRecipe(projectPath, incoming) {
  if (incoming && typeof incoming === "object" && incoming.startCommand) {
    return {
      id: incoming.id || "custom",
      label: incoming.label || "App",
      installCommand: incoming.installCommand || null,
      buildCommand: incoming.buildCommand || null,
      startCommand: String(incoming.startCommand),
      outputDir: incoming.outputDir || null,
    };
  }
  const persisted = readJsonSafe(path.join(projectPath, ".flowdesk-recipe.json"));
  if (persisted?.startCommand) return persisted;

  const files = projectFileNames(projectPath);
  const pkg = readJsonSafe(path.join(projectPath, "package.json"));
  const has = (name) => files.includes(name);
  const dep = (name) => Boolean(pkg?.dependencies?.[name] || pkg?.devDependencies?.[name]);
  const script = (name) => (typeof pkg?.scripts?.[name] === "string" ? pkg.scripts[name] : null);

  if (has("next.config.ts") || has("next.config.js") || has("next.config.mjs") || has("next.config.cjs") || dep("next")) {
    return {
      id: "nextjs",
      label: "Next.js",
      installCommand: "npm install --production=false",
      buildCommand: script("build") ? "npm run build" : "npx next build",
      startCommand: "npx next start -H 0.0.0.0 -p $PORT",
      outputDir: ".next",
    };
  }
  if (has("nuxt.config.ts") || has("nuxt.config.js") || dep("nuxt")) {
    return {
      id: "nuxt",
      label: "Nuxt",
      installCommand: "npm install --production=false",
      buildCommand: script("build") ? "npm run build" : "npx nuxt build",
      startCommand: script("start") ? "npm start" : "npx nuxt start --port $PORT --hostname 0.0.0.0",
      outputDir: ".output",
    };
  }
  if (has("vite.config.ts") || has("vite.config.js") || has("vite.config.mjs") || dep("vite")) {
    return {
      id: "vite",
      label: "Vite",
      installCommand: "npm install --production=false",
      buildCommand: script("build") ? "npm run build" : "npx vite build",
      startCommand: "npx vite preview --host 0.0.0.0 --port $PORT",
      outputDir: "dist",
    };
  }
  if (has("nest-cli.json") || dep("@nestjs/core")) {
    return {
      id: "nestjs",
      label: "NestJS",
      installCommand: "npm install --production=false",
      buildCommand: script("build") ? "npm run build" : "npx nest build",
      startCommand: script("start") ? "npm start" : "node dist/main.js",
      outputDir: "dist",
    };
  }
  if (pkg) {
    return {
      id: "node",
      label: "Node.js",
      installCommand: "npm install --production=false",
      buildCommand: script("build") && !/dev|watch/i.test(script("build")) ? "npm run build" : null,
      startCommand: script("start") ? "npm start" : pkg.main ? `node ${pkg.main}` : "node index.js",
      outputDir: null,
    };
  }
  if (has("requirements.txt") || has("main.py") || has("app.py") || has("bot.py")) {
    const entry = has("app.py") ? "app.py" : has("bot.py") ? "bot.py" : "main.py";
    return {
      id: "python",
      label: "Python",
      installCommand: has("requirements.txt") ? "pip3 install -r requirements.txt" : null,
      buildCommand: null,
      startCommand: `python3 ${entry}`,
      outputDir: null,
    };
  }
  return null;
}

function persistFrameworkRecipe(projectPath, recipe) {
  if (!projectPath || !fs.existsSync(projectPath) || !recipe) return;
  fs.writeFileSync(path.join(projectPath, ".flowdesk-recipe.json"), JSON.stringify(recipe), "utf8");
}

function isSafeProjectCommand(command) {
  return /^(npm|npx|node|python3|pip3|true)\b/.test(String(command || "").trim());
}

/** Detect the start command from a project dir */
function detectStartScript(projectPath) {
  const recipe = detectFrameworkRecipe(projectPath, null);
  if (recipe?.startCommand) {
    return { interpreter: "bash", script: recipe.startCommand, recipe };
  }
  return null;
}

function sanitizeGitBranch(value) {
  const text = String(value || "main").trim();
  return /^[A-Za-z0-9._/-]+$/.test(text) ? text : "main";
}

function listProjectNames(projectPath) {
  try {
    return fs.readdirSync(projectPath).filter((name) => name !== "." && name !== "..");
  } catch {
    return [];
  }
}

function isBareProjectDir(projectPath) {
  if (!fs.existsSync(projectPath)) return true;
  const names = listProjectNames(projectPath);
  if (!names.length) return true;
  return names.every((name) => name === ".env" || name === ".env.example");
}

function projectNeedsDeploy(projectPath) {
  if (isBareProjectDir(projectPath)) return true;
  if (detectStartScript(projectPath)) return false;
  return !fs.existsSync(path.join(projectPath, ".git"));
}

function notifyProjectProvisioned(vpsCode) {
  if (typeof fetch === "undefined") return;
  fetch("https://fdesk.flwdesk.com/api/webhooks/vps-provisioned", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      token: FLOWDESK_WEBHOOK_TOKEN,
      vpsCode,
      status: "online",
    }),
  }).catch(() => {});
}

async function installProjectDependencies(projectPath, recipe) {
  const command = recipe?.installCommand;
  if (command && command !== "true" && isSafeProjectCommand(command)) {
    await runCommand(command, projectPath);
    return;
  }
  if (fs.existsSync(path.join(projectPath, "package.json"))) {
    await runCommand("npm install --production=false", projectPath);
    return;
  }
  if (fs.existsSync(path.join(projectPath, "requirements.txt"))) {
    await runCommand("pip3 install -r requirements.txt", projectPath).catch(() => {});
  }
}

async function cloneProjectFromGit(projectPath, gitUrl, branch) {
  const envBackup = loadProjectEnv(projectPath);
  const tmpPath = `${projectPath}.clone-tmp`;
  if (fs.existsSync(tmpPath)) {
    fs.rmSync(tmpPath, { recursive: true, force: true });
  }
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
  await runCommand(`git clone --depth=1 -b ${branch} "${gitUrl}" "${tmpPath}"`, PROJECTS_DIR);
  if (fs.existsSync(projectPath)) {
    fs.rmSync(projectPath, { recursive: true, force: true });
  }
  fs.renameSync(tmpPath, projectPath);
  if (Object.keys(envBackup).length) {
    writeProjectEnv(projectPath, { ...loadProjectEnv(projectPath), ...envBackup });
  }
}

function projectHttpPort(vpsCode) {
  let hash = 0;
  for (const ch of String(vpsCode)) hash = ((hash * 33) + ch.charCodeAt(0)) >>> 0;
  return 31000 + (hash % 900);
}

function nginxConfigDirs() {
  const preferred = "/www/server/panel/vhost/nginx";
  if (fs.existsSync(preferred)) return [preferred];
  const fallback = "/etc/nginx/conf.d";
  return fs.existsSync(fallback) ? [fallback] : [];
}

function flowdeskTlsPaths() {
  return {
    dir: "/opt/flowdesk/certs",
    crt: "/opt/flowdesk/certs/flwdesk.crt",
    key: "/opt/flowdesk/certs/flwdesk.key",
  };
}

function ensureFlowdeskTlsCert() {
  const { dir, crt, key } = flowdeskTlsPaths();
  if (fs.existsSync(crt) && fs.existsSync(key)) return { crt, key };
  fs.mkdirSync(dir, { recursive: true });
  execSync(
    `openssl req -x509 -nodes -days 825 -newkey rsa:2048 -keyout "${key}" -out "${crt}" -subj "/CN=*.flwdesk.com" -addext "subjectAltName=DNS:*.flwdesk.com,DNS:flwdesk.com"`,
    { stdio: "ignore" },
  );
  return { crt, key };
}

function nginxSslListenBlock() {
  const { crt, key } = ensureFlowdeskTlsCert();
  return `    listen 443 ssl http2;
    listen [::]:443 ssl http2;
    ssl_certificate ${crt};
    ssl_certificate_key ${key};`;
}

function normalizeProjectHosts(domains, vpsCode) {
  const hosts = (Array.isArray(domains) ? domains : [])
    .map((item) => String(item || "").trim().toLowerCase())
    .filter((item) => /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(item) || /^[a-z0-9]$/.test(item));
  const fallback = `${String(vpsCode || "site").toLowerCase()}.flwdesk.com`;
  if (!hosts.includes(fallback)) hosts.push(fallback);
  return [...new Set(hosts)];
}

function persistProjectHosts(projectPath, hosts) {
  if (!projectPath || !fs.existsSync(projectPath) || !hosts.length) return;
  fs.writeFileSync(path.join(projectPath, ".flowdesk-domains.json"), JSON.stringify(hosts), "utf8");
}

function loadPersistedHosts(projectPath) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(projectPath, ".flowdesk-domains.json"), "utf8"));
    return Array.isArray(raw) ? raw.map((item) => String(item || "")).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function projectLooksBuilt(projectPath, recipe) {
  const outputDir = recipe?.outputDir;
  if (outputDir === ".next") return fs.existsSync(path.join(projectPath, ".next", "BUILD_ID"));
  if (outputDir && outputDir !== ".") return fs.existsSync(path.join(projectPath, outputDir));
  return fs.existsSync(path.join(projectPath, ".next", "BUILD_ID"))
    || fs.existsSync(path.join(projectPath, "dist", "index.js"));
}

async function buildProjectIfNeeded(projectPath, recipe) {
  const command = recipe?.buildCommand;
  if (!command || !isSafeProjectCommand(command)) return;
  if (projectLooksBuilt(projectPath, recipe)) return;
  await runCommand(command, projectPath);
}

function writeFlowdeskErrorPages() {
  const dir = "/opt/flowdesk/error-pages";
  fs.mkdirSync(dir, { recursive: true });
  const shell = (code, title, text) => `<!doctype html>
<html lang="pt-BR">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${code} — Flowdesk</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #fafafa; color: #111; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
    main { width: min(520px, calc(100vw - 48px)); }
    p.kicker { margin: 0 0 16px; font-size: 13px; letter-spacing: .16em; text-transform: uppercase; color: #8a8a8a; }
    h1 { margin: 0 0 12px; font-size: 44px; letter-spacing: -.04em; }
    p.copy { margin: 0; line-height: 1.6; color: #666; }
    a { color: #111; }
  </style>
</head>
<body>
  <main>
    <p class="kicker">Flowdesk Hosting</p>
    <h1>${title}</h1>
    <p class="copy">${text}</p>
  </main>
</body>
</html>`;
  fs.writeFileSync(path.join(dir, "404.html"), shell("404", "404", "Este projeto nao existe ou ainda nao foi publicado. Confira o subdominio no painel da VPS."));
  fs.writeFileSync(path.join(dir, "500.html"), shell("500", "500", "O site encontrou um erro temporario. Tente novamente em instantes."));
  fs.writeFileSync(path.join(dir, "502.html"), shell("502", "502", "O projeto ainda esta subindo ou ficou offline. Inicie a VPS no painel Flowdesk."));
}

function writeNginxFile(fileName, contents) {
  for (const dir of nginxConfigDirs()) {
    fs.writeFileSync(path.join(dir, fileName), contents, "utf8");
  }
}

function writeDefaultCustomerNginx() {
  writeFlowdeskErrorPages();
  writeNginxFile("flowdesk-default.conf", `server {
    listen 80;
    listen [::]:80;
${nginxSslListenBlock()}
    server_name *.flwdesk.com;
    root /opt/flowdesk/error-pages;
    error_page 404 /404.html;
    error_page 500 /500.html;
    error_page 502 503 504 /502.html;
    location / {
        try_files $uri /404.html;
    }
    location = /404.html { }
    location = /500.html { }
    location = /502.html { }
}
`);
}

function writeProjectNginx(vpsCode, domains, port) {
  const hosts = normalizeProjectHosts(domains, vpsCode);
  writeNginxFile(`flowdesk-${vpsCode}.conf`, `server {
    listen 80;
    listen [::]:80;
${nginxSslListenBlock()}
    server_name ${hosts.join(" ")};
    client_max_body_size 32m;
    error_page 404 /flowdesk-404.html;
    error_page 500 /flowdesk-500.html;
    error_page 502 503 504 /flowdesk-502.html;
    location = /flowdesk-404.html { alias /opt/flowdesk/error-pages/404.html; }
    location = /flowdesk-500.html { alias /opt/flowdesk/error-pages/500.html; }
    location = /flowdesk-502.html { alias /opt/flowdesk/error-pages/502.html; }
    location / {
        proxy_pass http://127.0.0.1:${port};
        proxy_http_version 1.1;
        proxy_connect_timeout 3s;
        proxy_read_timeout 60s;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_intercept_errors on;
    }
}
`);
  return hosts;
}

async function reloadNginx() {
  await runCommand("nginx -t && nginx -s reload").catch(() =>
    runCommand("/etc/init.d/nginx reload").catch(() => null),
  );
}

async function publishProjectHttp(vpsCode, projectPath, domains) {
  const port = projectHttpPort(vpsCode);
  const envObj = loadProjectEnv(projectPath);
  envObj.PORT = String(port);
  envObj.HOST = "0.0.0.0";
  envObj.HOSTNAME = "0.0.0.0";
  if (fs.existsSync(projectPath)) {
    writeProjectEnv(projectPath, envObj);
  }
  const hosts = normalizeProjectHosts([
    ...(Array.isArray(domains) ? domains : []),
    ...loadPersistedHosts(projectPath),
  ], vpsCode);
  persistProjectHosts(projectPath, hosts);
  writeDefaultCustomerNginx();
  writeProjectNginx(vpsCode, hosts, port);
  await reloadNginx();
  return port;
}

async function ensureCustomerHttpStack() {
  try {
    writeDefaultCustomerNginx();
    await reloadNginx();
  } catch (error) {
    console.error("[Flowdesk Daemon] Falha ao publicar nginx padrao:", error.message);
  }
}

async function deployProject(vpsCode, projectPath, input = {}) {
  const gitUrl = String(input.gitUrl || "").trim();
  const branch = sanitizeGitBranch(input.branch);

  if (fs.existsSync(path.join(projectPath, ".git"))) {
    await runCommand(`git fetch origin && git reset --hard origin/${branch}`, projectPath);
  } else if (gitUrl) {
    await cloneProjectFromGit(projectPath, gitUrl, branch);
  } else {
    const error = new Error("gitUrl obrigatorio para deploy inicial.");
    error.code = "needs_deploy";
    throw error;
  }

  const recipe = detectFrameworkRecipe(projectPath, input.framework);
  persistFrameworkRecipe(projectPath, recipe);
  await installProjectDependencies(projectPath, recipe);
  await buildProjectIfNeeded(projectPath, recipe);
  const port = await publishProjectHttp(vpsCode, projectPath, input.domains);
  await pm2StartOrRestart(vpsCode, projectPath, recipe);
  notifyProjectProvisioned(vpsCode);
  return {
    ok: true,
    status: "online",
    autoDeployed: true,
    port,
    framework: recipe,
    message: recipe?.label
      ? `Deploy ${recipe.label} concluido e projeto no ar.`
      : "Deploy concluido e projeto iniciado.",
  };
}

async function startOrRestartProject(vpsCode, projectPath, input = {}) {
  if (projectNeedsDeploy(projectPath)) {
    if (!String(input.gitUrl || "").trim()) {
      const error = new Error("Projeto ainda nao foi deployado. O sistema inicia o deploy automaticamente quando o GitHub esta vinculado.");
      error.code = "needs_deploy";
      throw error;
    }
    return deployProject(vpsCode, projectPath, input);
  }
  const recipe = detectFrameworkRecipe(projectPath, input.framework);
  persistFrameworkRecipe(projectPath, recipe);
  await buildProjectIfNeeded(projectPath, recipe);
  const port = await publishProjectHttp(vpsCode, projectPath, input.domains);
  await pm2StartOrRestart(vpsCode, projectPath, recipe);
  return { ok: true, status: "online", autoDeployed: false, port, framework: recipe };
}

function buildPm2App(vpsCode, projectPath, recipe, envObj) {
  const start = String(recipe?.startCommand || "npm start").replace(/\$PORT/g, String(envObj.PORT || "3000"));
  if (!isSafeProjectCommand(start)) {
    throw new Error("Comando de start do projeto nao permitido.");
  }
  if (start === "npm start") {
    return { name: vpsCode, cwd: projectPath, script: "npm", args: "start", env: envObj, autorestart: true };
  }
  return {
    name: vpsCode,
    cwd: projectPath,
    script: "bash",
    args: `-lc ${JSON.stringify(start)}`,
    env: envObj,
    autorestart: true,
  };
}

/** Start or restart a project in PM2 with env injection */
async function pm2StartOrRestart(vpsCode, projectPath, incomingRecipe) {
  const recipe = incomingRecipe || detectFrameworkRecipe(projectPath, null);
  if (!recipe?.startCommand) {
    throw new Error("Nenhum arquivo de entrada detectado (Next.js, Node, Python). Confira se o repositorio foi clonado.");
  }

  const envObj = loadProjectEnv(projectPath);
  const ecoPath = path.join(projectPath, ".flowdesk-pm2.json");
  fs.writeFileSync(ecoPath, JSON.stringify({ apps: [buildPm2App(vpsCode, projectPath, recipe, envObj)] }), "utf8");

  try {
    await runCommand(`pm2 delete "${vpsCode}"`).catch(() => {});
    await runCommand(`pm2 start "${ecoPath}" --update-env`, projectPath, envObj);
  } catch (error) {
    throw new Error(error.message || "Falha ao iniciar o processo no PM2.");
  }
  await runCommand("pm2 save", null, {});
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// Health check (unauthenticated)
app.get('/status', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// ── Files ───────────────────────────────────────────────────────────────────

function isMinecraftWorkspaceRequest(req) {
  return req.query?.kind === 'minecraft' || req.body?.kind === 'minecraft';
}

function resolveVpsWorkspacePath(req) {
  const { vpsCode } = req.params;
  if (isMinecraftWorkspaceRequest(req)) {
    return {
      projectPath: resolveMinecraftServerPath(vpsCode),
      minecraft: true,
    };
  }
  return {
    projectPath: path.resolve(PROJECTS_DIR, vpsCode),
    minecraft: false,
  };
}

function ensureMinecraftWorkspaceSkeleton(serverPath, vpsCode) {
  if (!serverPath) return;
  fs.mkdirSync(serverPath, { recursive: true });
  for (const folder of ['worlds', 'mods', 'plugins', 'config', 'logs', 'backups', 'versions', 'runtime']) {
    fs.mkdirSync(path.join(serverPath, folder), { recursive: true });
  }
  const serverJsonPath = path.join(serverPath, 'server.json');
  if (!fs.existsSync(serverJsonPath)) {
    writeJsonFile(serverJsonPath, {
      projectCode: vpsCode,
      status: 'created',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }
}

// GET tree or file content
app.get('/v1/vps/:vpsCode/files', async (req, res) => {
  const filePath    = req.query.path;
  const { projectPath, minecraft } = resolveVpsWorkspacePath(req);

  if (!projectPath) {
    return res.status(400).json({ ok: false, message: 'Workspace invalido.' });
  }

  if (!fs.existsSync(projectPath)) {
    if (minecraft) {
      ensureMinecraftWorkspaceSkeleton(projectPath, req.params.vpsCode);
    } else {
    return res.json({ ok: true, tree: [] });
    }
  }

  if (filePath) {
    if (minecraft && isHiddenMinecraftFilePath(filePath)) {
      return res.status(403).json({ ok: false, message: 'Arquivo interno protegido pelo painel.' });
    }
    // Prevent path traversal
    const safe = path.resolve(projectPath, filePath);
    if (!safe.startsWith(projectPath)) return res.status(403).json({ message: 'Forbidden path' });
    if (!fs.existsSync(safe) || !fs.statSync(safe).isFile()) {
      return res.status(404).json({ message: 'File not found' });
    }
    const content = fs.readFileSync(safe, 'utf8');
    return res.json({
      file: { path: filePath, name: path.basename(filePath), content, language: langFromName(filePath) }
    });
  }

  res.json({ ok: true, tree: walkTree(projectPath, '', { minecraft }) });
});

// POST save file content
async function handleVpsFilesPost(req, res) {
  const { path: filePath, content, action, targetPath: destPath, type } = req.body;
  const { projectPath, minecraft } = resolveVpsWorkspacePath(req);

  try {
    if (!projectPath) return res.status(400).json({ ok: false, message: 'Workspace invalido.' });
    if (minecraft) ensureMinecraftWorkspaceSkeleton(projectPath, req.params.vpsCode);
    if (!fs.existsSync(projectPath)) fs.mkdirSync(projectPath, { recursive: true });
    if (minecraft && isHiddenMinecraftFilePath(filePath)) {
      return res.status(403).json({ ok: false, message: 'Arquivo interno protegido pelo painel.' });
    }
    if (minecraft && destPath && isHiddenMinecraftFilePath(destPath)) {
      return res.status(403).json({ ok: false, message: 'Arquivo interno protegido pelo painel.' });
    }

    if (action === 'delete') {
      const safe = path.resolve(projectPath, filePath);
      if (!safe.startsWith(projectPath)) return res.status(403).json({ message: 'Forbidden' });
      fs.rmSync(safe, { recursive: true, force: true });
    } else if (action === 'rename' || action === 'move') {
      const src  = path.resolve(projectPath, filePath);
      const dest = path.resolve(projectPath, destPath);
      if (!src.startsWith(projectPath) || !dest.startsWith(projectPath)) return res.status(403).json({ message: 'Forbidden' });
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(src, dest);
    } else if (action === 'create-folder' || type === 'directory') {
      const safe = path.resolve(projectPath, filePath);
      if (!safe.startsWith(projectPath)) return res.status(403).json({ message: 'Forbidden' });
      fs.mkdirSync(safe, { recursive: true });
    } else {
      // Save file content
      const safe = path.resolve(projectPath, filePath);
      if (!safe.startsWith(projectPath)) return res.status(403).json({ message: 'Forbidden' });
      fs.mkdirSync(path.dirname(safe), { recursive: true });
      fs.writeFileSync(safe, content || '', 'utf8');
    }

    res.json({ ok: true, tree: walkTree(projectPath, '', { minecraft }) });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
}

app.post('/v1/vps/:vpsCode/files', handleVpsFilesPost);

// ── Env ──────────────────────────────────────────────────────────────────────

app.post('/v1/vps/:vpsCode/files/actions', handleVpsFilesPost);

// GET env file content
app.get('/v1/vps/:vpsCode/env', (req, res) => {
  const { vpsCode }   = req.params;
  const projectPath   = path.join(PROJECTS_DIR, vpsCode);
  const envPath       = path.join(projectPath, '.env');
  const content       = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  res.json({ ok: true, env: content });
});

// POST / PUT env — supports both formats sent by the Next.js routes
app.post('/v1/vps/:vpsCode/env', (req, res) => handleEnvWrite(req, res));
app.put('/v1/vps/:vpsCode/env',  (req, res) => handleEnvWrite(req, res));

function handleEnvWrite(req, res) {
  const { vpsCode }   = req.params;
  const projectPath   = path.join(PROJECTS_DIR, vpsCode);

  try {
    if (!fs.existsSync(projectPath)) fs.mkdirSync(projectPath, { recursive: true });

    const body = req.body;

    // Mode 1: raw dotenv string  { env: "KEY=VALUE\n..." }
    if (typeof body.env === 'string') {
      fs.writeFileSync(path.join(projectPath, '.env'), body.env, 'utf8');
      return res.json({ ok: true });
    }

    // Mode 2: structured variables array  { variables: [{key, value}] }
    if (Array.isArray(body.variables)) {
      const existing = loadProjectEnv(projectPath);
      for (const item of body.variables) {
        if (item.key && typeof item.value === 'string') {
          if (!['PATH','HOME','USER','SHELL','LOGNAME'].includes(item.key)) {
            existing[item.key] = item.value;
          }
        }
      }
      writeProjectEnv(projectPath, existing);
      return res.json({ ok: true });
    }

    // Mode 3: dotenv per-environment map  { envFiles: { production: "KEY=.." } }
    if (body.envFiles && typeof body.envFiles === 'object') {
      // Merge all environments into a single .env (production takes priority)
      const merged = {};
      for (const env of ['development', 'preview', 'production']) {
        const block = body.envFiles[env] || '';
        for (const line of block.split('\n')) {
          const match = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
          if (!match) continue;
          const key = match[1];
          let val = (match[2] || '').trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          if (!['PATH','HOME','USER','SHELL','LOGNAME'].includes(key)) merged[key] = val;
        }
      }
      writeProjectEnv(projectPath, merged);
      return res.json({ ok: true });
    }

    res.status(400).json({ ok: false, message: 'Formato de env inválido.' });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
}

// ── Actions ───────────────────────────────────────────────────────────────────

function normalizeMinecraftSlug(value, fallback = 'minecraft') {
  const raw = String(value || fallback)
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 48);
  return /^[a-z0-9](?:[a-z0-9-]{1,46}[a-z0-9])?$/.test(raw) ? raw : fallback;
}

function normalizeProjectCode(value) {
  const code = String(value || '').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{2,80}$/.test(code)) return null;
  return code;
}

function resolveMinecraftServerPath(projectCode) {
  const safeCode = normalizeProjectCode(projectCode);
  if (!safeCode) return null;
  const root = path.resolve(MINECRAFT_HOSTING_ROOT);
  const serverPath = path.resolve(root, 'servers', safeCode);
  if (!serverPath.startsWith(root + path.sep)) return null;
  return serverPath;
}

function normalizeMinecraftLimit(value, fallbackValue) {
  if (value === null) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallbackValue;
}

function readJsonFile(filePath, fallbackValue) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return fallbackValue;
  }
}

function writeJsonFile(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

function appendMinecraftControlLog(serverPath, message, level = 'INFO') {
  try {
    const logsDir = path.join(serverPath, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    const line = `[${new Date().toISOString()}] [${level}] ${message}\n`;
    fs.appendFileSync(path.join(logsDir, 'control-plane.log'), line, 'utf8');
  } catch (_) {
    // best effort
  }
}

function appendMinecraftServerLog(serverPath, message) {
  try {
    const logsDir = path.join(serverPath, 'logs');
    fs.mkdirSync(logsDir, { recursive: true });
    fs.appendFileSync(path.join(logsDir, 'latest.log'), `${message}\n`, 'utf8');
  } catch (_) {
    // best effort
  }
}

function rotateMinecraftLatestLog(serverPath) {
  try {
    const logsDir = path.join(serverPath, 'logs');
    const latestPath = path.join(logsDir, 'latest.log');
    if (!fs.existsSync(latestPath) || fs.statSync(latestPath).size <= 0) return;

    fs.mkdirSync(logsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.renameSync(latestPath, path.join(logsDir, `latest-${stamp}.log`));

    const archives = fs.readdirSync(logsDir)
      .filter((name) => /^latest-\d{4}-\d{2}-\d{2}T/.test(name))
      .sort();
    for (const oldArchive of archives.slice(0, Math.max(0, archives.length - 5))) {
      fs.rmSync(path.join(logsDir, oldArchive), { force: true });
    }
  } catch (_) {
    // best effort
  }
}

function buildMinecraftRconPassword(vpsCode) {
  return crypto
    .createHash('sha256')
    .update(`${vpsCode}:${AUTH_TOKEN}:minecraft-rcon`)
    .digest('hex')
    .slice(0, 24);
}

function readPropertiesFile(filePath) {
  const properties = new Map();
  if (!fs.existsSync(filePath)) return properties;
  for (const rawLine of fs.readFileSync(filePath, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || !line.includes('=')) continue;
    const index = line.indexOf('=');
    properties.set(line.slice(0, index), line.slice(index + 1));
  }
  return properties;
}

function writePropertiesFile(filePath, properties) {
  const lines = ['# Managed by Flowdesk Minecraft control-plane'];
  for (const [key, value] of properties.entries()) {
    lines.push(`${key}=${value}`);
  }
  lines.push('');
  fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
}

function ensureMinecraftRuntimeProperties(vpsCode, serverPath, serverConfig) {
  const propertiesPath = path.join(serverPath, 'server.properties');
  const properties = readPropertiesFile(propertiesPath);
  const worldSlug = serverConfig?.server?.firstWorldSlug || 'world';
  const maxPlayers = normalizeMinecraftLimit(serverConfig?.limits?.maxPlayers, 20) || 20;
  const serverPort = normalizeMinecraftLimit(serverConfig?.server?.serverPort, 25565) || 25565;
  const rconPort = normalizeMinecraftLimit(serverConfig?.server?.rconPort, serverPort + 1000) || serverPort + 1000;

  properties.set('motd', serverConfig?.server?.serverName || 'Minecraft Server');
  properties.set('server-ip', '');
  properties.set('server-port', String(serverPort));
  properties.set('max-players', String(maxPlayers));
  properties.set('online-mode', properties.get('online-mode') || 'true');
  properties.set('enable-rcon', 'true');
  properties.set('rcon.port', String(rconPort));
  properties.set('rcon.password', properties.get('rcon.password') || buildMinecraftRconPassword(vpsCode));
  properties.set('level-name', `worlds/${worldSlug}`);
  properties.set('view-distance', properties.get('view-distance') || '8');
  properties.set('simulation-distance', properties.get('simulation-distance') || '6');

  writePropertiesFile(propertiesPath, properties);
}

function readMinecraftServerPort(serverPath, fallback = 25565) {
  const config = readJsonFile(path.join(serverPath, 'server.json'), {});
  const fromConfig = normalizeMinecraftLimit(config?.server?.serverPort, null);
  if (fromConfig) return fromConfig;
  const properties = readPropertiesFile(path.join(serverPath, 'server.properties'));
  return normalizeMinecraftLimit(properties.get('server-port'), fallback) || fallback;
}

function findMinecraftPidByPort(port) {
  try {
    const output = execSync(`ss -ltnp 'sport = :${Number(port)}' 2>/dev/null || true`, { encoding: 'utf8' });
    const match = output.match(/pid=(\d+)/);
    return match ? Number(match[1]) : null;
  } catch (_) {
    return null;
  }
}

function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function allocateMinecraftPorts(vpsCode, serverPath, requestedServerPort = null, requestedRconPort = null) {
  const existingServerPort = readMinecraftServerPort(serverPath, null);
  const serverRoot = path.join(MINECRAFT_HOSTING_ROOT, 'servers');
  const usedServerPorts = new Set();
  const usedRconPorts = new Set();
  try {
    for (const entry of fs.readdirSync(serverRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('codex-smoke-')) continue;
      const otherPath = path.join(serverRoot, entry.name);
      if (path.resolve(otherPath) === path.resolve(serverPath)) continue;
      const otherConfig = readJsonFile(path.join(otherPath, 'server.json'), {});
      const otherServerPort = normalizeMinecraftLimit(otherConfig?.server?.serverPort, null) ||
        normalizeMinecraftLimit(readPropertiesFile(path.join(otherPath, 'server.properties')).get('server-port'), null);
      const otherRconPort = normalizeMinecraftLimit(otherConfig?.server?.rconPort, null) ||
        normalizeMinecraftLimit(readPropertiesFile(path.join(otherPath, 'server.properties')).get('rcon.port'), null);
      if (otherServerPort) usedServerPorts.add(otherServerPort);
      if (otherRconPort) usedRconPorts.add(otherRconPort);
    }
  } catch (_) {}

  const pickPort = (requested, existing, start, end, used) => {
    if (requested && requested >= start && requested <= end && !used.has(requested)) return requested;
    if (existing && existing >= start && existing <= end && !used.has(existing)) return existing;
    for (let port = start; port <= end; port += 1) {
      if (!used.has(port)) return port;
    }
    throw new Error(`Sem portas livres para Minecraft entre ${start}-${end}.`);
  };

  const serverPort = pickPort(
    normalizeMinecraftLimit(requestedServerPort, null),
    existingServerPort,
    25565,
    29999,
    usedServerPorts,
  );
  const rconPort = pickPort(
    normalizeMinecraftLimit(requestedRconPort, null),
    normalizeMinecraftLimit(readPropertiesFile(path.join(serverPath, 'server.properties')).get('rcon.port'), null),
    30000,
    34999,
    usedRconPorts,
  );
  return { serverPort, rconPort };
}

function setMinecraftServerStatus(serverPath, status, extra = {}) {
  const current = readJsonFile(path.join(serverPath, 'server.json'), {});
  const next = {
    ...current,
    ...extra,
    status,
    updatedAt: new Date().toISOString(),
  };
  writeJsonFile(path.join(serverPath, 'server.json'), next);
  return next;
}

async function requestJson(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'Flowdesk-Minecraft-ControlPlane/1.0' },
  });
  if (!response.ok) throw new Error(`Falha HTTP ${response.status} em ${url}`);
  return response.json();
}

async function downloadBinary(url, targetPath, minBytes = 64 * 1024) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'Flowdesk-Minecraft-ControlPlane/1.0' },
  });
  if (!response.ok) throw new Error(`Falha ao baixar runtime (${response.status}).`);
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length < minBytes) throw new Error('Runtime baixado parece incompleto.');
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, buffer);
  return targetPath;
}

function parseMinecraftVersion(version) {
  const match = String(version || '').match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!match) return [1, 21, 1];
  return [
    Number(match[1] || 0),
    Number(match[2] || 0),
    Number(match[3] || 0),
  ];
}

function compareMinecraftVersion(version, target) {
  const left = parseMinecraftVersion(version);
  const right = parseMinecraftVersion(target);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

function requiredJavaMajorForMinecraft(version) {
  if (compareMinecraftVersion(version, '1.17') < 0) return 8;
  if (compareMinecraftVersion(version, '1.20.5') < 0) return 17;
  return 21;
}

function managedJavaInstallName(major, channel = 'latest') {
  if (channel === 'legacy-8u312') return 'java-8u312';
  return `java-${major}`;
}

function existingJavaBinaryForMajor(major, channel = 'latest') {
  const managedName = managedJavaInstallName(major, channel);
  const candidates = [
    channel === 'legacy-8u312' ? process.env.FLOWDESK_JAVA_8_LEGACY_BIN : null,
    process.env[`FLOWDESK_JAVA_${major}_BIN`],
    process.env[`JAVA_${major}_BIN`],
    path.join(MINECRAFT_HOSTING_ROOT, 'java', managedName, 'bin', 'java'),
    channel === 'latest' ? path.join('/usr/lib/jvm', `java-${major}-openjdk-amd64`, 'bin', 'java') : null,
    channel === 'latest' ? path.join('/usr/lib/jvm', `java-1.${major}.0-openjdk-amd64`, 'bin', 'java') : null,
  ].filter(Boolean);
  return candidates.find((candidate) => {
    try {
      return fs.existsSync(candidate) && fs.statSync(candidate).isFile();
    } catch (_) {
      return false;
    }
  }) || null;
}

function javaDownloadUrls(major, channel = 'latest') {
  if (channel === 'legacy-8u312') {
    return [
      'https://api.adoptium.net/v3/binary/version/jdk8u312-b07/linux/x64/jre/hotspot/normal/eclipse?project=jdk',
      'https://api.adoptium.net/v3/binary/version/jdk8u312-b07/linux/x64/jdk/hotspot/normal/eclipse?project=jdk',
    ];
  }
  return [
    `https://api.adoptium.net/v3/binary/latest/${major}/ga/linux/x64/jre/hotspot/normal/eclipse?project=jdk`,
    `https://api.adoptium.net/v3/binary/latest/${major}/ga/linux/x64/jdk/hotspot/normal/eclipse?project=jdk`,
  ];
}

async function downloadManagedJava(major, serverPath, channel = 'latest') {
  const managedName = managedJavaInstallName(major, channel);
  const javaRoot = path.join(MINECRAFT_HOSTING_ROOT, 'java', managedName);
  const archivePath = path.join(MINECRAFT_HOSTING_ROOT, 'java', `${managedName}.tar.gz`);
  const urls = javaDownloadUrls(major, channel);
  let lastError = null;
  fs.mkdirSync(path.dirname(archivePath), { recursive: true });
  appendMinecraftControlLog(serverPath, `Java ${major} ausente. Baixando runtime compativel (${managedName})...`);
  for (const url of urls) {
    try {
      await downloadBinary(url, archivePath, 10 * 1024 * 1024);
      fs.rmSync(javaRoot, { recursive: true, force: true });
      fs.mkdirSync(javaRoot, { recursive: true });
      await runCommandStrict(`tar -xzf "${archivePath}" -C "${javaRoot}" --strip-components=1`);
      const javaBin = path.join(javaRoot, 'bin', 'java');
      if (!fs.existsSync(javaBin)) throw new Error(`Java ${major} baixou, mas bin/java nao foi encontrado.`);
      fs.chmodSync(javaBin, 0o755);
      appendMinecraftControlLog(serverPath, `Java ${major} preparado em ${javaBin}.`);
      return javaBin;
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`Nao foi possivel preparar Java ${major}: ${lastError?.message || 'download falhou'}.`);
}

async function resolveMinecraftJavaBin(serverConfig, serverPath) {
  const version = String(serverConfig?.server?.version || '1.21.1');
  const major = requiredJavaMajorForMinecraft(version);
  const channel = major === 8 ? 'legacy-8u312' : 'latest';
  const existing = existingJavaBinaryForMajor(major, channel);
  if (existing) return existing;
  if (process.env.JAVA_BIN && major >= 21 && channel === 'latest') return process.env.JAVA_BIN;
  return downloadManagedJava(major, serverPath, channel);
}

function extractXmlVersions(xml = '') {
  return [...String(xml).matchAll(/<version>([^<]+)<\/version>/g)].map((match) => match[1]).filter(Boolean);
}

function minecraftAddonType(serverType = 'vanilla') {
  const type = String(serverType || '').toLowerCase();
  if (['paper', 'purpur', 'spigot', 'bukkit', 'folia'].includes(type)) return 'plugins';
  if (['fabric', 'quilt', 'forge', 'neoforge'].includes(type)) return 'mods';
  return 'vanilla';
}

function minecraftModrinthFacets(serverType, version) {
  const addonType = minecraftAddonType(serverType);
  if (addonType === 'vanilla') return '';
  const loader = String(serverType || '').toLowerCase();
  const facets = [
    [`project_type:${addonType === 'plugins' ? 'plugin' : 'mod'}`],
    [`categories:${loader}`],
  ];
  if (version) facets.push([`versions:${version}`]);
  return JSON.stringify(facets);
}

function safePackageName(value) {
  const name = path.basename(String(value || '').replace(/\\/g, '/')).trim();
  if (!name || name.startsWith('.') || !/\.(jar|zip|disabled)$/i.test(name)) return null;
  return name.replace(/[^a-zA-Z0-9._+ -]/g, '_').slice(0, 160);
}

function safeRuntimeName(value) {
  return String(value || 'runtime').replace(/[^a-zA-Z0-9._-]+/g, '-').slice(0, 80);
}

async function resolveForgeVersion(version) {
  const response = await fetch('https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml');
  if (!response.ok) throw new Error(`Forge metadata falhou (${response.status}).`);
  const versions = extractXmlVersions(await response.text())
    .filter((item) => item === version || item.startsWith(`${version}-`))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
  const preferred = versions.find((item) => /recommended/i.test(item)) || versions[versions.length - 1];
  if (!preferred) throw new Error(`Forge nao publicou instalador para Minecraft ${version}.`);
  return preferred;
}

async function installForgeRuntime(serverPath, version, resolvedFullVersion = null) {
  const fullVersion = resolvedFullVersion || await resolveForgeVersion(version);
  const installerName = `forge-${safeRuntimeName(fullVersion)}-installer.jar`;
  const installerPath = path.join(serverPath, 'runtime', installerName);
  const url = `https://maven.minecraftforge.net/net/minecraftforge/forge/${encodeURIComponent(fullVersion)}/forge-${encodeURIComponent(fullVersion)}-installer.jar`;
  await downloadBinary(url, installerPath, 1024 * 1024);
  appendMinecraftServerLog(serverPath, `[FLOWDESK] Instalando Forge ${fullVersion}...`);
  const javaBin = await resolveMinecraftJavaBin({ server: { version } }, serverPath);
  const output = await runCommandStrict(`"${javaBin}" -Djava.awt.headless=true -jar "${installerPath}" --installServer`, serverPath);
  output.split(/\r?\n/).filter(Boolean).slice(-80).forEach((line) => appendMinecraftServerLog(serverPath, `[FORGE] ${line}`));

  const unixArgs = path.join(serverPath, 'libraries', 'net', 'minecraftforge', 'forge', fullVersion, 'unix_args.txt');
  const winArgs = path.join(serverPath, 'libraries', 'net', 'minecraftforge', 'forge', fullVersion, 'win_args.txt');
  const forgeJar = path.join(serverPath, `forge-${fullVersion}.jar`);
  if (fs.existsSync(unixArgs)) return { kind: 'argsFile', path: unixArgs, fullVersion };
  if (fs.existsSync(winArgs)) return { kind: 'argsFile', path: winArgs, fullVersion };
  if (fs.existsSync(forgeJar)) return { kind: 'jar', path: forgeJar, fullVersion };
  throw new Error(`Forge ${fullVersion} instalou, mas o launcher nao foi encontrado.`);
}

function findForgeRuntimeLaunch(serverPath, preferredFullVersion = null) {
  const forgeRoot = path.join(serverPath, 'libraries', 'net', 'minecraftforge', 'forge');
  try {
    const versions = fs.readdirSync(forgeRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }));
    const orderedVersions = preferredFullVersion
      ? [preferredFullVersion, ...versions.filter((version) => version !== preferredFullVersion)]
      : versions;
    for (const version of orderedVersions) {
      const unixArgs = path.join(forgeRoot, version, 'unix_args.txt');
      const winArgs = path.join(forgeRoot, version, 'win_args.txt');
      if (fs.existsSync(unixArgs)) return { kind: 'argsFile', path: unixArgs, fullVersion: version };
      if (fs.existsSync(winArgs)) return { kind: 'argsFile', path: winArgs, fullVersion: version };
      if (preferredFullVersion) break;
    }
  } catch (_) {}
  try {
    const jar = preferredFullVersion
      ? path.join(serverPath, `forge-${preferredFullVersion}.jar`)
      : fs.readdirSync(serverPath)
        .filter((name) => /^forge-.+\.jar$/i.test(name) && !/-installer\.jar$/i.test(name))
        .map((name) => path.join(serverPath, name))
        .find((candidate) => fs.statSync(candidate).size > 64 * 1024);
    if (jar && fs.existsSync(jar) && fs.statSync(jar).size > 64 * 1024) return { kind: 'jar', path: jar };
  } catch (_) {}
  return null;
}

async function installMinecraftRuntime(serverPath, serverConfig) {
  const server = serverConfig.server || {};
  const version = String(server.version || '1.21.1');
  const serverType = String(server.serverType || 'paper').toLowerCase();
  const target = path.join(serverPath, 'runtime', 'server.jar');
  appendMinecraftControlLog(serverPath, `Runtime ausente. Baixando ${serverType} ${version}...`);

  if (serverType === 'vanilla') {
    const manifest = await requestJson('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
    const item = (manifest.versions || []).find((entry) => entry.id === version);
    if (!item?.url) throw new Error(`Versao Vanilla ${version} nao encontrada pela Mojang.`);
    const details = await requestJson(item.url);
    const url = details.downloads?.server?.url;
    if (!url) throw new Error(`A Mojang nao publicou server.jar para ${version}.`);
    return downloadBinary(url, target, 1024 * 1024);
  }

  if (serverType === 'paper') {
    const builds = await requestJson(`https://fill.papermc.io/v3/projects/paper/versions/${encodeURIComponent(version)}/builds`);
    const candidates = Array.isArray(builds) ? builds : [];
    const latest = candidates.find((item) => item.channel === 'STABLE') || candidates[0];
    const url = latest?.downloads?.['server:default']?.url;
    if (!url) throw new Error(`Paper ainda nao tem build para ${version}.`);
    return downloadBinary(url, target, 1024 * 1024);
  }

  if (serverType === 'purpur') {
    const buildInfo = await requestJson(`https://api.purpurmc.org/v2/purpur/${encodeURIComponent(version)}`);
    const build = buildInfo.builds?.latest || buildInfo.builds?.all?.slice(-1)?.[0];
    if (!build) throw new Error(`Purpur ainda nao tem build para ${version}.`);
    const url = `https://api.purpurmc.org/v2/purpur/${encodeURIComponent(version)}/${encodeURIComponent(build)}/download`;
    return downloadBinary(url, target, 1024 * 1024);
  }

  if (serverType === 'fabric') {
    const loaders = await requestJson(`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(version)}`);
    const loader = (loaders || []).find((item) => item.loader?.stable) || loaders?.[0];
    const installers = await requestJson('https://meta.fabricmc.net/v2/versions/installer');
    const installer = (installers || []).find((item) => item.stable) || installers?.[0];
    if (!loader?.loader?.version || !installer?.version) throw new Error(`Fabric ainda nao tem loader para ${version}.`);
    const url = `https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(version)}/${encodeURIComponent(loader.loader.version)}/${encodeURIComponent(installer.version)}/server/jar`;
    return downloadBinary(url, target, 64 * 1024);
  }

  if (serverType === 'forge') {
    return installForgeRuntime(serverPath, version);
  }

  throw new Error(`${serverType} precisa de instalador dedicado antes do start. Envie o runtime pela aba Arquivos ou use Paper/Purpur/Vanilla/Fabric/Forge.`);
}

async function resolveMinecraftRuntimeJar(serverPath, serverConfig) {
  const serverType = String(serverConfig.server?.serverType || '').toLowerCase();
  if (serverType === 'forge') {
    const version = String(serverConfig.server?.version || '1.21.1');
    const preferredFullVersion = await resolveForgeVersion(version);
    const forgeLaunch = findForgeRuntimeLaunch(serverPath, preferredFullVersion);
    if (forgeLaunch) return forgeLaunch;
    return installForgeRuntime(serverPath, version, preferredFullVersion);
  }

  const candidates = [
    path.join(serverPath, 'server.jar'),
    path.join(serverPath, 'runtime', 'server.jar'),
    path.join(serverPath, 'runtime', 'paper.jar'),
    path.join(serverPath, 'runtime', 'purpur.jar'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).size > 64 * 1024) return candidate;
  }
  const runtimeDir = path.join(serverPath, 'runtime');
  try {
    const found = fs.readdirSync(runtimeDir)
      .filter((name) => name.toLowerCase().endsWith('.jar'))
      .filter((name) => !/-installer\.jar$/i.test(name))
      .map((name) => path.join(runtimeDir, name))
      .find((candidate) => fs.statSync(candidate).size > 64 * 1024);
    if (found) return found;
  } catch (_) {}
  return installMinecraftRuntime(serverPath, serverConfig);
}

function buildMinecraftJavaArgs(serverPath, serverConfig, runtimeTarget) {
  const limits = readJsonFile(path.join(serverPath, 'limits.json'), {});
  const ramMb = Math.max(512, Math.floor(Number(limits.ramMb || 1024)));
  const base = [`-Xms${Math.min(512, ramMb)}M`, `-Xmx${ramMb}M`];
  if (runtimeTarget && typeof runtimeTarget === 'object' && runtimeTarget.kind === 'argsFile') {
    return [...base, `@${runtimeTarget.path}`, 'nogui'];
  }
  const jarPath = typeof runtimeTarget === 'string' ? runtimeTarget : runtimeTarget?.path;
  return [...base, '-jar', jarPath, 'nogui'];
}

async function startMinecraftServerProcess(vpsCode, serverPath) {
  const existing = minecraftProcesses.get(vpsCode);
  if (existing && !existing.killed) {
    return { ok: true, status: 'online', message: 'Servidor Minecraft ja esta rodando.' };
  }
  const existingPid = findMinecraftPidByPort(readMinecraftServerPort(serverPath));
  if (existingPid && isProcessAlive(existingPid)) {
    setMinecraftServerStatus(serverPath, 'online', { pid: existingPid, recoveredAt: new Date().toISOString() });
    return { ok: true, status: 'online', pid: existingPid, message: 'Servidor Minecraft ja esta rodando.' };
  }
  if (minecraftStartJobs.has(vpsCode)) {
    return { ok: true, status: 'starting', message: 'Servidor Minecraft ja esta preparando runtime/start.' };
  }

  const job = (async () => {
    try {
      await startMinecraftServerProcessNow(vpsCode, serverPath);
    } catch (err) {
      setMinecraftServerStatus(serverPath, 'crashed', { lastError: err.message });
      appendMinecraftServerLog(serverPath, `[FLOWDESK] Start falhou: ${err.message}`);
    } finally {
      minecraftStartJobs.delete(vpsCode);
    }
  })();
  minecraftStartJobs.set(vpsCode, job);
  return { ok: true, status: 'starting', message: 'Servidor Minecraft iniciando. Acompanhe o console.' };
}

async function startMinecraftServerProcessNow(vpsCode, serverPath) {
  const serverConfig = readJsonFile(path.join(serverPath, 'server.json'), { projectCode: vpsCode });
  fs.writeFileSync(path.join(serverPath, 'eula.txt'), 'eula=true\n', 'utf8');
  ensureMinecraftRuntimeProperties(vpsCode, serverPath, serverConfig);
  rotateMinecraftLatestLog(serverPath);
  setMinecraftServerStatus(serverPath, 'starting', { lastStartedAt: new Date().toISOString() });
  appendMinecraftServerLog(serverPath, `[FLOWDESK] Iniciando servidor Minecraft ${vpsCode}...`);

  const jarPath = await resolveMinecraftRuntimeJar(serverPath, serverConfig);
  const javaBin = await resolveMinecraftJavaBin(serverConfig, serverPath);
  const args = buildMinecraftJavaArgs(serverPath, serverConfig, jarPath);
  appendMinecraftControlLog(serverPath, `Java start: ${javaBin} ${args.join(' ')}`);
  const child = spawn(javaBin, args, { cwd: serverPath, stdio: ['pipe', 'pipe', 'pipe'] });
  minecraftProcesses.set(vpsCode, child);
  setMinecraftServerStatus(serverPath, 'starting', { pid: child.pid });

  const handleLine = (line, prefix = '') => {
    const trimmed = String(line || '').trimEnd();
    if (!trimmed.trim()) return;
    appendMinecraftServerLog(serverPath, prefix ? `${prefix}${trimmed}` : trimmed);
    if (trimmed.includes('Done (') && trimmed.includes('help')) {
      setMinecraftServerStatus(serverPath, 'online', { lastReadyAt: new Date().toISOString() });
    }
  };

  child.stdout.on('data', (chunk) => {
    String(chunk).split(/\r?\n/).forEach((line) => handleLine(line));
  });
  child.stderr.on('data', (chunk) => {
    String(chunk).split(/\r?\n/).forEach((line) => handleLine(line, '[STDERR] '));
  });
  child.on('error', (err) => {
    minecraftProcesses.delete(vpsCode);
    setMinecraftServerStatus(serverPath, 'crashed', { lastError: err.message });
    appendMinecraftServerLog(serverPath, `[FLOWDESK] Falha ao iniciar: ${err.message}`);
  });
  child.on('close', (code) => {
    minecraftProcesses.delete(vpsCode);
    const expectedStop = readJsonFile(path.join(serverPath, 'server.json'), {}).status === 'stopping';
    setMinecraftServerStatus(serverPath, expectedStop || code === 0 ? 'offline' : 'crashed', { lastExitCode: code });
    appendMinecraftServerLog(serverPath, `[FLOWDESK] Servidor encerrado com codigo ${code}.`);
  });

  return { ok: true, status: 'starting', pid: child.pid, message: 'Servidor Minecraft iniciando. Acompanhe o console.' };
}

async function stopMinecraftServerProcess(vpsCode, serverPath) {
  const child = minecraftProcesses.get(vpsCode);
  setMinecraftServerStatus(serverPath, 'stopping', { lastStoppedAt: new Date().toISOString() });
  appendMinecraftServerLog(serverPath, '[FLOWDESK] Enviando stop para o servidor Minecraft...');
  if (!child || child.killed) {
    const pid = findMinecraftPidByPort(readMinecraftServerPort(serverPath));
    if (pid && isProcessAlive(pid)) {
      try {
        process.kill(pid, 'SIGTERM');
        setTimeout(() => {
          if (isProcessAlive(pid)) process.kill(pid, 'SIGKILL');
        }, 15000).unref?.();
        return { ok: true, status: 'stopping', message: 'Stop enviado para processo Minecraft recuperado.' };
      } catch (_) {}
    }
    setMinecraftServerStatus(serverPath, 'offline');
    return { ok: true, status: 'offline', message: 'Servidor Minecraft ja estava offline.' };
  }
  try {
    child.stdin.write('stop\n');
  } catch (_) {
    child.kill('SIGTERM');
  }
  setTimeout(() => {
    if (minecraftProcesses.get(vpsCode) === child && !child.killed) {
      child.kill('SIGKILL');
    }
  }, 15000).unref?.();
  return { ok: true, status: 'stopping', message: 'Stop enviado para o Minecraft.' };
}

function killMinecraftServerProcess(vpsCode, serverPath) {
  const child = minecraftProcesses.get(vpsCode);
  if (child && !child.killed) {
    child.kill('SIGKILL');
    minecraftProcesses.delete(vpsCode);
  }
  setMinecraftServerStatus(serverPath, 'offline', { lastKilledAt: new Date().toISOString() });
  appendMinecraftServerLog(serverPath, '[FLOWDESK] Processo Minecraft finalizado a forca.');
  return { ok: true, status: 'offline', message: 'Processo Minecraft finalizado a forca.' };
}

function resetMinecraftWorld(serverPath) {
  const serverConfig = readJsonFile(path.join(serverPath, 'server.json'), {});
  const firstWorldSlug = serverConfig.server?.firstWorldSlug || 'world';
  const firstWorldName = serverConfig.server?.firstWorldName || 'Mundo principal';
  const worldsDir = path.join(serverPath, 'worlds');
  if (fs.existsSync(worldsDir)) fs.rmSync(worldsDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(worldsDir, firstWorldSlug), { recursive: true });
  writeJsonFile(path.join(worldsDir, firstWorldSlug, 'world.json'), {
    id: firstWorldSlug,
    name: firstWorldName,
    resetAt: new Date().toISOString(),
    isolatedPath: path.join(worldsDir, firstWorldSlug),
  });
  appendMinecraftServerLog(serverPath, `[FLOWDESK] Mundo resetado. Mundo ativo: ${firstWorldSlug}.`);
  return { ok: true, status: readJsonFile(path.join(serverPath, 'server.json'), {}).status || 'created', worlds: listMinecraftWorlds(serverPath) };
}

function sendMinecraftCommand(vpsCode, serverPath, command) {
  const child = minecraftProcesses.get(vpsCode);
  const clean = String(command || '').trim().replace(/^\//, '');
  if (!clean) throw new Error('Comando vazio.');
  if (!child || child.killed) throw new Error('Servidor Minecraft nao esta rodando.');
  child.stdin.write(`${clean}\n`);
  appendMinecraftServerLog(serverPath, `[FLOWDESK] > ${clean}`);
  return { ok: true, status: 'online', command: clean };
}

function listMinecraftAddons(serverPath, type) {
  const folder = type === 'mods' ? 'mods' : 'plugins';
  const dir = path.join(serverPath, folder);
  fs.mkdirSync(dir, { recursive: true });
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(jar|zip|disabled)$/i.test(entry.name))
    .map((entry) => {
      const filePath = path.join(dir, entry.name);
      const stat = fs.statSync(filePath);
      return {
        name: entry.name,
        folder,
        type: folder === 'mods' ? 'mod' : 'plugin',
        path: `${folder}/${entry.name}`,
        size: stat.size,
        updatedAt: stat.mtime.toISOString(),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

function minecraftAddonTarget(serverPath) {
  const serverConfig = readJsonFile(path.join(serverPath, 'server.json'), {});
  const serverType = serverConfig.server?.serverType || 'vanilla';
  const type = minecraftAddonType(serverType);
  return {
    serverConfig,
    serverType,
    type,
    folder: type === 'mods' ? 'mods' : type === 'plugins' ? 'plugins' : '',
    version: serverConfig.server?.version || '1.21.1',
  };
}

async function searchMinecraftLibrary(serverPath, query = '', page = 1, limit = 20, index = '') {
  const target = minecraftAddonTarget(serverPath);
  if (target.type === 'vanilla') {
    return { ok: true, type: 'vanilla', hits: [], totalHits: 0, message: 'Vanilla nao carrega plugins nem mods.' };
  }
  const params = new URLSearchParams();
  params.set('query', String(query || ''));
  params.set('limit', String(Math.min(40, Math.max(1, Number(limit) || 20))));
  params.set('offset', String((Math.max(1, Number(page) || 1) - 1) * Number(params.get('limit'))));
  params.set('index', index || (query ? 'relevance' : 'downloads'));
  params.set('facets', minecraftModrinthFacets(target.serverType, target.version));
  const data = await requestJson(`https://api.modrinth.com/v2/search?${params.toString()}`);
  return {
    ok: true,
    type: target.type,
    platform: target.serverType,
    serverVersion: target.version,
    page: Math.max(1, Number(page) || 1),
    limit: Number(params.get('limit')),
    totalHits: data.total_hits || 0,
    hits: (data.hits || []).map((hit) => ({
      project_id: hit.project_id,
      slug: hit.slug,
      title: hit.title,
      author: hit.author,
      description: hit.description,
      icon_url: hit.icon_url,
      downloads: hit.downloads,
      follows: hit.follows,
      date_modified: hit.date_modified,
      categories: hit.categories || [],
      display_categories: hit.display_categories || [],
      versions: hit.versions || [],
      project_type: hit.project_type,
      source: 'modrinth',
    })),
  };
}

function selectMinecraftInstallFile(version = {}) {
  const files = Array.isArray(version.files) ? version.files : [];
  return files.find((file) => file.primary && file.url && safePackageName(file.filename))
    || files.find((file) => file.url && safePackageName(file.filename))
    || null;
}

async function getMinecraftLibraryProject(serverPath, projectId) {
  const target = minecraftAddonTarget(serverPath);
  if (target.type === 'vanilla') throw new Error('Vanilla nao carrega plugins nem mods.');
  const project = await requestJson(`https://api.modrinth.com/v2/project/${encodeURIComponent(projectId)}`);
  const versions = await requestJson(`https://api.modrinth.com/v2/project/${encodeURIComponent(projectId)}/version`);
  const compatible = (versions || []).filter((version) => {
    const loaders = version.loaders || [];
    const games = version.game_versions || [];
    return loaders.includes(target.serverType) && games.includes(target.version) && selectMinecraftInstallFile(version);
  });
  return {
    ok: true,
    type: target.type,
    platform: target.serverType,
    serverVersion: target.version,
    project,
    versions: compatible,
    latestVersion: compatible[0] || null,
  };
}

async function installMinecraftAddon(serverPath, body = {}) {
  const target = minecraftAddonTarget(serverPath);
  if (target.type === 'vanilla') throw new Error('Vanilla nao carrega plugins nem mods.');
  const limits = readJsonFile(path.join(serverPath, 'limits.json'), {});
  const current = listMinecraftAddons(serverPath, target.type);
  const max = target.type === 'mods' ? limits.maxMods : limits.maxPlugins;
  if (max !== null && Number.isFinite(Number(max)) && current.length >= Number(max)) {
    throw new Error(`Limite do plano atingido: ${max} ${target.type === 'mods' ? 'mods' : 'plugins'}.`);
  }
  const url = String(body.url || '').trim();
  const filename = safePackageName(body.filename || '');
  if (!/^https:\/\//i.test(url) || !filename) throw new Error('Arquivo de instalacao invalido.');
  const dest = path.join(serverPath, target.folder, filename);
  await downloadBinary(url, dest, 1);
  appendMinecraftServerLog(serverPath, `[FLOWDESK] ${target.type === 'mods' ? 'Mod' : 'Plugin'} instalado: ${filename}. Reinicie o servidor para carregar.`);
  return {
    ok: true,
    success: true,
    filename,
    folder: target.folder,
    path: `${target.folder}/${filename}`,
    addons: listMinecraftAddons(serverPath, target.type),
  };
}

function deleteMinecraftAddon(serverPath, body = {}) {
  const folder = body.type === 'mods' || body.folder === 'mods' ? 'mods' : 'plugins';
  const filename = safePackageName(body.name || body.filename || '');
  if (!filename) throw new Error('Arquivo invalido.');
  const filePath = path.join(serverPath, folder, filename);
  if (!fs.existsSync(filePath)) throw new Error('Arquivo nao encontrado.');
  const trashDir = path.join(serverPath, 'trash', 'addons');
  fs.mkdirSync(trashDir, { recursive: true });
  fs.renameSync(filePath, path.join(trashDir, `${Date.now()}-${filename}`));
  appendMinecraftServerLog(serverPath, `[FLOWDESK] Addon removido: ${folder}/${filename}.`);
  return { ok: true, success: true, addons: listMinecraftAddons(serverPath, folder) };
}

function listMinecraftWorlds(serverPath) {
  const worldsPath = path.join(serverPath, 'worlds');
  try {
    return fs.readdirSync(worldsPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (_) {
    return [];
  }
}

function normalizeMinecraftProvisionPayload(body) {
  const projectCode = normalizeProjectCode(body.projectCode || body.vpsCode);
  const sourceServer = body.server && typeof body.server === 'object' ? body.server : {};
  const limits = body.limits && typeof body.limits === 'object' ? body.limits : {};
  if (!projectCode) return null;

  const serverName = String(sourceServer.serverName || 'Servidor Minecraft').trim().slice(0, 80) || 'Servidor Minecraft';
  const serverType = ['paper', 'purpur', 'fabric', 'forge', 'neoforge', 'vanilla'].includes(sourceServer.serverType)
    ? sourceServer.serverType
    : 'paper';
  const version = String(sourceServer.version || '1.21.1').trim().slice(0, 24) || '1.21.1';
  const subdomain = normalizeMinecraftSlug(sourceServer.subdomain || serverName);
  const firstWorldName = String(sourceServer.firstWorldName || 'world').trim().slice(0, 80) || 'world';
  const firstWorldSlug = normalizeMinecraftSlug(firstWorldName, 'world');
  const serverPort = normalizeMinecraftLimit(sourceServer.serverPort, null);
  const rconPort = normalizeMinecraftLimit(sourceServer.rconPort, null);

  return {
    projectCode,
    deploymentId: body.deploymentId || null,
    server: {
      serverName,
      serverType,
      version,
      subdomain,
      firstWorldName,
      firstWorldSlug,
      serverPort,
      rconPort,
      domains: {
        primary: `${subdomain}.mine.flwdesk.com`,
        fixed: `${projectCode.toLowerCase()}.mine.flwdesk.com`,
      },
    },
    limits: {
      ramMb: normalizeMinecraftLimit(limits.ramMb, 1024),
      storageGb: normalizeMinecraftLimit(limits.storageGb, 5),
      maxPlayers: normalizeMinecraftLimit(limits.maxPlayers, 10),
      maxWorlds: normalizeMinecraftLimit(limits.maxWorlds, 2),
      maxMods: normalizeMinecraftLimit(limits.maxMods, 15),
      maxPlugins: normalizeMinecraftLimit(limits.maxPlugins, 15),
    },
    plan: body.plan || null,
    region: body.region || null,
  };
}

function writeMinecraftServerProperties(serverPath, config) {
  const serverPort = normalizeMinecraftLimit(config.server.serverPort, 25565) || 25565;
  const rconPort = normalizeMinecraftLimit(config.server.rconPort, serverPort + 1000) || serverPort + 1000;
  const properties = [
    '# Managed by Flowdesk Minecraft control-plane',
    `motd=${config.server.serverName}`,
    'server-ip=',
    `server-port=${serverPort}`,
    `max-players=${config.limits.maxPlayers || 0}`,
    'online-mode=true',
    'enable-rcon=true',
    `rcon.port=${rconPort}`,
    `rcon.password=${buildMinecraftRconPassword(config.projectCode)}`,
    `level-name=worlds/${config.server.firstWorldSlug || 'world'}`,
    'view-distance=8',
    'simulation-distance=6',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(serverPath, 'server.properties'), properties, 'utf8');
}

function ensureMinecraftServerLayout(config) {
  const serverPath = resolveMinecraftServerPath(config.projectCode);
  if (!serverPath) throw new Error('Codigo de servidor Minecraft invalido.');

  const now = new Date().toISOString();
  fs.mkdirSync(serverPath, { recursive: true });
  const firstWorldSlug = config.server.firstWorldSlug || 'world';
  const allocatedPorts = allocateMinecraftPorts(
    config.projectCode,
    serverPath,
    config.server.serverPort,
    config.server.rconPort,
  );
  config.server = {
    ...config.server,
    serverPort: allocatedPorts.serverPort,
    rconPort: allocatedPorts.rconPort,
  };
  for (const folder of [`worlds/${firstWorldSlug}`, 'mods', 'plugins', 'config', 'logs', 'backups', 'versions', 'runtime']) {
    fs.mkdirSync(path.join(serverPath, folder), { recursive: true });
  }

  const existing = readJsonFile(path.join(serverPath, 'server.json'), {});
  const serverConfig = {
    ...existing,
    projectCode: config.projectCode,
    deploymentId: config.deploymentId,
    server: config.server,
    limits: config.limits,
    plan: config.plan,
    region: config.region,
    status: existing.status || 'created',
    createdAt: existing.createdAt || now,
    updatedAt: now,
  };

  writeJsonFile(path.join(serverPath, 'server.json'), serverConfig);
  writeJsonFile(path.join(serverPath, 'limits.json'), config.limits);
  const existingDomains = readJsonFile(path.join(serverPath, 'domains.json'), {});
  writeJsonFile(path.join(serverPath, 'domains.json'), {
    primary: config.server.domains.primary,
    fixed: config.server.domains.fixed,
    cloudflare: existingDomains.cloudflare && typeof existingDomains.cloudflare === 'object'
      ? existingDomains.cloudflare
      : { managed: true, status: 'pending_dns_record' },
    updatedAt: now,
  });
  writeJsonFile(path.join(serverPath, 'worlds', firstWorldSlug, 'world.json'), {
    id: firstWorldSlug,
    name: config.server.firstWorldName || 'Mundo principal',
    createdAt: existing.createdAt || now,
    isolatedPath: path.join(serverPath, 'worlds', firstWorldSlug),
  });
  writeMinecraftServerProperties(serverPath, config);
  appendMinecraftControlLog(
    serverPath,
    `Servidor preparado: ${config.server.serverName} (${config.server.serverType} ${config.server.version}).`,
  );

  return {
    ok: true,
    status: serverConfig.status,
    projectCode: config.projectCode,
    serverPath,
    server: config.server,
    ports: allocatedPorts,
    domains: config.server.domains,
    worlds: listMinecraftWorlds(serverPath),
    limits: config.limits,
  };
}

app.post('/v1/minecraft/servers', async (req, res) => {
  try {
    const config = normalizeMinecraftProvisionPayload(req.body || {});
    if (!config) return res.status(400).json({ ok: false, message: 'Payload Minecraft invalido.' });
    const result = ensureMinecraftServerLayout(config);
    return res.json({ ...result, message: 'Servidor Minecraft criado pelo control-plane.' });
  } catch (err) {
    res.status(500).json({ ok: false, status: 'crashed', message: err.message });
  }
});

app.get('/v1/minecraft/servers/:vpsCode/status', async (req, res) => {
  const serverPath = resolveMinecraftServerPath(req.params.vpsCode);
  if (!serverPath || !fs.existsSync(serverPath)) {
    return res.status(404).json({ ok: false, message: 'Servidor Minecraft nao encontrado.' });
  }
  const liveProcess = minecraftProcesses.get(req.params.vpsCode);
  const startJob = minecraftStartJobs.get(req.params.vpsCode);
  const stored = readJsonFile(path.join(serverPath, 'server.json'), {});
  const recoveredPid = liveProcess && !liveProcess.killed
    ? liveProcess.pid
    : findMinecraftPidByPort(readMinecraftServerPort(serverPath));
  const recoveredOnline = Boolean(recoveredPid && isProcessAlive(recoveredPid));
  if (recoveredOnline && stored.status !== 'online') {
    setMinecraftServerStatus(serverPath, 'online', { pid: recoveredPid, recoveredAt: new Date().toISOString() });
  }
  const staleOnlineStatus = ['online', 'starting', 'restarting'].includes(String(stored.status || '').toLowerCase());
  const effectiveStatus = startJob
    ? 'starting'
    : recoveredOnline
      ? 'online'
      : staleOnlineStatus
        ? 'offline'
        : stored.status || 'created';
  if (!recoveredOnline && staleOnlineStatus) {
    setMinecraftServerStatus(serverPath, 'offline', { pid: null, lastSeenMissingAt: new Date().toISOString() });
  }
  return res.json({
    ok: true,
    status: effectiveStatus,
    pid: recoveredPid || null,
    projectCode: req.params.vpsCode,
    server: stored.server || null,
    domains: readJsonFile(path.join(serverPath, 'domains.json'), {}),
    worlds: listMinecraftWorlds(serverPath),
    limits: readJsonFile(path.join(serverPath, 'limits.json'), {}),
  });
});

app.post('/v1/minecraft/servers/:vpsCode/worlds', async (req, res) => {
  const serverPath = resolveMinecraftServerPath(req.params.vpsCode);
  if (!serverPath || !fs.existsSync(serverPath)) {
    return res.status(404).json({ ok: false, message: 'Servidor Minecraft nao encontrado.' });
  }
  const limits = readJsonFile(path.join(serverPath, 'limits.json'), {});
  const maxWorlds = limits.maxWorlds === null ? null : Number(limits.maxWorlds || 1);
  const worlds = listMinecraftWorlds(serverPath);
  if (maxWorlds !== null && worlds.length >= maxWorlds) {
    return res.status(409).json({ ok: false, message: `Limite do plano atingido: ${maxWorlds} mundo(s).`, worlds, limits });
  }
  const slug = normalizeMinecraftSlug(req.body?.name || `world-${worlds.length + 1}`, `world-${worlds.length + 1}`);
  if (worlds.includes(slug)) return res.status(409).json({ ok: false, message: 'Ja existe um mundo com esse nome.', worlds, limits });
  const worldPath = path.join(serverPath, 'worlds', slug);
  fs.mkdirSync(worldPath, { recursive: true });
  writeJsonFile(path.join(worldPath, 'world.json'), {
    id: slug,
    name: String(req.body?.name || slug).trim().slice(0, 80) || slug,
    createdAt: new Date().toISOString(),
    isolatedPath: worldPath,
  });
  appendMinecraftControlLog(serverPath, `Mundo criado: ${slug}.`);
  return res.json({ ok: true, world: slug, worlds: listMinecraftWorlds(serverPath), limits });
});

app.post('/v1/minecraft/servers/:vpsCode/actions/:action', async (req, res) => {
  const vpsCode = req.params.vpsCode;
  const serverPath = resolveMinecraftServerPath(vpsCode);
  if (!serverPath) {
    return res.status(400).json({ ok: false, message: 'Codigo de servidor Minecraft invalido.' });
  }
  ensureMinecraftWorkspaceSkeleton(serverPath, req.params.vpsCode);
  const action = String(req.params.action || '').toLowerCase();
  try {
    let result;
    if (action === 'start') {
      result = await startMinecraftServerProcess(vpsCode, serverPath);
    } else if (action === 'stop') {
      result = await stopMinecraftServerProcess(vpsCode, serverPath);
    } else if (action === 'kill' || action === 'force-kill') {
      result = killMinecraftServerProcess(vpsCode, serverPath);
    } else if (action === 'reset-world') {
      await stopMinecraftServerProcess(vpsCode, serverPath);
      result = resetMinecraftWorld(serverPath);
    } else if (action === 'command') {
      result = sendMinecraftCommand(vpsCode, serverPath, req.body?.command);
    } else if (action === 'restart') {
      await stopMinecraftServerProcess(vpsCode, serverPath);
      setTimeout(() => {
        startMinecraftServerProcess(vpsCode, serverPath).catch((err) => {
          appendMinecraftServerLog(serverPath, `[FLOWDESK] Restart falhou: ${err.message}`);
          setMinecraftServerStatus(serverPath, 'crashed', { lastError: err.message });
        });
      }, 2500).unref?.();
      result = { ok: true, status: 'restarting', message: 'Restart enviado para o Minecraft.' };
    } else {
      return res.status(400).json({ ok: false, message: 'Acao Minecraft invalida.' });
    }
    appendMinecraftControlLog(serverPath, `Acao ${action} executada. Status atual: ${result.status}.`);
    return res.json({
      ...result,
      projectCode: vpsCode,
      worlds: listMinecraftWorlds(serverPath),
      limits: readJsonFile(path.join(serverPath, 'limits.json'), {}),
    });
  } catch (err) {
    setMinecraftServerStatus(serverPath, 'crashed', { lastError: err.message });
    appendMinecraftServerLog(serverPath, `[FLOWDESK] ${err.message}`);
    return res.status(500).json({ ok: false, status: 'crashed', message: err.message });
  }
});

app.get('/v1/minecraft/servers/:vpsCode/addons', async (req, res) => {
  const serverPath = resolveMinecraftServerPath(req.params.vpsCode);
  if (!serverPath || !fs.existsSync(serverPath)) {
    return res.status(404).json({ ok: false, message: 'Servidor Minecraft nao encontrado.' });
  }
  const type = req.query.type === 'mods' ? 'mods' : 'plugins';
  return res.json({
    ok: true,
    type,
    addons: listMinecraftAddons(serverPath, type),
    limits: readJsonFile(path.join(serverPath, 'limits.json'), {}),
  });
});

app.get('/v1/minecraft/servers/:vpsCode/library/search', async (req, res) => {
  try {
    const serverPath = resolveMinecraftServerPath(req.params.vpsCode);
    if (!serverPath || !fs.existsSync(serverPath)) {
      return res.status(404).json({ ok: false, message: 'Servidor Minecraft nao encontrado.' });
    }
    const payload = await searchMinecraftLibrary(
      serverPath,
      req.query.q || '',
      req.query.page || 1,
      req.query.limit || 20,
      req.query.index || '',
    );
    return res.json(payload);
  } catch (err) {
    return res.status(502).json({ ok: false, success: false, message: err.message });
  }
});

app.get('/v1/minecraft/servers/:vpsCode/library/project/:projectId', async (req, res) => {
  try {
    const serverPath = resolveMinecraftServerPath(req.params.vpsCode);
    if (!serverPath || !fs.existsSync(serverPath)) {
      return res.status(404).json({ ok: false, message: 'Servidor Minecraft nao encontrado.' });
    }
    return res.json(await getMinecraftLibraryProject(serverPath, req.params.projectId));
  } catch (err) {
    return res.status(502).json({ ok: false, success: false, message: err.message });
  }
});

app.post('/v1/minecraft/servers/:vpsCode/addons/install', async (req, res) => {
  try {
    const serverPath = resolveMinecraftServerPath(req.params.vpsCode);
    if (!serverPath || !fs.existsSync(serverPath)) {
      return res.status(404).json({ ok: false, message: 'Servidor Minecraft nao encontrado.' });
    }
    return res.json(await installMinecraftAddon(serverPath, req.body || {}));
  } catch (err) {
    return res.status(400).json({ ok: false, success: false, message: err.message });
  }
});

app.post('/v1/minecraft/servers/:vpsCode/addons/delete', async (req, res) => {
  try {
    const serverPath = resolveMinecraftServerPath(req.params.vpsCode);
    if (!serverPath || !fs.existsSync(serverPath)) {
      return res.status(404).json({ ok: false, message: 'Servidor Minecraft nao encontrado.' });
    }
    return res.json(deleteMinecraftAddon(serverPath, req.body || {}));
  } catch (err) {
    return res.status(400).json({ ok: false, success: false, message: err.message });
  }
});

app.post('/v1/vps/:vpsCode/actions/:action', async (req, res) => {
  const { vpsCode, action } = req.params;
  const projectPath = path.join(PROJECTS_DIR, vpsCode);

  try {
    // ── DEPLOY ──────────────────────────────────────────
    if (action === 'deploy') {
      const result = await deployProject(vpsCode, projectPath, req.body || {});
      return res.json(result);
    }

    // ── START ────────────────────────────────────────────
    if (action === 'start') {
      const result = await startOrRestartProject(vpsCode, projectPath, req.body || {});
      return res.json({
        ...result,
        message: result.autoDeployed
          ? 'Deploy inicial concluido e projeto iniciado.'
          : result.message || 'Projeto iniciado.',
      });
    }

    // ── STOP ─────────────────────────────────────────────
    if (action === 'stop') {
      await runCommand(`pm2 stop "${vpsCode}"`).catch(() => {});
      return res.json({ ok: true, status: 'offline' });
    }

    if (action === 'delete') {
      await runCommand(`pm2 delete "${vpsCode}"`).catch(() => {});
      const safeProjectPath = path.resolve(PROJECTS_DIR, vpsCode);
      const safeRoot = path.resolve(PROJECTS_DIR);
      if (safeProjectPath.startsWith(safeRoot) && fs.existsSync(safeProjectPath)) {
        fs.rmSync(safeProjectPath, { recursive: true, force: true });
      }
      await runCommand('pm2 save', null, {}).catch(() => {});
      return res.json({ ok: true, status: 'offline', message: 'Project removed.' });
    }

    // ── RESTART ──────────────────────────────────────────
    if (action === 'restart') {
      const result = await startOrRestartProject(vpsCode, projectPath, req.body || {});
      return res.json({
        ...result,
        message: result.autoDeployed
          ? 'Deploy automatico concluido e projeto reiniciado.'
          : result.message || 'Projeto reiniciado.',
      });
    }

    // ── ROLLBACK / SYNC (passthrough) ────────────────────
    res.json({ ok: true, status: 'unknown', message: `Ação ${action} recebida.` });

  } catch (err) {
    console.error(`[Daemon] Action ${action} failed for ${vpsCode}:`, err.message);
    const needsDeploy = err.code === "needs_deploy" || /deploy/i.test(String(err.message || ""));
    res.status(needsDeploy ? 400 : 500).json({
      ok: false,
      status: needsDeploy ? "offline" : "crashed",
      code: err.code || (needsDeploy ? "needs_deploy" : null),
      message: err.message,
    });
  }
});

// ── Deploys (legacy route from provisioning) ─────────────────────────────────
app.post('/v1/vps/:vpsCode/deploys', (req, res) => {
  req.params.action = 'deploy';
  // Delegate to actions handler
  const fakeNext = () => {};
  // Re-route body
  req.body = req.body || {};
  return app._router.handle(
    Object.assign(req, { url: `/v1/vps/${req.params.vpsCode}/actions/deploy`, method: 'POST' }),
    res,
    fakeNext
  );
});

// ── Metrics ───────────────────────────────────────────────────────────────────
async function readDiskPercent() {
  try {
    const raw = await runCommand(`df -k "${PROJECTS_DIR}" | tail -1`);
    const parts = raw.trim().split(/\s+/);
    const used = parseInt(parts[2], 10);
    const total = parseInt(parts[1], 10);
    if (Number.isFinite(used) && Number.isFinite(total) && total > 0) {
      return Math.round((used / total) * 1000) / 10;
    }
  } catch (_) {}
  return 0;
}

function readPrimaryIp() {
  const nets = os.networkInterfaces();
  for (const entries of Object.values(nets)) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return null;
}

app.get('/v1/vps/:vpsCode/metrics', async (req, res) => {
  const { vpsCode } = req.params;
  try {
    const raw = await runCommand('pm2 jlist');
    const list = JSON.parse(raw.trim() || '[]');
    const proc = list.find(p => p.name === vpsCode);
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const ramPercent = totalMem > 0 ? Math.round(((totalMem - freeMem) / totalMem) * 1000) / 10 : 0;
    const diskPercent = await readDiskPercent();
    const appRamMb = proc ? Math.round(((proc.monit?.memory || 0) / (1024 * 1024)) * 10) / 10 : 0;
    if (proc) {
      const pm2Status = proc.pm2_env?.status || 'unknown';
      const runtimeStatus = pm2Status === 'online' ? 'online' : pm2Status === 'stopped' ? 'offline' : pm2Status === 'errored' ? 'crashed' : 'unknown';
      return res.json({
        ok: true,
        status: runtimeStatus,
        host: os.hostname(),
        publicIp: readPrimaryIp(),
        metric: {
          cpu_percent: proc.monit?.cpu ?? 0,
          ram_percent: ramPercent,
          disk_percent: diskPercent,
          network_rx_kbps: 0,
          network_tx_kbps: 0,
          process_count: list.length,
          uptime_seconds: proc.pm2_env?.pm_uptime ? Math.max(0, Math.floor((Date.now() - proc.pm2_env.pm_uptime) / 1000)) : 0,
          app_cpu_percent: proc.monit?.cpu ?? 0,
          app_ram_mb: appRamMb,
          memory: proc.monit?.memory ?? 0,
        },
      });
    }
    res.json({
      ok: true,
      status: 'offline',
      host: os.hostname(),
      publicIp: readPrimaryIp(),
      metric: {
        cpu_percent: 0,
        ram_percent: ramPercent,
        disk_percent: diskPercent,
        network_rx_kbps: 0,
        network_tx_kbps: 0,
        process_count: list.length,
        uptime_seconds: 0,
        app_cpu_percent: 0,
        app_ram_mb: 0,
      },
    });
  } catch (err) {
    res.json({ ok: true, status: 'unknown', metric: null, error: err.message });
  }
});

// ── Logs ──────────────────────────────────────────────────────────────────────
app.get('/v1/vps/:vpsCode/logs', async (req, res) => {
  const { vpsCode } = req.params;
  const lines = parseInt(req.query.lines) || 100;
  try {
    if (req.query.kind === 'minecraft') {
      const serverPath = resolveMinecraftServerPath(vpsCode);
      if (!serverPath || !fs.existsSync(serverPath)) {
        return res.json({ ok: true, logs: '' });
      }
      const logFiles = [
        path.join(serverPath, 'logs', 'latest.log'),
      ];
      let logContent = '';
      for (const logFile of logFiles) {
        if (!fs.existsSync(logFile)) continue;
        const all = fs.readFileSync(logFile, 'utf8').split('\n').filter(l => l.trim());
        if (all.length) {
          logContent += `${logContent ? '\n' : ''}${all.slice(-lines).join('\n')}`;
        }
      }
      return res.json({ ok: true, source: 'minecraft', logs: logContent.trim() });
    }

    // Read out.log and error.log directly to avoid PM2 bus issues
    const pm2Home = process.env.PM2_HOME || '/root/.pm2';
    const outLog  = path.join(pm2Home, 'logs', `${vpsCode}-out.log`);
    const errLog  = path.join(pm2Home, 'logs', `${vpsCode}-error.log`);

    let logContent = '';
    if (fs.existsSync(outLog)) {
      const all = fs.readFileSync(outLog, 'utf8').split('\n');
      logContent += all.slice(-lines).join('\n');
    }
    if (fs.existsSync(errLog)) {
      const all = fs.readFileSync(errLog, 'utf8').split('\n').filter(l => l.trim());
      if (all.length) logContent += '\n[STDERR]\n' + all.slice(-Math.min(lines, 50)).join('\n');
    }

    res.json({ ok: true, logs: logContent.trim() });
  } catch (err) {
    res.json({ ok: false, logs: '', message: err.message });
  }
});

const server = app.listen(PORT, process.env.DAEMON_BIND || "127.0.0.1", () => {
  console.log(`[Flowdesk Daemon] Listening on ${process.env.DAEMON_BIND || "127.0.0.1"}:${PORT}`);
  ensureCustomerHttpStack();
});
server.keepAliveTimeout = 75_000;
server.headersTimeout = 80_000;
server.requestTimeout = 180_000;
server.timeout = 180_000;
