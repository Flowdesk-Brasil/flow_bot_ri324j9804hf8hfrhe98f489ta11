const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");
const { withEphemeralComponentsV2 } = require("../utils/componentFactory");
const sorteioDb = require("./sorteioDbService");

const SORTEIO_PREFIX = "sorteio:";
const COMPONENT_TYPE = { ACTION_ROW: 1, BUTTON: 2, TEXT_DISPLAY: 10, CONTAINER: 17, SEPARATOR: 14 };
const BUTTON_STYLE = { PRIMARY: 1, SECONDARY: 2, SUCCESS: 3, DANGER: 4 };
const MESSAGE_FLAG_IS_COMPONENTS_V2 = 32768;

const MIN_TITLE_LENGTH = 3;
const MAX_TITLE_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 1000;
const MIN_DURATION_MINUTES = 1;
const MAX_DURATION_MINUTES = 43200;
const MAX_WINNERS = 25;
const PARTICIPANTS_PAGE_SIZE = 20;
const DRAFT_TTL_MS = 30 * 60 * 1000;

/** @type {Map<string, object>} */
const draftSessions = new Map();

function clampText(value, maxLength) {
  return String(value || "").slice(0, maxLength);
}

/** Discord rejeita setValue vazio quando minLength > tamanho do valor. */
function applyModalInputValue(builder, value, minLength = 1) {
  const text = String(value ?? "").trim();
  if (text.length >= minLength) {
    builder.setValue(text);
  }
  return builder;
}

function buildModalField({ customId, label, style, required, minLength, maxLength, placeholder, value }) {
  const input = new TextInputBuilder()
    .setCustomId(customId)
    .setLabel(clampText(label, 45))
    .setStyle(style)
    .setRequired(required);

  if (maxLength) input.setMaxLength(maxLength);
  if (minLength) input.setMinLength(minLength);
  if (placeholder) input.setPlaceholder(clampText(placeholder, 100));
  applyModalInputValue(input, value, minLength || 1);

  return input;
}

function draftKey(guildId, userId) {
  return `${guildId}:${userId}`;
}

function getDraft(guildId, userId) {
  const key = draftKey(guildId, userId);
  const draft = draftSessions.get(key);
  if (!draft) return createDefaultDraft(guildId, userId);
  if (Date.now() - draft.updatedAt > DRAFT_TTL_MS) {
    draftSessions.delete(key);
    return createDefaultDraft(guildId, userId);
  }
  return draft;
}

function saveDraft(guildId, userId, patch) {
  const key = draftKey(guildId, userId);
  const current = getDraft(guildId, userId);
  const next = { ...current, ...patch, updatedAt: Date.now() };
  draftSessions.set(key, next);
  return next;
}

function clearDraft(guildId, userId) {
  draftSessions.delete(draftKey(guildId, userId));
}

function createDefaultDraft(guildId, userId) {
  return {
    guildId,
    userId,
    title: "",
    description: "",
    durationMinutes: 60,
    winnerCount: 1,
    requiredRoleIds: [],
    minServerDays: 0,
    minAccountAgeDays: 0,
    blacklistUserIds: [],
    setupChannelId: null,
    setupMessageId: null,
    updatedAt: Date.now(),
  };
}

function canManageSorteio(interaction, sorteio) {
  if (!interaction.guild) return false;
  const member = interaction.member;
  if (!member) return false;
  if (member.permissions.has(PermissionFlagsBits.Administrator)) return true;
  if (member.permissions.has(PermissionFlagsBits.ManageGuild)) return true;
  if (sorteio && sorteio.host_user_id === interaction.user.id) return true;
  return false;
}

function parseIdList(raw) {
  const text = String(raw || "");
  const ids = new Set();
  const mentionRegex = /<@!?(\d+)>/g;
  const roleRegex = /<@&(\d+)>/g;
  let match;
  while ((match = mentionRegex.exec(text))) ids.add(match[1]);
  while ((match = roleRegex.exec(text))) ids.add(match[1]);
  text
    .split(/[\s,;]+/)
    .map((part) => part.trim())
    .filter((part) => /^\d{5,}$/.test(part))
    .forEach((part) => ids.add(part));
  return [...ids];
}

function parseRoleIdList(raw) {
  const text = String(raw || "");
  const ids = new Set();
  const roleRegex = /<@&(\d+)>/g;
  let match;
  while ((match = roleRegex.exec(text))) ids.add(match[1]);
  text
    .split(/[\s,;]+/)
    .map((part) => part.trim())
    .filter((part) => /^\d{5,}$/.test(part))
    .forEach((part) => ids.add(part));
  return [...ids];
}

function formatDurationMinutes(minutes) {
  const value = Number(minutes) || 0;
  if (value < 60) return `${value} min`;
  if (value < 1440) {
    const hours = Math.floor(value / 60);
    const mins = value % 60;
    return mins ? `${hours}h ${mins}min` : `${hours}h`;
  }
  const days = Math.floor(value / 1440);
  const hours = Math.floor((value % 1440) / 60);
  return hours ? `${days}d ${hours}h` : `${days}d`;
}

function formatRequirements(sorteio) {
  const lines = [];
  const roles = sorteio.required_role_ids || [];
  if (roles.length) {
    lines.push(`-# Cargos: ${roles.map((id) => `<@&${id}>`).join(", ")}`);
  }
  if (sorteio.min_server_days > 0) {
    lines.push(`-# Tempo no servidor: minimo ${sorteio.min_server_days} dia(s)`);
  }
  if (sorteio.min_account_age_days > 0) {
    lines.push(`-# Conta Discord: minimo ${sorteio.min_account_age_days} dia(s)`);
  }
  if (!lines.length) {
    lines.push("-# Requisitos: nenhum (todos podem participar)");
  }
  return lines.join("\n");
}

