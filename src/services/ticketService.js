const {
  ActionRowBuilder,
  ChannelType,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");
const { env } = require("../config/env");
const {
  claimTicket,
  closeTicket,
  closeTicketAsDeleted,
  createTicket,
  deleteTicketAiSuggestionSession,
  getAllOpenTickets,
  getGuildTicketRuntime,
  getLastTicketForUser,
  getOpenTicketByChannel,
  getOpenTicketsForUser,
  getTicketAiSuggestionSession,
  registerEvent,
  upsertTicketAiSuggestionSession,
  upsertTicketTranscript,
  updateTicketIntroMessageId,
} = require("./supabaseService");
const { CUSTOM_IDS } = require("../constants/customIds");
const {
  sendTicketClaimedLog,
  sendTicketClosedLog,
  sendTicketCreatedLog,
} = require("./logService");
const {
  buildTicketDisabledInteractionPayload,
  ensureTicketPanels,
} = require("./ticketPanelService");
const { generateTranscriptHtml } = require("./transcriptService");
const { buildTicketChannelName } = require("../utils/channelName");
const {
  buildLogPayload,
  buildTicketIntroPayload,
  buildTicketSimpleMessagePayload,
  buildAiSuggestionPayload,
} = require("../utils/componentFactory");
const { generateProtocol } = require("../utils/protocol");
const {
  buildTranscriptUrl,
  createTranscriptAccessCode,
  hashTranscriptAccessCode,
} = require("../utils/transcriptAccess");
const {
  canClaimTicket,
  canCloseTicket,
  resolveStaffVisibilityRoleIds,
} = require("../utils/staff");
const {
  buildTicketClosureNotificationKey,
  enqueueTicketClosureDirectMessage,
  processDirectMessageQueue,
} = require("./directMessageQueueService");
const {
  isTicketAiEnabledForRuntime,
  markTicketAiClosed,
  markTicketAiHandoff,
  sendInitialTicketAiMessage,
  generateAiSuggestion,
  sendTicketAiInteractionLog,
} = require("./ticketAiService");
const {
  sendSupportTicketOpenedEmail,
} = require("./emailNotificationService");

const pendingTicketReasons = new Map();

const AI_SUGGESTION_SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const OPEN_TICKET_LOCK_TTL_MS = 15 * 1000;
const MINIMUM_MESSAGES_FOR_TRANSCRIPT = 6;
const openTicketLocks = new Map();
let warnedAboutMissingIntroMessageColumn = false;
let warnedAboutMissingAiSuggestionSessionTable = false;

function buildOpenTicketLockKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function buildPendingReasonKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function resolveAiSuggestionSessionExpiresAt() {
  return Date.now() + AI_SUGGESTION_SESSION_TTL_MS;
}

function readPendingTicketReasonFromMemory(guildId, userId) {
  const pendingKey = buildPendingReasonKey(guildId, userId);
  const cached = pendingTicketReasons.get(pendingKey);
  if (!cached) {
    return null;
  }

  if (!cached.expiresAt || cached.expiresAt < Date.now()) {
    pendingTicketReasons.delete(pendingKey);
    return null;
  }

  return cached;
}

function cachePendingTicketReason(guildId, userId, value) {
  const pendingKey = buildPendingReasonKey(guildId, userId);
  pendingTicketReasons.set(pendingKey, {
    reason: String(value?.reason || "").trim(),
    suggestion: String(value?.suggestion || "").trim(),
    expiresAt:
      typeof value?.expiresAt === "number" && Number.isFinite(value.expiresAt)
        ? value.expiresAt
        : resolveAiSuggestionSessionExpiresAt(),
  });
}

function clearPendingTicketReasonFromMemory(guildId, userId) {
  pendingTicketReasons.delete(buildPendingReasonKey(guildId, userId));
}

function isMissingAiSuggestionSessionTableError(error) {
  const normalized = String(error?.message || "").toLowerCase();
  return (
    normalized.includes("ticket_ai_suggestion_sessions") &&
    (normalized.includes("does not exist") || normalized.includes("relation"))
  );
}

function logAiSuggestionSessionFallback(operation, error) {
  if (!isMissingAiSuggestionSessionTableError(error) || warnedAboutMissingAiSuggestionSessionTable) {
    return;
  }

  warnedAboutMissingAiSuggestionSessionTable = true;
  logTicketFlowFailure(`ai-suggestion-session-${operation}-migration-missing`, error);
}

async function persistPendingTicketReason(guildId, userId, reason, suggestion) {
  const expiresAt = resolveAiSuggestionSessionExpiresAt();
  cachePendingTicketReason(guildId, userId, {
    reason,
    suggestion,
    expiresAt,
  });

  try {
    await upsertTicketAiSuggestionSession({
      guildId,
      userId,
      reason,
      suggestion,
      expiresAt: new Date(expiresAt).toISOString(),
    });
  } catch (error) {
    if (isMissingAiSuggestionSessionTableError(error)) {
      logAiSuggestionSessionFallback("persist", error);
      return;
    }

    logTicketFlowFailure("persist-ai-suggestion-session", error, {
      guildId,
      userId,
    });
  }
}

async function loadPendingTicketReason(guildId, userId) {
  const cached = readPendingTicketReasonFromMemory(guildId, userId);
  if (cached) {
    return cached;
  }

  try {
    const session = await getTicketAiSuggestionSession(guildId, userId);
    if (!session) {
      return null;
    }

    const expiresAtMs = Date.parse(String(session.expires_at || ""));
    if (!Number.isFinite(expiresAtMs) || expiresAtMs < Date.now()) {
      await clearPendingTicketReason(guildId, userId);
      return null;
    }

    const restored = {
      reason: String(session.reason || "").trim(),
      suggestion: String(session.suggestion || "").trim(),
      expiresAt: expiresAtMs,
    };

    cachePendingTicketReason(guildId, userId, restored);
    return restored;
  } catch (error) {
    if (isMissingAiSuggestionSessionTableError(error)) {
      logAiSuggestionSessionFallback("load", error);
      return null;
    }

    logTicketFlowFailure("load-ai-suggestion-session", error, {
      guildId,
      userId,
    });
    return null;
  }
}

async function clearPendingTicketReason(guildId, userId) {
  clearPendingTicketReasonFromMemory(guildId, userId);

  try {
    await deleteTicketAiSuggestionSession(guildId, userId);
  } catch (error) {
    if (isMissingAiSuggestionSessionTableError(error)) {
      logAiSuggestionSessionFallback("clear", error);
      return;
    }

    logTicketFlowFailure("clear-ai-suggestion-session", error, {
      guildId,
      userId,
    });
  }
}

async function ensureAiSuggestionInteractionAcknowledged(interaction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferUpdate();
  }
}

