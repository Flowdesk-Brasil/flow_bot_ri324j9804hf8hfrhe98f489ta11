const mysql = require("mysql2/promise");
const { Client } = require("pg");

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const CONNECT_TIMEOUT_MS = 8000;
const QUERY_TIMEOUT_MS = 8000;

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
  return {
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

function sanitizeError(error) {
  const message = String(error?.message || "Falha no banco local.");
  const lowered = message.toLowerCase();
  if (lowered.includes("timeout")) return { code: "timeout", message: "Banco local nao respondeu a tempo." };
  if (lowered.includes("access denied") || lowered.includes("password") || lowered.includes("auth")) {
    return { code: "invalid_credentials", message: "Usuario ou senha do banco local invalidos." };
  }
  if (lowered.includes("econnrefused") || lowered.includes("enotfound")) {
    return { code: "offline", message: "Nao foi possivel conectar em 127.0.0.1 / host local do banco." };
  }
  return { code: "db_error", message: "Falha ao executar a operacao no banco local." };
}

async function inspectSchema(target) {
  const columns = await withCityDatabase(target, async (query) => {
    if (target.engine === "postgres") {
      return query(
        `SELECT table_name AS table, column_name AS column, data_type AS data_type
         FROM information_schema.columns WHERE table_schema = 'public'
         ORDER BY table_name, ordinal_position`,
      );
    }
    return query(
      `SELECT TABLE_NAME AS \`table\`, COLUMN_NAME AS \`column\`, DATA_TYPE AS data_type
       FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION`,
      [target.database],
    );
  });
  const normalized = columns.map((row) => ({
    table: String(row.table || row.TABLE || ""),
    column: String(row.column || row.COLUMN || ""),
    dataType: String(row.data_type || row.DATA_TYPE || ""),
  }));
  return {
    ok: true,
    tables: Array.from(new Set(normalized.map((item) => item.table))).slice(0, 200),
    columns: normalized.slice(0, 400),
  };
}

async function executeJob(target, operation, payload) {
  const started = Date.now();
  if (operation === "TEST_CONNECTION" || operation === "HEALTH_CHECK") {
    await withCityDatabase(target, (query) => query("SELECT 1 AS ok"));
    return { ok: true, latencyMs: Date.now() - started };
  }
  if (operation === "INSPECT_SCHEMA") {
    const inspected = await inspectSchema(target);
    return { ...inspected, latencyMs: Date.now() - started };
  }

  const mapping = normalizeMapping(payload?.mapping);
  const identifierValue = String(payload?.identifierValue || "").trim();
  if (!identifierValue) {
    return { ok: false, code: "missing_identifier", message: "Identificador ausente." };
  }
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
  if (
    operation === "GET_PLAYER" ||
    operation === "CHECK_WHITELIST" ||
    operation === "TEST_MAPPING"
  ) {
    return {
      ok: true,
      playerKey,
      currentValue: current == null ? null : String(current),
      state,
      latencyMs: Date.now() - started,
    };
  }

  const approve = operation === "APPROVE_WHITELIST";
  if ((approve && state === "on") || (!approve && state === "off")) {
    return {
      ok: true,
      skipped: true,
      playerKey,
      previousValue: current == null ? null : String(current),
      nextValue: current == null ? null : String(current),
      state,
    };
  }
  const desired = coerceValue(mapping.valueType, approve ? mapping.valueOn : mapping.valueOff);
  const updateSql = buildUpdateSql(target.engine, mapping);
  await withCityDatabase(target, (query) => query(updateSql, [desired, playerKey]));
  const confirmRows = await withCityDatabase(target, (query) => query(selectSql, [identifierValue]));
  const next = confirmRows[0]?.whitelist_value;
  return {
    ok: true,
    skipped: false,
    playerKey,
    previousValue: current == null ? null : String(current),
    nextValue: next == null ? null : String(next),
    state: classifyState(mapping, next),
  };
}

module.exports = {
  executeJob,
  sanitizeError,
};
