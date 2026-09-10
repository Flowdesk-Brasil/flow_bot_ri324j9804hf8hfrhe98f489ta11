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
  inferWhitelistChanged,
  normalizeWhitelistResult,
  healthCheckActivePools,
} = require("./whitelistCityDb");
const {
  applyNicknameFormat,
  resolveNicknameFormat,
  sanitizePlayerName,
} = require("../utils/whitelistNickname");
const { settleMaybePromise } = require("../utils/settleMaybePromise");
const { uniqueNotice } = require("./cityDbErrors");

const WHITELIST_REVIEW_PREFIX = "whitelist:";
const COMPONENT_TYPE = { ACTION_ROW: 1, BUTTON: 2, TEXT_DISPLAY: 10, CONTAINER: 17 };
const applyingLocks = new Set();
const retryingFailedApplies = new Set();
const attemptWindow = new Map();
const ATTEMPT_WINDOW_MS = 120_000;
const ATTEMPT_LIMIT = 5;
let lastPoolHealthAt = 0;
const POOL_HEALTH_INTERVAL_MS = 45_000;

function clampText(value, maxLength) {
  return String(value || "").slice(0, maxLength);
}

function isOptionalCityFailure(result) {
  return [
    "offline",
    "timeout",
    "vps_timeout",
    "circuit_open",
    "pool_exhausted",
    "city_deferred",
    "ip_not_allowed",
  ].includes(String(result?.code || ""));
}

function deferredCityResult(identifierValue) {
  return {
    ok: true,
    deferred: true,
    skipped: true,
    code: "city_deferred",
    playerKey: identifierValue || "",
    message: "Whitelist liberada no Discord. A sync do jogo acontece pelo launcher na VPS, sem abrir o MySQL na internet.",
  };
}

