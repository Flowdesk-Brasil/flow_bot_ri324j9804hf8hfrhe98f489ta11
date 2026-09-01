const {
  AttachmentBuilder,
  MessageFlags,
} = require("discord.js");
const { CUSTOM_IDS } = require("../constants/customIds");
const {
  buildCaptchaChallengePayload,
  buildTicketSimpleMessagePayload,
} = require("../utils/componentFactory");
const {
  generateCaptchaCode,
  generateCaptchaOptions,
  renderCaptchaImage,
} = require("./captchaImageGenerator");
const {
  createGuildCaptchaSession,
  deleteGuildCaptchaSession,
  getGuildCaptchaRuntime,
  getGuildCaptchaSession,
} = require("./supabaseService");

const CAPTCHA_ATTACHMENT_NAME = "captcha-code.png";

function memberHasAnyRole(member, roleIds = []) {
  if (!member?.roles?.cache || !Array.isArray(roleIds) || !roleIds.length) {
    return false;
  }
  return roleIds.some((roleId) => member.roles.cache.has(roleId));
}

function buildCaptchaFailurePayload(message) {
  return buildTicketSimpleMessagePayload({
    title: "Verificacao nao concluida",
    message,
    tone: "error",
  });
}

function buildCaptchaSuccessPayload(message) {
  return buildTicketSimpleMessagePayload({
    title: "Verificacao concluida",
    message,
    tone: "success",
  });
}

async function sendCaptchaVerificationLog({ guild, member, settings, client }) {
  const channelId = settings?.logs_channel_id;
  if (!channelId) return;

  const channel =
    guild.channels.cache.get(channelId) ||
    (await guild.channels.fetch(channelId).catch(() => null));

  if (!channel || !channel.isTextBased()) return;

  const verifiedRoles = Array.isArray(settings.verified_role_ids)
    ? settings.verified_role_ids
    : [];
  const roleMentions = verifiedRoles
    .map((roleId) => `<@&${roleId}>`)
    .join(", ");

  await channel
    .send({
      content: [
        "### Membro verificado",
        `Usuario: ${member} (\`${member.id}\`)`,
        roleMentions ? `Cargos: ${roleMentions}` : "Cargos: nenhum configurado",
        `Horario: <t:${Math.floor(Date.now() / 1000)}:F>`,
      ].join("\n"),
      allowedMentions: { parse: [] },
    })
    .catch((error) => {
      console.error("[captcha-log]", error);
    });
}

async function assignVerifiedRoles(member, roleIds = []) {
  if (!member?.manageable || !Array.isArray(roleIds) || !roleIds.length) {
    return;
  }

  const assignableRoleIds = roleIds.filter((roleId) => {
    const role = member.guild.roles.cache.get(roleId);
    return Boolean(role && role.editable);
  });

  if (!assignableRoleIds.length) return;
  await member.roles.add(assignableRoleIds, "Captcha verificado").catch(() => null);
}

