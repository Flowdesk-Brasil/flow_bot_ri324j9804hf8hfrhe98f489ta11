const { env } = require("../config/env");
const { CUSTOM_IDS } = require("../constants/customIds");
const {
  getConfiguredCaptchaGuildRuntimes,
  updateGuildCaptchaPanelMessageId,
} = require("./supabaseService");
const { buildCaptchaPanelPayload } = require("../utils/componentFactory");

let activeCaptchaPanelSyncPromise = null;
const captchaPanelSyncState = new Map();

function buildCaptchaPanelSyncFingerprint(runtime) {
  return JSON.stringify({
    panelChannelId: runtime?.settings?.panel_channel_id || "",
    panelTitle: runtime?.settings?.panel_title || "",
    panelDescription: runtime?.settings?.panel_description || "",
    panelButtonLabel: runtime?.settings?.panel_button_label || "",
    panelLayout: runtime?.settings?.panel_layout || null,
  });
}

function shouldSyncCaptchaPanel(runtime) {
  const fingerprint = buildCaptchaPanelSyncFingerprint(runtime);
  const cachedState = captchaPanelSyncState.get(runtime.guildId);
  const now = Date.now();

  if (!cachedState) {
    return { shouldSync: true, fingerprint };
  }

  const verificationIntervalMs = Math.max(
    env.ticketPanelVerificationIntervalMs || 0,
    env.ticketPanelSyncIntervalMs || 0,
    15_000,
  );

  if (cachedState.fingerprint !== fingerprint) {
    return { shouldSync: true, fingerprint };
  }

  if (now - cachedState.lastVerifiedAt >= verificationIntervalMs) {
    return { shouldSync: true, fingerprint };
  }

  return { shouldSync: false, fingerprint };
}

function markCaptchaPanelSyncState(guildId, fingerprint) {
  captchaPanelSyncState.set(guildId, {
    fingerprint,
    lastVerifiedAt: Date.now(),
  });
}

function pruneCaptchaPanelSyncState(runtimes) {
  const activeGuildIds = new Set(
    Array.isArray(runtimes) ? runtimes.map((runtime) => runtime.guildId) : [],
  );

  for (const guildId of captchaPanelSyncState.keys()) {
    if (!activeGuildIds.has(guildId)) {
      captchaPanelSyncState.delete(guildId);
    }
  }
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

function messageLooksLikeCaptchaPanel(message) {
  if (!message?.author?.bot || message.author.id !== message.client.user.id) {
    return false;
  }

  let foundStartButton = false;
  walkComponents(message.components, (component) => {
    const customId = component.customId || component.data?.custom_id;
    if (customId === CUSTOM_IDS.startCaptcha) {
      foundStartButton = true;
    }
  });

  return foundStartButton;
}

async function fetchExistingCaptchaPanelMessage(channel, storedMessageId = null) {
  if (storedMessageId) {
    const storedMessage = await channel.messages
      .fetch(storedMessageId)
      .catch(() => null);

    if (
      storedMessage &&
      storedMessage.author?.bot &&
      storedMessage.author.id === storedMessage.client.user.id
    ) {
      return storedMessage;
    }
  }

  const recentMessages = await channel.messages.fetch({ limit: 25 });
  return recentMessages.find((message) => messageLooksLikeCaptchaPanel(message)) || null;
}

async function syncCaptchaPanelForRuntime(client, runtime) {
  if (!runtime?.settings?.panel_channel_id) {
    return { status: "skipped", reason: "missing_panel_channel" };
  }

  const guild =
    client.guilds.cache.get(runtime.guildId) ||
    (await client.guilds.fetch(runtime.guildId).catch(() => null));

  if (!guild) {
    return { status: "skipped", reason: "guild_unavailable" };
  }

  const channel =
    guild.channels.cache.get(runtime.settings.panel_channel_id) ||
    (await guild.channels.fetch(runtime.settings.panel_channel_id).catch(() => null));

  if (!channel || !channel.isTextBased()) {
    return { status: "skipped", reason: "channel_unavailable" };
  }

  const payload = buildCaptchaPanelPayload({
    settings: runtime.settings,
  });

  const existingMessage = await fetchExistingCaptchaPanelMessage(
    channel,
    runtime.settings.panel_message_id || null,
  );

  if (existingMessage) {
    await existingMessage.edit(payload);
    if (runtime.settings.panel_message_id !== existingMessage.id) {
      await updateGuildCaptchaPanelMessageId(runtime.guildId, existingMessage.id);
      runtime.settings.panel_message_id = existingMessage.id;
    }
    return {
      status: "updated",
      guildId: runtime.guildId,
      channelId: channel.id,
      messageId: existingMessage.id,
      licenseStatus: runtime.licenseStatus,
    };
  }

  const sentMessage = await channel.send(payload);
  await updateGuildCaptchaPanelMessageId(runtime.guildId, sentMessage.id);
  runtime.settings.panel_message_id = sentMessage.id;
  return {
    status: "created",
    guildId: runtime.guildId,
    channelId: channel.id,
    messageId: sentMessage.id,
    licenseStatus: runtime.licenseStatus,
  };
}

async function syncAllCaptchaPanels(client) {
  if (activeCaptchaPanelSyncPromise) {
    return activeCaptchaPanelSyncPromise;
  }

  activeCaptchaPanelSyncPromise = (async () => {
    const runtimes = await getConfiguredCaptchaGuildRuntimes();
    const applied = [];
    const skipped = [];
    pruneCaptchaPanelSyncState(runtimes);

    for (const runtime of runtimes) {
      if (!runtime.isConfigured || !runtime.licenseUsable) {
        skipped.push({ guildId: runtime.guildId, reason: "incomplete_config" });
        continue;
      }

      const syncDecision = shouldSyncCaptchaPanel(runtime);
      if (!syncDecision.shouldSync) {
        skipped.push({ guildId: runtime.guildId, reason: "unchanged" });
        continue;
      }

      try {
        const result = await syncCaptchaPanelForRuntime(client, runtime);
        markCaptchaPanelSyncState(runtime.guildId, syncDecision.fingerprint);
        applied.push(result);
      } catch (error) {
        skipped.push({
          guildId: runtime.guildId,
          reason: error instanceof Error ? error.message : "sync_failed",
        });
      }
    }

    return {
      total: runtimes.length,
      applied,
      skipped,
    };
  })();

  try {
    return await activeCaptchaPanelSyncPromise;
  } finally {
    activeCaptchaPanelSyncPromise = null;
  }
}

module.exports = {
  syncAllCaptchaPanels,
  syncCaptchaPanelForRuntime,
};