function buildFailurePayload(title, message) {
  return withEphemeralComponentsV2({
    components: [
      {
        type: COMPONENT_TYPE.CONTAINER,
        accent_color: 0xe74c3c,
        components: [{ type: COMPONENT_TYPE.TEXT_DISPLAY, content: [`### ${title}`, message].join("\n\n") }],
      },
    ],
  });
}

function buildSuccessPayload(title, message) {
  return withEphemeralComponentsV2({
    components: [
      {
        type: COMPONENT_TYPE.CONTAINER,
        accent_color: 0x2ecc71,
        components: [{ type: COMPONENT_TYPE.TEXT_DISPLAY, content: [`### ${title}`, message].join("\n\n") }],
      },
    ],
  });
}

function buildSetupSummary(draft) {
  const titleLine = draft.title
    ? `-# Titulo: **${draft.title}**`
    : "-# Titulo: *nao definido*";
  const descLine = draft.description
    ? `-# Premio: ${clampText(draft.description, 120)}${draft.description.length > 120 ? "..." : ""}`
    : "-# Premio: *nao definido*";
  const roles =
    draft.requiredRoleIds.length > 0
      ? draft.requiredRoleIds.map((id) => `<@&${id}>`).join(", ")
      : "Nenhum";
  const blacklist =
    draft.blacklistUserIds.length > 0
      ? draft.blacklistUserIds.map((id) => `<@${id}>`).join(", ")
      : "Nenhum";

  const ready =
    draft.title.length >= MIN_TITLE_LENGTH && draft.description.length >= 3;

  return [
    "## Central de Sorteios",
    "-# Configure o sorteio e clique em **Enviar Sorteio** quando estiver pronto.",
    "",
    ready ? "-# Status: **Pronto para publicar**" : "-# Status: *pendente — defina titulo e premio*",
    "",
    titleLine,
    descLine,
    `-# Duracao: **${formatDurationMinutes(draft.durationMinutes)}** (${draft.durationMinutes} min)`,
    `-# Vencedores: **${draft.winnerCount}**`,
    `-# Cargos obrigatorios: ${roles}`,
    `-# Tempo minimo no servidor: **${draft.minServerDays}** dia(s)`,
    `-# Idade minima da conta: **${draft.minAccountAgeDays}** dia(s)`,
    `-# Blacklist: ${blacklist}`,
  ].join("\n");
}

function buildSetupPanelPayload(draft, userId) {
  const summary = buildSetupSummary(draft);
  return withEphemeralComponentsV2({
    components: [
      {
        type: COMPONENT_TYPE.CONTAINER,
        accent_color: 0xf1c40f,
        components: [{ type: COMPONENT_TYPE.TEXT_DISPLAY, content: summary }],
      },
      {
        type: COMPONENT_TYPE.ACTION_ROW,
        components: [
          {
            type: COMPONENT_TYPE.BUTTON,
            style: BUTTON_STYLE.PRIMARY,
            label: "Definir Sorteio",
            custom_id: `${SORTEIO_PREFIX}btn:basic:${userId}`,
          },
          {
            type: COMPONENT_TYPE.BUTTON,
            style: BUTTON_STYLE.SECONDARY,
            label: "Tempo (minutos)",
            custom_id: `${SORTEIO_PREFIX}btn:time:${userId}`,
          },
          {
            type: COMPONENT_TYPE.BUTTON,
            style: BUTTON_STYLE.SECONDARY,
            label: "Vencedores",
            custom_id: `${SORTEIO_PREFIX}btn:winners:${userId}`,
          },
        ],
      },
      {
        type: COMPONENT_TYPE.ACTION_ROW,
        components: [
          {
            type: COMPONENT_TYPE.BUTTON,
            style: BUTTON_STYLE.SECONDARY,
            label: "Cargos",
            custom_id: `${SORTEIO_PREFIX}btn:roles:${userId}`,
          },
          {
            type: COMPONENT_TYPE.BUTTON,
            style: BUTTON_STYLE.SECONDARY,
            label: "Tempo no servidor",
            custom_id: `${SORTEIO_PREFIX}btn:serverdays:${userId}`,
          },
          {
            type: COMPONENT_TYPE.BUTTON,
            style: BUTTON_STYLE.SECONDARY,
            label: "Idade da conta",
            custom_id: `${SORTEIO_PREFIX}btn:accountdays:${userId}`,
          },
        ],
      },
      {
        type: COMPONENT_TYPE.ACTION_ROW,
        components: [
          {
            type: COMPONENT_TYPE.BUTTON,
            style: BUTTON_STYLE.SECONDARY,
            label: "Blacklist",
            custom_id: `${SORTEIO_PREFIX}btn:blacklist:${userId}`,
          },
          {
            type: COMPONENT_TYPE.BUTTON,
            style: BUTTON_STYLE.SECONDARY,
            label: "Historico",
            custom_id: `${SORTEIO_PREFIX}btn:history:${userId}`,
          },
          {
            type: COMPONENT_TYPE.BUTTON,
            style: BUTTON_STYLE.SECONDARY,
            label: "Atualizar",
            custom_id: `${SORTEIO_PREFIX}btn:refresh:${userId}`,
          },
        ],
      },
      {
        type: COMPONENT_TYPE.ACTION_ROW,
        components: [
          {
            type: COMPONENT_TYPE.BUTTON,
            style: BUTTON_STYLE.SUCCESS,
            label: "Enviar Sorteio",
            custom_id: `${SORTEIO_PREFIX}btn:send:${userId}`,
          },
          {
            type: COMPONENT_TYPE.BUTTON,
            style: BUTTON_STYLE.DANGER,
            label: "Cancelar",
            custom_id: `${SORTEIO_PREFIX}btn:cancel:${userId}`,
          },
        ],
      },
    ],
  });
}

