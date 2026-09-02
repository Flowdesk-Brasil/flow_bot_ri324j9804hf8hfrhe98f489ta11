const {
  ActionRowBuilder,
  MessageFlags,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");
const { CUSTOM_IDS } = require("../constants/customIds");
const {
  buildLogPayload,
  buildPublishedSuggestionPayload,
  buildSuggestionVoteDetailsPayload,
  resolveMemberAvatarUrl,
  withEphemeralComponentsV2,
} = require("../utils/componentFactory");
const {
  createGuildSuggestion,
  getGuildSuggestionById,
  getGuildSuggestionsRuntime,
  getGuildSuggestionVotes,
  updateGuildSuggestionMessageIds,
  upsertGuildSuggestionVote,
} = require("./supabaseService");

const MIN_TITLE_LENGTH = 5;
const MIN_BODY_LENGTH = 10;
const SUGGESTION_VOTE_PREFIX = "suggestion:vote:";

function buildSuggestionFailurePayload(title, message) {
  return withEphemeralComponentsV2({
    components: [
      {
        type: 17,
        accent_color: 0xe74c3c,
        components: [
          {
            type: 10,
            content: [`### ${title}`, message].join("\n\n"),
          },
        ],
      },
    ],
  });
}

function buildSuggestionSuccessPayload(title, message) {
  return withEphemeralComponentsV2({
    components: [
      {
        type: 17,
        accent_color: 0x2ecc71,
        components: [
          {
            type: 10,
            content: [`### ${title}`, message].join("\n\n"),
          },
        ],
      },
    ],
  });
}

function parseSuggestionVoteCustomId(customId) {
  if (!customId || !customId.startsWith(SUGGESTION_VOTE_PREFIX)) {
    return null;
  }

  const parts = customId.split(":");
  if (parts.length !== 4) return null;

  const voteType = parts[2];
  const suggestionId = Number(parts[3]);

  if (!["yes", "no", "details"].includes(voteType)) return null;
  if (!Number.isFinite(suggestionId) || suggestionId <= 0) return null;

  return { voteType, suggestionId };
}

function buildVoteLabels(yesVotes, noVotes) {
  const totalVotes = yesVotes + noVotes;
  const yesPct = totalVotes ? ((yesVotes / totalVotes) * 100).toFixed(2) : "0.00";
  const noPct = totalVotes ? ((noVotes / totalVotes) * 100).toFixed(2) : "0.00";

  return {
    yes: `✅ ${yesVotes} ${yesVotes === 1 ? "voto" : "votos"} | (${yesPct}%)`,
    no: `❌ ${noVotes} ${noVotes === 1 ? "voto" : "votos"} | (${noPct}%)`,
    details: "?",
  };
}

async function replySuggestionMessage(interaction, payload) {
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp(payload).catch(() => null);
    return;
  }
  await interaction.reply(payload);
}

