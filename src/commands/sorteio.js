const { SlashCommandBuilder } = require("discord.js");
const { executeSorteioCommand } = require("../services/sorteioService");

module.exports = {
  data: new SlashCommandBuilder()
    .setName("sorteio")
    .setDescription("Cria e gerencia sorteios avancados no servidor."),

  async execute(interaction) {
    await executeSorteioCommand(interaction);
  },
};
