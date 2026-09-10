const crypto = require("crypto");
const mysql = require("mysql2/promise");
const { Pool: PgPool } = require("pg");
const { settleMaybePromise } = require("../utils/settleMaybePromise");

const CONNECT_TIMEOUT_MS = 12_000;
const QUERY_TIMEOUT_MS = 6_000;
const INTERACTIVE_QUERY_TIMEOUT_MS = 4_500;
const POOL_CONNECTION_LIMIT = 8;
const POOL_MAX_IDLE = 6;
const POOL_IDLE_TIMEOUT_MS = 120_000;
const POOL_QUEUE_LIMIT = 32;
const MAX_RETRIES = 4;
const INTERACTIVE_MAX_RETRIES = 2;
const RETRY_BASE_MS = 90;
const RETRY_MAX_MS = 900;
const CIRCUIT_FAILURE_THRESHOLD = 8;
const CIRCUIT_OPEN_MS = 12_000;
const MAX_CONCURRENT_OPS = 10;
const HEALTH_CHECK_INTERVAL_MS = 60_000;

const poolRegistry = new Map();
const breakerRegistry = new Map();
const semaphoreRegistry = new Map();
const metricsRegistry = new Map();

const RETRYABLE_ERRNO = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "PROTOCOL_CONNECTION_LOST",
]);

const RETRYABLE_SQL_STATE = new Set(["08000", "08003", "08006", "08001", "HY000"]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelay(attempt) {
  const jitter = Math.floor(Math.random() * 80);
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1) + jitter);
}

function buildPoolKey(target) {
  const fingerprint = crypto
    .createHash("sha256")
    .update(
      [
        target.engine,
        target.host,
        target.port,
        target.database,
        target.user,
        target.password,
        target.ssl ? "1" : "0",
      ].join("\0"),
    )
    .digest("hex")
    .slice(0, 24);
  return `${target.engine}:${fingerprint}`;
}

function redactSecrets(text) {
  return String(text || "")
    .replace(/password[=:]\S+/gi, "password=[redacted]")
    .replace(/access denied for user '[^']+'@'[^']+'/gi, "access denied for user [redacted]")
    .slice(0, 240);
}

function logCityDb(level, event, extra = {}) {
  const payload = {
    scope: "city-db",
    event,
    ts: new Date().toISOString(),
    ...extra,
  };
  if (level === "error") {
    console.error("[city-db]", payload);
    return;
  }
  if (level === "warn") {
    console.warn("[city-db]", payload);
    return;
  }
  console.info("[city-db]", payload);
}

function getMetrics(poolKey) {
  if (!metricsRegistry.has(poolKey)) {
    metricsRegistry.set(poolKey, {
      queries: 0,
      failures: 0,
      retries: 0,
      lastLatencyMs: 0,
      lastErrorCode: null,
      lastSuccessAt: 0,
    });
  }
  return metricsRegistry.get(poolKey);
}

function createSemaphore(limit) {
  let active = 0;
  const queue = [];
  return {
    async acquire() {
      if (active < limit) {
        active += 1;
        return;
      }
      await new Promise((resolve) => queue.push(resolve));
      active += 1;
    },
    release() {
      active = Math.max(0, active - 1);
      const next = queue.shift();
      if (next) next();
    },
  };
}

function getSemaphore(poolKey) {
  if (!semaphoreRegistry.has(poolKey)) {
    semaphoreRegistry.set(poolKey, createSemaphore(MAX_CONCURRENT_OPS));
  }
  return semaphoreRegistry.get(poolKey);
}

function createCircuitBreaker(poolKey) {
  return {
    poolKey,
    failures: 0,
    openedUntil: 0,
    isOpen() {
      if (Date.now() < this.openedUntil) return true;
      if (this.openedUntil > 0) {
        this.openedUntil = 0;
        this.failures = 0;
      }
      return false;
    },
    recordSuccess() {
      this.failures = 0;
      this.openedUntil = 0;
    },
    recordFailure() {
      this.failures += 1;
      if (this.failures >= CIRCUIT_FAILURE_THRESHOLD) {
        this.openedUntil = Date.now() + CIRCUIT_OPEN_MS;
        logCityDb("warn", "circuit_open", {
          poolKey: this.poolKey.slice(0, 12),
          failures: this.failures,
          openMs: CIRCUIT_OPEN_MS,
        });
      }
    },
  };
}

function getBreaker(poolKey) {
  if (!breakerRegistry.has(poolKey)) {
    breakerRegistry.set(poolKey, createCircuitBreaker(poolKey));
  }
  return breakerRegistry.get(poolKey);
}

function classifyDbError(error) {
  const errno = String(error?.code || error?.errno || error?.cause?.code || "").toUpperCase();
  const sqlState = String(error?.sqlState || error?.cause?.sqlState || "").toUpperCase();
  const { explainCityDbFailure, uniqueNotice } = require("./cityDbErrors");
  const issue = explainCityDbFailure(error);
  const retryableByNetwork =
    RETRYABLE_ERRNO.has(errno) ||
    RETRYABLE_SQL_STATE.has(sqlState) ||
    issue.retryable === true;
  return {
    code: issue.code,
    title: issue.title,
    message: issue.message,
    hint: issue.hint,
    publicMessage: uniqueNotice(issue.message, issue.hint),
    retryable: retryableByNetwork,
    evictPool: issue.evictPool === true,
  };
}

