const { LabelBuilder, StringSelectMenuBuilder } = require("@discordjs/builders");
const { MessageFlags, ModalBuilder } = require("discord.js");
const { CUSTOM_IDS } = require("../constants/customIds");
const {
  buildBatePontoLogPayload,
  buildBatePontoResultPayload,
} = require("../utils/componentFactory");
const {
  createGuildBatePontoEvent,
  createGuildBatePontoSession,
  finishGuildBatePontoSession,
  getActiveGuildBatePontoSession,
  getGuildBatePontoHourBank,
  getGuildBatePontoRuntime,
  updateGuildBatePontoSession,
  upsertGuildBatePontoHourBank,
} = require("./supabaseService");

const BATE_PONTO_MODAL_OPTIONS = {
  start: { label: "Iniciar Ponto", value: "start", description: "Comecar um novo registro de expediente." },
  pause: { label: "Pausar", value: "pause", description: "Registrar uma pausa no expediente atual." },
  resume: { label: "Retomar Ponto", value: "resume", description: "Retomar o expediente apos a pausa." },
  finish: { label: "Finalizar Ponto", value: "finish", description: "Encerrar o registro de expediente atual." },
};

function elapsedSecondsSince(isoTimestamp) {
  if (!isoTimestamp) {
    return 0;
  }

  const then = new Date(isoTimestamp).getTime();
  if (!Number.isFinite(then)) {
    return 0;
  }

  return Math.max(0, Math.floor((Date.now() - then) / 1000));
}

function formatDurationLabel(totalSeconds) {
  const seconds = Math.max(0, Number(totalSeconds) || 0);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  const parts = [];

  if (hours) parts.push(`${hours}h`);
  if (minutes) parts.push(`${minutes}m`);
  if (secs || !parts.length) parts.push(`${secs}s`);

  return parts.join(" ");
}

function memberHasBatePontoAccess(member, settings) {
  const allowedRoleIds = Array.isArray(settings?.allowed_role_ids)
    ? settings.allowed_role_ids.filter(Boolean)
    : [];

  if (!allowedRoleIds.length) {
    return true;
  }

  if (!member?.roles?.cache) {
    return false;
  }

  return allowedRoleIds.some((roleId) => member.roles.cache.has(String(roleId)));
}

function memberMeetsVoiceRequirement(member, settings) {
  if (!settings?.require_voice_channel) {
    return true;
  }

  const voiceChannelId = member?.voice?.channelId;
  if (!voiceChannelId) {
    return false;
  }

  const requiredVoiceChannelIds = Array.isArray(settings?.required_voice_channel_ids)
    ? settings.required_voice_channel_ids.filter(Boolean)
    : [];

  if (!requiredVoiceChannelIds.length) {
    return true;
  }

  return requiredVoiceChannelIds.includes(String(voiceChannelId));
}

function buildVoiceRequirementMessage(settings) {
  const requiredVoiceChannelIds = Array.isArray(settings?.required_voice_channel_ids)
    ? settings.required_voice_channel_ids.filter(Boolean)
    : [];

  if (!requiredVoiceChannelIds.length) {
    return "Voce precisa estar em uma call do servidor para iniciar o ponto.";
  }

  return "Voce precisa estar em uma das calls autorizadas para iniciar o ponto.";
}

function buildModalOptionsForSession(session) {
  if (!session) {
    return [BATE_PONTO_MODAL_OPTIONS.start];
  }

  if (session.status === "active") {
    return [BATE_PONTO_MODAL_OPTIONS.pause, BATE_PONTO_MODAL_OPTIONS.finish];
  }

  if (session.status === "on_break") {
    return [BATE_PONTO_MODAL_OPTIONS.resume, BATE_PONTO_MODAL_OPTIONS.finish];
  }

  return [];
}

async function replyBatePontoMessage(interaction, payload) {
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp(payload).catch(() => null);
    return;
  }

  await interaction.reply(payload);
}

async function resolveLogsChannel(guild, channelId) {
  if (!guild || !channelId) {
    return null;
  }

  const channel =
    guild.channels.cache.get(channelId) ||
    (await guild.channels.fetch(channelId).catch(() => null));

  if (!channel || !channel.isTextBased()) {
    return null;
  }

  return channel;
}