async function handleCaptchaStartInteraction(interaction) {
  const guildId = interaction.guildId;
  if (!guildId) return;

  const runtime = await getGuildCaptchaRuntime(guildId);
  const settings = runtime?.settings;

  if (!runtime?.licenseUsable || !settings?.enabled) {
    await interaction.reply({
      ...buildCaptchaFailurePayload(
        "O modulo de captcha esta indisponivel neste servidor no momento.",
      ),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const member = interaction.member;
  const verifiedRoleIds = Array.isArray(settings.verified_role_ids)
    ? settings.verified_role_ids
    : [];
  const bypassRoleIds = Array.isArray(settings.bypass_role_ids)
    ? settings.bypass_role_ids
    : [];

  if (memberHasAnyRole(member, verifiedRoleIds)) {
    await interaction.reply({
      ...buildCaptchaSuccessPayload(
        "Voce ja esta verificado neste servidor.",
      ),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (memberHasAnyRole(member, bypassRoleIds)) {
    await assignVerifiedRoles(member, verifiedRoleIds);
    await interaction.reply({
      ...buildCaptchaSuccessPayload(
        "Seu cargo permite pular a verificacao. Acesso liberado.",
      ),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const correctCode = generateCaptchaCode(6);
  const optionCodes = generateCaptchaOptions(correctCode, 5);
  const expiresAt = new Date(
    Date.now() + Math.max(30, Number(settings.timeout_seconds || 120)) * 1000,
  ).toISOString();

  await createGuildCaptchaSession({
    guildId,
    userId: interaction.user.id,
    correctCode,
    optionCodes,
    attemptsRemaining: Math.max(1, Number(settings.max_attempts || 3)),
    expiresAt,
  });

  const imageBuffer = renderCaptchaImage(correctCode);
  const attachment = new AttachmentBuilder(imageBuffer, {
    name: CAPTCHA_ATTACHMENT_NAME,
  });

  await interaction.reply({
    ...buildCaptchaChallengePayload({
      title: settings.challenge_title,
      description: settings.challenge_description,
      attachmentName: CAPTCHA_ATTACHMENT_NAME,
      options: optionCodes,
    }),
    files: [attachment],
  });
}

async function handleCaptchaVerifyInteraction(interaction) {
  const guildId = interaction.guildId;
  if (!guildId) return;

  const runtime = await getGuildCaptchaRuntime(guildId);
  const settings = runtime?.settings;

  if (!runtime?.licenseUsable || !settings?.enabled) {
    await interaction.reply({
      ...buildCaptchaFailurePayload(
        "O modulo de captcha esta indisponivel neste servidor no momento.",
      ),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const selectedCode = interaction.values?.[0] || "";
  const session = await getGuildCaptchaSession(guildId, interaction.user.id);

  if (!session) {
    await interaction.reply({
      ...buildCaptchaFailurePayload(
        "Nenhuma verificacao ativa foi encontrada. Clique em Iniciar novamente.",
      ),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (new Date(session.expires_at).getTime() <= Date.now()) {
    await deleteGuildCaptchaSession(guildId, interaction.user.id);
    await interaction.reply({
      ...buildCaptchaFailurePayload(
        "O tempo da verificacao expirou. Clique em Iniciar novamente.",
      ),
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (selectedCode === session.correct_code) {
    await deleteGuildCaptchaSession(guildId, interaction.user.id);
    await assignVerifiedRoles(interaction.member, settings.verified_role_ids);
    await sendCaptchaVerificationLog({
      guild: interaction.guild,
      member: interaction.member,
      settings,
      client: interaction.client,
    });

    await interaction.update({
      ...buildCaptchaSuccessPayload(
        settings.success_message ||
          "Verificacao concluida com sucesso. Bem-vindo ao servidor!",
      ),
      files: [],
      components: [],
    });
    return;
  }

  const attemptsRemaining = Math.max(0, Number(session.attempts_remaining || 0) - 1);

  if (attemptsRemaining <= 0) {
    await deleteGuildCaptchaSession(guildId, interaction.user.id);

    if (settings.kick_on_fail && interaction.member?.kickable) {
      await interaction.member
        .kick("Falhou na verificacao de captcha.")
        .catch(() => null);
    }

    await interaction.update({
      ...buildCaptchaFailurePayload(
        "Voce esgotou as tentativas de verificacao. Tente novamente mais tarde.",
      ),
      files: [],
      components: [],
    });
    return;
  }

  const nextCorrectCode = generateCaptchaCode(6);
  const nextOptionCodes = generateCaptchaOptions(nextCorrectCode, 5);
  const expiresAt = new Date(
    Date.now() + Math.max(30, Number(settings.timeout_seconds || 120)) * 1000,
  ).toISOString();

  await createGuildCaptchaSession({
    guildId,
    userId: interaction.user.id,
    correctCode: nextCorrectCode,
    optionCodes: nextOptionCodes,
    attemptsRemaining,
    expiresAt,
  });

  const imageBuffer = renderCaptchaImage(nextCorrectCode);
  const attachment = new AttachmentBuilder(imageBuffer, {
    name: CAPTCHA_ATTACHMENT_NAME,
  });

  await interaction.update({
    ...buildCaptchaChallengePayload({
      title: settings.challenge_title,
      description: `${settings.challenge_description}\n\nCodigo incorreto. Tentativas restantes: **${attemptsRemaining}**.`,
      attachmentName: CAPTCHA_ATTACHMENT_NAME,
      options: nextOptionCodes,
    }),
    files: [attachment],
  });
}

function isCaptchaButtonInteraction(interaction) {
  return interaction.isButton?.() && interaction.customId === CUSTOM_IDS.startCaptcha;
}

function isCaptchaSelectInteraction(interaction) {
  return (
    interaction.isStringSelectMenu?.() &&
    interaction.customId === CUSTOM_IDS.verifyCaptcha
  );
}

module.exports = {
  handleCaptchaStartInteraction,
  handleCaptchaVerifyInteraction,
  isCaptchaButtonInteraction,
  isCaptchaSelectInteraction,
};
