const {
  MessageFlags,
} = require("discord.js");
const { CUSTOM_IDS } = require("../constants/customIds");
const { env } = require("../config/env");
const { buildTicketSimpleMessagePayload } = require("../utils/componentFactory");
const {
  claimTicketFromInteraction,
  closeTicketFromInteraction,
  openTicketFromModalSubmit,
  showOpenTicketReasonModal,
  showAdminTicketPanelFromInteraction,
  showMemberTicketPanelFromInteraction,
  showStaffTicketPanelFromInteraction,
  handleTicketModalSubmit,
  handleTicketSelectInteraction,
  handleAiSuggestionHelped,
  handleAiSuggestionContinue,
} = require("../services/ticketService");
const {
  handleSecurityLogButtonInteraction,
  isSecurityLogButtonInteraction,
} = require("../services/securityLogsService");
const {
  handleSalesInteraction,
  isSalesComponentInteraction,
} = require("../services/salesService");
const {
  handleTicketRefundInteraction,
  isTicketRefundInteraction,
} = require("../services/ticketRefundService");
const {
  getGuildTicketRuntime,
} = require("../services/supabaseService");
const { isDiscordUserSuspended, isDiscordUserAtRisk } = require("../services/violationService");

function isTicketButtonInteraction(interaction) {
  return (
    interaction.isButton() &&
    [
      CUSTOM_IDS.openTicket,
      CUSTOM_IDS.claimTicket,
      CUSTOM_IDS.closeTicket,
      CUSTOM_IDS.ticketAdminPanel,
      CUSTOM_IDS.ticketStaffPanel,
      CUSTOM_IDS.ticketMemberPanel,
    ].includes(interaction.customId)
  );
}

function isTicketSelectInteraction(interaction) {
  return (
    interaction.isStringSelectMenu?.() &&
    [
      CUSTOM_IDS.ticketAdminSelect,
      CUSTOM_IDS.ticketStaffSelect,
      CUSTOM_IDS.ticketMemberSelect,
    ].includes(interaction.customId)
  );
}

function isTicketModalSubmit(interaction) {
  return (
    interaction.isModalSubmit?.() &&
    [
      CUSTOM_IDS.ticketAddMemberModal,
      CUSTOM_IDS.ticketRemoveMemberModal,
      CUSTOM_IDS.ticketPaymentModal,
      CUSTOM_IDS.ticketMemberUpdateModal,
      CUSTOM_IDS.ticketStaffNoteModal,
    ].includes(interaction.customId)
  );
}

function isUnknownInteractionError(error) {
  return error?.code === 10062 || error?.rawError?.code === 10062;
}

async function replyWithTicketErrorPayload(interaction, payload) {
  const normalizedPayload = {
    ...payload,
    flags: (payload.flags || 0) | MessageFlags.Ephemeral,
  };

  if (interaction.deferred && !interaction.replied) {
    await interaction.followUp(normalizedPayload).catch(() => null);
    return;
  }

  if (interaction.replied) {
    await interaction.followUp(normalizedPayload).catch(() => null);
    return;
  }

  await interaction.reply(normalizedPayload).catch(() => null);
}

function buildPlatformStatusErrorPayload() {
  return buildTicketSimpleMessagePayload({
    title: "Algo de errado aconteceu aqui",
    message:
      "Nao consegui concluir sua solicitacao agora. Tente novamente em alguns instantes.",
    hint: "Se o problema continuar, acompanhe nossa pagina de status.",
    buttonLabel: "Verificar status",
    buttonUrl: env.statusPageUrl,
    tone: "error",
  });
}

module.exports = {
  name: "interactionCreate",
  async execute(interaction, client) {
    try {
      if (interaction.isChatInputCommand()) {
        const command = client.commands.get(interaction.commandName);
        if (!command) return;

        await command.execute(interaction, client);
        return;
      }

      if (interaction.isModalSubmit()) {
        if (isTicketModalSubmit(interaction)) {
          await handleTicketModalSubmit(interaction);
          return;
        }
        if (isSalesComponentInteraction(interaction)) {
          await handleSalesInteraction(interaction, client);
          return;
        }
        if (interaction.customId === CUSTOM_IDS.openTicketReasonModal) {
          await openTicketFromModalSubmit(interaction);
        }
        return;
      }

      if (isSalesComponentInteraction(interaction)) {
        await handleSalesInteraction(interaction, client);
        return;
      }

      if (isTicketRefundInteraction(interaction)) {
        await handleTicketRefundInteraction(interaction, client, getGuildTicketRuntime);
        return;
      }

      if (isTicketSelectInteraction(interaction)) {
        await handleTicketSelectInteraction(interaction);
        return;
      }

      if (!interaction.isButton()) return;

      if (isSecurityLogButtonInteraction(interaction)) {
        await handleSecurityLogButtonInteraction(interaction);
        return;
      }

      if (
        interaction.customId === CUSTOM_IDS.openTicket &&
        !interaction.deferred &&
        !interaction.replied
      ) {
        // Block suspended users from opening tickets
        const suspended = await isDiscordUserSuspended(interaction.user.id);
        if (suspended) {
          const payload = buildTicketSimpleMessagePayload({
            title: "🚫 Conta Suspensa",
            message:
              "Sua conta Flowdesk está **suspensa** devido a violações ativas.\nVocê não pode abrir tickets enquanto sua conta estiver suspensa.\nAcesse o painel em flwdesk.com/account para mais detalhes.",
            tone: "error",
          });
          await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => null);
          return;
        }
        await showOpenTicketReasonModal(interaction);
        return;
      }

      if (isTicketButtonInteraction(interaction) && !interaction.deferred && !interaction.replied) {
        await interaction.deferUpdate();
      }

      if (interaction.customId === CUSTOM_IDS.claimTicket) {
        await claimTicketFromInteraction(interaction);
        return;
      }

      if (interaction.customId === CUSTOM_IDS.closeTicket) {
        await closeTicketFromInteraction(interaction);
        return;
      }

      if (interaction.customId === CUSTOM_IDS.ticketAdminPanel) {
        await showAdminTicketPanelFromInteraction(interaction);
        return;
      }

      if (interaction.customId === CUSTOM_IDS.ticketStaffPanel) {
        await showStaffTicketPanelFromInteraction(interaction);
        return;
      }

      if (interaction.customId === CUSTOM_IDS.ticketMemberPanel) {
        await showMemberTicketPanelFromInteraction(interaction);
        return;
      }

      if (interaction.customId === CUSTOM_IDS.aiSuggestionHelped) {
        await handleAiSuggestionHelped(interaction);
        return;
      }

      if (interaction.customId === CUSTOM_IDS.aiSuggestionContinue) {
        await handleAiSuggestionContinue(interaction);
      }
    } catch (error) {
      if (isUnknownInteractionError(error)) {
        const interactionAgeMs =
          typeof interaction?.createdTimestamp === "number"
            ? Date.now() - interaction.createdTimestamp
            : null;
        console.warn("[interactionCreate] Interacao expirada antes de ser reconhecida.", {
          interactionId: interaction?.id || null,
          customId: interaction?.customId || null,
          createdTimestamp: interaction?.createdTimestamp || null,
          interactionAgeMs,
        });
        return;
      }

      console.error(error);

      if (interaction.isChatInputCommand()) {
        await replyWithTicketErrorPayload(
          interaction,
          buildPlatformStatusErrorPayload(),
        );
        return;
      }

      await replyWithTicketErrorPayload(
        interaction,
        buildPlatformStatusErrorPayload(),
      );
    }
  },
};