function cityDbNoticeText(result, extra = "") {
  const message = String(result?.message || "O MySQL da sua VPS nao esta acessivel agora.").trim();
  const hint = String(result?.hint || "").trim();
  return `${uniqueNotice(message, hint)}${extra}`.trim();
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

function isWhitelistModuleActive(settings) {
  if (!settings || typeof settings !== "object") return false;
  if (settings.enabled === true) return true;
  if (settings.panel_message_id || settings.panel_channel_id) return true;
  const mapping = settings.mapping && typeof settings.mapping === "object" ? settings.mapping : {};
  return Boolean(mapping.playerTable && mapping.whitelistColumn);
}

function consumeAttempt(guildId, userId) {
  const key = `${guildId}:${userId}`;
  const now = Date.now();
  const current = attemptWindow.get(key);
  if (!current || now > current.resetAt) {
    attemptWindow.set(key, { count: 1, resetAt: now + ATTEMPT_WINDOW_MS });
    return { ok: true };
  }
  if (current.count >= ATTEMPT_LIMIT) {
    return { ok: false };
  }
  current.count += 1;
  return { ok: true };
}

function validateIdentifier(kind, raw) {
  const value = sanitizeIdentifier(raw);
  if (!value) {
    return { ok: false, message: "Informe um identificador valido." };
  }
  if (/<@!?\d+>/.test(value) || /https?:\/\//i.test(value) || /[\s;'"\\]/.test(value)) {
    return { ok: false, message: "Identificador invalido." };
  }
  if (kind === "discord_id" && !isSnowflake(value)) {
    return { ok: false, message: "O Discord ID informado nao e valido." };
  }
  if ((kind === "character_id" || kind === "internal_id") && !/^\d{1,18}$/.test(value)) {
    return { ok: false, message: "Informe apenas o numero do ID. Esse formato nao existe." };
  }
  if ((kind === "character_id" || kind === "internal_id") && Number(value) <= 0) {
    return { ok: false, message: "Esse ID nao existe." };
  }
  if ((kind === "license" || kind === "license2") && !/^(license2?:)?[a-f0-9]{32,80}$/i.test(value)) {
    return { ok: false, message: "A license informada nao e valida." };
  }
  if (kind === "steam" && !/^(steam:)?[a-z0-9]{10,40}$/i.test(value)) {
    return { ok: false, message: "O Steam ID informado nao e valido." };
  }
  return { ok: true, value };
}

function wasWhitelistAlreadyApplied(result) {
  if (!result?.ok) return false;
  return !inferWhitelistChanged(result);
}

function buildWhitelistApplyNotice({ result, approve, autoApproved }) {
  const normalized = normalizeWhitelistResult(result);
  const freshlyApplied = inferWhitelistChanged(normalized);
  const alreadyApplied = wasWhitelistAlreadyApplied(normalized);
  const before = normalized.previousValue ?? "0";
  const after = normalized.nextValue ?? normalized.currentValue ?? "1";

  if (!approve) {
    return buildNoticePayload(
      alreadyApplied ? "Whitelist ja estava removida" : "Whitelist removida",
      alreadyApplied
        ? "O registro da cidade ja estava desligado. Nada foi alterado."
        : `Seu ID estava ligado (${before}) e foi desligado (${after}) no banco da cidade. O Discord foi sincronizado.`,
      "ok",
    );
  }

  if (normalized.deferred || normalized.code === "city_deferred") {
    return buildNoticePayload(
      "Whitelist liberada",
      "Cargos e nickname foram aplicados no Discord. A Flowdesk nao depende do MySQL da cidade; a sync do jogo entra quando o launcher na VPS estiver no ar.",
      "ok",
    );
  }

  if (autoApproved) {
    if (freshlyApplied) {
      return buildNoticePayload(
        "Whitelist liberada",
        `Seu ID estava desligado (${before}) e foi liberado (${after}) no banco da cidade. Cargos e nickname foram aplicados no Discord.`,
        "ok",
      );
    }
    return buildNoticePayload(
      "Whitelist ja liberada",
      `Este ID ja estava liberado no banco da cidade (${after}). Cargos e nickname foram sincronizados no Discord.`,
      "ok",
    );
  }

  return buildNoticePayload(
    alreadyApplied ? "Whitelist ja estava liberada" : "Whitelist sincronizada",
    alreadyApplied
      ? `O registro da cidade ja estava liberado (${after}). O Discord foi sincronizado.`
      : `O banco da cidade foi atualizado (${before} -> ${after}) e o Discord foi sincronizado.`,
    "ok",
  );
}

async function assertManualWhitelistClaim(guildId, userId, identifierValue) {
  const byId = await whitelistDb.findBoundRequestByIdentifier(guildId, identifierValue);
  if (byId && String(byId.user_id) !== String(userId) && byId.status === "pending") {
    return {
      ok: false,
      code: "id_busy",
      title: "ID em analise",
      message: "Este ID ja esta em analise por outro membro.",
    };
  }
  return { ok: true };
}

function isCityPlayerMissing(result) {
  if (!result) return true;
  if (result.code === "player_not_found") return true;
  if (result.ok !== true) return false;
  const playerKey = String(result.playerKey ?? "").trim();
  return !playerKey;
}

async function upsertAutoWhitelistRequest({
  guildId,
  userId,
  identifierKind,
  identifierValue,
  playerName,
  correlationId,
}) {
  const openRequest = await whitelistDb.findOpenRequest(guildId, userId);
  if (openRequest) {
    return whitelistDb.updateWhitelistRequest(openRequest.id, {
      identifier_kind: identifierKind,
      identifier_value: identifierValue,
      correlation_id: correlationId,
      ...(playerName || openRequest.player_name
        ? { player_name: playerName || openRequest.player_name }
        : {}),
    });
  }
  try {
    return await whitelistDb.createWhitelistRequest({
      guild_id: guildId,
      user_id: userId,
      identifier_kind: identifierKind,
      identifier_value: identifierValue,
      status: "pending",
      correlation_id: correlationId,
      ...(playerName ? { player_name: playerName } : {}),
    });
  } catch {
    const retryOpen = await whitelistDb.findOpenRequest(guildId, userId);
    if (retryOpen) return retryOpen;
    throw new Error("duplicate_request");
  }
}

async function handleAutomaticWhitelistSubmit(interaction, settings, identifierKind, identifierValue, playerName) {
  const operationPromise = executeWhitelistOperation(
    settings,
    "APPROVE_WHITELIST",
    identifierValue,
    { interactive: true },
  );

  let deferTimer = null;
  if (!interaction.deferred && !interaction.replied) {
    deferTimer = setTimeout(() => {
      if (!interaction.deferred && !interaction.replied) {
        void settleMaybePromise(interaction.deferReply({ flags: MessageFlags.Ephemeral }));
      }
    }, 2500);
  }

  let result;
  try {
    result = normalizeWhitelistResult(await operationPromise);
  } catch (error) {
    result = { ok: false, ...sanitizeCityDbError(error) };
  } finally {
    if (deferTimer) clearTimeout(deferTimer);
  }

  const guildId = interaction.guildId;
  const correlationId = randomUUID();

  if (isCityPlayerMissing(result)) {
    const openRequest = await whitelistDb.findOpenRequest(guildId, interaction.user.id);
    if (openRequest) {
      await whitelistDb.updateWhitelistRequest(openRequest.id, {
        status: "cancelled",
        apply_error: "ID nao encontrado no banco da cidade.",
      }).catch(() => null);
    }
    await replyEphemeral(
      interaction,
      buildNoticePayload(
        "ID nao encontrado",
        "Esse ID nao existe no banco da cidade. Confira o numero e tente novamente.",
      ),
    );
    return;
  }

  if (!result.ok && isOptionalCityFailure(result)) {
    result = deferredCityResult(identifierValue);
  }

  if (!result.ok) {
    let failedRequest;
    try {
      failedRequest = await upsertAutoWhitelistRequest({
        guildId,
        userId: interaction.user.id,
        identifierKind,
        identifierValue,
        playerName,
        correlationId,
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
    await replyEphemeral(
      interaction,
      buildNoticePayload(result.title || "Nao foi possivel aplicar a whitelist", cityDbNoticeText(result)),
    );
    void persistWhitelistFailure({
      interaction,
      settings,
      request: failedRequest,
      result,
      operation: "APPROVE_WHITELIST",
      correlationId,
    });
    return;
  }

  let request;
  try {
    request = await upsertAutoWhitelistRequest({
      guildId,
      userId: interaction.user.id,
      identifierKind,
      identifierValue,
      playerName,
      correlationId,
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

  await persistWhitelistSuccess({
    interaction,
    settings,
    request,
    result,
    approve: true,
    operation: "APPROVE_WHITELIST",
    autoApproved: true,
    correlationId,
    cityPending: result.deferred === true || result.code === "city_deferred",
  });

  await replyEphemeral(
    interaction,
    buildWhitelistApplyNotice({ result, approve: true, autoApproved: true }),
  );
}

async function applyApprovedNickname(guild, userId, settings, identifierValue, playerName) {
  const member =
    guild.members.cache.get(userId) || (await guild.members.fetch(userId).catch(() => null));
  if (!member) return;
  const parsedName = sanitizePlayerName(playerName);
  const displayName = parsedName.ok
    ? parsedName.value
    : member.displayName || member.user?.globalName || member.user?.username || "Jogador";
  const nextNick = applyNicknameFormat(
    resolveNicknameFormat(settings),
    displayName,
    identifierValue,
  );
  if (!nextNick || member.nickname === nextNick || member.displayName === nextNick) return;
  await settleMaybePromise(member.setNickname(nextNick));
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
  try {
    if (interaction.deferred && !interaction.replied) {
      await interaction.editReply(payload);
      return;
    }
    if (interaction.replied) {
      await interaction.followUp(payload);
      return;
    }
    await interaction.reply(payload);
  } catch {
    await settleMaybePromise(interaction.followUp?.(payload));
  }
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
            request.player_name
              ? `**Nome:** \`${clampText(request.player_name, 40)}\``
              : "",
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
  const settings = runtime?.settings || (await whitelistDb.getGuildWhitelistSettings(guildId));

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

  if (!settings || !isWhitelistModuleActive(settings)) {
    await replyEphemeral(
      interaction,
      buildNoticePayload(
        "Configuracao incompleta",
        "A whitelist ainda nao foi configurada neste servidor. Abra o painel Flowdesk e salve o modulo.",
      ),
    );
    return;
  }

  const identifierKind = String(settings.identifier_kind || "discord_id");
  const label = clampText(settings.identifier_label || "ID / License", 45);
  const placeholder = clampText(
    settings.identifier_placeholder || "Coloque seu ID do jogo",
    100,
  );

  const modal = new ModalBuilder()
    .setCustomId(CUSTOM_IDS.submitWhitelistModal)
    .setTitle("Solicitar whitelist");

  const identifierInput = new TextInputBuilder()
    .setCustomId(CUSTOM_IDS.whitelistIdentifierInput)
    .setLabel(label)
    .setPlaceholder(placeholder || "Coloque seu ID do jogo")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(1)
    .setMaxLength(128);

  if (identifierKind === "discord_id") {
    identifierInput.setValue(interaction.user.id);
  }

  const nameInput = new TextInputBuilder()
    .setCustomId(CUSTOM_IDS.whitelistPlayerNameInput)
    .setLabel("SEU NOME")
    .setPlaceholder("Coloque seu NOME do jogo")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(2)
    .setMaxLength(24);

  modal.addComponents(
    new ActionRowBuilder().addComponents(identifierInput),
    new ActionRowBuilder().addComponents(nameInput),
  );
  await interaction.showModal(modal);
}

async function handleWhitelistModalSubmit(interaction) {
  const guildId = interaction.guildId;
  if (!guildId || !interaction.guild) return;

  const runtime = await getGuildWhitelistRuntime(guildId);
  const settings = runtime?.settings || (await whitelistDb.getGuildWhitelistSettings(guildId));

  if (!runtime?.licenseUsable || !isWhitelistModuleActive(settings)) {
    await replyEphemeral(
      interaction,
      buildNoticePayload(
        "Modulo indisponivel",
        "Nao foi possivel registrar sua solicitacao agora.",
      ),
    );
    return;
  }

  const identifierKind = String(settings.identifier_kind || "discord_id");
  const parsedIdentifier = validateIdentifier(
    identifierKind,
    interaction.fields.getTextInputValue(CUSTOM_IDS.whitelistIdentifierInput),
  );
  if (!parsedIdentifier.ok) {
    await replyEphemeral(
      interaction,
      buildNoticePayload("Identificador invalido", parsedIdentifier.message),
    );
    return;
  }
  const identifierValue = parsedIdentifier.value;

  let playerName = "";
  try {
    const parsedName = sanitizePlayerName(
      interaction.fields.getTextInputValue(CUSTOM_IDS.whitelistPlayerNameInput),
    );
    if (!parsedName.ok) {
      await replyEphemeral(
        interaction,
        buildNoticePayload("Nome invalido", parsedName.message),
      );
      return;
    }
    playerName = parsedName.value;
  } catch {
    await replyEphemeral(
      interaction,
      buildNoticePayload(
        "Nome obrigatorio",
        "Informe seu nome do jogo. Esse nome sera usado no nick apos a liberacao.",
      ),
    );
    return;
  }

  if (!consumeAttempt(guildId, interaction.user.id).ok) {
    await replyEphemeral(
      interaction,
      buildNoticePayload(
        "Aguarde um momento",
        "Muitas tentativas em pouco tempo. Tente novamente em alguns minutos.",
        "warning",
      ),
    );
    return;
  }

  const isAutomatic = String(settings.approval_mode || "manual") === "automatic";

  if (isAutomatic) {
    await handleAutomaticWhitelistSubmit(
      interaction,
      settings,
      identifierKind,
      identifierValue,
      playerName,
    );
    return;
  }

  const claim = await assertManualWhitelistClaim(guildId, interaction.user.id, identifierValue);
  if (!claim.ok) {
    await replyEphemeral(
      interaction,
      buildNoticePayload(claim.title, claim.message, "warning"),
    );
    return;
  }

  const openRequest = await whitelistDb.findOpenRequest(guildId, interaction.user.id);

  if (openRequest) {
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

  const correlationId = randomUUID();
  let request;
  try {
    request = await whitelistDb.createWhitelistRequest({
      guild_id: guildId,
      user_id: interaction.user.id,
      identifier_kind: identifierKind,
      identifier_value: identifierValue,
      player_name: playerName,
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
      `**Nome:** \`${playerName}\``,
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
      result = normalizeWhitelistResult(
        await executeWhitelistOperation(
          settings,
          cityOperation,
          request.identifier_value,
        ),
      );
    } catch (error) {
      result = { ok: false, ...sanitizeCityDbError(error) };
    }

    if (!result.ok && isOptionalCityFailure(result)) {
      result = deferredCityResult(request.identifier_value);
    }

    if (!result.ok) {
      const missingPlayer = result.code === "player_not_found" || isCityPlayerMissing(result);
      await replyEphemeral(
        interaction,
        buildNoticePayload(
          missingPlayer ? "ID nao encontrado" : result.title || "Nao foi possivel aplicar a whitelist",
          missingPlayer
            ? "Esse ID nao existe no banco da cidade. A whitelist so e liberada para um ID cadastrado."
            : cityDbNoticeText(result),
        ),
      );
      void persistWhitelistFailure({
        interaction,
        settings,
        request,
        result,
        operation,
        correlationId,
      });
      return;
    }

    await persistWhitelistSuccess({
      interaction,
      settings,
      request,
      result,
      approve,
      operation,
      autoApproved,
      correlationId,
      cityPending: result.deferred === true || result.code === "city_deferred",
    });

    await replyEphemeral(
      interaction,
      buildWhitelistApplyNotice({ result, approve, autoApproved }),
    );
  } finally {
    applyingLocks.delete(lockKey);
  }
}

async function persistWhitelistFailure({
  interaction,
  settings,
  request,
  result,
  operation,
  correlationId,
}) {
  const nextRequest = await whitelistDb.updateWhitelistRequest(request.id, {
    status: "apply_failed",
    reviewed_by_user_id: interaction.user.id,
    reviewed_at: new Date().toISOString(),
    apply_error: result.message || "Falha ao sincronizar com o banco da cidade.",
    player_key: result.playerKey || request.player_key || null,
    previous_whitelist_value: result.previousValue ?? request.previous_whitelist_value ?? null,
  });
  await Promise.all([
    whitelistDb.insertWhitelistAudit({
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
    }),
    refreshReviewMessage(interaction.guild, nextRequest, settings),
    sendWhitelistLog({
      guild: interaction.guild,
      settings,
      title: result.title || "Banco da cidade offline",
      color: 0xe74c3c,
      lines: [
        `**Pedido:** \`${request.id}\``,
        `**Membro:** <@${request.user_id}>`,
        `**Erro:** ${clampText(result.message || "O banco da cidade nao esta online.", 180)}`,
        result.hint ? `**Obs:** ${clampText(result.hint, 180)}` : "",
        `**Correlation:** \`${correlationId}\``,
      ].filter(Boolean),
    }),
  ]).catch(() => null);
}

async function persistWhitelistSuccess({
  interaction,
  settings,
  request,
  result,
  approve,
  operation,
  autoApproved,
  correlationId,
  cityPending = false,
}) {
  const nextRequest = await whitelistDb.updateWhitelistRequest(request.id, {
    status: approve ? "approved" : "denied",
    reviewed_by_user_id: interaction.user.id,
    reviewed_at: new Date().toISOString(),
    applied_at: new Date().toISOString(),
    apply_error: cityPending ? "pending_city_sync" : null,
    player_key: result.playerKey || null,
    previous_whitelist_value: result.previousValue ?? null,
    next_whitelist_value: result.nextValue ?? null,
    ...(request.player_name ? { player_name: request.player_name } : {}),
  });
  await Promise.all([
    whitelistDb.insertWhitelistAudit({
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
    }),
    assignRoles(
      interaction.guild,
      request.user_id,
      approve ? settings.approved_role_ids : settings.denied_role_ids,
      approve ? settings.denied_role_ids : settings.approved_role_ids,
    ),
    approve
      ? applyApprovedNickname(
          interaction.guild,
          request.user_id,
          settings,
          request.identifier_value,
          request.player_name,
        )
      : Promise.resolve(),
    refreshReviewMessage(interaction.guild, nextRequest, settings),
    sendWhitelistLog({
      guild: interaction.guild,
      settings,
      title: cityPending
        ? "Whitelist liberada no Discord"
        : autoApproved
          ? "Whitelist automatica sincronizada"
          : approve
            ? "Whitelist aprovada"
            : "Whitelist removida",
      color: approve ? 0x2ecc71 : 0xe74c3c,
      lines: [
        `**Pedido:** \`${request.id}\``,
        `**Membro:** <@${request.user_id}>`,
        request.player_name ? `**Nome:** \`${clampText(request.player_name, 40)}\`` : "",
        `**Identificador:** \`${request.identifier_value}\``,
        `**Jogador:** \`${result.playerKey || "-"}\``,
        `**Antes:** \`${result.previousValue ?? "null"}\``,
        `**Depois:** \`${result.nextValue ?? "null"}\``,
        `**Staff:** ${autoApproved ? "Automatico" : `${interaction.user} (\`${interaction.user.id}\`)`}`,
        `**Correlation:** \`${correlationId}\``,
      ].filter(Boolean),
    }),
  ]).catch(() => null);
}

async function handleWhitelistReviewInteraction(interaction) {
  const parsed = parseReviewCustomId(interaction.customId);
  if (!parsed || !interaction.guildId || !interaction.guild) return;

  if (!interaction.deferred && !interaction.replied) {
    await settleMaybePromise(interaction.deferReply({ flags: MessageFlags.Ephemeral }));
  }

  const runtime = await getGuildWhitelistRuntime(interaction.guildId);
  const settings = runtime?.settings;

  if (!runtime?.licenseUsable || !isWhitelistModuleActive(settings)) {
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

async function retryFailedWhitelistApplies(client) {
  const failed = await whitelistDb.listApplyFailedRequests(12);
  for (const request of failed || []) {
    if (!request?.id || retryingFailedApplies.has(request.id)) continue;
    const updatedAt = Date.parse(request.updated_at || request.reviewed_at || 0);
    if (updatedAt && Date.now() - updatedAt < 8000) continue;
    if (updatedAt && Date.now() - updatedAt > 30 * 60 * 1000) continue;
    const lockKey = `${request.guild_id}:${request.id}`;
    if (applyingLocks.has(lockKey)) continue;
    retryingFailedApplies.add(request.id);
    applyingLocks.add(lockKey);
    try {
      const settings = await whitelistDb.getGuildWhitelistSettings(request.guild_id);
      if (!isWhitelistModuleActive(settings)) continue;
      const result = await executeWhitelistOperation(
        settings,
        "APPROVE_WHITELIST",
        request.identifier_value,
      );
      if (!result.ok) continue;
      const guild = await client.guilds.fetch(request.guild_id).catch(() => null);
      if (!guild) continue;
      await whitelistDb.updateWhitelistRequest(request.id, {
        status: "approved",
        apply_error: null,
        applied_at: new Date().toISOString(),
        player_key: result.playerKey || request.player_key || null,
        previous_whitelist_value: result.previousValue ?? request.previous_whitelist_value ?? null,
        next_whitelist_value: result.nextValue ?? null,
      });
      await assignRoles(guild, request.user_id, settings.approved_role_ids, settings.denied_role_ids);
      await applyApprovedNickname(
        guild,
        request.user_id,
        settings,
        request.identifier_value,
        request.player_name,
      );
      await sendWhitelistLog({
        guild,
        settings,
        title: "Whitelist sincronizada automaticamente",
        color: 0x2ecc71,
        lines: [
          `**Pedido:** \`${request.id}\``,
          `**Membro:** <@${request.user_id}>`,
          request.player_name ? `**Nome:** \`${clampText(request.player_name, 40)}\`` : "",
          `**Jogador:** \`${result.playerKey || request.player_key || "-"}\``,
        ],
      });
    } catch (error) {
      console.error("[whitelist-auto-retry]", error);
    } finally {
      applyingLocks.delete(lockKey);
      retryingFailedApplies.delete(request.id);
    }
  }
}

async function reconcileCompletedAgentJobs(client) {
  if (Date.now() - lastPoolHealthAt >= POOL_HEALTH_INTERVAL_MS) {
    lastPoolHealthAt = Date.now();
    await healthCheckActivePools().catch((error) => {
      console.error("[city-db-health]", error);
    });
  }
  await retryFailedWhitelistApplies(client).catch((error) => {
    console.error("[whitelist-auto-retry]", error);
  });
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
          await applyApprovedNickname(
            guild,
            request.user_id,
            settings,
            request.identifier_value,
            request.player_name,
          );
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