function buildActiveSorteioPayload(sorteio, entryCount, { ended = false } = {}) {
  const endsUnix = Math.floor(new Date(sorteio.ends_at).getTime() / 1000);
  const statusLine = ended
    ? "-# Status: **Encerrado**"
    : `-# Termina: <t:${endsUnix}:R> (<t:${endsUnix}:f>)`;

  const content = [
    ended ? "## Sorteio encerrado" : "## Sorteio ativo",
    `### ${sorteio.title}`,
    "",
    sorteio.description || "-# Sem descricao adicional.",
    "",
    statusLine,
    `-# Participantes: **${entryCount}**`,
    `-# Vencedores: **${sorteio.winner_count}**`,
    formatRequirements(sorteio),
    `-# Host: <@${sorteio.host_user_id}>`,
  ].join("\n");

  const components = [
    {
      type: COMPONENT_TYPE.CONTAINER,
      accent_color: ended ? 0x95a5a6 : 0xf1c40f,
      components: [
        { type: COMPONENT_TYPE.TEXT_DISPLAY, content },
        { type: COMPONENT_TYPE.SEPARATOR, divider: true, spacing: 1 },
        {
          type: COMPONENT_TYPE.TEXT_DISPLAY,
          content: ended
            ? "-# Clique em **Reroll** para sortear novamente (host ou staff)."
            : "-# Clique em **Entrar no sorteio** para participar.",
        },
      ],
    },
  ];

  if (!ended) {
    components.push({
      type: COMPONENT_TYPE.ACTION_ROW,
      components: [
        {
          type: COMPONENT_TYPE.BUTTON,
          style: BUTTON_STYLE.SUCCESS,
          label: "Entrar no sorteio",
          custom_id: `${SORTEIO_PREFIX}enter:${sorteio.id}`,
        },
        {
          type: COMPONENT_TYPE.BUTTON,
          style: BUTTON_STYLE.SECONDARY,
          label: "⚙",
          custom_id: `${SORTEIO_PREFIX}gear:${sorteio.id}`,
        },
      ],
    });
  } else {
    components.push({
      type: COMPONENT_TYPE.ACTION_ROW,
      components: [
        {
          type: COMPONENT_TYPE.BUTTON,
          style: BUTTON_STYLE.SECONDARY,
          label: "Ver participantes",
          custom_id: `${SORTEIO_PREFIX}participants:${sorteio.id}:0`,
        },
        {
          type: COMPONENT_TYPE.BUTTON,
          style: BUTTON_STYLE.PRIMARY,
          label: "Reroll",
          custom_id: `${SORTEIO_PREFIX}reroll:${sorteio.id}`,
        },
      ],
    });
  }

  return {
    flags: MESSAGE_FLAG_IS_COMPONENTS_V2,
    components,
    allowedMentions: { parse: ["users", "roles"] },
  };
}

function buildWinnerAnnouncementPayload(sorteio, winnerIds, { reroll = false } = {}) {
  const winnerMentions =
    winnerIds.length > 0
      ? winnerIds.map((id) => `<@${id}>`).join(", ")
      : "Nenhum participante valido";

  const title = reroll
    ? "## Novo resultado (reroll)"
    : "## Sorteio finalizado!";

  const content = [
    title,
    `### ${sorteio.title}`,
    "",
    winnerIds.length === 1
      ? `-# Ganhador: ${winnerMentions}`
      : `-# Ganhadores (${winnerIds.length}): ${winnerMentions}`,
    `-# Total de participantes no sorteio: consulte a mensagem acima.`,
    `-# Parabens! Entre em contato com <@${sorteio.host_user_id}> para receber o premio.`,
  ].join("\n");

  return {
    flags: MESSAGE_FLAG_IS_COMPONENTS_V2,
    components: [
      {
        type: COMPONENT_TYPE.CONTAINER,
        accent_color: 0x2ecc71,
        components: [{ type: COMPONENT_TYPE.TEXT_DISPLAY, content }],
      },
      {
        type: COMPONENT_TYPE.ACTION_ROW,
        components: [
          {
            type: COMPONENT_TYPE.BUTTON,
            style: BUTTON_STYLE.PRIMARY,
            label: "Reroll",
            custom_id: `${SORTEIO_PREFIX}reroll:${sorteio.id}`,
          },
        ],
      },
    ],
    allowedMentions: { parse: ["users"] },
  };
}

function buildGearPanelPayload(sorteio, { isEntered, entryCount }) {
  const statusText = isEntered
    ? "Voce **esta participando** deste sorteio."
    : "Voce **nao esta participando** deste sorteio.";

  return withEphemeralComponentsV2({
    components: [
      {
        type: COMPONENT_TYPE.CONTAINER,
        accent_color: 0x3498db,
        components: [
          {
            type: COMPONENT_TYPE.TEXT_DISPLAY,
            content: ["### Gerenciar participacao", statusText, `-# Participantes: **${entryCount}**`].join("\n\n"),
          },
        ],
      },
      {
        type: COMPONENT_TYPE.ACTION_ROW,
        components: [
          {
            type: COMPONENT_TYPE.BUTTON,
            style: BUTTON_STYLE.DANGER,
            label: "Sair do sorteio",
            custom_id: `${SORTEIO_PREFIX}leave:${sorteio.id}`,
            disabled: !isEntered || sorteio.status !== "active",
          },
          {
            type: COMPONENT_TYPE.BUTTON,
            style: BUTTON_STYLE.SECONDARY,
            label: `Ver participantes (${entryCount})`,
            custom_id: `${SORTEIO_PREFIX}participants:${sorteio.id}:0`,
          },
        ],
      },
    ],
  });
}

