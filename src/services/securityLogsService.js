const {
  ActionRowBuilder,
  AttachmentBuilder,
  AuditLogEvent,
  ButtonBuilder,
  ButtonStyle,
  ContainerBuilder,
  MediaGalleryBuilder,
  MediaGalleryItemBuilder,
  MessageFlags,
  SectionBuilder,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
  ThumbnailBuilder,
} = require("discord.js");
const { calculateUserDefaultAvatarIndex } = require("@discordjs/rest");
const {
  deleteSecurityLogQueueItem,
  enqueueSecurityLogQueueItem,
  getDueSecurityLogQueueItems,
  getGuildSecurityLogsRuntime,
  markSecurityLogQueueItemProcessing,
  rescheduleSecurityLogQueueItem,
} = require("./supabaseService");

const RUNTIME_CACHE_TTL_MS = 10_000;
const runtimeCache = new Map();
const recentEventCache = new Map();
const globalAvatarSnapshotCache = new Map();
const guildAvatarSnapshotCache = new Map();
const voiceStateSnapshotCache = new Map();
const messageSnapshotCache = new Map();

const DEFAULT_AUDIT_RETRY_DELAYS_MS = [0, 1_200, 1_400, 1_600];
const KICK_AUDIT_RETRY_DELAYS_MS = [0, 1_000, 1_500, 2_200, 3_200];
const RECENT_EVENT_TTL_MS = 20_000;
const MESSAGE_SNAPSHOT_TTL_MS = 6 * 60 * 60 * 1000;
const MAX_MESSAGE_SNAPSHOTS = 5_000;
const SECURITY_LOG_DETAILS_PREFIX = "securitylog:details:";
const SECURITY_LOG_QUEUE_PROCESS_INTERVAL_MS = 12_000;
const SECURITY_LOG_QUEUE_RETRY_DELAYS_MS = [
  10 * 1000,
  30 * 1000,
  60 * 1000,
  3 * 60 * 1000,
  10 * 60 * 1000,
  30 * 60 * 1000,
  60 * 60 * 1000,
];
const MAX_DIRECT_SECURITY_LOG_SENDS = 4;

let canvasModuleResolved = false;
let canvasModule = null;
let activeSecurityLogSends = 0;
let queueProcessingPromise = null;
let queueIntervalHandle = null;

const SECURITY_LOG_EVENT_CONFIG = {
  nicknameChange: {
    enabledColumn: "nickname_change_enabled",
    channelColumn: "nickname_change_channel_id",
    label: "Alteracao de nickname",
  },
  avatarChange: {
    enabledColumn: "avatar_change_enabled",
    channelColumn: "avatar_change_channel_id",
    label: "Alteracao de avatar",
  },
  voiceJoin: {
    enabledColumn: "voice_join_enabled",
    channelColumn: "voice_join_channel_id",
    label: "Entrou em canal de voz",
  },
  voiceLeave: {
    enabledColumn: "voice_leave_enabled",
    channelColumn: "voice_leave_channel_id",
    label: "Saiu de canal de voz",
  },
  messageDelete: {
    enabledColumn: "message_delete_enabled",
    channelColumn: "message_delete_channel_id",
    label: "Mensagem deletada",
  },
  messageEdit: {
    enabledColumn: "message_edit_enabled",
    channelColumn: "message_edit_channel_id",
    label: "Mensagem editada",
  },
  memberBan: {
    enabledColumn: "member_ban_enabled",
    channelColumn: "member_ban_channel_id",
    label: "Membro banido",
  },
  memberUnban: {
    enabledColumn: "member_unban_enabled",
    channelColumn: "member_unban_channel_id",
    label: "Membro desbanido",
  },
  memberKick: {
    enabledColumn: "member_kick_enabled",
    channelColumn: "member_kick_channel_id",
    label: "Membro expulso",
  },
  memberTimeout: {
    enabledColumn: "member_timeout_enabled",
    channelColumn: "member_timeout_channel_id",
    label: "Membro silenciado",
  },
  voiceMute: {
    enabledColumn: "voice_mute_enabled",
    channelColumn: "voice_mute_channel_id",
    label: "Mute e desmute em call",
  },
};

function resolveCanvasModule() {
  if (canvasModuleResolved) return canvasModule;
  canvasModuleResolved = true;
  try {
    canvasModule = require("@napi-rs/canvas");
  } catch {
    canvasModule = null;
  }
  return canvasModule;
}