function wrapClassifiedError(classified, original) {
  const error = new Error(classified.publicMessage || classified.message);
  error.code = classified.code;
  error.title = classified.title;
  error.hint = classified.hint;
  error.cause = original;
  error.errno = original?.errno || original?.cause?.errno;
  error.sqlState = original?.sqlState || original?.cause?.sqlState;
  error.sqlMessage = original?.sqlMessage || original?.cause?.sqlMessage;
  return error;
}

function toPg(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

async function evictPool(poolKey) {
  const entry = poolRegistry.get(poolKey);
  if (!entry) return;
  poolRegistry.delete(poolKey);
  logCityDb("warn", "pool_evicted", { poolKey: poolKey.slice(0, 12), engine: entry.engine });
  await settleMaybePromise(entry.pool?.end?.());
}

function createMysqlPool(target) {
  const pool = mysql.createPool({
    host: target.host,
    port: target.port,
    database: target.database || undefined,
    user: target.user,
    password: target.password || "",
    ssl: target.ssl ? { rejectUnauthorized: false } : undefined,
    waitForConnections: true,
    connectionLimit: POOL_CONNECTION_LIMIT,
    maxIdle: POOL_MAX_IDLE,
    idleTimeout: POOL_IDLE_TIMEOUT_MS,
    queueLimit: POOL_QUEUE_LIMIT,
    connectTimeout: CONNECT_TIMEOUT_MS,
    enableKeepAlive: true,
    keepAliveInitialDelay: 5_000,
    insecureAuth: true,
    charset: "utf8mb4",
    dateStrings: true,
  });
  pool.on("connection", (connection) => {
    connection.on("error", () => {
      /* mysql2 removes broken connection from pool automatically */
    });
  });
  return pool;
}

function createPgPool(target) {
  return new PgPool({
    host: target.host,
    port: target.port,
    database: target.database,
    user: target.user,
    password: target.password,
    ssl: target.ssl ? { rejectUnauthorized: false } : undefined,
    max: POOL_CONNECTION_LIMIT,
    idleTimeoutMillis: POOL_IDLE_TIMEOUT_MS,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    allowExitOnIdle: true,
    statement_timeout: QUERY_TIMEOUT_MS,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  });
}

async function getPoolEntry(target) {
  const poolKey = buildPoolKey(target);
  const existing = poolRegistry.get(poolKey);
  if (existing) return { poolKey, ...existing };

  const entry =
    target.engine === "postgres"
      ? { engine: "postgres", pool: createPgPool(target), lastHealthAt: 0 }
      : { engine: "mysql", pool: createMysqlPool(target), lastHealthAt: 0 };

  poolRegistry.set(poolKey, entry);
  return { poolKey, ...entry };
}

async function runQueryWithTimeout(run, timeoutMs) {
  let timer = null;
  try {
    return await Promise.race([
      run(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("query timeout")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function pingPool(entry) {
  if (entry.engine === "postgres") {
    await entry.pool.query("SELECT 1");
    return;
  }
  const conn = await entry.pool.getConnection();
  try {
    await conn.ping();
  } finally {
    await settleMaybePromise(conn.release?.());
  }
}

async function ensureHealthy(entry, poolKey, force = false) {
  const now = Date.now();
  if (!force && now - entry.lastHealthAt < HEALTH_CHECK_INTERVAL_MS) return;
  await pingPool(entry);
  entry.lastHealthAt = now;
  poolRegistry.set(poolKey, entry);
}

async function runMysqlTransaction(pool, fn, queryTimeoutMs) {
  const connection = await pool.getConnection();
  const query = async (sql, params = []) => {
    const [rows] = await runQueryWithTimeout(
      () => connection.query(sql, params),
      queryTimeoutMs,
    );
    return Array.isArray(rows) ? rows : [];
  };
  try {
    await connection.beginTransaction();
    const result = await fn(query);
    await connection.commit();
    return result;
  } catch (error) {
    await settleMaybePromise(connection.rollback?.());
    throw error;
  } finally {
    await settleMaybePromise(connection.release?.());
  }
}

async function runPgTransaction(pool, fn, queryTimeoutMs) {
  const client = await pool.connect();
  const query = async (sql, params = []) => {
    const result = await runQueryWithTimeout(
      () => client.query(toPg(sql), params),
      queryTimeoutMs,
    );
    return result.rows || [];
  };
  try {
    await client.query("BEGIN");
    const result = await fn(query);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await settleMaybePromise(client.query("ROLLBACK"));
    throw error;
  } finally {
    await settleMaybePromise(client.release?.());
  }
}

async function runOnce(target, poolKey, fn, options) {
  const queryTimeoutMs = options.interactive ? INTERACTIVE_QUERY_TIMEOUT_MS : QUERY_TIMEOUT_MS;
  const entry = await getPoolEntry(target);
  if (!options.interactive) {
    await ensureHealthy(entry, poolKey);
  }

  const metrics = getMetrics(poolKey);
  const started = Date.now();

  if (entry.engine === "postgres") {
    const query = async (sql, params = []) => {
      const result = await runQueryWithTimeout(
        () => entry.pool.query(toPg(sql), params),
        queryTimeoutMs,
      );
      return result.rows || [];
    };
    const withTransaction = (txFn) => runPgTransaction(entry.pool, txFn, queryTimeoutMs);
    const value = await fn({ query, withTransaction });
    metrics.queries += 1;
    metrics.lastLatencyMs = Date.now() - started;
    metrics.lastSuccessAt = Date.now();
    return value;
  }

  const query = async (sql, params = []) => {
    const [rows] = await runQueryWithTimeout(
      () => entry.pool.query(sql, params),
      queryTimeoutMs,
    );
    return Array.isArray(rows) ? rows : [];
  };
  const withTransaction = (txFn) => runMysqlTransaction(entry.pool, txFn, queryTimeoutMs);
  const value = await fn({ query, withTransaction });
  metrics.queries += 1;
  metrics.lastLatencyMs = Date.now() - started;
  metrics.lastSuccessAt = Date.now();
  return value;
}

async function executeWithCityDb(target, fn, options = {}) {
  const poolKey = buildPoolKey(target);
  const breaker = getBreaker(poolKey);
  if (breaker.isOpen()) {
    const error = new Error("Banco da cidade temporariamente indisponivel. Tente em instantes.");
    error.code = "circuit_open";
    throw error;
  }

  const semaphore = getSemaphore(poolKey);
  await semaphore.acquire();
  try {
    let lastError = null;
    const maxRetries = options.interactive ? INTERACTIVE_MAX_RETRIES : MAX_RETRIES;
    for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
      try {
        const value = await runOnce(target, poolKey, fn, options);
        breaker.recordSuccess();
        return value;
      } catch (error) {
        const classified = classifyDbError(error);
        lastError = error;
        getMetrics(poolKey).failures += 1;
        getMetrics(poolKey).lastErrorCode = classified.code;
        logCityDb("warn", "query_fail", {
          poolKey: poolKey.slice(0, 12),
          attempt,
          code: classified.code,
          sqlMessage: redactSecrets(error?.sqlMessage || error?.cause?.sqlMessage || error?.message),
        });

        if (!classified.retryable || attempt >= maxRetries) {
          if (classified.retryable || classified.evictPool) {
            breaker.recordFailure();
          }
          throw wrapClassifiedError(classified, error);
        }

        getMetrics(poolKey).retries += 1;
        logCityDb("warn", "query_retry", {
          poolKey: poolKey.slice(0, 12),
          attempt,
          code: classified.code,
          delayMs: retryDelay(attempt),
        });
        if (classified.evictPool) {
          await evictPool(poolKey);
        }
        await sleep(retryDelay(attempt));
      }
    }
    throw lastError || new Error("Falha ao acessar o banco da cidade.");
  } finally {
    semaphore.release();
  }
}

async function healthCheckCityDb(target) {
  const poolKey = buildPoolKey(target);
  const breaker = getBreaker(poolKey);
  if (breaker.isOpen()) {
    return { ok: false, code: "circuit_open", latencyMs: 0 };
  }
  const started = Date.now();
  try {
    const entry = await getPoolEntry(target);
    await ensureHealthy(entry, poolKey, true);
    breaker.recordSuccess();
    return { ok: true, code: "ok", latencyMs: Date.now() - started };
  } catch (error) {
    const classified = classifyDbError(error);
    breaker.recordFailure();
    return { ok: false, code: classified.code, latencyMs: Date.now() - started };
  }
}

function getCityDbMetrics(target) {
  const poolKey = buildPoolKey(target);
  return { poolKey: poolKey.slice(0, 12), ...getMetrics(poolKey) };
}

async function healthCheckActivePools() {
  const snapshots = [];
  for (const [poolKey, entry] of poolRegistry.entries()) {
    const started = Date.now();
    try {
      await ensureHealthy(entry, poolKey, true);
      getBreaker(poolKey).recordSuccess();
      snapshots.push({ poolKey: poolKey.slice(0, 12), ok: true, latencyMs: Date.now() - started });
    } catch (error) {
      const classified = classifyDbError(error);
      getBreaker(poolKey).recordFailure();
      logCityDb("warn", "pool_health_fail", {
        poolKey: poolKey.slice(0, 12),
        code: classified.code,
      });
      if (classified.evictPool) {
        await evictPool(poolKey);
      }
      snapshots.push({
        poolKey: poolKey.slice(0, 12),
        ok: false,
        code: classified.code,
        latencyMs: Date.now() - started,
      });
    }
  }
  if (snapshots.length) {
    logCityDb("info", "pool_health_scan", { pools: snapshots.length, ok: snapshots.filter((item) => item.ok).length });
  }
  return snapshots;
}

module.exports = {
  executeWithCityDb,
  healthCheckCityDb,
  healthCheckActivePools,
  getCityDbMetrics,
  classifyDbError,
  evictPool,
  buildPoolKey,
  logCityDb,
};
