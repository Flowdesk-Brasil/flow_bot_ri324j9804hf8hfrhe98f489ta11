const { createClient } = require("@supabase/supabase-js");
const { env } = require("../config/env");
const flowPlansCatalog = require("../../shared/flow-plans.json");

const TICKETS_TABLE = "tickets";
const EVENTS_TABLE = "ticket_events";
const TICKET_SETTINGS_TABLE = "guild_ticket_settings";
const TICKET_STAFF_SETTINGS_TABLE = "guild_ticket_staff_settings";
const WELCOME_SETTINGS_TABLE = "guild_welcome_settings";
const CAPTCHA_SETTINGS_TABLE = "guild_captcha_settings";
const CAPTCHA_SESSIONS_TABLE = "guild_captcha_sessions";
const SUGGESTIONS_SETTINGS_TABLE = "guild_suggestions_settings";
const SUGGESTIONS_TABLE = "guild_suggestions";
const SUGGESTION_VOTES_TABLE = "guild_suggestion_votes";
const SUGGESTION_VOTE_EVENTS_TABLE = "guild_suggestion_vote_events";
const BATE_PONTO_SETTINGS_TABLE = "guild_bate_ponto_settings";
const BATE_PONTO_SESSIONS_TABLE = "guild_bate_ponto_sessions";
const BATE_PONTO_EVENTS_TABLE = "guild_bate_ponto_events";
const BATE_PONTO_HOUR_BANK_TABLE = "guild_bate_ponto_hour_bank";
const ANTILINK_SETTINGS_TABLE = "guild_antilink_settings";
const AUTOROLE_SETTINGS_TABLE = "guild_autorole_settings";
const AUTOROLE_QUEUE_TABLE = "guild_autorole_queue";
const SECURITY_LOGS_SETTINGS_TABLE = "guild_security_logs_settings";
const SECURITY_LOG_QUEUE_TABLE = "guild_security_log_queue";
const PLAN_GUILDS_TABLE = "auth_user_plan_guilds";
const USER_PLAN_STATE_TABLE = "auth_user_plan_state";
const PAYMENT_ORDERS_TABLE = "payment_orders";
const TICKET_TRANSCRIPTS_TABLE = "ticket_transcripts";
const TICKET_DM_QUEUE_TABLE = "ticket_dm_queue";
const TICKET_AI_SESSIONS_TABLE = "ticket_ai_sessions";
const TICKET_AI_MESSAGES_TABLE = "ticket_ai_messages";
const TICKET_AI_SUGGESTION_SESSIONS_TABLE = "ticket_ai_suggestion_sessions";
const DEFAULT_LICENSE_VALIDITY_DAYS = 30;
const EXPIRED_GRACE_MS = 3 * 24 * 60 * 60 * 1000;
const MODULE_RUNTIME_CACHE_TTL_MS = 20 * 1000;
const LICENSE_RUNTIME_CACHE_TTL_MS = 45 * 1000;
const CONFIGURED_TICKET_GUILDS_CACHE_TTL_MS = 30 * 1000;

const licenseRuntimeCache = new Map();
const licenseRuntimeInflight = new Map();
const moduleRuntimeCache = {
  ticket: new Map(),
  welcome: new Map(),
  captcha: new Map(),
  suggestions: new Map(),
  batePonto: new Map(),
  antiLink: new Map(),
  autoRole: new Map(),
  securityLogs: new Map(),
};
const moduleRuntimeInflight = {
  ticket: new Map(),
  welcome: new Map(),
  captcha: new Map(),
  suggestions: new Map(),
  batePonto: new Map(),
  antiLink: new Map(),
  autoRole: new Map(),
  securityLogs: new Map(),
};
let configuredTicketGuildRuntimesCache = null;
let configuredTicketGuildRuntimesInflight = null;

const BATE_PONTO_SETTINGS_SELECT =
  "guild_id, enabled, panel_channel_id, logs_channel_id, panel_layout, panel_title, panel_description, panel_button_label, panel_message_id, log_layout, allowed_role_ids, hour_bank_enabled, daily_target_minutes, timezone, auto_finish_open_sessions, max_open_hours, require_voice_channel, required_voice_channel_ids, updated_at";

const BATE_PONTO_SESSION_SELECT =
  "id, guild_id, user_id, status, started_at, ended_at, last_action_at, worked_seconds, break_seconds, break_started_at, voice_channel_id, voice_left_at, voice_warning_sent_at, created_at, updated_at";

const BATE_PONTO_EVENT_SELECT =
  "id, guild_id, user_id, session_id, action, worked_seconds, break_seconds, hour_bank_delta_seconds, note, created_at";

const supabase = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

function unwrap(result, operation) {
  if (result.error) {
    throw new Error(
      `[Supabase] Falha em "${operation}": ${result.error.message}`,
    );
  }

  return result.data;
}

function cloneCachedValue(value) {
  if (value === undefined) {
    return undefined;
  }

  return JSON.parse(JSON.stringify(value));
}

function readCacheEntry(cache, key) {
  const entry = cache.get(key);
  if (!entry) {
    return { hit: false, value: undefined };
  }

  if (entry.expiresAt <= Date.now()) {
    cache.delete(key);
    return { hit: false, value: undefined };
  }

  return {
    hit: true,
    value: cloneCachedValue(entry.value),
  };
}

function writeCacheEntry(cache, key, value, ttlMs) {
  cache.set(key, {
    expiresAt: Date.now() + ttlMs,
    value: cloneCachedValue(value),
  });
}

async function withCachedResult(cache, inflight, key, ttlMs, loader) {
  const cached = readCacheEntry(cache, key);
  if (cached.hit) {
    return cached.value;
  }

  const existingPromise = inflight.get(key);
  if (existingPromise) {
    return cloneCachedValue(await existingPromise);
  }

  const loadPromise = (async () => {
    const value = await loader();
    writeCacheEntry(cache, key, value, ttlMs);
    return value;
  })();

  inflight.set(key, loadPromise);

  try {
    return cloneCachedValue(await loadPromise);
  } finally {
    inflight.delete(key);
  }
}

function resolveLicenseBaseTimestamp(order) {
  const paidAtMs = order.paid_at ? Date.parse(order.paid_at) : Number.NaN;
  if (Number.isFinite(paidAtMs)) return paidAtMs;

  const createdAtMs = Date.parse(order.created_at);
  if (Number.isFinite(createdAtMs)) return createdAtMs;

  return Date.now();
}

function resolveLicenseValidityMs(order) {
  const explicitCycleDays =
    typeof order?.plan_billing_cycle_days === "number" &&
    Number.isFinite(order.plan_billing_cycle_days) &&
    order.plan_billing_cycle_days > 0
      ? order.plan_billing_cycle_days
      : null;

  if (explicitCycleDays) {
    return explicitCycleDays * 24 * 60 * 60 * 1000;
  }

  const normalizedPlanCode =
    typeof order?.plan_code === "string"
      ? order.plan_code.trim().toLowerCase()
      : "";
  const catalogCycleDays = Number(
    flowPlansCatalog?.[normalizedPlanCode]?.billingCycleDays,
  );
  const cycleDays =
    Number.isInteger(catalogCycleDays) && catalogCycleDays > 0
      ? catalogCycleDays
      : DEFAULT_LICENSE_VALIDITY_DAYS;

  return cycleDays * 24 * 60 * 60 * 1000;
}

function resolveLatestLicenseStatusFromApprovedOrders(orders, nowMs = Date.now()) {
  if (!Array.isArray(orders) || !orders.length) {
    return {
      status: "not_paid",
      usable: false,
      latestCoverage: null,
    };
  }

  const sortedOrders = [...orders].sort((left, right) => {
    return resolveLicenseBaseTimestamp(left) - resolveLicenseBaseTimestamp(right);
  });

  let latestCoverage = null;

  for (const order of sortedOrders) {
    const paidTimestampMs = resolveLicenseBaseTimestamp(order);
    let licenseStartsAtMs = paidTimestampMs;

    if (latestCoverage) {
      const previousLicenseExpiresAtMs = latestCoverage.licenseExpiresAtMs;
      const previousGraceExpiresAtMs = latestCoverage.graceExpiresAtMs;
      const previousRenewalWindowStartsAtMs =
        previousLicenseExpiresAtMs - EXPIRED_GRACE_MS;

      if (
        Number.isFinite(previousLicenseExpiresAtMs) &&
        Number.isFinite(previousGraceExpiresAtMs) &&
        paidTimestampMs >= previousRenewalWindowStartsAtMs &&
        paidTimestampMs <= previousGraceExpiresAtMs
      ) {
        licenseStartsAtMs = previousLicenseExpiresAtMs;
      }
    }

    const licenseExpiresAtMs = licenseStartsAtMs + resolveLicenseValidityMs(order);
    const graceExpiresAtMs = licenseExpiresAtMs + EXPIRED_GRACE_MS;

    let status = "off";
    if (nowMs <= licenseExpiresAtMs) {
      status = "paid";
    } else if (nowMs <= graceExpiresAtMs) {
      status = "expired";
    }

    latestCoverage = {
      order,
      status,
      licenseStartsAtMs,
      licenseExpiresAtMs,
      graceExpiresAtMs,
    };
  }

  return {
    status: latestCoverage?.status || "not_paid",
    usable:
      latestCoverage?.status === "paid" || latestCoverage?.status === "expired",
    latestCoverage,
  };
}

function resolvePlanStateLicenseStatus(
  planState,
  fallbackActivatedAt = null,
  fallbackExpiresAt = null,
  nowMs = Date.now(),
) {
  if (!planState || planState.status === "inactive") {
    return {
      status: "not_paid",
      usable: false,
      latestCoverage: null,
    };
  }

  const activatedAtMs = Date.parse(
    planState.activated_at || fallbackActivatedAt || new Date(nowMs).toISOString(),
  );
  const expiresAtMs = Date.parse(
    planState.expires_at || fallbackExpiresAt || "",
  );
  const normalizedActivatedAtMs = Number.isFinite(activatedAtMs)
    ? activatedAtMs
    : nowMs;
  const normalizedExpiresAtMs = Number.isFinite(expiresAtMs)
    ? expiresAtMs
    : normalizedActivatedAtMs;
  const graceExpiresAtMs = normalizedExpiresAtMs + EXPIRED_GRACE_MS;

  let status = planState.status === "expired" ? "expired" : "paid";
  if (Number.isFinite(expiresAtMs)) {
    if (nowMs <= normalizedExpiresAtMs) {
      status = "paid";
    } else if (nowMs <= graceExpiresAtMs) {
      status = "expired";
    } else {
      status = "off";
    }
  }

  return {
    status,
    usable: status === "paid" || status === "expired",
    latestCoverage: {
      order: null,
      status,
      licenseStartsAtMs: normalizedActivatedAtMs,
      licenseExpiresAtMs: normalizedExpiresAtMs,
      graceExpiresAtMs,
    },
  };
}

async function getUserPlanStatesByUserIds(userIds) {
  const uniqueUserIds = [...new Set((userIds || []).filter((value) => Number.isFinite(value)))];
  if (!uniqueUserIds.length) {
    return new Map();
  }

  const result = await supabase
    .from(USER_PLAN_STATE_TABLE)
    .select(
      "user_id, status, activated_at, expires_at, plan_code, plan_name, amount, currency, billing_cycle_days, updated_at",
    )
    .in("user_id", uniqueUserIds);

  const rows = unwrap(result, "getUserPlanStatesByUserIds") || [];
  return new Map(rows.map((row) => [row.user_id, row]));
}

async function getUserPlanStateByUserId(userId) {
  if (!Number.isFinite(userId)) {
    return null;
  }

  const result = await supabase
    .from(USER_PLAN_STATE_TABLE)
    .select(
      "user_id, status, activated_at, expires_at, plan_code, plan_name, amount, currency, billing_cycle_days, updated_at",
    )
    .eq("user_id", userId)
    .maybeSingle();

  return unwrap(result, "getUserPlanStateByUserId") || null;
}