function trimText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function toSnippet(value, maxLength = 800) {
  const normalized = trimText(String(value || ""))
    .replace(/`/g, "'")
    .replace(/\s+/g, " ");
  if (!normalized) return "(sem conteudo textual)";
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function toCodeBlock(value, maxLength = 800) {
  return `\`\`\`\n${toSnippet(value, maxLength)}\n\`\`\``;
}

function toFieldValue(value, maxLength = 1024) {
  const normalized = String(value || "").trim();
  if (!normalized) return "-";
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function compactErrorMessage(error, fallback = "Falha ao processar operacao.") {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : fallback;
  return toSnippet(message, 450);
}

function serializeDiscordEmbed(embed) {
  const fields = Array.from(embed?.fields || [])
    .map((field) => ({
      name: trimText(field?.name || ""),
      value: trimText(field?.value || ""),
    }))
    .filter((field) => field.name || field.value)
    .slice(0, 12);

  return {
    title: trimText(embed?.title || ""),
    description: trimText(embed?.description || ""),
    authorName: trimText(embed?.author?.name || ""),
    footerText: trimText(embed?.footer?.text || ""),
    url: trimText(embed?.url || ""),
    imageUrl: trimText(embed?.image?.url || ""),
    thumbnailUrl: trimText(embed?.thumbnail?.url || ""),
    fields,
  };
}

function serializeAttachment(attachment) {
  return {
    name: trimText(attachment?.name || ""),
    url: trimText(attachment?.url || attachment?.proxyURL || ""),
    contentType: trimText(attachment?.contentType || ""),
    size: Number.isFinite(attachment?.size) ? attachment.size : null,
  };
}

function buildMessageSnapshot(message) {
  if (!message?.id) return null;

  return {
    messageId: message.id,
    guildId: message.guildId || message.guild?.id || null,
    channelId: message.channelId || message.channel?.id || null,
    author: message.author
      ? {
          id: message.author.id,
          username: message.author.username || "",
          globalName: message.author.globalName || "",
          displayName: message.author.displayName || "",
          bot: Boolean(message.author.bot),
        }
      : null,
    content: trimText(message.content || ""),
    cleanContent: trimText(message.cleanContent || ""),
    embeds: Array.from(message.embeds || []).map(serializeDiscordEmbed),
    attachments: Array.from(message.attachments?.values?.() || []).map(serializeAttachment),
    stickers: Array.from(message.stickers?.values?.() || []).map((sticker) => ({
      name: trimText(sticker?.name || ""),
      id: sticker?.id || null,
    })),
    createdTimestamp: Number.isFinite(message.createdTimestamp)
      ? message.createdTimestamp
      : null,
    updatedAt: Date.now(),
  };
}

function pruneMessageSnapshots(now = Date.now()) {
  for (const [messageId, snapshot] of messageSnapshotCache.entries()) {
    if (!snapshot?.updatedAt || now - snapshot.updatedAt > MESSAGE_SNAPSHOT_TTL_MS) {
      messageSnapshotCache.delete(messageId);
    }
  }

  while (messageSnapshotCache.size > MAX_MESSAGE_SNAPSHOTS) {
    const oldestKey = messageSnapshotCache.keys().next().value;
    if (!oldestKey) break;
    messageSnapshotCache.delete(oldestKey);
  }
}

function observeSecurityLogMessageSnapshot(message) {
  if (!message?.id || message.author?.bot || message.webhookId) return false;

  const snapshot = buildMessageSnapshot(message);
  if (!snapshot) return false;

  messageSnapshotCache.set(message.id, snapshot);
  pruneMessageSnapshots();
  return true;
}

function readMessageSnapshot(messageId) {
  const snapshot = messageSnapshotCache.get(messageId);
  if (!snapshot) return null;
  if (Date.now() - snapshot.updatedAt > MESSAGE_SNAPSHOT_TTL_MS) {
    messageSnapshotCache.delete(messageId);
    return null;
  }
  return snapshot;
}

async function resolveMentionedUserLabel(client, userId) {
  const user =
    client?.users?.cache?.get(userId) ||
    (client?.users?.fetch
      ? await client.users.fetch(userId).catch(() => null)
      : null);
  const name = trimText(user?.globalName || user?.displayName || user?.username || "");
  return name ? `@${name}` : `@usuario:${userId}`;
}

async function resolveMessageMentionsText(text, messageOrSnapshot, guild) {
  let resolved = trimText(text || "");
  if (!resolved) return "";

  const client = guild?.client || messageOrSnapshot?.client || null;
  const userIds = [...new Set(Array.from(resolved.matchAll(/<@!?(\d+)>/g)).map((match) => match[1]))];
  for (const userId of userIds) {
    const label = await resolveMentionedUserLabel(client, userId);
    resolved = resolved.replace(new RegExp(`<@!?${userId}>`, "g"), label);
  }

  resolved = resolved.replace(/<@&(\d+)>/g, (match, roleId) => {
    const role = guild?.roles?.cache?.get(roleId);
    return role?.name ? `@${role.name}` : `@cargo:${roleId}`;
  });

  const channelIds = [...new Set(Array.from(resolved.matchAll(/<#(\d+)>/g)).map((match) => match[1]))];
  for (const channelId of channelIds) {
    const channel =
      guild?.channels?.cache?.get(channelId) ||
      (guild?.channels?.fetch
        ? await guild.channels.fetch(channelId).catch(() => null)
        : null);
    const label = channel?.name ? `#${channel.name}` : `#canal:${channelId}`;
    resolved = resolved.replace(new RegExp(`<#${channelId}>`, "g"), label);
  }

  return resolved.replace(/@everyone/g, "@everyone").replace(/@here/g, "@here");
}

function buildEmbedTextLines(embeds = []) {
  const lines = [];
  for (const embed of embeds || []) {
    const serialized = embed?.title !== undefined ? embed : serializeDiscordEmbed(embed);
    if (serialized.title) lines.push(`Titulo: ${serialized.title}`);
    if (serialized.description) lines.push(`Descricao: ${serialized.description}`);
    if (serialized.authorName) lines.push(`Autor do embed: ${serialized.authorName}`);
    for (const field of serialized.fields || []) {
      const fieldName = trimText(field.name || "Campo");
      const fieldValue = trimText(field.value || "");
      if (fieldName || fieldValue) {
        lines.push(`${fieldName}: ${fieldValue}`);
      }
    }
    if (serialized.footerText) lines.push(`Rodape: ${serialized.footerText}`);
    if (serialized.url) lines.push(`Link do embed: ${serialized.url}`);
    if (serialized.imageUrl) lines.push(`Imagem do embed: ${serialized.imageUrl}`);
    if (serialized.thumbnailUrl) lines.push(`Miniatura do embed: ${serialized.thumbnailUrl}`);
  }
  return lines;
}

function buildAttachmentTextLines(attachments = []) {
  return (attachments || [])
    .map((attachment) => {
      const name = trimText(attachment.name || "arquivo");
      const url = trimText(attachment.url || "");
      const contentType = trimText(attachment.contentType || "");
      return [name, contentType ? `(${contentType})` : "", url].filter(Boolean).join(" ");
    })
    .filter(Boolean);
}

async function resolveDeletedMessageContent(message, snapshot) {
  const guild = message.guild;
  const textCandidates = [
    message.cleanContent,
    message.content,
    snapshot?.cleanContent,
    snapshot?.content,
  ];
  let content = "";

  for (const candidate of textCandidates) {
    const normalized = trimText(candidate || "");
    if (normalized) {
      content = normalized;
      break;
    }
  }

  content = await resolveMessageMentionsText(content, message, guild);

  const embedLines = buildEmbedTextLines(
    message.embeds?.length ? message.embeds : snapshot?.embeds || [],
  );
  if (embedLines.length) {
    content += `${content ? "\n\n" : ""}[Embeds apagados]\n${embedLines.join("\n")}`;
  }

  const attachmentValues = message.attachments?.size
    ? Array.from(message.attachments.values()).map(serializeAttachment)
    : snapshot?.attachments || [];
  const attachmentLines = buildAttachmentTextLines(attachmentValues);
  if (attachmentLines.length) {
    content += `${content ? "\n\n" : ""}[Anexos apagados]\n${attachmentLines.join("\n")}`;
  }

  const stickers = message.stickers?.size
    ? Array.from(message.stickers.values()).map((sticker) => ({
        name: trimText(sticker?.name || ""),
        id: sticker?.id || null,
      }))
    : snapshot?.stickers || [];
  const stickerLines = stickers
    .map((sticker) => [sticker.name || "sticker", sticker.id ? `(${sticker.id})` : ""].filter(Boolean).join(" "))
    .filter(Boolean);
  if (stickerLines.length) {
    content += `${content ? "\n\n" : ""}[Stickers apagados]\n${stickerLines.join("\n")}`;
  }

  return content || "(Mensagem apagada sem texto, embed, anexo ou sticker disponivel no cache do bot)";
}

function normalizeSecurityLogFields(fields = []) {
  return fields
    .filter((field) => field && typeof field.name === "string")
    .slice(0, 24)
    .map((field) => ({
      name: toSnippet(field.name, 256),
      value: toFieldValue(field.value, 1024),
      inline: Boolean(field.inline),
    }));
}

function chunkTextBlocks(blocks, maxLength = 3500, maxChunks = 6) {
  const normalizedBlocks = blocks
    .map((block) => String(block || "").trim())
    .filter(Boolean);

  if (!normalizedBlocks.length) return [];

  const chunks = [];
  let currentChunk = "";

  for (const block of normalizedBlocks) {
    if (!currentChunk) {
      currentChunk = block;
      continue;
    }

    if (currentChunk.length + 2 + block.length <= maxLength) {
      currentChunk += `\n\n${block}`;
      continue;
    }

    chunks.push(currentChunk);
    if (chunks.length >= maxChunks) {
      return chunks;
    }

    currentChunk = block;
  }

  if (currentChunk && chunks.length < maxChunks) {
    chunks.push(currentChunk);
  }

  return chunks;
}

function formatDateTime(timestampMs) {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) return "Nao informado";
  const unix = Math.floor(timestampMs / 1000);
  return `<t:${unix}:F> (<t:${unix}:R>)`;
}

function formatMemberLabel(member) {
  if (!member?.id) return "Membro desconhecido";
  return `<@${member.id}> (\`${member.id}\`)`;
}

function formatUserLabel(user) {
  if (!user?.id) return "Usuario desconhecido";
  return `<@${user.id}> (\`${user.id}\`)`;
}

function resolveMemberDisplayName(member, fallbackMember = null) {
  const candidates = [
    member?.nickname,
    member?.displayName,
    member?.user?.globalName,
    member?.user?.username,
    fallbackMember?.nickname,
    fallbackMember?.displayName,
    fallbackMember?.user?.globalName,
    fallbackMember?.user?.username,
  ];

  for (const candidate of candidates) {
    const normalized = trimText(candidate || "");
    if (normalized) return normalized;
  }

  const fallbackId = member?.id || fallbackMember?.id;
  return fallbackId ? `<@${fallbackId}>` : "Nome nao identificado";
}

function resolveEventConfig(settings, eventKey) {
  const config = SECURITY_LOG_EVENT_CONFIG[eventKey];
  if (!config || !settings) return { enabled: false, channelId: null, label: "" };
  if (settings.enabled !== true) {
    return { enabled: false, channelId: null, label: config.label };
  }

  const useDefaultChannel = settings.use_default_channel === true;
  const resolvedDefaultChannelId = trimText(settings.default_channel_id);
  const resolvedEventChannelId = trimText(settings[config.channelColumn]);

  return {
    enabled: settings[config.enabledColumn] === true,
    channelId: useDefaultChannel
      ? resolvedDefaultChannelId || null
      : resolvedEventChannelId || null,
    label: config.label,
  };
}

async function resolveTextChannel(guild, channelId) {
  if (!guild || !channelId) return null;
  const channel =
    guild.channels.cache.get(channelId) ||
    (await guild.channels.fetch(channelId).catch(() => null));

  if (!channel || !channel.isTextBased()) return null;
  return channel;
}

async function resolveRuntime(guildId) {
  const cached = runtimeCache.get(guildId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const runtime = await getGuildSecurityLogsRuntime(guildId).catch(() => null);
  runtimeCache.set(guildId, {
    value: runtime,
    expiresAt: Date.now() + RUNTIME_CACHE_TTL_MS,
  });
  return runtime;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function registerRecentEvent(cacheKey, ttlMs = RECENT_EVENT_TTL_MS) {
  const key = trimText(cacheKey);
  if (!key) return false;

  const now = Date.now();
  const expiresAt = recentEventCache.get(key) || 0;
  if (expiresAt > now) {
    return true;
  }

  recentEventCache.set(key, now + ttlMs);
  for (const [entryKey, entryExpiresAt] of recentEventCache.entries()) {
    if (entryExpiresAt <= now) {
      recentEventCache.delete(entryKey);
    }
  }

  return false;
}

function resolveAuditEntryTargetId(entry) {
  if (entry?.target?.id) return entry.target.id;
  if (entry?.extra?.id) return entry.extra.id;
  return null;
}

async function resolveAuditEntry(guild, input) {
  const {
    type,
    targetId = null,
    maxAgeMs = 30_000,
    predicate = null,
    retryDelaysMs = DEFAULT_AUDIT_RETRY_DELAYS_MS,
    limit = 12,
    allowUnknownTarget = false,
  } = input;

  if (!guild) return null;

  for (const retryDelayMs of retryDelaysMs) {
    if (retryDelayMs > 0) {
      await sleep(retryDelayMs);
    }

    const logs = await guild.fetchAuditLogs({ type, limit }).catch(() => null);
    if (!logs) {
      continue;
    }

    const now = Date.now();
    let fallbackUnknownTargetEntry = null;
    for (const entry of logs.entries.values()) {
      if (!entry?.executor?.id) continue;
      if (typeof entry.createdTimestamp !== "number") continue;
      if (now - entry.createdTimestamp > maxAgeMs) continue;

      const entryTargetId = resolveAuditEntryTargetId(entry);
      if (typeof predicate === "function" && !predicate(entry)) {
        continue;
      }

      if (!targetId) {
        return entry;
      }

      if (entryTargetId === targetId) {
        return entry;
      }

      if (!entryTargetId && allowUnknownTarget && !fallbackUnknownTargetEntry) {
        fallbackUnknownTargetEntry = entry;
      }
    }

    if (fallbackUnknownTargetEntry) {
      return fallbackUnknownTargetEntry;
    }
  }

  return null;
}

function resolveStaticUserAvatarUrl(user) {
  if (!user || typeof user.displayAvatarURL !== "function") return null;
  return user.displayAvatarURL({
    extension: "png",
    forceStatic: true,
    size: 512,
  });
}

function resolveStaticMemberAvatarUrl(member) {
  if (!member || typeof member.displayAvatarURL !== "function") return null;
  return member.displayAvatarURL({
    extension: "png",
    forceStatic: true,
    size: 512,
  });
}

function resolveDefaultAvatarUrl(client, userId) {
  if (!client?.rest?.cdn || !userId) return null;
  const index = calculateUserDefaultAvatarIndex(userId);
  return client.rest.cdn.defaultAvatar(index);
}

function resolveUserAvatarUrlFromHash(client, userId, avatarHash, fallbackUser = null) {
  const normalizedHash = trimText(avatarHash);
  if (normalizedHash) {
    return client.rest.cdn.avatar(userId, normalizedHash, {
      extension: "png",
      forceStatic: true,
      size: 512,
    });
  }

  return resolveStaticUserAvatarUrl(fallbackUser) || resolveDefaultAvatarUrl(client, userId);
}

function resolveMemberAvatarUrlFromHash(
  client,
  guildId,
  userId,
  avatarHash,
  fallbackMember = null,
  fallbackUser = null,
) {
  const normalizedHash = trimText(avatarHash);
  if (normalizedHash) {
    return client.rest.cdn.guildMemberAvatar(guildId, userId, normalizedHash, {
      extension: "png",
      forceStatic: true,
      size: 512,
    });
  }

  return (
    resolveStaticMemberAvatarUrl(fallbackMember) ||
    resolveUserAvatarUrlFromHash(client, userId, null, fallbackUser)
  );
}

function resolveGuildAvatarSnapshotKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function getKnownGlobalAvatarHash(client, userId) {
  if (globalAvatarSnapshotCache.has(userId)) {
    return globalAvatarSnapshotCache.get(userId);
  }

  const cachedUser = client?.users?.cache?.get(userId);
  if (cachedUser) {
    return cachedUser.avatar || null;
  }

  return undefined;
}

function rememberGlobalAvatarHash(userId, avatarHash) {
  if (!userId) return;
  globalAvatarSnapshotCache.set(userId, avatarHash || null);
}

function getKnownGuildAvatarHash(guild, userId) {
  if (!guild?.id || !userId) return undefined;

  const snapshotKey = resolveGuildAvatarSnapshotKey(guild.id, userId);
  if (guildAvatarSnapshotCache.has(snapshotKey)) {
    return guildAvatarSnapshotCache.get(snapshotKey);
  }

  const cachedMember = guild.members?.cache?.get(userId);
  if (cachedMember) {
    return cachedMember.avatar || null;
  }

  return undefined;
}

function rememberGuildAvatarHash(guildId, userId, avatarHash) {
  if (!guildId || !userId) return;
  guildAvatarSnapshotCache.set(
    resolveGuildAvatarSnapshotKey(guildId, userId),
    avatarHash || null,
  );
}

function resolveVoiceStateSnapshotKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function getKnownVoiceStateSnapshot(guildId, userId) {
  if (!guildId || !userId) return null;
  return voiceStateSnapshotCache.get(resolveVoiceStateSnapshotKey(guildId, userId)) || null;
}

function rememberVoiceStateSnapshot(guildId, userId, snapshot) {
  if (!guildId || !userId || !snapshot) return;
  voiceStateSnapshotCache.set(resolveVoiceStateSnapshotKey(guildId, userId), {
    channelId: snapshot.channelId || null,
    serverMute:
      typeof snapshot.serverMute === "boolean" ? snapshot.serverMute : null,
    serverDeaf:
      typeof snapshot.serverDeaf === "boolean" ? snapshot.serverDeaf : null,
  });
}

function resolveVoiceStateBoolean(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === "boolean") {
      return candidate;
    }
  }

  return null;
}

function resolveVoiceStateFromCache(member) {
  if (!member?.voice) return null;
  return member.voice;
}

function rememberVoiceStateFromState(voiceState) {
  if (!voiceState?.guild?.id || !voiceState?.id) return;
  rememberVoiceStateSnapshot(voiceState.guild.id, voiceState.id, {
    channelId: voiceState.channelId || null,
    serverMute:
      typeof voiceState.serverMute === "boolean" ? voiceState.serverMute : null,
    serverDeaf:
      typeof voiceState.serverDeaf === "boolean" ? voiceState.serverDeaf : null,
  });
}

function primeVoiceStateSnapshots(client) {
  if (!client?.guilds?.cache) return 0;

  let primedCount = 0;
  for (const guild of client.guilds.cache.values()) {
    for (const voiceState of guild.voiceStates?.cache?.values?.() || []) {
      if (voiceState?.member?.user?.bot) continue;
      rememberVoiceStateFromState(voiceState);
      primedCount += 1;
    }
  }

  return primedCount;
}

function resolveVoiceChannel(guild, channelId, fallbackChannel = null) {
  if (fallbackChannel?.id === channelId) {
    return fallbackChannel;
  }

  if (!guild || !channelId) return null;
  return guild.channels?.cache?.get(channelId) || fallbackChannel || null;
}

function hasAuditChangeKey(entry, keys) {
  if (!Array.isArray(entry?.changes) || !Array.isArray(keys) || !keys.length) {
    return false;
  }

  const allowedKeys = new Set(
    keys.map((key) => String(key || "").toLowerCase()).filter(Boolean),
  );
  if (!allowedKeys.size) return false;

  return entry.changes.some((change) =>
    allowedKeys.has(String(change?.key || "").toLowerCase()),
  );
}

function resolveVoiceAuditEntryChannelId(entry) {
  return trimText(
    entry?.extra?.channel?.id ||
      entry?.extra?.channel_id ||
      entry?.options?.channel?.id ||
      entry?.options?.channel_id ||
      "",
  );
}

function resolveVoiceAuditEntryCount(entry) {
  const rawCount = entry?.extra?.count ?? entry?.options?.count ?? null;
  const normalizedCount = Number(rawCount);
  return Number.isFinite(normalizedCount) ? normalizedCount : null;
}

async function resolveVoiceMoveAuditEntry(guild, userId, oldChannelId, newChannelId) {
  return resolveAuditEntry(guild, {
    type: AuditLogEvent.MemberMove,
    targetId: userId,
    maxAgeMs: 75_000,
    retryDelaysMs: [0, 900, 1_500, 2_200, 3_200],
    limit: 30,
    allowUnknownTarget: true,
    predicate: (entry) => {
      const auditChannelId = resolveVoiceAuditEntryChannelId(entry);
      const auditCount = resolveVoiceAuditEntryCount(entry);
      return (
        (!auditChannelId ||
          auditChannelId === oldChannelId ||
          auditChannelId === newChannelId) &&
        (auditCount === null || auditCount >= 1)
      );
    },
  });
}

async function resolveVoiceMuteAuditEntry(guild, userId, nextMutedState) {
  const auditEntry =
    (await resolveAuditEntry(guild, {
      type: AuditLogEvent.MemberUpdate,
      targetId: userId,
      maxAgeMs: 75_000,
      retryDelaysMs: [0, 900, 1_500, 2_200, 3_200],
      limit: 30,
      predicate: (entry) =>
        hasAuditChangeKey(entry, ["mute", "suppress", "deaf"]),
    })) ||
    (await resolveAuditEntry(guild, {
      type: AuditLogEvent.MemberUpdate,
      targetId: userId,
      maxAgeMs: 75_000,
      retryDelaysMs: [0, 1_200, 2_000, 3_000],
      limit: 30,
      predicate: (entry) => {
        if (!Array.isArray(entry?.changes)) return false;
        return entry.changes.some((change) => {
          const changeKey = String(change?.key || "").toLowerCase();
          if (!["mute", "suppress", "deaf"].includes(changeKey)) return false;
          const nextValue =
            typeof change?.new === "boolean"
              ? change.new
              : typeof change?.old === "boolean"
                ? !change.old
                : null;
          return nextValue === null || nextValue === nextMutedState;
        });
      },
    }));

  return auditEntry;
}

function encodeButtonValue(value) {
  const normalized = trimText(String(value || ""));
  return normalized || "0";
}

function decodeButtonValue(value) {
  const normalized = trimText(String(value || ""));
  return normalized && normalized !== "0" ? normalized : null;
}

function buildSecurityLogDetailsCustomId(eventKey, context = {}) {
  const targetId = encodeButtonValue(context.targetId);
  const actorId = encodeButtonValue(context.actorId);
  const channelId = encodeButtonValue(context.channelId);
  const oldChannelId = encodeButtonValue(context.oldChannelId);
  const newChannelId = encodeButtonValue(context.newChannelId);
  const scope = encodeButtonValue(context.scope);
  const state = encodeButtonValue(context.state);
  const until = Number.isFinite(context.untilTimestamp)
    ? Math.max(0, Math.trunc(context.untilTimestamp)).toString(36)
    : "0";

  switch (eventKey) {
    case "avatarChange":
      return `${SECURITY_LOG_DETAILS_PREFIX}av:${targetId}:${scope}`;
    case "nicknameChange":
      return `${SECURITY_LOG_DETAILS_PREFIX}nn:${targetId}`;
    case "voiceJoin":
      return `${SECURITY_LOG_DETAILS_PREFIX}vj:${targetId}:${channelId}`;
    case "voiceLeave":
      return `${SECURITY_LOG_DETAILS_PREFIX}vl:${targetId}:${channelId}`;
    case "voiceMute":
      return `${SECURITY_LOG_DETAILS_PREFIX}vt:${targetId}:${actorId}:${channelId}:${state}`;
    case "messageDelete":
      return `${SECURITY_LOG_DETAILS_PREFIX}md:${targetId}:${channelId}`;
    case "messageEdit":
      return `${SECURITY_LOG_DETAILS_PREFIX}me:${targetId}:${channelId}`;
    case "memberBan":
      return `${SECURITY_LOG_DETAILS_PREFIX}mb:${targetId}:${actorId}`;
    case "memberUnban":
      return `${SECURITY_LOG_DETAILS_PREFIX}mu:${targetId}:${actorId}`;
    case "memberKick":
      return `${SECURITY_LOG_DETAILS_PREFIX}mk:${targetId}:${actorId}`;
    case "memberTimeout":
      return `${SECURITY_LOG_DETAILS_PREFIX}mt:${targetId}:${actorId}:${until}`;
    default:
      return null;
  }
}

function parseSecurityLogDetailsCustomId(customId) {
  const normalized = trimText(customId);
  if (!normalized.startsWith(SECURITY_LOG_DETAILS_PREFIX)) {
    return null;
  }

  const body = normalized.slice(SECURITY_LOG_DETAILS_PREFIX.length);
  const parts = body.split(":");
  const code = parts.shift() || "";

  switch (code) {
    case "av":
      return {
        code,
        targetId: decodeButtonValue(parts[0]),
        scope: decodeButtonValue(parts[1]),
      };
    case "nn":
      return {
        code,
        targetId: decodeButtonValue(parts[0]),
      };
    case "vj":
    case "vl":
    case "md":
    case "me":
      return {
        code,
        targetId: decodeButtonValue(parts[0]),
        channelId: decodeButtonValue(parts[1]),
      };
    case "vm":
      return {
        code,
        targetId: decodeButtonValue(parts[0]),
        actorId: decodeButtonValue(parts[1]),
        oldChannelId: decodeButtonValue(parts[2]),
        newChannelId: decodeButtonValue(parts[3]),
      };
    case "vt":
      return {
        code,
        targetId: decodeButtonValue(parts[0]),
        actorId: decodeButtonValue(parts[1]),
        channelId: decodeButtonValue(parts[2]),
        state: decodeButtonValue(parts[3]),
      };
    case "mb":
    case "mu":
    case "mk":
      return {
        code,
        targetId: decodeButtonValue(parts[0]),
        actorId: decodeButtonValue(parts[1]),
      };
    case "mt":
      return {
        code,
        targetId: decodeButtonValue(parts[0]),
        actorId: decodeButtonValue(parts[1]),
        untilTimestamp:
          parts[2] && parts[2] !== "0"
            ? Number.parseInt(parts[2], 36)
            : null,
      };
    default:
      return null;
  }
}

function formatUserReference(userId) {
  return userId ? `<@${userId}> (\`${userId}\`)` : "Nao identificado";
}

function formatChannelReference(channelId) {
  return channelId ? `<#${channelId}> (\`${channelId}\`)` : "Nao identificado";
}

function buildActionRowsFromButtons(buttons = []) {
  const rows = [];
  for (let index = 0; index < buttons.length; index += 5) {
    rows.push(
      new ActionRowBuilder().addComponents(buttons.slice(index, index + 5)),
    );
  }
  return rows;
}

function buildSecurityLogActionRows(guildId, eventKey, context = {}) {
  const buttons = [];
  const detailCustomId = buildSecurityLogDetailsCustomId(eventKey, context);

  if (detailCustomId) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(detailCustomId)
        .setStyle(ButtonStyle.Secondary)
        .setLabel("Detalhes"),
    );
  }

  const primaryChannelId = trimText(
    context.newChannelId || context.channelId || "",
  );
  if (guildId && primaryChannelId) {
    buttons.push(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel("Abrir canal")
        .setURL(`https://discord.com/channels/${guildId}/${primaryChannelId}`),
    );
  }

  if (eventKey === "avatarChange") {
    const oldAvatarUrl = trimText(context.oldAvatarUrl || "");
    const newAvatarUrl = trimText(context.newAvatarUrl || "");

    if (oldAvatarUrl) {
      buttons.push(
        new ButtonBuilder()
          .setStyle(ButtonStyle.Link)
          .setLabel("Avatar antigo")
          .setURL(oldAvatarUrl),
      );
    }

    if (newAvatarUrl && buttons.length < 5) {
      buttons.push(
        new ButtonBuilder()
          .setStyle(ButtonStyle.Link)
          .setLabel("Avatar novo")
          .setURL(newAvatarUrl),
      );
    }
  }

  return buildActionRowsFromButtons(buttons);
}

function createSecurityLogSeparator({
  divider = true,
  spacing = SeparatorSpacingSize.Small,
} = {}) {
  return new SeparatorBuilder().setDivider(divider).setSpacing(spacing);
}

function buildSecurityLogFieldTextBlocks(fields = []) {
  const safeFields = normalizeSecurityLogFields(fields);
  if (!safeFields.length) return [];

  const lines = safeFields.map((field) => {
    const label = toSnippet(field.name, 120);
    const normalizedValue = trimText(field.value || "-") || "-";
    const compactValue = normalizedValue.replace(/\s*\n\s*/g, " ").trim();
    const shouldUseBlock =
      normalizedValue.includes("\n") ||
      normalizedValue.includes("```") ||
      compactValue.length > 180;

    return shouldUseBlock
      ? `**${label}**\n${normalizedValue}`
      : `**${label}:** ${compactValue}`;
  });

  return chunkTextBlocks(lines, 2_400, 10);
}

function buildSecurityLogPayload({
  color = 0x5ca9ff,
  title,
  description,
  fields = [],
  imageBuffer = null,
  imageName = "security-log.png",
  thumbnailUrl = null,
  buttonRows = [],
  flags = MessageFlags.IsComponentsV2,
}) {
  const container = new ContainerBuilder().setAccentColor(color);
  const normalizedTitle = toSnippet(title || "Flowdesk Security Logs", 180);
  const normalizedDescription = trimText(description || "");
  const descriptionBlocks = normalizedDescription
    ? chunkTextBlocks([normalizedDescription], 3_500, 4)
    : [];
  const fieldBlocks = buildSecurityLogFieldTextBlocks(fields);
  const safeButtonRows = Array.isArray(buttonRows)
    ? buttonRows.filter(Boolean)
    : [];

  if (thumbnailUrl) {
    const headerSection = new SectionBuilder()
      .addTextDisplayComponents(
        new TextDisplayBuilder().setContent(`## ${normalizedTitle}`),
      )
      .setThumbnailAccessory(
        new ThumbnailBuilder()
          .setURL(thumbnailUrl)
          .setDescription(normalizedTitle),
      );

    if (descriptionBlocks[0]) {
      headerSection.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(descriptionBlocks[0]),
      );
    }

    container.addSectionComponents(headerSection);
  } else {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(`## ${normalizedTitle}`),
    );

    if (descriptionBlocks[0]) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(descriptionBlocks[0]),
      );
    }
  }

  for (const block of descriptionBlocks.slice(1)) {
    container.addTextDisplayComponents(
      new TextDisplayBuilder().setContent(block),
    );
  }

  if (fieldBlocks.length) {
    container.addSeparatorComponents(createSecurityLogSeparator());
    for (const block of fieldBlocks) {
      container.addTextDisplayComponents(
        new TextDisplayBuilder().setContent(block),
      );
    }
  }

  if (imageBuffer) {
    container.addSeparatorComponents(createSecurityLogSeparator());
    container.addMediaGalleryComponents(
      new MediaGalleryBuilder().addItems(
        new MediaGalleryItemBuilder()
          .setURL(`attachment://${imageName}`)
          .setDescription(normalizedTitle),
      ),
    );
  }

  if (safeButtonRows.length) {
    container.addSeparatorComponents(createSecurityLogSeparator());
    container.addActionRowComponents(...safeButtonRows);
  }

  container.addSeparatorComponents(
    createSecurityLogSeparator({
      divider: false,
      spacing: SeparatorSpacingSize.Small,
    }),
  );
  container.addTextDisplayComponents(
    new TextDisplayBuilder().setContent("-# Flowdesk Security Logs"),
  );

  const payload = {
    components: [container],
    flags,
    allowedMentions: { parse: [] },
  };

  if (imageBuffer) {
    payload.files = [new AttachmentBuilder(imageBuffer, { name: imageName })];
  }

  return payload;
}

