const {
  ContainerBuilder,
  EmbedBuilder,
  MessageFlags,
  SeparatorBuilder,
  SeparatorSpacingSize,
  TextDisplayBuilder,
} = require("discord.js");
const { getGuildAntiLinkRuntime, getGuildTicketSettings } = require("./supabaseService");

const RUNTIME_CACHE_TTL_MS = 10_000;
const runtimeCache = new Map();
const DELETE_RETRY_DELAYS_MS = [0, 350, 1_200, 3_000];
const DELETE_QUEUE_GAP_MS = 90;
const DELETE_DEDUP_TTL_MS = 45_000;
const BURST_WINDOW_MS = 10_000;
const BURST_SWEEP_THRESHOLD = 3;
const BURST_SWEEP_COOLDOWN_MS = 2_500;
const NOTICE_COOLDOWN_MS = 7_500;
const MEMBER_ACTION_COOLDOWN_MS = 15_000;
const deleteQueuesByChannel = new Map();
const queuedDeleteIds = new Map();
const burstState = new Map();
const burstSweepCooldowns = new Map();
const noticeCooldowns = new Map();
const memberActionCooldowns = new Map();

const HTTP_LINK_REGEX = /\b(?:https?:\/\/|www\.)[^\s<>()]+/i;
const DISCORD_INVITE_REGEX =
  /\b(?:discord(?:app)?\.com\/invite\/|discord\.gg\/)[a-z0-9-]{2,}\b/i;
const MARKDOWN_HIDDEN_LINK_REGEX = /\[[^\]]{1,180}\]\(([^)]+)\)/i;
const OBFUSCATED_HTTP_REGEX =
  /h\s*[tx]\s*[tx]\s*p\s*s?\s*(?:[:\]\)]|\scolon\s)?\s*(?:\/|\sslash\s)\s*(?:\/|\sslash\s)/i;
