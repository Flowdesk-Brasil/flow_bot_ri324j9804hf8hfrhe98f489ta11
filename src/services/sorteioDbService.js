const { createClient } = require("@supabase/supabase-js");
const { env } = require("../config/env");

const SORTEIOS_TABLE = "guild_sorteios";
const ENTRIES_TABLE = "guild_sorteio_entries";
const BLACKLIST_TABLE = "guild_sorteio_blacklist";

const supabase = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

function unwrap(result, operation) {
  if (result.error) {
    const code = result.error.code || "";
    if (code === "42P01" || code === "PGRST205") {
      return null;
    }
    throw new Error(`[SorteioDB] ${operation}: ${result.error.message}`);
  }
  return result.data;
}

function isMissingTableError(error) {
  const message = String(error?.message || "");
  return message.includes("42P01") || message.includes("PGRST205");
}

async function createSorteio(record) {
  try {
    const data = unwrap(
      await supabase.from(SORTEIOS_TABLE).insert(record).select("*").single(),
      "createSorteio",
    );
    return data;
  } catch (error) {
    if (isMissingTableError(error)) return null;
    throw error;
  }
}

async function updateSorteio(id, patch) {
  try {
    const data = unwrap(
      await supabase.from(SORTEIOS_TABLE).update(patch).eq("id", id).select("*").single(),
      "updateSorteio",
    );
    return data;
  } catch (error) {
    if (isMissingTableError(error)) return null;
    throw error;
  }
}

async function getSorteioById(id) {
  try {
    const data = unwrap(
      await supabase.from(SORTEIOS_TABLE).select("*").eq("id", id).maybeSingle(),
      "getSorteioById",
    );
    return data;
  } catch (error) {
    if (isMissingTableError(error)) return null;
    throw error;
  }
}

async function getSorteioByMessageId(messageId) {
  try {
    const data = unwrap(
      await supabase
        .from(SORTEIOS_TABLE)
        .select("*")
        .eq("message_id", messageId)
        .maybeSingle(),
      "getSorteioByMessageId",
    );
    return data;
  } catch (error) {
    if (isMissingTableError(error)) return null;
    throw error;
  }
}

async function getActiveSorteiosToEnd() {
  try {
    const data = unwrap(
      await supabase
        .from(SORTEIOS_TABLE)
        .select("*")
        .eq("status", "active")
        .lte("ends_at", new Date().toISOString())
        .limit(50),
      "getActiveSorteiosToEnd",
    );
    return data || [];
  } catch (error) {
    if (isMissingTableError(error)) return [];
    throw error;
  }
}

async function getSorteioHistory(guildId, limit = 10) {
  try {
    const data = unwrap(
      await supabase
        .from(SORTEIOS_TABLE)
        .select("*")
        .eq("guild_id", guildId)
        .eq("status", "ended")
        .order("ended_at", { ascending: false })
        .limit(limit),
      "getSorteioHistory",
    );
    return data || [];
  } catch (error) {
    if (isMissingTableError(error)) return [];
    throw error;
  }
}

async function addEntry({ sorteioId, guildId, userId }) {
  try {
    const data = unwrap(
      await supabase
        .from(ENTRIES_TABLE)
        .insert({
          sorteio_id: sorteioId,
          guild_id: guildId,
          user_id: userId,
        })
        .select("*")
        .single(),
      "addEntry",
    );
    return data;
  } catch (error) {
    if (error?.message?.includes("duplicate") || error?.code === "23505") {
      return { duplicate: true };
    }
    if (isMissingTableError(error)) return null;
    throw error;
  }
}

async function removeEntry(sorteioId, userId) {
  try {
    unwrap(
      await supabase
        .from(ENTRIES_TABLE)
        .delete()
        .eq("sorteio_id", sorteioId)
        .eq("user_id", userId),
      "removeEntry",
    );
    return true;
  } catch (error) {
    if (isMissingTableError(error)) return false;
    throw error;
  }
}

async function getEntries(sorteioId) {
  try {
    const data = unwrap(
      await supabase
        .from(ENTRIES_TABLE)
        .select("user_id, joined_at")
        .eq("sorteio_id", sorteioId)
        .order("joined_at", { ascending: true }),
      "getEntries",
    );
    return data || [];
  } catch (error) {
    if (isMissingTableError(error)) return [];
    throw error;
  }
}

async function getEntryCount(sorteioId) {
  try {
    const result = await supabase
      .from(ENTRIES_TABLE)
      .select("id", { count: "exact", head: true })
      .eq("sorteio_id", sorteioId);
    if (result.error) {
      if (result.error.code === "42P01" || result.error.code === "PGRST205") {
        return 0;
      }
      throw new Error(result.error.message);
    }
    return result.count || 0;
  } catch (error) {
    if (isMissingTableError(error)) return 0;
    throw error;
  }
}

async function isUserEntered(sorteioId, userId) {
  try {
    const data = unwrap(
      await supabase
        .from(ENTRIES_TABLE)
        .select("id")
        .eq("sorteio_id", sorteioId)
        .eq("user_id", userId)
        .maybeSingle(),
      "isUserEntered",
    );
    return Boolean(data);
  } catch (error) {
    if (isMissingTableError(error)) return false;
    throw error;
  }
}

async function replaceBlacklist(sorteioId, guildId, userIds, createdBy) {
  try {
    unwrap(
      await supabase.from(BLACKLIST_TABLE).delete().eq("sorteio_id", sorteioId),
      "replaceBlacklist.delete",
    );
    if (!userIds.length) return [];

    const rows = userIds.map((userId) => ({
      sorteio_id: sorteioId,
      guild_id: guildId,
      user_id: userId,
      created_by: createdBy,
    }));

    const data = unwrap(
      await supabase.from(BLACKLIST_TABLE).insert(rows).select("user_id"),
      "replaceBlacklist.insert",
    );
    return (data || []).map((row) => row.user_id);
  } catch (error) {
    if (isMissingTableError(error)) return [];
    throw error;
  }
}

async function getBlacklistUserIds(sorteioId) {
  try {
    const data = unwrap(
      await supabase
        .from(BLACKLIST_TABLE)
        .select("user_id")
        .eq("sorteio_id", sorteioId),
      "getBlacklistUserIds",
    );
    return (data || []).map((row) => row.user_id);
  } catch (error) {
    if (isMissingTableError(error)) return [];
    throw error;
  }
}

module.exports = {
  createSorteio,
  updateSorteio,
  getSorteioById,
  getSorteioByMessageId,
  getActiveSorteiosToEnd,
  getSorteioHistory,
  addEntry,
  removeEntry,
  getEntries,
  getEntryCount,
  isUserEntered,
  replaceBlacklist,
  getBlacklistUserIds,
};