function formatDurationMs(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return "Menos de 1 minuto";
  }

  const totalMinutes = Math.max(1, Math.round(durationMs / 60_000));
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];

  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}min`);

  return parts.join(" ") || "Menos de 1 minuto";
}

function buildSecurityLogQueueKey({ guildId, channelId, eventKey, title, buttonContext }) {
  const stableContext = [
    buttonContext?.targetId || "",
    buttonContext?.actorId || "",
    buttonContext?.channelId || "",
    buttonContext?.oldChannelId || "",
    buttonContext?.newChannelId || "",
    buttonContext?.scope || "",
    buttonContext?.state || "",
    buttonContext?.untilTimestamp || "",
  ].join(":");

  return [
    "security-log",
    guildId,
    channelId,
    eventKey,
    toSnippet(title || "", 80),
    stableContext,
    Date.now().toString(36),
    Math.random().toString(36).slice(2, 10),
  ].join(":");
}

function serializeSecurityLogForQueue(input) {
  return {
    color: input.color,
    title: input.title,
    description: input.description,
    fields: Array.isArray(input.fields) ? input.fields : [],
    imageBase64: input.imageBuffer ? input.imageBuffer.toString("base64") : null,
    imageName: input.imageName || "security-log.png",
    thumbnailUrl: input.thumbnailUrl || null,
    buttonContext: input.buttonContext || null,
  };
}

function deserializeSecurityLogFromQueue(payload = {}) {
  return {
    color: Number(payload.color) || 0x5ca9ff,
    title: payload.title,
    description: payload.description,
    fields: Array.isArray(payload.fields) ? payload.fields : [],
    imageBuffer: payload.imageBase64
      ? Buffer.from(String(payload.imageBase64), "base64")
      : null,
    imageName: payload.imageName || "security-log.png",
    thumbnailUrl: payload.thumbnailUrl || null,
    buttonContext: payload.buttonContext || null,
  };
}

async function sendSecurityLogPayloadToChannel({
  guild,
  channel,
  eventKey,
  color,
  title,
  description,
  fields,
  imageBuffer,
  imageName,
  thumbnailUrl,
  buttonContext,
}) {
  const payload = buildSecurityLogPayload({
    color,
    title,
    description,
    fields,
    imageBuffer,
    imageName,
    thumbnailUrl,
    buttonRows: buildSecurityLogActionRows(guild.id, eventKey, buttonContext),
  });

  return channel.send(payload);
}

async function enqueueSecurityLogForRetry({
  guild,
  channelId,
  eventKey,
  color,
  title,
  description,
  fields,
  imageBuffer,
  imageName,
  thumbnailUrl,
  buttonContext,
}) {
  if (!guild?.id || !channelId) return false;

  const queueKey = buildSecurityLogQueueKey({
    guildId: guild.id,
    channelId,
    eventKey,
    title,
    buttonContext,
  });

  await enqueueSecurityLogQueueItem({
    queueKey,
    guildId: guild.id,
    channelId,
    eventKey,
    payload: serializeSecurityLogForQueue({
      color,
      title,
      description,
      fields,
      imageBuffer,
      imageName,
      thumbnailUrl,
      buttonContext,
    }),
  });

  return true;
}

function resolveNextSecurityLogRetryTimestamp(attemptCount) {
  const delay =
    SECURITY_LOG_QUEUE_RETRY_DELAYS_MS[
      Math.min(attemptCount - 1, SECURITY_LOG_QUEUE_RETRY_DELAYS_MS.length - 1)
    ] || SECURITY_LOG_QUEUE_RETRY_DELAYS_MS[SECURITY_LOG_QUEUE_RETRY_DELAYS_MS.length - 1];

  return new Date(Date.now() + delay).toISOString();
}

async function sendSecurityLog({
  guild,
  settings,
  eventKey,
  color = 0x5ca9ff,
  title,
  description,
  fields = [],
  imageBuffer = null,
  imageName = "security-log.png",
  thumbnailUrl = null,
  buttonContext = null,
}) {
  const config = resolveEventConfig(settings, eventKey);
  if (!config.enabled || !config.channelId) return false;

  const channel = await resolveTextChannel(guild, config.channelId);
  if (!channel) return false;

  const finalTitle = title || config.label;
  const logInput = {
    guild,
    channelId: config.channelId,
    eventKey,
    color,
    title: finalTitle,
    description,
    fields,
    imageBuffer,
    imageName,
    thumbnailUrl,
    buttonContext,
  };

  if (activeSecurityLogSends >= MAX_DIRECT_SECURITY_LOG_SENDS) {
    try {
      return await enqueueSecurityLogForRetry(logInput);
    } catch (error) {
      console.warn(
        `[security-logs] fila indisponivel para ${eventKey} em guild ${guild.id}: ${compactErrorMessage(error)}`,
      );
    }
  }

  activeSecurityLogSends += 1;
  try {
    await sendSecurityLogPayloadToChannel({
      guild,
      channel,
      eventKey,
      color,
      title: finalTitle,
      description,
      fields,
      imageBuffer,
      imageName,
      thumbnailUrl,
      buttonContext,
    });
    return true;
  } catch (error) {
    const detail = compactErrorMessage(error, "falha ao enviar log");
    console.warn(
      `[security-logs] falha ao enviar log ${eventKey} em guild ${guild.id} canal ${config.channelId}: ${detail}`,
    );

    try {
      return await enqueueSecurityLogForRetry(logInput);
    } catch (queueError) {
      console.warn(
        `[security-logs] falha ao enfileirar log ${eventKey} em guild ${guild.id}: ${compactErrorMessage(queueError)}`,
      );
      return false;
    }
  } finally {
    activeSecurityLogSends = Math.max(0, activeSecurityLogSends - 1);
  }
}

async function processSecurityLogQueue(client, options = {}) {
  const { limit = 15 } = options;

  if (queueProcessingPromise) {
    return queueProcessingPromise;
  }

  queueProcessingPromise = (async () => {
    const queueItems = await getDueSecurityLogQueueItems(limit);
    const results = [];

    for (const queueItem of queueItems) {
      const nextAttemptCount = Number(queueItem.attempt_count || 0) + 1;
      const lockedItem = await markSecurityLogQueueItemProcessing(queueItem.id, {
        attemptCount: nextAttemptCount,
      });

      if (!lockedItem) {
        continue;
      }

      try {
        const guild =
          client.guilds.cache.get(queueItem.guild_id) ||
          (await client.guilds.fetch(queueItem.guild_id).catch(() => null));
        if (!guild) {
          throw new Error("Servidor nao localizado para entrega do security log.");
        }

        const channel = await resolveTextChannel(guild, queueItem.channel_id);
        if (!channel) {
          throw new Error("Canal de security log nao localizado ou sem suporte a texto.");
        }

        const payload = deserializeSecurityLogFromQueue(queueItem.payload || {});
        await sendSecurityLogPayloadToChannel({
          guild,
          channel,
          eventKey: queueItem.event_key,
          ...payload,
        });

        await deleteSecurityLogQueueItem(queueItem.id);
        results.push({ id: queueItem.id, status: "sent" });
      } catch (error) {
        const reachedMaxAttempts =
          nextAttemptCount >= Number(queueItem.max_attempts || 48);
        const lastError = compactErrorMessage(error, "Falha ao entregar security log.");

        await rescheduleSecurityLogQueueItem(queueItem.id, {
          attemptCount: nextAttemptCount,
          nextAttemptAt: resolveNextSecurityLogRetryTimestamp(nextAttemptCount),
          lastError,
          finalFailure: reachedMaxAttempts,
        });

        results.push({
          id: queueItem.id,
          status: reachedMaxAttempts ? "failed" : "queued",
          lastError,
        });
      }
    }

    return results;
  })();

  try {
    return await queueProcessingPromise;
  } finally {
    queueProcessingPromise = null;
  }
}

function startSecurityLogQueueWorker(client) {
  if (queueIntervalHandle) {
    return queueIntervalHandle;
  }

  void processSecurityLogQueue(client).catch((error) => {
    console.error("[security-log-queue]", error);
  });

  queueIntervalHandle = setInterval(() => {
    void processSecurityLogQueue(client).catch((error) => {
      console.error("[security-log-queue]", error);
    });
  }, SECURITY_LOG_QUEUE_PROCESS_INTERVAL_MS);

  return queueIntervalHandle;
}

function isSecurityLogButtonInteraction(interaction) {
  return (
    interaction?.isButton?.() &&
    trimText(interaction.customId).startsWith(SECURITY_LOG_DETAILS_PREFIX)
  );
}

function buildSecurityLogDetailsFields(parsed) {
  switch (parsed?.code) {
    case "av":
      return [
        { name: "Usuario", value: formatUserReference(parsed.targetId), inline: true },
        {
          name: "Escopo",
          value:
            parsed.scope === "global"
              ? "Avatar global da conta"
              : "Avatar especifico do servidor",
          inline: true,
        },
      ];
    case "nn":
      return [
        { name: "Usuario", value: formatUserReference(parsed.targetId) },
      ];
    case "vj":
    case "vl":
      return [
        { name: "Usuario", value: formatUserReference(parsed.targetId), inline: true },
        { name: "Canal", value: formatChannelReference(parsed.channelId), inline: true },
      ];
    case "vm":
      return [
        { name: "Usuario", value: formatUserReference(parsed.targetId), inline: true },
        { name: "Movido por", value: formatUserReference(parsed.actorId), inline: true },
        { name: "Canal antigo", value: formatChannelReference(parsed.oldChannelId), inline: true },
        { name: "Canal novo", value: formatChannelReference(parsed.newChannelId), inline: true },
      ];
    case "vt":
      return [
        { name: "Usuario", value: formatUserReference(parsed.targetId), inline: true },
        { name: "Executado por", value: formatUserReference(parsed.actorId), inline: true },
        { name: "Canal", value: formatChannelReference(parsed.channelId), inline: true },
        {
          name: "Estado",
          value: parsed.state === "muted" ? "Mutado em voz" : "Desmutado em voz",
          inline: true,
        },
      ];
    case "md":
    case "me":
      return [
        { name: "Autor", value: formatUserReference(parsed.targetId), inline: true },
        { name: "Canal", value: formatChannelReference(parsed.channelId), inline: true },
      ];
    case "mb":
      return [
        { name: "Alvo", value: formatUserReference(parsed.targetId), inline: true },
        { name: "Executado por", value: formatUserReference(parsed.actorId), inline: true },
      ];
    case "mu":
      return [
        { name: "Alvo", value: formatUserReference(parsed.targetId), inline: true },
        { name: "Executado por", value: formatUserReference(parsed.actorId), inline: true },
      ];
    case "mk":
      return [
        { name: "Alvo", value: formatUserReference(parsed.targetId), inline: true },
        { name: "Executado por", value: formatUserReference(parsed.actorId), inline: true },
      ];
    case "mt":
      return [
        { name: "Alvo", value: formatUserReference(parsed.targetId), inline: true },
        { name: "Executado por", value: formatUserReference(parsed.actorId), inline: true },
        {
          name: "Silenciado ate",
          value: parsed.untilTimestamp ? formatDateTime(parsed.untilTimestamp) : "Nao informado",
        },
      ];
    default:
      return [];
  }
}

function buildSecurityLogDetailsTitle(parsed) {
  switch (parsed?.code) {
    case "av":
      return "Detalhes da alteracao de avatar";
    case "nn":
      return "Detalhes da alteracao de nickname";
    case "vj":
      return "Detalhes da entrada em call";
    case "vl":
      return "Detalhes da saida de call";
    case "vm":
      return "Detalhes da movimentacao de call";
    case "vt":
      return "Detalhes do mute em call";
    case "md":
      return "Detalhes da mensagem deletada";
    case "me":
      return "Detalhes da mensagem editada";
    case "mb":
      return "Detalhes do banimento";
    case "mu":
      return "Detalhes do desbanimento";
    case "mk":
      return "Detalhes da expulsao";
    case "mt":
      return "Detalhes do silenciamento";
    default:
      return "Detalhes da log";
  }
}

async function handleSecurityLogButtonInteraction(interaction) {
  const parsed = parseSecurityLogDetailsCustomId(interaction?.customId);
  if (!parsed) return false;

  const logUrl =
    interaction?.guildId && interaction?.channelId && interaction?.message?.id
      ? `https://discord.com/channels/${interaction.guildId}/${interaction.channelId}/${interaction.message.id}`
      : null;
  const primaryChannelId =
    parsed.newChannelId || parsed.channelId || parsed.oldChannelId || null;
  const buttons = [];

  if (logUrl) {
    buttons.push(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel("Abrir log")
        .setURL(logUrl),
    );
  }

  if (interaction?.guildId && primaryChannelId) {
    buttons.push(
      new ButtonBuilder()
        .setStyle(ButtonStyle.Link)
        .setLabel(parsed.code === "vm" ? "Abrir destino" : "Abrir canal")
        .setURL(
          `https://discord.com/channels/${interaction.guildId}/${primaryChannelId}`,
        ),
    );
  }

  await interaction.reply(
    buildSecurityLogPayload({
      color: 0x7b9cff,
      title: buildSecurityLogDetailsTitle(parsed),
      description: logUrl
        ? "Abrir a mensagem original ou navegar direto para o canal relacionado."
        : "Informacoes adicionais desta log de seguranca.",
      fields: buildSecurityLogDetailsFields(parsed),
      buttonRows: buildActionRowsFromButtons(buttons),
      flags: MessageFlags.Ephemeral | MessageFlags.IsComponentsV2,
    }),
  );

  return true;
}