async function getGuildAccountLicenseRuntimeMap(guildIds) {
  const uniqueGuildIds = [...new Set((guildIds || []).filter(Boolean))];
  const runtimeByGuild = new Map();

  if (!uniqueGuildIds.length) {
    return runtimeByGuild;
  }

  const unresolvedGuildIds = [];
  for (const guildId of uniqueGuildIds) {
    const cached = readCacheEntry(licenseRuntimeCache, guildId);
    if (cached.hit) {
      runtimeByGuild.set(guildId, cached.value);
      continue;
    }

    unresolvedGuildIds.push(guildId);
  }

  if (!unresolvedGuildIds.length) {
    return runtimeByGuild;
  }

  const planGuildsResult = await supabase
    .from(PLAN_GUILDS_TABLE)
    .select("guild_id, user_id, activated_at, created_at, is_active")
    .in("guild_id", unresolvedGuildIds);

  const planGuildRows = unwrap(planGuildsResult, "getGuildAccountLicenseRuntimeMap.planGuilds") || [];
  const planGuildByGuildId = new Map(
    planGuildRows.map((row) => [row.guild_id, row]),
  );
  const missingGuildIds = unresolvedGuildIds.filter(
    (guildId) => !planGuildByGuildId.has(guildId),
  );
  const approvedOrdersByGuild = missingGuildIds.length
    ? await getApprovedPaymentOrdersForGuildIds(missingGuildIds)
    : new Map();
  const legacyCoverageByGuild = new Map();

  for (const [guildId, orders] of approvedOrdersByGuild.entries()) {
    const latestCoverage = resolveLatestLicenseStatusFromApprovedOrders(orders).latestCoverage;
    if (latestCoverage) {
      legacyCoverageByGuild.set(guildId, latestCoverage);
    }
  }

  const userIds = new Set();
  for (const row of planGuildRows) {
    userIds.add(row.user_id);
  }
  for (const coverage of legacyCoverageByGuild.values()) {
    if (coverage?.order?.user_id) {
      userIds.add(coverage.order.user_id);
    }
  }

  const userPlanStates = await getUserPlanStatesByUserIds([...userIds]);

  for (const guildId of unresolvedGuildIds) {
    const planGuildLink = planGuildByGuildId.get(guildId) || null;
    const legacyCoverage = legacyCoverageByGuild.get(guildId) || null;
    const ownerUserId =
      planGuildLink?.user_id || legacyCoverage?.order?.user_id || null;

    if (!Number.isFinite(ownerUserId)) {
      const runtime = {
        licenseStatus: "paid",
        licenseUsable: true,
        latestCoverage: null,
        licenseOwnerUserId: null,
        planLinkActive: true,
      };
      writeCacheEntry(
        licenseRuntimeCache,
        guildId,
        runtime,
        LICENSE_RUNTIME_CACHE_TTL_MS,
      );
      runtimeByGuild.set(guildId, cloneCachedValue(runtime));
      continue;
    }

    const planState = userPlanStates.get(ownerUserId) || null;
    const fallbackActivatedAt =
      planGuildLink?.activated_at ||
      (legacyCoverage?.licenseStartsAtMs
        ? new Date(legacyCoverage.licenseStartsAtMs).toISOString()
        : null);
    const planCoverage = resolvePlanStateLicenseStatus(
      planState,
      fallbackActivatedAt,
      legacyCoverage?.licenseExpiresAtMs
        ? new Date(legacyCoverage.licenseExpiresAtMs).toISOString()
        : null,
    );

    let licenseStatus = planCoverage.status;
    let latestCoverage = planCoverage.latestCoverage;

    if (planGuildLink && planGuildLink.is_active === false) {
      licenseStatus = "off";
    } else if (licenseStatus === "not_paid" && legacyCoverage) {
      licenseStatus = legacyCoverage.status;
      latestCoverage = legacyCoverage;
    } else if (licenseStatus === "not_paid" && planGuildLink) {
      licenseStatus = "off";
    }

    const runtime = {
      licenseStatus: "paid",
      licenseUsable: true,
      latestCoverage,
      licenseOwnerUserId: ownerUserId,
      planLinkActive: true,
    };
    writeCacheEntry(
      licenseRuntimeCache,
      guildId,
      runtime,
      LICENSE_RUNTIME_CACHE_TTL_MS,
    );
    runtimeByGuild.set(guildId, cloneCachedValue(runtime));
  }

  return runtimeByGuild;
}

async function getGuildAccountLicenseRuntime(guildId) {
  return await withCachedResult(
    licenseRuntimeCache,
    licenseRuntimeInflight,
    guildId,
    LICENSE_RUNTIME_CACHE_TTL_MS,
    async () => {
      const runtimeByGuild = await getGuildAccountLicenseRuntimeMap([guildId]);
      return (
        runtimeByGuild.get(guildId) || {
          licenseStatus: "paid",
          licenseUsable: true,
          latestCoverage: null,
          licenseOwnerUserId: null,
          planLinkActive: true,
        }
      );
    },
  );
}

function normalizePlanCode(value, fallback = "pro") {
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  return flowPlansCatalog?.[normalized] ? normalized : fallback;
}

function resolvePlanNameFromOrder(order) {
  const fromOrder = typeof order?.plan_name === "string" ? order.plan_name.trim() : "";
  if (fromOrder) return fromOrder;

  const normalizedPlanCode = normalizePlanCode(order?.plan_code, "pro");
  const fromCatalog = flowPlansCatalog?.[normalizedPlanCode]?.name;
  return typeof fromCatalog === "string" && fromCatalog.trim()
    ? fromCatalog.trim()
    : "Flow Pro";
}

function resolveExpiresAtIsoFromOrderOrCoverage(order, coverage) {
  if (
    coverage &&
    Number.isFinite(coverage.licenseExpiresAtMs) &&
    coverage.licenseExpiresAtMs > 0
  ) {
    return new Date(coverage.licenseExpiresAtMs).toISOString();
  }

  const expiresAtFromOrder =
    typeof order?.expires_at === "string" ? order.expires_at.trim() : "";
  if (expiresAtFromOrder) return expiresAtFromOrder;

  return null;
}

async function getOpenTicketCount(guildId, userId) {
  const result = await supabase
    .from(TICKETS_TABLE)
    .select("id", { count: "exact", head: true })
    .eq("guild_id", guildId)
    .eq("user_id", userId)
    .eq("status", "open");

  if (result.error) {
    throw new Error(
      `[Supabase] Falha em "getOpenTicketCount": ${result.error.message}`,
    );
  }

  return result.count || 0;
}

async function getOpenTicketsForUser(guildId, userId) {
  const result = await supabase
    .from(TICKETS_TABLE)
    .select("*")
    .eq("guild_id", guildId)
    .eq("user_id", userId)
    .eq("status", "open")
    .order("opened_at", { ascending: false });

  return unwrap(result, "getOpenTicketsForUser") || [];
}

async function getAllOpenTickets() {
  const result = await supabase
    .from(TICKETS_TABLE)
    .select("*")
    .eq("status", "open")
    .order("opened_at", { ascending: false });

  return unwrap(result, "getAllOpenTickets") || [];
}

