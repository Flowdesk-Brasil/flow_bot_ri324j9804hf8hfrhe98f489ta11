const { buildBatePontoVoiceWarningDmPayload } = require("../utils/componentFactory");
const {
  finishBatePontoSessionCore,
  memberMeetsVoiceRequirement,
} = require("./batePontoService");
const {
  getActiveGuildBatePontoSession,
  getGuildBatePontoRuntime,
  listOpenGuildBatePontoSessionsWithVoiceAbsence,
  updateGuildBatePontoSession,
} = require("./supabaseService");

const VOICE_ABSENCE_WARNING_MS = 3 * 60 * 1000;
const VOICE_ABSENCE_FINISH_MS = 5 * 60 * 1000;
const VOICE_ABSENCE_RECOVERY_INTERVAL_MS = 60 * 1000;

const ABSENCE_NOTE =
  "Finalizado automaticamente por ausencia da call autorizada.";

const absenceTrackers = new Map();

function trackingKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function isVoiceChannelAuthorized(channelId, settings) {
  if (!channelId) {
    return false;
  }

  const requiredVoiceChannelIds = Array.isArray(settings?.required_voice_channel_ids)
    ? settings.required_voice_channel_ids.filter(Boolean)
    : [];

  if (!requiredVoiceChannelIds.length) {
    return true;
  }

  return requiredVoiceChannelIds.includes(String(channelId));
}

function buildVoiceChannelJoinUrl(guildId, channelId) {
  if (!guildId || !channelId) {
    return null;
  }

  return `https://discord.com/channels/${guildId}/${channelId}`;
}

function clearAbsenceTimers(entry) {
  if (!entry) {
    return;
  }

  if (entry.warningTimeout) {
    clearTimeout(entry.warningTimeout);
  }

  if (entry.finishTimeout) {
    clearTimeout(entry.finishTimeout);
  }
}

function clearBatePontoVoiceAbsenceTracking(guildId, userId) {
  const key = trackingKey(guildId, userId);
  const entry = absenceTrackers.get(key);
  if (!entry) {
    return;
  }

  clearAbsenceTimers(entry);
  absenceTrackers.delete(key);
}

async function resolveVoiceChannelName(guild, channelId) {
  if (!guild || !channelId) {
    return "call autorizada";
  }

  const channel =
    guild.channels.cache.get(channelId) ||
    (await guild.channels.fetch(channelId).catch(() => null));

  return channel?.name || "call autorizada";
}

async function resolveGuildMember(guild, userId) {
  if (!guild || !userId) {
    return null;
  }

  return (
    guild.members.cache.get(userId) ||
    (await guild.members.fetch(userId).catch(() => null))
  );
}

async function sendVoiceAbsenceWarningDm(client, entry) {
  const { guildId, userId, sessionId, lastChannelId } = entry;
  const session = await getActiveGuildBatePontoSession(guildId, userId);

  if (!session || session.id !== sessionId || !session.voice_left_at) {
    clearBatePontoVoiceAbsenceTracking(guildId, userId);
    return;
  }

  if (session.voice_warning_sent_at) {
    entry.warningSent = true;
    return;
  }

  const runtime = await getGuildBatePontoRuntime(guildId);
  const settings = runtime?.settings;
  if (!runtime?.licenseUsable || !settings?.enabled || !settings?.require_voice_channel) {
    clearBatePontoVoiceAbsenceTracking(guildId, userId);
    return;
  }

  const guild =
    client.guilds.cache.get(guildId) ||
    (await client.guilds.fetch(guildId).catch(() => null));

  if (!guild) {
    return;
  }

  const member = await resolveGuildMember(guild, userId);
  if (member && memberMeetsVoiceRequirement(member, settings)) {
    clearBatePontoVoiceAbsenceTracking(guildId, userId);
    await updateGuildBatePontoSession(sessionId, {
      voiceLeftAt: null,
      voiceWarningSentAt: null,
      voiceChannelId: member.voice?.channelId || lastChannelId,
    });
    return;
  }

  const channelId = lastChannelId || session.voice_channel_id;
  const channelName = await resolveVoiceChannelName(guild, channelId);
  const joinUrl = buildVoiceChannelJoinUrl(guildId, channelId);
  const payload = buildBatePontoVoiceWarningDmPayload({
    guildName: guild.name,
    channelName,
    joinUrl,
    minutesUntilFinish: 2,
  });

  const user = member?.user || (await client.users.fetch(userId).catch(() => null));
  if (!user) {
    return;
  }

  await user.send(payload).catch((error) => {
    console.error("[bate-ponto-voice:warning-dm]", error);
  });

  const now = new Date().toISOString();
  await updateGuildBatePontoSession(sessionId, {
    voiceWarningSentAt: now,
  });
  entry.warningSent = true;
}

async function finishSessionForVoiceAbsence(client, entry) {
  const { guildId, userId, sessionId } = entry;

  try {
    const session = await getActiveGuildBatePontoSession(guildId, userId);
    if (!session || session.id !== sessionId || !session.voice_left_at) {
      clearBatePontoVoiceAbsenceTracking(guildId, userId);
      return;
    }

    const runtime = await getGuildBatePontoRuntime(guildId);
    const settings = runtime?.settings;
    if (!runtime?.licenseUsable || !settings?.enabled || !settings?.require_voice_channel) {
      clearBatePontoVoiceAbsenceTracking(guildId, userId);
      return;
    }

    const guild =
      client.guilds.cache.get(guildId) ||
      (await client.guilds.fetch(guildId).catch(() => null));

    if (!guild) {
      return;
    }

    const member = await resolveGuildMember(guild, userId);
    if (member && memberMeetsVoiceRequirement(member, settings)) {
      clearBatePontoVoiceAbsenceTracking(guildId, userId);
      await updateGuildBatePontoSession(sessionId, {
        voiceLeftAt: null,
        voiceWarningSentAt: null,
        voiceChannelId: member.voice?.channelId || session.voice_channel_id,
      });
      return;
    }

    await finishBatePontoSessionCore({
      guildId,
      userId,
      settings,
      member: member || { id: userId },
      guild,
      session,
      note: ABSENCE_NOTE,
    });
  } catch (error) {
    console.error("[bate-ponto-voice:auto-finish]", error);
  } finally {
    clearBatePontoVoiceAbsenceTracking(guildId, userId);
  }
}