function drawRoundedRect(context, x, y, width, height, radius) {
  const safeRadius = Math.max(
    0,
    Math.min(radius, width / 2, height / 2),
  );

  context.beginPath();
  context.moveTo(x + safeRadius, y);
  context.lineTo(x + width - safeRadius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + safeRadius);
  context.lineTo(x + width, y + height - safeRadius);
  context.quadraticCurveTo(x + width, y + height, x + width - safeRadius, y + height);
  context.lineTo(x + safeRadius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - safeRadius);
  context.lineTo(x, y + safeRadius);
  context.quadraticCurveTo(x, y, x + safeRadius, y);
  context.closePath();
}

function drawCoverImage(context, image, x, y, width, height) {
  const scale = Math.max(width / image.width, height / image.height);
  const drawWidth = image.width * scale;
  const drawHeight = image.height * scale;
  const offsetX = x + (width - drawWidth) / 2;
  const offsetY = y + (height - drawHeight) / 2;
  context.drawImage(image, offsetX, offsetY, drawWidth, drawHeight);
}

async function fetchImageBufferWithRetry(url, attempts = 3) {
  if (typeof fetch !== "function") return null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          "user-agent": "FlowdeskSecurityLogs/1.0",
          accept: "image/png,image/jpeg,image/webp,image/gif,image/*;q=0.8",
        },
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const arrayBuffer = await response.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      if (buffer.length > 0) return buffer;
    } catch {
      if (attempt < attempts) {
        await sleep(250 * attempt);
      }
    }
  }

  return null;
}

