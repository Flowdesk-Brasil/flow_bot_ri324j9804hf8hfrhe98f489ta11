const mysql = require("mysql2/promise");
const { Client } = require("pg");
const { decryptWhitelistSecret } = require("../utils/whitelistSecret");

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const QUERY_TIMEOUT_MS = 12000;
const CONNECT_TIMEOUT_MS = 12000;

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
    nullBehavior: String(record.nullBehavior || "off"),
    joinTable: String(record.joinTable || "").trim(),
    joinFromColumn: String(record.joinFromColumn || "").trim(),
    joinToColumn: String(record.joinToColumn || "").trim(),
    joinIdentifierColumn: String(record.joinIdentifierColumn || "").trim(),
  };
  if (mapping.playerTable && mapping.playerIdColumn && mapping.whitelistColumn) {
    return mapping;
  }
  return {
    playerTable: "vrp_users",
    playerIdColumn: "id",
    whitelistColumn: "whitelisted",
    valueType: "integer",
    valueOff: "0",
    valueOn: "1",
    nullBehavior: "off",
    joinTable: "",
    joinFromColumn: "",
    joinToColumn: "",
    joinIdentifierColumn: "",
  };
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
  if (left == null && right == null) return true;
  if (valueType === "boolean") return Boolean(left) === Boolean(right);
  if (valueType === "integer") return Number(left) === Number(right);
  return String(left ?? "") === String(right ?? "");
}

function classifyState(mapping, current) {
  if (current == null) {
    return mapping.nullBehavior === "unknown" ? "unknown" : mapping.nullBehavior;
  }
  try {
    const onValue = coerceValue(mapping.valueType, mapping.valueOn);
    const offValue = coerceValue(mapping.valueType, mapping.valueOff);
    if (equivalent(mapping.valueType, current, onValue)) return "on";
    if (equivalent(mapping.valueType, current, offValue)) return "off";
  } catch {
    return "unknown";
  }
  return "unknown";
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

  const connection = await mysql.createConnection({
    host: target.host,
    port: target.port,
    database: target.database,
    user: target.user,
    password: target.password,
    ssl: target.ssl ? { rejectUnauthorized: false } : undefined,
    connectTimeout: CONNECT_TIMEOUT_MS,
  });
  try {
    return await fn(async (sql, params = []) => {
      const [rows] = await connection.execute(sql, params);
      return Array.isArray(rows) ? rows : [];
    });
  } finally {
    await connection.end().catch(() => null);
  }
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

async function executeWhitelistOperation(settings, operation, identifierValue) {
  const mapping = normalizeMapping(settings.mapping);
  let cityTarget = null;
  try {
    cityTarget = settingsToTarget(settings, settings.guild_id);
  } catch {
    cityTarget = null;
  }
  try {
    return await runDirectWhitelistOperation(settings, mapping, operation, identifierValue);
  } catch (error) {
    const sanitized = sanitizeCityDbError(error);
    if (sanitized.code !== "offline" && sanitized.code !== "timeout") {
      throw error;
    }
    const queued = await require("./whitelistDbService").enqueueAgentJob({
      guild_id: settings.guild_id,
      operation,
      payload: {
        identifierValue,
        mapping,
        cityDb: cityTarget
          ? {
              engine: cityTarget.engine,
              port: cityTarget.port,
              database: cityTarget.database,
              user: cityTarget.user,
              password: cityTarget.password,
            }
          : undefined,
      },
    });
    if (!queued?.id) {
      return { ok: false, ...sanitized };
    }
    const finished = await require("./whitelistDbService").waitForAgentJob(queued.id, 28000);
    if (finished.status !== "done") {
      return {
        ok: false,
        code: "vps_timeout",
        message:
          finished.error_message ||
          "O launcher na VPS nao concluiu a tempo. Deixe o app aberto na maquina da cidade.",
      };
    }
    const result = finished.result && typeof finished.result === "object" ? finished.result : {};
    if (result.ok === false) {
      return {
        ok: false,
        code: result.code || "db_error",
        message: result.message || "Falha no MySQL da VPS.",
        playerKey: result.playerKey,
        previousValue: result.previousValue,
        nextValue: result.nextValue,
      };
    }
    return {
      ok: true,
      code: result.code || "ok",
      skipped: result.skipped === true,
      playerKey: result.playerKey,
      previousValue: result.previousValue ?? null,
      nextValue: result.nextValue ?? result.currentValue ?? null,
      currentValue: result.currentValue ?? null,
      state: result.state,
    };
  }
}

async function runDirectWhitelistOperation(settings, mapping, operation, identifierValue) {
  const target = settingsToTarget(settings, settings.guild_id);
  const selectSql = buildSelectSql(target.engine, mapping);
  const rows = await withCityDatabase(target, (query) => query(selectSql, [identifierValue]));

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
      code: "already_applied",
      playerKey,
      previousValue: current == null ? null : String(current),
      nextValue: current == null ? null : String(current),
      state,
    };
  }

  const desired = coerceValue(mapping.valueType, approve ? mapping.valueOn : mapping.valueOff);
  const updateSql = buildUpdateSql(target.engine, mapping);
  await withCityDatabase(target, (query) => query(updateSql, [desired, playerKey]));
  const confirmRows = await withCityDatabase(target, (query) =>
    query(selectSql, [identifierValue]),
  );
  const next = confirmRows[0]?.whitelist_value;
  return {
    ok: true,
    skipped: false,
    code: "ok",
    playerKey,
    previousValue: current == null ? null : String(current),
    nextValue: next == null ? null : String(next),
    state: classifyState(mapping, next),
  };
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
