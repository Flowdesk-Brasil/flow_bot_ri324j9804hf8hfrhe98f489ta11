const { SlashCommandBuilder } = require("discord.js");
const { executeTimeclockCommand } = require("../services/timeclockDiscordService");

const ACTION_BY_SUBCOMMAND = {
  status: "status",
  iniciar: "start",
  pausar: "pause",
  retomar: "resume",
  finalizar: "finish",
  historico: "history",
  ranking: "ranking",
};

module.exports = {
  data: new SlashCommandBuilder()
    .setName("ponto")
    .setDescription("Controle sua jornada de Bate Ponto.")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("status")
        .setDescription("Mostra o estado atual do seu ponto."),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("iniciar")
        .setDescription("Inicia sua jornada do dia."),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("pausar")
        .setDescription("Inicia uma pausa na jornada atual."),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("retomar")
        .setDescription("Retoma uma jornada pausada."),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("finalizar")
        .setDescription("Finaliza sua jornada atual."),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("historico")
        .setDescription("Mostra seu historico recente de ponto."),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("ranking")
        .setDescription("Mostra o ranking do Bate Ponto."),
    ),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();
    const action = ACTION_BY_SUBCOMMAND[subcommand] || "status";
    await executeTimeclockCommand(interaction, action);
  },
};
