const net = require("net");
const mysql = require("mysql2/promise");
const { Client } = require("pg");
const { decryptWhitelistSecret } = require("../utils/whitelistSecret");

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const QUERY_TIMEOUT_MS = 2500;
const CONNECT_TIMEOUT_MS = 1200;
const PORT_PROBE_MS = 300;
const PORT_CACHE_MS = 120_000;
const portProbeCache = new Map();
const cityPoolCache = new Map();

function isSafeSqlIdentifier(value) {
  return IDENTIFIER_RE.test(String(value || ""));
}

function quoteSqlIdentifier(engine, value) {
  const parts = String(value || "")
    .split(".")
    .map((part) => part.replace(/[`"]/g, "").trim())
    .filter(Boolean);
  if (!parts.length || parts.length > 2 || !parts.every(isSafeSqlIdentifier)) {
    throw new Error("Identificador SQL invalido.");
  }
  if (engine === "postgres") {
    return parts.map((part) => `"${part}"`).join(".");
  }
  return parts.map((part) => `\`${part}\``).join(".");
}

function normalizeMapping(value) {
  const record = value && typeof value === "object" ? value : {};
  const mapping = {
    playerTable: String(record.playerTable || "").trim(),
    playerIdColumn: String(record.playerIdColumn || "").trim(),
    whitelistColumn: String(record.whitelistColumn || "").trim(),
    valueType: String(record.valueType || "integer"),
    valueOff: String(record.valueOff ?? "0"),
    valueOn: String(record.valueOn ?? "1"),
    nullBehavior: "off",
    joinTable: String(record.joinTable || "").trim(),
    joinFromColumn: String(record.joinFromColumn || "").trim(),
    joinToColumn: String(record.joinToColumn || "").trim(),
    joinIdentifierColumn: String(record.joinIdentifierColumn || "").trim(),
  };
  return mapping;
}

function mappingUsesJoin(mapping) {
  return Boolean(
    mapping.joinTable &&
      mapping.joinFromColumn &&
      mapping.joinToColumn &&
      mapping.joinIdentifierColumn,
  );
}

function coerceValue(valueType, raw) {
  const text = String(raw ?? "").trim();
  if (valueType === "boolean") {
    const lowered = text.toLowerCase();
    if (["1", "true", "yes", "on", "approved", "active"].includes(lowered)) return true;
    if (["0", "false", "no", "off", "denied", "inactive", "pending", "null", ""].includes(lowered)) {
      return false;
    }
    return lowered;
  }
  if (valueType === "integer") {
    const parsed = Number(text);
    if (!Number.isFinite(parsed)) throw new Error("Valor incompativel com coluna numerica.");
    return Math.trunc(parsed);
  }
  return text;
}

function equivalent(valueType, left, right) {
  if (isWhitelistOffValue(left) && isWhitelistOffValue(right)) return true;
  if (valueType === "boolean") return Boolean(left) === Boolean(right);
  if (valueType === "integer") return Number(left) === Number(right);
  return String(left ?? "") === String(right ?? "");
}

function normalizeWhitelistValue(value) {
  if (value == null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (Buffer.isBuffer(value)) {
    if (value.length === 0) return null;
    if (value.length === 1) return value[0];
    return value.toString("utf8").trim();
  }
  const text = String(value).trim();
  if (!text || text === "[object Object]") return null;
  return text;
}

function isWhitelistOffValue(value) {
  const normalized = normalizeWhitelistValue(value);
  if (normalized == null) return true;
  if (normalized === false || normalized === 0) return true;
  const text = String(normalized).trim().toLowerCase();
  return (
    text === "" ||
    text === "0" ||
    text === "false" ||
    text === "off" ||
    text === "null" ||
    text === "undefined" ||
    text === "no"
  );
}

function isWhitelistOnValue(value) {
  const normalized = normalizeWhitelistValue(value);
  if (normalized == null) return false;
  if (normalized === true || normalized === 1) return true;
  const text = String(normalized).trim().toLowerCase();
  return text === "1" || text === "true" || text === "on" || text === "yes";
}

function classifyState(mapping, current) {
  const normalized = normalizeWhitelistValue(current);
  if (isWhitelistOnValue(normalized)) return "on";
  if (isWhitelistOffValue(normalized)) return "off";
  try {
    const onValue = coerceValue(mapping.valueType, mapping.valueOn);
    const offValue = coerceValue(mapping.valueType, mapping.valueOff);
    if (equivalent(mapping.valueType, normalized, onValue)) return "on";
    if (equivalent(mapping.valueType, normalized, offValue)) return "off";
  } catch {
    return "off";
  }
  return "off";
}

function buildSelectSql(engine, mapping) {
  const playerTable = quoteSqlIdentifier(engine, mapping.playerTable);
  const playerId = quoteSqlIdentifier(engine, mapping.playerIdColumn);
  const whitelist = quoteSqlIdentifier(engine, mapping.whitelistColumn);
  if (mappingUsesJoin(mapping)) {
    const joinTable = quoteSqlIdentifier(engine, mapping.joinTable);
    const joinFrom = quoteSqlIdentifier(engine, mapping.joinFromColumn);
    const joinTo = quoteSqlIdentifier(engine, mapping.joinToColumn);
    const joinId = quoteSqlIdentifier(engine, mapping.joinIdentifierColumn);
    return `SELECT ${playerTable}.${playerId} AS player_key, ${playerTable}.${whitelist} AS whitelist_value FROM ${playerTable} INNER JOIN ${joinTable} ON ${playerTable}.${joinFrom} = ${joinTable}.${joinTo} WHERE ${joinTable}.${joinId} = ? LIMIT 2`;
  }
  return `SELECT ${playerId} AS player_key, ${whitelist} AS whitelist_value FROM ${playerTable} WHERE ${playerId} = ? LIMIT 2`;
}

function buildUpdateSql(engine, mapping) {
  const playerTable = quoteSqlIdentifier(engine, mapping.playerTable);
  const playerId = quoteSqlIdentifier(engine, mapping.playerIdColumn);
  const whitelist = quoteSqlIdentifier(engine, mapping.whitelistColumn);
  return `UPDATE ${playerTable} SET ${whitelist} = ? WHERE ${playerId} = ?`;
}

function toPg(sql) {
  let index = 0;
  return sql.replace(/\?/g, () => `$${++index}`);
}

function rememberPortState(host, port, open) {
  portProbeCache.set(`${host}:${port}`, { open, at: Date.now() });
}

function probeCityPort(host, port) {
  const key = `${host}:${Number(port || 3306)}`;
  const cached = portProbeCache.get(key);
  if (cached && Date.now() - cached.at < PORT_CACHE_MS) {
    return Promise.resolve(cached.open);
  }
  return new Promise((resolve) => {
    const socket = net.connect({ host, port: Number(port || 3306), timeout: PORT_PROBE_MS });
    const finish = (open) => {
      socket.removeAllListeners();
      socket.destroy();
      rememberPortState(host, port, open);
      resolve(open);
    };
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function poolKey(target) {
  return `${target.engine}|${target.host}|${target.port}|${target.database}|${target.user}`;
}

function getMysqlPool(target) {
  const key = poolKey(target);
  const existing = cityPoolCache.get(key);
  if (existing) return existing;
  const pool = mysql.createPool({
    host: target.host,
    port: target.port,
    database: target.database,
    user: target.user,
    password: target.password,
    ssl: target.ssl ? { rejectUnauthorized: false } : undefined,
    connectTimeout: CONNECT_TIMEOUT_MS,
    connectionLimit: 4,
    maxIdle: 3,
    idleTimeout: 90_000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
  });
  cityPoolCache.set(key, pool);
  return pool;
}

async function withCityDatabase(target, fn) {
  if (target.engine === "postgres") {
    const client = new Client({
      host: target.host,
      port: target.port,
      database: target.database,
      user: target.user,
      password: target.password,
      ssl: target.ssl ? { rejectUnauthorized: false } : undefined,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      statement_timeout: QUERY_TIMEOUT_MS,
    });
    await client.connect();
    try {
      return await fn(async (sql, params = []) => {
        const result = await client.query(toPg(sql), params);
        return result.rows || [];
      });
    } finally {
      await client.end().catch(() => null);
    }
  }

  const pool = getMysqlPool(target);
  return fn(async (sql, params = []) => {
    const [rows] = await pool.execute(sql, params);
    return Array.isArray(rows) ? rows : [];
  });
}

function isUnusableCityHost(value) {
  const host = String(value || "").trim().toLowerCase();
  return (
    !host ||
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host.startsWith("127.") ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    host.startsWith("169.254.")
  );
}

function settingsToLauncherCityDb(settings, guildId) {
  const user = String(settings?.db_user || "").trim();
  const database = String(settings?.db_name || "").trim();
  if (!user || !database) return null;
  const password = decryptWhitelistSecret(settings?.db_password_cipher, guildId);
  return {
    engine: settings?.db_engine === "postgres" ? "postgres" : "mysql",
    host: "127.0.0.1",
    port: Number(settings?.db_port || 3306),
    database,
    user,
    password: password || "",
  };
}

function settingsToTarget(settings, guildId) {
  const host = !isUnusableCityHost(settings?.db_host)
    ? settings.db_host
    : settings?.agent_public_ip;
  if (!host || !settings?.db_name || !settings?.db_user) {
    throw new Error("Conexao do banco da cidade incompleta.");
  }
  if (isUnusableCityHost(host)) {
    throw new Error(
      "O host do banco ainda e local ou interno. Informe o IP publico da VPS no painel.",
    );
  }
  const password = decryptWhitelistSecret(settings.db_password_cipher, guildId);
  if (!password) throw new Error("Senha do banco nao configurada.");
  return {
    engine: settings.db_engine === "postgres" ? "postgres" : "mysql",
    host,
    port: Number(settings.db_port || 3306),
    database: settings.db_name,
    user: settings.db_user,
    password,
    ssl: settings.db_ssl === true,
  };
}

async function executeWhitelistOperation(settings, operation, identifierValue, options = {}) {
  const mapping = normalizeMapping(settings.mapping);
  if (!mapping.playerTable || !mapping.playerIdColumn || !mapping.whitelistColumn) {
    throw new Error("Configure a tabela e as colunas da whitelist no painel.");
  }
  let cityTarget = null;
  try {
    cityTarget = settingsToTarget(settings, settings.guild_id);
  } catch {
    cityTarget = null;
  }

  const launcherCityDb =
    settingsToLauncherCityDb(settings, settings.guild_id) ||
    (cityTarget
      ? {
          engine: cityTarget.engine,
          port: cityTarget.port,
          database: cityTarget.database,
          user: cityTarget.user,
          password: cityTarget.password,
        }
      : null);
  const launcherOpts = options.interactive ? { priority: "interactive" } : {};
  const mode = String(settings?.connection_mode || "direct").toLowerCase();

  if (mode === "agent" || mode === "launcher") {
    if (cityTarget && options.interactive) {
      return raceCityOperations(
        settings,
        mapping,
        operation,
        identifierValue,
        cityTarget,
        launcherCityDb,
        launcherOpts,
      );
    }
    return runViaLauncher(settings, operation, identifierValue, mapping, launcherCityDb, launcherOpts);
  }

  if (cityTarget) {
    return raceCityOperations(
      settings,
      mapping,
      operation,
      identifierValue,
      cityTarget,
      launcherCityDb,
      launcherOpts,
    );
  }

  return runViaLauncher(settings, operation, identifierValue, mapping, launcherCityDb, launcherOpts);
}

async function raceCityOperations(
  settings,
  mapping,
  operation,
  identifierValue,
  cityTarget,
  launcherCityDb,
  launcherOpts,
) {
  const launcherTask = runViaLauncher(
    settings,
    operation,
    identifierValue,
    mapping,
    launcherCityDb,
    launcherOpts,
  ).then((value) => {
    if (value?.ok === true || !isRetryableLauncherCode(value?.code)) return value;
    throw value;
  });

  const directTask = (async () => {
    const portOpen = await probeCityPort(cityTarget.host, cityTarget.port);
    if (!portOpen) {
      throw { ok: false, code: "port_closed", message: "Porta do banco fechada." };
    }
    try {
      return await runDirectWhitelistOperation(settings, mapping, operation, identifierValue);
    } catch (error) {
      const sanitized = sanitizeCityDbError(error);
      if (sanitized.code !== "offline" && sanitized.code !== "timeout") {
        throw { ok: false, ...sanitized };
      }
      rememberPortState(cityTarget.host, cityTarget.port, false);
      throw { ok: false, ...sanitized };
    }
  })();

  try {
    return await Promise.any([directTask, launcherTask]);
  } catch (aggregate) {
    const errors = Array.isArray(aggregate?.errors) ? aggregate.errors : [];
    const meaningful =
      errors.find((item) => item && typeof item === "object" && item.code && item.code !== "port_closed") ||
      errors.find((item) => item && typeof item === "object" && item.code === "player_not_found") ||
      errors[0];
    if (meaningful && typeof meaningful === "object") return meaningful;
    return {
      ok: false,
      code: "offline",
      message: "Nao foi possivel conectar ao banco da cidade agora.",
    };
  }
}

async function runViaLauncher(settings, operation, identifierValue, mapping, cityDb, options = {}) {
  const db = require("./whitelistDbService");
  const fast = options.priority === "interactive";
  const attempts = fast ? 2 : 3;
  const timeouts = fast ? [3500, 5500] : [9000, 14000, 14000];
  const pollMs = fast ? 15 : 50;
  let last = {
    ok: false,
    code: "offline",
    message: "Nao foi possivel enfileirar o SQL no launcher da VPS.",
  };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const queued = await db.enqueueAgentJob({
      guild_id: settings.guild_id,
      operation,
      payload: {
        identifierValue,
        mapping,
        cityDb: cityDb || undefined,
      },
    });
    if (!queued?.id) {
      await sleep(fast ? 150 * attempt : 300 * attempt);
      continue;
    }
    const finished = await db.waitForAgentJob(
      queued.id,
      timeouts[Math.min(attempt - 1, timeouts.length - 1)],
      pollMs,
    );
    if (finished.status !== "done") {
      last = {
        ok: false,
        code: "vps_timeout",
        message:
          finished.error_message ||
          "O launcher na VPS ainda esta sincronizando o banco. O pedido continua aberto.",
      };
      await sleep(fast ? 200 * attempt : 400 * attempt);
      continue;
    }
    const result = finished.result && typeof finished.result === "object" ? finished.result : {};
    if (result.ok === false) {
      last = {
        ok: false,
        code: result.code || "db_error",
        message: result.message || "Falha no MySQL da VPS.",
        playerKey: result.playerKey,
        previousValue: result.previousValue,
        nextValue: result.nextValue,
      };
      if (!isRetryableLauncherCode(last.code)) return last;
      await sleep(fast ? 200 * attempt : 400 * attempt);
      continue;
    }
    return {
      ok: true,
      code: result.code || "ok",
      skipped: result.skipped === true,
      changed: result.changed === true,
      playerKey: result.playerKey,
      previousValue: result.previousValue ?? null,
      nextValue: result.nextValue ?? result.currentValue ?? null,
      currentValue: result.currentValue ?? null,
      state: result.state,
    };
  }
  return last;
}

function isRetryableLauncherCode(code) {
  return [
    "offline",
    "timeout",
    "vps_timeout",
    "missing_credentials",
    "invalid_credentials",
  ].includes(String(code || ""));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runDirectWhitelistOperation(settings, mapping, operation, identifierValue) {
  const target = settingsToTarget(settings, settings.guild_id);
  const selectSql = buildSelectSql(target.engine, mapping);
  const updateSql = buildUpdateSql(target.engine, mapping);
  return withCityDatabase(target, async (query) => {
    const rows = await query(selectSql, [identifierValue]);
    if (rows.length > 1) {
      return { ok: false, code: "multiple_players", message: "Mais de um jogador encontrado." };
    }
    if (!rows.length) {
      return { ok: false, code: "player_not_found", message: "Jogador nao encontrado no banco da cidade." };
    }

    const current = rows[0].whitelist_value;
    const playerKey = String(rows[0].player_key ?? "");
    const state = classifyState(mapping, current);

    if (operation === "GET_PLAYER" || operation === "CHECK_WHITELIST" || operation === "TEST_MAPPING") {
      return {
        ok: true,
        code: "ok",
        playerKey,
        currentValue: current == null ? null : String(current),
        state,
      };
    }

    const approve = operation === "APPROVE_WHITELIST";
    if ((approve && state === "on") || (!approve && state === "off")) {
      return {
        ok: true,
        skipped: true,
        changed: false,
        code: "already_applied",
        playerKey,
        previousValue: current == null ? null : String(current),
        nextValue: current == null ? null : String(current),
        state,
      };
    }

    const desired = coerceValue(mapping.valueType, approve ? mapping.valueOn : mapping.valueOff);
    await query(updateSql, [desired, playerKey]);
    const nextState = classifyState(mapping, desired);
    return {
      ok: true,
      skipped: false,
      changed: true,
      code: "applied",
      playerKey,
      previousValue: current == null ? null : String(current),
      nextValue: String(desired),
      state: nextState,
    };
  });
}

function mappingFingerprint(mapping) {
  const normalized = normalizeMapping(mapping);
  return [
    normalized.playerTable,
    normalized.playerIdColumn,
    normalized.whitelistColumn,
    normalized.valueType,
    normalized.valueOff,
    normalized.valueOn,
    normalized.nullBehavior,
    normalized.joinTable,
    normalized.joinFromColumn,
    normalized.joinToColumn,
    normalized.joinIdentifierColumn,
  ].join("|");
}

function sanitizeCityDbError(error) {
  const message = String(error?.message || "").toLowerCase();
  if (message.includes("timeout")) return { code: "timeout", message: "Banco da cidade nao respondeu a tempo." };
  if (message.includes("access denied") || message.includes("password") || message.includes("auth")) {
    return { code: "invalid_credentials", message: "Credencial do banco invalida." };
  }
  if (message.includes("econnrefused") || message.includes("enotfound") || message.includes("etimedout")) {
    return {
      code: "offline",
      message: "A Flowdesk nao alcanca o IP publico do banco. Liberar a porta na VPS e bind-address 0.0.0.0.",
    };
  }
  return { code: "db_error", message: "Falha ao sincronizar a whitelist com o banco da cidade." };
}

module.exports = {
  executeWhitelistOperation,
  sanitizeCityDbError,
  normalizeMapping,
  mappingFingerprint,
};