function buildParticipantsPayload(sorteio, entries, page = 0) {
  const total = entries.length;
  const start = page * PARTICIPANTS_PAGE_SIZE;
  const slice = entries.slice(start, start + PARTICIPANTS_PAGE_SIZE);
  const mentions = slice.map((entry) => `<@${entry.user_id}>`).join(", ") || "Nenhum participante nesta pagina.";
  const totalPages = Math.max(1, Math.ceil(total / PARTICIPANTS_PAGE_SIZE));

  const content = [
    "### Lista de participantes",
    `-# Sorteio: **${sorteio.title}**`,
    `-# Total: **${total}** participante(s)`,
    `-# Pagina **${page + 1}** de **${totalPages}**`,
    "",
    mentions,
  ].join("\n");

  const navRow = {
    type: COMPONENT_TYPE.ACTION_ROW,
    components: [
      {
        type: COMPONENT_TYPE.BUTTON,
        style: BUTTON_STYLE.SECONDARY,
        label: "Anterior",
        custom_id: `${SORTEIO_PREFIX}participants:${sorteio.id}:${Math.max(0, page - 1)}`,
        disabled: page <= 0,
      },
      {
        type: COMPONENT_TYPE.BUTTON,
        style: BUTTON_STYLE.SECONDARY,
        label: "Proxima",
        custom_id: `${SORTEIO_PREFIX}participants:${sorteio.id}:${page + 1}`,
        disabled: page + 1 >= totalPages,
      },
    ],
  };

  return withEphemeralComponentsV2({
    components: [
      {
        type: COMPONENT_TYPE.CONTAINER,
        accent_color: 0x9b59b6,
        components: [{ type: COMPONENT_TYPE.TEXT_DISPLAY, content }],
      },
      ...(totalPages > 1 ? [navRow] : []),
    ],
    allowedMentions: { parse: ["users"] },
  });
}

function buildHistoryPayload(items) {
  if (!items.length) {
    return buildSuccessPayload("Historico de sorteios", "Nenhum sorteio encerrado encontrado neste servidor.");
  }

  const lines = items.map((item) => {
    const winners = (item.winner_user_ids || []).map((id) => `<@${id}>`).join(", ") || "Sem ganhador";
    const endedUnix = item.ended_at
      ? Math.floor(new Date(item.ended_at).getTime() / 1000)
      : null;
    const when = endedUnix ? `<t:${endedUnix}:R>` : "data desconhecida";
    return `- **${item.title}** — ${winners} (${when})`;
  });

  return withEphemeralComponentsV2({
    components: [
      {
        type: COMPONENT_TYPE.CONTAINER,
        accent_color: 0x34495e,
        components: [
          {
            type: COMPONENT_TYPE.TEXT_DISPLAY,
            content: ["### Historico recente", ...lines].join("\n"),
          },
        ],
      },
    ],
    allowedMentions: { parse: ["users"] },
  });
}

async function replySorteio(interaction, payload) {
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp(payload).catch(() => null);
    return;
  }
  await interaction.reply(payload);
}

async function updateSorteioMessage(client, sorteio) {
  if (!sorteio?.channel_id || !sorteio?.message_id) return;
  const channel = await client.channels.fetch(sorteio.channel_id).catch(() => null);
  if (!channel?.isTextBased?.()) return;
  const message = await channel.messages.fetch(sorteio.message_id).catch(() => null);
  if (!message) return;

  const entryCount = await sorteioDb.getEntryCount(sorteio.id);
  const payload = buildActiveSorteioPayload(sorteio, entryCount, {
    ended: sorteio.status !== "active",
  });
  await message.edit(payload).catch(() => null);
}

function pickRandomWinners(entries, count, excludeIds = []) {
  const exclude = new Set(excludeIds.map(String));
  const pool = entries.filter((entry) => !exclude.has(String(entry.user_id)));
  const shuffled = [...pool];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, count).map((entry) => entry.user_id);
}

async function validateEntryEligibility(interaction, sorteio) {
  const member = interaction.member;
  const user = interaction.user;

  if (sorteio.status !== "active") {
    return "Este sorteio ja foi encerrado.";
  }

  if (new Date(sorteio.ends_at).getTime() <= Date.now()) {
    return "Este sorteio expirou.";
  }

  const blacklist = await sorteioDb.getBlacklistUserIds(sorteio.id);
  if (blacklist.includes(user.id)) {
    return "Voce esta na blacklist deste sorteio e nao pode participar.";
  }

  const requiredRoles = sorteio.required_role_ids || [];
  if (requiredRoles.length) {
    const hasRole = requiredRoles.some((roleId) => member.roles.cache.has(roleId));
    if (!hasRole) {
      return `Voce precisa de um destes cargos: ${requiredRoles.map((id) => `<@&${id}>`).join(", ")}`;
    }
  }

  if (sorteio.min_server_days > 0 && member.joinedTimestamp) {
    const days =
      (Date.now() - member.joinedTimestamp) / (1000 * 60 * 60 * 24);
    if (days < sorteio.min_server_days) {
      return `Voce precisa estar no servidor ha pelo menos ${sorteio.min_server_days} dia(s).`;
    }
  }

  if (sorteio.min_account_age_days > 0 && user.createdTimestamp) {
    const days =
      (Date.now() - user.createdTimestamp) / (1000 * 60 * 60 * 24);
    if (days < sorteio.min_account_age_days) {
      return `Sua conta Discord precisa ter pelo menos ${sorteio.min_account_age_days} dia(s).`;
    }
  }

  return null;
}

