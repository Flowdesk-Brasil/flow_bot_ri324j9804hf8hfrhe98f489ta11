'use strict';
const express = require('express');
const { exec, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ─── Config ──────────────────────────────────────────────────────────────────
const AUTH_TOKEN   = process.env.DAEMON_TOKEN || "flowdesk-super-secret-token-v1";
const PROJECTS_DIR = process.env.PROJECTS_DIR || "/root/flowdesk-projects";
const PORT         = process.env.PORT || 5001;

if (!fs.existsSync(PROJECTS_DIR)) {
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
}

// ─── Auth Middleware ──────────────────────────────────────────────────────────
app.use((req, res, next) => {
  const auth = req.headers['authorization'] || '';
  if (auth !== `Bearer ${AUTH_TOKEN}`) {
    return res.status(401).json({ ok: false, message: "Unauthorized agent token" });
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

    const opts = { env, shell: '/bin/sh' };
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

/** Recursive file tree walker */
function walkTree(dir, relPrefix = '') {
  const result = [];
  let entries;
  try { entries = fs.readdirSync(dir); } catch { return result; }
  for (const name of entries) {
    if (name === '.git' || name === 'node_modules' || name === '.env') continue;
    const full = path.join(dir, name);
    const rel  = relPrefix ? `${relPrefix}/${name}` : name;
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (stat.isDirectory()) {
      result.push({ name, path: rel, type: 'directory', language: null, children: walkTree(full, rel) });
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

/** Detect the start command from a project dir */
function detectStartScript(projectPath) {
  const pkgPath = path.join(projectPath, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      if (pkg.main) return { interpreter: 'node', script: pkg.main };
    } catch (_) {}
    // Check for index.js
    if (fs.existsSync(path.join(projectPath, 'index.js'))) {
      return { interpreter: 'node', script: 'index.js' };
    }
    if (fs.existsSync(path.join(projectPath, 'src/index.js'))) {
      return { interpreter: 'node', script: 'src/index.js' };
    }
    // Fallback: use npm start
    return { interpreter: 'npm', script: 'start' };
  }
  if (fs.existsSync(path.join(projectPath, 'main.py'))) {
    return { interpreter: 'python3', script: 'main.py' };
  }
  if (fs.existsSync(path.join(projectPath, 'bot.py'))) {
    return { interpreter: 'python3', script: 'bot.py' };
  }
  return null;
}

/** Start or restart a project in PM2 with env injection */
async function pm2StartOrRestart(vpsCode, projectPath) {
  const detected = detectStartScript(projectPath);
  if (!detected) throw new Error('Nenhum arquivo de entrada detectado (index.js, main.py, etc). Certifique-se de que o projeto foi clonado corretamente.');

  const envObj = loadProjectEnv(projectPath);

  // Try restart first (if already registered)
  try {
    await runCommand(`pm2 restart "${vpsCode}" --update-env`, projectPath, envObj);
    await runCommand('pm2 save', null, {});
    return;
  } catch (_) { /* not registered yet, will start fresh */ }

  // Delete stale entry if any
  await runCommand(`pm2 delete "${vpsCode}"`).catch(() => {});

  let startCmd;
  if (detected.interpreter === 'npm') {
    startCmd = `pm2 start npm --name "${vpsCode}" --update-env -- ${detected.script}`;
  } else {
    startCmd = `pm2 start ${detected.interpreter} --name "${vpsCode}" --update-env -- ${detected.script}`;
  }

  await runCommand(startCmd, projectPath, envObj);
  await runCommand('pm2 save', null, {});
}

// ─── Routes ──────────────────────────────────────────────────────────────────

// Health check (unauthenticated)
app.get('/status', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// ── Files ───────────────────────────────────────────────────────────────────

// GET tree or file content
app.get('/v1/vps/:vpsCode/files', async (req, res) => {
  const { vpsCode } = req.params;
  const filePath    = req.query.path;
  const projectPath = path.join(PROJECTS_DIR, vpsCode);

  if (!fs.existsSync(projectPath)) {
    return res.json({ ok: true, tree: [] });
  }

  if (filePath) {
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

  res.json({ ok: true, tree: walkTree(projectPath) });
});

// POST save file content
app.post('/v1/vps/:vpsCode/files', async (req, res) => {
  const { vpsCode } = req.params;
  const { path: filePath, content, action, targetPath: destPath, type } = req.body;
  const projectPath = path.join(PROJECTS_DIR, vpsCode);

  try {
    if (!fs.existsSync(projectPath)) fs.mkdirSync(projectPath, { recursive: true });

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

    res.json({ ok: true, tree: walkTree(projectPath) });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// ── Env ──────────────────────────────────────────────────────────────────────

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

app.post('/v1/vps/:vpsCode/actions/:action', async (req, res) => {
  const { vpsCode, action } = req.params;
  const projectPath = path.join(PROJECTS_DIR, vpsCode);

  try {
    // ── DEPLOY ──────────────────────────────────────────
    if (action === 'deploy') {
      const { gitUrl, branch = 'main' } = req.body;

      if (fs.existsSync(path.join(projectPath, '.git'))) {
        // Already cloned — pull latest
        await runCommand(`git fetch origin && git reset --hard origin/${branch}`, projectPath);
      } else if (gitUrl) {
        // Fresh clone
        fs.mkdirSync(projectPath, { recursive: true });
        await runCommand(`git clone --depth=1 -b ${branch} "${gitUrl}" "${projectPath}"`, PROJECTS_DIR);
      } else {
        return res.status(400).json({ ok: false, message: 'gitUrl obrigatório para deploy inicial.' });
      }

      // Install dependencies
      if (fs.existsSync(path.join(projectPath, 'package.json'))) {
        await runCommand('npm install --production=false', projectPath);
      } else if (fs.existsSync(path.join(projectPath, 'requirements.txt'))) {
        await runCommand('pip3 install -r requirements.txt', projectPath).catch(() => {});
      }

      // Start
      await pm2StartOrRestart(vpsCode, projectPath);
      return res.json({ ok: true, status: 'online', message: 'Deploy concluído.' });
    }

    // ── START ────────────────────────────────────────────
    if (action === 'start') {
      if (!fs.existsSync(projectPath)) {
        return res.status(400).json({ ok: false, message: 'Projeto ainda não foi deployado. Clique em Deploy primeiro.' });
      }
      await pm2StartOrRestart(vpsCode, projectPath);
      return res.json({ ok: true, status: 'online' });
    }

    // ── STOP ─────────────────────────────────────────────
    if (action === 'stop') {
      await runCommand(`pm2 stop "${vpsCode}"`).catch(() => {});
      return res.json({ ok: true, status: 'offline' });
    }

    // ── RESTART ──────────────────────────────────────────
    if (action === 'restart') {
      if (!fs.existsSync(projectPath)) {
        return res.status(400).json({ ok: false, message: 'Projeto ainda não foi deployado. Clique em Deploy primeiro.' });
      }
      await pm2StartOrRestart(vpsCode, projectPath);
      return res.json({ ok: true, status: 'online' });
    }

    // ── ROLLBACK / SYNC (passthrough) ────────────────────
    res.json({ ok: true, status: 'unknown', message: `Ação ${action} recebida.` });

  } catch (err) {
    console.error(`[Daemon] Action ${action} failed for ${vpsCode}:`, err.message);
    res.status(500).json({ ok: false, status: 'crashed', message: err.message });
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
app.get('/v1/vps/:vpsCode/metrics', async (req, res) => {
  const { vpsCode } = req.params;
  try {
    const raw = await runCommand('pm2 jlist');
    const list = JSON.parse(raw.trim() || '[]');
    const proc = list.find(p => p.name === vpsCode);
    if (proc) {
      return res.json({
        ok: true,
        status: proc.pm2_env?.status || 'unknown',
        metric: {
          cpu:    proc.monit?.cpu    ?? 0,
          memory: proc.monit?.memory ?? 0,
        },
      });
    }
    res.json({ ok: true, status: 'offline', metric: null });
  } catch (err) {
    res.json({ ok: true, status: 'unknown', metric: null, error: err.message });
  }
});

// ── Logs ──────────────────────────────────────────────────────────────────────
app.get('/v1/vps/:vpsCode/logs', async (req, res) => {
  const { vpsCode } = req.params;
  const lines = parseInt(req.query.lines) || 100;
  try {
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

// ── Health / Ping ─────────────────────────────────────────────────────────────
app.get('/ping', (req, res) => res.json({ ok: true }));

// ─── Start Server ─────────────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[Flowdesk Daemon] Listening on ${PORT}`);
});
