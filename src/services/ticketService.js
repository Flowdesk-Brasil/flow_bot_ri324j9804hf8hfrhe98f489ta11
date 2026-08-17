const {
  ActionRowBuilder,
  AttachmentBuilder,
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
const TICKET_PAYMENT_SYNC_INTERVAL_MS = 7_500;
const TICKET_PAYMENT_SYNC_MAX_MS = 30 * 60_000;
const openTicketLocks = new Map();
let warnedAboutMissingIntroMessageColumn = false;
let warnedAboutMissingAiSuggestionSessionTable = false;

const COMPONENT_TYPE = {
  ACTION_ROW: 1,
  BUTTON: 2,
  STRING_SELECT: 3,
  CONTAINER: 17,
  TEXT_DISPLAY: 10,
  SEPARATOR: 14,
  MEDIA_GALLERY: 12,
};

const BUTTON_STYLE = {
  PRIMARY: 1,
  SECONDARY: 2,
  SUCCESS: 3,
  DANGER: 4,
  LINK: 5,
};

const PANEL_SELECT_PLACEHOLDER = "Escolha uma acao";

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

function formatMoney(value) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(Number(value || 0));
}

function normalizeSnowflake(value) {
  const normalized = String(value || "").trim();
  return /^\d{10,25}$/.test(normalized) ? normalized : "";
}

function parseMoneyInput(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/\s+/g, "")
    .replace(/^R\$/i, "")
    .replace(/\./g, "")
    .replace(",", ".");
  const amount = Number(normalized);
  if (!Number.isFinite(amount)) return null;
  const rounded = Math.round(amount * 100) / 100;
  return rounded >= 1 ? rounded : null;
}

function textDisplay(content) {
  return {
    type: COMPONENT_TYPE.TEXT_DISPLAY,
    content: String(content || "").slice(0, 3900),
  };
}

function separator() {
  return {
    type: COMPONENT_TYPE.SEPARATOR,
    divider: true,
    spacing: 1,
  };
}

function actionRow(components) {
  return {
    type: COMPONENT_TYPE.ACTION_ROW,
    components,
  };
}

function buildTicketActionPanelPayload({ title, ticket, options, tone = "neutral" }) {
  const lines = [
    `### ${title}`,
    "",
    `Protocolo: \`${ticket.protocol}\``,
    `Solicitante: <@${ticket.user_id}>`,
    `Staff: ${resolveTicketOwnerSummary(ticket)}`,
    `Canal: <#${ticket.channel_id}>`,
  ];

  return {
    flags: MessageFlags.IsComponentsV2,
    components: [
      {
        type: COMPONENT_TYPE.CONTAINER,
        accent_color:
          tone === "warning"
            ? 0xf1c40f
            : tone === "success"
              ? 0x2ecc71
              : 0x2b2d31,
        components: [
          textDisplay(lines.join("\n")),
          separator(),
          actionRow([
            {
              type: COMPONENT_TYPE.STRING_SELECT,
              custom_id: options.customId,
              placeholder: PANEL_SELECT_PLACEHOLDER,
              min_values: 1,
              max_values: 1,
              options: options.items.slice(0, 25).map((item) => ({
                label: item.label,
                description: item.description,
                value: item.value,
              })),
            },
          ]),
        ],
      },
    ],
    allowedMentions: { parse: [] },
  };
}

function buildAdminPanelPayload(ticket) {
  return buildTicketActionPanelPayload({
    title: "Painel Admin",
    ticket,
    tone: "warning",
    options: {
      customId: CUSTOM_IDS.ticketAdminSelect,
      items: [
        {
          label: "Assumir ticket",
          description: "Define voce como staff responsavel e atualiza o embed.",
          value: "claim",
        },
        {
          label: "Adicionar membro",
          description: "Libera um usuario extra neste ticket.",
          value: "add_member",
        },
        {
          label: "Remover membro",
          description: "Remove a permissao de um usuario extra.",
          value: "remove_member",
        },
        {
          label: "Criar call",
          description: "Cria uma sala de voz privada para os membros do ticket.",
          value: "create_call",
        },
        {
          label: "Criar pagamento",
          description: "Gera PIX pelo Mercado Pago configurado em Vendas.",
          value: "create_payment",
        },
        {
          label: "Encerrar ticket",
          description: "Fecha o atendimento com transcript e logs.",
          value: "close",
        },
      ],
    },
  });
}

