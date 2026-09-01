const { createClient } = require("@supabase/supabase-js");
const { env } = require("../config/env");

const OFFICIAL_SUPPORT_GUILD_ID = "1353259338759671838";
const CLIENT_ROLE_CACHE_TTL_MS = 20 * 1000;

const eligibilityCache = new Map();

const supabase = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function chunkArray(values, size = 500) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

async function runWithConcurrency(items, worker) {
  const queue = Array.isArray(items) ? items : [];
  if (!queue.length) return 0;

  const concurrency = Math.max(
    1,
    Math.min(env.clientRoleSyncConcurrency || 1, queue.length),
  );
  let cursor = 0;
  let completed = 0;

  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (cursor < queue.length) {
        const item = queue[cursor];
        cursor += 1;
        await worker(item);
        completed += 1;
      }
    }),
  );

  return completed;
}

function isFutureOrOpenEnded(isoValue, nowMs = Date.now()) {
  if (!isoValue) return true;
  const timestamp = Date.parse(isoValue);
  return Number.isFinite(timestamp) && timestamp > nowMs;
}

function isPlanStateActive(row, nowMs = Date.now()) {
  const status = String(row?.status || "").trim().toLowerCase();
  return status === "active" && isFutureOrOpenEnded(row?.expires_at, nowMs);
}

function isApprovedOrderActive(row, nowMs = Date.now()) {
  return (
    String(row?.status || "").trim().toLowerCase() === "approved" &&
    Boolean(row?.paid_at) &&
    isFutureOrOpenEnded(row?.expires_at, nowMs)
  );
}

function readEligibilityCache(discordUserId) {
  const entry = eligibilityCache.get(discordUserId);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    eligibilityCache.delete(discordUserId);
    return null;
  }
  return entry.eligible;
}

function writeEligibilityCache(discordUserId, eligible) {
  eligibilityCache.set(discordUserId, {
    eligible,
    expiresAt: Date.now() + CLIENT_ROLE_CACHE_TTL_MS,
  });
}

function clearClientRoleEligibilityCache(discordUserId = null) {
  const normalizedDiscordUserId =
    typeof discordUserId === "string" ? discordUserId.trim() : "";
  if (normalizedDiscordUserId) {
    eligibilityCache.delete(normalizedDiscordUserId);
    return;
  }
  eligibilityCache.clear();
}

async function loadClientRoleEligibilityMap(discordUserIds) {
  const uniqueDiscordUserIds = [...new Set((discordUserIds || []).filter(Boolean))];
  const eligibleByDiscordUserId = new Map(
    uniqueDiscordUserIds.map((discordUserId) => [discordUserId, false]),
  );

  if (!uniqueDiscordUserIds.length) {
    return eligibleByDiscordUserId;
  }

  const authUsers = [];
  for (const chunk of chunkArray(uniqueDiscordUserIds, 500)) {
    const { data, error } = await supabase
      .from("auth_users")
      .select("id, discord_user_id")
      .in("discord_user_id", chunk);

    if (error) {
      throw new Error(error.message);
    }

    if (Array.isArray(data) && data.length) {
      authUsers.push(...data);
    }
  }

  const userIds = authUsers
    .map((row) => row.id)
    .filter((value) => Number.isFinite(value));

  const discordUserIdByUserId = new Map();
  for (const row of authUsers) {
    const discordUserId =
      typeof row?.discord_user_id === "string" ? row.discord_user_id.trim() : "";
    if (Number.isFinite(row?.id) && discordUserId) {
      discordUserIdByUserId.set(row.id, discordUserId);
    }
  }

  const nowMs = Date.now();

  if (userIds.length) {
    for (const chunk of chunkArray(userIds, 500)) {
      const { data, error } = await supabase
        .from("auth_user_plan_state")
        .select("user_id, status, expires_at")
        .in("user_id", chunk);

      if (error) {
        throw new Error(error.message);
      }

      for (const row of data || []) {
        if (!isPlanStateActive(row, nowMs)) continue;
        const discordUserId = discordUserIdByUserId.get(row.user_id);
        if (discordUserId) eligibleByDiscordUserId.set(discordUserId, true);
      }
    }

    for (const chunk of chunkArray(userIds, 500)) {
      const { data, error } = await supabase
        .from("payment_orders")
        .select("user_id, status, paid_at, expires_at")
        .in("user_id", chunk)
        .eq("status", "approved");

      if (error) {
        throw new Error(error.message);
      }

      for (const row of data || []) {
        if (!isApprovedOrderActive(row, nowMs)) continue;
        const discordUserId = discordUserIdByUserId.get(row.user_id);
        if (discordUserId) eligibleByDiscordUserId.set(discordUserId, true);
      }
    }
  }

  for (const [discordUserId, eligible] of eligibleByDiscordUserId.entries()) {
    writeEligibilityCache(discordUserId, eligible);
  }

  return eligibleByDiscordUserId;
}