const DOMAIN_CANDIDATE_REGEX =
  /\b[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+\b/gi;
const KNOWN_TLD_SET = new Set([
  "com",
  "net",
  "org",
  "io",
  "gg",
  "co",
  "app",
  "dev",
  "br",
  "xyz",
  "live",
  "store",
  "site",
  "online",
  "etc",
  "me",
  "link",
  "tv",
  "pro",
  "cloud",
  "info",
  "biz",
  "shop",
  "top",
  "vip",
  "tech",
  "blog",
  "ai",
  "edu",
  "gov",
  "mil",
  "us",
  "uk",
  "de",
  "fr",
  "es",
  "it",
  "ca",
  "au",
  "pt",
  "jp",
  "kr",
  "cn",
  "in",
  "ru",
  "ar",
  "mx",
  "cl",
  "pe",
  "uy",
  "py",
  "bo",
  "ec",
  "ve",
  "nl",
  "be",
  "ch",
  "se",
  "no",
  "fi",
  "dk",
  "pl",
  "tr",
  "cz",
  "at",
  "ro",
  "hu",
  "gr",
  "il",
  "ie",
  "nz",
  "za",
  "id",
  "sg",
  "hk",
  "tw",
  "th",
  "ph",
  "my",
  "com.br",
  "net.br",
  "org.br",
  "gov.br",
  "edu.br",
]);

function normalizeText(value) {
  if (typeof value !== "string") return "";
  return value
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .toLowerCase();
}

function normalizeCompact(value) {
  return normalizeText(value).replace(
    /[\s`~!@#$%^&*()_+=[\]{}|;:'",<>/?\\.-]+/g,
    "",
  );
}

function normalizeDeobfuscated(value) {
  return normalizeText(value)
    .replace(/hxxps?/g, (match) => (match === "hxxps" ? "https" : "http"))
    .replace(/\((dot)\)|\[(dot)\]|\{(dot)\}|\sdot\s/g, ".")
    .replace(/\((slash)\)|\[(slash)\]|\{(slash)\}|\sslash\s/g, "/")
    .replace(/\((colon)\)|\[(colon)\]|\{(colon)\}|\scolon\s/g, ":")
    .replace(/\s+/g, "");
}

function normalizeAction(value) {
  if (value === "timeout" || value === "kick" || value === "ban") {
    return value;
  }
  return "delete_only";
}

function normalizeTimeoutMinutes(value) {
  const parsed =
    typeof value === "number" && Number.isFinite(value)
      ? Math.trunc(value)
      : Number.NaN;
  if (!Number.isFinite(parsed)) return 10;
  return Math.min(10080, Math.max(1, parsed));
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isDiscordUnknownMessageError(error) {
  return (
    Number(error?.code) === 10008 ||
    String(error?.message || "").toLowerCase().includes("unknown message")
  );
}

function compactExpiringMap(map, now = Date.now()) {
  if (map.size < 1_000) return;
  for (const [key, expiresAt] of map.entries()) {
    if (expiresAt <= now) {
      map.delete(key);
    }
  }
}

function markExpiringKey(map, key, ttlMs) {
  const now = Date.now();
  compactExpiringMap(map, now);
  map.set(key, now + ttlMs);
}

function hasFreshKey(map, key) {
  const expiresAt = map.get(key);
  if (!expiresAt) return false;
  if (expiresAt <= Date.now()) {
    map.delete(key);
    return false;
  }
  return true;
}

function enqueueMessageDelete(message, reason) {
  const messageId = message?.id;
  const channelId = message?.channelId;
  if (!messageId || !channelId || typeof message.delete !== "function") {
    return Promise.resolve({
      deleted: false,
      status: "warn",
      detail: "mensagem sem canal ou metodo de exclusao",
    });
  }

  if (hasFreshKey(queuedDeleteIds, messageId)) {
    return Promise.resolve({
      deleted: true,
      status: "ok",
      detail: "exclusao ja enfileirada",
    });
  }

  markExpiringKey(queuedDeleteIds, messageId, DELETE_DEDUP_TTL_MS);
  const previous = deleteQueuesByChannel.get(channelId) || Promise.resolve();
  const task = previous
    .catch(() => null)
    .then(async () => {
      for (let attempt = 0; attempt < DELETE_RETRY_DELAYS_MS.length; attempt += 1) {
        const delayMs = DELETE_RETRY_DELAYS_MS[attempt];
        if (delayMs > 0) {
          await wait(delayMs);
        }

        try {
          await message.delete();
          return { deleted: true, status: "ok", detail: null };
        } catch (error) {
          if (isDiscordUnknownMessageError(error)) {
            return { deleted: true, status: "ok", detail: "mensagem ja removida" };
          }

          const isLastAttempt = attempt + 1 >= DELETE_RETRY_DELAYS_MS.length;
          if (isLastAttempt) {
            return {
              deleted: false,
              status: "warn",
              detail: error instanceof Error ? error.message : "falha ao apagar mensagem",
            };
          }
        }
      }

      return { deleted: false, status: "warn", detail: "falha ao apagar mensagem" };
    })
    .finally(async () => {
      await wait(DELETE_QUEUE_GAP_MS);
      if (deleteQueuesByChannel.get(channelId) === task) {
        deleteQueuesByChannel.delete(channelId);
      }
    });

  deleteQueuesByChannel.set(channelId, task);

  return task.then((result) => {
    if (!result.deleted) {
      console.warn(
        `[AntiLink] falha ao apagar mensagem em guild ${message.guildId} canal ${channelId}: ${result.detail || reason}`,
      );
    }
    return result;
  });
}

function shouldApplyMemberAction(message, action) {
  if (action === "delete_only") return false;
  const key = `${message.guildId}:${message.author?.id}:${action}`;
  if (hasFreshKey(memberActionCooldowns, key)) return false;
  markExpiringKey(memberActionCooldowns, key, MEMBER_ACTION_COOLDOWN_MS);
  return true;
}

function shouldSendNotice(message) {
  const key = `${message.guildId}:${message.channelId}:${message.author?.id}`;
  if (hasFreshKey(noticeCooldowns, key)) return false;
  markExpiringKey(noticeCooldowns, key, NOTICE_COOLDOWN_MS);
  return true;
}

function observeViolationBurst(message) {
  const key = `${message.guildId}:${message.channelId}:${message.author?.id}`;
  const now = Date.now();
  const state = burstState.get(key) || [];
  const recent = state.filter((timestamp) => now - timestamp <= BURST_WINDOW_MS);
  recent.push(now);
  burstState.set(key, recent);
  return recent.length;
}

function scheduleBurstSweep({ message, settings }) {
  const key = `${message.guildId}:${message.channelId}:${message.author?.id}`;
  if (hasFreshKey(burstSweepCooldowns, key)) return;
  markExpiringKey(burstSweepCooldowns, key, BURST_SWEEP_COOLDOWN_MS);

  setTimeout(async () => {
    const channel = message.channel;
    if (!channel || typeof channel.messages?.fetch !== "function") return;

    const fetched = await channel.messages.fetch({ limit: 100 }).catch((error) => {
      const detail = error instanceof Error ? error.message : "falha ao buscar mensagens";
      console.warn(
        `[AntiLink] falha na varredura anti-flood em ${message.guildId}/${message.channelId}: ${detail}`,
      );
      return null;
    });
    if (!fetched) return;

    for (const candidate of fetched.values()) {
      if (candidate.author?.id !== message.author?.id) continue;
      if (candidate.author?.bot || candidate.webhookId) continue;
      const detection = detectViolation(resolveMessageTextForDetection(candidate), settings);
      if (!detection) continue;
      void enqueueMessageDelete(candidate, `[AntiLink sweep] ${detection.reason}`);
    }
  }, 250);
}

function hasLikelyDomainWithKnownTld(value) {
  if (typeof value !== "string" || !value.trim()) return false;
  const candidates = value.match(DOMAIN_CANDIDATE_REGEX);
  if (!Array.isArray(candidates) || !candidates.length) return false;

  for (const candidate of candidates) {
    const domain = String(candidate || "").toLowerCase();
    const parts = domain.split(".").filter(Boolean);
    if (parts.length < 2) continue;

    const topLevel = parts[parts.length - 1];
    const topLevelPair = `${parts[parts.length - 2]}.${topLevel}`;

    if (KNOWN_TLD_SET.has(topLevel) || KNOWN_TLD_SET.has(topLevelPair)) {
      return true;
    }
  }

  return false;
}

const TENOR_GIF_REGEX = /^https?:\/\/tenor\.com\/view\/[a-z0-9-]+/i;

function detectViolation(content, settings) {
  const normalized = normalizeText(content);
  if (!normalized) return null;

  const compact = normalizeCompact(content);
  const deobfuscated = normalizeDeobfuscated(content);

  const inviteMatch = normalized.match(DISCORD_INVITE_REGEX) || deobfuscated.match(DISCORD_INVITE_REGEX);
  if (inviteMatch) {
    return { rule: "discord_invite", reason: "convite do Discord detectado", url: inviteMatch[0] };
  }

  if (compact.includes("discordgg") || compact.includes("discordcominvite")) {
    return { rule: "discord_invite", reason: "convite do Discord detectado", url: "[ofuscado: discord.gg]" };
  }

  const markdownMatch = normalized.match(MARKDOWN_HIDDEN_LINK_REGEX);
  if (markdownMatch) {
    const hiddenUrl = markdownMatch[1];
    if (!TENOR_GIF_REGEX.test(hiddenUrl)) {
      return { rule: "markdown_hidden_link", reason: "link escondido em texto markdown", url: hiddenUrl };
    }
  }

  const httpRegex = new RegExp(/\b(?:https?:\/\/|www\.)[^\s<>()]+/, 'gi');
  const httpMatches = normalized.match(httpRegex) || [];
  for (const url of httpMatches) {
    if (TENOR_GIF_REGEX.test(url)) continue;
    return { rule: "external_link", reason: "link externo detectado", url };
  }

  const domainCandidates = normalized.match(DOMAIN_CANDIDATE_REGEX) || [];
  for (const candidate of domainCandidates) {
    if (candidate.toLowerCase().includes("tenor.com")) continue;

    const parts = candidate.split(".").filter(Boolean);
    if (parts.length < 2) continue;
    
    const topLevel = parts[parts.length - 1];
    const topLevelPair = `${parts[parts.length - 2]}.${topLevel}`;
    if (KNOWN_TLD_SET.has(topLevel) || KNOWN_TLD_SET.has(topLevelPair)) {
      return { rule: "external_link", reason: "link externo detectado", url: candidate };
    }
  }

  if (OBFUSCATED_HTTP_REGEX.test(normalized)) {
    return { rule: "obfuscated_link", reason: "link ofuscado detectado", url: "[http ofuscado]" };
  }

  const deobfHttpMatches = deobfuscated.match(/\b(?:https?:\/\/)[^\s<>()]+/gi) || [];
  for (const url of deobfHttpMatches) {
    if (TENOR_GIF_REGEX.test(url)) continue;
    return { rule: "obfuscated_link", reason: "link ofuscado detectado", url };
  }

  const deobfDomainCandidates = deobfuscated.match(DOMAIN_CANDIDATE_REGEX) || [];
  for (const candidate of deobfDomainCandidates) {
    if (candidate.toLowerCase().includes("tenor.com")) continue;

    const parts = candidate.split(".").filter(Boolean);
    if (parts.length < 2) continue;
    
    const topLevel = parts[parts.length - 1];
    const topLevelPair = `${parts[parts.length - 2]}.${topLevel}`;
    if (KNOWN_TLD_SET.has(topLevel) || KNOWN_TLD_SET.has(topLevelPair)) {
      return { rule: "obfuscated_link", reason: "link ofuscado detectado", url: candidate };
    }
  }

  return null;
}

function formatSnippet(content) {
  const normalized = String(content || "")
    .replace(/`/g, "'")
    .replace(/\[[^\]]{1,180}\]\(([^)]+)\)/gi, "[link removido]")
    .replace(
      /\b(?:https?:\/\/|hxxps?:\/\/|www\.)[^\s<>()]+/gi,
      "[link removido]",
    )
    .replace(
      /\b(?:discord(?:app)?\.com\/invite\/|discord\.gg\/)[a-z0-9-]{2,}\b/gi,
      "[convite removido]",
    )
    .replace(
      /\b[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.(?:[a-z]{2,24}|xn--[a-z0-9-]{2,59})\b/gi,
      "[dominio removido]",
    )
    .trim();
  if (!normalized) return "(mensagem sem texto)";
  if (normalized.length <= 260) return normalized;
  return `${normalized.slice(0, 257)}...`;
}

function resolveActionLabel(action, timeoutMinutes) {
  if (action === "timeout") return `Silenciar por ${timeoutMinutes} min`;
  if (action === "kick") return "Expulsar usuario";
  if (action === "ban") return "Banir usuario";
  return "Apenas apagar mensagem";
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

  const runtime = await getGuildAntiLinkRuntime(guildId).catch(() => null);
  runtimeCache.set(guildId, {
    value: runtime,
    expiresAt: Date.now() + RUNTIME_CACHE_TTL_MS,
  });
  return runtime;
}

async function resolveMember(message) {
  if (message?.member) return message.member;
  if (!message?.guild || !message?.author?.id) return null;
  return message.guild.members.fetch(message.author.id).catch(() => null);
}

function resolveMessageTextForDetection(message) {
  const fragments = [];

  if (typeof message?.content === "string" && message.content.trim()) {
    fragments.push(message.content.trim());
  }

  if (
    typeof message?.cleanContent === "string" &&
    message.cleanContent.trim() &&
    message.cleanContent.trim() !== message.content?.trim()
  ) {
    fragments.push(message.cleanContent.trim());
  }

  if (Array.isArray(message?.embeds) && message.embeds.length) {
    for (const embed of message.embeds) {
      if (typeof embed?.title === "string" && embed.title.trim()) {
        fragments.push(embed.title.trim());
      }
      if (typeof embed?.description === "string" && embed.description.trim()) {
        fragments.push(embed.description.trim());
      }
      if (typeof embed?.url === "string" && embed.url.trim()) {
        fragments.push(embed.url.trim());
      }
      if (Array.isArray(embed?.fields)) {
        for (const field of embed.fields) {
          if (typeof field?.value === "string" && field.value.trim()) {
            fragments.push(field.value.trim());
          }
        }
      }
    }
  }

  return fragments.join("\n");
}

async function applyModerationAction({
  message,
  member,
  action,
  timeoutMinutes,
  reason,
}) {
  const result = {
    deleted: false,
    actionApplied: "delete_only",
    moderationStatus: "ok",
    moderationDetail: null,
  };

  const deleteResult = await enqueueMessageDelete(message, reason);
  result.deleted = deleteResult.deleted;
  if (!deleteResult.deleted) {
    result.moderationStatus = "warn";
    result.moderationDetail = deleteResult.detail;
  }

  if (action === "delete_only") {
    return result;
  }

  if (!shouldApplyMemberAction(message, action)) {
    result.actionApplied = action;
    return result;
  }

  if (!member) {
    result.moderationStatus = "warn";
    result.moderationDetail = "membro nao encontrado para aplicar punicao";
    return result;
  }

  if (action === "timeout") {
    result.actionApplied = "timeout";
    if (!member.moderatable) {
      result.moderationStatus = "warn";
      result.moderationDetail = "bot sem permissao para silenciar este usuario";
      return result;
    }

    try {
      await member.timeout(timeoutMinutes * 60 * 1000, reason);
      return result;
    } catch (error) {
      result.moderationStatus = "warn";
      result.moderationDetail =
        error instanceof Error ? error.message : "falha ao silenciar usuario";
      console.warn(
        `[AntiLink] falha ao aplicar timeout em guild ${message.guildId}: ${result.moderationDetail}`,
      );
      return result;
    }
  }

  if (action === "kick") {
    result.actionApplied = "kick";
    if (!member.kickable) {
      result.moderationStatus = "warn";
      result.moderationDetail = "bot sem permissao para expulsar este usuario";
      return result;
    }

    try {
      await member.kick(reason);
      return result;
    } catch (error) {
      result.moderationStatus = "warn";
      result.moderationDetail =
        error instanceof Error ? error.message : "falha ao expulsar usuario";
      console.warn(
        `[AntiLink] falha ao expulsar membro em guild ${message.guildId}: ${result.moderationDetail}`,
      );
      return result;
    }
  }

  result.actionApplied = "ban";
  if (!member.bannable) {
    result.moderationStatus = "warn";
    result.moderationDetail = "bot sem permissao para banir este usuario";
    return result;
  }

  try {
    await member.ban({ reason, deleteMessageSeconds: 0 });
    return result;
  } catch (error) {
    result.moderationStatus = "warn";
    result.moderationDetail =
      error instanceof Error ? error.message : "falha ao banir usuario";
    console.warn(
      `[AntiLink] falha ao banir membro em guild ${message.guildId}: ${result.moderationDetail}`,
    );
    return result;
  }
}

async function sendAntiLinkLog({
  message,
  settings,
  action,
  timeoutMinutes,
  detection,
  moderation,
}) {
  if (!settings.log_channel_id) return;

  const logChannel = await resolveTextChannel(message.guild, settings.log_channel_id);
  if (!logChannel) return;

  const moderationSummary =
    moderation.moderationStatus === "ok"
      ? "Executado com sucesso."
      : `Executado com alerta: ${moderation.moderationDetail || "sem detalhes"}.`;

  const payload = {
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
    components: [
      new ContainerBuilder()
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            "## Seguranca: AntiLink bloqueou uma mensagem",
          ),
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `-# Usuario: <@${message.author.id}>\n-# Canal: <#${message.channelId}>\n-# Regra: ${detection.reason}\n-# Acao configurada: ${resolveActionLabel(action, timeoutMinutes)}\n-# Resultado: ${moderationSummary}`,
          ),
        )
        .addSeparatorComponents(
          new SeparatorBuilder()
            .setSpacing(SeparatorSpacingSize.Large)
            .setDivider(true),
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `### Link Exato Detectado\n\`\`\`\n${detection.url}\n\`\`\``,
          ),
        ),
    ],
  };

  const sent = await logChannel.send(payload).catch(() => null);
  if (sent) return;

  const fallbackEmbed = new EmbedBuilder()
    .setColor(0x7a1212)
    .setTitle("Seguranca: AntiLink bloqueou uma mensagem")
    .setDescription(
      [
        `Usuario: <@${message.author.id}>`,
        `Canal: <#${message.channelId}>`,
        `Regra: ${detection.reason}`,
        `Acao configurada: ${resolveActionLabel(action, timeoutMinutes)}`,
        `Resultado: ${moderationSummary}`,
      ].join("\n"),
    )
    .addFields({
      name: "Link Exato Detectado",
      value: `\`\`\`\n${detection.url}\n\`\`\``,
    })
    .setTimestamp(new Date());

  await logChannel
    .send({
      allowedMentions: { parse: [] },
      embeds: [fallbackEmbed],
    })
    .catch((error) => {
      const detail =
        error instanceof Error ? error.message : "falha ao enviar log";
      console.warn(
        `[AntiLink] falha ao enviar log em guild ${message.guildId} canal ${settings.log_channel_id}: ${detail}`,
      );
      return null;
    });
}