async function replaceAiSuggestionReply(interaction, message) {
  await interaction.editReply(buildTicketSimpleMessagePayload(message));
}

function normalizeOpenedReason(reason) {
  return String(reason || "").trim().replace(/\r\n/g, "\n").slice(0, 900);
}

function acquireOpenTicketLock(guildId, userId) {
  const lockKey = buildOpenTicketLockKey(guildId, userId);
  const now = Date.now();
  const currentLockExpiration = openTicketLocks.get(lockKey);

  if (currentLockExpiration && currentLockExpiration > now) {
    return false;
  }

  openTicketLocks.set(lockKey, now + OPEN_TICKET_LOCK_TTL_MS);
  return true;
}

function releaseOpenTicketLock(guildId, userId) {
  openTicketLocks.delete(buildOpenTicketLockKey(guildId, userId));
}

function walkComponents(components, visitor) {
  if (!Array.isArray(components)) return;

  for (const component of components) {
    if (!component) continue;
    visitor(component);

    if (Array.isArray(component.components) && component.components.length) {
      walkComponents(component.components, visitor);
    }
  }
}

async function replyWithTicketPayload(interaction, payload) {
  const normalizedPayload = {
    ...payload,
    flags: (payload.flags || 0) | MessageFlags.Ephemeral,
  };

  if (interaction.deferred && !interaction.replied) {
    await interaction.followUp(normalizedPayload);
    return;
  }

  if (interaction.replied) {
    await interaction.followUp(normalizedPayload);
    return;
  }

  await interaction.reply(normalizedPayload);
}

function logTicketFlowFailure(stage, error, metadata = {}) {
  console.error(`[ticket-flow:${stage}]`, {
    message: error instanceof Error ? error.message : String(error),
    ...metadata,
  });
}

function isMissingTicketIntroMessageIdColumnError(error) {
  const normalized = String(error?.message || "").toLowerCase();
  return normalized.includes("intro_message_id");
}

async function persistTicketIntroMessageId(ticket, introMessageId, metadata = {}) {
  const normalizedIntroMessageId = String(introMessageId || "").trim();
  if (!ticket?.id || !normalizedIntroMessageId) return null;

  try {
    const updatedTicket = await updateTicketIntroMessageId(
      ticket.id,
      normalizedIntroMessageId,
    );
    ticket.intro_message_id = updatedTicket?.intro_message_id || normalizedIntroMessageId;
    return updatedTicket;
  } catch (error) {
    if (isMissingTicketIntroMessageIdColumnError(error)) {
      if (!warnedAboutMissingIntroMessageColumn) {
        warnedAboutMissingIntroMessageColumn = true;
        logTicketFlowFailure("persist-ticket-intro-message-id-migration-missing", error, metadata);
      }
      return null;
    }

    logTicketFlowFailure("persist-ticket-intro-message-id", error, metadata);
    return null;
  }
}

function resolveTicketClosureDmStatus(queueResults, notificationKey) {
  if (!Array.isArray(queueResults)) {
    return "queued";
  }

  const matchedResult = queueResults.find(
    (queueResult) => queueResult?.notificationKey === notificationKey,
  );

  return matchedResult?.status || "queued";
}

function resolveTranscriptUnavailableText(reason) {
  return reason === "generation_failed"
    ? "por falha ao gerar o historico agora"
    : "por falta de mensagens";
}

function buildTicketClosureReplyMessage(transcriptAvailable, dmStatus, transcriptReason) {
  if (!transcriptAvailable) {
    const unavailableText = resolveTranscriptUnavailableText(transcriptReason);
    switch (dmStatus) {
      case "sent":
        return `Ticket fechado. O transcript ficou indisponivel ${unavailableText}, mas o resumo com protocolo foi enviado no privado do solicitante.`;
      case "blocked":
        return `Ticket fechado. O transcript ficou indisponivel ${unavailableText}, mas o solicitante nao pode receber privado do bot.`;
      case "failed":
        return `Ticket fechado. O transcript ficou indisponivel ${unavailableText}, e o envio do resumo no privado falhou apos varias tentativas.`;
      default:
        return `Ticket fechado. O transcript ficou indisponivel ${unavailableText}, e o resumo com protocolo foi colocado na fila de entrega do privado.`;
    }
  }

  switch (dmStatus) {
    case "sent":
      return "Ticket fechado, log atualizado e codigo do transcript enviado no privado do solicitante.";
    case "blocked":
      return "Ticket fechado e transcript protegido com link no log, mas o solicitante nao pode receber privado do bot.";
    case "failed":
      return "Ticket fechado e transcript protegido com link no log, mas a entrega do codigo no privado falhou apos varias tentativas.";
    default:
      return "Ticket fechado, log atualizado e entrega do codigo ficou na fila do privado do solicitante.";
  }
}

function resolveTicketClosureReplyTone(transcriptAvailable, dmStatus) {
  if (transcriptAvailable && dmStatus === "sent") {
    return "success";
  }

  return "warning";
}

