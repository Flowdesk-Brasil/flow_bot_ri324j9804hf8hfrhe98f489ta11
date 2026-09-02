const { reconcileDeletedSuggestionMessage } = require("../services/suggestionService");

module.exports = {
  name: "messageDeleteBulk",
  async execute(messages, channel, client) {
    try {
      for (const message of messages.values()) {
        await reconcileDeletedSuggestionMessage(message, client, channel);
      }
    } catch (error) {
      console.error("[suggestion:messageDeleteBulk]", error);
    }
  },
};