async function sendAntiLinkNotice({ message, detection, action, timeoutMinutes }) {
  if (!message?.channel?.isTextBased?.()) return;

  const payload = {
    flags: MessageFlags.IsComponentsV2,
    allowedMentions: { parse: [] },
    components: [
      new ContainerBuilder()
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            "## Mensagem removida pelo AntiLink",
          ),
        )
        .addTextDisplayComponents(
          new TextDisplayBuilder().setContent(
            `-# Link Bloqueado: \`${detection.url}\`\n-# Acao: ${resolveActionLabel(action, timeoutMinutes)}`,
          ),
        ),
    ],
  };

  let sent = await message.channel.send(payload).catch(() => null);
  if (!sent) {
    const fallbackEmbed = new EmbedBuilder()
      .setColor(0x7a1212)
      .setTitle("Mensagem removida pelo AntiLink")
      .setDescription(
        `Link Bloqueado: \`${detection.url}\`\nAcao: ${resolveActionLabel(action, timeoutMinutes)}`,
      )
      .setTimestamp(new Date());

    sent = await message.channel
      .send({
        allowedMentions: { parse: [] },
        embeds: [fallbackEmbed],
      })
      .catch(() => null);
  }

  if (!sent) return;

  setTimeout(() => {
    sent.delete().catch(() => null);
  }, 8000);
}