async function loadAvatarImage(canvasApi, url) {
  const normalizedUrl = trimText(url);
  if (!canvasApi?.loadImage || !normalizedUrl) return null;

  const candidates = [
    normalizedUrl,
    normalizedUrl.replace(/([?&])format=(?:webp|gif|jpg|jpeg|png)/i, "$1format=png"),
    normalizedUrl.replace(/\.(?:webp|gif|jpg|jpeg)(?=\?|$)/i, ".png"),
  ].filter((candidate, index, values) => candidate && values.indexOf(candidate) === index);

  for (const candidate of candidates) {
    const directImage = await canvasApi.loadImage(candidate).catch(() => null);
    if (directImage) return directImage;

    const buffer = await fetchImageBufferWithRetry(candidate);
    if (!buffer) continue;

    const bufferedImage = await canvasApi.loadImage(buffer).catch(() => null);
    if (bufferedImage) return bufferedImage;
  }

  return null;
}

function drawAvatarFallback(context, label, x, y, width, height) {
  const gradient = context.createLinearGradient(x, y, x + width, y + height);
  gradient.addColorStop(0, "#151b29");
  gradient.addColorStop(1, "#27334a");
  context.fillStyle = gradient;
  context.fillRect(x, y, width, height);

  context.fillStyle = "rgba(255,255,255,0.1)";
  context.beginPath();
  context.arc(x + width / 2, y + height / 2 - 30, 92, 0, Math.PI * 2);
  context.fill();

  context.fillStyle = "rgba(255,255,255,0.82)";
  context.font = "700 38px Arial";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(label, x + width / 2, y + height / 2 + 92);
}