function messageLooksLikeTicketIntroMessage(message) {
  if (!message?.author?.bot || message.author.id !== message.client.user.id) {
    return false;
  }

  let foundIntroControl = false;
  walkComponents(message.components, (component) => {
    const customId = component.customId || component.data?.custom_id;
    if (
      customId === CUSTOM_IDS.ticketAdminPanel ||
      customId === CUSTOM_IDS.ticketStaffPanel ||
      customId === CUSTOM_IDS.ticketMemberPanel ||
      customId === CUSTOM_IDS.closeTicket
    ) {
      foundIntroControl = true;
    }
  });

  return foundIntroControl;
}

async function fetchExistingTicketIntroMessage(channel, storedMessageId = null) {
  const normalizedStoredMessageId = String(storedMessageId || "").trim();
  if (normalizedStoredMessageId) {
    const storedMessage = await channel.messages
      .fetch(normalizedStoredMessageId)
      .catch(() => null);

    if (storedMessage && messageLooksLikeTicketIntroMessage(storedMessage)) {
      return storedMessage;
    }
  }

  const recentMessages = await channel.messages.fetch({ limit: 100 });
  return recentMessages.find((message) => messageLooksLikeTicketIntroMessage(message)) || null;
}

async function shouldGenerateTranscript(channel) {
  const recentMessages = await channel.messages.fetch({ limit: MINIMUM_MESSAGES_FOR_TRANSCRIPT });
  return recentMessages.size >= MINIMUM_MESSAGES_FOR_TRANSCRIPT;
}

function resolveTicketOwnerSummary(ticket) {
  if (!ticket?.claimed_by) {
    return "Ainda nao assumido por ninguem.";
  }

  return `<@${ticket.claimed_by}>`;
}

async function replyWithTicketContextPanel(interaction, options) {
  const ticket = await getOpenTicketByChannel(
    interaction.guild.id,
    interaction.channel.id,
  );

  if (!ticket) {
    await replyWithTicketMessage(interaction, {
      title: "Ticket nao encontrado",
      message: "Este canal nao possui ticket aberto vinculado.",
      tone: "error",
    });
    return;
  }

  await replyWithTicketMessage(interaction, options(ticket));
}

async function showMemberTicketPanelFromInteraction(interaction) {
  await replyWithTicketContextPanel(interaction, (ticket) => ({
    title: "Painel do membro",
    message: [
      `Protocolo: \`${ticket.protocol}\``,
      `Responsavel: ${resolveTicketOwnerSummary(ticket)}`,
      "Use este canal para enviar detalhes, arquivos e tudo o que a equipe precisa para continuar o atendimento.",
    ].join("\n"),
    tone: "neutral",
  }));
}

async function showStaffTicketPanelFromInteraction(interaction) {
  const runtime = await ensureGuildRuntimeOrReply(interaction);
  if (!runtime) return;

  if (
    !canClaimTicket(interaction.member, runtime.staffSettings) &&
    !canCloseTicket(interaction.member, runtime.staffSettings)
  ) {
    await replyWithTicketMessage(interaction, {
      title: "Acesso negado",
      message: "Apenas a equipe configurada pode usar o painel staff deste ticket.",
      tone: "error",
    });
    return;
  }

  await replyWithTicketContextPanel(interaction, (ticket) => ({
    title: "Painel staff",
    message: [
      `Protocolo: \`${ticket.protocol}\``,
      `Solicitante: <@${ticket.user_id}>`,
      `Responsavel atual: ${resolveTicketOwnerSummary(ticket)}`,
      "Voce pode assumir o atendimento e acompanhar este canal com as permissoes da equipe.",
    ].join("\n"),
    tone: "warning",
  }));
}

async function showAdminTicketPanelFromInteraction(interaction) {
  const runtime = await ensureGuildRuntimeOrReply(interaction);
  if (!runtime) return;

  if (!canCloseTicket(interaction.member, runtime.staffSettings)) {
    await replyWithTicketMessage(interaction, {
      title: "Acesso negado",
      message: "Apenas administradores e a equipe com permissao de fechamento podem usar o painel admin.",
      tone: "error",
    });
    return;
  }

  await replyWithTicketContextPanel(interaction, (ticket) => ({
    title: "Painel admin",
    message: [
      `Protocolo: \`${ticket.protocol}\``,
      `Solicitante: <@${ticket.user_id}>`,
      `Responsavel atual: ${resolveTicketOwnerSummary(ticket)}`,
      "Voce pode revisar o atendimento, orientar a equipe e encerrar o ticket quando necessario.",
    ].join("\n"),
    tone: "warning",
  }));
}