async function endSorteio(client, sorteio, { reroll = false } = {}) {
  const fresh = await sorteioDb.getSorteioById(sorteio.id);
  if (!fresh) return null;
  if (!reroll && fresh.status !== "active") return fresh;

  const entries = await sorteioDb.getEntries(fresh.id);
  const exclude = reroll ? fresh.winner_user_ids || [] : [];
  let winners = pickRandomWinners(entries, fresh.winner_count, exclude);

  if (reroll && winners.length < fresh.winner_count) {
    winners = pickRandomWinners(entries, fresh.winner_count, []);
  }

  const patch = {
    winner_user_ids: winners,
    reroll_count: reroll ? (fresh.reroll_count || 0) + 1 : fresh.reroll_count || 0,
  };

  if (!reroll) {
    patch.status = "ended";
    patch.ended_at = new Date().toISOString();
  }

  const ended = await sorteioDb.updateSorteio(fresh.id, patch);

  if (!reroll) {
    await updateSorteioMessage(client, ended);
  }

  const channel = await client.channels.fetch(ended.channel_id).catch(() => null);
  if (channel?.isTextBased?.()) {
    const payload = buildWinnerAnnouncementPayload(ended, winners, { reroll });
    await channel.send(payload).catch(() => null);
  }

  return ended;
}

async function publishSorteio(interaction) {
  const guildId = interaction.guildId;
  const userId = interaction.user.id;
  const draft = getDraft(guildId, userId);

  if (!draft.title || draft.title.length < MIN_TITLE_LENGTH) {
    await replySorteio(
      interaction,
      buildFailurePayload("Configuracao incompleta", "Defina um titulo com pelo menos 3 caracteres."),
    );
    return;
  }

  if (!draft.description || draft.description.length < 3) {
    await replySorteio(
      interaction,
      buildFailurePayload("Configuracao incompleta", "Defina a descricao do premio no sorteio."),
    );
    return;
  }

  const endsAt = new Date(Date.now() + draft.durationMinutes * 60 * 1000);

  const created = await sorteioDb.createSorteio({
    guild_id: guildId,
    host_user_id: userId,
    channel_id: interaction.channelId,
    title: draft.title,
    description: draft.description,
    winner_count: draft.winnerCount,
    required_role_ids: draft.requiredRoleIds,
    min_server_days: draft.minServerDays,
    min_account_age_days: draft.minAccountAgeDays,
    ends_at: endsAt.toISOString(),
    status: "active",
  });

  if (!created) {
    await replySorteio(
      interaction,
      buildFailurePayload(
        "Banco indisponivel",
        "Nao foi possivel criar o sorteio. Verifique se a migracao SQL foi aplicada no Supabase.",
      ),
    );
    return;
  }

  if (draft.blacklistUserIds.length) {
    await sorteioDb.replaceBlacklist(
      created.id,
      guildId,
      draft.blacklistUserIds,
      userId,
    );
  }

  const payload = buildActiveSorteioPayload(created, 0);
  const message = await interaction.channel.send(payload);

  await sorteioDb.updateSorteio(created.id, { message_id: message.id });
  clearDraft(guildId, userId);

  await replySorteio(
    interaction,
    buildSuccessPayload(
      "Sorteio publicado",
      `O sorteio **${created.title}** foi enviado neste canal.\nEncerra <t:${Math.floor(endsAt.getTime() / 1000)}:R>.`,
    ),
  );
}

function showBasicModal(interaction, draft) {
  const modal = new ModalBuilder()
    .setCustomId(`${SORTEIO_PREFIX}modal:basic:${interaction.user.id}`)
    .setTitle("Definir sorteio");

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      buildModalField({
        customId: `${SORTEIO_PREFIX}field:title`,
        label: "Titulo",
        style: TextInputStyle.Short,
        required: true,
        minLength: MIN_TITLE_LENGTH,
        maxLength: MAX_TITLE_LENGTH,
        placeholder: "Ex: Sorteio Nitro mensal",
        value: draft.title,
      }),
    ),
    new ActionRowBuilder().addComponents(
      buildModalField({
        customId: `${SORTEIO_PREFIX}field:description`,
        label: "Descricao do premio",
        style: TextInputStyle.Paragraph,
        required: true,
        minLength: 3,
        maxLength: MAX_DESCRIPTION_LENGTH,
        placeholder: "Descreva o que o ganhador vai receber.",
        value: draft.description,
      }),
    ),
  );

  return interaction.showModal(modal);
}

function showTimeModal(interaction, draft) {
  const modal = new ModalBuilder()
    .setCustomId(`${SORTEIO_PREFIX}modal:time:${interaction.user.id}`)
    .setTitle("Tempo do sorteio");

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      buildModalField({
        customId: `${SORTEIO_PREFIX}field:minutes`,
        label: "Duracao (minutos)",
        style: TextInputStyle.Short,
        required: true,
        minLength: 1,
        maxLength: 5,
        placeholder: "Ex: 60",
        value: String(draft.durationMinutes || 60),
      }),
    ),
  );

  return interaction.showModal(modal);
}

function showWinnersModal(interaction, draft) {
  const modal = new ModalBuilder()
    .setCustomId(`${SORTEIO_PREFIX}modal:winners:${interaction.user.id}`)
    .setTitle("Vencedores");

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      buildModalField({
        customId: `${SORTEIO_PREFIX}field:winners`,
        label: "Quantidade (1-25)",
        style: TextInputStyle.Short,
        required: true,
        minLength: 1,
        maxLength: 2,
        placeholder: "Ex: 1",
        value: String(draft.winnerCount || 1),
      }),
    ),
  );

  return interaction.showModal(modal);
}

function showRolesModal(interaction, draft) {
  const modal = new ModalBuilder()
    .setCustomId(`${SORTEIO_PREFIX}modal:roles:${interaction.user.id}`)
    .setTitle("Cargos obrigatorios");

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      buildModalField({
        customId: `${SORTEIO_PREFIX}field:roles`,
        label: "Cargos (@cargo ou ID)",
        style: TextInputStyle.Paragraph,
        required: false,
        maxLength: 500,
        placeholder: "Vazio = todos podem. Ex: @VIP @Membro",
        value: draft.requiredRoleIds.length
          ? draft.requiredRoleIds.map((id) => `<@&${id}>`).join(" ")
          : "",
      }),
    ),
  );

  return interaction.showModal(modal);
}