async function buildAvatarComparisonImage(oldAvatarUrl, newAvatarUrl) {
  const oldUrl = trimText(oldAvatarUrl);
  const newUrl = trimText(newAvatarUrl);
  if (!oldUrl || !newUrl) return null;

  const canvasApi = resolveCanvasModule();
  if (!canvasApi?.createCanvas || !canvasApi?.loadImage) {
    return null;
  }

  const { createCanvas } = canvasApi;
  const width = 1200;
  const height = 620;
  const canvas = createCanvas(width, height);
  const context = canvas.getContext("2d");

  const [oldImage, newImage] = await Promise.all([
    loadAvatarImage(canvasApi, oldUrl),
    loadAvatarImage(canvasApi, newUrl),
  ]);

  context.fillStyle = "#0a0d14";
  context.fillRect(0, 0, width, height);

  const framePadding = 22;
  const frameX = framePadding;
  const frameY = framePadding;
  const frameWidth = width - framePadding * 2;
  const frameHeight = height - framePadding * 2;
  const splitX = frameX + frameWidth / 2;

  context.fillStyle = "rgba(0, 0, 0, 0.32)";
  drawRoundedRect(context, frameX + 10, frameY + 14, frameWidth, frameHeight, 28);
  context.fill();

  context.save();
  drawRoundedRect(context, frameX, frameY, frameWidth, frameHeight, 28);
  context.clip();

  if (oldImage) {
    drawCoverImage(context, oldImage, frameX, frameY, frameWidth / 2, frameHeight);
  } else {
    drawAvatarFallback(context, "Antes indisponivel", frameX, frameY, frameWidth / 2, frameHeight);
  }

  if (newImage) {
    drawCoverImage(context, newImage, splitX, frameY, frameWidth / 2, frameHeight);
  } else {
    drawAvatarFallback(context, "Depois indisponivel", splitX, frameY, frameWidth / 2, frameHeight);
  }

  const topFade = context.createLinearGradient(0, frameY, 0, frameY + 150);
  topFade.addColorStop(0, "rgba(0,0,0,0.28)");
  topFade.addColorStop(1, "rgba(0,0,0,0)");
  context.fillStyle = topFade;
  context.fillRect(frameX, frameY, frameWidth, 150);

  const bottomFade = context.createLinearGradient(0, frameY + frameHeight - 150, 0, frameY + frameHeight);
  bottomFade.addColorStop(0, "rgba(0,0,0,0)");
  bottomFade.addColorStop(1, "rgba(0,0,0,0.32)");
  context.fillStyle = bottomFade;
  context.fillRect(frameX, frameY + frameHeight - 150, frameWidth, 150);

  context.fillStyle = "rgba(255,255,255,0.12)";
  context.fillRect(splitX - 1.5, frameY, 3, frameHeight);

  context.restore();

  context.strokeStyle = "rgba(255,255,255,0.1)";
  context.lineWidth = 2;
  drawRoundedRect(context, frameX, frameY, frameWidth, frameHeight, 28);
  context.stroke();

  return canvas.toBuffer("image/png");
}

async function dispatchGuildMemberAvatarChange({
  guild,
  userId,
  beforeMemberAvatarHash,
  afterMemberAvatarHash,
  oldMember = null,
  newMember = null,
  fallbackUser = null,
}) {
  if (!guild?.id || !userId) return false;
  if (beforeMemberAvatarHash === afterMemberAvatarHash) {
    rememberGuildAvatarHash(guild.id, userId, afterMemberAvatarHash);
    return false;
  }

  const runtime = await resolveRuntime(guild.id);
  if (!runtime?.settings) {
    rememberGuildAvatarHash(guild.id, userId, afterMemberAvatarHash);
    return false;
  }

  const config = resolveEventConfig(runtime.settings, "avatarChange");
  if (!config.enabled) {
    rememberGuildAvatarHash(guild.id, userId, afterMemberAvatarHash);
    return false;
  }

  const oldAvatarUrl = resolveMemberAvatarUrlFromHash(
    guild.client,
    guild.id,
    userId,
    beforeMemberAvatarHash,
    oldMember,
    fallbackUser,
  );
  const newAvatarUrl = resolveMemberAvatarUrlFromHash(
    guild.client,
    guild.id,
    userId,
    afterMemberAvatarHash,
    newMember,
    fallbackUser,
  );
  const dedupeKey = [
    "avatar",
    "guild",
    guild.id,
    userId,
    beforeMemberAvatarHash || "none",
    afterMemberAvatarHash || "none",
  ].join(":");

  rememberGuildAvatarHash(guild.id, userId, afterMemberAvatarHash);

  if (registerRecentEvent(dedupeKey)) {
    return false;
  }

  const comparisonImage = await buildAvatarComparisonImage(
    oldAvatarUrl,
    newAvatarUrl,
  );

  await sendSecurityLog({
    guild,
    settings: runtime.settings,
    eventKey: "avatarChange",
    color: 0x7b9cff,
    title: "Avatar do servidor alterado",
    description: `Usuario: ${formatMemberLabel(newMember || oldMember || { id: userId })}`,
    imageBuffer: comparisonImage,
    imageName: `avatar-guild-compare-${userId}.png`,
    buttonContext: {
      targetId: userId,
      scope: "server",
      oldAvatarUrl,
      newAvatarUrl,
    },
  });

  return true;
}

async function dispatchGlobalAvatarChange({
  client,
  userId,
  beforeAvatarHash,
  afterAvatarHash,
  oldUser = null,
  newUser = null,
}) {
  if (!client?.guilds?.cache || !userId) return false;
  if (beforeAvatarHash === afterAvatarHash) {
    rememberGlobalAvatarHash(userId, afterAvatarHash);
    return false;
  }

  const oldAvatarUrl = resolveUserAvatarUrlFromHash(
    client,
    userId,
    beforeAvatarHash,
    oldUser,
  );
  const newAvatarUrl = resolveUserAvatarUrlFromHash(
    client,
    userId,
    afterAvatarHash,
    newUser,
  );
  const comparisonImage = await buildAvatarComparisonImage(
    oldAvatarUrl,
    newAvatarUrl,
  );

  rememberGlobalAvatarHash(userId, afterAvatarHash);

  let handled = false;
  for (const guild of client.guilds.cache.values()) {
    const member = await resolveMemberFromGuild(guild, userId);
    if (!member || member.user?.bot) {
      continue;
    }

    const runtime = await resolveRuntime(guild.id);
    if (!runtime?.settings) {
      continue;
    }

    const config = resolveEventConfig(runtime.settings, "avatarChange");
    if (!config.enabled) {
      continue;
    }

    const dedupeKey = [
      "avatar",
      "global",
      guild.id,
      userId,
      beforeAvatarHash || "none",
      afterAvatarHash || "none",
    ].join(":");

    if (registerRecentEvent(dedupeKey)) {
      continue;
    }

    await sendSecurityLog({
      guild,
      settings: runtime.settings,
      eventKey: "avatarChange",
      color: 0x7b9cff,
      title: "Avatar global alterado",
      description: `Usuario: ${formatMemberLabel(member)}`,
      imageBuffer: comparisonImage,
      imageName: `avatar-global-compare-${userId}.png`,
      buttonContext: {
        targetId: userId,
        scope: "global",
        oldAvatarUrl,
        newAvatarUrl,
      },
    });
    handled = true;
  }

  return handled;
}

async function handleNicknameOrAvatarUpdate(oldMember, newMember) {
  if (!newMember?.guild || !newMember?.id) return false;
  if (newMember.user?.bot) return false;

  const runtime = await resolveRuntime(newMember.guild.id);
  if (!runtime?.settings) return false;

  const settings = runtime.settings;
  const beforeNick = trimText(oldMember?.nickname || "");
  const afterNick = trimText(newMember.nickname || "");
  const freshMember =
    (await newMember.guild.members
      .fetch({ user: newMember.id, force: true })
      .catch(() => null)) ||
    newMember.guild.members.cache.get(newMember.id) ||
    newMember;
  const beforeNickLabel = resolveMemberDisplayName(oldMember, newMember);
  const afterNickLabel = resolveMemberDisplayName(freshMember, newMember);
  const beforeMemberAvatar = oldMember?.avatar || null;
  const afterMemberAvatar = newMember?.avatar || null;
  let handled = false;

  rememberGlobalAvatarHash(newMember.id, newMember.user?.avatar || null);
  rememberGuildAvatarHash(newMember.guild.id, newMember.id, afterMemberAvatar);

  if (beforeNick !== afterNick) {
    const config = resolveEventConfig(settings, "nicknameChange");
    if (config.enabled) {
      handled = true;
      await sendSecurityLog({
        guild: newMember.guild,
        settings,
        eventKey: "nicknameChange",
        color: 0x6a9cff,
        title: "Nickname alterado",
        description: `Usuario: ${formatMemberLabel(freshMember || newMember)}`,
        thumbnailUrl: resolveStaticMemberAvatarUrl(freshMember || newMember),
        fields: [
          {
            name: "Nickname antigo",
            value: beforeNickLabel,
          },
          {
            name: "Nickname novo",
            value: afterNickLabel,
          },
        ],
        buttonContext: {
          targetId: newMember.id,
        },
      });
    }
  }

  if (beforeMemberAvatar !== afterMemberAvatar) {
    handled =
      (await dispatchGuildMemberAvatarChange({
        guild: newMember.guild,
        userId: newMember.id,
        beforeMemberAvatarHash: beforeMemberAvatar,
        afterMemberAvatarHash: afterMemberAvatar,
        oldMember,
        newMember,
        fallbackUser: newMember.user || oldMember?.user || null,
      })) || handled;
  }

  const beforeTimeout = oldMember?.communicationDisabledUntilTimestamp || null;
  const afterTimeout = newMember?.communicationDisabledUntilTimestamp || null;
  const timeoutWasApplied =
    Number.isFinite(afterTimeout) &&
    afterTimeout > Date.now() &&
    (!Number.isFinite(beforeTimeout) || afterTimeout !== beforeTimeout);

  if (timeoutWasApplied) {
    const config = resolveEventConfig(settings, "memberTimeout");
    if (config.enabled) {
      const timeoutAuditEntry =
        (await resolveAuditEntry(newMember.guild, {
          type: AuditLogEvent.MemberUpdate,
          targetId: newMember.id,
          maxAgeMs: 45_000,
          retryDelaysMs: [0, 900, 1_400, 2_000],
          predicate: (entry) =>
            Array.isArray(entry.changes) &&
            entry.changes.some(
              (change) =>
                String(change?.key || "").toLowerCase() ===
                "communication_disabled_until",
            ),
        })) ||
        (await resolveAuditEntry(newMember.guild, {
          type: AuditLogEvent.AutoModerationUserCommunicationDisabled,
          targetId: newMember.id,
          maxAgeMs: 45_000,
          retryDelaysMs: [0, 900, 1_500],
        }));
      const executor = timeoutAuditEntry?.executor || null;
      const reason = trimText(timeoutAuditEntry?.reason || "");
      const dedupeKey = ["timeout", newMember.guild.id, newMember.id, afterTimeout].join(":");

      if (!registerRecentEvent(dedupeKey)) {
        handled = true;

        await sendSecurityLog({
          guild: newMember.guild,
          settings,
          eventKey: "memberTimeout",
          color: 0xffab4a,
          title: "Membro silenciado",
          description: `Usuario: ${formatMemberLabel(newMember)}`,
          fields: [
            {
              name: "Silenciado ate",
              value: formatDateTime(afterTimeout),
            },
            {
              name: "Duracao aproximada",
              value: formatDurationMs(afterTimeout - Date.now()),
              inline: true,
            },
            {
              name: "Executado por",
              value: executor ? formatUserLabel(executor) : "Nao identificado",
              inline: true,
            },
            ...(reason
              ? [
                  {
                    name: "Motivo",
                    value: reason,
                  },
                ]
              : []),
          ],
          thumbnailUrl: resolveStaticMemberAvatarUrl(newMember),
          buttonContext: {
            targetId: newMember.id,
            actorId: executor?.id || null,
            untilTimestamp: afterTimeout,
          },
        });
      }
    }
  }

  return handled;
}