function buildStaffPanelPayload(ticket) {
  return buildTicketActionPanelPayload({
    title: "Painel Staff",
    ticket,
    tone: "warning",
    options: {
      customId: CUSTOM_IDS.ticketStaffSelect,
      items: [
        {
          label: "Assumir atendimento",
          description: "Atualiza responsavel, FlowAI e logs.",
          value: "claim",
        },
        {
          label: "Solicitar detalhes",
          description: "Envia um checklist objetivo para o membro responder.",
          value: "request_details",
        },
        {
          label: "Registrar nota interna",
          description: "Salva uma observacao operacional no historico.",
          value: "internal_note",
        },
        {
          label: "Escalar equipe",
          description: "Notifica cargos configurados para priorizar o ticket.",
          value: "escalate",
        },
        {
          label: "Preparar encerramento",
          description: "Confirma pendencias antes do fechamento.",
          value: "prepare_close",
        },
        {
          label: "Criar call",
          description: "Cria uma call privada para alinhamento.",
          value: "create_call",
        },
      ],
    },
  });
}

function buildMemberPanelPayload(ticket) {
  return buildTicketActionPanelPayload({
    title: "Painel do membro",
    ticket,
    options: {
      customId: CUSTOM_IDS.ticketMemberSelect,
      items: [
        {
          label: "Enviar atualizacao",
          description: "Envia um resumo formatado para a equipe.",
          value: "send_update",
        },
        {
          label: "Chamar staff",
          description: "Sinaliza que voce precisa de retorno da equipe.",
          value: "request_staff",
        },
        {
          label: "Checklist de evidencias",
          description: "Mostra o que anexar para acelerar a analise.",
          value: "evidence_checklist",
        },
        {
          label: "Marcar como resolvido",
          description: "Avisa que sua solicitacao pode ser encerrada.",
          value: "mark_ready",
        },
      ],
    },
  });
}

async function loadTicketForInteraction(interaction) {
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
    return null;
  }

  return ticket;
}

function canUseStaffPanel(member, runtime) {
  return (
    canClaimTicket(member, runtime.staffSettings) ||
    canCloseTicket(member, runtime.staffSettings)
  );
}

async function ensureTicketAccess(interaction, mode) {
  const runtime = await ensureGuildRuntimeOrReply(interaction);
  if (!runtime) return null;

  const ticket = await loadTicketForInteraction(interaction);
  if (!ticket) return null;

  if (mode === "member") {
    if (ticket.user_id !== interaction.user.id && !canUseStaffPanel(interaction.member, runtime)) {
      await replyWithTicketMessage(interaction, {
        title: "Acesso negado",
        message: "Apenas o solicitante e a equipe podem usar este painel.",
        tone: "error",
      });
      return null;
    }
    return { runtime, ticket };
  }

  if (mode === "staff" && !canUseStaffPanel(interaction.member, runtime)) {
    await replyWithTicketMessage(interaction, {
      title: "Acesso negado",
      message: "Apenas a equipe configurada pode usar o painel staff deste ticket.",
      tone: "error",
    });
    return null;
  }

  if (mode === "admin" && !canCloseTicket(interaction.member, runtime.staffSettings)) {
    await replyWithTicketMessage(interaction, {
      title: "Acesso negado",
      message: "Apenas administradores e a equipe com permissao de fechamento podem usar o painel admin.",
      tone: "error",
    });
    return null;
  }

  return { runtime, ticket };
}

async function editTicketIntroMessage(channel, ticket, metadata = {}) {
  try {
    const existingMessage = await fetchExistingTicketIntroMessage(
      channel,
      ticket.intro_message_id || null,
    );
    if (!existingMessage) return null;
    const edited = await existingMessage.edit(buildTicketIntroPayload({ ticket }));
    if (ticket.intro_message_id !== edited.id) {
      await persistTicketIntroMessageId(ticket, edited.id, metadata);
    }
    return edited;
  } catch (error) {
    logTicketFlowFailure("edit-ticket-intro-message", error, metadata);
    return null;
  }
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
  const context = await ensureTicketAccess(interaction, "member");
  if (!context) return;
  await replyWithTicketPayload(
    interaction,
    buildMemberPanelPayload(context.ticket),
  );
}