function showServerDaysModal(interaction, draft) {
  const modal = new ModalBuilder()
    .setCustomId(`${SORTEIO_PREFIX}modal:serverdays:${interaction.user.id}`)
    .setTitle("Tempo no servidor");

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      buildModalField({
        customId: `${SORTEIO_PREFIX}field:serverdays`,
        label: "Dias minimos (0 = livre)",
        style: TextInputStyle.Short,
        required: true,
        minLength: 1,
        maxLength: 4,
        placeholder: "Ex: 0",
        value: String(draft.minServerDays ?? 0),
      }),
    ),
  );

  return interaction.showModal(modal);
}

function showAccountDaysModal(interaction, draft) {
  const modal = new ModalBuilder()
    .setCustomId(`${SORTEIO_PREFIX}modal:accountdays:${interaction.user.id}`)
    .setTitle("Idade da conta");

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      buildModalField({
        customId: `${SORTEIO_PREFIX}field:accountdays`,
        label: "Dias minimos (0 = livre)",
        style: TextInputStyle.Short,
        required: true,
        minLength: 1,
        maxLength: 4,
        placeholder: "Ex: 0",
        value: String(draft.minAccountAgeDays ?? 0),
      }),
    ),
  );

  return interaction.showModal(modal);
}

function showBlacklistModal(interaction, draft) {
  const modal = new ModalBuilder()
    .setCustomId(`${SORTEIO_PREFIX}modal:blacklist:${interaction.user.id}`)
    .setTitle("Blacklist");

  modal.addComponents(
    new ActionRowBuilder().addComponents(
      buildModalField({
        customId: `${SORTEIO_PREFIX}field:blacklist`,
        label: "Usuarios bloqueados",
        style: TextInputStyle.Paragraph,
        required: false,
        maxLength: 1000,
        placeholder: "@usuario ou ID. Vazio = nenhum",
        value: draft.blacklistUserIds.length
          ? draft.blacklistUserIds.map((id) => `<@${id}>`).join(" ")
          : "",
      }),
    ),
  );

  return interaction.showModal(modal);
}

async function refreshSetupPanelMessage(interaction, draft, ownerId) {
  const payload = buildSetupPanelPayload(draft, ownerId);
  const channelId = draft.setupChannelId || interaction.channelId;
  const messageId = draft.setupMessageId;

  if (messageId && channelId) {
    try {
      const channel = await interaction.client.channels.fetch(channelId);
      if (channel?.isTextBased?.()) {
        const message = await channel.messages.fetch(messageId);
        await message.edit(payload);
        return true;
      }
    } catch (error) {
      console.warn("[sorteio] Falha ao atualizar painel de setup:", error?.message || error);
    }
  }

  return false;
}

async function handleSetupButton(interaction, action, ownerId) {
  if (interaction.user.id !== ownerId) {
    await replySorteio(
      interaction,
      buildFailurePayload("Sem permissao", "Este painel pertence a outro usuario."),
    );
    return;
  }

  const guildId = interaction.guildId;
  const draft = getDraft(guildId, ownerId);

  if (action === "basic") {
    await showBasicModal(interaction, draft);
    return;
  }
  if (action === "time") {
    await showTimeModal(interaction, draft);
    return;
  }
  if (action === "winners") {
    await showWinnersModal(interaction, draft);
    return;
  }
  if (action === "roles") {
    await showRolesModal(interaction, draft);
    return;
  }
  if (action === "serverdays") {
    await showServerDaysModal(interaction, draft);
    return;
  }
  if (action === "accountdays") {
    await showAccountDaysModal(interaction, draft);
    return;
  }
  if (action === "blacklist") {
    await showBlacklistModal(interaction, draft);
    return;
  }
  if (action === "history") {
    const items = await sorteioDb.getSorteioHistory(guildId, 10);
    await replySorteio(interaction, buildHistoryPayload(items));
    return;
  }
  if (action === "refresh") {
    await interaction.update(buildSetupPanelPayload(getDraft(guildId, ownerId), ownerId));
    return;
  }
  if (action === "cancel") {
    clearDraft(guildId, ownerId);
    await replySorteio(interaction, buildSuccessPayload("Cancelado", "Rascunho do sorteio descartado."));
    return;
  }
  if (action === "send") {
    await publishSorteio(interaction);
  }
}

async function handleEnterSorteio(interaction, sorteioId) {
  const sorteio = await sorteioDb.getSorteioById(sorteioId);
  if (!sorteio) {
    await replySorteio(interaction, buildFailurePayload("Sorteio invalido", "Este sorteio nao existe mais."));
    return;
  }

  const error = await validateEntryEligibility(interaction, sorteio);
  if (error) {
    await replySorteio(interaction, buildFailurePayload("Nao foi possivel entrar", error));
    return;
  }

  const result = await sorteioDb.addEntry({
    sorteioId: sorteio.id,
    guildId: interaction.guildId,
    userId: interaction.user.id,
  });

  if (result?.duplicate) {
    await replySorteio(
      interaction,
      buildFailurePayload("Ja participando", "Voce ja esta inscrito neste sorteio."),
    );
    return;
  }

  const entryCount = await sorteioDb.getEntryCount(sorteio.id);
  await updateSorteioMessage(interaction.client, sorteio);

  await replySorteio(
    interaction,
    buildSuccessPayload(
      "Inscricao confirmada",
      `Voce entrou no sorteio **${sorteio.title}**.\nTotal de participantes: **${entryCount}**.`,
    ),
  );
}