async function resolveMemberFromGuild(guild, userId) {
  if (!guild || !userId) return null;
  return (
    guild.members.cache.get(userId) ||
    (await guild.members.fetch(userId).catch(() => null))
  );
}

async function handleUserAvatarUpdate(oldUser, newUser, client) {
  if (!client?.guilds?.cache || !newUser?.id) return false;
  if (newUser.bot) return false;

  const beforeAvatar = oldUser?.avatar || null;
  const afterAvatar = newUser?.avatar || null;
  return dispatchGlobalAvatarChange({
    client,
    userId: newUser.id,
    beforeAvatarHash: beforeAvatar,
    afterAvatarHash: afterAvatar,
    oldUser,
    newUser,
  });
}

async function handleRawSecurityPacket(packet, client) {
  if (!packet?.t || !client) return false;

  if (packet.t === "USER_UPDATE") {
    const userId = trimText(packet.d?.id);
    if (!userId || packet.d?.bot === true) return false;
    if (!Object.prototype.hasOwnProperty.call(packet.d || {}, "avatar")) return false;

    const beforeAvatarHash = getKnownGlobalAvatarHash(client, userId);
    const afterAvatarHash = packet.d.avatar || null;
    const cachedUser = client.users?.cache?.get(userId) || null;

    if (beforeAvatarHash === undefined) {
      rememberGlobalAvatarHash(userId, afterAvatarHash);
      return false;
    }

    return dispatchGlobalAvatarChange({
      client,
      userId,
      beforeAvatarHash,
      afterAvatarHash,
      oldUser: cachedUser,
      newUser: cachedUser,
    });
  }

  if (packet.t === "GUILD_MEMBER_UPDATE") {
    const guildId = trimText(packet.d?.guild_id);
    const userId = trimText(packet.d?.user?.id);
    if (!guildId || !userId || packet.d?.user?.bot === true) return false;

    const guild = client.guilds?.cache?.get(guildId);
    if (!guild) return false;

    const cachedUser = client.users?.cache?.get(userId) || null;
    const cachedMember = guild.members?.cache?.get(userId) || null;
    let handled = false;

    if (Object.prototype.hasOwnProperty.call(packet.d || {}, "avatar")) {
      const beforeMemberAvatarHash = getKnownGuildAvatarHash(guild, userId);
      const afterMemberAvatarHash = packet.d.avatar || null;

      if (beforeMemberAvatarHash === undefined) {
        rememberGuildAvatarHash(guild.id, userId, afterMemberAvatarHash);
      } else {
        handled =
          (await dispatchGuildMemberAvatarChange({
            guild,
            userId,
            beforeMemberAvatarHash,
            afterMemberAvatarHash,
            oldMember: cachedMember,
            newMember: cachedMember,
            fallbackUser: cachedUser,
          })) || handled;
      }
    }

    if (Object.prototype.hasOwnProperty.call(packet.d?.user || {}, "avatar")) {
      const beforeAvatarHash = getKnownGlobalAvatarHash(client, userId);
      const afterAvatarHash = packet.d.user.avatar || null;

      if (beforeAvatarHash === undefined) {
        rememberGlobalAvatarHash(userId, afterAvatarHash);
      } else {
        handled =
          (await dispatchGlobalAvatarChange({
            client,
            userId,
            beforeAvatarHash,
            afterAvatarHash,
            oldUser: cachedUser,
            newUser: cachedUser,
          })) || handled;
      }
    }

    return handled;
  }

  return false;
}

async function handleVoiceStateSecurityLog(oldState, newState) {
  const guild = newState?.guild || oldState?.guild;
  if (!guild || !newState?.id) return false;
  if (newState.member?.user?.bot) return false;

  const runtime = await resolveRuntime(guild.id);
  if (!runtime?.settings) {
    rememberVoiceStateSnapshot(guild.id, newState.id, {
      channelId: newState?.channelId ?? null,
      serverMute:
        typeof newState?.serverMute === "boolean" ? newState.serverMute : null,
      serverDeaf:
        typeof newState?.serverDeaf === "boolean" ? newState.serverDeaf : null,
    });
    return false;
  }
  const settings = runtime.settings;
  const snapshot = getKnownVoiceStateSnapshot(guild.id, newState.id);
  const cachedVoiceState =
    resolveVoiceStateFromCache(newState.member) ||
    resolveVoiceStateFromCache(oldState?.member) ||
    null;
  const oldChannelId =
    oldState?.channelId ??
    snapshot?.channelId ??
    (cachedVoiceState?.channelId && cachedVoiceState.channelId !== newState?.channelId
      ? cachedVoiceState.channelId
      : null) ??
    null;
  const newChannelId = newState?.channelId ?? null;
  const oldChannel = resolveVoiceChannel(guild, oldChannelId, oldState?.channel || null);
  const newChannel = resolveVoiceChannel(guild, newChannelId, newState?.channel || null);
  const oldServerMute = resolveVoiceStateBoolean(
    oldState?.serverMute,
    snapshot?.serverMute,
    cachedVoiceState &&
      cachedVoiceState.channelId !== newState?.channelId
      ? cachedVoiceState.serverMute
      : null,
  );
  const newServerMute = resolveVoiceStateBoolean(
    newState?.serverMute,
    cachedVoiceState?.serverMute,
  );
  const memberLabel = formatMemberLabel(
    newState.member || oldState.member || { id: newState.id },
  );
  let handled = false;

  if (!oldChannel && newChannel) {
    await sendSecurityLog({
      guild,
      settings,
      eventKey: "voiceJoin",
      color: 0x53c46f,
      title: "Entrou em canal de voz",
      description: `Usuario: ${memberLabel}`,
      thumbnailUrl: resolveStaticMemberAvatarUrl(newState.member),
      fields: [{ name: "Canal", value: `<#${newChannel.id}>` }],
      buttonContext: {
        targetId: newState.id,
        channelId: newChannel.id,
      },
    });
    handled = true;
  }

  if (oldChannel && !newChannel) {
    await sendSecurityLog({
      guild,
      settings,
      eventKey: "voiceLeave",
      color: 0xff9b6a,
      title: "Saiu de canal de voz",
      description: `Usuario: ${memberLabel}`,
      thumbnailUrl: resolveStaticMemberAvatarUrl(oldState.member),
      fields: [{ name: "Canal anterior", value: `<#${oldChannel.id}>` }],
      buttonContext: {
        targetId: newState.id,
        channelId: oldChannel.id,
      },
    });
    handled = true;
  }


  const voiceMuteChanged =
    typeof oldServerMute === "boolean" &&
    typeof newServerMute === "boolean" &&
    oldServerMute !== newServerMute;

  if (voiceMuteChanged) {
    const muteConfig = resolveEventConfig(settings, "voiceMute");
    if (muteConfig.enabled) {
      const muteAuditEntry = await resolveVoiceMuteAuditEntry(
        guild,
        newState.id,
        newServerMute,
      );
      const executor = muteAuditEntry?.executor || null;
      const currentChannel = newChannel || oldChannel;
      const changedByModerator = executor?.id && executor.id !== newState.id;
      const dedupeKey = [
        "voice-mute",
        guild.id,
        newState.id,
        oldServerMute ? "muted" : "unmuted",
        newServerMute ? "muted" : "unmuted",
      ].join(":");

      if (!registerRecentEvent(dedupeKey)) {
        const voiceMuteFields = [
          {
            name: "Canal",
            value: currentChannel ? `<#${currentChannel.id}>` : "Nao identificado",
            inline: true,
          },
          {
            name: changedByModerator ? "Executado por" : "Origem da alteracao",
            value: changedByModerator
              ? formatUserLabel(executor)
              : "Alteracao direta do usuario ou auditoria indisponivel",
            inline: true,
          },
        ];

        await sendSecurityLog({
          guild,
          settings,
          eventKey: "voiceMute",
          color: newServerMute ? 0xffb24d : 0x63d39a,
          title: newServerMute
            ? "Membro mutado na call"
            : "Membro desmutado na call",
          description: `Usuario: ${memberLabel}`,
          thumbnailUrl: resolveStaticMemberAvatarUrl(newState.member || oldState.member),
          fields: voiceMuteFields,
          buttonContext: {
            targetId: newState.id,
            actorId: executor?.id || null,
            channelId: currentChannel?.id || null,
            state: newServerMute ? "muted" : "unmuted",
          },
        });
        handled = true;
      }
    }
  }

  rememberVoiceStateSnapshot(guild.id, newState.id, {
    channelId: newChannelId,
    serverMute: newServerMute,
    serverDeaf:
      typeof newState?.serverDeaf === "boolean" ? newState.serverDeaf : null,
  });

  return handled;
}