async function showStaffTicketPanelFromInteraction(interaction) {
  const context = await ensureTicketAccess(interaction, "staff");
  if (!context) return;
  await replyWithTicketPayload(
    interaction,
    buildStaffPanelPayload(context.ticket),
  );
}

async function showAdminTicketPanelFromInteraction(interaction) {
  const context = await ensureTicketAccess(interaction, "admin");
  if (!context) return;
  await replyWithTicketPayload(
    interaction,
    buildAdminPanelPayload(context.ticket),
  );
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

function createMemberIdModal(customId, title) {
  const modal = new ModalBuilder()
    .setCustomId(customId)
    .setTitle(title);
  const input = new TextInputBuilder()
    .setCustomId(CUSTOM_IDS.ticketMemberIdInput)
    .setLabel("ID do membro")
    .setPlaceholder("Ex.: 123456789012345678")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(10)
    .setMaxLength(25);
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return modal;
}

function createTicketPaymentModal(ticket) {
  const modal = new ModalBuilder()
    .setCustomId(CUSTOM_IDS.ticketPaymentModal)
    .setTitle("Criar pagamento PIX");
  const amountInput = new TextInputBuilder()
    .setCustomId(CUSTOM_IDS.ticketPaymentAmountInput)
    .setLabel("Valor")
    .setPlaceholder("Ex.: 1,00")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(16);
  const noteInput = new TextInputBuilder()
    .setCustomId(CUSTOM_IDS.ticketPaymentNoteInput)
    .setLabel("Descricao curta")
    .setPlaceholder(`Pagamento do ticket ${ticket.protocol}`)
    .setStyle(TextInputStyle.Short)
    .setRequired(false)
    .setMaxLength(120);
  modal.addComponents(
    new ActionRowBuilder().addComponents(amountInput),
    new ActionRowBuilder().addComponents(noteInput),
  );
  return modal;
}

function createTextModal(customId, inputId, title, label, placeholder) {
  const modal = new ModalBuilder().setCustomId(customId).setTitle(title);
  const input = new TextInputBuilder()
    .setCustomId(inputId)
    .setLabel(label)
    .setPlaceholder(placeholder)
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMinLength(4)
    .setMaxLength(900);
  modal.addComponents(new ActionRowBuilder().addComponents(input));
  return modal;
}

async function addMemberToTicket(interaction, memberId) {
  const context = await ensureTicketAccess(interaction, "admin");
  if (!context) return;
  const member = await interaction.guild.members.fetch(memberId).catch(() => null);
  if (!member) {
    await replyWithTicketMessage(interaction, {
      title: "Membro nao encontrado",
      message: "Nao encontrei esse ID dentro do servidor.",
      tone: "error",
    });
    return;
  }

  await interaction.channel.permissionOverwrites.edit(member.id, {
    ViewChannel: true,
    SendMessages: true,
    ReadMessageHistory: true,
    AttachFiles: true,
    EmbedLinks: true,
  });

  await registerEvent({
    ticketId: context.ticket.id,
    protocol: context.ticket.protocol,
    guildId: interaction.guild.id,
    channelId: interaction.channel.id,
    actorId: interaction.user.id,
    eventType: "claimed",
    metadata: {
      action: "member_added",
      member_id: member.id,
    },
  }).catch((error) => logTicketFlowFailure("register-member-added", error));

  await interaction.channel.send(buildTicketSimpleMessagePayload({
    title: "Membro adicionado",
    message: `<@${member.id}> agora pode acompanhar este ticket.`,
    tone: "success",
  }));

  await replyWithTicketMessage(interaction, {
    title: "Permissao aplicada",
    message: `Adicionei <@${member.id}> ao ticket.`,
    tone: "success",
  });
}

async function removeMemberFromTicket(interaction, memberId) {
  const context = await ensureTicketAccess(interaction, "admin");
  if (!context) return;
  if (memberId === context.ticket.user_id) {
    await replyWithTicketMessage(interaction, {
      title: "Acao bloqueada",
      message: "O solicitante principal nao pode ser removido do proprio ticket.",
      tone: "warning",
    });
    return;
  }

  await interaction.channel.permissionOverwrites.delete(memberId).catch(async () => {
    await interaction.channel.permissionOverwrites.edit(memberId, {
      ViewChannel: false,
      SendMessages: false,
      ReadMessageHistory: false,
    });
  });

  await registerEvent({
    ticketId: context.ticket.id,
    protocol: context.ticket.protocol,
    guildId: interaction.guild.id,
    channelId: interaction.channel.id,
    actorId: interaction.user.id,
    eventType: "claimed",
    metadata: {
      action: "member_removed",
      member_id: memberId,
    },
  }).catch((error) => logTicketFlowFailure("register-member-removed", error));

  await interaction.channel.send(buildTicketSimpleMessagePayload({
    title: "Membro removido",
    message: `<@${memberId}> nao tem mais permissao direta neste ticket.`,
    tone: "warning",
  }));

  await replyWithTicketMessage(interaction, {
    title: "Permissao removida",
    message: `Removi <@${memberId}> do ticket.`,
    tone: "success",
  });
}

async function createPrivateTicketCall(interaction, mode = "staff") {
  const context = await ensureTicketAccess(interaction, mode === "admin" ? "admin" : mode === "member" ? "member" : "staff");
  if (!context) return;
  const guild = interaction.guild;
  const botMember = guild.members.me || (await guild.members.fetchMe());
  const userIds = new Set([
    context.ticket.user_id,
    context.ticket.claimed_by,
    interaction.user.id,
  ].filter(Boolean));

  for (const overwrite of interaction.channel.permissionOverwrites.cache.values()) {
    const id = overwrite.id;
    if (id === guild.roles.everyone.id || id === botMember.id) continue;
    if (guild.members.cache.has(id)) {
      userIds.add(id);
    }
  }

  const permissionOverwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect],
    },
    {
      id: botMember.id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.Speak,
        PermissionFlagsBits.ManageChannels,
      ],
    },
    ...[...userIds].map((id) => ({
      id,
      allow: [
        PermissionFlagsBits.ViewChannel,
        PermissionFlagsBits.Connect,
        PermissionFlagsBits.Speak,
        PermissionFlagsBits.Stream,
      ],
    })),
  ];

  const suffix = String(context.ticket.protocol || context.ticket.id)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .slice(-32);
  const call = await guild.channels.create({
    name: `call-${suffix}`,
    type: ChannelType.GuildVoice,
    parent: interaction.channel.parentId || undefined,
    permissionOverwrites,
    reason: `Call privada do ticket ${context.ticket.protocol}`,
  });

  await registerEvent({
    ticketId: context.ticket.id,
    protocol: context.ticket.protocol,
    guildId: guild.id,
    channelId: interaction.channel.id,
    actorId: interaction.user.id,
    eventType: "claimed",
    metadata: {
      action: "private_call_created",
      voice_channel_id: call.id,
    },
  }).catch((error) => logTicketFlowFailure("register-call-created", error));

  await interaction.channel.send(buildTicketSimpleMessagePayload({
    title: "Call criada",
    message: `Criei a call privada <#${call.id}> para os membros deste ticket.`,
    tone: "success",
  }));

  await replyWithTicketMessage(interaction, {
    title: "Call pronta",
    message: `Sala criada: <#${call.id}>.`,
    tone: "success",
  });
}

