const {
  handleAiMention,
  observePotentialCommunityQuestion,
} = require("../services/aiMentionService");
const { handleAntiLinkMessage } = require("../services/antiLinkService");
const { handleAdminAssistantMessage } = require("../services/adminAssistantService");
const { observeSecurityLogMessageSnapshot } = require("../services/securityLogsService");
const { handleTicketAiMessage } = require("../services/ticketAiService");

module.exports = {
  name: "messageCreate",
  async execute(message, client) {
    try {
      observeSecurityLogMessageSnapshot(message);

      const antiLinkHandled = await handleAntiLinkMessage(message);
      if (antiLinkHandled) {
        return;
      }

      const adminHandled = await handleAdminAssistantMessage(message, client);
      if (adminHandled) {
        return;
      }

      const ticketHandled = await handleTicketAiMessage(message, client);
      if (ticketHandled) {
        return;
      }

      const mentionHandled = await handleAiMention(message, client);
      if (mentionHandled) {
        return;
      }

      await observePotentialCommunityQuestion(message, client);
    } catch (error) {
      console.error("[messageCreate] falha ao processar mensagem:", error);
    }
  },
};