function scheduleAbsenceTracking(client, input) {
  const { guildId, userId, sessionId, lastChannelId, leftAt, warningAlreadySent } = input;
  const key = trackingKey(guildId, userId);
  const existing = absenceTrackers.get(key);

  if (
    existing &&
    existing.sessionId === sessionId &&
    existing.leftAt === new Date(leftAt).getTime()
  ) {
    return;
  }

  clearBatePontoVoiceAbsenceTracking(guildId, userId);

  const leftAtMs = new Date(leftAt).getTime();
  if (!Number.isFinite(leftAtMs)) {
    return;
  }

  const warningDelay = Math.max(0, leftAtMs + VOICE_ABSENCE_WARNING_MS - Date.now());
  const finishDelay = Math.max(0, leftAtMs + VOICE_ABSENCE_FINISH_MS - Date.now());

  const entry = {
    guildId,
    userId,
    sessionId,
    lastChannelId,
    leftAt: leftAtMs,
    warningSent: Boolean(warningAlreadySent),
    warningTimeout: null,
    finishTimeout: null,
  };

  if (!warningAlreadySent) {
    entry.warningTimeout = setTimeout(() => {
      sendVoiceAbsenceWarningDm(client, entry).catch((error) => {
        console.error("[bate-ponto-voice:warning]", error);
      });
    }, warningDelay);
  }

  entry.finishTimeout = setTimeout(() => {
    finishSessionForVoiceAbsence(client, entry).catch((error) => {
      console.error("[bate-ponto-voice:finish]", error);
    });
  }, finishDelay);

  absenceTrackers.set(key, entry);
}

async function clearVoiceAbsenceState(sessionId) {
  await updateGuildBatePontoSession(sessionId, {
    voiceLeftAt: null,
    voiceWarningSentAt: null,
  });
}

async function handleBatePontoVoiceStateUpdate(oldState, newState, client) {
  const guildId = newState.guild?.id || oldState.guild?.id;
  const userId = newState.id || oldState.id;

  if (!guildId || !userId) {
    return;
  }

  const runtime = await getGuildBatePontoRuntime(guildId);
  const settings = runtime?.settings;

  if (!runtime?.licenseUsable || !settings?.enabled || !settings?.require_voice_channel) {
    return;
  }

  const session = await getActiveGuildBatePontoSession(guildId, userId);
  if (!session) {
    clearBatePontoVoiceAbsenceTracking(guildId, userId);
    return;
  }

  const oldChannelId = oldState.channelId;
  const newChannelId = newState.channelId;
  const oldAuthorized = isVoiceChannelAuthorized(oldChannelId, settings);
  const newAuthorized = isVoiceChannelAuthorized(newChannelId, settings);

  if (newAuthorized) {
    clearBatePontoVoiceAbsenceTracking(guildId, userId);
    await updateGuildBatePontoSession(session.id, {
      voiceLeftAt: null,
      voiceWarningSentAt: null,
      voiceChannelId: String(newChannelId),
    });
    return;
  }

  if (!oldAuthorized || newAuthorized) {
    return;
  }

  const lastChannelId = String(oldChannelId);
  const now = new Date().toISOString();

  await updateGuildBatePontoSession(session.id, {
    voiceLeftAt: now,
    voiceChannelId: lastChannelId,
    voiceWarningSentAt: null,
  });

  scheduleAbsenceTracking(client, {
    guildId,
    userId,
    sessionId: session.id,
    lastChannelId,
    leftAt: now,
    warningAlreadySent: false,
  });
}

async function hydrateBatePontoVoiceAbsenceTrackers(client) {
  const sessions = await listOpenGuildBatePontoSessionsWithVoiceAbsence();

  for (const session of sessions) {
    if (!session?.guild_id || !session?.user_id || !session?.voice_left_at) {
      continue;
    }

    const runtime = await getGuildBatePontoRuntime(session.guild_id);
    const settings = runtime?.settings;
    if (!runtime?.licenseUsable || !settings?.enabled || !settings?.require_voice_channel) {
      await clearVoiceAbsenceState(session.id);
      continue;
    }

    scheduleAbsenceTracking(client, {
      guildId: session.guild_id,
      userId: session.user_id,
      sessionId: session.id,
      lastChannelId: session.voice_channel_id,
      leftAt: session.voice_left_at,
      warningAlreadySent: Boolean(session.voice_warning_sent_at),
    });
  }
}

function startBatePontoVoiceAbsenceWorker(client) {
  hydrateBatePontoVoiceAbsenceTrackers(client).catch((error) => {
    console.error("[bate-ponto-voice:hydrate]", error);
  });

  setInterval(() => {
    hydrateBatePontoVoiceAbsenceTrackers(client).catch((error) => {
      console.error("[bate-ponto-voice:recovery]", error);
    });
  }, VOICE_ABSENCE_RECOVERY_INTERVAL_MS);
}

module.exports = {
  handleBatePontoVoiceStateUpdate,
  hydrateBatePontoVoiceAbsenceTrackers,
  startBatePontoVoiceAbsenceWorker,
  clearBatePontoVoiceAbsenceTracking,
  isVoiceChannelAuthorized,
};