async function handleAntiLinkMessage(message) {
  if (!message || !message.inGuild()) return false;
  if (message.author?.bot || message.webhookId) return false;
  if (!message.guildId) return false;

  const runtime = await resolveRuntime(message.guildId);
  if (!runtime?.settings) return false;

  const settings = runtime.settings;
  if (!settings.enabled) return false;

  const member = await resolveMember(message);

  const ignoredRoleIds = Array.isArray(settings.ignored_role_ids)
    ? settings.ignored_role_ids
    : [];
  if (
    member &&
    ignoredRoleIds.length &&
    member.roles?.cache?.some((role) => ignoredRoleIds.includes(role.id))
  ) {
    return false;
  }

  const ignoredChannelIds = Array.isArray(settings.ignored_channel_ids) ? settings.ignored_channel_ids : [];
  if (ignoredChannelIds.includes(message.channelId)) return false;

  const ticketSettings = await getGuildTicketSettings(message.guildId).catch(() => null);
  if (ticketSettings?.tickets_category_id) {
    const parentIdToCheck = message.channel?.isThread?.() ? message.channel.parent?.parentId : message.channel?.parentId;
    if (parentIdToCheck === ticketSettings.tickets_category_id) {
      return false;
    }
  }

  const textForDetection = resolveMessageTextForDetection(message);
  const detection = detectViolation(textForDetection, settings);
  if (!detection) return false;

  const burstCount = observeViolationBurst(message);
  if (burstCount >= BURST_SWEEP_THRESHOLD) {
    scheduleBurstSweep({ message, settings });
  }

  const action = normalizeAction(settings.enforcement_action);
  const timeoutMinutes = normalizeTimeoutMinutes(settings.timeout_minutes);
  const reason = `[AntiLink] ${detection.reason}`;
  const moderation = await applyModerationAction({
    message,
    member,
    action,
    timeoutMinutes,
    reason,
  });

  if (shouldSendNotice(message)) {
    void sendAntiLinkNotice({
      message,
      detection,
      action,
      timeoutMinutes,
    }).catch(() => null);
  }

  void sendAntiLinkLog({
    message,
    settings,
    action,
    timeoutMinutes,
    detection,
    moderation,
  }).catch(() => null);

  return true;
}

module.exports = {
  detectViolation,
  handleAntiLinkMessage,
};
