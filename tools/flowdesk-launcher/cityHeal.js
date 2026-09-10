const { exec, spawn } = require("child_process");
const fs = require("fs");
const net = require("net");
const path = require("path");
const { connectCityMysql, releaseCityMysql, evictCityMysqlPools } = require("./cityMysql");

const PROBE_MS = 350;
const START_WAIT_MS = 10_000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function probePort(host, port, timeoutMs = PROBE_MS) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve(true);
    });
    socket.once("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

function run(command, timeoutMs = 8000) {
  return new Promise((resolve) => {
    exec(
      command,
      { windowsHide: true, timeout: timeoutMs },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
        });
      },
    );
  });
}

function spawnDetached(exe, args, cwd) {
  try {
    const child = spawn(exe, args, {
      cwd: cwd || path.dirname(exe),
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function exists(file) {
  try {
    return Boolean(file) && fs.existsSync(file);
  } catch {
    return false;
  }
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

function collectInstalls() {
  const found = [];
  const seen = new Set();
  const add = (install) => {
    const key = String(install.mysqld || install.startBat || "").toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    found.push(install);
  };

  const roots = [];
  for (const drive of ["C", "D", "E", "F"]) {
    roots.push(
      `${drive}:\\xampp`,
      `${drive}:\\XAMPP`,
      `${drive}:\\laragon`,
      `${drive}:\\wamp64`,
      `${drive}:\\wamp`,
      `${drive}:\\server\\xampp`,
      `${drive}:\\appserv`,
      `${drive}:\\USBWebserver`,
      `${drive}:\\fivem\\mysql`,
      `${drive}:\\txData\\mysql`,
    );
  }
  const envRoots = [process.env.XAMPP_HOME, process.env.XAMPP, process.env.LARAGON_ROOT].filter(Boolean);
  roots.push(...envRoots);

  for (const root of roots) {
    if (!exists(root)) continue;
    const mysqld = [
      path.join(root, "mysql", "bin", "mysqld.exe"),
      path.join(root, "bin", "mysqld.exe"),
    ].find(exists);
    const myIni = [
      path.join(root, "mysql", "bin", "my.ini"),
      path.join(root, "mysql", "my.ini"),
      path.join(root, "bin", "my.ini"),
    ].find(exists);
    const startBat = [
      path.join(root, "mysql_start.bat"),
      path.join(root, "mysql_start.cmd"),
      path.join(root, "xampp_start.exe"),
    ].find(exists);
    if (mysqld || startBat) {
      add({
        kind: /xampp/i.test(root) ? "xampp" : "bundle",
        root,
        mysqld,
        myIni,
        startBat,
      });
    }

    for (const nest of [
      path.join(root, "bin", "mysql"),
      path.join(root, "bin", "mariadb"),
      path.join(root, "mysql"),
    ]) {
      if (!exists(nest)) continue;
      for (const name of listDir(nest)) {
        const nestedMysqld = path.join(nest, name, "bin", "mysqld.exe");
        const nestedIni = [
          path.join(nest, name, "my.ini"),
          path.join(nest, name, "bin", "my.ini"),
        ].find(exists);
        if (exists(nestedMysqld)) {
          add({
            kind: "bundle",
            root: path.join(nest, name),
            mysqld: nestedMysqld,
            myIni: nestedIni,
            startBat: null,
          });
        }
      }
    }
  }

  const programRoots = [
    path.join(process.env["ProgramFiles"] || "C:\\Program Files", "MySQL"),
    path.join(process.env["ProgramFiles"] || "C:\\Program Files", "MariaDB"),
    path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "MySQL"),
    path.join(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "MariaDB"),
  ];
  for (const programRoot of programRoots) {
    if (!exists(programRoot)) continue;
    for (const name of listDir(programRoot)) {
      const mysqld = path.join(programRoot, name, "bin", "mysqld.exe");
      const myIni = [
        path.join(programRoot, name, "my.ini"),
        path.join(process.env.ProgramData || "C:\\ProgramData", "MySQL", name, "my.ini"),
      ].find(exists);
      if (exists(mysqld)) {
        add({ kind: "service", root: path.join(programRoot, name), mysqld, myIni, startBat: null });
      }
    }
  }

  return found;
}

async function isLocalMysqlUp(ports) {
  for (const port of ports) {
    if (await probePort("127.0.0.1", port)) return port;
  }
  return 0;
}

async function startWindowsServices() {
  const services = [
    "MySQL",
    "MySQL80",
    "MySQL84",
    "MySQL57",
    "MySQL56",
    "MariaDB",
    "MariaDB103",
    "MariaDB104",
    "MariaDB106",
    "MariaDB1011",
    "XAMPP",
  ];
  for (const name of services) {
    await run(`sc start "${name}"`);
    await run(`net start "${name}"`);
  }
}

async function isMysqldRunning() {
  const result = await run("tasklist /FI \"IMAGENAME eq mysqld.exe\" /NH", 4000);
  return /mysqld\.exe/i.test(result.stdout || "");
}

function patchBindAddress(file) {
  if (!exists(file)) return false;
  try {
    const raw = fs.readFileSync(file, "utf8");
    const next = raw
      .replace(/^\s*bind-address\s*=\s*127\.0\.0\.1/gim, "bind-address=0.0.0.0")
      .replace(/^\s*skip-networking\s*=\s*1/gim, "skip-networking=0");
    if (next === raw) return false;
    fs.copyFileSync(file, `${file}.flowdesk.bak`);
    fs.writeFileSync(file, next, "utf8");
    return true;
  } catch {
    return false;
  }
}

function startInstall(install) {
  if (install.myIni) patchBindAddress(install.myIni);
  if (install.mysqld && install.myIni) {
    if (spawnDetached(install.mysqld, [`--defaults-file=${install.myIni}`], path.dirname(install.mysqld))) {
      return `mysqld ${path.basename(install.root)}`;
    }
  }
  if (install.mysqld) {
    if (spawnDetached(install.mysqld, ["--standalone"], path.dirname(install.mysqld))) {
      return `mysqld standalone ${path.basename(install.root)}`;
    }
  }
  if (install.startBat) {
    if (spawnDetached(install.startBat, [], install.root)) {
      return path.basename(install.startBat);
    }
  }
  return "";
}

async function waitForMysql(ports, timeoutMs = START_WAIT_MS) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const open = await isLocalMysqlUp(ports);
    if (open) return open;
    await sleep(400);
  }
  return 0;
}

async function verifyCityLogin(target) {
  const connection = await connectCityMysql(target);
  try {
    await connection.query("SELECT 1 AS ok");
    return { ok: true };
  } finally {
    await releaseCityMysql(connection);
  }
}

async function healCityMysql(target = {}) {
  const preferred = Number(target.port || 3306) || 3306;
  const ports = [...new Set([preferred, 3306, 3307].filter((value) => value >= 1 && value <= 65535))];
  const steps = [];

  let openPort = await isLocalMysqlUp(ports);
  const alreadyRunning = await isMysqldRunning();
  if (!openPort) {
    steps.push("mysql_off");
    await startWindowsServices();
    steps.push("services");
    openPort = await isLocalMysqlUp(ports);
  }

  if (!openPort && alreadyRunning) {
    steps.push("mysqld_running");
    openPort = await waitForMysql(ports, 6000);
  }

  if (!openPort && !alreadyRunning) {
    const installs = collectInstalls();
    if (!installs.length) {
      return {
        ok: false,
        mysql: "down",
        code: "mysql_missing",
        message: "Nao achei XAMPP/MySQL nesta VPS. Instale o XAMPP ou ligue o MariaDB.",
        steps,
      };
    }
    for (const install of installs) {
      const started = startInstall(install);
      if (!started) continue;
      steps.push(started);
      openPort = await waitForMysql(ports, 5000);
      if (openPort) break;
    }
    if (!openPort) openPort = await waitForMysql(ports, 4000);
  }

  if (!openPort) {
    return {
      ok: false,
      mysql: "down",
      code: "offline",
      message: "O MySQL desta VPS ainda nao abriu a porta 3306. O launcher tenta de novo sozinho.",
      steps,
    };
  }

  try {
    await evictCityMysqlPools();
    await verifyCityLogin({ ...target, port: openPort || preferred });
    return {
      ok: true,
      mysql: "up",
      port: openPort,
      message: `MySQL local pronto na porta ${openPort}.`,
      steps,
    };
  } catch (error) {
    return {
      ok: false,
      mysql: "up",
      port: openPort,
      code: error?.code || "invalid_credentials",
      message: error?.message || "MySQL ligado, mas o usuario do painel ainda nao entra.",
      steps,
    };
  }
}

module.exports = {
  collectInstalls,
  healCityMysql,
  isLocalMysqlUp,
  probePort,
  waitForMysql,
};
