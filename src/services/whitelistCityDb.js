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
const PORT_PROBE_MS = 250;
const PORT_CACHE_MS = 120_000;
const HINT_CACHE_MS = 2_500;
const ROUTE_AFFINITY_MS = 10 * 60_000;
const portProbeCache = new Map();
const launcherHintCache = new Map();
const routeAffinity = new Map();

function rememberRoute(guildId, via) {
  if (!guildId || !via) return;
  routeAffinity.set(String(guildId), { via, at: Date.now() });
}

function preferredRoute(guildId) {
  const row = routeAffinity.get(String(guildId || ""));
  if (!row || Date.now() - row.at > ROUTE_AFFINITY_MS) return null;
  return row.via;
}

function peekLauncherHint(guildId) {
  const cached = launcherHintCache.get(String(guildId || ""));
  if (cached && Date.now() - cached.at < HINT_CACHE_MS) return cached.value;
  return null;
}

async function warmupWhitelistRoute(settings) {
  if (!settings?.guild_id) return preferredRoute(settings?.guild_id);
  const hint = await readLauncherHint(settings.guild_id);
  if (hint?.online) rememberRoute(settings.guild_id, "launcher");
  return preferredRoute(settings.guild_id);
}

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
  const cacheKey = String(guildId || "");
  const cached = launcherHintCache.get(cacheKey);
  if (cached && Date.now() - cached.at < HINT_CACHE_MS) {
    return cached.value;
  }
  try {
    const db = require("./whitelistDbService");
    if (typeof db.getLauncherConnectivityHint !== "function") {
      return { online: false, reason: "missing" };
    }
    const value = await db.getLauncherConnectivityHint(guildId);
    launcherHintCache.set(cacheKey, { at: Date.now(), value });
    return value;
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

function buildSelectSql(engine, mapping, candidateCount = 1) {
  const playerTable = quoteSqlIdentifier(engine, mapping.playerTable);
  const playerId = quoteSqlIdentifier(engine, mapping.playerIdColumn);
  const whitelist = quoteSqlIdentifier(engine, mapping.whitelistColumn);
  const placeholders = Array.from({ length: Math.max(1, candidateCount) }, () => "?").join(", ");
  if (mappingUsesJoin(mapping)) {
    const joinTable = quoteSqlIdentifier(engine, mapping.joinTable);
    const joinFrom = quoteSqlIdentifier(engine, mapping.joinFromColumn);
    const joinTo = quoteSqlIdentifier(engine, mapping.joinToColumn);
    const joinId = quoteSqlIdentifier(engine, mapping.joinIdentifierColumn);
    return `SELECT ${playerTable}.${playerId} AS player_key, ${playerTable}.${whitelist} AS whitelist_value FROM ${playerTable} INNER JOIN ${joinTable} ON ${playerTable}.${joinFrom} = ${joinTable}.${joinTo} WHERE ${joinTable}.${joinId} IN (${placeholders}) LIMIT 2`;
  }
  return `SELECT ${playerId} AS player_key, ${whitelist} AS whitelist_value FROM ${playerTable} WHERE ${playerId} IN (${placeholders}) LIMIT 2`;
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
  const interactive = Boolean(options.interactive);
  const launcherOpts = {
    priority: interactive ? "interactive" : "background",
  };

  const preferred = preferredRoute(settings.guild_id);
  const cachedHint = peekLauncherHint(settings.guild_id);
  const skipDirectFirst = preferred === "launcher" || cachedHint?.online === true;
  const useDirect = Boolean(cityTarget) && !skipDirectFirst;
  const directTask = useDirect
    ? (async () => {
        const portOpen = await probeCityPort(cityTarget.host, cityTarget.port);
        if (!portOpen) {
          return { ok: false, code: "port_closed", message: "Porta do banco fechada." };
        }
        try {
          return await runDirectWhitelistOperation(settings, mapping, operation, identifierValue, {
            interactive,
          });
        } catch (error) {
          const sanitized = decorateCityFailure(sanitizeCityDbError(error));
          if (sanitized.code === "offline" || sanitized.code === "timeout") {
            rememberPortState(cityTarget.host, cityTarget.port, false);
          }
          return sanitized;
        }
      })()
    : null;

  const useLauncher = Boolean(launcherCityDb);

  if (useLauncher) {
    logCityDb("info", "whitelist_launcher_local", {
      guildId: settings.guild_id,
      operation,
    });
  }

  const launcherTask = useLauncher
    ? runViaLauncher(settings, operation, identifierValue, mapping, launcherCityDb, {
        ...launcherOpts,
        brief: interactive && preferred !== "launcher",
      }).catch((error) => {
        logCityDb("warn", "whitelist_launcher_error", {
          guildId: settings.guild_id,
          operation,
          message: error instanceof Error ? error.message : String(error),
        });
        return decorateCityFailure({
          ok: false,
          code: "offline",
          message: error instanceof Error ? error.message : String(error),
        });
      })
    : null;

  if (launcherTask && directTask) {
    const raced = await raceFirstDecisiveResult([directTask, launcherTask]);
    if (raced?.ok) rememberRoute(settings.guild_id, raced.via === "direct" ? "direct" : "launcher");
    return raced;
  }
  if (launcherTask) {
    const viaLauncher = await launcherTask;
    if (viaLauncher?.ok || isDecisiveCityResult(viaLauncher)) {
      if (viaLauncher?.ok) rememberRoute(settings.guild_id, "launcher");
      return viaLauncher?.ok ? normalizeWhitelistResult(viaLauncher) : decorateCityFailure(viaLauncher);
    }
    if (cityTarget && skipDirectFirst) {
      try {
        const portOpen = await probeCityPort(cityTarget.host, cityTarget.port);
        if (portOpen) {
          const direct = await runDirectWhitelistOperation(settings, mapping, operation, identifierValue, {
            interactive,
          });
          if (direct?.ok || isDecisiveCityResult(direct)) {
            if (direct?.ok) rememberRoute(settings.guild_id, "direct");
            return direct?.ok ? normalizeWhitelistResult(direct) : decorateCityFailure(direct);
          }
        }
      } catch (error) {
        /* launcher ja falhou; cai no deferred */
      }
    }
    return decorateCityFailure(viaLauncher || { ok: false, code: "city_deferred" });
  }
  if (directTask) {
    const direct = await directTask;
    if (direct?.ok || isDecisiveCityResult(direct)) {
      if (direct?.ok) rememberRoute(settings.guild_id, "direct");
      return direct?.ok ? normalizeWhitelistResult(direct) : decorateCityFailure(direct);
    }
    if (direct && !isRetryableLauncherCode(direct.code)) {
      return decorateCityFailure(direct);
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

function isDecisiveCityResult(result) {
  if (!result || typeof result !== "object") return false;
  if (result.ok === true) return true;
  const code = String(result.code || "");
  return (
    code === "player_not_found" ||
    code === "multiple_players" ||
    (result.ok === false && code !== "" && !isRetryableLauncherCode(code) && code !== "port_closed")
  );
}

async function raceFirstDecisiveResult(tasks) {
  return new Promise((resolve) => {
    const collected = [];
    let pending = tasks.length;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    for (const task of tasks) {
      Promise.resolve(task)
        .then((value) => {
          const normalized = value?.ok ? normalizeWhitelistResult(value) : decorateCityFailure(value || {});
          collected.push(normalized);
          if (isDecisiveCityResult(normalized)) {
            finish(normalized);
            return;
          }
          pending -= 1;
          if (pending <= 0) {
            finish(pickBestWhitelistResult(collected));
          }
        })
        .catch((error) => {
          collected.push(decorateCityFailure(sanitizeCityDbError(error)));
          pending -= 1;
          if (pending <= 0) {
            finish(pickBestWhitelistResult(collected));
          }
        });
    }
  });
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
  const brief = options.brief === true;
  const attempts = brief ? 1 : fast ? 1 : 2;
  const timeouts = brief ? [1800] : fast ? [4000] : [8000, 12000];
  const pollMs = fast || brief ? 10 : 40;
  const waitOpts = brief
    ? { extendIfClaimed: true, extendMs: 1200, maxTotalMs: 2500 }
    : fast
      ? { extendIfClaimed: true, extendMs: 2500, maxTotalMs: 5500 }
      : { extendIfClaimed: true, extendMs: 8000, maxTotalMs: 18000 };
  let last = {
    ok: false,
    code: "offline",
    message: "Nao foi possivel enfileirar o SQL no launcher da VPS.",
  };

  if (!fast && !brief) {
    await db.requeueStaleAgentJobs(settings.guild_id, 60000);
  }

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let jobId = null;
    if (!fast) {
      const pending = await db.findPendingAgentJob(settings.guild_id, operation, identifierValue);
      if (pending?.id) jobId = pending.id;
    }
    if (!jobId) {
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
      await sleep(fast ? 80 * attempt : 250 * attempt);
      continue;
    }

    const finished = await db.waitForAgentJob(
      jobId,
      timeouts[Math.min(attempt - 1, timeouts.length - 1)],
      pollMs,
      waitOpts,
    );

    if (finished.status !== "done") {
      last = decorateCityFailure({
        ok: false,
        code: finished.status === "timeout" ? "vps_timeout" : "offline",
        message: finished.error_message || buildLauncherWaitMessage(await readLauncherHint(settings.guild_id)),
      });
      if (finished.status === "timeout" && !fast && !brief) {
        await db.requeueStaleAgentJobs(settings.guild_id, 45000);
        await sleep(400 * attempt);
        continue;
      }
      return last;
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
      if (!isRetryableLauncherCode(last.code) || fast || brief) return last;
      await sleep(200 * attempt);
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
  const candidates = identifierCandidates(identifierValue);
  const selectSql = buildSelectSql(target.engine, mapping, candidates.length);
  const updateSql = buildUpdateSql(target.engine, mapping);
  const dbOptions = { interactive: runtimeOptions.interactive === true };

  return withCityDatabase(
    target,
    async (query, withTransaction) => {
      const readAndMaybeWrite = async (runQuery) => {
        const rows = await runQuery(selectSql, candidates);
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
  warmupWhitelistRoute,
};
