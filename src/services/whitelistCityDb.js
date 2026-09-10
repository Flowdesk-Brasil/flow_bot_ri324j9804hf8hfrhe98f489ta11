const net = require("net");
const { decryptWhitelistSecret } = require("../utils/whitelistSecret");
const {
  executeWithCityDb,
  healthCheckCityDb,
  healthCheckActivePools,
  classifyDbError,
  logCityDb,
} = require("./cityDbRuntime");
const { explainCityDbFailure } = require("./cityDbErrors");

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PORT_PROBE_MS = 300;
const PORT_CACHE_MS = 120_000;
const portProbeCache = new Map();

function decorateCityFailure(result) {
  const { uniqueNotice } = require("./cityDbErrors");
  const issue = explainCityDbFailure({
    code: result?.code,
    message: result?.message || result?.title || "O banco da cidade nao esta online.",
    hint: result?.hint,
    cause: result?.cause,
    sqlMessage: result?.sqlMessage,
  });
  const rawMessage =
    result?.message && !/catch|undefined/i.test(String(result.message))
      ? result.message
      : issue.message;
  const hint = result?.hint || issue.hint;
  return {
    ok: false,
    ...result,
    code: result?.code || issue.code,
    title: result?.title || issue.title,
    message: uniqueNotice(rawMessage, ""),
    hint,
  };
}

function identifierCandidates(value) {
  const raw = String(value ?? "").trim();
  const out = [];
  const add = (item) => {
    if (item === 0 || item) {
      const key = typeof item === "number" ? `n:${item}` : `s:${item}`;
      if (!out.some((entry) => entry.key === key)) {
        out.push({ key, value: item });
      }
    }
  };
  add(raw);
  const stripped = raw.replace(/^(license2?:|steam:|discord:|fivem:|live:|xbl:|char\d+:)/i, "");
  add(stripped);
  if (/^\d{1,18}$/.test(stripped)) {
    add(Number(stripped));
    add(String(Number(stripped)));
  }
  if (/^[a-f0-9]{32,80}$/i.test(stripped)) {
    add(`license:${stripped}`);
    add(`license2:${stripped}`);
  }
  return out.map((entry) => entry.value);
}

async function readLauncherHint(guildId) {
  try {
    const db = require("./whitelistDbService");
    if (typeof db.getLauncherConnectivityHint !== "function") {
      return { online: false, reason: "missing" };
    }
    return await db.getLauncherConnectivityHint(guildId);
  } catch {
    return { online: false, reason: "unknown" };
  }
}

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

async function withCityDatabase(target, fn, options = {}) {
  return executeWithCityDb(target, async ({ query, withTransaction }) => fn(query, withTransaction), options);
}