async function syncOpenTicketControlMessages(client) {
  const openTickets = await getAllOpenTickets();
  const applied = [];
  const skipped = [];

  for (const ticket of openTickets) {
    try {
      const guild =
        client.guilds.cache.get(ticket.guild_id) ||
        (await client.guilds.fetch(ticket.guild_id).catch(() => null));

      if (!guild) {
        skipped.push({ guildId: ticket.guild_id, channelId: ticket.channel_id, reason: "guild_unavailable" });
        continue;
      }

      const channel =
        guild.channels.cache.get(ticket.channel_id) ||
        (await guild.channels.fetch(ticket.channel_id).catch(() => null));

      if (!channel || !channel.isTextBased()) {
        await reconcileDeletedTicketChannel(ticket.guild_id, ticket.channel_id);
        skipped.push({ guildId: ticket.guild_id, channelId: ticket.channel_id, reason: "channel_unavailable" });
        continue;
      }

      const payload = buildTicketIntroPayload({ ticket });
      const existingMessage = await fetchExistingTicketIntroMessage(
        channel,
        ticket.intro_message_id || null,
      );

      if (!existingMessage) {
        skipped.push({
          guildId: ticket.guild_id,
          channelId: ticket.channel_id,
          reason: "intro_message_missing",
        });
        continue;
      }

      const syncedMessage = await existingMessage.edit(payload);

      if (ticket.intro_message_id !== syncedMessage.id) {
        await persistTicketIntroMessageId(ticket, syncedMessage.id, {
          guildId: ticket.guild_id,
          channelId: ticket.channel_id,
          protocol: ticket.protocol,
        });
      }

      applied.push({
        guildId: ticket.guild_id,
        channelId: ticket.channel_id,
        messageId: syncedMessage.id,
        mode: "updated",
      });
    } catch (error) {
      skipped.push({
        guildId: ticket.guild_id,
        channelId: ticket.channel_id,
        reason: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  return {
    applied,
    skipped,
    total: openTickets.length,
  };
}

function isUnknownChannelError(error) {
  return (
    error?.code === 10003 ||
    error?.rawError?.code === 10003 ||
    error?.status === 404
  );
}

async function fetchGuildChannelFresh(guild, channelId) {
  try {
    return await guild.channels.fetch(channelId, { force: true });
  } catch (error) {
    if (isUnknownChannelError(error)) {
      return null;
    }

    throw error;
  }
}

async function replyWithTicketMessage(interaction, message) {
  await replyWithTicketPayload(
    interaction,
    buildTicketSimpleMessagePayload(message),
  );
}

async function reconcileDeletedTicketChannel(guildId, channelId) {
  const ticket = await getOpenTicketByChannel(guildId, channelId);

  if (!ticket) {
    return null;
  }

  const closedTicket = await closeTicketAsDeleted(ticket.id);
  if (!closedTicket) {
    return null;
  }

  await registerEvent({
    ticketId: closedTicket.id,
    protocol: closedTicket.protocol,
    guildId,
    channelId,
    actorId: "system:channel_deleted",
    eventType: "closed",
    metadata: {
      reason: "channel_deleted",
    },
  });

  return closedTicket;
}

async function reconcileDeletedTicketChannelsForUser(guild, userId) {
  const openTickets = await getOpenTicketsForUser(guild.id, userId);
  const cleanedTickets = [];

  for (const ticket of openTickets) {
    const existingChannel = await fetchGuildChannelFresh(guild, ticket.channel_id);

    if (existingChannel) {
      continue;
    }

    const closedTicket = await reconcileDeletedTicketChannel(
      guild.id,
      ticket.channel_id,
    );
    if (!closedTicket) {
      continue;
    }

    cleanedTickets.push(closedTicket);
  }

  return cleanedTickets;
}

async function ensureGuildRuntimeOrReply(interaction) {
  const runtime = await getGuildTicketRuntime(interaction.guild.id);

  if (!runtime.settings || !runtime.staffSettings) {
    await replyWithTicketMessage(
      interaction,
      {
        title: "Configuracao pendente",
        message:
          "As configuracoes do ticket deste servidor ainda nao foram concluidas no Flowdesk.",
        tone: "warning",
      },
    );
    return null;
  }

  return {
    ...runtime,
    accentColor: env.accentColor,
  };
}

async function showOpenTicketReasonModal(interaction) {
  if (!interaction.inGuild()) {
    await replyWithTicketMessage(
      interaction,
      {
        title: "Servidor obrigatorio",
        message: "Este bot funciona apenas dentro de servidores.",
        tone: "warning",
      },
    );
    return;
  }

  const runtime = await ensureGuildRuntimeOrReply(interaction);
  if (!runtime) return;

  if (!runtime.licenseUsable || runtime.settings.enabled !== true) {
    await replyWithTicketPayload(
      interaction,
      buildTicketDisabledInteractionPayload(runtime),
    );
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(CUSTOM_IDS.openTicketReasonModal)
    .setTitle("Abrir atendimento");

  const reasonInput = new TextInputBuilder()
    .setCustomId(CUSTOM_IDS.openTicketReasonInput)
    .setLabel("Motivo do atendimento")
    .setPlaceholder("Explique em poucas palavras o motivo do seu atendimento.")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMinLength(5)
    .setMaxLength(900);

  modal.addComponents(
    new ActionRowBuilder().addComponents(reasonInput),
  );

  await interaction.showModal(modal);
}

async function openTicketFromInteraction(interaction, openedReason = "", aiSuggestion = null) {
  if (!interaction.inGuild()) {
    await replyWithTicketMessage(
      interaction,
      {
        title: "Servidor obrigatorio",
        message: "Este bot funciona apenas dentro de servidores.",
        tone: "warning",
      },
    );
    return;
  }

  const runtime = await ensureGuildRuntimeOrReply(interaction);
  if (!runtime) return;

  if (!runtime.licenseUsable || runtime.settings.enabled !== true) {
    await replyWithTicketPayload(
      interaction,
      buildTicketDisabledInteractionPayload(runtime),
    );
    return;
  }

  const guild = interaction.guild;
  const user = interaction.user;
  const normalizedOpenedReason = normalizeOpenedReason(openedReason);
  const lockAcquired = acquireOpenTicketLock(guild.id, user.id);

  if (!lockAcquired) {
    await replyWithTicketMessage(
      interaction,
      {
        title: "Preparando ticket",
        message:
          "Seu ticket ja esta sendo preparado. Aguarde alguns segundos antes de tentar novamente.",
        tone: "warning",
      },
    );
    return;
  }

  try {
    const cleanedDeletedTickets = await reconcileDeletedTicketChannelsForUser(
      guild,
      user.id,
    );

    const [openTickets, lastTicket] = await Promise.all([
      getOpenTicketsForUser(guild.id, user.id),
      getLastTicketForUser(guild.id, user.id),
    ]);

    const openCount = openTickets.length;

    if (openCount >= env.maxOpenTicketsPerUser) {
      await replyWithTicketMessage(
        interaction,
        {
          title: "Ticket ja aberto",
          message: `Voce ja possui ${openCount} ticket(s) aberto(s).`,
          tone: "warning",
        },
      );
      return;
    }

    if (lastTicket?.opened_at && cleanedDeletedTickets.length === 0) {
      const openedAt = new Date(lastTicket.opened_at).getTime();
      const now = Date.now();
      const cooldownMs = env.openCooldownSeconds * 1000;
      const remaining = openedAt + cooldownMs - now;

      if (remaining > 0) {
        const seconds = Math.ceil(remaining / 1000);
        await replyWithTicketMessage(
          interaction,
          {
            title: "Aguarde um pouco",
            message: `Aguarde ${seconds}s para abrir outro ticket.`,
            tone: "warning",
          },
        );
        return;
      }
    }

    const botMember = guild.members.me || (await guild.members.fetchMe());
    const categoryChannel =
      guild.channels.cache.get(runtime.settings.tickets_category_id) ||
      (await guild.channels
        .fetch(runtime.settings.tickets_category_id)
        .catch(() => null));

    if (!categoryChannel || categoryChannel.type !== ChannelType.GuildCategory) {
      await replyWithTicketMessage(
        interaction,
        {
          title: "Categoria indisponivel",
          message:
            "A categoria configurada para os tickets nao foi encontrada neste servidor.",
          tone: "error",
        },
      );
      return;
    }

    const botPermissionsInCategory = categoryChannel.permissionsFor(botMember);
    if (
      !botPermissionsInCategory?.has(PermissionFlagsBits.ViewChannel) ||
      !botPermissionsInCategory?.has(PermissionFlagsBits.ManageChannels)
    ) {
      await replyWithTicketMessage(
        interaction,
        {
          title: "Permissoes insuficientes",
          message:
            "O bot nao possui permissoes suficientes na categoria configurada para criar tickets.",
          tone: "error",
        },
      );
      return;
    }

    const protocol = generateProtocol();
    const channelName = buildTicketChannelName(user.username, protocol);
    const visibilityRoleIds = resolveStaffVisibilityRoleIds(
      runtime.staffSettings,
    );
    const permissionOverwrites = [
      {
        id: guild.roles.everyone.id,
        deny: [PermissionFlagsBits.ViewChannel],
      },
      {
        id: user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks,
        ],
      },
      {
        id: botMember.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.ManageChannels,
          PermissionFlagsBits.ManageMessages,
        ],
      },
    ];

    for (const roleId of visibilityRoleIds) {
      permissionOverwrites.push({
        id: roleId,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.AttachFiles,
          PermissionFlagsBits.EmbedLinks,
          PermissionFlagsBits.ManageMessages,
        ],
      });
    }

    const channel = await guild.channels.create({
      name: channelName,
      type: ChannelType.GuildText,
      parent: categoryChannel.id,
      topic: `protocol=${protocol};user=${user.id}`,
      permissionOverwrites,
    });

    let ticket = null;

    try {
      ticket = await createTicket({
        protocol,
        guildId: guild.id,
        channelId: channel.id,
        userId: user.id,
        openedReason: normalizedOpenedReason,
      });
    } catch (error) {
      await channel.delete("Falha ao salvar ticket no banco").catch(() => null);
      throw error;
    }

    try {
      await registerEvent({
        ticketId: ticket.id,
        protocol: ticket.protocol,
        guildId: guild.id,
        channelId: channel.id,
        actorId: user.id,
        eventType: "created",
        metadata: {
          opened_by: user.id,
          opened_reason: normalizedOpenedReason,
        },
      });
    } catch (error) {
      logTicketFlowFailure("register-created-event", error, {
        guildId: guild.id,
        channelId: channel.id,
        protocol: ticket.protocol,
        userId: user.id,
      });
    }

    void sendSupportTicketOpenedEmail({
      discordUserId: user.id,
      protocol: ticket.protocol,
      guildName: guild.name,
      channelUrl: `https://discord.com/channels/${guild.id}/${channel.id}`,
      reason: normalizedOpenedReason,
    });

    try {
      const introMessage = await channel.send(buildTicketIntroPayload({ ticket }));
      await persistTicketIntroMessageId(ticket, introMessage.id, {
        guildId: guild.id,
        channelId: channel.id,
        protocol: ticket.protocol,
        userId: user.id,
      });
    } catch (error) {
      logTicketFlowFailure("send-ticket-intro", error, {
        guildId: guild.id,
        channelId: channel.id,
        protocol: ticket.protocol,
      });

      await channel
        .send(
          buildTicketSimpleMessagePayload({
            title: "Ticket criado",
            message: `Ticket criado com sucesso para <@${user.id}>.\nProtocolo: \`${ticket.protocol}\``,
            tone: "success",
          }),
        )
    }
    
    // Send AI suggestion summary for staff visibility
    if (aiSuggestion) {
      try {
        await channel.send(buildTicketSimpleMessagePayload({
          title: "🤖 Triagem IA",
          message: [
            "O usuário recebeu a seguinte sugestão antes de abrir este ticket:",
            "",
            aiSuggestion,
          ].join("\n"),
          tone: "neutral",
        })).catch(() => null);
      } catch (error) {
        logTicketFlowFailure("send-ai-suggestion-summary", error, {
          guildId: guild.id,
          channelId: channel.id,
          protocol: ticket.protocol,
        });
      }
    }

    try {
      await sendInitialTicketAiMessage(interaction.client, ticket);
    } catch (error) {
      logTicketFlowFailure("send-ticket-ai-welcome", error, {
        guildId: guild.id,
        channelId: channel.id,
        protocol: ticket.protocol,
      });
    }

    try {
      await sendTicketCreatedLog(guild, ticket, runtime);
    } catch (error) {
      logTicketFlowFailure("send-created-log", error, {
        guildId: guild.id,
        channelId: channel.id,
        protocol: ticket.protocol,
      });
    }

    try {
      await replyWithTicketMessage(
        interaction,
        {
          title: "Ticket criado",
          message: `Ticket criado com sucesso: <#${channel.id}>`,
          tone: "success",
        },
      );
    } catch (error) {
      logTicketFlowFailure("reply-open-success", error, {
        guildId: guild.id,
        channelId: channel.id,
        protocol: ticket.protocol,
        interactionId: interaction.id,
      });
    }
  } finally {
    releaseOpenTicketLock(guild.id, user.id);
  }
}

async function openTicketFromModalSubmit(interaction) {
  if (!interaction.inGuild()) {
    await replyWithTicketMessage(interaction, {
      title: "Servidor obrigatorio",
      message: "Este bot funciona apenas dentro de servidores.",
      tone: "warning",
    });
    return;
  }

  const openedReason = interaction.fields.getTextInputValue(
    CUSTOM_IDS.openTicketReasonInput,
  );

  // Immediate feedback
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  try {
    const runtime = await getGuildTicketRuntime(interaction.guild.id);
    
    if (!runtime.settings || !runtime.staffSettings) {
      await interaction.editReply(buildTicketSimpleMessagePayload({
        title: "Configuracao pendente",
        message: "As configuracoes do ticket deste servidor ainda nao foram concluidas no Flowdesk.",
        tone: "warning",
      }));
      return;
    }

    const guildRuntime = {
      ...runtime,
      accentColor: env.accentColor,
    };

    if (!runtime.licenseUsable || runtime.settings.enabled !== true) {
      await interaction.editReply(buildTicketDisabledInteractionPayload(guildRuntime));
      return;
    }

    if (isTicketAiEnabledForRuntime(guildRuntime)) {
      try {
        const suggestion = await generateAiSuggestion(
          openedReason,
          guildRuntime.settings,
          interaction.user.id,
          {
            guildId: interaction.guild.id,
            guildName: interaction.guild.name,
            userName: interaction.user.displayName || interaction.user.username,
          },
        );

        await persistPendingTicketReason(
          interaction.guild.id,
          interaction.user.id,
          openedReason,
          suggestion,
        );

        const payload = buildAiSuggestionPayload({
          suggestion,
          guildName: interaction.guild.name,
        });

        await interaction.editReply(payload);
        return;
      } catch (error) {
        console.error("[ticketService:aiSuggestion] Falha ao gerar sugestão:", error);
        // If it's a specific AI/Token error, we can continue to standard flow
      }
    }

    // Fallback or explicit skip to standard ticket opening
    await openTicketFromInteraction(interaction, openedReason);
  } catch (error) {
    const errorMessage = String(error?.message || "");
    
    // Check if it's a database migration issue (missing column)
    if (errorMessage.includes("ai_rules") || errorMessage.includes("column does not exist")) {
      await interaction.editReply(buildTicketSimpleMessagePayload({
        title: "⚠️ Erro de Banco de Dados",
        message: "A coluna `ai_rules` não foi encontrada no seu banco de dados Supabase.\n\n**Ação necessária:** Execute o script SQL `072_add_ai_rules_to_settings.sql` no dashboard do seu Supabase para corrigir este problema.",
        tone: "error",
      }));
      return;
    }

    console.error("[ticketService:modalSubmit] Erro fatal:", error);
    await interaction.editReply(buildTicketSimpleMessagePayload({
      title: "Falha na solicitação",
      message: "Ocorreu um erro inesperado ao processar seu ticket. Tente novamente em alguns segundos.",
      tone: "error",
    }));
  }
}

async function handleAiSuggestionHelped(interaction) {
  await ensureAiSuggestionInteractionAcknowledged(interaction);
  const cached = await loadPendingTicketReason(interaction.guild.id, interaction.user.id);
  await clearPendingTicketReason(interaction.guild.id, interaction.user.id);

  if (cached) {
    await sendTicketAiInteractionLog(interaction.client, {
      ticket: { guild_id: interaction.guild.id, protocol: "N/A (Pre-ticket)" },
      userId: interaction.user.id,
      prompt: cached.reason,
      response: cached.suggestion,
      source: "ai_suggestion",
      status: "resolved_by_ai",
    }).catch(console.error);
  }

  await replaceAiSuggestionReply(interaction, {
    title: "Atendimento encerrado",
    message: "Perfeito. A sugestao resolveu seu caso e o ticket nao foi aberto.",
    tone: "success",
  }).catch(() => null);
  return;

  const successPayload = buildTicketSimpleMessagePayload({
    title: "✅ Atendimento Encerrado",
    message: "Fico feliz que a sugestão ajudou! Atendimento encerrado antes de abrir o ticket.",
    tone: "success",
  });

  await interaction.update({
    ...successPayload,
    components: [], // Explicitly ensure buttons are gone
  }).catch(() => {
    interaction.editReply({ 
      content: "✅ Atendimento encerrado. Fico feliz que ajudou!", 
      components: [] 
    }).catch(() => null);
  });
}

async function handleAiSuggestionContinue(interaction) {
  await ensureAiSuggestionInteractionAcknowledged(interaction);
  const restoredSession = await loadPendingTicketReason(interaction.guild.id, interaction.user.id);

  if (!restoredSession) {
    await clearPendingTicketReason(interaction.guild.id, interaction.user.id);
    await replaceAiSuggestionReply(interaction, {
      title: "Sessao encerrada",
      message: "Essa sugestao nao esta mais disponivel. Abra o ticket novamente para gerar uma nova triagem.",
      hint: "A sessao da sugestao fica salva por ate 12 horas.",
      tone: "warning",
    }).catch(() => null);
    await replyWithTicketMessage(interaction, {
      title: "Sessao encerrada",
      message: "Essa sugestao nao esta mais disponivel. Abra o ticket novamente para gerar uma nova triagem.",
      tone: "warning",
    });
    return;
  }

  const runtime = interaction.inGuild()
    ? await getGuildTicketRuntime(interaction.guild.id).catch(() => null)
    : null;
  const shouldReuseAiSuggestion = isTicketAiEnabledForRuntime(runtime);
  const suggestionForTicket = shouldReuseAiSuggestion
    ? restoredSession.suggestion
    : null;

  await sendTicketAiInteractionLog(interaction.client, {
    ticket: { guild_id: interaction.guild.id, protocol: "N/A (Pre-ticket)" },
    userId: interaction.user.id,
    prompt: restoredSession.reason,
    response: restoredSession.suggestion,
    source: "ai_suggestion",
    status: "continued_to_ticket",
  }).catch(console.error);

  await replaceAiSuggestionReply(interaction, {
    title: "Abrindo ticket",
    message: shouldReuseAiSuggestion
      ? "Estou usando essa triagem para abrir seu atendimento agora."
      : "O FlowAI esta desligado neste servidor agora, entao vou abrir seu atendimento direto.",
    hint: "Se algo impedir a abertura, eu aviso logo abaixo.",
    tone: "neutral",
  }).catch(() => null);

  await openTicketFromInteraction(interaction, restoredSession.reason, suggestionForTicket);
  return;

  const pendingKey = buildPendingReasonKey(interaction.guild.id, interaction.user.id);
  const cached = pendingTicketReasons.get(pendingKey);
  
  if (!cached || cached.expiresAt < Date.now()) {
    pendingTicketReasons.delete(pendingKey);
    await interaction.reply({
      content: "Sua sessão de sugestão expirou. Por favor, abra o ticket novamente.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  pendingTicketReasons.delete(pendingKey);

  await sendTicketAiInteractionLog(interaction.client, {
    ticket: { guild_id: interaction.guild.id, protocol: "N/A (Pre-ticket)" },
    userId: interaction.user.id,
    prompt: cached.reason,
    response: cached.suggestion,
    source: "ai_suggestion",
    status: "continued_to_ticket",
  }).catch(console.error);
  
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  } else {
    // If it was already a followUp from modal, we might need to edit or send new
    await interaction.editReply({ content: "Abrindo seu ticket agora...", components: [] });
  }
  
  await openTicketFromInteraction(interaction, cached.reason, cached.suggestion);
}

async function claimTicketFromInteraction(interaction) {
  if (!interaction.inGuild()) {
    await replyWithTicketMessage(
      interaction,
      {
        title: "Servidor obrigatorio",
        message: "Este comando funciona apenas dentro de servidores.",
        tone: "warning",
      },
    );
    return;
  }

  const runtime = await ensureGuildRuntimeOrReply(interaction);
  if (!runtime) return;

  if (!canClaimTicket(interaction.member, runtime.staffSettings)) {
    await replyWithTicketMessage(
      interaction,
      {
        title: "Acesso negado",
        message: "Apenas a equipe configurada pode assumir tickets.",
        tone: "error",
      },
    );
    return;
  }

  const channel = interaction.channel;
  const guild = interaction.guild;
  const ticket = await getOpenTicketByChannel(guild.id, channel.id);

  if (!ticket) {
    await replyWithTicketMessage(
      interaction,
      {
        title: "Ticket nao encontrado",
        message: "Este canal nao possui ticket aberto vinculado.",
        tone: "error",
      },
    );
    return;
  }

  if (ticket.claimed_by === interaction.user.id) {
    await replyWithTicketMessage(
      interaction,
      {
        title: "Acao duplicada",
        message: "Voce ja esta como responsavel deste ticket.",
        tone: "warning",
      },
    );
    return;
  }

  const updated = await claimTicket(ticket.id, interaction.user.id);

  await registerEvent({
    ticketId: updated.id,
    protocol: updated.protocol,
    guildId: guild.id,
    channelId: channel.id,
    actorId: interaction.user.id,
    eventType: "claimed",
  });

  try {
    await markTicketAiHandoff(updated, {
      handoffReason: "ticket_claimed",
      handedOffBy: interaction.user.id,
      handedOffAt: new Date().toISOString(),
    });
  } catch (error) {
    logTicketFlowFailure("mark-ticket-ai-claimed", error, {
      guildId: guild.id,
      channelId: channel.id,
      protocol: updated.protocol,
      actorId: interaction.user.id,
    });
  }

  await channel.send(
    buildLogPayload({
      accentColor: runtime.accentColor,
      title: "Ticket assumido",
      lines: [
        `**Protocolo:** \`${updated.protocol}\``,
        `**Responsavel:** <@${interaction.user.id}>`,
      ],
    }),
  );

  await sendTicketClaimedLog(guild, updated, interaction.user.id, runtime);

  await replyWithTicketMessage(interaction, {
    title: "Ticket assumido",
    message: "Ticket assumido com sucesso.",
    tone: "success",
  });
}

async function closeTicketFromInteraction(interaction) {
  if (!interaction.inGuild()) {
    await replyWithTicketMessage(
      interaction,
      {
        title: "Servidor obrigatorio",
        message: "Este comando funciona apenas dentro de servidores.",
        tone: "warning",
      },
    );
    return;
  }

  const runtime = await ensureGuildRuntimeOrReply(interaction);
  if (!runtime) return;

  if (!canCloseTicket(interaction.member, runtime.staffSettings)) {
    await replyWithTicketMessage(
      interaction,
      {
        title: "Acesso negado",
        message: "Apenas a equipe configurada pode fechar tickets.",
        tone: "error",
      },
    );
    return;
  }

  const channel = interaction.channel;
  const guild = interaction.guild;
  const ticket = await getOpenTicketByChannel(guild.id, channel.id);

  if (!ticket) {
    await replyWithTicketMessage(
      interaction,
      {
        title: "Ticket nao encontrado",
        message: "Este canal nao possui ticket aberto vinculado.",
        tone: "error",
      },
    );
    return;
  }

  try {
    const result = await closeOpenTicketChannel({
      client: interaction.client,
      guild,
      channel,
      ticket,
      actorId: interaction.user.id,
      runtime,
    });

    await replyWithTicketMessage(
      interaction,
      {
        title: "Ticket fechado",
        message: buildTicketClosureReplyMessage(
          result.transcriptAvailable,
          result.dmDeliveryStatus,
          result.transcriptReason,
        ),
        tone: resolveTicketClosureReplyTone(
          result.transcriptAvailable,
          result.dmDeliveryStatus,
        ),
      },
    );
  } catch (error) {
    if (String(error?.message || "").includes("Transcript vazio gerado")) {
      await replyWithTicketMessage(interaction, {
        title: "Falha no transcript",
        message:
          "Nao foi possivel proteger e salvar o transcript deste ticket agora. Tente fechar novamente em alguns segundos.",
        tone: "error",
      });
      return;
    }

    throw error;
  }
}

async function closeOpenTicketChannel({
  client,
  guild,
  channel,
  ticket,
  actorId,
  runtime,
}) {
  let transcriptHtml = "";
  let transcriptUrl = "";
  let accessCode = "";
  let dmDeliveryStatus = "queued";
  let transcriptAvailable = false;
  let transcriptReason = "insufficient_messages";

  try {
    transcriptAvailable = await shouldGenerateTranscript(channel);

    if (transcriptAvailable) {
      transcriptHtml = await generateTranscriptHtml(channel);
      if (!String(transcriptHtml || "").trim()) {
        throw new Error("Transcript vazio gerado para o ticket.");
      }

      transcriptUrl = buildTranscriptUrl(ticket.protocol);
      accessCode = createTranscriptAccessCode();

      await upsertTicketTranscript({
        ticketId: ticket.id,
        protocol: ticket.protocol,
        guildId: guild.id,
        channelId: channel.id,
        userId: ticket.user_id,
        closedBy: actorId,
        transcriptHtml,
        accessCodeHash: hashTranscriptAccessCode(ticket.protocol, accessCode),
      });
      transcriptReason = "available";
    }
  } catch (error) {
    logTicketFlowFailure("prepare-transcript", error, {
      guildId: guild.id,
      channelId: channel.id,
      protocol: ticket.protocol,
      actorId,
    });
    transcriptHtml = "";
    transcriptUrl = "";
    accessCode = "";
    transcriptAvailable = false;
    transcriptReason = "generation_failed";
  }

  const updated = await closeTicket(
    ticket.id,
    actorId,
    transcriptAvailable ? transcriptUrl : null,
  );

  try {
    await markTicketAiClosed(updated, {
      handedOffBy: actorId,
      handoffReason: "ticket_closed",
    });
  } catch (error) {
    logTicketFlowFailure("mark-ticket-ai-closed", error, {
      guildId: guild.id,
      channelId: channel.id,
      protocol: updated.protocol,
      actorId,
    });
  }

  try {
    const { notificationKey } = await enqueueTicketClosureDirectMessage({
      ticket: updated,
      closedBy: actorId,
      transcriptAvailable,
      transcriptUrl,
      accessCode,
      transcriptReason,
    });
    const queueResults = await processDirectMessageQueue(client, {
      limit: 10,
      notificationKey,
    });
    dmDeliveryStatus = resolveTicketClosureDmStatus(
      queueResults,
      notificationKey,
    );
  } catch (error) {
    dmDeliveryStatus = "failed";
    logTicketFlowFailure("queue-ticket-closure-dm", error, {
      guildId: guild.id,
      channelId: channel.id,
      protocol: ticket.protocol,
      userId: ticket.user_id,
      notificationKey: buildTicketClosureNotificationKey(updated.id),
    });
  }

  await registerEvent({
    ticketId: updated.id,
    protocol: updated.protocol,
    guildId: guild.id,
    channelId: channel.id,
    actorId,
    eventType: "closed",
    metadata: {
      transcript_url: transcriptUrl,
      transcript_available: transcriptAvailable,
      transcript_dm_delivered: dmDeliveryStatus === "sent",
      transcript_dm_status: dmDeliveryStatus,
      transcript_reason: transcriptReason,
    },
  });

  try {
    await sendTicketClosedLog(
      guild,
      updated,
      {
        available: transcriptAvailable,
        url: transcriptUrl,
        dmStatus: dmDeliveryStatus,
        reason: transcriptReason,
      },
      actorId,
      runtime,
    );
  } catch (error) {
    logTicketFlowFailure("send-closed-log", error, {
      guildId: guild.id,
      channelId: channel.id,
      protocol: updated.protocol,
    });
  }

  await channel
    .send(
      buildLogPayload({
        accentColor: runtime.accentColor,
        title: "Encerramento",
        lines: [
          `**Protocolo:** \`${updated.protocol}\``,
          `**Fechado por:** <@${actorId}>`,
          `Canal sera removido em ${env.deleteDelaySeconds}s.`,
        ],
      }),
    )
    .catch((error) => {
      logTicketFlowFailure("send-close-summary", error, {
        guildId: guild.id,
        channelId: channel.id,
        protocol: updated.protocol,
      });
    });

  setTimeout(async () => {
    await channel.delete("Ticket encerrado").catch(() => null);
  }, env.deleteDelaySeconds * 1000);

  return {
    updated,
    transcriptAvailable,
    transcriptReason,
    dmDeliveryStatus,
    transcriptUrl,
  };
}

async function syncAllTicketPanels(client) {
  return ensureTicketPanels(client);
}


module.exports = {
  reconcileDeletedTicketChannel,
  reconcileDeletedTicketChannelsForUser,
  showOpenTicketReasonModal,
  openTicketFromInteraction,
  openTicketFromModalSubmit,
  handleAiSuggestionHelped,
  handleAiSuggestionContinue,
  claimTicketFromInteraction,
  closeTicketFromInteraction,
  showAdminTicketPanelFromInteraction,
  showStaffTicketPanelFromInteraction,
  showMemberTicketPanelFromInteraction,
  syncOpenTicketControlMessages,
  syncAllTicketPanels,
  closeOpenTicketChannel,
};
