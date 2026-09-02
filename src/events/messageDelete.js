const { handleMessageDeleteSecurityLog } = require("../services/securityLogsService");
const { reconcileDeletedSuggestionMessage } = require("../services/suggestionService");

module.exports = {
  name: "messageDelete",
  async execute(message, client) {
    try {
      await handleMessageDeleteSecurityLog(message);
    } catch (error) {
      console.error("[security-log:messageDelete]", error);
    }

    try {
      await reconcileDeletedSuggestionMessage(message, client);
    } catch (error) {
      console.error("[suggestion:messageDelete]", error);
    }
  },
};
