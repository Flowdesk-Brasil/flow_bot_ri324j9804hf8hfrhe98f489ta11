const { createClient } = require("@supabase/supabase-js");
const { env } = require("../config/env");
const { randomUUID } = require("crypto");

const SETTINGS_TABLE = "guild_whitelist_settings";
const REQUESTS_TABLE = "guild_whitelist_requests";
const AUDIT_TABLE = "guild_whitelist_audit";
const AGENT_JOBS_TABLE = "guild_whitelist_agent_jobs";

const supabase = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function unwrap(result, operation) {
  if (result.error) {
    const code = result.error.code || "";
    if (code === "42P01" || code === "PGRST205") return null;
    throw new Error(`[WhitelistDB] ${operation}: ${result.error.message}`);
  }
  return result.data;
}

function isMissingColumnError(error, column) {
  const code = String(error?.code || "");
  const message = String(error?.message || "").toLowerCase();
  const name = String(column || "").toLowerCase();
  if (!name) return false;
  if (code === "PGRST204" || code === "42703") {
    return message.includes(name);
  }
  return (
    message.includes(name) &&
    (message.includes("column") ||
      message.includes("schema cache") ||
      message.includes("could not find"))
  );
}

const SETTINGS_COLUMNS =
  "guild_id, enabled, panel_channel_id, review_channel_id, logs_channel_id, panel_layout, panel_title, panel_description, panel_button_label, panel_message_id, approved_role_ids, denied_role_ids, review_role_ids, identifier_kind, identifier_label, identifier_placeholder, approval_mode, connection_mode, db_engine, db_host, db_port, db_name, db_user, db_ssl, db_password_cipher, mapping, mapping_status, last_health_ok, agent_public_ip, configured_by_user_id, updated_at, nickname_format";
const SETTINGS_COLUMNS_LEGACY =
  "guild_id, enabled, panel_channel_id, review_channel_id, logs_channel_id, panel_layout, panel_title, panel_description, panel_button_label, panel_message_id, approved_role_ids, denied_role_ids, review_role_ids, identifier_kind, identifier_label, identifier_placeholder, approval_mode, connection_mode, db_engine, db_host, db_port, db_name, db_user, db_ssl, db_password_cipher, mapping, mapping_status, last_health_ok, agent_public_ip, configured_by_user_id, updated_at";

async function getGuildWhitelistSettings(guildId) {
  const result = await supabase
    .from(SETTINGS_TABLE)
    .select(SETTINGS_COLUMNS)
    .eq("guild_id", guildId)
    .maybeSingle();
  if (result.error && isMissingColumnError(result.error, "nickname_format")) {
    const fallback = await supabase
      .from(SETTINGS_TABLE)
      .select(SETTINGS_COLUMNS_LEGACY)
      .eq("guild_id", guildId)
      .maybeSingle();
    return unwrap(fallback, "getGuildWhitelistSettings");
  }
  return unwrap(result, "getGuildWhitelistSettings");
}

async function updateGuildWhitelistPanelMessageId(guildId, messageId) {
  const result = await supabase
    .from(SETTINGS_TABLE)
    .update({ panel_message_id: messageId })
    .eq("guild_id", guildId);
  unwrap(result, "updateGuildWhitelistPanelMessageId");
}

async function listEnabledWhitelistSettings() {
  const result = await supabase
    .from(SETTINGS_TABLE)
    .select(
      "guild_id, enabled, panel_channel_id, panel_layout, panel_title, panel_description, panel_button_label, panel_message_id, identifier_label",
    )
    .eq("enabled", true);
  return unwrap(result, "listEnabledWhitelistSettings") || [];
}

async function findApprovedRequestByUser(guildId, userId) {
  const result = await supabase
    .from(REQUESTS_TABLE)
    .select("id, guild_id, user_id, identifier_value, status")
    .eq("guild_id", guildId)
    .eq("user_id", userId)
    .eq("status", "approved")
    .order("id", { ascending: false })
    .limit(1);
  const rows = unwrap(result, "findApprovedRequestByUser") || [];
  return rows[0] || null;
}

async function findBoundRequestByIdentifier(guildId, identifierValue) {
  const result = await supabase
    .from(REQUESTS_TABLE)
    .select("id, guild_id, user_id, identifier_value, status")
    .eq("guild_id", guildId)
    .eq("identifier_value", identifierValue)
    .in("status", ["approved", "pending", "apply_failed"])
    .order("id", { ascending: false })
    .limit(8);
  const rows = unwrap(result, "findBoundRequestByIdentifier") || [];
  return rows.find((row) => row.status === "approved") || rows[0] || null;
}

async function findOpenRequest(guildId, userId) {
  const result = await supabase
    .from(REQUESTS_TABLE)
    .select("*")
    .eq("guild_id", guildId)
    .eq("user_id", userId)
    .in("status", ["pending", "apply_failed"])
    .maybeSingle();
  return unwrap(result, "findOpenRequest");
}