async function sendBatePontoLog({
  guild,
  member,
  action,
  session,
  settings,
  hourBankBalance,
}) {
  const channelId = settings?.logs_channel_id;
  if (!channelId) {
    return;
  }

  const channel = await resolveLogsChannel(guild, channelId);
  if (!channel) {
    return;
  }

  const payload = buildBatePontoLogPayload({
    action,
    member,
    session,
    settings,
    hourBankBalance,
  });

  await channel.send(payload).catch((error) => {
    console.error("[bate-ponto-log]", error);
  });
}

async function showBatePontoModal(interaction) {
  const guildId = interaction.guildId;
  if (!guildId) {
    return;
  }

  const runtime = await getGuildBatePontoRuntime(guildId);
  const settings = runtime?.settings;

  if (!runtime?.licenseUsable || !settings?.enabled) {
    await replyBatePontoMessage(
      interaction,
      buildBatePontoResultPayload({
        title: "Modulo indisponivel",
        message: "O sistema de bate ponto esta indisponivel neste servidor no momento.",
        tone: "error",
      }),
    );
    return;
  }

  const member = interaction.member;
  if (!memberHasBatePontoAccess(member, settings)) {
    await replyBatePontoMessage(
      interaction,
      buildBatePontoResultPayload({
        title: "Permissao negada",
        message: "Voce nao possui um cargo autorizado para bater ponto neste servidor.",
        tone: "error",
      }),
    );
    return;
  }

  const session = await getActiveGuildBatePontoSession(guildId, interaction.user.id);
  const options = buildModalOptionsForSession(session);

  if (!options.length) {
    await replyBatePontoMessage(
      interaction,
      buildBatePontoResultPayload({
        title: "Acao indisponivel",
        message: "Nao ha acoes disponiveis para o seu registro de ponto no momento.",
        tone: "error",
      }),
    );
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(CUSTOM_IDS.submitBatePontoModal)
    .setTitle("Bater Ponto")
    .addLabelComponents(
      new LabelBuilder()
        .setLabel("Acao")
        .setDescription("Escolha o que deseja registrar no seu expediente.")
        .setStringSelectMenuComponent(
          new StringSelectMenuBuilder()
            .setCustomId(CUSTOM_IDS.batePontoActionSelect)
            .setPlaceholder("Selecione uma acao")
            .setMinValues(1)
            .setMaxValues(1)
            .addOptions(options),
        ),
    );

  await interaction.showModal(modal);
}

async function handleStartAction({ guildId, userId, settings, member, guild }) {
  if (!memberMeetsVoiceRequirement(member, settings)) {
    return {
      ok: false,
      payload: buildBatePontoResultPayload({
        title: "Call obrigatoria",
        message: buildVoiceRequirementMessage(settings),
        tone: "error",
      }),
    };
  }

  const existingSession = await getActiveGuildBatePontoSession(guildId, userId);
  if (existingSession) {
    return {
      ok: false,
      payload: buildBatePontoResultPayload({
        title: "Ponto ja iniciado",
        message: "Voce ja possui um registro de ponto em andamento.",
        tone: "error",
      }),
    };
  }

  const session = await createGuildBatePontoSession({ guildId, userId });
  if (!session) {
    return {
      ok: false,
      payload: buildBatePontoResultPayload({
        title: "Erro ao salvar",
        message: "Nao foi possivel iniciar seu ponto. Tente novamente em instantes.",
        tone: "error",
      }),
    };
  }

  await createGuildBatePontoEvent({
    guildId,
    userId,
    sessionId: session.id,
    action: "start",
  });

  await sendBatePontoLog({
    guild,
    member,
    action: "start",
    session,
    settings,
  });

  return {
    ok: true,
    payload: buildBatePontoResultPayload({
      title: "Ponto iniciado",
      message: "Seu expediente foi iniciado com sucesso. Bom trabalho!",
      tone: "success",
    }),
  };
}

async function handlePauseAction({ guildId, userId, settings, member, guild, session }) {
  if (!session || session.status !== "active") {
    return {
      ok: false,
      payload: buildBatePontoResultPayload({
        title: "Ponto indisponivel",
        message: "Voce precisa ter um ponto ativo para registrar uma pausa.",
        tone: "error",
      }),
    };
  }

  const elapsed = elapsedSecondsSince(session.last_action_at);
  const workedSeconds = Number(session.worked_seconds || 0) + elapsed;
  const now = new Date().toISOString();

  const updatedSession = await updateGuildBatePontoSession(session.id, {
    status: "on_break",
    lastActionAt: now,
    workedSeconds,
    breakStartedAt: now,
  });

  if (!updatedSession) {
    return {
      ok: false,
      payload: buildBatePontoResultPayload({
        title: "Erro ao salvar",
        message: "Nao foi possivel registrar a pausa. Tente novamente em instantes.",
        tone: "error",
      }),
    };
  }

  await createGuildBatePontoEvent({
    guildId,
    userId,
    sessionId: updatedSession.id,
    action: "pause",
    workedSeconds: updatedSession.worked_seconds,
    breakSeconds: updatedSession.break_seconds,
  });

  await sendBatePontoLog({
    guild,
    member,
    action: "pause",
    session: updatedSession,
    settings,
  });

  return {
    ok: true,
    payload: buildBatePontoResultPayload({
      title: "Pausa registrada",
      message: "Sua pausa foi registrada. Retome o ponto quando voltar ao trabalho.",
      tone: "success",
    }),
  };
}

async function handleResumeAction({ guildId, userId, settings, member, guild, session }) {
  if (!session || session.status !== "on_break") {
    return {
      ok: false,
      payload: buildBatePontoResultPayload({
        title: "Pausa indisponivel",
        message: "Voce precisa estar em pausa para retomar o ponto.",
        tone: "error",
      }),
    };
  }

  const elapsed = elapsedSecondsSince(session.break_started_at || session.last_action_at);
  const breakSeconds = Number(session.break_seconds || 0) + elapsed;
  const now = new Date().toISOString();

  const updatedSession = await updateGuildBatePontoSession(session.id, {
    status: "active",
    lastActionAt: now,
    breakSeconds,
    breakStartedAt: null,
  });

  if (!updatedSession) {
    return {
      ok: false,
      payload: buildBatePontoResultPayload({
        title: "Erro ao salvar",
        message: "Nao foi possivel retomar o ponto. Tente novamente em instantes.",
        tone: "error",
      }),
    };
  }

  await createGuildBatePontoEvent({
    guildId,
    userId,
    sessionId: updatedSession.id,
    action: "resume",
    workedSeconds: updatedSession.worked_seconds,
    breakSeconds: updatedSession.break_seconds,
  });

  await sendBatePontoLog({
    guild,
    member,
    action: "resume",
    session: updatedSession,
    settings,
  });

  return {
    ok: true,
    payload: buildBatePontoResultPayload({
      title: "Ponto retomado",
      message: "Seu expediente foi retomado com sucesso.",
      tone: "success",
    }),
  };
}

async function handleFinishAction({ guildId, userId, settings, member, guild, session }) {
  if (!session || !["active", "on_break"].includes(session.status)) {
    return {
      ok: false,
      payload: buildBatePontoResultPayload({
        title: "Ponto indisponivel",
        message: "Voce nao possui um registro de ponto em andamento para finalizar.",
        tone: "error",
      }),
    };
  }

  let workedSeconds = Number(session.worked_seconds || 0);
  let breakSeconds = Number(session.break_seconds || 0);

  if (session.status === "active") {
    workedSeconds += elapsedSecondsSince(session.last_action_at);
  } else {
    breakSeconds += elapsedSecondsSince(session.break_started_at || session.last_action_at);
  }

  let hourBankBalance = null;
  let hourBankDeltaSeconds = 0;

  if (settings?.hour_bank_enabled) {
    const targetSeconds = Number(settings.daily_target_minutes || 480) * 60;
    hourBankDeltaSeconds = workedSeconds - targetSeconds;
    const existingBank = await getGuildBatePontoHourBank(guildId, userId);
    const nextBalance = Number(existingBank?.balance_seconds || 0) + hourBankDeltaSeconds;
    const updatedBank = await upsertGuildBatePontoHourBank({
      guildId,
      userId,
      balanceSeconds: nextBalance,
    });
    hourBankBalance = updatedBank?.balance_seconds ?? nextBalance;
  }

  const finishedSession = await finishGuildBatePontoSession(session.id, {
    workedSeconds,
    breakSeconds,
  });

  if (!finishedSession) {
    return {
      ok: false,
      payload: buildBatePontoResultPayload({
        title: "Erro ao salvar",
        message: "Nao foi possivel finalizar seu ponto. Tente novamente em instantes.",
        tone: "error",
      }),
    };
  }

  await createGuildBatePontoEvent({
    guildId,
    userId,
    sessionId: finishedSession.id,
    action: "finish",
    workedSeconds,
    breakSeconds,
    hourBankDeltaSeconds,
  });

  await sendBatePontoLog({
    guild,
    member,
    action: "finish",
    session: finishedSession,
    settings,
    hourBankBalance,
  });

  const messageLines = [
    `Tempo trabalhado: **${formatDurationLabel(workedSeconds)}**`,
  ];

  if (breakSeconds > 0) {
    messageLines.push(`Tempo em pausa: **${formatDurationLabel(breakSeconds)}**`);
  }

  if (hourBankBalance !== null) {
    messageLines.push(`Banco de horas: **${formatDurationLabel(hourBankBalance)}**`);
  }

  return {
    ok: true,
    payload: buildBatePontoResultPayload({
      title: "Ponto finalizado",
      message: messageLines.join("\n"),
      tone: "success",
    }),
  };
}

async function handleBatePontoModalSubmit(interaction) {
  const guildId = interaction.guildId;
  if (!guildId) {
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const runtime = await getGuildBatePontoRuntime(guildId);
  const settings = runtime?.settings;

  if (!runtime?.licenseUsable || !settings?.enabled) {
    await interaction.editReply(
      buildBatePontoResultPayload({
        title: "Modulo indisponivel",
        message: "O sistema de bate ponto esta indisponivel neste servidor no momento.",
        tone: "error",
      }),
    );
    return;
  }

  const member = interaction.member;
  if (!memberHasBatePontoAccess(member, settings)) {
    await interaction.editReply(
      buildBatePontoResultPayload({
        title: "Permissao negada",
        message: "Voce nao possui um cargo autorizado para bater ponto neste servidor.",
        tone: "error",
      }),
    );
    return;
  }

  const selectedValues = interaction.fields.getStringSelectValues(
    CUSTOM_IDS.batePontoActionSelect,
  );
  const action = selectedValues?.[0];

  if (!action) {
    await interaction.editReply(
      buildBatePontoResultPayload({
        title: "Acao invalida",
        message: "Selecione uma acao valida para registrar seu ponto.",
        tone: "error",
      }),
    );
    return;
  }

  const userId = interaction.user.id;
  const session = await getActiveGuildBatePontoSession(guildId, userId);
  const context = {
    guildId,
    userId,
    settings,
    member: member || interaction.user,
    guild: interaction.guild,
    session,
  };

  let result;
  if (action === "start") {
    result = await handleStartAction(context);
  } else if (action === "pause") {
    result = await handlePauseAction(context);
  } else if (action === "resume") {
    result = await handleResumeAction(context);
  } else if (action === "finish") {
    result = await handleFinishAction(context);
  } else {
    await interaction.editReply(
      buildBatePontoResultPayload({
        title: "Acao invalida",
        message: "A acao selecionada nao e suportada.",
        tone: "error",
      }),
    );
    return;
  }

  await interaction.editReply(result.payload);
}

function isBatePontoButtonInteraction(interaction) {
  return (
    interaction.isButton?.() &&
    interaction.customId === CUSTOM_IDS.startBatePonto
  );
}

function isBatePontoModalSubmit(interaction) {
  return (
    interaction.isModalSubmit?.() &&
    interaction.customId === CUSTOM_IDS.submitBatePontoModal
  );
}

module.exports = {
  showBatePontoModal,
  handleBatePontoModalSubmit,
  isBatePontoButtonInteraction,
  isBatePontoModalSubmit,
};
