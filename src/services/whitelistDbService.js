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

async function getGuildWhitelistSettings(guildId) {
  const result = await supabase
    .from(SETTINGS_TABLE)
    .select(
      "guild_id, enabled, panel_channel_id, review_channel_id, logs_channel_id, panel_layout, panel_title, panel_description, panel_button_label, panel_message_id, approved_role_ids, denied_role_ids, review_role_ids, identifier_kind, identifier_label, identifier_placeholder, approval_mode, connection_mode, db_engine, db_host, db_port, db_name, db_user, db_ssl, db_password_cipher, mapping, mapping_status, last_health_ok, agent_public_ip, configured_by_user_id, updated_at",
    )
    .eq("guild_id", guildId)
    .maybeSingle();
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
  const result = await supabase
    .from(REQUESTS_TABLE)
    .insert({
      ...record,
      correlation_id: record.correlation_id || randomUUID(),
    })
    .select("*")
    .single();
  return unwrap(result, "createWhitelistRequest");
}

async function updateWhitelistRequest(id, patch) {
  const result = await supabase
    .from(REQUESTS_TABLE)
    .update(patch)
    .eq("id", id)
    .select("*")
    .single();
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
  findOpenRequest,
  createWhitelistRequest,
  updateWhitelistRequest,
  getWhitelistRequestById,
  insertWhitelistAudit,
  enqueueAgentJob,
  findQueuedAgentJob,
  listDoneJobsForDiscordSync,
  markJobDiscordSynced,
};