async function createWhitelistRequest(record) {
  const payload = {
    ...record,
    correlation_id: record.correlation_id || randomUUID(),
  };
  const result = await supabase.from(REQUESTS_TABLE).insert(payload).select("*").single();
  if (result.error && payload.player_name != null && isMissingColumnError(result.error, "player_name")) {
    const { player_name: playerName, ...rest } = payload;
    const fallback = await supabase.from(REQUESTS_TABLE).insert(rest).select("*").single();
    const row = unwrap(fallback, "createWhitelistRequest");
    if (row) row.player_name = playerName;
    return row;
  }
  return unwrap(result, "createWhitelistRequest");
}

async function updateWhitelistRequest(id, patch) {
  const result = await supabase
    .from(REQUESTS_TABLE)
    .update(patch)
    .eq("id", id)
    .select("*")
    .single();
  if (result.error && patch.player_name != null && isMissingColumnError(result.error, "player_name")) {
    const { player_name: playerName, ...rest } = patch;
    const fallback = await supabase
      .from(REQUESTS_TABLE)
      .update(rest)
      .eq("id", id)
      .select("*")
      .single();
    const row = unwrap(fallback, "updateWhitelistRequest");
    if (row) row.player_name = playerName;
    return row;
  }
  return unwrap(result, "updateWhitelistRequest");
}

async function getWhitelistRequestById(id) {
  const result = await supabase.from(REQUESTS_TABLE).select("*").eq("id", id).maybeSingle();
  return unwrap(result, "getWhitelistRequestById");
}

async function insertWhitelistAudit(record) {
  const result = await supabase.from(AUDIT_TABLE).insert({
    ...record,
    correlation_id: record.correlation_id || randomUUID(),
  });
  unwrap(result, "insertWhitelistAudit");
}

async function enqueueAgentJob(record) {
  const result = await supabase
    .from(AGENT_JOBS_TABLE)
    .insert({
      ...record,
      status: "queued",
      correlation_id: record.correlation_id || randomUUID(),
    })
    .select("*")
    .single();
  return unwrap(result, "enqueueAgentJob");
}

async function listApplyFailedRequests(limit = 15) {
  const result = await supabase
    .from(REQUESTS_TABLE)
    .select("*")
    .eq("status", "apply_failed")
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (result.error && String(result.error.message || "").toLowerCase().includes("updated_at")) {
    const fallback = await supabase
      .from(REQUESTS_TABLE)
      .select("*")
      .eq("status", "apply_failed")
      .order("id", { ascending: false })
      .limit(limit);
    return unwrap(fallback, "listApplyFailedRequests") || [];
  }
  return unwrap(result, "listApplyFailedRequests") || [];
}

async function getAgentJob(jobId) {
  const result = await supabase
    .from(AGENT_JOBS_TABLE)
    .select("id, status, result, error_message, claimed_at")
    .eq("id", jobId)
    .maybeSingle();
  return unwrap(result, "getAgentJob");
}

async function requeueStaleAgentJobs(guildId, maxAgeMs = 45000) {
  if (!guildId) return;
  const cutoff = new Date(Date.now() - Math.max(5000, Number(maxAgeMs) || 45000)).toISOString();
  const result = await supabase
    .from(AGENT_JOBS_TABLE)
    .update({ status: "queued", claimed_at: null })
    .eq("guild_id", guildId)
    .eq("status", "claimed")
    .lt("claimed_at", cutoff);
  unwrap(result, "requeueStaleAgentJobs");
}

async function findPendingAgentJob(guildId, operation, identifierValue) {
  const result = await supabase
    .from(AGENT_JOBS_TABLE)
    .select("id, status, payload, created_at")
    .eq("guild_id", guildId)
    .eq("operation", operation)
    .in("status", ["queued", "claimed"])
    .order("created_at", { ascending: false })
    .limit(12);
  const rows = unwrap(result, "findPendingAgentJob") || [];
  const target = String(identifierValue || "").trim();
  return (
    rows.find((row) => {
      const payload = row.payload && typeof row.payload === "object" ? row.payload : {};
      return String(payload.identifierValue || "").trim() === target;
    }) || null
  );
}