async function handleLeaveSorteio(interaction, sorteioId) {
  const sorteio = await sorteioDb.getSorteioById(sorteioId);
  if (!sorteio || sorteio.status !== "active") {
    await replySorteio(interaction, buildFailurePayload("Sorteio encerrado", "Nao e possivel sair agora."));
    return;
  }

  const wasEntered = await sorteioDb.isUserEntered(sorteioId, interaction.user.id);
  if (!wasEntered) {
    await replySorteio(interaction, buildFailurePayload("Nao participando", "Voce nao esta neste sorteio."));
    return;
  }

  await sorteioDb.removeEntry(sorteioId, interaction.user.id);
  const entryCount = await sorteioDb.getEntryCount(sorteioId);
  await updateSorteioMessage(interaction.client, sorteio);

  await replySorteio(
    interaction,
    buildSuccessPayload(
      "Saida confirmada",
      `Voce saiu do sorteio **${sorteio.title}**.\nParticipantes restantes: **${entryCount}**.`,
    ),
  );
}

async function handleGearSorteio(interaction, sorteioId) {
  const sorteio = await sorteioDb.getSorteioById(sorteioId);
  if (!sorteio) {
    await replySorteio(interaction, buildFailurePayload("Sorteio invalido", "Este sorteio nao existe."));
    return;
  }

  const [isEntered, entryCount] = await Promise.all([
    sorteioDb.isUserEntered(sorteioId, interaction.user.id),
    sorteioDb.getEntryCount(sorteioId),
  ]);

  await replySorteio(
    interaction,
    buildGearPanelPayload(sorteio, { isEntered, entryCount }),
  );
}

async function handleParticipantsList(interaction, sorteioId, page) {
  const sorteio = await sorteioDb.getSorteioById(sorteioId);
  if (!sorteio) {
    await replySorteio(interaction, buildFailurePayload("Sorteio invalido", "Este sorteio nao existe."));
    return;
  }

  const entries = await sorteioDb.getEntries(sorteioId);
  const totalPages = Math.max(1, Math.ceil(entries.length / PARTICIPANTS_PAGE_SIZE));
  const safePage = Math.min(Math.max(0, page), totalPages - 1);

  const payload = buildParticipantsPayload(sorteio, entries, safePage);

  const onParticipantsMessage = (interaction.message?.components || []).some((row) =>
    (row.components || []).some((component) =>
      String(component.customId || component.custom_id || "").startsWith(`${SORTEIO_PREFIX}participants:`),
    ),
  );

  if (onParticipantsMessage) {
    await interaction.update(payload).catch(() => interaction.editReply(payload));
    return;
  }

  await replySorteio(interaction, payload);
}

