const mysql = require("mysql2/promise");

const DEFAULT_CITY_USER = "usuariodeteste";
const DEFAULT_CITY_PASSWORD = "12345";
const CONNECT_TIMEOUT_MS = 1200;
const FALLBACK_TIMEOUT_MS = 600;
let liveConnection = null;

function safeDatabaseName(value) {
  return String(value || "").replace(/[`\\]/g, "");
}

function resolveCityLogin(target) {
  const user = String(target?.user || "").trim() || DEFAULT_CITY_USER;
  const typed = target?.password == null ? "" : String(target.password);
  return {
    user,
    password: typed || (user === DEFAULT_CITY_USER ? DEFAULT_CITY_PASSWORD : ""),
    database: safeDatabaseName(target?.database),
    port: Number(target?.port || 3306),
  };
}

function uniqueCreds(items) {
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.user}\0${item.password}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function credentialList(login) {
  return uniqueCreds([
    { user: login.user, password: login.password },
    { user: DEFAULT_CITY_USER, password: DEFAULT_CITY_PASSWORD },
    { user: login.user, password: "" },
    { user: "root", password: login.password },
    { user: "root", password: DEFAULT_CITY_PASSWORD },
    { user: "root", password: "" },
    { user: "root", password: "root" },
    { user: "root", password: "123456" },
  ]);
}

async function openMysql(attempt, database, timeoutMs = CONNECT_TIMEOUT_MS) {
  const connection = await mysql.createConnection({
    host: attempt.socketPath ? undefined : attempt.host,
    port: attempt.socketPath ? undefined : attempt.port,
    socketPath: attempt.socketPath,
    user: attempt.user,
    password: attempt.password,
    connectTimeout: timeoutMs,
    enableKeepAlive: true,
    insecureAuth: true,
    charset: "utf8mb4",
  });
  if (database) {
    try {
      await connection.query(`USE \`${database}\``);
    } catch (error) {
      await connection.end().catch(() => null);
      throw error;
    }
  }
  return connection;
}

async function runFirstSql(connection, statements) {
  for (const sql of statements) {
    try {
      await connection.query(sql);
      return true;
    } catch {
      /* MariaDB and MySQL 8 reject each other's CREATE USER syntax */
    }
  }
  return false;
}

async function ensureAccount(connection, user, password, database) {
  const safeUser = String(user || "").trim();
  if (!safeUser) return;
  const pwd = connection.escape(password || "");
  for (const host of ["localhost", "127.0.0.1", "%"]) {
    const ident = `${connection.escape(safeUser)}@${connection.escape(host)}`;
    await runFirstSql(connection, [
      `GRANT ALL PRIVILEGES ON *.* TO ${ident} IDENTIFIED BY ${pwd} WITH GRANT OPTION`,
      `CREATE USER IF NOT EXISTS ${ident} IDENTIFIED BY ${pwd}`,
      `CREATE USER ${ident} IDENTIFIED BY ${pwd}`,
      `ALTER USER ${ident} IDENTIFIED BY ${pwd}`,
      `SET PASSWORD FOR ${ident} = PASSWORD(${pwd})`,
      `GRANT ALL PRIVILEGES ON *.* TO ${ident} IDENTIFIED VIA mysql_native_password USING PASSWORD(${pwd}) WITH GRANT OPTION`,
    ]);
    if (database) {
      await connection
        .query(`GRANT ALL PRIVILEGES ON \`${safeDatabaseName(database)}\`.* TO ${ident}`)
        .catch(() => null);
    }
  }
  await connection.query("FLUSH PRIVILEGES").catch(() => null);
}

async function provisionCityAccounts(connection, login) {
  await ensureAccount(connection, DEFAULT_CITY_USER, DEFAULT_CITY_PASSWORD, login.database);
  if (login.user && login.user !== DEFAULT_CITY_USER) {
    await ensureAccount(connection, login.user, login.password, login.database);
  }
}

async function tryReconnect(login, preferred) {
  const hosts = ["127.0.0.1", "localhost"];
  const ports = [...new Set([preferred.port, login.port, 3306, 3307].filter((value) => value >= 1 && value <= 65535))];
  let lastError = null;
  for (const host of hosts) {
    for (const port of ports) {
      try {
        return await openMysql(
          { user: login.user, password: login.password, host, port },
          login.database,
        );
      } catch (error) {
        lastError = error;
      }
    }
  }
  throw lastError || new Error("Conta criada, mas a reconexao falhou.");
}

