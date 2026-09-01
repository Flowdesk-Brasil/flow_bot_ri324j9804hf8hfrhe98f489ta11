const { handleNicknameOrAvatarUpdate } = require("../services/securityLogsService");
const { syncClientRoleForMember } = require("../services/clientRoleService");

module.exports = {
  name: "guildMemberUpdate",
  async execute(oldMember, newMember) {
    try {
      await handleNicknameOrAvatarUpdate(oldMember, newMember);
    } catch (error) {
      console.error("[security-log:guildMemberUpdate]", error);
    }

    try {
      if (oldMember.guild?.id === newMember.guild?.id && oldMember.roles.cache.size !== newMember.roles.cache.size) {
        await syncClientRoleForMember(newMember, { log: false });
      }
    } catch (error) {
      console.error("[client-role:member-update]", error);
    }
  },
};
