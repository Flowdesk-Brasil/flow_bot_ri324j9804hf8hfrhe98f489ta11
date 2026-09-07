const { Client } = require("pg");
const { connectCityMysql, releaseCityMysql } = require("./cityMysql");

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

function safeDatabaseName(value) {
  return String(value || "").replace(/[`\\]/g, "");
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

  const connection = await connectCityMysql(target);
  try {
    return await fn(async (sql, params = []) => {
      const [rows] = await connection.query(sql, params);
      return Array.isArray(rows) ? rows : [];
    });
  } finally {
    await releaseCityMysql(connection);
  }
}

function sanitizeError(error) {
  const message = String(error?.message || "Falha no MySQL da VPS.");
  const lowered = message.toLowerCase();
  if (error?.code === "missing_credentials" || lowered.includes("nao chegaram no launcher")) {
    return {
      code: "missing_credentials",
      message: "Usuario e senha do MySQL nao chegaram no launcher. Digite no painel e clique em Conectar banco.",
    };
  }
  if (lowered.includes("unknown database")) {
    return { code: "unknown_database", message: "O nome do banco nao existe neste MySQL. Confira o campo Nome do banco." };
  }
  if (lowered.includes("timeout") || lowered.includes("etimedout")) {
    return { code: "timeout", message: "O MySQL desta VPS nao respondeu. Confira se o servico esta no ar." };
  }
  if (lowered.includes("plugin") || lowered.includes("caching_sha2") || lowered.includes("not supported auth")) {
    return {
      code: "auth_plugin",
      message: "O MySQL recusou o plugin de autenticacao. No HeidiSQL, altere o usuario para mysql_native_password.",
    };
  }
  if (error?.errno === 1045 || lowered.includes("access denied") || lowered.includes("er_access_denied")) {
    const who = message.match(/['`]([^'`]+)['`]@['`]([^'`]+)['`]/);
    const account = who ? `${who[1]}@${who[2]}` : "usuario@localhost";
    return {
      code: "invalid_credentials",
      message: `MariaDB recusou ${account}. Rode o SQL do painel (usuariodeteste / 12345) na aba Consulta do HeidiSQL, como root.`,
    };
  }
  if (lowered.includes("econnrefused") || lowered.includes("enotfound") || lowered.includes("ehostunreach")) {
    return {
      code: "offline",
      message: "MySQL fechado nesta VPS. O launcher vai abrir o script de portas. Confira se o servico MySQL esta iniciado.",
    };
  }
  if (lowered.includes("not allowed to connect") || lowered.includes("host is blocked")) {
    return { code: "ip_not_allowed", message: "O usuario do MySQL nao aceita conexao local. Libere usuario@localhost." };
  }
  const short = message.replace(/\s+/g, " ").slice(0, 160);
  return { code: "db_error", message: short || "Falha ao falar com o MySQL desta VPS." };
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
  const inferred = normalized.some(
    (item) => item.table.toLowerCase() === "vrp_users" && item.column.toLowerCase() === "whitelisted",
  )
    ? {
        mapping: {
          playerTable: "vrp_users",
          playerIdColumn: "id",
          whitelistColumn: "whitelisted",
          valueType: "integer",
          valueOff: "0",
          valueOn: "1",
          nullBehavior: "off",
        },
        confidence: 96,
        notes: ["Framework vRP detectado: vrp_users.whitelisted (NULL vira 1)."],
      }
    : null;
  return {
    ok: true,
    tables: Array.from(new Set(normalized.map((item) => item.table))).slice(0, 200),
    columns: normalized.slice(0, 400),
    inferred,
  };
}

async function executeJob(target, operation, payload) {
  const started = Date.now();
  if (operation === "TEST_CONNECTION" || operation === "HEALTH_CHECK") {
    const probe = await withCityDatabase(target, async (query) => {
      await query("SELECT 1 AS ok");
      try {
        const tables = await query(
          "SELECT TABLE_NAME AS name FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'vrp_users' LIMIT 1",
        );
        return { hasVrpUsers: Array.isArray(tables) && tables.length > 0 };
      } catch {
        return { hasVrpUsers: false };
      }
    });
    return {
      ok: true,
      latencyMs: Date.now() - started,
      hasVrpUsers: probe.hasVrpUsers === true,
    };
  }
  if (operation === "INSPECT_SCHEMA") {
    const inspected = await inspectSchema(target);
    return { ...inspected, latencyMs: Date.now() - started };
  }

  const mapping = normalizeMapping(payload?.mapping);
  const identifierValue = String(payload?.identifierValue || "").trim();
  if (!identifierValue && operation === "TEST_MAPPING") {
    const playerTable = quoteSqlIdentifier(target.engine, mapping.playerTable);
    const playerId = quoteSqlIdentifier(target.engine, mapping.playerIdColumn);
    const whitelist = quoteSqlIdentifier(target.engine, mapping.whitelistColumn);
    const sample = await withCityDatabase(target, (query) =>
      query(
        `SELECT ${playerId} AS player_key, ${whitelist} AS whitelist_value FROM ${playerTable} LIMIT 1`,
      ),
    );
    const current = sample[0]?.whitelist_value;
    return {
      ok: true,
      playerKey: sample[0] ? String(sample[0].player_key ?? "") : "",
      currentValue: current == null ? null : String(current),
      state: sample[0] ? classifyState(mapping, current) : "unknown",
      latencyMs: Date.now() - started,
      message: sample[0]
        ? "Mapping validado. Registro de amostra lido sem alterar dados."
        : "Tabela e colunas existem. Ainda nao ha jogadores para amostrar.",
    };
  }
  if (!identifierValue) {
    return { ok: false, code: "missing_identifier", message: "Identificador ausente." };
  }
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
    await query(updateSql, [desired, playerKey]);
    const confirmRows = await query(selectSql, [identifierValue]);
    const next = confirmRows[0]?.whitelist_value;
    return {
      ok: true,
      skipped: false,
      playerKey,
      previousValue: current == null ? null : String(current),
      nextValue: next == null ? null : String(next),
      state: classifyState(mapping, next),
    };
  });
}

module.exports = {
  executeJob,
  sanitizeError,
};