async function callTicketPaymentInternalApi(action, body) {
  if (!env.salesInternalApiToken) {
    throw new Error("SALES_INTERNAL_API_TOKEN/CRON_SECRET nao configurado para o bot.");
  }

  const response = await fetch(env.salesInternalApiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.salesInternalApiToken}`,
    },
    body: JSON.stringify({ action, ...body }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) {
    throw new Error(payload.message || "Falha ao comunicar com checkout interno.");
  }
  return payload;
}

function buildTicketPixPaymentPayload(ticket, payment, note) {
  const files = [];
  const body = [
    "## Pagamento PIX",
    note ? `**Descricao:** ${note}` : `**Ticket:** \`${ticket.protocol}\``,
    `**Valor:** ${formatMoney(payment.amount)}`,
    `**Status:** ${payment.status || "pending"}`,
    "",
    "Pague pelo QR Code ou copia e cola. Assim que o Mercado Pago aprovar, esta mensagem sera atualizada automaticamente.",
  ];
  if (payment.qrBase64) {
    const raw = String(payment.qrBase64).replace(/^data:image\/png;base64,/i, "");
    files.push(new AttachmentBuilder(Buffer.from(raw, "base64"), { name: "ticket-pix.png" }));
  }
  if (payment.qrCode) {
    body.push("", "**PIX copia e cola**", `\`\`\`${String(payment.qrCode).slice(0, 990)}\`\`\``);
  }

  const components = [
    {
      type: COMPONENT_TYPE.CONTAINER,
      accent_color: 0x8fdbff,
      components: [
        textDisplay(body.join("\n")),
        ...(payment.qrBase64
          ? [{
              type: COMPONENT_TYPE.MEDIA_GALLERY,
              items: [{ media: { url: "attachment://ticket-pix.png" } }],
            }]
          : []),
      ],
    },
  ];
  if (payment.ticketUrl) {
    components.push(actionRow([
      {
        type: COMPONENT_TYPE.BUTTON,
        style: BUTTON_STYLE.LINK,
        label: "Abrir Mercado Pago",
        url: payment.ticketUrl,
      },
    ]));
  }

  return {
    flags: MessageFlags.IsComponentsV2,
    components,
    files,
    allowedMentions: { users: [ticket.user_id] },
  };
}

