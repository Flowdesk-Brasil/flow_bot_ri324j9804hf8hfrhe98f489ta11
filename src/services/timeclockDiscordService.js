const { MessageFlags } = require("discord.js");
const { env } = require("../config/env");

function normalizeDiscordPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return {
      content: "Nao foi possivel montar a resposta do Bate Ponto.",
      flags: MessageFlags.Ephemeral,
    };
  }

  const next = { ...payload };
  if (next.allowed_mentions && !next.allowedMentions) {
    next.allowedMentions = next.allowed_mentions;
    delete next.allowed_mentions;
  }
  if (!next.flags) {
    next.flags = MessageFlags.Ephemeral;
  }
  return next;
}

function getMemberRoleIds(interaction) {
  const roles = interaction.member?.roles;
  if (!roles) return [];
  if (roles.cache?.keys) return [...roles.cache.keys()];
  if (Array.isArray(roles)) return roles.filter(Boolean).map(String);
  return [];
}

async function callTimeclockInternalApi(interaction, action) {
  if (!env.timeclockInternalApiToken && process.env.NODE_ENV === "production") {
    throw new Error("TIMECLOCK_INTERNAL_API_TOKEN/CRON_SECRET nao configurado para o bot.");
  }
  if (!interaction.guild?.id) {
    throw new Error("O Bate Ponto so pode ser usado dentro de um servidor.");
  }

  const response = await fetch(env.timeclockInternalApiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(env.timeclockInternalApiToken
        ? { Authorization: `Bearer ${env.timeclockInternalApiToken}` }
        : {}),
    },
    body: JSON.stringify({
      action,
      guildId: interaction.guild.id,
      userId: interaction.user.id,
      actorId: interaction.user.id,
      source: interaction.isButton?.() ? "discord_button" : "discord_command",
      interactionId: interaction.id,
      memberRoleIds: getMemberRoleIds(interaction),
    }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) {
    const discordPayload = payload.discordPayload
      ? normalizeDiscordPayload(payload.discordPayload)
      : null;
    const error = new Error(payload.message || "Falha ao processar Bate Ponto.");
    error.discordPayload = discordPayload;
    throw error;
  }
  return payload;
}

async function replyToInteraction(interaction, payload, mode = "reply") {
  const normalized = normalizeDiscordPayload(payload);

  if (mode === "update" && interaction.isButton?.()) {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.update(normalized);
      return;
    }
    await interaction.editReply(normalized).catch(async () => {
      await interaction.followUp(normalized).catch(() => null);
    });
    return;
  }

  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(normalized).catch(async () => {
      await interaction.followUp(normalized).catch(() => null);
    });
    return;
  }

  await interaction.reply(normalized);
}

async function showTimeclockStatus(interaction) {
  const payload = await callTimeclockInternalApi(interaction, "status");
  await replyToInteraction(interaction, payload.discordPayload, "reply");
}

async function handleTimeclockButtonInteraction(interaction) {
  const actionByCustomId = {
    "timeclock:open": "status",
    "timeclock:start": "start",
    "timeclock:pause": "pause",
    "timeclock:finish": "finish",
  };
  const action = actionByCustomId[interaction.customId];
  if (!action) return false;

  try {
    const payload = await callTimeclockInternalApi(interaction, action);
    await replyToInteraction(
      interaction,
      payload.discordPayload,
      interaction.customId === "timeclock:open" ? "reply" : "update",
    );
  } catch (error) {
    const payload = error.discordPayload || {
      content: error.message || "Erro ao processar Bate Ponto.",
      flags: MessageFlags.Ephemeral,
    };
    await replyToInteraction(interaction, payload, interaction.customId === "timeclock:open" ? "reply" : "update");
  }

  return true;
}

async function executeTimeclockCommand(interaction, action) {
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const payload = await callTimeclockInternalApi(interaction, action);
    await replyToInteraction(interaction, payload.discordPayload, "reply");
  } catch (error) {
    await replyToInteraction(
      interaction,
      error.discordPayload || {
        content: error.message || "Erro ao processar Bate Ponto.",
        flags: MessageFlags.Ephemeral,
      },
      "reply",
    );
  }
}

module.exports = {
  executeTimeclockCommand,
  handleTimeclockButtonInteraction,
  showTimeclockStatus,
};
