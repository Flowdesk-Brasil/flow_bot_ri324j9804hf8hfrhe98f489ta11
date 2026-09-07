const {
  ActionRowBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");
const { randomUUID } = require("crypto");
const { CUSTOM_IDS } = require("../constants/customIds");
const {
  buildLogPayload,
  withEphemeralComponentsV2,
} = require("../utils/componentFactory");
const { getGuildWhitelistRuntime } = require("./supabaseService");
const whitelistDb = require("./whitelistDbService");
const {
  executeWhitelistOperation,
  sanitizeCityDbError,
  mappingFingerprint,
} = require("./whitelistCityDb");

const WHITELIST_REVIEW_PREFIX = "whitelist:";
const COMPONENT_TYPE = { ACTION_ROW: 1, BUTTON: 2, TEXT_DISPLAY: 10, CONTAINER: 17 };
const applyingLocks = new Set();

function clampText(value, maxLength) {
  return String(value || "").slice(0, maxLength);
}

function sanitizeIdentifier(value) {
  return String(value || "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim()
    .slice(0, 128);
}

function isSnowflake(value) {
  return /^\d{15,25}$/.test(String(value || ""));
}

function buildNoticePayload(title, message, tone = "error") {
  const color = tone === "ok" ? 0x2ecc71 : tone === "warning" ? 0xf1c40f : 0xe74c3c;
  return withEphemeralComponentsV2({
    components: [
      {
        type: COMPONENT_TYPE.CONTAINER,
        accent_color: color,
        components: [
          {
            type: COMPONENT_TYPE.TEXT_DISPLAY,
            content: [`### ${title}`, message].join("\n\n"),
          },
        ],
      },
    ],
  });
}

async function replyEphemeral(interaction, payload) {
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp(payload).catch(() => null);
    return;
  }
  await interaction.reply(payload);
}

function isWhitelistButtonInteraction(interaction) {
  if (!interaction.isButton()) return false;
  if (interaction.customId === CUSTOM_IDS.startWhitelist) return true;
  return /^(whitelist:(approve|deny|retry):\d+)$/.test(interaction.customId);
}

function isWhitelistModalSubmit(interaction) {
  return interaction.isModalSubmit?.() && interaction.customId === CUSTOM_IDS.submitWhitelistModal;
}

function parseReviewCustomId(customId) {
  const match = String(customId || "").match(/^whitelist:(approve|deny|retry):(\d+)$/);
  if (!match) return null;
  return { action: match[1], requestId: Number(match[2]) };
}

function memberCanReview(member, settings) {
  if (!member) return false;
  if (member.permissions?.has(PermissionFlagsBits.ManageGuild)) return true;
  const reviewRoleIds = Array.isArray(settings?.review_role_ids) ? settings.review_role_ids : [];
  return reviewRoleIds.some((roleId) => member.roles?.cache?.has(roleId));
}

async function resolveTextChannel(guild, channelId) {
  if (!guild || !channelId) return null;
  const channel =
    guild.channels.cache.get(channelId) ||
    (await guild.channels.fetch(channelId).catch(() => null));
  if (!channel || !channel.isTextBased()) return null;
  return channel;
}

async function assignRoles(guild, userId, addIds, removeIds) {
  const member =
    guild.members.cache.get(userId) || (await guild.members.fetch(userId).catch(() => null));
  if (!member) return;
  const toAdd = (Array.isArray(addIds) ? addIds : []).filter(Boolean);
  const toRemove = (Array.isArray(removeIds) ? removeIds : []).filter(Boolean);
  for (const roleId of toAdd) {
    await member.roles.add(roleId).catch(() => null);
  }
  for (const roleId of toRemove) {
    await member.roles.remove(roleId).catch(() => null);
  }
}

function buildReviewPayload({ request, member, identifierKind, identifierValue, status }) {
  const statusLabel =
    status === "approved"
      ? "Aprovado e sincronizado"
      : status === "denied"
        ? "Reprovado"
          : status === "apply_failed"
          ? String(request.apply_error || "").toLowerCase().includes("agent")
            ? "Aguardando Agent da cidade"
            : "Aprovado no Discord, falha no banco"
          : "Pendente";
  const mention = member ? `${member} (\`${request.user_id}\`)` : `\`${request.user_id}\``;
  const components = [
    {
      type: COMPONENT_TYPE.CONTAINER,
      accent_color:
        status === "approved" ? 0x2ecc71 : status === "denied" ? 0xe74c3c : 0xf1c40f,
      components: [
        {
          type: COMPONENT_TYPE.TEXT_DISPLAY,
          content: [
            "### Solicitacao de whitelist",
            `**Membro:** ${mention}`,
            `**Identificador (${identifierKind}):** \`${clampText(identifierValue, 80)}\``,
            `**Status:** ${statusLabel}`,
            `**Pedido:** \`${request.id}\``,
            request.apply_error ? `**Detalhe:** ${clampText(request.apply_error, 180)}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        },
      ],
    },
  ];

  if (status === "pending") {
    components.push({
      type: COMPONENT_TYPE.ACTION_ROW,
      components: [
        {
          type: COMPONENT_TYPE.BUTTON,
          custom_id: `${WHITELIST_REVIEW_PREFIX}approve:${request.id}`,
          style: 3,
          label: "Aprovar",
        },
        {
          type: COMPONENT_TYPE.BUTTON,
          custom_id: `${WHITELIST_REVIEW_PREFIX}deny:${request.id}`,
          style: 4,
          label: "Reprovar",
        },
      ],
    });
  } else if (status === "apply_failed") {
    components.push({
      type: COMPONENT_TYPE.ACTION_ROW,
      components: [
        {
          type: COMPONENT_TYPE.BUTTON,
          custom_id: `${WHITELIST_REVIEW_PREFIX}retry:${request.id}`,
          style: 1,
          label: "Tentar sincronizar novamente",
        },
        {
          type: COMPONENT_TYPE.BUTTON,
          custom_id: `${WHITELIST_REVIEW_PREFIX}deny:${request.id}`,
          style: 2,
          label: "Cancelar pedido",
        },
      ],
    });
  }

  return {
    flags: MessageFlags.IsComponentsV2,
    components,
    allowedMentions: { parse: [] },
  };
}

async function sendWhitelistLog({ guild, settings, title, lines, color }) {
  const channel = await resolveTextChannel(guild, settings?.logs_channel_id);
  if (!channel) return;
  const payload = buildLogPayload({
    accentColor: color || 0x3d8bff,
    title,
    lines,
  });
  await channel.send(payload).catch(() => null);
}

async function showWhitelistModal(interaction) {
  const guildId = interaction.guildId;
  if (!guildId) return;

  const runtime = await getGuildWhitelistRuntime(guildId);
  const settings = runtime?.settings;

  if (!runtime?.licenseUsable) {
    await replyEphemeral(
      interaction,
      buildNoticePayload(
        "Assinatura indisponivel",
        "A whitelist deste servidor esta pausada porque a assinatura nao esta ativa.",
      ),
    );
    return;
  }

  if (!settings?.enabled) {
    await replyEphemeral(
      interaction,
      buildNoticePayload(
        "Modulo desativado",
        "O sistema de whitelist nao esta ativo neste servidor.",
      ),
    );
    return;
  }

  const identifierKind = String(settings.identifier_kind || "discord_id");
  const label = clampText(settings.identifier_label || "ID / License", 45);
  const placeholder = clampText(
    settings.identifier_placeholder || "Informe seu ID, license ou token",
    100,
  );

  const modal = new ModalBuilder()
    .setCustomId(CUSTOM_IDS.submitWhitelistModal)
    .setTitle("Solicitar whitelist");

  const identifierInput = new TextInputBuilder()
    .setCustomId(CUSTOM_IDS.whitelistIdentifierInput)
    .setLabel(label)
    .setPlaceholder(placeholder)
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(128);

  if (identifierKind === "discord_id") {
    identifierInput.setValue(interaction.user.id);
  }

  modal.addComponents(new ActionRowBuilder().addComponents(identifierInput));
  await interaction.showModal(modal);
}

async function handleWhitelistModalSubmit(interaction) {
  const guildId = interaction.guildId;
  if (!guildId || !interaction.guild) return;

  const runtime = await getGuildWhitelistRuntime(guildId);
  const settings = runtime?.settings;

  if (!runtime?.licenseUsable || !settings?.enabled) {
    await replyEphemeral(
      interaction,
      buildNoticePayload(
        "Modulo indisponivel",
        "Nao foi possivel registrar sua solicitacao agora.",
      ),
    );
    return;
  }

  const identifierValue = sanitizeIdentifier(
    interaction.fields.getTextInputValue(CUSTOM_IDS.whitelistIdentifierInput),
  );
  const identifierKind = String(settings.identifier_kind || "discord_id");

  if (!identifierValue) {
    await replyEphemeral(
      interaction,
      buildNoticePayload("Identificador invalido", "Informe um identificador valido."),
    );
    return;
  }

  if (identifierKind === "discord_id" && !isSnowflake(identifierValue)) {
    await replyEphemeral(
      interaction,
      buildNoticePayload("Discord ID invalido", "O Discord ID informado nao e valido."),
    );
    return;
  }

  const openRequest = await whitelistDb.findOpenRequest(guildId, interaction.user.id);
  const isAutomatic = String(settings.approval_mode || "manual") === "automatic";

  if (openRequest && !isAutomatic) {
    await replyEphemeral(
      interaction,
      buildNoticePayload(
        "Pedido ja em analise",
        "Voce ja possui uma solicitacao pendente. Aguarde a equipe analisar.",
        "warning",
      ),
    );
    return;
  }

  if (isAutomatic) {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => null);
    }

    if (settings.mapping_status !== "validated") {
      await replyEphemeral(
        interaction,
        buildNoticePayload(
          "Integracao nao validada",
          "A whitelist automatica so libera depois que o mapping do banco for validado no dashboard.",
        ),
      );
      return;
    }

    const correlationId = openRequest?.correlation_id || randomUUID();
    let request = openRequest;
    if (request) {
      request = await whitelistDb.updateWhitelistRequest(request.id, {
        identifier_kind: identifierKind,
        identifier_value: identifierValue,
        correlation_id: correlationId,
      });
    } else {
      try {
        request = await whitelistDb.createWhitelistRequest({
          guild_id: guildId,
          user_id: interaction.user.id,
          identifier_kind: identifierKind,
          identifier_value: identifierValue,
          status: "pending",
          correlation_id: correlationId,
        });
      } catch {
        await replyEphemeral(
          interaction,
          buildNoticePayload(
            "Aguarde",
            "Sua solicitacao automatica ja esta sendo processada. Tente novamente em instantes.",
            "warning",
          ),
        );
        return;
      }
    }

    const reviewChannel = await resolveTextChannel(interaction.guild, settings.review_channel_id);
    if (reviewChannel && !request.review_message_id) {
      const reviewMessage = await reviewChannel.send(
        buildReviewPayload({
          request,
          member: interaction.member || interaction.user,
          identifierKind,
          identifierValue,
          status: "pending",
        }),
      ).catch(() => null);
      if (reviewMessage) {
        request = await whitelistDb.updateWhitelistRequest(request.id, {
          review_message_id: reviewMessage.id,
          review_channel_id: reviewChannel.id,
        });
      }
    }

    await applyWhitelistChange({
      interaction,
      settings,
      request,
      approve: true,
      operation: "APPROVE_WHITELIST",
      autoApproved: true,
    });
    return;
  }

  const correlationId = randomUUID();
  let request;
  try {
    request = await whitelistDb.createWhitelistRequest({
      guild_id: guildId,
      user_id: interaction.user.id,
      identifier_kind: identifierKind,
      identifier_value: identifierValue,
      status: "pending",
      correlation_id: correlationId,
    });
  } catch {
    await replyEphemeral(
      interaction,
      buildNoticePayload(
        "Pedido ja em analise",
        "Voce ja possui uma solicitacao pendente. Aguarde a equipe analisar.",
        "warning",
      ),
    );
    return;
  }

  const reviewChannel = await resolveTextChannel(interaction.guild, settings.review_channel_id);
  if (!reviewChannel) {
    await whitelistDb.updateWhitelistRequest(request.id, {
      status: "cancelled",
      apply_error: "Canal de analise indisponivel.",
    });
    await replyEphemeral(
      interaction,
      buildNoticePayload(
        "Configuracao incompleta",
        "O canal de analise da whitelist nao esta disponivel. Avise a equipe do servidor.",
      ),
    );
    return;
  }

  const reviewMessage = await reviewChannel.send(
    buildReviewPayload({
      request,
      member: interaction.member || interaction.user,
      identifierKind,
      identifierValue,
      status: "pending",
    }),
  );

  await whitelistDb.updateWhitelistRequest(request.id, {
    review_message_id: reviewMessage.id,
    review_channel_id: reviewChannel.id,
  });

  await whitelistDb.insertWhitelistAudit({
    guild_id: guildId,
    request_id: request.id,
    user_id: interaction.user.id,
    actor_user_id: interaction.user.id,
    operation: "GET_PLAYER",
    identifier_kind: identifierKind,
    identifier_value: identifierValue,
    success: true,
    correlation_id: correlationId,
    mapping_fingerprint: mappingFingerprint(settings.mapping),
  });

  await sendWhitelistLog({
    guild: interaction.guild,
    settings,
    title: "Nova solicitacao de whitelist",
    color: 0x3d8bff,
    lines: [
      `**Membro:** ${interaction.user} (\`${interaction.user.id}\`)`,
      `**Identificador:** \`${identifierKind}\` \`${identifierValue}\``,
      `**Pedido:** \`${request.id}\``,
    ],
  });

  await replyEphemeral(
    interaction,
    buildNoticePayload(
      "Solicitacao enviada",
      "Sua whitelist entrou na analise da equipe. Voce sera atualizado quando houver um resultado.",
      "ok",
    ),
  );
}

async function refreshReviewMessage(guild, request, settings) {
  if (!request?.review_channel_id || !request?.review_message_id) return;
  const channel = await resolveTextChannel(guild, request.review_channel_id);
  if (!channel) return;
  const message = await channel.messages.fetch(request.review_message_id).catch(() => null);
  if (!message) return;
  const member =
    guild.members.cache.get(request.user_id) ||
    (await guild.members.fetch(request.user_id).catch(() => null));
  await message
    .edit(
      buildReviewPayload({
        request,
        member,
        identifierKind: request.identifier_kind,
        identifierValue: request.identifier_value,
        status: request.status,
      }),
    )
    .catch(() => null);
}

async function applyWhitelistChange({
  interaction,
  settings,
  request,
  approve,
  operation,
  autoApproved = false,
}) {
  const lockKey = `${request.guild_id}:${request.id}`;
  if (applyingLocks.has(lockKey)) {
    await replyEphemeral(
      interaction,
      buildNoticePayload("Aguarde", "Esta solicitacao ja esta sendo processada.", "warning"),
    );
    return;
  }
  applyingLocks.add(lockKey);

  const correlationId = request.correlation_id || randomUUID();
  const cityOperation = cityOperationFor(operation);

  try {
    let result;
    try {
      result = await executeWhitelistOperation(
        settings,
        cityOperation,
        request.identifier_value,
      );
    } catch (error) {
      result = { ok: false, ...sanitizeCityDbError(error) };
    }

    if (!result.ok) {
      const nextRequest = await whitelistDb.updateWhitelistRequest(request.id, {
        status: "apply_failed",
        reviewed_by_user_id: interaction.user.id,
        reviewed_at: new Date().toISOString(),
        apply_error: result.message || "Falha ao sincronizar com o banco da cidade.",
        player_key: result.playerKey || request.player_key || null,
        previous_whitelist_value:
          result.previousValue ?? request.previous_whitelist_value ?? null,
      });

      await whitelistDb.insertWhitelistAudit({
        guild_id: request.guild_id,
        request_id: request.id,
        user_id: request.user_id,
        actor_user_id: interaction.user.id,
        operation,
        identifier_kind: request.identifier_kind,
        identifier_value: request.identifier_value,
        player_key: result.playerKey || null,
        previous_value: result.previousValue || null,
        next_value: result.nextValue || null,
        success: false,
        error_code: result.code || "db_error",
        error_message: result.message || "Falha ao sincronizar.",
        correlation_id: correlationId,
        mapping_fingerprint: mappingFingerprint(settings.mapping),
      });

      await refreshReviewMessage(interaction.guild, nextRequest, settings);
      await sendWhitelistLog({
        guild: interaction.guild,
        settings,
        title: "Falha ao sincronizar whitelist",
        color: 0xe74c3c,
        lines: [
          `**Pedido:** \`${request.id}\``,
          `**Membro:** <@${request.user_id}>`,
          `**Erro:** ${clampText(result.message || "Falha no banco da cidade.", 180)}`,
          `**Correlation:** \`${correlationId}\``,
        ],
      });
      await replyEphemeral(
        interaction,
        buildNoticePayload(
          "Banco nao sincronizado",
          autoApproved
            ? `${result.message || "Nao foi possivel liberar no banco da cidade."} Clique novamente no painel para tentar de novo.`
            : `${result.message || "Nao foi possivel aplicar a whitelist no banco da cidade."} O pedido permanece aberto para retry.`,
        ),
      );
      return;
    }

    const nextRequest = await whitelistDb.updateWhitelistRequest(request.id, {
      status: approve ? "approved" : "denied",
      reviewed_by_user_id: interaction.user.id,
      reviewed_at: new Date().toISOString(),
      applied_at: new Date().toISOString(),
      apply_error: null,
      player_key: result.playerKey || null,
      previous_whitelist_value: result.previousValue ?? null,
      next_whitelist_value: result.nextValue ?? null,
    });

    await whitelistDb.insertWhitelistAudit({
      guild_id: request.guild_id,
      request_id: request.id,
      user_id: request.user_id,
      actor_user_id: interaction.user.id,
      operation,
      identifier_kind: request.identifier_kind,
      identifier_value: request.identifier_value,
      player_key: result.playerKey || null,
      previous_value: result.previousValue || null,
      next_value: result.nextValue || null,
      success: true,
      correlation_id: correlationId,
      mapping_fingerprint: mappingFingerprint(settings.mapping),
    });

    if (approve) {
      await assignRoles(
        interaction.guild,
        request.user_id,
        settings.approved_role_ids,
        settings.denied_role_ids,
      );
    } else {
      await assignRoles(
        interaction.guild,
        request.user_id,
        settings.denied_role_ids,
        settings.approved_role_ids,
      );
    }

    await refreshReviewMessage(interaction.guild, nextRequest, settings);
    await sendWhitelistLog({
      guild: interaction.guild,
      settings,
      title: autoApproved
        ? "Whitelist automatica sincronizada"
        : approve
          ? "Whitelist aprovada"
          : "Whitelist removida",
      color: approve ? 0x2ecc71 : 0xe74c3c,
      lines: [
        `**Pedido:** \`${request.id}\``,
        `**Membro:** <@${request.user_id}>`,
        `**Identificador:** \`${request.identifier_value}\``,
        `**Jogador:** \`${result.playerKey || "-"}\``,
        `**Antes:** \`${result.previousValue ?? "null"}\``,
        `**Depois:** \`${result.nextValue ?? "null"}\``,
        `**Staff:** ${autoApproved ? "Automatico" : `${interaction.user} (\`${interaction.user.id}\`)`}`,
        `**Correlation:** \`${correlationId}\``,
      ],
    });

    await replyEphemeral(
      interaction,
      buildNoticePayload(
        autoApproved
          ? "Whitelist liberada"
          : approve
            ? "Whitelist sincronizada"
            : "Whitelist removida",
        autoApproved
          ? result.skipped
            ? "Seu ID ja estava liberado no banco da cidade. O Discord foi sincronizado."
            : "Seu ID foi localizado e a whitelist foi liberada automaticamente."
          : result.skipped
            ? "O registro da cidade ja estava no estado desejado. O pedido foi concluido."
            : "O banco da cidade foi atualizado e o Discord foi sincronizado.",
        "ok",
      ),
    );
  } finally {
    applyingLocks.delete(lockKey);
  }
}

async function handleWhitelistReviewInteraction(interaction) {
  const parsed = parseReviewCustomId(interaction.customId);
  if (!parsed || !interaction.guildId || !interaction.guild) return;

  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral }).catch(() => null);
  }

  const runtime = await getGuildWhitelistRuntime(interaction.guildId);
  const settings = runtime?.settings;

  if (!runtime?.licenseUsable || !settings?.enabled) {
    await replyEphemeral(
      interaction,
      buildNoticePayload(
        "Modulo indisponivel",
        runtime?.licenseUsable
          ? "A whitelist esta desativada neste servidor."
          : "A assinatura deste servidor expirou. A sincronizacao ficou pausada.",
      ),
    );
    return;
  }

  if (!memberCanReview(interaction.member, settings)) {
    await replyEphemeral(
      interaction,
      buildNoticePayload("Sem permissao", "Voce nao pode analisar pedidos de whitelist."),
    );
    return;
  }

  const request = await whitelistDb.getWhitelistRequestById(parsed.requestId);
  if (!request || request.guild_id !== interaction.guildId) {
    await replyEphemeral(
      interaction,
      buildNoticePayload("Pedido invalido", "Esta solicitacao nao pertence a este servidor."),
    );
    return;
  }

  if (parsed.action === "deny") {
    if (request.status === "approved") {
      await replyEphemeral(
        interaction,
        buildNoticePayload(
          "Pedido ja aprovado",
          "Use o fluxo de remocao no banco apenas com uma operacao controlada. Este pedido ja foi concluido.",
          "warning",
        ),
      );
      return;
    }

    const nextRequest = await whitelistDb.updateWhitelistRequest(request.id, {
      status: "denied",
      reviewed_by_user_id: interaction.user.id,
      reviewed_at: new Date().toISOString(),
      apply_error: null,
    });
    await assignRoles(
      interaction.guild,
      request.user_id,
      settings.denied_role_ids,
      settings.approved_role_ids,
    );
    await whitelistDb.insertWhitelistAudit({
      guild_id: request.guild_id,
      request_id: request.id,
      user_id: request.user_id,
      actor_user_id: interaction.user.id,
      operation: "CHECK_WHITELIST",
      identifier_kind: request.identifier_kind,
      identifier_value: request.identifier_value,
      success: true,
      correlation_id: request.correlation_id || randomUUID(),
      mapping_fingerprint: mappingFingerprint(settings.mapping),
    });
    await refreshReviewMessage(interaction.guild, nextRequest, settings);
    await sendWhitelistLog({
      guild: interaction.guild,
      settings,
      title: "Whitelist reprovada",
      color: 0xe74c3c,
      lines: [
        `**Pedido:** \`${request.id}\``,
        `**Membro:** <@${request.user_id}>`,
        `**Staff:** ${interaction.user} (\`${interaction.user.id}\`)`,
      ],
    });
    await replyEphemeral(
      interaction,
      buildNoticePayload("Pedido reprovado", "A solicitacao foi recusada no Discord.", "ok"),
    );
    return;
  }

  if (!["pending", "apply_failed"].includes(request.status)) {
    await replyEphemeral(
      interaction,
      buildNoticePayload("Pedido encerrado", "Esta solicitacao ja foi concluida.", "warning"),
    );
    return;
  }

  if (settings.mapping_status !== "validated") {
    await replyEphemeral(
      interaction,
      buildNoticePayload(
        "Mapping nao validado",
        "Valide a integracao no dashboard antes de sincronizar o banco da cidade.",
      ),
    );
    return;
  }

  await applyWhitelistChange({
    interaction,
    settings,
    request,
    approve: true,
    operation: parsed.action === "retry" ? "RETRY_APPLY" : "APPROVE_WHITELIST",
  });
}

function cityOperationFor(operation) {
  if (operation === "RETRY_APPLY" || operation === "APPROVE_WHITELIST") {
    return "APPROVE_WHITELIST";
  }
  return operation;
}

async function handleWhitelistButtonInteraction(interaction) {
  if (interaction.customId === CUSTOM_IDS.startWhitelist) {
    await showWhitelistModal(interaction);
    return;
  }
  await handleWhitelistReviewInteraction(interaction);
}

module.exports = {
  isWhitelistButtonInteraction,
  isWhitelistModalSubmit,
  handleWhitelistButtonInteraction,
  handleWhitelistModalSubmit,
  reconcileCompletedAgentJobs,
};

async function reconcileCompletedAgentJobs(client) {
  const jobs = await whitelistDb.listDoneJobsForDiscordSync(25);
  for (const job of jobs) {
    try {
      const request = await whitelistDb.getWhitelistRequestById(job.request_id);
      if (!request) {
        await whitelistDb.markJobDiscordSynced(job.id);
        continue;
      }
      const settings = await whitelistDb.getGuildWhitelistSettings(request.guild_id);
      const guild = await client.guilds.fetch(request.guild_id).catch(() => null);
      if (!guild || !settings) continue;
      const approve = String(job.operation) !== "REMOVE_WHITELIST";
      const result = job.result && typeof job.result === "object" ? job.result : {};
      if (request.status === "approved" || request.status === "denied") {
        if (approve) {
          await assignRoles(guild, request.user_id, settings.approved_role_ids, settings.denied_role_ids);
        } else {
          await assignRoles(guild, request.user_id, settings.denied_role_ids, settings.approved_role_ids);
        }
        await refreshReviewMessage(guild, request, settings);
        await sendWhitelistLog({
          guild,
          settings,
          title: approve ? "Whitelist aplicada pelo Agent" : "Whitelist removida pelo Agent",
          color: approve ? 0x2ecc71 : 0xe74c3c,
          lines: [
            `**Pedido:** \`${request.id}\``,
            `**Membro:** <@${request.user_id}>`,
            `**Jogador:** \`${result.playerKey || request.player_key || "-"}\``,
            `**Correlation:** \`${request.correlation_id || "-"}\``,
          ],
        });
      }
      await whitelistDb.markJobDiscordSynced(job.id);
    } catch (error) {
      console.error("[whitelist-agent-reconcile]", error);
    }
  }
}