function cacheKey(login) {
  return `${login.user}\0${login.password}\0${login.database}\0${login.port}`;
}

async function reuseLiveConnection(login) {
  if (!liveConnection || liveConnection.key !== cacheKey(login) || !liveConnection.connection) {
    return null;
  }
  try {
    await liveConnection.connection.ping();
    return liveConnection.connection;
  } catch {
    await liveConnection.connection.end().catch(() => null);
    liveConnection = null;
    return null;
  }
}

function rememberConnection(login, connection) {
  connection._flowdeskPooled = true;
  liveConnection = { key: cacheKey(login), connection };
  return connection;
}

async function connectPreferred(login) {
  return openMysql(
    { user: login.user, password: login.password, host: "127.0.0.1", port: login.port },
    login.database,
    CONNECT_TIMEOUT_MS,
  );
}

async function connectCityMysql(target) {
  const login = resolveCityLogin(target);
  const reused = await reuseLiveConnection(login);
  if (reused) return reused;
  try {
    return rememberConnection(login, await connectPreferred(login));
  } catch {
    /* Fall through to the broader local search. */
  }
  const ports = [...new Set([login.port, 3306, 3307].filter((value) => value >= 1 && value <= 65535))];
  const hosts = ["127.0.0.1", "localhost"];
  const pipes = ["\\\\.\\pipe\\MariaDB", "\\\\.\\pipe\\MySQL", "\\\\.\\pipe\\MySQL80"];
  let lastError = null;

  async function accept(connection, cred, port) {
    if (cred.user === login.user && cred.password === login.password) {
      return connection;
    }
    if (cred.user === "root") {
      try {
        await provisionCityAccounts(connection, login);
      } finally {
        await connection.end().catch(() => null);
      }
      return tryReconnect(login, { port });
    }
    await connection.end().catch(() => null);
    return null;
  }

  for (const cred of credentialList(login)) {
    for (const host of hosts) {
      for (const port of ports) {
        for (const dbName of login.database ? [login.database, ""] : [""]) {
          try {
            const opened = await accept(
              await openMysql({ ...cred, host, port }, dbName, FALLBACK_TIMEOUT_MS),
              cred,
              port,
            );
            if (opened) return rememberConnection(login, opened);
          } catch (error) {
            lastError = error;
          }
        }
      }
    }
    for (const socketPath of pipes) {
      try {
        const opened = await accept(
          await openMysql(
            { ...cred, host: "localhost", port: 3306, socketPath },
            login.database,
            FALLBACK_TIMEOUT_MS,
          ),
          cred,
          3306,
        );
        if (opened) return rememberConnection(login, opened);
      } catch (error) {
        lastError = error;
      }
    }
  }

  throw lastError || new Error("Nao foi possivel abrir o MariaDB/MySQL nesta VPS.");
}

function releaseCityMysql(connection) {
  if (connection?._flowdeskPooled) return Promise.resolve();
  return connection?.end?.().catch(() => null);
}

module.exports = {
  DEFAULT_CITY_USER,
  DEFAULT_CITY_PASSWORD,
  connectCityMysql,
  releaseCityMysql,
  resolveCityLogin,
  cityDbProvisionSql() {
    return [
      `GRANT ALL PRIVILEGES ON *.* TO '${DEFAULT_CITY_USER}'@'localhost' IDENTIFIED BY '${DEFAULT_CITY_PASSWORD}' WITH GRANT OPTION;`,
      `GRANT ALL PRIVILEGES ON *.* TO '${DEFAULT_CITY_USER}'@'127.0.0.1' IDENTIFIED BY '${DEFAULT_CITY_PASSWORD}' WITH GRANT OPTION;`,
      `GRANT ALL PRIVILEGES ON *.* TO '${DEFAULT_CITY_USER}'@'%' IDENTIFIED BY '${DEFAULT_CITY_PASSWORD}' WITH GRANT OPTION;`,
      "FLUSH PRIVILEGES;",
    ].join("\n");
  },
};
