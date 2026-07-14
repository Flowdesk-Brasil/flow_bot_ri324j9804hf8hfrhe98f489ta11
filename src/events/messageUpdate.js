const {
  handleMessageEditSecurityLog,
  observeSecurityLogMessageSnapshot,
} = require("../services/securityLogsService");

module.exports = {
  name: "messageUpdate",
  async execute(oldMessage, newMessage) {
    try {
      await handleMessageEditSecurityLog(oldMessage, newMessage);
      observeSecurityLogMessageSnapshot(newMessage);
    } catch (error) {
      console.error("[security-log:messageUpdate]", error);
    }
  },
};
