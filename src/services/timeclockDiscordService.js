const { MessageFlags } = require("discord.js");
const { env } = require("../config/env");

const COMPONENTS_V2_FLAG = 32768;
const ACTION_ROW_COMPONENT_TYPE = 1;
const TEXT_DISPLAY_COMPONENT_TYPE = 10;

function buildDiagnosticMessage(response, payload, bodyText) {
  if (response.status === 401 || response.status === 403) {
    return "Bate Ponto sem autorizacao interna. Configure o TIMECLOCK_INTERNAL_API_TOKEN igual no site e no bot.";
  }

  if (response.status === 404) {
    return `Rota interna do Bate Ponto nao encontrada em ${env.timeclockInternalApiUrl}. Publique o site atualizado ou ajuste TIMECLOCK_INTERNAL_API_URL.`;
  }

  if (payload?.message) return payload.message;

  if (response.status >= 500) {
    return "A API do Bate Ponto retornou erro interno. Verifique se a migration 142_timeclock_enterprise.sql foi aplicada e se o site esta atualizado.";
  }

  if (bodyText && bodyText.trim().startsWith("<")) {
    return `A URL interna do Bate Ponto respondeu HTML em vez de JSON. Confira TIMECLOCK_INTERNAL_API_URL: ${env.timeclockInternalApiUrl}`;
  }

  return `Falha ao processar Bate Ponto. HTTP ${response.status || "sem resposta"}.`;
}

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

  if (Array.isArray(next.components)) {
    const extractedText = extractTextDisplayContent(next.components);
    const actionRows = next.components
      .filter((component) => component?.type === ACTION_ROW_COMPONENT_TYPE)
      .slice(0, 5);
    const hadComponentsV2 = actionRows.length !== next.components.length;

    if (hadComponentsV2) {
      if (!next.content && extractedText) {
        next.content = extractedText.slice(0, 1900);
      }
      if (typeof next.flags === "number") {
        next.flags &= ~COMPONENTS_V2_FLAG;
      }
    }

    if (actionRows.length) {
      next.components = actionRows;
    } else {
      delete next.components;
    }
  }

  if (!next.flags) {
    next.flags = MessageFlags.Ephemeral;
  }
  return next;
}

function extractTextDisplayContent(components) {
  const parts = [];
  const visit = (items) => {
    for (const component of items || []) {
      if (!component || typeof component !== "object") continue;
      if (component.type === TEXT_DISPLAY_COMPONENT_TYPE && typeof component.content === "string") {
        parts.push(component.content);
      }
      if (Array.isArray(component.components)) {
        visit(component.components);
      }
    }
  };
  visit(components);
  return parts.join("\n\n").trim();
}

function buildContentOnlyFallback(payload, error) {
  const embedDescription = Array.isArray(payload?.embeds)
    ? payload.embeds.find((embed) => typeof embed?.description === "string")?.description
    : null;
  const content =
    (typeof payload?.content === "string" && payload.content.trim()) ||
    embedDescription ||
    "Nao foi possivel renderizar o painel do Bate Ponto. Tente novamente em alguns segundos.";

  return {
    content: String(content).slice(0, 1900),
    flags: MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  };
}

async function sendInteractionPayload(interaction, sender, payload, context) {
  try {
    await sender(payload);
  } catch (error) {
    console.error("[timeclock] Discord rejeitou payload; tentando fallback texto:", {
      context,
      guildId: interaction.guild?.id,
      userId: interaction.user?.id,
      code: error?.code,
      status: error?.status,
      message: error?.message,
    });
    await sender(buildContentOnlyFallback(payload, error));
  }
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

  let response;
  try {
    response = await fetch(env.timeclockInternalApiUrl, {
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
  } catch (error) {
    console.error("[timeclock] falha ao chamar API interna:", {
      action,
      guildId: interaction.guild.id,
      userId: interaction.user.id,
      url: env.timeclockInternalApiUrl,
      error,
    });
    throw new Error("Nao consegui conectar o bot ao site do Bate Ponto. Verifique TIMECLOCK_INTERNAL_API_URL e se o site esta online.");
  }

  const bodyText = await response.text().catch(() => "");
  let payload = {};
  if (bodyText) {
    try {
      payload = JSON.parse(bodyText);
    } catch {
      payload = {};
    }
  }
  if (!response.ok || !payload.ok) {
    const error = new Error(buildDiagnosticMessage(response, payload, bodyText));
    const discordPayload = payload.discordPayload
      ? normalizeDiscordPayload(payload.discordPayload)
      : null;
    error.discordPayload = {
      ...(discordPayload || {}),
      content: error.message,
      flags: MessageFlags.Ephemeral,
    };
    console.error("[timeclock] API interna recusou a acao:", {
      action,
      guildId: interaction.guild.id,
      userId: interaction.user.id,
      status: response.status,
      url: env.timeclockInternalApiUrl,
      message: error.message,
      bodyPreview: bodyText.slice(0, 240),
    });
    throw error;
  }
  return payload;
}

async function replyToInteraction(interaction, payload, mode = "reply") {
  const normalized = normalizeDiscordPayload(payload);

  if (mode === "update" && interaction.isButton?.()) {
    if (!interaction.deferred && !interaction.replied) {
      await sendInteractionPayload(
        interaction,
        (payloadToSend) => interaction.update(payloadToSend),
        normalized,
        "button_update",
      );
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

  await sendInteractionPayload(
    interaction,
    (payloadToSend) => interaction.reply(payloadToSend),
    normalized,
    "reply",
  );
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
