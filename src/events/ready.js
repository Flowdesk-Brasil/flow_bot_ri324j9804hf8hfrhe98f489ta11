const { ensureOfficialLinkPanel } = require("../services/officialLinkPanelService");
const {
  syncAllTicketPanels,
  syncOpenTicketControlMessages,
} = require("../services/ticketService");
const {
  primeVoiceStateSnapshots,
  startSecurityLogQueueWorker,
} = require("../services/securityLogsService");
const { startDirectMessageQueueWorker } = require("../services/directMessageQueueService");
const { startAutoRoleWorker } = require("../services/autoRoleService");
const { primeInviteCacheForClient } = require("../utils/inviteTracker");
const { syncSlashCommandsForClient } = require("../services/slashCommandSyncService");
const { startVoicePresence } = require("../services/voicePresenceService");
const { startStatusHeartbeat } = require("../services/statusMonitoringService");
const { syncAllViolationRoles } = require("../services/violationService");
const { syncAllClientRoles } = require("../services/clientRoleService");
const { initRealtimeListeners } = require("../services/realtimeService");
const { verifySupabaseAdminConnection } = require("../services/supabaseConnectivityService");
const { env } = require("../config/env");

module.exports = {
  name: "clientReady",
  once: true,
  async execute(client) {
    console.log(`Bot online como ${client.user.tag}`);

    const supabaseReady = await verifySupabaseAdminConnection();

    if (
      supabaseReady &&
      String(process.env.SUPABASE_REALTIME_ENABLED || "true").toLowerCase() !== "false"
    ) {
      initRealtimeListeners(client);
    } else if (supabaseReady) {
      console.log("[realtimeService] listeners desativados por SUPABASE_REALTIME_ENABLED=false");
    }

    if (supabaseReady) {
      startStatusHeartbeat(client);
    } else {
      console.warn(
        "[startup] Servicos dependentes do Supabase foram pausados ate a chave correta ser configurada.",
      );
    }

    console.log(
      `[ai-mention] ${env.openaiApiKey ? "ativo" : "desativado"} | modelo principal: ${env.openaiModel}`,
    );
    if (env.autoDeployCommands) {
      try {
        const slashSync = await syncSlashCommandsForClient(client);
        if (slashSync.deployed) {
          console.log(
            `[slash-commands] synced ${slashSync.count} command(s) (${slashSync.scope})`,
          );
        } else {
          console.log(
            `[slash-commands] sincronizacao ignorada (${slashSync.reason})`,
          );
        }
      } catch (error) {
        console.error("[slash-commands]", error);
      }
    } else {
      console.log("[slash-commands] sincronizacao automatica desativada no .env");
    }

    try {
      const panelResult = await ensureOfficialLinkPanel(client);
      console.log(
        `[official-link-panel] ${panelResult.mode} message ${panelResult.messageId}`,
      );
    } catch (error) {
      console.error("[official-link-panel]", error);
    }

    if (supabaseReady) {
      try {
        const result = await syncAllTicketPanels(client);
        console.log(
          `[ticket-panels] synced ${result.applied.length}/${result.total} paineis`,
        );
      } catch (error) {
        console.error("[ticket-panels]", error);
      }

      try {
        const result = await syncOpenTicketControlMessages(client);
        if (result.applied.length || result.total) {
          console.log(
            `[ticket-open-messages] synced ${result.applied.length}/${result.total} mensagens`,
          );
        }
      } catch (error) {
        console.error("[ticket-open-messages]", error);
      }

      startDirectMessageQueueWorker(client);
      startSecurityLogQueueWorker(client);
      startAutoRoleWorker(client);

      if (env.clientRoleStartupSyncMode !== "off") {
        try {
          const result = await syncAllClientRoles(client);
          console.log(
            `[client-role] Startup sync completo (${result.synced}/${result.candidateCount}).`,
          );
        } catch (error) {
          console.error("[client-role] Erro no startup sync:", error);
        }
      } else {
        console.log("[client-role] Startup sync desativado por configuracao.");
      }

      if (env.clientRolePeriodicSyncMode !== "off") {
        setInterval(async () => {
          try {
            const result = await syncAllClientRoles(client);
            console.log(
              `[client-role] Sync periodico completo (${result.synced}/${result.candidateCount}).`,
            );
          } catch (error) {
            console.error("[client-role] Erro no sync periodico:", error);
          }
        }, env.clientRolePeriodicSyncIntervalMs);
      } else {
        console.log("[client-role] Sync periodico desativado por configuracao.");
      }
    }

    try {
      await primeInviteCacheForClient(client);
    } catch (error) {
      console.error("[invite-cache]", error);
    }

    try {
      startVoicePresence(client);
    } catch (error) {
      console.error("[voice-presence]", error);
    }

    try {
      const primedVoiceStates = primeVoiceStateSnapshots(client);
      if (primedVoiceStates > 0) {
        console.log(`[security-logs] snapshots de voz inicializados: ${primedVoiceStates}`);
      }
    } catch (error) {
      console.error("[security-logs:prime-voice-states]", error);
    }

    if (supabaseReady) {
      const startupViolationSyncMode = env.violationStartupSyncMode;
      const periodicViolationSyncMode = env.violationPeriodicSyncMode;

      setInterval(async () => {
        try {
          const result = await syncAllTicketPanels(client);
          if (result.applied.length) {
            console.log(
              `[ticket-panels] synced ${result.applied.length}/${result.total} paineis`,
            );
          }
        } catch (error) {
          console.error("[ticket-panels]", error);
        }
      }, env.ticketPanelSyncIntervalMs);

      setInterval(async () => {
        try {
          const result = await syncOpenTicketControlMessages(client);
          if (result.applied.length) {
            console.log(
              `[ticket-open-messages] synced ${result.applied.length}/${result.total} mensagens`,
            );
          }
        } catch (error) {
          console.error("[ticket-open-messages]", error);
        }
      }, env.ticketOpenMessageSyncIntervalMs);

      if (startupViolationSyncMode !== "off") {
        try {
          const result = await syncAllViolationRoles(client, {
            mode: startupViolationSyncMode,
          });
          console.log(
            `[violation-roles] Startup sync ${result.mode} completo (${result.synced}/${result.candidateCount}).`,
          );
        } catch (error) {
          console.error("[violation-roles] Erro no startup sync:", error);
        }
      } else {
        console.log("[violation-roles] Startup sync desativado por configuracao.");
      }

      if (periodicViolationSyncMode !== "off") {
        setInterval(async () => {
          try {
            const result = await syncAllViolationRoles(client, {
              mode: periodicViolationSyncMode,
            });
            console.log(
              `[violation-roles] Sync periodico ${result.mode} completo (${result.synced}/${result.candidateCount}).`,
            );
          } catch (error) {
            console.error("[violation-roles] Erro no sync periodico:", error);
          }
        }, env.violationPeriodicSyncIntervalMs);
      } else {
        console.log("[violation-roles] Sync periodico desativado por configuracao.");
      }
    }
  },
};