function buildTicketPaymentFinalPayload(ticket, payment, status) {
  const approved = status === "approved";
  return {
    flags: MessageFlags.IsComponentsV2,
    components: [
      {
        type: COMPONENT_TYPE.CONTAINER,
        accent_color: approved ? 0x2ecc71 : 0xffb86b,
        components: [
          textDisplay([
            approved ? "## Pagamento aprovado" : "## Pagamento indisponivel",
            `**Ticket:** \`${ticket.protocol}\``,
            `**Valor:** ${formatMoney(payment.amount)}`,
            `**Status:** ${status}`,
            approved
              ? "O Mercado Pago confirmou o pagamento deste ticket."
              : "Esse PIX nao esta mais disponivel para pagamento.",
          ].join("\n")),
        ],
      },
    ],
    files: [],
    attachments: [],
    allowedMentions: { parse: [] },
  };
}

async function sendTicketPaymentLog(guild, channelId, payload) {
  if (!channelId) return;
  const channel =
    guild.channels.cache.get(channelId) ||
    (await guild.channels.fetch(channelId).catch(() => null));
  if (!channel?.isTextBased()) return;
  await channel.send(payload).catch(() => null);
}

async function sendTicketPaymentLogForStatus(interaction, ticket, payment, logs, status) {
  const isApproved = status === "approved";
  const isPending = status === "pending";
  const channelId = isApproved
    ? logs?.approvedLogChannelId
    : isPending
      ? logs?.pendingLogChannelId
      : logs?.rejectedLogChannelId;
  await sendTicketPaymentLog(
    interaction.guild,
    channelId,
    buildLogPayload({
      accentColor: isApproved ? 0x2ecc71 : isPending ? 0x8fdbff : 0xffb86b,
      title: isApproved
        ? "Pagamento de ticket aprovado"
        : isPending
          ? "Pagamento de ticket pendente"
          : "Pagamento de ticket recusado",
      lines: [
        `**Protocolo:** \`${ticket.protocol}\``,
        `**Canal:** <#${ticket.channel_id}>`,
        `**Cliente:** <@${ticket.user_id}>`,
        `**Valor:** ${formatMoney(payment.amount)}`,
        `**Status:** ${status}`,
        payment.providerPaymentId ? `**Mercado Pago:** \`${payment.providerPaymentId}\`` : "",
      ].filter(Boolean),
    }),
  );
}

function isFinalTicketPaymentStatus(status) {
  return ["approved", "rejected", "cancelled", "expired", "refunded", "charged_back"].includes(
    String(status || "").toLowerCase(),
  );
}

