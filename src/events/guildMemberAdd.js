const { sendWelcomeMessage } = require("../services/welcomeService");
const { enqueueAutoRoleForMember } = require("../services/autoRoleService");
const { syncClientRoleForMember } = require("../services/clientRoleService");

module.exports = {
  name: "guildMemberAdd",
  async execute(member) {
    try {
      await sendWelcomeMessage({ member, kind: "entry" });
    } catch (error) {
      console.error("[welcome-entry]", error);
    }

    try {
      await enqueueAutoRoleForMember({ member });
    } catch (error) {
      console.error("[autorole:member-add]", error);
    }

    try {
      await syncClientRoleForMember(member);
    } catch (error) {
      console.error("[client-role:member-add]", error);
    }
  },
};