async function handleMessageDeleteSecurityLog(message) {
  if (!message?.guild || !message?.guildId) return false;
  if (message.author?.bot || message.webhookId) return false;

  const runtime = await resolveRuntime(message.guildId);
  if (!runtime?.settings) return false;

  const snapshot = readMessageSnapshot(message.id);
  const snapshotAuthor = snapshot?.author || null;
  if (snapshotAuthor?.bot) return false;

  const authorLabel = message.author
    ? formatUserLabel(message.author)
    : snapshotAuthor?.id
      ? formatUserLabel(snapshotAuthor)
      : "Nao identificado";
  const resolvedChannelId = message.channelId || snapshot?.channelId || null;
  const resolvedAuthorId = message.author?.id || snapshotAuthor?.id || null;
  const channelLabel = resolvedChannelId ? `<#${resolvedChannelId}>` : "Nao identificado";

  let content = trimText(message.content || "");

  // Resolve menções (@user) para nomes legíveis no log
  if (content && message.mentions?.users?.size > 0) {
    content = content.replace(/<@!?(\d+)>/g, (match, userId) => {
      const mentionedUser = message.mentions.users.get(userId);
      if (mentionedUser) {
        const displayName = mentionedUser.globalName || mentionedUser.username || mentionedUser.displayName;
        return `@${displayName}`;
      }
      return `@usuario:${userId}`;
    });
  }

  // Resolve menções de cargos (@cargo) para nomes legíveis
  if (content && message.mentions?.roles?.size > 0) {
    content = content.replace(/<@&(\d+)>/g, (match, roleId) => {
      const mentionedRole = message.mentions.roles?.get(roleId);
      if (mentionedRole?.name) {
        return `@${mentionedRole.name}`;
      }
      return `@cargo:${roleId}`;
    });
  }

  // Resolve menções de canais (#canal) para nomes legíveis
  if (content) {
    content = content.replace(/<#(\d+)>/g, (match, channelId) => {
      const mentionedChannel = message.guild?.channels?.cache?.get(channelId);
      if (mentionedChannel?.name) {
        return `#${mentionedChannel.name}`;
      }
      return `#canal:${channelId}`;
    });
  }

  const extraContext = [];

  for (const embed of message.embeds || []) {
    if (trimText(embed.title || "")) extraContext.push(`Titulo: ${trimText(embed.title)}`);
    if (trimText(embed.description || "")) extraContext.push(`Descricao: ${trimText(embed.description)}`);
    if (trimText(embed.author?.name || "")) extraContext.push(`Autor do Embed: ${trimText(embed.author.name)}`);
    for (const field of embed.fields || []) {
      if (trimText(field.name || "") || trimText(field.value || "")) {
        extraContext.push(`${trimText(field.name)}: ${trimText(field.value)}`);
      }
    }
    if (trimText(embed.footer?.text || "")) extraContext.push(`Rodape: ${trimText(embed.footer.text)}`);
  }

  if (extraContext.length > 0) {
    if (content) content += "\n\n[Embeds presentes]:\n" + extraContext.join("\n").substring(0, 500);
    else content = "[Conteudo do Embed apagado]:\n" + extraContext.join("\n").substring(0, 600);
  }

  if (message.attachments?.size > 0) {
    const urls = message.attachments.map((a) => a.name || a.url).join("\n");
    if (content) content += "\n\n[Anexos no apagamento]:\n" + urls;
    else content = "[Anexos apagados]:\n" + urls;
  }

  if (!content) {
    content = "(Mensagem apagada sem dados disponiveis no evento direto)";
  }

  content = await resolveDeletedMessageContent(message, snapshot);

  await sendSecurityLog({
    guild: message.guild,
    settings: runtime.settings,
    eventKey: "messageDelete",
    color: 0xe08989,
    title: "Mensagem deletada",
    description: `Autor: ${authorLabel}`,
    thumbnailUrl: resolveStaticUserAvatarUrl(message.author),
    fields: [
      {
        name: "Canal",
        value: channelLabel,
        inline: true,
      },
      {
        name: "Conteudo",
        value: toCodeBlock(content, 700),
      },
    ],
    buttonContext: {
      targetId: resolvedAuthorId,
      channelId: resolvedChannelId,
    },
  });

  return true;
}

async function handleMessageEditSecurityLog(oldMessage, newMessage) {
  const guild = newMessage?.guild || oldMessage?.guild;
  const guildId = newMessage?.guildId || oldMessage?.guildId;
  if (!guild || !guildId) return false;

  const author = newMessage?.author || oldMessage?.author;
  if (author?.bot) return false;

  const oldSnapshot = readMessageSnapshot(oldMessage?.id || newMessage?.id);
  let oldContent = trimText(
    oldMessage?.cleanContent ||
      oldMessage?.content ||
      oldSnapshot?.cleanContent ||
      oldSnapshot?.content ||
      "",
  );
  let newContent = trimText(newMessage?.cleanContent || newMessage?.content || "");
  if (oldContent === newContent) return false;

  // Helper para resolver menções em qualquer conteúdo de mensagem
  const resolveMentions = (text, message) => {
    if (!text || !message) return text;
    // Usuários
    if (message.mentions?.users?.size > 0) {
      text = text.replace(/<@!?(\d+)>/g, (match, userId) => {
        const u = message.mentions.users.get(userId);
        if (u) return `@${u.globalName || u.username || u.displayName}`;
        return `@usuario:${userId}`;
      });
    }
    // Cargos
    if (message.mentions?.roles?.size > 0) {
      text = text.replace(/<@&(\d+)>/g, (match, roleId) => {
        const r = message.mentions.roles?.get(roleId);
        return r?.name ? `@${r.name}` : `@cargo:${roleId}`;
      });
    }
    // Canais
    text = text.replace(/<#(\d+)>/g, (match, channelId) => {
      const ch = message.guild?.channels?.cache?.get(channelId);
      return ch?.name ? `#${ch.name}` : `#canal:${channelId}`;
    });
    return text;
  };

  oldContent = resolveMentions(oldContent, oldMessage);
  newContent = resolveMentions(newContent, newMessage);

  const runtime = await resolveRuntime(guildId);
  if (!runtime?.settings) return false;

  await sendSecurityLog({
    guild,
    settings: runtime.settings,
    eventKey: "messageEdit",
    color: 0x69b7ff,
    title: "Mensagem editada",
    description: `Autor: ${author ? formatUserLabel(author) : "Nao identificado"}`,
    thumbnailUrl: resolveStaticUserAvatarUrl(author),
    fields: [
      {
        name: "Canal",
        value: newMessage?.channelId
          ? `<#${newMessage.channelId}>`
          : oldMessage?.channelId
            ? `<#${oldMessage.channelId}>`
            : "Nao identificado",
      },
      {
        name: "Conteudo antigo",
        value: toCodeBlock(oldContent || "(indisponivel)", 520),
      },
      {
        name: "Conteudo novo",
        value: toCodeBlock(newContent || "(indisponivel)", 520),
      },
    ],
    buttonContext: {
      targetId: author?.id || null,
      channelId: newMessage?.channelId || oldMessage?.channelId || null,
    },
  });

  return true;
}

async function handleGuildBanAddSecurityLog(ban) {
  const guild = ban?.guild;
  const user = ban?.user;
  if (!guild || !user?.id) return false;

  const runtime = await resolveRuntime(guild.id);
  if (!runtime?.settings) return false;

  const auditEntry = await resolveAuditEntry(guild, {
    type: AuditLogEvent.MemberBanAdd,
    targetId: user.id,
    maxAgeMs: 35_000,
  });
  const executor = auditEntry?.executor || null;
  const reason = trimText(auditEntry?.reason || "");

  await sendSecurityLog({
    guild,
    settings: runtime.settings,
    eventKey: "memberBan",
    color: 0xe86363,
    title: "Membro banido",
    description: `Alvo: ${formatUserLabel(user)}`,
    thumbnailUrl: resolveStaticUserAvatarUrl(user),
    fields: [
      {
        name: "Executado por",
        value: executor ? formatUserLabel(executor) : "Nao identificado",
      },
      {
        name: "Motivo",
        value: reason || "Nao informado",
      },
    ],
    buttonContext: {
      targetId: user.id,
      actorId: executor?.id || null,
    },
  });

  return true;
}

async function handleGuildBanRemoveSecurityLog(ban) {
  const guild = ban?.guild;
  const user = ban?.user;
  if (!guild || !user?.id) return false;

  const runtime = await resolveRuntime(guild.id);
  if (!runtime?.settings) return false;

  const auditEntry = await resolveAuditEntry(guild, {
    type: AuditLogEvent.MemberBanRemove,
    targetId: user.id,
    maxAgeMs: 35_000,
  });
  const executor = auditEntry?.executor || null;
  const reason = trimText(auditEntry?.reason || "");

  await sendSecurityLog({
    guild,
    settings: runtime.settings,
    eventKey: "memberUnban",
    color: 0x6ac985,
    title: "Membro desbanido",
    description: `Alvo: ${formatUserLabel(user)}`,
    thumbnailUrl: resolveStaticUserAvatarUrl(user),
    fields: [
      {
        name: "Executado por",
        value: executor ? formatUserLabel(executor) : "Nao identificado",
      },
      {
        name: "Motivo",
        value: reason || "Nao informado",
      },
    ],
    buttonContext: {
      targetId: user.id,
      actorId: executor?.id || null,
    },
  });

  return true;
}

async function handleMemberRemoveSecurityLog(member) {
  if (!member?.guild || !member?.id) return false;
  if (member.user?.bot) return false;

  const runtime = await resolveRuntime(member.guild.id);
  if (!runtime?.settings) return false;

  const config = resolveEventConfig(runtime.settings, "memberKick");
  if (!config.enabled) return false;

  const kickAuditEntry = await resolveAuditEntry(member.guild, {
    type: AuditLogEvent.MemberKick,
    targetId: member.id,
    maxAgeMs: 60_000,
    limit: 20,
    retryDelaysMs: KICK_AUDIT_RETRY_DELAYS_MS,
  });

  if (!kickAuditEntry) return false;

  const dedupeKey = ["kick", member.guild.id, member.id, kickAuditEntry.id].join(":");
  if (registerRecentEvent(dedupeKey, 30_000)) {
    return false;
  }

  await sendSecurityLog({
    guild: member.guild,
    settings: runtime.settings,
    eventKey: "memberKick",
    color: 0xff9c5f,
    title: "Membro expulso",
    description: `Alvo: ${formatMemberLabel(member)}`,
    thumbnailUrl: resolveStaticMemberAvatarUrl(member),
    fields: [
      {
        name: "Executado por",
        value: kickAuditEntry.executor
          ? formatUserLabel(kickAuditEntry.executor)
          : "Nao identificado",
      },
      {
        name: "Motivo",
        value: trimText(kickAuditEntry.reason || "") || "Nao informado",
      },
    ],
    buttonContext: {
      targetId: member.id,
      actorId: kickAuditEntry.executor?.id || null,
    },
  });

  return true;
}

module.exports = {
  handleGuildBanAddSecurityLog,
  handleGuildBanRemoveSecurityLog,
  handleMemberRemoveSecurityLog,
  handleMessageDeleteSecurityLog,
  handleMessageEditSecurityLog,
  handleNicknameOrAvatarUpdate,
  handleRawSecurityPacket,
  handleSecurityLogButtonInteraction,
  handleUserAvatarUpdate,
  handleVoiceStateSecurityLog,
  isSecurityLogButtonInteraction,
  observeSecurityLogMessageSnapshot,
  processSecurityLogQueue,
  primeVoiceStateSnapshots,
  startSecurityLogQueueWorker,
};