function startTicketPaymentAutoSync(interaction, ticket, paymentMessage, payment, logs) {
  const startedAt = Date.now();
  const tick = async () => {
    if (Date.now() - startedAt > TICKET_PAYMENT_SYNC_MAX_MS) return;
    let payload;
    try {
      payload = await callTicketPaymentInternalApi("sync_ticket_payment", {
        guildId: interaction.guild.id,
        paymentId: payment.providerPaymentId,
      });
    } catch (error) {
      logTicketFlowFailure("ticket-payment-sync", error, {
        guildId: interaction.guild.id,
        ticketId: ticket.id,
        protocol: ticket.protocol,
      });
      setTimeout(tick, TICKET_PAYMENT_SYNC_INTERVAL_MS);
      return;
    }

    const nextPayment = payload.payment || payment;
    const status = nextPayment.status || "pending";
    if (isFinalTicketPaymentStatus(status)) {
      await paymentMessage.edit(buildTicketPaymentFinalPayload(ticket, nextPayment, status)).catch(() => null);
      await sendTicketPaymentLogForStatus(interaction, ticket, nextPayment, payload.logs || logs, status);
      if (status === "approved") {
        await interaction.channel.send(buildTicketSimpleMessagePayload({
          title: "Pagamento aprovado",
          message: `Pagamento de ${formatMoney(nextPayment.amount)} confirmado para este ticket.`,
          tone: "success",
        })).catch(() => null);
      }
      return;
    }

    setTimeout(tick, TICKET_PAYMENT_SYNC_INTERVAL_MS);
  };

  setTimeout(tick, TICKET_PAYMENT_SYNC_INTERVAL_MS);
}