function isUnusableCityHost(value) {
  const host = String(value || "").trim().toLowerCase();
  if (
    !host ||
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "0.0.0.0" ||
    host === "::1" ||
    host.startsWith("127.") ||
    host.startsWith("10.") ||
    host.startsWith("192.168.") ||
    host.startsWith("169.254.")
  ) {
    return true;
  }
  const private172 = host.match(/^172\.(\d+)\./);
  if (private172) {
    const second = Number(private172[1]);
    return second >= 16 && second <= 31;
  }
  return false;
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
  const host = settings?.db_host;
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
  } catch (error) {
    cityTarget = null;
    logCityDb("warn", "direct_target_unavailable", {
      guildId: settings.guild_id,
      operation,
      message: error instanceof Error ? error.message : String(error),
    });
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

  if (launcherCityDb) {
    const hint = await readLauncherHint(settings.guild_id);
    if (hint?.online) {
      logCityDb("info", "whitelist_launcher_local", {
        guildId: settings.guild_id,
        operation,
      });
      try {
        const viaLauncher = await runViaLauncher(
          settings,
          operation,
          identifierValue,
          mapping,
          launcherCityDb,
          launcherOpts,
        );
        if (viaLauncher?.ok || !isRetryableLauncherCode(viaLauncher?.code)) {
          return viaLauncher?.ok ? normalizeWhitelistResult(viaLauncher) : decorateCityFailure(viaLauncher);
        }
      } catch (error) {
        logCityDb("warn", "whitelist_launcher_error", {
          guildId: settings.guild_id,
          operation,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  if (cityTarget) {
    try {
      const direct = await runDirectWhitelistOperation(settings, mapping, operation, identifierValue, {
        interactive: Boolean(options.interactive),
      });
      if (direct?.ok) {
        return normalizeWhitelistResult(direct);
      }
      if (direct?.code === "player_not_found" || direct?.code === "multiple_players") {
        return normalizeWhitelistResult(direct);
      }
      if (direct && !isRetryableLauncherCode(direct.code)) {
        return decorateCityFailure(direct);
      }
    } catch (error) {
      const sanitized = sanitizeCityDbError(error);
      if (!isRetryableLauncherCode(sanitized.code)) {
        return decorateCityFailure(sanitized);
      }
    }
  }

  return {
    ok: false,
    code: "city_deferred",
    title: "Sync do jogo pendente",
    message: "A whitelist do Discord segue. A sync do jogo espera o launcher na VPS, que sobe com o Windows e liga o MySQL local.",
    hint: "Deixe o launcher na bandeja. Ele fala com o XAMPP em localhost e nao precisa abrir a porta 3306.",
  };
}

function inferWhitelistChanged(result) {
  if (!result?.ok) return false;
  if (result.changed === true || result.code === "applied") return true;

  const previous = result.previousValue;
  const next = result.nextValue ?? result.currentValue;
  if (isWhitelistOffValue(previous) && isWhitelistOnValue(next)) return true;
  if (isWhitelistOnValue(previous) && isWhitelistOffValue(next)) return true;
  if (previous != null && next != null && String(previous) !== String(next)) return true;

  if (result.changed === false || result.skipped === true || result.code === "already_applied") {
    return false;
  }

  if (result.skipped === false && result.state === "on" && isWhitelistOffValue(previous)) {
    return true;
  }
  if (result.skipped === false && result.state === "off" && isWhitelistOnValue(previous)) {
    return true;
  }

  if (previous == null && next == null) return false;
  return false;
}

function normalizeWhitelistResult(result) {
  if (!result || typeof result !== "object") return result;
  const code = String(result.code || "");
  if (result.ok === false || result.deferred === true || code === "city_deferred" || code === "player_not_found") {
    return {
      ...result,
      changed: false,
      code: code || result.code || "error",
    };
  }
  const changed = inferWhitelistChanged(result);
  const alreadyApplied = result.skipped === true || code === "already_applied";
  return {
    ...result,
    changed,
    skipped: changed ? false : alreadyApplied,
    code: changed ? "applied" : alreadyApplied ? "already_applied" : code || "ok",
  };
}

function pickBestWhitelistResult(results) {
  const list = (Array.isArray(results) ? results : []).filter(
    (item) => item && typeof item === "object",
  );
  const notFound = list.find((item) => item.code === "player_not_found");
  if (notFound) return normalizeWhitelistResult(notFound);

  const successes = list.filter((item) => item.ok === true).map(normalizeWhitelistResult);
  if (successes.length) {
    return (
      successes.find((item) => item.changed === true) ||
      successes.find((item) => item.code === "applied") ||
      successes.find((item) => !item.skipped && item.code !== "already_applied") ||
      successes[0]
    );
  }

  const failure =
    list.find((item) => item.code && item.code !== "port_closed") ||
    list.find((item) => item.ok === false) ||
    null;
  if (failure) return decorateCityFailure(failure);
  return decorateCityFailure({
    ok: false,
    code: "offline",
    message: "O banco da cidade nao esta online agora.",
  });
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
  const interactive = launcherOpts?.priority === "interactive";
  const launcherTask = runViaLauncher(
    settings,
    operation,
    identifierValue,
    mapping,
    launcherCityDb,
    launcherOpts,
  );

  const directTask = (async () => {
    const portOpen = await probeCityPort(cityTarget.host, cityTarget.port);
    if (!portOpen) {
      return { ok: false, code: "port_closed", message: "Porta do banco fechada." };
    }
    try {
      return await runDirectWhitelistOperation(settings, mapping, operation, identifierValue, {
        interactive: Boolean(interactive),
      });
    } catch (error) {
      const sanitized = sanitizeCityDbError(error);
      if (sanitized.code !== "offline" && sanitized.code !== "timeout") {
        return { ok: false, ...sanitized };
      }
      rememberPortState(cityTarget.host, cityTarget.port, false);
      return { ok: false, ...sanitized };
    }
  })();

  if (interactive) {
    const direct = await directTask;
    if (direct?.ok === true) {
      return normalizeWhitelistResult(direct);
    }
    const launcher = await launcherTask;
    return pickBestWhitelistResult([direct, launcher]);
  }

  const settled = await Promise.allSettled([directTask, launcherTask]);
  const values = settled.map((entry) => (entry.status === "fulfilled" ? entry.value : entry.reason));
  return pickBestWhitelistResult(values);
}

function buildLauncherWaitMessage(hint) {
  if (!hint?.online) {
    if (hint?.reason === "missing") {
      return "O launcher nao esta vinculado. Instale o Setup na VPS; ele abre com o Windows e fica no ar sozinho.";
    }
    return "O launcher na VPS esta offline. Ele precisa ficar aberto; depois de instalar, sobe com o Windows e corrige o MySQL.";
  }
  return "O launcher recebeu a tarefa e esta sincronizando o MySQL local.";
}

async function runViaLauncher(settings, operation, identifierValue, mapping, cityDb, options = {}) {
  const db = require("./whitelistDbService");
  const fast = options.priority === "interactive";
  const attempts = fast ? 3 : 3;
  const timeouts = fast ? [8000, 12000, 16000] : [9000, 14000, 18000];
  const pollMs = fast ? 20 : 50;
  const waitOpts = fast
    ? { extendIfClaimed: true, extendMs: 14000, maxTotalMs: 28000 }
    : { extendIfClaimed: true, extendMs: 10000, maxTotalMs: 24000 };
  let last = {
    ok: false,
    code: "offline",
    message: "Nao foi possivel enfileirar o SQL no launcher da VPS.",
  };

  await db.requeueStaleAgentJobs(settings.guild_id, fast ? 25000 : 90000);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await db.requeueStaleAgentJobs(settings.guild_id, fast ? 20000 : 60000);

    let jobId = null;
    const pending = await db.findPendingAgentJob(settings.guild_id, operation, identifierValue);
    if (pending?.id) {
      jobId = pending.id;
    } else {
      const queued = await db.enqueueAgentJob({
        guild_id: settings.guild_id,
        operation,
        payload: {
          identifierValue,
          mapping,
          cityDb: cityDb || undefined,
        },
      });
      jobId = queued?.id || null;
    }

    if (!jobId) {
      await sleep(fast ? 200 * attempt : 400 * attempt);
      continue;
    }

    const finished = await db.waitForAgentJob(
      jobId,
      timeouts[Math.min(attempt - 1, timeouts.length - 1)],
      pollMs,
      waitOpts,
    );

    if (finished.status !== "done") {
      const hint = await readLauncherHint(settings.guild_id);
      last = decorateCityFailure({
        ok: false,
        code: finished.status === "timeout" ? "vps_timeout" : "offline",
        message:
          finished.error_message ||
          buildLauncherWaitMessage(hint),
      });
      if (finished.status === "timeout") {
        await db.requeueStaleAgentJobs(settings.guild_id, fast ? 15000 : 45000);
      }
      await sleep(fast ? 350 * attempt : 600 * attempt);
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
    return normalizeWhitelistResult({
      ok: true,
      code: result.code || "ok",
      skipped: result.skipped === true,
      playerKey: result.playerKey,
      previousValue: result.previousValue ?? null,
      nextValue: result.nextValue ?? result.currentValue ?? null,
      currentValue: result.currentValue ?? null,
      state: result.state,
    });
  }
  return last;
}

function isRetryableLauncherCode(code) {
  return [
    "offline",
    "timeout",
    "vps_timeout",
    "pool_exhausted",
    "circuit_open",
    "missing_credentials",
    "invalid_credentials",
  ].includes(String(code || ""));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runDirectWhitelistOperation(
  settings,
  mapping,
  operation,
  identifierValue,
  runtimeOptions = {},
) {
  const target = settingsToTarget(settings, settings.guild_id);
  const selectSql = buildSelectSql(target.engine, mapping);
  const updateSql = buildUpdateSql(target.engine, mapping);
  const dbOptions = { interactive: runtimeOptions.interactive === true };

  return withCityDatabase(
    target,
    async (query, withTransaction) => {
      const readAndMaybeWrite = async (runQuery) => {
        let rows = [];
        for (const candidate of identifierCandidates(identifierValue)) {
          rows = await runQuery(selectSql, [candidate]);
          if (rows.length) break;
        }
        if (rows.length > 1) {
          return { ok: false, code: "multiple_players", message: "Mais de um jogador encontrado." };
        }
        if (!rows.length) {
          return {
            ok: false,
            code: "player_not_found",
            message: "Jogador nao encontrado no banco da cidade.",
          };
        }

        const current = rows[0].whitelist_value;
        const playerKeyRaw = rows[0].player_key;
        const playerKey = String(playerKeyRaw ?? "");
        const state = classifyState(mapping, current);

        if (
          operation === "GET_PLAYER" ||
          operation === "CHECK_WHITELIST" ||
          operation === "TEST_MAPPING"
        ) {
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
          return normalizeWhitelistResult({
            ok: true,
            skipped: true,
            changed: false,
            code: "already_applied",
            playerKey,
            previousValue: current == null ? null : String(current),
            nextValue: current == null ? null : String(current),
            state,
          });
        }

        const desired = coerceValue(mapping.valueType, approve ? mapping.valueOn : mapping.valueOff);
        await runQuery(updateSql, [desired, playerKeyRaw ?? playerKey]);
        const nextState = classifyState(mapping, desired);
        return normalizeWhitelistResult({
          ok: true,
          skipped: false,
          changed: true,
          code: "applied",
          playerKey,
          previousValue: current == null ? null : String(current),
          nextValue: String(desired),
          state: nextState,
        });
      };

      const mutating =
        operation === "APPROVE_WHITELIST" || operation === "REMOVE_WHITELIST";
      if (mutating && typeof withTransaction === "function") {
        return withTransaction(readAndMaybeWrite);
      }
      return readAndMaybeWrite(query);
    },
    dbOptions,
  );
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
  const classified = classifyDbError(error);
  const issue = explainCityDbFailure(error);
  return {
    code: classified.code || issue.code,
    title: classified.title || issue.title,
    message: classified.message || issue.message,
    hint: classified.hint || issue.hint,
  };
}

module.exports = {
  executeWhitelistOperation,
  sanitizeCityDbError,
  normalizeMapping,
  mappingFingerprint,
  inferWhitelistChanged,
  normalizeWhitelistResult,
  healthCheckCityDb,
  healthCheckActivePools,
};