async function isDiscordUserClientEligible(discordUserId) {
  const normalizedDiscordUserId =
    typeof discordUserId === "string" ? discordUserId.trim() : "";
  if (!normalizedDiscordUserId) return false;

  const cached = readEligibilityCache(normalizedDiscordUserId);
  if (cached !== null) return cached;

  const map = await loadClientRoleEligibilityMap([normalizedDiscordUserId]);
  return map.get(normalizedDiscordUserId) || false;
}

async function getOfficialGuild(client, providedGuild = null) {
  if (providedGuild) return providedGuild;

  const guildId = env.officialSupportGuildId || OFFICIAL_SUPPORT_GUILD_ID;
  return await client.guilds.fetch(guildId).catch(() => null);
}

async function applyClientRoleForMember(member, eligible, options = {}) {
  const roleId = env.officialClientRoleId;
  const guild = member?.guild;
  if (!guild || !roleId || guild.id !== (env.officialSupportGuildId || OFFICIAL_SUPPORT_GUILD_ID)) {
    return { eligible, changed: false };
  }

  const hasRole = member.roles.cache.has(roleId);
  if (eligible && !hasRole) {
    await member.roles.add(roleId, "Flowdesk - pagamento ativo identificado");
    if (options.log !== false) {
      console.log(`[client-role] Cargo CLIENTE aplicado para ${member.id}.`);
    }
    return { eligible, changed: true };
  }

  if (!eligible && hasRole) {
    await member.roles.remove(roleId, "Flowdesk - pagamento inativo, expirado ou cancelado");
    if (options.log !== false) {
      console.log(`[client-role] Cargo CLIENTE removido de ${member.id}.`);
    }
    return { eligible, changed: true };
  }

  return { eligible, changed: false };
}

async function syncClientRoleForMember(member, options = {}) {
  if (!member || member.user?.bot) {
    return { eligible: false, changed: false };
  }

  const officialGuildId = env.officialSupportGuildId || OFFICIAL_SUPPORT_GUILD_ID;
  if (member.guild?.id !== officialGuildId) {
    return { eligible: false, changed: false };
  }

  const eligible =
    typeof options.eligible === "boolean"
      ? options.eligible
      : await isDiscordUserClientEligible(member.id);

  return await applyClientRoleForMember(member, eligible, options);
}

async function syncClientRoleForDiscordUser(client, discordUserId, options = {}) {
  const normalizedDiscordUserId =
    typeof discordUserId === "string" ? discordUserId.trim() : "";
  if (!normalizedDiscordUserId) {
    return { eligible: false, changed: false };
  }

  const guild = await getOfficialGuild(client, options.guild || null);
  if (!guild) {
    console.warn("[client-role] Nao foi possivel buscar o servidor oficial.");
    return { eligible: false, changed: false };
  }

  const eligible =
    typeof options.eligible === "boolean"
      ? options.eligible
      : await isDiscordUserClientEligible(normalizedDiscordUserId);

  const member =
    options.member ||
    guild.members.cache.get(normalizedDiscordUserId) ||
    (await guild.members
      .fetch({ user: normalizedDiscordUserId, force: true })
      .catch(() => null));

  if (!member) {
    if (options.log !== false) {
      console.log(
        `[client-role] Usuario ${normalizedDiscordUserId} ainda nao esta no servidor oficial; cargo sera aplicado quando entrar.`,
      );
    }
    return { eligible, changed: false };
  }

  return await applyClientRoleForMember(member, eligible, options);
}

async function syncAllClientRoles(client) {
  const guild = await getOfficialGuild(client);
  if (!guild) {
    return { synced: 0, candidateCount: 0 };
  }

  const allMembers = await guild.members.fetch().catch(() => null);
  if (!allMembers) {
    return { synced: 0, candidateCount: 0 };
  }

  const members = [...allMembers.values()].filter((member) => !member.user?.bot);
  const eligibilityByDiscordUserId = await loadClientRoleEligibilityMap(
    members.map((member) => member.id),
  );

  const synced = await runWithConcurrency(members, async (member) => {
    await syncClientRoleForMember(member, {
      guild,
      member,
      eligible: eligibilityByDiscordUserId.get(member.id) || false,
      log: false,
    });
  });

  return { synced, candidateCount: members.length };
}

module.exports = {
  clearClientRoleEligibilityCache,
  isDiscordUserClientEligible,
  syncAllClientRoles,
  syncClientRoleForDiscordUser,
  syncClientRoleForMember,
};