async function createTicketPaymentFromModal(interaction) {
  const context = await ensureTicketAccess(interaction, "admin");
  if (!context) return;
  const rawAmount = interaction.fields.getTextInputValue(CUSTOM_IDS.ticketPaymentAmountInput);
  const note = String(
    interaction.fields.getTextInputValue(CUSTOM_IDS.ticketPaymentNoteInput) || "",
  ).trim().slice(0, 120);
  const amount = parseMoneyInput(rawAmount);
  if (!amount) {
    await replyWithTicketMessage(interaction, {
      title: "Valor invalido",
      message: "Informe um valor de R$ 1,00 ou maior.",
      tone: "error",
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  let payload;
  try {
    payload = await callTicketPaymentInternalApi("create_ticket_pix_payment", {
      guildId: interaction.guild.id,
      ticketId: String(context.ticket.id),
      protocol: context.ticket.protocol,
      discordUserId: context.ticket.user_id,
      requestedBy: interaction.user.id,
      payerName: interaction.user.displayName || interaction.user.username,
      amount,
    });
  } catch (error) {
    await interaction.editReply(
      error instanceof Error ? error.message : "Nao foi possivel gerar o pagamento.",
    );
    return;
  }

  const payment = payload.payment;
  const paymentMessage = await interaction.channel.send(
    buildTicketPixPaymentPayload(context.ticket, payment, note),
  );
  await sendTicketPaymentLogForStatus(
    interaction,
    context.ticket,
    payment,
    payload.logs,
    "pending",
  );
  startTicketPaymentAutoSync(
    interaction,
    context.ticket,
    paymentMessage,
    payment,
    payload.logs,
  );
  await interaction.editReply(`Pagamento PIX criado: ${formatMoney(payment.amount)}.`);
}

async function handleStaffAction(interaction, action) {
  const context = await ensureTicketAccess(interaction, "staff");
  if (!context) return;
  const { ticket, runtime } = context;

  if (action === "claim") {
    await claimTicketFromInteraction(interaction);
    return;
  }

  if (action === "create_call") {
    await createPrivateTicketCall(interaction, "staff");
    return;
  }

  if (action === "internal_note") {
    await interaction.showModal(createTextModal(
      CUSTOM_IDS.ticketStaffNoteModal,
      CUSTOM_IDS.ticketStaffNoteInput,
      "Registrar nota interna",
      "Nota operacional",
      "Ex.: Cliente aguardando comprovante; retorno combinado para hoje.",
    ));
    return;
  }

  if (action === "request_details") {
    await interaction.channel.send(buildTicketSimpleMessagePayload({
      title: "Precisamos de alguns detalhes",
      message: [
        `<@${ticket.user_id}>, envie por favor:`,
        "1. O que aconteceu ou o que voce quer solicitar.",
        "2. Prints, comprovantes, IDs ou links relacionados.",
        "3. O resultado esperado para considerarmos o caso resolvido.",
      ].join("\n"),
      tone: "warning",
    }));
    await replyWithTicketMessage(interaction, {
      title: "Checklist enviado",
      message: "Solicitei os detalhes essenciais ao membro.",
      tone: "success",
    });
    return;
  }

  if (action === "escalate") {
    const roleIds = resolveStaffVisibilityRoleIds(runtime.staffSettings);
    const mentions = roleIds.map((roleId) => `<@&${roleId}>`).join(" ");
    await interaction.channel.send({
      ...buildTicketSimpleMessagePayload({
        title: "Ticket escalado",
        message: [
          mentions || "Equipe configurada",
          `O ticket \`${ticket.protocol}\` precisa de prioridade/revisao.`,
        ].join("\n"),
        tone: "warning",
      }),
      allowedMentions: { roles: roleIds },
    });
    await replyWithTicketMessage(interaction, {
      title: "Equipe notificada",
      message: "Enviei a escalacao no canal do ticket.",
      tone: "success",
    });
    return;
  }

  if (action === "prepare_close") {
    await interaction.channel.send(buildTicketSimpleMessagePayload({
      title: "Preparando encerramento",
      message: [
        `<@${ticket.user_id}>, a equipe marcou este atendimento como pronto para encerramento.`,
        "Se ainda houver pendencia, responda neste canal antes do fechamento.",
      ].join("\n"),
      tone: "warning",
    }));
    await replyWithTicketMessage(interaction, {
      title: "Aviso enviado",
      message: "O membro foi avisado antes do encerramento.",
      tone: "success",
    });
  }
}

async function handleMemberAction(interaction, action) {
  const context = await ensureTicketAccess(interaction, "member");
  if (!context) return;
  const { ticket, runtime } = context;

  if (action === "send_update") {
    await interaction.showModal(createTextModal(
      CUSTOM_IDS.ticketMemberUpdateModal,
      CUSTOM_IDS.ticketMemberUpdateInput,
      "Enviar atualizacao",
      "Resumo para a equipe",
      "Explique o que mudou, anexe IDs/links e diga o que ainda precisa.",
    ));
    return;
  }

  if (action === "request_staff") {
    const roleIds = resolveStaffVisibilityRoleIds(runtime.staffSettings);
    await interaction.channel.send({
      ...buildTicketSimpleMessagePayload({
        title: "Membro solicitou retorno",
        message: [
          roleIds.map((roleId) => `<@&${roleId}>`).join(" ") || "Equipe configurada",
          `<@${ticket.user_id}> pediu retorno da equipe neste ticket.`,
        ].join("\n"),
        tone: "warning",
      }),
      allowedMentions: { roles: roleIds, users: [ticket.user_id] },
    });
    await replyWithTicketMessage(interaction, {
      title: "Equipe chamada",
      message: "Avisei a equipe configurada neste canal.",
      tone: "success",
    });
    return;
  }

  if (action === "evidence_checklist") {
    await replyWithTicketMessage(interaction, {
      title: "Checklist de evidencias",
      message: [
        "Envie prints completos, comprovantes, IDs de pedido/transacao, horario aproximado e qualquer link relevante.",
        "Evite senhas, tokens, chaves privadas ou dados sensiveis desnecessarios.",
      ].join("\n"),
      tone: "neutral",
    });
    return;
  }

  if (action === "mark_ready") {
    await interaction.channel.send(buildTicketSimpleMessagePayload({
      title: "Membro marcou como resolvido",
      message: `<@${ticket.user_id}> informou que o atendimento pode ser encerrado.`,
      tone: "success",
    }));
    await replyWithTicketMessage(interaction, {
      title: "Aviso enviado",
      message: "A equipe foi avisada que o ticket pode ser encerrado.",
      tone: "success",
    });
  }
}

async function handleAdminAction(interaction, action) {
  const context = await ensureTicketAccess(interaction, "admin");
  if (!context) return;

  if (action === "claim") {
    await claimTicketFromInteraction(interaction);
    return;
  }
  if (action === "add_member") {
    await interaction.showModal(createMemberIdModal(CUSTOM_IDS.ticketAddMemberModal, "Adicionar membro"));
    return;
  }
  if (action === "remove_member") {
    await interaction.showModal(createMemberIdModal(CUSTOM_IDS.ticketRemoveMemberModal, "Remover membro"));
    return;
  }
  if (action === "create_call") {
    await createPrivateTicketCall(interaction, "admin");
    return;
  }
  if (action === "create_payment") {
    await interaction.showModal(createTicketPaymentModal(context.ticket));
    return;
  }
  if (action === "close") {
    await closeTicketFromInteraction(interaction);
  }
}

async function handleTicketSelectInteraction(interaction) {
  const action = interaction.values?.[0];
  if (!action) return;

  if (interaction.customId === CUSTOM_IDS.ticketAdminSelect) {
    await handleAdminAction(interaction, action);
    return;
  }
  if (interaction.customId === CUSTOM_IDS.ticketStaffSelect) {
    await handleStaffAction(interaction, action);
    return;
  }
  if (interaction.customId === CUSTOM_IDS.ticketMemberSelect) {
    await handleMemberAction(interaction, action);
  }
}

async function handleTicketModalSubmit(interaction) {
  if (interaction.customId === CUSTOM_IDS.ticketAddMemberModal) {
    const memberId = normalizeSnowflake(
      interaction.fields.getTextInputValue(CUSTOM_IDS.ticketMemberIdInput),
    );
    if (!memberId) {
      await replyWithTicketMessage(interaction, {
        title: "ID invalido",
        message: "Informe um ID Discord valido.",
        tone: "error",
      });
      return;
    }
    await addMemberToTicket(interaction, memberId);
    return;
  }

  if (interaction.customId === CUSTOM_IDS.ticketRemoveMemberModal) {
    const memberId = normalizeSnowflake(
      interaction.fields.getTextInputValue(CUSTOM_IDS.ticketMemberIdInput),
    );
    if (!memberId) {
      await replyWithTicketMessage(interaction, {
        title: "ID invalido",
        message: "Informe um ID Discord valido.",
        tone: "error",
      });
      return;
    }
    await removeMemberFromTicket(interaction, memberId);
    return;
  }

  if (interaction.customId === CUSTOM_IDS.ticketPaymentModal) {
    await createTicketPaymentFromModal(interaction);
    return;
  }

  if (interaction.customId === CUSTOM_IDS.ticketMemberUpdateModal) {
    const context = await ensureTicketAccess(interaction, "member");
    if (!context) return;
    const update = String(
      interaction.fields.getTextInputValue(CUSTOM_IDS.ticketMemberUpdateInput) || "",
    ).trim().replace(/```/g, "'''").slice(0, 900);
    await interaction.channel.send(buildTicketSimpleMessagePayload({
      title: "Atualizacao do membro",
      message: [`<@${interaction.user.id}> enviou uma atualizacao:`, `> \`\`\`${update}\`\`\``].join("\n"),
      tone: "neutral",
    }));
    await replyWithTicketMessage(interaction, {
      title: "Atualizacao enviada",
      message: "Sua atualizacao foi publicada para a equipe.",
      tone: "success",
    });
    return;
  }

  if (interaction.customId === CUSTOM_IDS.ticketStaffNoteModal) {
    const context = await ensureTicketAccess(interaction, "staff");
    if (!context) return;
    const note = String(
      interaction.fields.getTextInputValue(CUSTOM_IDS.ticketStaffNoteInput) || "",
    ).trim().replace(/```/g, "'''").slice(0, 900);
    await registerEvent({
      ticketId: context.ticket.id,
      protocol: context.ticket.protocol,
      guildId: interaction.guild.id,
      channelId: interaction.channel.id,
      actorId: interaction.user.id,
      eventType: "claimed",
      metadata: {
        action: "staff_note",
        note,
      },
    }).catch((error) => logTicketFlowFailure("register-staff-note", error));
    await replyWithTicketMessage(interaction, {
      title: "Nota registrada",
      message: "A observacao foi registrada no historico operacional do ticket.",
      tone: "success",
    });
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
  await editTicketIntroMessage(channel, updated, {
    guildId: guild.id,
    channelId: channel.id,
    protocol: updated.protocol,
    actorId: interaction.user.id,
  });

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
  handleTicketSelectInteraction,
  handleTicketModalSubmit,
  syncOpenTicketControlMessages,
  syncAllTicketPanels,
  closeOpenTicketChannel,
};