async function getLauncherConnectivityHint(guildId) {
  try {
    const result = await supabase
      .from("launcher_devices")
      .select("connection_status, last_seen_at, last_error")
      .eq("guild_id", guildId)
      .order("last_seen_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const row = unwrap(result, "getLauncherConnectivityHint");
    if (!row) {
      return { online: false, reason: "missing" };
    }
    const lastSeen = Date.parse(String(row.last_seen_at || ""));
    const fresh = Number.isFinite(lastSeen) && Date.now() - lastSeen < 45_000;
    const online = row.connection_status === "online" && fresh;
    return {
      online,
      reason: row.connection_status || "unknown",
      lastError: row.last_error || null,
    };
  } catch {
    return { online: false, reason: "unknown" };
  }
}

async function waitForAgentJob(jobId, timeoutMs = 15000, pollMs = 50, options = {}) {
  const extendIfClaimed = options.extendIfClaimed !== false;
  const extendMs = Number(options.extendMs || 12000);
  const maxTotalMs = Number(
    options.maxTotalMs || timeoutMs + (extendIfClaimed ? extendMs : 0),
  );
  const started = Date.now();
  let extendedOnce = false;

  return new Promise((resolve) => {
    let settled = false;
    let pollTimer = null;
    let watchdog = null;
    let channel = null;

    const finish = (row) => {
      if (settled) return;
      settled = true;
      if (pollTimer) clearInterval(pollTimer);
      if (watchdog) clearTimeout(watchdog);
      if (channel) supabase.removeChannel(channel);
      resolve(row);
    };

    const finishTimeout = () => {
      finish({
        id: jobId,
        status: "timeout",
        result: null,
        error_message: "O launcher na VPS nao respondeu a tempo. Na primeira configuracao, abra o app. Depois a whitelist usa o banco direto.",
      });
    };

    const scheduleWatchdog = () => {
      if (watchdog) clearTimeout(watchdog);
      const elapsed = Date.now() - started;
      const remainingTotal = maxTotalMs - elapsed;
      if (remainingTotal <= 0) {
        void handleTimeout();
        return;
      }
      const phaseLimit = extendedOnce ? maxTotalMs : timeoutMs;
      const phaseRemaining = Math.max(0, phaseLimit - elapsed);
      watchdog = setTimeout(
        () => void handleTimeout(),
        Math.min(remainingTotal, phaseRemaining || remainingTotal),
      );
    };

    const handleTimeout = async () => {
      try {
        const row = await getAgentJob(jobId);
        if (row && (row.status === "done" || row.status === "failed")) {
          finish(row);
          return;
        }
        if (extendIfClaimed && !extendedOnce && row?.status === "claimed") {
          extendedOnce = true;
          scheduleWatchdog();
          return;
        }
      } catch {
        /* continua para timeout final */
      }
      finishTimeout();
    };

    const readRow = async () => {
      try {
        const row = await getAgentJob(jobId);
        if (row && (row.status === "done" || row.status === "failed")) {
          finish(row);
        }
      } catch {
        /* continua aguardando */
      }
    };

    void readRow();
    pollTimer = setInterval(readRow, pollMs);
    scheduleWatchdog();

    try {
      channel = supabase
        .channel(`whitelist-job-${jobId}-${Date.now()}`)
        .on(
          "postgres_changes",
          {
            event: "UPDATE",
            schema: "public",
            table: AGENT_JOBS_TABLE,
            filter: `id=eq.${jobId}`,
          },
          (payload) => {
            const row = payload.new;
            if (row && (row.status === "done" || row.status === "failed")) {
              finish(row);
            }
          },
        )
        .subscribe();
    } catch {
      /* fallback apenas com polling */
    }
  });
}

async function findQueuedAgentJob(guildId, requestId, operation) {
  const result = await supabase
    .from(AGENT_JOBS_TABLE)
    .select("id, status, operation")
    .eq("guild_id", guildId)
    .eq("request_id", requestId)
    .eq("operation", operation)
    .in("status", ["queued", "claimed"])
    .maybeSingle();
  return unwrap(result, "findQueuedAgentJob");
}

async function listDoneJobsForDiscordSync(limit = 25) {
  const result = await supabase
    .from(AGENT_JOBS_TABLE)
    .select("id, guild_id, request_id, operation, result, error_message, status, discord_synced")
    .eq("status", "done")
    .eq("discord_synced", false)
    .not("request_id", "is", null)
    .order("completed_at", { ascending: true })
    .limit(limit);
  if (result.error && String(result.error.message || "").includes("discord_synced")) {
    const fallback = await supabase
      .from(AGENT_JOBS_TABLE)
      .select("id, guild_id, request_id, operation, result, error_message, status")
      .eq("status", "done")
      .not("request_id", "is", null)
      .order("id", { ascending: false })
      .limit(limit);
    return unwrap(fallback, "listDoneJobsForDiscordSync") || [];
  }
  return unwrap(result, "listDoneJobsForDiscordSync") || [];
}

async function markJobDiscordSynced(id) {
  const result = await supabase
    .from(AGENT_JOBS_TABLE)
    .update({ discord_synced: true })
    .eq("id", id);
  if (result.error && String(result.error.message || "").includes("discord_synced")) {
    return;
  }
  unwrap(result, "markJobDiscordSynced");
}

module.exports = {
  getGuildWhitelistSettings,
  updateGuildWhitelistPanelMessageId,
  listEnabledWhitelistSettings,
  findApprovedRequestByUser,
  findBoundRequestByIdentifier,
  findOpenRequest,
  createWhitelistRequest,
  updateWhitelistRequest,
  getWhitelistRequestById,
  insertWhitelistAudit,
  enqueueAgentJob,
  listApplyFailedRequests,
  waitForAgentJob,
  getAgentJob,
  requeueStaleAgentJobs,
  findPendingAgentJob,
  getLauncherConnectivityHint,
  findQueuedAgentJob,
  listDoneJobsForDiscordSync,
  markJobDiscordSynced,
};