async function showSuggestionModal(interaction) {
  const guildId = interaction.guildId;
  if (!guildId) return;

  const runtime = await getGuildSuggestionsRuntime(guildId);
  const settings = runtime?.settings;

  if (!runtime?.licenseUsable || !settings?.enabled) {
    await replySuggestionMessage(
      interaction,
      buildSuggestionFailurePayload(
        "Modulo indisponivel",
        "O sistema de sugestoes esta indisponivel neste servidor no momento.",
      ),
    );
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(CUSTOM_IDS.submitSuggestionModal)
    .setTitle("Enviar sugestao");

  const titleInput = new TextInputBuilder()
    .setCustomId(CUSTOM_IDS.suggestionTitleInput)
    .setLabel("Titulo da sugestao")
    .setPlaceholder("Descreva em poucas palavras o tema da sugestao.")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMinLength(MIN_TITLE_LENGTH)
    .setMaxLength(100);

  const bodyInput = new TextInputBuilder()
    .setCustomId(CUSTOM_IDS.suggestionBodyInput)
    .setLabel("Descricao da sugestao")
    .setPlaceholder("Explique sua sugestao com detalhes para a equipe avaliar.")
    .setStyle(TextInputStyle.Paragraph)
    .setRequired(true)
    .setMinLength(MIN_BODY_LENGTH)
    .setMaxLength(2000);

  modal.addComponents(
    new ActionRowBuilder().addComponents(titleInput),
    new ActionRowBuilder().addComponents(bodyInput),
  );

  await interaction.showModal(modal);
}

async function resolvePublishChannel(guild, channelId) {
  if (!guild || !channelId) return null;

  const channel =
    guild.channels.cache.get(channelId) ||
    (await guild.channels.fetch(channelId).catch(() => null));

  if (!channel || !channel.isTextBased()) return null;
  return channel;
}

async function resolveLogsChannel(guild, channelId) {
  return resolvePublishChannel(guild, channelId);
}

async function sendSuggestionSubmissionLog({ guild, member, suggestion, settings }) {
  const channelId = settings?.logs_channel_id;
  if (!channelId) return;

  const channel = await resolveLogsChannel(guild, channelId);
  if (!channel) return;

  const payload = buildLogPayload({
    accentColor: 0x00bcd4,
    title: "Nova sugestao enviada",
    lines: [
      `**Usuario:** ${member} (\`${member.id}\`)`,
      `**Titulo:** ${suggestion.title}`,
      `**ID:** \`${suggestion.id}\``,
      `**Horario:** <t:${Math.floor(Date.now() / 1000)}:F>`,
    ],
  });

  await channel.send(payload).catch((error) => {
    console.error("[suggestion-log-submission]", error);
  });
}

async function sendSuggestionVoteLog({ guild, member, suggestion, settings, voteType, action }) {
  const logsChannelId = settings?.logs_channel_id;
  if (!logsChannelId) return;

  const channel = await resolveLogsChannel(guild, logsChannelId);
  if (!channel) return;

  const voteLabel = voteType === "yes" ? "A favor" : "Contra";
  const actionLabel =
    action === "change" ? "alterou o voto para" : "votou";

  const payload = buildLogPayload({
    accentColor: voteType === "yes" ? 0x2ecc71 : 0xe74c3c,
    title: "Voto em sugestao",
    lines: [
      `**Usuario:** ${member} (\`${member.id}\`)`,
      `**Sugestao:** ${suggestion.title} (\`#${suggestion.id}\`)`,
      `**Acao:** ${actionLabel} **${voteLabel}**`,
      `**Horario:** <t:${Math.floor(Date.now() / 1000)}:F>`,
    ],
  });

  await channel.send(payload).catch((error) => {
    console.error("[suggestion-log-vote]", error);
  });
}

async function handleSuggestionModalSubmit(interaction) {
  const guildId = interaction.guildId;
  if (!guildId) return;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const runtime = await getGuildSuggestionsRuntime(guildId);
  const settings = runtime?.settings;

  if (!runtime?.licenseUsable || !settings?.enabled) {
    await interaction.editReply(
      buildSuggestionFailurePayload(
        "Modulo indisponivel",
        "O sistema de sugestoes esta indisponivel neste servidor no momento.",
      ),
    );
    return;
  }

  const title = String(
    interaction.fields.getTextInputValue(CUSTOM_IDS.suggestionTitleInput) || "",
  ).trim();
  const body = String(
    interaction.fields.getTextInputValue(CUSTOM_IDS.suggestionBodyInput) || "",
  ).trim();

  if (title.length < MIN_TITLE_LENGTH) {
    await interaction.editReply(
      buildSuggestionFailurePayload(
        "Titulo invalido",
        `O titulo precisa ter pelo menos ${MIN_TITLE_LENGTH} caracteres.`,
      ),
    );
    return;
  }

  if (body.length < MIN_BODY_LENGTH) {
    await interaction.editReply(
      buildSuggestionFailurePayload(
        "Descricao invalida",
        `A descricao precisa ter pelo menos ${MIN_BODY_LENGTH} caracteres.`,
      ),
    );
    return;
  }

  const publishChannelId = settings.publish_channel_id;
  const publishChannel = await resolvePublishChannel(interaction.guild, publishChannelId);

  if (!publishChannel) {
    await interaction.editReply(
      buildSuggestionFailurePayload(
        "Canal indisponivel",
        "O canal de publicacao de sugestoes nao esta configurado ou nao esta acessivel.",
      ),
    );
    return;
  }

  let suggestion;
  try {
    suggestion = await createGuildSuggestion({
      guildId,
      authorUserId: interaction.user.id,
      title,
      body,
      publishChannelId,
    });
  } catch (error) {
    console.error("[suggestion-create]", error);
    await interaction.editReply(
      buildSuggestionFailurePayload(
        "Erro ao salvar",
        "Nao foi possivel registrar sua sugestao. Tente novamente em instantes.",
      ),
    );
    return;
  }

  const authorMention = `<@${interaction.user.id}>`;
  const authorAvatarUrl = resolveMemberAvatarUrl(
    interaction.member || interaction.user,
  );
  const voteLabels = buildVoteLabels(0, 0);
  const payload = buildPublishedSuggestionPayload({
    suggestion,
    settings,
    authorMention,
    authorAvatarUrl,
    voteLabels,
  });

  let publishedMessage;
  try {
    publishedMessage = await publishChannel.send(payload);
  } catch (error) {
    console.error("[suggestion-publish]", error);
    await interaction.editReply(
      buildSuggestionFailurePayload(
        "Erro ao publicar",
        "Sua sugestao foi registrada, mas nao foi possivel publica-la no canal.",
      ),
    );
    return;
  }

  let thread = null;
  const threadName = `Debater sugestao #${suggestion.id}`.slice(0, 100);

  try {
    thread = await publishedMessage.startThread({
      name: threadName,
      autoArchiveDuration: 1440,
      reason: "Discussao da sugestao",
    });
  } catch (error) {
    console.error("[suggestion-thread]", error);
  }

  try {
    await updateGuildSuggestionMessageIds(suggestion.id, {
      messageId: publishedMessage.id,
      threadId: thread?.id || null,
    });
  } catch (error) {
    console.error("[suggestion-update-ids]", error);
  }

  suggestion.message_id = publishedMessage.id;
  suggestion.thread_id = thread?.id || null;

  await sendSuggestionSubmissionLog({
    guild: interaction.guild,
    member: interaction.member || interaction.user,
    suggestion,
    settings,
  });

  await interaction.editReply(
    buildSuggestionSuccessPayload(
      "Sugestao enviada",
      `Sua sugestao foi publicada em ${publishChannel}. Obrigado pela contribuicao!`,
    ),
  );
}

async function syncPublishedSuggestionMessage(interaction, suggestion, settings) {
  if (!suggestion?.message_id || !suggestion?.publish_channel_id) return;

  const channel = await resolvePublishChannel(
    interaction.guild,
    suggestion.publish_channel_id,
  );
  if (!channel) return;

  const message = await channel.messages.fetch(suggestion.message_id).catch(() => null);
  if (!message) return;

  const yesVotes = Number(suggestion.yes_votes || 0);
  const noVotes = Number(suggestion.no_votes || 0);
  const voteLabels = buildVoteLabels(yesVotes, noVotes);

  let authorAvatarUrl = "";
  if (suggestion?.author_user_id) {
    const author = await interaction.client.users
      .fetch(suggestion.author_user_id)
      .catch(() => null);
    authorAvatarUrl = resolveMemberAvatarUrl(author);
  }

  const payload = buildPublishedSuggestionPayload({
    suggestion,
    settings,
    authorAvatarUrl,
    voteLabels,
  });

  await message.edit(payload).catch((error) => {
    console.error("[suggestion-sync-message]", error);
  });
}

async function handleSuggestionVoteInteraction(interaction) {
  const parsed = parseSuggestionVoteCustomId(interaction.customId);
  if (!parsed || parsed.voteType === "details") return;

  const guildId = interaction.guildId;
  if (!guildId) return;

  await interaction.deferUpdate();

  const runtime = await getGuildSuggestionsRuntime(guildId);
  const settings = runtime?.settings;

  if (!runtime?.licenseUsable || !settings?.enabled) {
    return;
  }

  const suggestion = await getGuildSuggestionById(parsed.suggestionId);
  if (!suggestion || suggestion.guild_id !== guildId) {
    return;
  }

  if (suggestion.status !== "open") {
    return;
  }

  let voteResult;
  try {
    voteResult = await upsertGuildSuggestionVote({
      suggestionId: parsed.suggestionId,
      guildId,
      userId: interaction.user.id,
      vote: parsed.voteType,
    });
  } catch (error) {
    console.error("[suggestion-vote]", error);
    return;
  }

  suggestion.yes_votes = voteResult.counts.yes;
  suggestion.no_votes = voteResult.counts.no;

  await syncPublishedSuggestionMessage(interaction, suggestion, settings);

  await sendSuggestionVoteLog({
    guild: interaction.guild,
    member: interaction.member || interaction.user,
    suggestion,
    settings,
    voteType: parsed.voteType,
    action: voteResult.action,
  });
}

async function handleSuggestionDetailsInteraction(interaction) {
  const parsed = parseSuggestionVoteCustomId(interaction.customId);
  if (!parsed || parsed.voteType !== "details") return;

  const guildId = interaction.guildId;
  if (!guildId) return;

  const runtime = await getGuildSuggestionsRuntime(guildId);
  const settings = runtime?.settings;

  if (!runtime?.licenseUsable || !settings?.enabled) {
    await replySuggestionMessage(
      interaction,
      buildSuggestionFailurePayload(
        "Modulo indisponivel",
        "O sistema de sugestoes esta indisponivel neste servidor no momento.",
      ),
    );
    return;
  }

  const suggestion = await getGuildSuggestionById(parsed.suggestionId);
  if (!suggestion || suggestion.guild_id !== guildId) {
    await replySuggestionMessage(
      interaction,
      buildSuggestionFailurePayload(
        "Sugestao nao encontrada",
        "Esta sugestao nao existe ou nao pertence a este servidor.",
      ),
    );
    return;
  }

  const votes = await getGuildSuggestionVotes(parsed.suggestionId);
  const yesVoters = votes.filter((v) => v.vote === "yes").map((v) => v.user_id);
  const noVoters = votes.filter((v) => v.vote === "no").map((v) => v.user_id);

  const payload = buildSuggestionVoteDetailsPayload({
    suggestion,
    yesVoters,
    noVoters,
    settings,
  });

  await replySuggestionMessage(interaction, payload);
}

function isSuggestionButtonInteraction(interaction) {
  return (
    interaction.isButton?.() &&
    interaction.customId === CUSTOM_IDS.startSuggestion
  );
}

function isSuggestionModalSubmit(interaction) {
  return (
    interaction.isModalSubmit?.() &&
    interaction.customId === CUSTOM_IDS.submitSuggestionModal
  );
}

function isSuggestionVoteInteraction(interaction) {
  if (!interaction.isButton?.()) return false;
  const parsed = parseSuggestionVoteCustomId(interaction.customId);
  return Boolean(parsed && (parsed.voteType === "yes" || parsed.voteType === "no"));
}

function isSuggestionDetailsInteraction(interaction) {
  if (!interaction.isButton?.()) return false;
  const parsed = parseSuggestionVoteCustomId(interaction.customId);
  return Boolean(parsed && parsed.voteType === "details");
}

module.exports = {
  showSuggestionModal,
  handleSuggestionModalSubmit,
  handleSuggestionVoteInteraction,
  handleSuggestionDetailsInteraction,
  isSuggestionButtonInteraction,
  isSuggestionModalSubmit,
  isSuggestionVoteInteraction,
  isSuggestionDetailsInteraction,
  sendSuggestionSubmissionLog,
  sendSuggestionVoteLog,
};