async function getLastTicketForUser(guildId, userId) {
  const result = await supabase
    .from(TICKETS_TABLE)
    .select("opened_at")
    .eq("guild_id", guildId)
    .eq("user_id", userId)
    .order("opened_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  return unwrap(result, "getLastTicketForUser");
}

async function createTicket({ protocol, guildId, channelId, userId, openedReason = "" }) {
  const result = await supabase
    .from(TICKETS_TABLE)
    .insert({
      protocol,
      guild_id: guildId,
      channel_id: channelId,
      user_id: userId,
      opened_reason: String(openedReason || "").trim(),
      status: "open",
    })
    .select("*")
    .single();

  return unwrap(result, "createTicket");
}

async function updateTicketIntroMessageId(ticketId, introMessageId) {
  const result = await supabase
    .from(TICKETS_TABLE)
    .update({
      intro_message_id: introMessageId || null,
    })
    .eq("id", ticketId)
    .select("id, intro_message_id")
    .single();

  return unwrap(result, "updateTicketIntroMessageId");
}

async function getOpenTicketByChannel(guildId, channelId) {
  const result = await supabase
    .from(TICKETS_TABLE)
    .select("*")
    .eq("guild_id", guildId)
    .eq("channel_id", channelId)
    .eq("status", "open")
    .maybeSingle();

  return unwrap(result, "getOpenTicketByChannel");
}

async function getTicketAiSession(ticketId) {
  const result = await supabase
    .from(TICKET_AI_SESSIONS_TABLE)
    .select("*")
    .eq("ticket_id", ticketId)
    .maybeSingle();

  return unwrap(result, "getTicketAiSession");
}

async function getTicketAiSuggestionSession(guildId, userId) {
  const result = await supabase
    .from(TICKET_AI_SUGGESTION_SESSIONS_TABLE)
    .select("*")
    .eq("guild_id", guildId)
    .eq("user_id", userId)
    .is("consumed_at", null)
    .maybeSingle();

  return unwrap(result, "getTicketAiSuggestionSession");
}

async function upsertTicketAiSession(input) {
  const result = await supabase
    .from(TICKET_AI_SESSIONS_TABLE)
    .upsert(
      {
        ticket_id: input.ticketId,
        protocol: input.protocol,
        guild_id: input.guildId,
        channel_id: input.channelId,
        user_id: input.userId,
        status: input.status || "active",
        handoff_reason: input.handoffReason || null,
        handed_off_by: input.handedOffBy || null,
        handed_off_at: input.handedOffAt || null,
        last_ai_reply_at: input.lastAiReplyAt || null,
        last_user_message_at: input.lastUserMessageAt || null,
        last_staff_message_at: input.lastStaffMessageAt || null,
      },
      { onConflict: "ticket_id" },
    )
    .select("*")
    .single();

  return unwrap(result, "upsertTicketAiSession");
}

async function upsertTicketAiSuggestionSession(input) {
  const result = await supabase
    .from(TICKET_AI_SUGGESTION_SESSIONS_TABLE)
    .upsert(
      {
        guild_id: input.guildId,
        user_id: input.userId,
        reason: String(input.reason || "").trim(),
        suggestion: String(input.suggestion || "").trim(),
        expires_at: input.expiresAt,
        consumed_at: null,
      },
      { onConflict: "guild_id,user_id" },
    )
    .select("*")
    .single();

  return unwrap(result, "upsertTicketAiSuggestionSession");
}

async function deleteTicketAiSuggestionSession(guildId, userId) {
  const result = await supabase
    .from(TICKET_AI_SUGGESTION_SESSIONS_TABLE)
    .delete()
    .eq("guild_id", guildId)
    .eq("user_id", userId)
    .select("*")
    .maybeSingle();

  return unwrap(result, "deleteTicketAiSuggestionSession");
}

async function createTicketAiMessage(input) {
  const result = await supabase
    .from(TICKET_AI_MESSAGES_TABLE)
    .insert({
      ticket_id: input.ticketId,
      protocol: input.protocol,
      guild_id: input.guildId,
      channel_id: input.channelId,
      author_id: input.authorId || null,
      author_type: input.authorType,
      source: input.source || "ticket_ai",
      content: String(input.content || "").trim(),
      metadata: input.metadata || {},
    })
    .select("*")
    .single();

  return unwrap(result, "createTicketAiMessage");
}

async function getRecentTicketAiMessages(ticketId, limit = 12) {
  const result = await supabase
    .from(TICKET_AI_MESSAGES_TABLE)
    .select("*")
    .eq("ticket_id", ticketId)
    .order("created_at", { ascending: false })
    .limit(limit);

  const rows = unwrap(result, "getRecentTicketAiMessages") || [];
  return rows.reverse();
}

async function claimTicket(ticketId, staffId) {
  const result = await supabase
    .from(TICKETS_TABLE)
    .update({
      claimed_by: staffId,
      claimed_at: new Date().toISOString(),
    })
    .eq("id", ticketId)
    .select("*")
    .single();

  return unwrap(result, "claimTicket");
}

async function closeTicket(ticketId, closedBy, transcriptFileName) {
  const result = await supabase
    .from(TICKETS_TABLE)
    .update({
      status: "closed",
      closed_by: closedBy,
      closed_at: new Date().toISOString(),
      transcript_file: transcriptFileName,
    })
    .eq("id", ticketId)
    .select("*")
    .single();

  return unwrap(result, "closeTicket");
}

async function upsertTicketTranscript({
  ticketId,
  protocol,
  guildId,
  channelId,
  userId,
  closedBy,
  transcriptHtml,
  accessCode,
  accessCodeHash,
}) {
  const result = await supabase
    .from(TICKET_TRANSCRIPTS_TABLE)
    .upsert(
      {
        ticket_id: ticketId,
        protocol,
        guild_id: guildId,
        channel_id: channelId,
        user_id: userId,
        closed_by: closedBy,
        transcript_html: transcriptHtml,
        access_code: accessCode,
        access_code_hash: accessCodeHash,
      },
      { onConflict: "ticket_id" },
    )
    .select("*")
    .single();

  return unwrap(result, "upsertTicketTranscript");
}

async function getTicketTranscriptByProtocol(protocol) {
  const result = await supabase
    .from(TICKET_TRANSCRIPTS_TABLE)
    .select("*")
    .eq("protocol", protocol)
    .maybeSingle();

  return unwrap(result, "getTicketTranscriptByProtocol");
}

async function enqueueTicketDirectMessage({
  notificationKey,
  kind,
  ticketId = null,
  protocol,
  guildId,
  userId,
  payload,
  maxAttempts = 12,
}) {
  const result = await supabase
    .from(TICKET_DM_QUEUE_TABLE)
    .upsert(
      {
        notification_key: notificationKey,
        kind,
        ticket_id: ticketId,
        protocol,
        guild_id: guildId,
        user_id: userId,
        payload,
        status: "pending",
        attempt_count: 0,
        max_attempts: maxAttempts,
        next_attempt_at: new Date().toISOString(),
        last_error: null,
        dm_channel_id: null,
        delivered_message_id: null,
        sent_at: null,
      },
      { onConflict: "notification_key" },
    )
    .select("*")
    .single();

  return unwrap(result, "enqueueTicketDirectMessage");
}

async function getDueTicketDirectMessages(limit = 10, notificationKey = null) {
  let query = supabase
    .from(TICKET_DM_QUEUE_TABLE)
    .select("*")
    .eq("status", "pending")
    .lte("next_attempt_at", new Date().toISOString())
    .order("next_attempt_at", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(limit);

  if (notificationKey) {
    query = query.eq("notification_key", notificationKey);
  }

  const result = await query;
  return unwrap(result, "getDueTicketDirectMessages") || [];
}

async function markTicketDirectMessageSent(queueId, { dmChannelId, deliveredMessageId }) {
  const result = await supabase
    .from(TICKET_DM_QUEUE_TABLE)
    .update({
      status: "sent",
      sent_at: new Date().toISOString(),
      last_error: null,
      dm_channel_id: dmChannelId || null,
      delivered_message_id: deliveredMessageId || null,
    })
    .eq("id", queueId)
    .select("*")
    .single();

  return unwrap(result, "markTicketDirectMessageSent");
}

async function markTicketDirectMessageBlocked(queueId, { attemptCount, lastError }) {
  const result = await supabase
    .from(TICKET_DM_QUEUE_TABLE)
    .update({
      status: "blocked",
      attempt_count: attemptCount,
      last_error: lastError || null,
    })
    .eq("id", queueId)
    .select("*")
    .single();

  return unwrap(result, "markTicketDirectMessageBlocked");
}

async function rescheduleTicketDirectMessage(queueId, {
  attemptCount,
  nextAttemptAt,
  lastError,
  finalFailure = false,
}) {
  const result = await supabase
    .from(TICKET_DM_QUEUE_TABLE)
    .update({
      status: finalFailure ? "failed" : "pending",
      attempt_count: attemptCount,
      next_attempt_at: nextAttemptAt,
      last_error: lastError || null,
    })
    .eq("id", queueId)
    .select("*")
    .single();

  return unwrap(result, "rescheduleTicketDirectMessage");
}

async function enqueueSecurityLogQueueItem({
  queueKey,
  guildId,
  channelId,
  eventKey,
  payload,
  maxAttempts = 48,
}) {
  const result = await supabase
    .from(SECURITY_LOG_QUEUE_TABLE)
    .upsert(
      {
        queue_key: queueKey,
        guild_id: guildId,
        channel_id: channelId,
        event_key: eventKey,
        payload,
        status: "pending",
        attempt_count: 0,
        max_attempts: maxAttempts,
        next_attempt_at: new Date().toISOString(),
        last_error: null,
      },
      { onConflict: "queue_key" },
    )
    .select("*")
    .single();

  return unwrap(result, "enqueueSecurityLogQueueItem");
}

async function getDueSecurityLogQueueItems(limit = 15) {
  const result = await supabase
    .from(SECURITY_LOG_QUEUE_TABLE)
    .select("*")
    .eq("status", "pending")
    .lte("next_attempt_at", new Date().toISOString())
    .order("next_attempt_at", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(limit);

  return unwrap(result, "getDueSecurityLogQueueItems") || [];
}

async function markSecurityLogQueueItemProcessing(queueId, { attemptCount }) {
  const result = await supabase
    .from(SECURITY_LOG_QUEUE_TABLE)
    .update({
      status: "processing",
      attempt_count: attemptCount,
      last_error: null,
    })
    .eq("id", queueId)
    .eq("status", "pending")
    .select("*")
    .maybeSingle();

  return unwrap(result, "markSecurityLogQueueItemProcessing");
}

async function deleteSecurityLogQueueItem(queueId) {
  const result = await supabase
    .from(SECURITY_LOG_QUEUE_TABLE)
    .delete()
    .eq("id", queueId)
    .select("id")
    .maybeSingle();

  return unwrap(result, "deleteSecurityLogQueueItem");
}

async function rescheduleSecurityLogQueueItem(queueId, {
  attemptCount,
  nextAttemptAt,
  lastError,
  finalFailure = false,
}) {
  const result = await supabase
    .from(SECURITY_LOG_QUEUE_TABLE)
    .update({
      status: finalFailure ? "failed" : "pending",
      attempt_count: attemptCount,
      next_attempt_at: nextAttemptAt,
      last_error: lastError || null,
    })
    .eq("id", queueId)
    .select("*")
    .single();

  return unwrap(result, "rescheduleSecurityLogQueueItem");
}

function normalizeAutoRoleRequestedSource(value) {
  return value === "existing_members_sync" ? "existing_members_sync" : "member_join";
}

async function enqueueGuildAutoRoleQueueItems(queueItems) {
  const normalizedItems = (queueItems || [])
    .filter((item) => item && item.guildId && item.memberId && item.dueAt)
    .map((item) => ({
      guild_id: item.guildId,
      member_id: item.memberId,
      due_at: item.dueAt,
      status: "pending",
      attempt_count: 0,
      requested_source: normalizeAutoRoleRequestedSource(item.requestedSource),
      last_error: null,
      processed_at: null,
    }));

  if (!normalizedItems.length) {
    return 0;
  }

  const result = await supabase
    .from(AUTOROLE_QUEUE_TABLE)
    .insert(normalizedItems, { returning: "minimal" });

  unwrap(result, "enqueueGuildAutoRoleQueueItems");
  return normalizedItems.length;
}

async function getDueGuildAutoRoleQueueItems(limit = 10) {
  const result = await supabase
    .from(AUTOROLE_QUEUE_TABLE)
    .select("*")
    .eq("status", "pending")
    .lte("due_at", new Date().toISOString())
    .order("due_at", { ascending: true })
    .order("created_at", { ascending: true })
    .limit(limit);

  return unwrap(result, "getDueGuildAutoRoleQueueItems") || [];
}

async function markGuildAutoRoleQueueItemProcessing(queueId, { attemptCount }) {
  const result = await supabase
    .from(AUTOROLE_QUEUE_TABLE)
    .update({
      status: "processing",
      attempt_count: attemptCount,
      last_error: null,
    })
    .eq("id", queueId)
    .select("*")
    .single();

  return unwrap(result, "markGuildAutoRoleQueueItemProcessing");
}

async function markGuildAutoRoleQueueItemCompleted(queueId) {
  const result = await supabase
    .from(AUTOROLE_QUEUE_TABLE)
    .update({
      status: "completed",
      processed_at: new Date().toISOString(),
      last_error: null,
    })
    .eq("id", queueId)
    .select("*")
    .single();

  return unwrap(result, "markGuildAutoRoleQueueItemCompleted");
}

async function markGuildAutoRoleQueueItemCancelled(queueId, { lastError }) {
  const result = await supabase
    .from(AUTOROLE_QUEUE_TABLE)
    .update({
      status: "cancelled",
      processed_at: new Date().toISOString(),
      last_error: lastError || null,
    })
    .eq("id", queueId)
    .select("*")
    .single();

  return unwrap(result, "markGuildAutoRoleQueueItemCancelled");
}

async function postponeGuildAutoRoleQueueItem(queueId, { nextDueAt, lastError }) {
  const result = await supabase
    .from(AUTOROLE_QUEUE_TABLE)
    .update({
      status: "pending",
      due_at: nextDueAt,
      last_error: lastError || null,
    })
    .eq("id", queueId)
    .select("*")
    .single();

  return unwrap(result, "postponeGuildAutoRoleQueueItem");
}

async function rescheduleGuildAutoRoleQueueItem(queueId, {
  attemptCount,
  nextDueAt,
  lastError,
  finalFailure = false,
}) {
  const result = await supabase
    .from(AUTOROLE_QUEUE_TABLE)
    .update({
      status: finalFailure ? "failed" : "pending",
      attempt_count: attemptCount,
      due_at: nextDueAt,
      last_error: lastError || null,
      processed_at: finalFailure ? new Date().toISOString() : null,
    })
    .eq("id", queueId)
    .select("*")
    .single();

  return unwrap(result, "rescheduleGuildAutoRoleQueueItem");
}

async function closeTicketAsDeleted(ticketId) {
  const result = await supabase
    .from(TICKETS_TABLE)
    .update({
      status: "closed",
      closed_by: "system:channel_deleted",
      closed_at: new Date().toISOString(),
      transcript_file: null,
    })
    .eq("id", ticketId)
    .eq("status", "open")
    .select("*")
    .maybeSingle();

  return unwrap(result, "closeTicketAsDeleted");
}

async function registerEvent({
  ticketId,
  protocol,
  guildId,
  channelId,
  actorId,
  eventType,
  metadata = {},
}) {
  const result = await supabase.from(EVENTS_TABLE).insert({
    ticket_id: ticketId,
    protocol,
    guild_id: guildId,
    channel_id: channelId,
    actor_id: actorId,
    event_type: eventType,
    metadata,
  });

  unwrap(result, "registerEvent");
}

function isMissingDedicatedTicketAiColumns(error) {
  const message = String(error?.message || "").toLowerCase();
  const code = String(error?.code || "").toLowerCase();

  return (
    code === "42703" ||
    message.includes("ai_enabled") ||
    message.includes("ai_company_name") ||
    message.includes("ai_company_bio") ||
    message.includes("ai_tone")
  );
}

function expandLegacyTicketAiSettings(row) {
  const rawRules = typeof row?.ai_rules === "string" ? row.ai_rules.trim() : "";
  const base = {
    ...row,
    ai_rules: rawRules.startsWith("{") ? "" : rawRules,
    ai_enabled: false,
    ai_company_name: "",
    ai_company_bio: "",
    ai_tone: "formal",
  };

  if (!rawRules.startsWith("{")) {
    return base;
  }

  try {
    const parsed = JSON.parse(rawRules);
    return {
      ...base,
      ai_rules:
        typeof parsed?.rules === "string" ? parsed.rules.trim() : base.ai_rules,
      ai_enabled: parsed?.enabled === true,
      ai_company_name:
        typeof parsed?.companyName === "string"
          ? parsed.companyName.trim()
          : "",
      ai_company_bio:
        typeof parsed?.companyBio === "string"
          ? parsed.companyBio.trim()
          : "",
      ai_tone:
        typeof parsed?.tone === "string" && parsed.tone.trim().toLowerCase() === "friendly"
          ? "friendly"
          : "formal",
    };
  } catch {
    return base;
  }
}

async function getGuildTicketSettings(guildId) {
  const result = await supabase
    .from(TICKET_SETTINGS_TABLE)
    .select(
      "guild_id, enabled, menu_channel_id, tickets_category_id, logs_created_channel_id, logs_closed_channel_id, panel_layout, panel_title, panel_description, panel_button_label, panel_message_id, ai_rules, ai_enabled, ai_company_name, ai_company_bio, ai_tone, updated_at",
    )
    .eq("guild_id", guildId)
    .maybeSingle();

  if (!result.error) {
    return result.data;
  }

  if (!isMissingDedicatedTicketAiColumns(result.error)) {
    return unwrap(result, "getGuildTicketSettings");
  }

  const legacyResult = await supabase
    .from(TICKET_SETTINGS_TABLE)
    .select(
      "guild_id, enabled, menu_channel_id, tickets_category_id, logs_created_channel_id, logs_closed_channel_id, panel_layout, panel_title, panel_description, panel_button_label, panel_message_id, ai_rules, updated_at",
    )
    .eq("guild_id", guildId)
    .maybeSingle();

  const legacyRow = unwrap(legacyResult, "getGuildTicketSettingsLegacy");
  return legacyRow ? expandLegacyTicketAiSettings(legacyRow) : legacyRow;
}

async function getGuildTicketStaffSettings(guildId) {
  const result = await supabase
    .from(TICKET_STAFF_SETTINGS_TABLE)
    .select(
      "guild_id, admin_role_id, claim_role_ids, close_role_ids, notify_role_ids, updated_at",
    )
    .eq("guild_id", guildId)
    .maybeSingle();

  return unwrap(result, "getGuildTicketStaffSettings");
}

async function getGuildWelcomeSettings(guildId) {
  const result = await supabase
    .from(WELCOME_SETTINGS_TABLE)
    .select(
      "guild_id, enabled, entry_public_channel_id, entry_log_channel_id, exit_public_channel_id, exit_log_channel_id, entry_layout, exit_layout, entry_thumbnail_mode, exit_thumbnail_mode, updated_at",
    )
    .eq("guild_id", guildId)
    .maybeSingle();

  return unwrap(result, "getGuildWelcomeSettings");
}

async function getGuildCaptchaSettings(guildId) {
  const result = await supabase
    .from(CAPTCHA_SETTINGS_TABLE)
    .select(
      "guild_id, enabled, panel_channel_id, logs_channel_id, verified_role_ids, bypass_role_ids, panel_layout, panel_title, panel_description, panel_button_label, panel_message_id, challenge_title, challenge_description, max_attempts, timeout_seconds, kick_on_fail, success_message, updated_at",
    )
    .eq("guild_id", guildId)
    .maybeSingle();

  if (result.error) {
    const code = typeof result.error.code === "string" ? result.error.code : "";
    const message = String(result.error.message || "").toLowerCase();
    if (code === "42P01" || message.includes(CAPTCHA_SETTINGS_TABLE)) {
      return null;
    }
    return unwrap(result, "getGuildCaptchaSettings");
  }

  return result.data;
}

async function createGuildCaptchaSession(input) {
  const result = await supabase
    .from(CAPTCHA_SESSIONS_TABLE)
    .upsert(
      {
        guild_id: input.guildId,
        user_id: input.userId,
        correct_code: input.correctCode,
        option_codes: input.optionCodes,
        attempts_remaining: input.attemptsRemaining,
        expires_at: input.expiresAt,
      },
      { onConflict: "guild_id,user_id" },
    )
    .select(
      "guild_id, user_id, correct_code, option_codes, attempts_remaining, expires_at",
    )
    .single();

  return unwrap(result, "createGuildCaptchaSession");
}

async function getGuildCaptchaSession(guildId, userId) {
  const result = await supabase
    .from(CAPTCHA_SESSIONS_TABLE)
    .select(
      "guild_id, user_id, correct_code, option_codes, attempts_remaining, expires_at",
    )
    .eq("guild_id", guildId)
    .eq("user_id", userId)
    .maybeSingle();

  if (result.error) {
    const code = typeof result.error.code === "string" ? result.error.code : "";
    const message = String(result.error.message || "").toLowerCase();
    if (code === "42P01" || message.includes(CAPTCHA_SESSIONS_TABLE)) {
      return null;
    }
    return unwrap(result, "getGuildCaptchaSession");
  }

  return result.data;
}

async function deleteGuildCaptchaSession(guildId, userId) {
  const result = await supabase
    .from(CAPTCHA_SESSIONS_TABLE)
    .delete()
    .eq("guild_id", guildId)
    .eq("user_id", userId);

  if (result.error) {
    const code = typeof result.error.code === "string" ? result.error.code : "";
    const message = String(result.error.message || "").toLowerCase();
    if (code === "42P01" || message.includes(CAPTCHA_SESSIONS_TABLE)) {
      return null;
    }
    return unwrap(result, "deleteGuildCaptchaSession");
  }

  return result.data;
}

async function getGuildAntiLinkSettings(guildId) {
  const result = await supabase
    .from(ANTILINK_SETTINGS_TABLE)
    .select(
      "guild_id, enabled, log_channel_id, enforcement_action, timeout_minutes, ignored_role_ids, block_external_links, block_discord_invites, block_obfuscated_links, updated_at",
    )
    .eq("guild_id", guildId)
    .maybeSingle();

  return unwrap(result, "getGuildAntiLinkSettings");
}

async function getGuildAutoRoleSettings(guildId) {
  const result = await supabase
    .from(AUTOROLE_SETTINGS_TABLE)
    .select(
      "guild_id, enabled, role_ids, assignment_delay_minutes, existing_members_sync_requested_at, existing_members_sync_started_at, existing_members_sync_completed_at, existing_members_sync_status, existing_members_sync_error, updated_at",
    )
    .eq("guild_id", guildId)
    .maybeSingle();

  return unwrap(result, "getGuildAutoRoleSettings");
}

async function getPendingGuildAutoRoleSyncSettings(limit = 1) {
  const result = await supabase
    .from(AUTOROLE_SETTINGS_TABLE)
    .select(
      "guild_id, enabled, role_ids, assignment_delay_minutes, existing_members_sync_requested_at, existing_members_sync_started_at, existing_members_sync_completed_at, existing_members_sync_status, existing_members_sync_error, updated_at",
    )
    .eq("existing_members_sync_status", "pending")
    .order("existing_members_sync_requested_at", { ascending: true })
    .order("updated_at", { ascending: true })
    .limit(limit);

  return unwrap(result, "getPendingGuildAutoRoleSyncSettings") || [];
}

async function markGuildAutoRoleSyncProcessing(guildId) {
  const result = await supabase
    .from(AUTOROLE_SETTINGS_TABLE)
    .update({
      existing_members_sync_status: "processing",
      existing_members_sync_started_at: new Date().toISOString(),
      existing_members_sync_error: null,
    })
    .eq("guild_id", guildId)
    .select("*")
    .single();

  return unwrap(result, "markGuildAutoRoleSyncProcessing");
}

async function markGuildAutoRoleSyncCompleted(guildId) {
  const result = await supabase
    .from(AUTOROLE_SETTINGS_TABLE)
    .update({
      existing_members_sync_status: "completed",
      existing_members_sync_completed_at: new Date().toISOString(),
      existing_members_sync_error: null,
    })
    .eq("guild_id", guildId)
    .select("*")
    .single();

  return unwrap(result, "markGuildAutoRoleSyncCompleted");
}

async function markGuildAutoRoleSyncFailed(guildId, errorMessage) {
  const result = await supabase
    .from(AUTOROLE_SETTINGS_TABLE)
    .update({
      existing_members_sync_status: "failed",
      existing_members_sync_completed_at: new Date().toISOString(),
      existing_members_sync_error: String(errorMessage || "").slice(0, 450),
    })
    .eq("guild_id", guildId)
    .select("*")
    .single();

  return unwrap(result, "markGuildAutoRoleSyncFailed");
}

async function getGuildSecurityLogsSettings(guildId) {
  const result = await supabase
    .from(SECURITY_LOGS_SETTINGS_TABLE)
    .select(
      "guild_id, enabled, use_default_channel, default_channel_id, nickname_change_enabled, nickname_change_channel_id, avatar_change_enabled, avatar_change_channel_id, voice_join_enabled, voice_join_channel_id, voice_leave_enabled, voice_leave_channel_id, message_delete_enabled, message_delete_channel_id, message_edit_enabled, message_edit_channel_id, member_ban_enabled, member_ban_channel_id, member_unban_enabled, member_unban_channel_id, member_kick_enabled, member_kick_channel_id, member_timeout_enabled, member_timeout_channel_id, voice_move_enabled, voice_move_channel_id, voice_mute_enabled, voice_mute_channel_id, updated_at",
    )
    .eq("guild_id", guildId)
    .maybeSingle();

  return unwrap(result, "getGuildSecurityLogsSettings");
}

async function getApprovedPaymentOrdersForGuild(guildId) {
  const result = await supabase
    .from(PAYMENT_ORDERS_TABLE)
    .select("id, user_id, guild_id, plan_code, paid_at, created_at, expires_at, plan_billing_cycle_days")
    .eq("guild_id", guildId)
    .eq("status", "approved")
    .order("paid_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false });

  return unwrap(result, "getApprovedPaymentOrdersForGuild") || [];
}

async function getUserPlanSnapshotByDiscordUserId(discordUserId) {
  const normalizedDiscordUserId =
    typeof discordUserId === "string" ? discordUserId.trim() : "";
  if (!normalizedDiscordUserId) {
    return {
      hasPlan: false,
      hasPurchaseHistory: false,
      userId: null,
    };
  }

  const authUserResult = await supabase
    .from("auth_users")
    .select("id, discord_user_id")
    .eq("discord_user_id", normalizedDiscordUserId)
    .maybeSingle();

  const authUser = unwrap(authUserResult, "getUserPlanSnapshotByDiscordUserId.authUser");
  if (!authUser?.id) {
    return {
      hasPlan: false,
      hasPurchaseHistory: false,
      userId: null,
    };
  }

  const [approvedOrdersResult, userPlanState] = await Promise.all([
    supabase
      .from(PAYMENT_ORDERS_TABLE)
      .select(
        "id, user_id, plan_code, plan_name, paid_at, created_at, expires_at, amount, currency, plan_billing_cycle_days",
      )
      .eq("user_id", authUser.id)
      .eq("status", "approved")
      .order("paid_at", { ascending: false, nullsFirst: false })
      .order("created_at", { ascending: false }),
    getUserPlanStateByUserId(authUser.id),
  ]);

  const approvedOrders = unwrap(
    approvedOrdersResult,
    "getUserPlanSnapshotByDiscordUserId.approvedOrders",
  ) || [];

  if (!approvedOrders.length) {
    const accountLicense = resolvePlanStateLicenseStatus(userPlanState);
    if (accountLicense.status === "paid" || accountLicense.status === "expired") {
      const normalizedPlanCode = normalizePlanCode(userPlanState?.plan_code, "pro");
      const resolvedPlanName =
        typeof userPlanState?.plan_name === "string" && userPlanState.plan_name.trim()
          ? userPlanState.plan_name.trim()
          : resolvePlanNameFromOrder({ plan_code: normalizedPlanCode });

      return {
        hasPlan: true,
        hasPurchaseHistory: false,
        userId: authUser.id,
        planCode: normalizedPlanCode,
        planName: resolvedPlanName,
        status: accountLicense.status === "paid" ? "active" : "expired",
        rawStatus: accountLicense.status,
        expiresAt: userPlanState?.expires_at || null,
        purchasedAt: userPlanState?.activated_at || null,
        amount:
          typeof userPlanState?.amount === "number" &&
          Number.isFinite(userPlanState.amount)
            ? userPlanState.amount
            : null,
        currency:
          typeof userPlanState?.currency === "string" && userPlanState.currency.trim()
            ? userPlanState.currency.trim()
            : "BRL",
        billingCycleDays:
          typeof userPlanState?.billing_cycle_days === "number" &&
          Number.isFinite(userPlanState.billing_cycle_days)
            ? userPlanState.billing_cycle_days
            : null,
      };
    }

    return {
      hasPlan: false,
      hasPurchaseHistory: false,
      userId: authUser.id,
    };
  }

  const license = resolveLatestLicenseStatusFromApprovedOrders(approvedOrders);
  const latestCoverage = license.latestCoverage;
  const latestOrder = latestCoverage?.order || approvedOrders[0];
  const accountLicense = resolvePlanStateLicenseStatus(
    userPlanState,
    latestCoverage?.licenseStartsAtMs
      ? new Date(latestCoverage.licenseStartsAtMs).toISOString()
      : latestOrder?.paid_at || latestOrder?.created_at || null,
    latestCoverage?.licenseExpiresAtMs
      ? new Date(latestCoverage.licenseExpiresAtMs).toISOString()
      : latestOrder?.expires_at || null,
  );
  const resolvedAccountStatus =
    accountLicense.status === "not_paid" ? license.status : accountLicense.status;
  const normalizedPlanCode = normalizePlanCode(
    userPlanState?.plan_code || latestOrder?.plan_code,
    "pro",
  );
  const resolvedPlanName =
    (typeof userPlanState?.plan_name === "string" && userPlanState.plan_name.trim()) ||
    resolvePlanNameFromOrder(latestOrder);
  const expiresAtIso =
    userPlanState?.expires_at ||
    resolveExpiresAtIsoFromOrderOrCoverage(latestOrder, latestCoverage);
  const purchasedAtIso =
    userPlanState?.activated_at || latestOrder?.paid_at || latestOrder?.created_at || null;

  return {
    hasPlan: true,
    hasPurchaseHistory: true,
    userId: authUser.id,
    planCode: normalizedPlanCode,
    planName: resolvedPlanName,
    status: resolvedAccountStatus === "paid" ? "active" : "expired",
    rawStatus: resolvedAccountStatus,
    expiresAt: expiresAtIso,
    purchasedAt: purchasedAtIso,
    amount: (() => {
      const fromPlanState = Number(userPlanState?.amount);
      if (Number.isFinite(fromPlanState)) return fromPlanState;
      return typeof latestOrder?.amount === "number" && Number.isFinite(latestOrder.amount)
        ? latestOrder.amount
        : null;
    })(),
    currency:
      typeof userPlanState?.currency === "string" && userPlanState.currency.trim()
        ? userPlanState.currency.trim()
        : typeof latestOrder?.currency === "string" && latestOrder.currency.trim()
          ? latestOrder.currency.trim()
        : "BRL",
    billingCycleDays:
      typeof userPlanState?.billing_cycle_days === "number" &&
      Number.isFinite(userPlanState.billing_cycle_days)
        ? userPlanState.billing_cycle_days
        : typeof latestOrder?.plan_billing_cycle_days === "number" &&
            Number.isFinite(latestOrder.plan_billing_cycle_days)
          ? latestOrder.plan_billing_cycle_days
        : null,
  };
}

async function getAuthUserContactByDiscordUserId(discordUserId) {
  const normalizedDiscordUserId =
    typeof discordUserId === "string" ? discordUserId.trim() : "";
  if (!normalizedDiscordUserId) return null;

  const result = await supabase
    .from("auth_users")
    .select("id, discord_user_id, email, display_name, username")
    .eq("discord_user_id", normalizedDiscordUserId)
    .maybeSingle();

  return unwrap(result, "getAuthUserContactByDiscordUserId") || null;
}

async function getAuthUserContactById(authUserId) {
  const normalizedAuthUserId = Number(authUserId);
  if (!Number.isFinite(normalizedAuthUserId) || normalizedAuthUserId <= 0) return null;

  const result = await supabase
    .from("auth_users")
    .select("id, discord_user_id, email, display_name, username")
    .eq("id", normalizedAuthUserId)
    .maybeSingle();

  return unwrap(result, "getAuthUserContactById") || null;
}

async function getApprovedPaymentOrdersForGuildIds(guildIds) {
  const uniqueGuildIds = [...new Set((guildIds || []).filter(Boolean))];
  if (!uniqueGuildIds.length) {
    return new Map();
  }

  const result = await supabase
    .from(PAYMENT_ORDERS_TABLE)
    .select("id, user_id, guild_id, plan_code, paid_at, created_at, expires_at, plan_billing_cycle_days")
    .in("guild_id", uniqueGuildIds)
    .eq("status", "approved")
    .order("paid_at", { ascending: false, nullsFirst: false })
    .order("created_at", { ascending: false });

  const rows = unwrap(result, "getApprovedPaymentOrdersForGuildIds") || [];
  const ordersByGuild = new Map(uniqueGuildIds.map((guildId) => [guildId, []]));

  for (const row of rows) {
    if (!ordersByGuild.has(row.guild_id)) {
      ordersByGuild.set(row.guild_id, []);
    }

    ordersByGuild.get(row.guild_id).push(row);
  }

  return ordersByGuild;
}

async function loadGuildTicketRuntime(guildId) {
  const [settings, staffSettings, accountLicenseRuntime] = await Promise.all([
    getGuildTicketSettings(guildId),
    getGuildTicketStaffSettings(guildId),
    getGuildAccountLicenseRuntime(guildId),
  ]);

  return {
    guildId,
    settings: settings || null,
    staffSettings: staffSettings || null,
    licenseStatus: accountLicenseRuntime.licenseStatus,
    licenseUsable: accountLicenseRuntime.licenseUsable,
    latestCoverage: accountLicenseRuntime.latestCoverage,
    isConfigured: Boolean(settings && staffSettings),
  };
}

async function getGuildTicketRuntime(guildId) {
  return await withCachedResult(
    moduleRuntimeCache.ticket,
    moduleRuntimeInflight.ticket,
    guildId,
    MODULE_RUNTIME_CACHE_TTL_MS,
    () => loadGuildTicketRuntime(guildId),
  );
}

async function loadGuildWelcomeRuntime(guildId) {
  const [settings, accountLicenseRuntime] = await Promise.all([
    getGuildWelcomeSettings(guildId),
    getGuildAccountLicenseRuntime(guildId),
  ]);

  return {
    guildId,
    settings: settings || null,
    licenseStatus: accountLicenseRuntime.licenseStatus,
    licenseUsable: accountLicenseRuntime.licenseUsable,
    latestCoverage: accountLicenseRuntime.latestCoverage,
    isConfigured: Boolean(settings),
  };
}

async function getGuildWelcomeRuntime(guildId) {
  return await withCachedResult(
    moduleRuntimeCache.welcome,
    moduleRuntimeInflight.welcome,
    guildId,
    MODULE_RUNTIME_CACHE_TTL_MS,
    () => loadGuildWelcomeRuntime(guildId),
  );
}

async function loadGuildCaptchaRuntime(guildId) {
  const [settings, accountLicenseRuntime] = await Promise.all([
    getGuildCaptchaSettings(guildId),
    getGuildAccountLicenseRuntime(guildId),
  ]);

  return {
    guildId,
    settings: settings || null,
    licenseStatus: accountLicenseRuntime.licenseStatus,
    licenseUsable: accountLicenseRuntime.licenseUsable,
    latestCoverage: accountLicenseRuntime.latestCoverage,
    isConfigured: Boolean(
      settings?.enabled &&
        settings?.panel_channel_id &&
        Array.isArray(settings?.verified_role_ids) &&
        settings.verified_role_ids.length,
    ),
  };
}

async function getGuildCaptchaRuntime(guildId) {
  return await withCachedResult(
    moduleRuntimeCache.captcha,
    moduleRuntimeInflight.captcha,
    guildId,
    MODULE_RUNTIME_CACHE_TTL_MS,
    () => loadGuildCaptchaRuntime(guildId),
  );
}

async function loadGuildAntiLinkRuntime(guildId) {
  const [settings, accountLicenseRuntime] = await Promise.all([
    getGuildAntiLinkSettings(guildId),
    getGuildAccountLicenseRuntime(guildId),
  ]);

  return {
    guildId,
    settings: settings || null,
    licenseStatus: accountLicenseRuntime.licenseStatus,
    licenseUsable: accountLicenseRuntime.licenseUsable,
    latestCoverage: accountLicenseRuntime.latestCoverage,
    isConfigured: Boolean(settings),
  };
}

async function getGuildAntiLinkRuntime(guildId) {
  return await withCachedResult(
    moduleRuntimeCache.antiLink,
    moduleRuntimeInflight.antiLink,
    guildId,
    MODULE_RUNTIME_CACHE_TTL_MS,
    () => loadGuildAntiLinkRuntime(guildId),
  );
}

async function loadGuildAutoRoleRuntime(guildId) {
  const [settings, accountLicenseRuntime] = await Promise.all([
    getGuildAutoRoleSettings(guildId),
    getGuildAccountLicenseRuntime(guildId),
  ]);

  return {
    guildId,
    settings: settings || null,
    licenseStatus: accountLicenseRuntime.licenseStatus,
    licenseUsable: accountLicenseRuntime.licenseUsable,
    latestCoverage: accountLicenseRuntime.latestCoverage,
    isConfigured: Boolean(settings),
  };
}

async function getGuildAutoRoleRuntime(guildId) {
  return await withCachedResult(
    moduleRuntimeCache.autoRole,
    moduleRuntimeInflight.autoRole,
    guildId,
    MODULE_RUNTIME_CACHE_TTL_MS,
    () => loadGuildAutoRoleRuntime(guildId),
  );
}

async function loadGuildSecurityLogsRuntime(guildId) {
  const [settings, accountLicenseRuntime] = await Promise.all([
    getGuildSecurityLogsSettings(guildId),
    getGuildAccountLicenseRuntime(guildId),
  ]);

  return {
    guildId,
    settings: settings || null,
    licenseStatus: accountLicenseRuntime.licenseStatus,
    licenseUsable: accountLicenseRuntime.licenseUsable,
    latestCoverage: accountLicenseRuntime.latestCoverage,
    isConfigured: Boolean(settings),
  };
}

async function getGuildSecurityLogsRuntime(guildId) {
  return await withCachedResult(
    moduleRuntimeCache.securityLogs,
    moduleRuntimeInflight.securityLogs,
    guildId,
    MODULE_RUNTIME_CACHE_TTL_MS,
    () => loadGuildSecurityLogsRuntime(guildId),
  );
}

async function loadConfiguredTicketGuildRuntimes() {
  const [settingsResult, staffResult] = await Promise.all([
    supabase
      .from(TICKET_SETTINGS_TABLE)
      .select(
        "guild_id, enabled, menu_channel_id, tickets_category_id, logs_created_channel_id, logs_closed_channel_id, panel_layout, panel_title, panel_description, panel_button_label, panel_message_id, ai_rules, ai_enabled, ai_company_name, ai_company_bio, ai_tone, updated_at",
      ),
    supabase
      .from(TICKET_STAFF_SETTINGS_TABLE)
      .select(
        "guild_id, admin_role_id, claim_role_ids, close_role_ids, notify_role_ids, updated_at",
      ),
  ]);

  const settingsRows = unwrap(settingsResult, "getConfiguredTicketGuildRuntimes.settings") || [];
  const staffRows = unwrap(staffResult, "getConfiguredTicketGuildRuntimes.staff") || [];
  const accountLicenseRuntimeByGuild = await getGuildAccountLicenseRuntimeMap(
    settingsRows.map((row) => row.guild_id),
  );

  const staffByGuild = new Map(staffRows.map((row) => [row.guild_id, row]));
  const runtimes = settingsRows.map((settingsRow) => {
    const accountLicenseRuntime =
      accountLicenseRuntimeByGuild.get(settingsRow.guild_id) || {
        licenseStatus: "not_paid",
        licenseUsable: false,
        latestCoverage: null,
      };
    const staffSettings = staffByGuild.get(settingsRow.guild_id) || null;

    return {
      guildId: settingsRow.guild_id,
      settings: settingsRow,
      staffSettings,
      licenseStatus: accountLicenseRuntime.licenseStatus,
      licenseUsable: accountLicenseRuntime.licenseUsable,
      latestCoverage: accountLicenseRuntime.latestCoverage,
      isConfigured: Boolean(settingsRow && staffSettings),
    };
  });

  return runtimes.filter((runtime) => runtime.settings);
}

async function getConfiguredTicketGuildRuntimes() {
  if (
    configuredTicketGuildRuntimesCache &&
    configuredTicketGuildRuntimesCache.expiresAt > Date.now()
  ) {
    return cloneCachedValue(configuredTicketGuildRuntimesCache.value);
  }

  if (configuredTicketGuildRuntimesInflight) {
    return cloneCachedValue(await configuredTicketGuildRuntimesInflight);
  }

  configuredTicketGuildRuntimesInflight = loadConfiguredTicketGuildRuntimes();

  try {
    const runtimes = await configuredTicketGuildRuntimesInflight;
    configuredTicketGuildRuntimesCache = {
      expiresAt: Date.now() + CONFIGURED_TICKET_GUILDS_CACHE_TTL_MS,
      value: cloneCachedValue(runtimes),
    };
    return cloneCachedValue(runtimes);
  } finally {
    configuredTicketGuildRuntimesInflight = null;
  }
}

async function updateGuildTicketPanelMessageId(guildId, panelMessageId) {
  const result = await supabase
    .from(TICKET_SETTINGS_TABLE)
    .update({
      panel_message_id: panelMessageId || null,
    })
    .eq("guild_id", guildId)
    .select("guild_id, panel_message_id")
    .single();

  return unwrap(result, "updateGuildTicketPanelMessageId");
}

async function loadConfiguredCaptchaGuildRuntimes() {
  const result = await supabase
    .from(CAPTCHA_SETTINGS_TABLE)
    .select(
      "guild_id, enabled, panel_channel_id, logs_channel_id, verified_role_ids, bypass_role_ids, panel_layout, panel_title, panel_description, panel_button_label, panel_message_id, challenge_title, challenge_description, max_attempts, timeout_seconds, kick_on_fail, success_message, updated_at",
    )
    .eq("enabled", true);

  if (result.error) {
    const code = typeof result.error.code === "string" ? result.error.code : "";
    const message = String(result.error.message || "").toLowerCase();
    if (code === "42P01" || message.includes(CAPTCHA_SETTINGS_TABLE)) {
      return [];
    }
    return unwrap(result, "loadConfiguredCaptchaGuildRuntimes");
  }

  const settingsRows = result.data || [];
  const accountLicenseRuntimeByGuild = await getGuildAccountLicenseRuntimeMap(
    settingsRows.map((row) => row.guild_id),
  );

  return settingsRows
    .map((settingsRow) => {
      const accountLicenseRuntime =
        accountLicenseRuntimeByGuild.get(settingsRow.guild_id) || {
          licenseStatus: "not_paid",
          licenseUsable: false,
          latestCoverage: null,
        };

      return {
        guildId: settingsRow.guild_id,
        settings: settingsRow,
        licenseStatus: accountLicenseRuntime.licenseStatus,
        licenseUsable: accountLicenseRuntime.licenseUsable,
        latestCoverage: accountLicenseRuntime.latestCoverage,
        isConfigured: Boolean(
          settingsRow.panel_channel_id &&
            Array.isArray(settingsRow.verified_role_ids) &&
            settingsRow.verified_role_ids.length,
        ),
      };
    })
    .filter((runtime) => runtime.settings);
}

async function getConfiguredCaptchaGuildRuntimes() {
  return loadConfiguredCaptchaGuildRuntimes();
}

async function updateGuildCaptchaPanelMessageId(guildId, panelMessageId) {
  const result = await supabase
    .from(CAPTCHA_SETTINGS_TABLE)
    .update({
      panel_message_id: panelMessageId || null,
    })
    .eq("guild_id", guildId)
    .select("guild_id, panel_message_id")
    .single();

  if (result.error) {
    const code = typeof result.error.code === "string" ? result.error.code : "";
    const message = String(result.error.message || "").toLowerCase();
    if (code === "42P01" || message.includes(CAPTCHA_SETTINGS_TABLE)) {
      return null;
    }
    return unwrap(result, "updateGuildCaptchaPanelMessageId");
  }

  return result.data;
}

async function getGuildSuggestionsSettings(guildId) {
  const result = await supabase
    .from(SUGGESTIONS_SETTINGS_TABLE)
    .select(
      "guild_id, enabled, panel_channel_id, publish_channel_id, logs_channel_id, panel_layout, panel_title, panel_description, panel_button_label, panel_message_id, suggestion_layout, published_header, published_footer, thread_name_prefix, updated_at",
    )
    .eq("guild_id", guildId)
    .maybeSingle();

  if (result.error) {
    const code = typeof result.error.code === "string" ? result.error.code : "";
    const message = String(result.error.message || "").toLowerCase();
    if (code === "42P01" || message.includes(SUGGESTIONS_SETTINGS_TABLE)) {
      return null;
    }
    return unwrap(result, "getGuildSuggestionsSettings");
  }

  return result.data;
}

async function loadGuildSuggestionsRuntime(guildId) {
  const [settings, accountLicenseRuntime] = await Promise.all([
    getGuildSuggestionsSettings(guildId),
    getGuildAccountLicenseRuntime(guildId),
  ]);

  return {
    guildId,
    settings: settings || null,
    licenseStatus: accountLicenseRuntime.licenseStatus,
    licenseUsable: accountLicenseRuntime.licenseUsable,
    latestCoverage: accountLicenseRuntime.latestCoverage,
    isConfigured: Boolean(
      settings?.enabled &&
        settings?.panel_channel_id &&
        settings?.publish_channel_id,
    ),
  };
}

async function getGuildSuggestionsRuntime(guildId) {
  return await withCachedResult(
    moduleRuntimeCache.suggestions,
    moduleRuntimeInflight.suggestions,
    guildId,
    MODULE_RUNTIME_CACHE_TTL_MS,
    () => loadGuildSuggestionsRuntime(guildId),
  );
}

async function loadConfiguredSuggestionsGuildRuntimes() {
  const result = await supabase
    .from(SUGGESTIONS_SETTINGS_TABLE)
    .select(
      "guild_id, enabled, panel_channel_id, publish_channel_id, logs_channel_id, panel_layout, panel_title, panel_description, panel_button_label, panel_message_id, suggestion_layout, published_header, published_footer, thread_name_prefix, updated_at",
    )
    .eq("enabled", true);

  if (result.error) {
    const code = typeof result.error.code === "string" ? result.error.code : "";
    const message = String(result.error.message || "").toLowerCase();
    if (code === "42P01" || message.includes(SUGGESTIONS_SETTINGS_TABLE)) {
      return [];
    }
    return unwrap(result, "loadConfiguredSuggestionsGuildRuntimes");
  }

  const settingsRows = result.data || [];
  const accountLicenseRuntimeByGuild = await getGuildAccountLicenseRuntimeMap(
    settingsRows.map((row) => row.guild_id),
  );

  return settingsRows
    .map((settingsRow) => {
      const accountLicenseRuntime =
        accountLicenseRuntimeByGuild.get(settingsRow.guild_id) || {
          licenseStatus: "not_paid",
          licenseUsable: false,
          latestCoverage: null,
        };

      return {
        guildId: settingsRow.guild_id,
        settings: settingsRow,
        licenseStatus: accountLicenseRuntime.licenseStatus,
        licenseUsable: accountLicenseRuntime.licenseUsable,
        latestCoverage: accountLicenseRuntime.latestCoverage,
        isConfigured: Boolean(
          settingsRow.panel_channel_id && settingsRow.publish_channel_id,
        ),
      };
    })
    .filter((runtime) => runtime.settings);
}

async function getConfiguredSuggestionsGuildRuntimes() {
  return loadConfiguredSuggestionsGuildRuntimes();
}

async function updateGuildSuggestionsPanelMessageId(guildId, panelMessageId) {
  const result = await supabase
    .from(SUGGESTIONS_SETTINGS_TABLE)
    .update({
      panel_message_id: panelMessageId || null,
    })
    .eq("guild_id", guildId)
    .select("guild_id, panel_message_id")
    .single();

  if (result.error) {
    const code = typeof result.error.code === "string" ? result.error.code : "";
    const message = String(result.error.message || "").toLowerCase();
    if (code === "42P01" || message.includes(SUGGESTIONS_SETTINGS_TABLE)) {
      return null;
    }
    return unwrap(result, "updateGuildSuggestionsPanelMessageId");
  }

  return result.data;
}

async function createGuildSuggestion(input) {
  const result = await supabase
    .from(SUGGESTIONS_TABLE)
    .insert({
      guild_id: input.guildId,
      author_user_id: input.authorUserId,
      title: input.title,
      body: input.body,
      status: input.status || "open",
      publish_channel_id: input.publishChannelId || null,
    })
    .select(
      "id, guild_id, author_user_id, title, body, status, publish_channel_id, message_id, thread_id, yes_votes, no_votes, created_at, updated_at",
    )
    .single();

  return unwrap(result, "createGuildSuggestion");
}

async function getGuildSuggestionById(suggestionId) {
  const result = await supabase
    .from(SUGGESTIONS_TABLE)
    .select(
      "id, guild_id, author_user_id, title, body, status, publish_channel_id, message_id, thread_id, yes_votes, no_votes, created_at, updated_at",
    )
    .eq("id", suggestionId)
    .maybeSingle();

  if (result.error) {
    const code = typeof result.error.code === "string" ? result.error.code : "";
    const message = String(result.error.message || "").toLowerCase();
    if (code === "42P01" || message.includes(SUGGESTIONS_TABLE)) {
      return null;
    }
    return unwrap(result, "getGuildSuggestionById");
  }

  return result.data;
}

async function getGuildSuggestionByMessageId(guildId, messageId) {
  if (!guildId || !messageId) {
    return null;
  }

  const result = await supabase
    .from(SUGGESTIONS_TABLE)
    .select(
      "id, guild_id, author_user_id, title, body, status, publish_channel_id, message_id, thread_id, yes_votes, no_votes, created_at, updated_at",
    )
    .eq("guild_id", guildId)
    .eq("message_id", String(messageId))
    .maybeSingle();

  if (result.error) {
    const code = typeof result.error.code === "string" ? result.error.code : "";
    const message = String(result.error.message || "").toLowerCase();
    if (code === "42P01" || message.includes(SUGGESTIONS_TABLE)) {
      return null;
    }
    return unwrap(result, "getGuildSuggestionByMessageId");
  }

  return result.data;
}

async function getOpenGuildSuggestionByMessageId(messageId) {
  if (!messageId) {
    return null;
  }

  const result = await supabase
    .from(SUGGESTIONS_TABLE)
    .select(
      "id, guild_id, author_user_id, title, body, status, publish_channel_id, message_id, thread_id, yes_votes, no_votes, created_at, updated_at",
    )
    .eq("message_id", String(messageId))
    .eq("status", "open")
    .maybeSingle();

  if (result.error) {
    const code = typeof result.error.code === "string" ? result.error.code : "";
    const message = String(result.error.message || "").toLowerCase();
    if (code === "42P01" || message.includes(SUGGESTIONS_TABLE)) {
      return null;
    }
    return unwrap(result, "getOpenGuildSuggestionByMessageId");
  }

  return result.data;
}

async function getGuildSuggestionByThreadId(guildId, threadId) {
  if (!guildId || !threadId) {
    return null;
  }

  const result = await supabase
    .from(SUGGESTIONS_TABLE)
    .select(
      "id, guild_id, author_user_id, title, body, status, publish_channel_id, message_id, thread_id, yes_votes, no_votes, created_at, updated_at",
    )
    .eq("guild_id", guildId)
    .eq("thread_id", threadId)
    .maybeSingle();

  if (result.error) {
    const code = typeof result.error.code === "string" ? result.error.code : "";
    const message = String(result.error.message || "").toLowerCase();
    if (code === "42P01" || message.includes(SUGGESTIONS_TABLE)) {
      return null;
    }
    return unwrap(result, "getGuildSuggestionByThreadId");
  }

  return result.data;
}

async function closeGuildSuggestionAsRemoved(suggestionId) {
  if (!suggestionId) {
    return null;
  }

  const result = await supabase
    .from(SUGGESTIONS_TABLE)
    .update({
      status: "closed",
      message_id: null,
      thread_id: null,
    })
    .eq("id", suggestionId)
    .select(
      "id, guild_id, author_user_id, title, body, status, publish_channel_id, message_id, thread_id, yes_votes, no_votes, created_at, updated_at",
    )
    .maybeSingle();

  if (result.error) {
    const code = typeof result.error.code === "string" ? result.error.code : "";
    const message = String(result.error.message || "").toLowerCase();
    if (code === "42P01" || message.includes(SUGGESTIONS_TABLE)) {
      return null;
    }
    return unwrap(result, "closeGuildSuggestionAsRemoved");
  }

  return result.data;
}

async function updateGuildSuggestionMessageIds(suggestionId, input = {}) {
  const payload = {};
  if (input.messageId !== undefined) payload.message_id = input.messageId || null;
  if (input.threadId !== undefined) payload.thread_id = input.threadId || null;
  if (input.yesVotes !== undefined) payload.yes_votes = input.yesVotes;
  if (input.noVotes !== undefined) payload.no_votes = input.noVotes;

  const result = await supabase
    .from(SUGGESTIONS_TABLE)
    .update(payload)
    .eq("id", suggestionId)
    .select(
      "id, guild_id, author_user_id, title, body, status, publish_channel_id, message_id, thread_id, yes_votes, no_votes, created_at, updated_at",
    )
    .single();

  return unwrap(result, "updateGuildSuggestionMessageIds");
}

async function createGuildSuggestionVoteEvent(input) {
  const result = await supabase
    .from(SUGGESTION_VOTE_EVENTS_TABLE)
    .insert({
      suggestion_id: input.suggestionId,
      guild_id: input.guildId,
      user_id: input.userId,
      previous_vote: input.previousVote || null,
      new_vote: input.newVote || null,
      action: input.action,
    })
    .select("id, suggestion_id, guild_id, user_id, previous_vote, new_vote, action, created_at")
    .single();

  return unwrap(result, "createGuildSuggestionVoteEvent");
}

async function upsertGuildSuggestionVote(input) {
  const existingResult = await supabase
    .from(SUGGESTION_VOTES_TABLE)
    .select("id, suggestion_id, guild_id, user_id, vote")
    .eq("suggestion_id", input.suggestionId)
    .eq("user_id", input.userId)
    .maybeSingle();

  if (existingResult.error) {
    return unwrap(existingResult, "upsertGuildSuggestionVote.lookup");
  }

  const previousVote = existingResult.data?.vote || null;
  const newVote = input.vote;

  let action = "cast";
  if (previousVote && previousVote !== newVote) {
    action = "change";
  } else if (previousVote === newVote) {
    action = "cast";
  }

  const upsertResult = await supabase
    .from(SUGGESTION_VOTES_TABLE)
    .upsert(
      {
        suggestion_id: input.suggestionId,
        guild_id: input.guildId,
        user_id: input.userId,
        vote: newVote,
      },
      { onConflict: "suggestion_id,user_id" },
    )
    .select("id, suggestion_id, guild_id, user_id, vote, created_at, updated_at")
    .single();

  const voteRow = unwrap(upsertResult, "upsertGuildSuggestionVote.upsert");

  if (!previousVote || previousVote !== newVote) {
    await createGuildSuggestionVoteEvent({
      suggestionId: input.suggestionId,
      guildId: input.guildId,
      userId: input.userId,
      previousVote,
      newVote,
      action: previousVote ? "change" : "cast",
    });
  }

  const counts = await getGuildSuggestionVoteCounts(input.suggestionId);
  await updateGuildSuggestionMessageIds(input.suggestionId, {
    yesVotes: counts.yes,
    noVotes: counts.no,
  });

  return {
    vote: voteRow,
    previousVote,
    action: previousVote && previousVote !== newVote ? "change" : previousVote ? "cast" : "cast",
    counts,
  };
}

async function getGuildSuggestionVotes(suggestionId) {
  const result = await supabase
    .from(SUGGESTION_VOTES_TABLE)
    .select("id, suggestion_id, guild_id, user_id, vote, created_at, updated_at")
    .eq("suggestion_id", suggestionId)
    .order("created_at", { ascending: true });

  if (result.error) {
    const code = typeof result.error.code === "string" ? result.error.code : "";
    const message = String(result.error.message || "").toLowerCase();
    if (code === "42P01" || message.includes(SUGGESTION_VOTES_TABLE)) {
      return [];
    }
    return unwrap(result, "getGuildSuggestionVotes");
  }

  return result.data || [];
}

async function getGuildSuggestionVoteCounts(suggestionId) {
  const votes = await getGuildSuggestionVotes(suggestionId);
  let yes = 0;
  let no = 0;

  for (const voteRow of votes) {
    if (voteRow.vote === "yes") yes += 1;
    if (voteRow.vote === "no") no += 1;
  }

  return { yes, no, total: yes + no };
}

async function createGuildSuggestionVoteLog(input) {
  const result = await supabase
    .from(SUGGESTION_VOTE_EVENTS_TABLE)
    .insert({
      suggestion_id: input.suggestionId,
      guild_id: input.guildId,
      user_id: input.userId,
      previous_vote: input.previousVote || null,
      new_vote: input.newVote || null,
      action: input.action || "cast",
    })
    .select("id, suggestion_id, guild_id, user_id, previous_vote, new_vote, action, created_at")
    .single();

  return unwrap(result, "createGuildSuggestionVoteLog");
}

async function getGuildBatePontoSettings(guildId) {
  const result = await supabase
    .from(BATE_PONTO_SETTINGS_TABLE)
    .select(BATE_PONTO_SETTINGS_SELECT)
    .eq("guild_id", guildId)
    .maybeSingle();

  if (result.error) {
    const code = typeof result.error.code === "string" ? result.error.code : "";
    const message = String(result.error.message || "").toLowerCase();
    if (code === "42P01" || message.includes(BATE_PONTO_SETTINGS_TABLE)) {
      return null;
    }
    return unwrap(result, "getGuildBatePontoSettings");
  }

  return result.data;
}

async function loadGuildBatePontoRuntime(guildId) {
  const [settings, accountLicenseRuntime] = await Promise.all([
    getGuildBatePontoSettings(guildId),
    getGuildAccountLicenseRuntime(guildId),
  ]);

  return {
    guildId,
    settings: settings || null,
    licenseStatus: accountLicenseRuntime.licenseStatus,
    licenseUsable: accountLicenseRuntime.licenseUsable,
    latestCoverage: accountLicenseRuntime.latestCoverage,
    isConfigured: Boolean(settings?.enabled && settings?.panel_channel_id),
  };
}

async function getGuildBatePontoRuntime(guildId) {
  return await withCachedResult(
    moduleRuntimeCache.batePonto,
    moduleRuntimeInflight.batePonto,
    guildId,
    MODULE_RUNTIME_CACHE_TTL_MS,
    () => loadGuildBatePontoRuntime(guildId),
  );
}

async function loadConfiguredBatePontoGuildRuntimes() {
  const result = await supabase
    .from(BATE_PONTO_SETTINGS_TABLE)
    .select(BATE_PONTO_SETTINGS_SELECT)
    .eq("enabled", true);

  if (result.error) {
    const code = typeof result.error.code === "string" ? result.error.code : "";
    const message = String(result.error.message || "").toLowerCase();
    if (code === "42P01" || message.includes(BATE_PONTO_SETTINGS_TABLE)) {
      return [];
    }
    return unwrap(result, "loadConfiguredBatePontoGuildRuntimes");
  }

  const settingsRows = result.data || [];
  const accountLicenseRuntimeByGuild = await getGuildAccountLicenseRuntimeMap(
    settingsRows.map((row) => row.guild_id),
  );

  return settingsRows
    .map((settingsRow) => {
      const accountLicenseRuntime =
        accountLicenseRuntimeByGuild.get(settingsRow.guild_id) || {
          licenseStatus: "not_paid",
          licenseUsable: false,
          latestCoverage: null,
        };

      return {
        guildId: settingsRow.guild_id,
        settings: settingsRow,
        licenseStatus: accountLicenseRuntime.licenseStatus,
        licenseUsable: accountLicenseRuntime.licenseUsable,
        latestCoverage: accountLicenseRuntime.latestCoverage,
        isConfigured: Boolean(settingsRow.panel_channel_id),
      };
    })
    .filter((runtime) => runtime.settings);
}

async function getConfiguredBatePontoGuildRuntimes() {
  return loadConfiguredBatePontoGuildRuntimes();
}

async function updateGuildBatePontoPanelMessageId(guildId, panelMessageId) {
  const result = await supabase
    .from(BATE_PONTO_SETTINGS_TABLE)
    .update({
      panel_message_id: panelMessageId || null,
    })
    .eq("guild_id", guildId)
    .select("guild_id, panel_message_id")
    .single();

  if (result.error) {
    const code = typeof result.error.code === "string" ? result.error.code : "";
    const message = String(result.error.message || "").toLowerCase();
    if (code === "42P01" || message.includes(BATE_PONTO_SETTINGS_TABLE)) {
      return null;
    }
    return unwrap(result, "updateGuildBatePontoPanelMessageId");
  }

  return result.data;
}

async function getActiveGuildBatePontoSession(guildId, userId) {
  if (!guildId || !userId) {
    return null;
  }

  const result = await supabase
    .from(BATE_PONTO_SESSIONS_TABLE)
    .select(BATE_PONTO_SESSION_SELECT)
    .eq("guild_id", guildId)
    .eq("user_id", userId)
    .in("status", ["active", "on_break"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (result.error) {
    const code = typeof result.error.code === "string" ? result.error.code : "";
    const message = String(result.error.message || "").toLowerCase();
    if (code === "42P01" || message.includes(BATE_PONTO_SESSIONS_TABLE)) {
      return null;
    }
    return unwrap(result, "getActiveGuildBatePontoSession");
  }

  return result.data;
}

async function createGuildBatePontoSession(input) {
  const now = input.startedAt || new Date().toISOString();
  const result = await supabase
    .from(BATE_PONTO_SESSIONS_TABLE)
    .insert({
      guild_id: input.guildId,
      user_id: input.userId,
      status: input.status || "active",
      started_at: now,
      last_action_at: now,
      worked_seconds: 0,
      break_seconds: 0,
      break_started_at: null,
    })
    .select(BATE_PONTO_SESSION_SELECT)
    .single();

  if (result.error) {
    const code = typeof result.error.code === "string" ? result.error.code : "";
    const message = String(result.error.message || "").toLowerCase();
    if (code === "42P01" || message.includes(BATE_PONTO_SESSIONS_TABLE)) {
      return null;
    }
    return unwrap(result, "createGuildBatePontoSession");
  }

  return result.data;
}

async function updateGuildBatePontoSession(sessionId, input = {}) {
  if (!sessionId) {
    return null;
  }

  const patch = {};
  if (input.status !== undefined) patch.status = input.status;
  if (input.lastActionAt !== undefined) patch.last_action_at = input.lastActionAt;
  if (input.workedSeconds !== undefined) patch.worked_seconds = input.workedSeconds;
  if (input.breakSeconds !== undefined) patch.break_seconds = input.breakSeconds;
  if (input.breakStartedAt !== undefined) patch.break_started_at = input.breakStartedAt;
  if (input.endedAt !== undefined) patch.ended_at = input.endedAt;
  if (input.voiceChannelId !== undefined) patch.voice_channel_id = input.voiceChannelId;
  if (input.voiceLeftAt !== undefined) patch.voice_left_at = input.voiceLeftAt;
  if (input.voiceWarningSentAt !== undefined) {
    patch.voice_warning_sent_at = input.voiceWarningSentAt;
  }

  if (!Object.keys(patch).length) {
    return null;
  }

  const result = await supabase
    .from(BATE_PONTO_SESSIONS_TABLE)
    .update(patch)
    .eq("id", sessionId)
    .select(BATE_PONTO_SESSION_SELECT)
    .single();

  if (result.error) {
    const code = typeof result.error.code === "string" ? result.error.code : "";
    const message = String(result.error.message || "").toLowerCase();
    if (code === "42P01" || message.includes(BATE_PONTO_SESSIONS_TABLE)) {
      return null;
    }
    return unwrap(result, "updateGuildBatePontoSession");
  }

  return result.data;
}

async function finishGuildBatePontoSession(sessionId, input = {}) {
  const now = input.endedAt || new Date().toISOString();
  return updateGuildBatePontoSession(sessionId, {
    status: "finished",
    endedAt: now,
    lastActionAt: now,
    workedSeconds: input.workedSeconds,
    breakSeconds: input.breakSeconds,
    breakStartedAt: null,
    voiceChannelId: null,
    voiceLeftAt: null,
    voiceWarningSentAt: null,
  });
}

async function listOpenGuildBatePontoSessionsWithVoiceAbsence() {
  const result = await supabase
    .from(BATE_PONTO_SESSIONS_TABLE)
    .select(BATE_PONTO_SESSION_SELECT)
    .in("status", ["active", "on_break"])
    .not("voice_left_at", "is", null);

  if (result.error) {
    const code = typeof result.error.code === "string" ? result.error.code : "";
    const message = String(result.error.message || "").toLowerCase();
    if (code === "42P01" || message.includes(BATE_PONTO_SESSIONS_TABLE)) {
      return [];
    }
    if (code === "42703" || message.includes("voice_left_at")) {
      return [];
    }
    return unwrap(result, "listOpenGuildBatePontoSessionsWithVoiceAbsence");
  }

  return result.data || [];
}

async function createGuildBatePontoEvent(input) {
  const result = await supabase
    .from(BATE_PONTO_EVENTS_TABLE)
    .insert({
      guild_id: input.guildId,
      user_id: input.userId,
      session_id: input.sessionId || null,
      action: input.action,
      worked_seconds: Number(input.workedSeconds || 0),
      break_seconds: Number(input.breakSeconds || 0),
      hour_bank_delta_seconds: Number(input.hourBankDeltaSeconds || 0),
      note: input.note || null,
    })
    .select(BATE_PONTO_EVENT_SELECT)
    .single();

  if (result.error) {
    const code = typeof result.error.code === "string" ? result.error.code : "";
    const message = String(result.error.message || "").toLowerCase();
    if (code === "42P01" || message.includes(BATE_PONTO_EVENTS_TABLE)) {
      return null;
    }
    return unwrap(result, "createGuildBatePontoEvent");
  }

  return result.data;
}

async function getGuildBatePontoHourBank(guildId, userId) {
  if (!guildId || !userId) {
    return null;
  }

  const result = await supabase
    .from(BATE_PONTO_HOUR_BANK_TABLE)
    .select("id, guild_id, user_id, balance_seconds, created_at, updated_at")
    .eq("guild_id", guildId)
    .eq("user_id", userId)
    .maybeSingle();

  if (result.error) {
    const code = typeof result.error.code === "string" ? result.error.code : "";
    const message = String(result.error.message || "").toLowerCase();
    if (code === "42P01" || message.includes(BATE_PONTO_HOUR_BANK_TABLE)) {
      return null;
    }
    return unwrap(result, "getGuildBatePontoHourBank");
  }

  return result.data;
}

async function upsertGuildBatePontoHourBank(input) {
  const result = await supabase
    .from(BATE_PONTO_HOUR_BANK_TABLE)
    .upsert(
      {
        guild_id: input.guildId,
        user_id: input.userId,
        balance_seconds: Number(input.balanceSeconds || 0),
      },
      { onConflict: "guild_id,user_id" },
    )
    .select("id, guild_id, user_id, balance_seconds, created_at, updated_at")
    .single();

  if (result.error) {
    const code = typeof result.error.code === "string" ? result.error.code : "";
    const message = String(result.error.message || "").toLowerCase();
    if (code === "42P01" || message.includes(BATE_PONTO_HOUR_BANK_TABLE)) {
      return null;
    }
    return unwrap(result, "upsertGuildBatePontoHourBank");
  }

  return result.data;
}

async function getGuildBatePontoRanking(guildId, options = {}) {
  if (!guildId) {
    return [];
  }

  const limit = Math.min(Math.max(Number(options.limit) || 10, 1), 100);
  const periodDays = Math.max(Number(options.periodDays) || 30, 1);
  const since = new Date(Date.now() - periodDays * 24 * 60 * 60 * 1000).toISOString();

  const result = await supabase
    .from(BATE_PONTO_SESSIONS_TABLE)
    .select("user_id, worked_seconds")
    .eq("guild_id", guildId)
    .eq("status", "finished")
    .gte("ended_at", since);

  if (result.error) {
    const code = typeof result.error.code === "string" ? result.error.code : "";
    const message = String(result.error.message || "").toLowerCase();
    if (code === "42P01" || message.includes(BATE_PONTO_SESSIONS_TABLE)) {
      return [];
    }
    return unwrap(result, "getGuildBatePontoRanking");
  }

  const totalsByUser = new Map();
  for (const row of result.data || []) {
    const current = totalsByUser.get(row.user_id) || 0;
    totalsByUser.set(row.user_id, current + Number(row.worked_seconds || 0));
  }

  return [...totalsByUser.entries()]
    .map(([userId, workedSeconds]) => ({ userId, workedSeconds }))
    .sort((a, b) => b.workedSeconds - a.workedSeconds)
    .slice(0, limit);
}

async function getGuildBatePontoHistory(guildId, options = {}) {
  if (!guildId) {
    return [];
  }

  const limit = Math.min(Math.max(Number(options.limit) || 25, 1), 100);
  const offset = Math.max(Number(options.offset) || 0, 0);

  let query = supabase
    .from(BATE_PONTO_EVENTS_TABLE)
    .select(BATE_PONTO_EVENT_SELECT)
    .eq("guild_id", guildId)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (options.userId) {
    query = query.eq("user_id", options.userId);
  }

  const result = await query;

  if (result.error) {
    const code = typeof result.error.code === "string" ? result.error.code : "";
    const message = String(result.error.message || "").toLowerCase();
    if (code === "42P01" || message.includes(BATE_PONTO_EVENTS_TABLE)) {
      return [];
    }
    return unwrap(result, "getGuildBatePontoHistory");
  }

  return result.data || [];
}

module.exports = {
  deleteSecurityLogQueueItem,
  enqueueSecurityLogQueueItem,
  enqueueGuildAutoRoleQueueItems,
  enqueueTicketDirectMessage,
  closeTicketAsDeleted,
  createTicket,
  deleteTicketAiSuggestionSession,
  getDueGuildAutoRoleQueueItems,
  getDueSecurityLogQueueItems,
  getDueTicketDirectMessages,
  getConfiguredTicketGuildRuntimes,
  getConfiguredCaptchaGuildRuntimes,
  getGuildAntiLinkRuntime,
  getGuildAntiLinkSettings,
  getGuildAutoRoleRuntime,
  getGuildAutoRoleSettings,
  getGuildSecurityLogsRuntime,
  getGuildSecurityLogsSettings,
  createTicketAiMessage,
  getGuildTicketRuntime,
  getGuildTicketSettings,
  getTicketAiSession,
  getTicketAiSuggestionSession,
  getRecentTicketAiMessages,
  getGuildWelcomeRuntime,
  getGuildCaptchaRuntime,
  getGuildCaptchaSettings,
  createGuildCaptchaSession,
  getGuildCaptchaSession,
  deleteGuildCaptchaSession,
  updateGuildCaptchaPanelMessageId,
  getGuildSuggestionsSettings,
  getGuildSuggestionsRuntime,
  getConfiguredSuggestionsGuildRuntimes,
  updateGuildSuggestionsPanelMessageId,
  createGuildSuggestion,
  getGuildSuggestionById,
  getGuildSuggestionByMessageId,
  getOpenGuildSuggestionByMessageId,
  getGuildSuggestionByThreadId,
  closeGuildSuggestionAsRemoved,
  updateGuildSuggestionMessageIds,
  upsertGuildSuggestionVote,
  getGuildSuggestionVotes,
  getGuildSuggestionVoteCounts,
  createGuildSuggestionVoteLog,
  getGuildBatePontoSettings,
  getGuildBatePontoRuntime,
  getConfiguredBatePontoGuildRuntimes,
  updateGuildBatePontoPanelMessageId,
  getActiveGuildBatePontoSession,
  createGuildBatePontoSession,
  updateGuildBatePontoSession,
  finishGuildBatePontoSession,
  listOpenGuildBatePontoSessionsWithVoiceAbsence,
  createGuildBatePontoEvent,
  getGuildBatePontoHourBank,
  upsertGuildBatePontoHourBank,
  getGuildBatePontoRanking,
  getGuildBatePontoHistory,
  getLastTicketForUser,
  getOpenTicketByChannel,
  getOpenTicketCount,
  getOpenTicketsForUser,
  getAllOpenTickets,
  getTicketTranscriptByProtocol,
  getGuildWelcomeSettings,
  getAuthUserContactById,
  getAuthUserContactByDiscordUserId,
  claimTicket,
  closeTicket,
  getPendingGuildAutoRoleSyncSettings,
  markGuildAutoRoleQueueItemCancelled,
  markGuildAutoRoleQueueItemCompleted,
  markGuildAutoRoleQueueItemProcessing,
  markSecurityLogQueueItemProcessing,
  markGuildAutoRoleSyncCompleted,
  markGuildAutoRoleSyncFailed,
  markGuildAutoRoleSyncProcessing,
  markTicketDirectMessageBlocked,
  markTicketDirectMessageSent,
  postponeGuildAutoRoleQueueItem,
  registerEvent,
  rescheduleGuildAutoRoleQueueItem,
  rescheduleSecurityLogQueueItem,
  rescheduleTicketDirectMessage,
  upsertTicketAiSession,
  upsertTicketAiSuggestionSession,
  upsertTicketTranscript,
  updateGuildTicketPanelMessageId,
  updateTicketIntroMessageId,
  getUserPlanSnapshotByDiscordUserId,
};