async function handleReroll(interaction, sorteioId) {
  const sorteio = await sorteioDb.getSorteioById(sorteioId);
  if (!sorteio) {
    await replySorteio(interaction, buildFailurePayload("Sorteio invalido", "Este sorteio nao existe."));
    return;
  }

  if (!canManageSorteio(interaction, sorteio)) {
    await replySorteio(
      interaction,
      buildFailurePayload("Sem permissao", "Apenas o host ou quem tem Gerenciar Servidor pode fazer reroll."),
    );
    return;
  }

  const entries = await sorteioDb.getEntries(sorteioId);
  if (!entries.length) {
    await replySorteio(
      interaction,
      buildFailurePayload("Sem participantes", "Nao ha participantes para sortear novamente."),
    );
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const ended = await endSorteio(interaction.client, sorteio, { reroll: true });

  await interaction.editReply(
    buildSuccessPayload(
      "Reroll concluido",
      `Novos ganhadores definidos para **${ended.title}**:\n${(ended.winner_user_ids || []).map((id) => `<@${id}>`).join(", ") || "Nenhum"}`,
    ),
  );
}

async function handleSorteioModalSubmit(interaction) {
  const customId = interaction.customId;
  const parts = customId.split(":");
  const modalType = parts[2];
  const ownerId = parts[3];

  if (interaction.user.id !== ownerId) {
    await replySorteio(
      interaction,
      buildFailurePayload("Sem permissao", "Este modal pertence a outro usuario."),
    );
    return;
  }

  const guildId = interaction.guildId;
  let draft = getDraft(guildId, ownerId);

  if (modalType === "basic") {
    const title = interaction.fields.getTextInputValue(`${SORTEIO_PREFIX}field:title`).trim();
    const description = interaction.fields
      .getTextInputValue(`${SORTEIO_PREFIX}field:description`)
      .trim();
    if (title.length < MIN_TITLE_LENGTH) {
      await replySorteio(
        interaction,
        buildFailurePayload("Titulo invalido", `Use pelo menos ${MIN_TITLE_LENGTH} caracteres.`),
      );
      return;
    }
    if (description.length < 3) {
      await replySorteio(
        interaction,
        buildFailurePayload("Descricao invalida", "Descreva o premio com pelo menos 3 caracteres."),
      );
      return;
    }
    draft = saveDraft(guildId, ownerId, { title, description });
  } else if (modalType === "time") {
    const minutes = Number.parseInt(
      interaction.fields.getTextInputValue(`${SORTEIO_PREFIX}field:minutes`),
      10,
    );
    if (!Number.isFinite(minutes) || minutes < MIN_DURATION_MINUTES || minutes > MAX_DURATION_MINUTES) {
      await replySorteio(
        interaction,
        buildFailurePayload(
          "Tempo invalido",
          `Informe entre ${MIN_DURATION_MINUTES} e ${MAX_DURATION_MINUTES} minutos.`,
        ),
      );
      return;
    }
    draft = saveDraft(guildId, ownerId, { durationMinutes: minutes });
  } else if (modalType === "winners") {
    const count = Number.parseInt(
      interaction.fields.getTextInputValue(`${SORTEIO_PREFIX}field:winners`),
      10,
    );
    if (!Number.isFinite(count) || count < 1 || count > MAX_WINNERS) {
      await replySorteio(
        interaction,
        buildFailurePayload("Valor invalido", `Informe entre 1 e ${MAX_WINNERS} vencedores.`),
      );
      return;
    }
    draft = saveDraft(guildId, ownerId, { winnerCount: count });
  } else if (modalType === "roles") {
    const raw = interaction.fields.getTextInputValue(`${SORTEIO_PREFIX}field:roles`);
    const requiredRoleIds = parseRoleIdList(raw);
    draft = saveDraft(guildId, ownerId, { requiredRoleIds });
  } else if (modalType === "serverdays") {
    const days = Number.parseInt(
      interaction.fields.getTextInputValue(`${SORTEIO_PREFIX}field:serverdays`),
      10,
    );
    if (!Number.isFinite(days) || days < 0 || days > 3650) {
      await replySorteio(interaction, buildFailurePayload("Valor invalido", "Informe dias entre 0 e 3650."));
      return;
    }
    draft = saveDraft(guildId, ownerId, { minServerDays: days });
  } else if (modalType === "accountdays") {
    const days = Number.parseInt(
      interaction.fields.getTextInputValue(`${SORTEIO_PREFIX}field:accountdays`),
      10,
    );
    if (!Number.isFinite(days) || days < 0 || days > 3650) {
      await replySorteio(interaction, buildFailurePayload("Valor invalido", "Informe dias entre 0 e 3650."));
      return;
    }
    draft = saveDraft(guildId, ownerId, { minAccountAgeDays: days });
  } else if (modalType === "blacklist") {
    const raw = interaction.fields.getTextInputValue(`${SORTEIO_PREFIX}field:blacklist`);
    const blacklistUserIds = parseIdList(raw);
    draft = saveDraft(guildId, ownerId, { blacklistUserIds });
  }

  const updated = await refreshSetupPanelMessage(interaction, draft, ownerId);
  if (updated) {
    await replySorteio(
      interaction,
      buildSuccessPayload("Configuracao salva", "Painel atualizado com as novas definicoes."),
    );
    return;
  }

  await replySorteio(interaction, buildSetupPanelPayload(draft, ownerId));
}

function parseSorteioButton(customId) {
  if (!customId?.startsWith(SORTEIO_PREFIX)) return null;
  const parts = customId.slice(SORTEIO_PREFIX.length).split(":");

  if (parts[0] === "btn" && parts.length === 3) {
    return { type: "setup", action: parts[1], ownerId: parts[2] };
  }
  if (parts[0] === "enter" && parts.length === 2) {
    return { type: "enter", sorteioId: Number(parts[1]) };
  }
  if (parts[0] === "gear" && parts.length === 2) {
    return { type: "gear", sorteioId: Number(parts[1]) };
  }
  if (parts[0] === "leave" && parts.length === 2) {
    return { type: "leave", sorteioId: Number(parts[1]) };
  }
  if (parts[0] === "participants" && parts.length === 3) {
    return { type: "participants", sorteioId: Number(parts[1]), page: Number(parts[2]) };
  }
  if (parts[0] === "reroll" && parts.length === 2) {
    return { type: "reroll", sorteioId: Number(parts[1]) };
  }
  return null;
}

function isSorteioButtonInteraction(interaction) {
  return interaction.isButton?.() && interaction.customId?.startsWith(SORTEIO_PREFIX);
}

function isSorteioModalSubmit(interaction) {
  return interaction.isModalSubmit?.() && interaction.customId?.startsWith(`${SORTEIO_PREFIX}modal:`);
}

async function handleSorteioButtonInteraction(interaction) {
  const parsed = parseSorteioButton(interaction.customId);
  if (!parsed) return;

  if (parsed.type === "setup") {
    await handleSetupButton(interaction, parsed.action, parsed.ownerId);
    return;
  }
  if (parsed.type === "enter") {
    await handleEnterSorteio(interaction, parsed.sorteioId);
    return;
  }
  if (parsed.type === "gear") {
    await handleGearSorteio(interaction, parsed.sorteioId);
    return;
  }
  if (parsed.type === "leave") {
    await handleLeaveSorteio(interaction, parsed.sorteioId);
    return;
  }
  if (parsed.type === "participants") {
    await handleParticipantsList(interaction, parsed.sorteioId, parsed.page);
    return;
  }
  if (parsed.type === "reroll") {
    await handleReroll(interaction, parsed.sorteioId);
  }
}

async function executeSorteioCommand(interaction) {
  if (!interaction.guild) {
    await interaction.reply({
      content: "Este comando so pode ser usado em servidores.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (!canManageSorteio(interaction)) {
    await interaction.reply(
      buildFailurePayload(
        "Sem permissao",
        "Voce precisa da permissao **Gerenciar Servidor** para criar sorteios.",
      ),
    );
    return;
  }

  const draft = getDraft(interaction.guildId, interaction.user.id);
  const payload = buildSetupPanelPayload(draft, interaction.user.id);

  const message = await interaction.reply({
    ...payload,
    fetchReply: true,
  });

  saveDraft(interaction.guildId, interaction.user.id, {
    setupChannelId: interaction.channelId,
    setupMessageId: message.id,
  });
}

function startSorteioWorker(client) {
  const tick = async () => {
    try {
      const due = await sorteioDb.getActiveSorteiosToEnd();
      for (const sorteio of due) {
        await endSorteio(client, sorteio).catch((error) => {
          console.error("[sorteio-worker]", sorteio.id, error);
        });
      }
    } catch (error) {
      console.error("[sorteio-worker]", error);
    }
  };

  tick();
  return setInterval(tick, 15_000);
}

module.exports = {
  executeSorteioCommand,
  handleSorteioButtonInteraction,
  handleSorteioModalSubmit,
  isSorteioButtonInteraction,
  isSorteioModalSubmit,
  startSorteioWorker,
};
