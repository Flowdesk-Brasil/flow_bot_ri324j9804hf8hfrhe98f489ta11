const { ChannelType } = require("discord.js");
const { reconcileDeletedTicketChannel } = require("../services/ticketService");
const { reconcileDeletedSuggestionThread } = require("../services/suggestionService");

module.exports = {
  name: "channelDelete",
  async execute(channel) {
    try {
      if (!channel || !channel.guild) {
        return;
      }

      if (
        channel.type !== ChannelType.GuildText &&
        channel.type !== ChannelType.PublicThread &&
        channel.type !== ChannelType.PrivateThread
      ) {
        return;
      }

      await reconcileDeletedTicketChannel(channel.guild.id, channel.id);

      if (
        channel.type === ChannelType.PublicThread ||
        channel.type === ChannelType.PrivateThread
      ) {
        await reconcileDeletedSuggestionThread(channel.guild, channel.id);
      }
    } catch (error) {
      console.error("[channelDelete] Falha ao reconciliar canal deletado", {
        guildId: channel?.guild?.id || null,
        channelId: channel?.id || null,
        error,
      });
    }
  },
};
