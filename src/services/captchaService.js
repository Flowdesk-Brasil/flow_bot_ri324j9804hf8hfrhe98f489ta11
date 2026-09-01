const {
  AttachmentBuilder,
  MessageFlags,
} = require("discord.js");
const { CUSTOM_IDS } = require("../constants/customIds");
const {
  buildCaptchaChallengePayload,
  buildCaptchaResultPayload,
  withEphemeralComponentsV2,
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
const DEFAULT_CHALLENGE_DESCRIPTION =
  "Selecione o codigo que aparece na imagem acima.";
const DEFAULT_SUCCESS_MESSAGE =
  "Verificacao concluida com sucesso. Bem-vindo ao servidor!";

function memberHasAnyRole(member, roleIds = []) {
  if (!member?.roles?.cache || !Array.isArray(roleIds) || !roleIds.length) {
    return false;
  }
  return roleIds.some((roleId) => member.roles.cache.has(roleId));
}

function buildCaptchaFailureResult(message) {
  return buildCaptchaResultPayload({
    title: "Verificacao nao concluida",
    message,
    tone: "error",
  });
}

function buildCaptchaSuccessResult(message) {
  return buildCaptchaResultPayload({
    title: "Verificacao concluida",
    message,
    tone: "success",
  });
}

function normalizeChallengeDescription(settings, extraLine = "") {
  const base =
    String(settings?.challenge_description || "").trim() ||
    DEFAULT_CHALLENGE_DESCRIPTION;
  const extra = String(extraLine || "").trim();
  return extra ? `${base}\n\n${extra}` : base;
}

function extractPayloadFallbackText(payload, fallback = "") {
  const components = Array.isArray(payload?.components) ? payload.components : [];

  for (const component of components) {
    if (component?.type === 10 && component.content) {
      return String(component.content).replace(/^#+\s*/gm, "").trim();
    }

    if (Array.isArray(component?.components)) {
      const nested = extractPayloadFallbackText(
        { components: component.components },
        "",
      );
      if (nested) return nested;
    }
  }

  return fallback;
}

async function replyCaptchaMessage(interaction, payload) {
  await interaction.reply(withEphemeralComponentsV2(payload));
}

async function acknowledgeCaptchaVerifyInteraction(interaction) {
  if (interaction.deferred || interaction.replied) return;
  await interaction.deferUpdate();
}

async function replaceCaptchaVerifyMessage(interaction, payload, files = []) {
  const normalizedPayload = withEphemeralComponentsV2(payload);
  const requestPayload = {
    ...normalizedPayload,
    files,
  };

  try {
    await interaction.editReply(requestPayload);
    return;
  } catch (editError) {
    console.warn("[captcha-verify-edit]", editError?.message || editError);
  }

  if (!interaction.deferred && !interaction.replied) {
    try {
      await interaction.update(requestPayload);
      return;
    } catch (updateError) {
      console.warn("[captcha-verify-update]", updateError?.message || updateError);
    }
  }

  const fallbackText = extractPayloadFallbackText(
    normalizedPayload,
    "Nao foi possivel atualizar a verificacao. Clique em Iniciar novamente.",
  );

  await interaction
    .editReply({
      content: fallbackText,
      embeds: [],
      components: [],
      files: [],
    })
    .catch(async () => {
      if (interaction.replied || interaction.deferred) {
        await interaction
          .followUp({
            content: fallbackText,
            flags: MessageFlags.Ephemeral,
          })
          .catch(() => null);
      }
    });
}

async function sendCaptchaVerificationLog({ guild, member, settings }) {
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
    await replyCaptchaMessage(
      interaction,
      buildCaptchaFailureResult(
        "O modulo de captcha esta indisponivel neste servidor no momento.",
      ),
    );
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
    await replyCaptchaMessage(
      interaction,
      buildCaptchaSuccessResult("Voce ja esta verificado neste servidor."),
    );
    return;
  }

  if (memberHasAnyRole(member, bypassRoleIds)) {
    await assignVerifiedRoles(member, verifiedRoleIds);
    await replyCaptchaMessage(
      interaction,
      buildCaptchaSuccessResult(
        "Seu cargo permite pular a verificacao. Acesso liberado.",
      ),
    );
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
      description: normalizeChallengeDescription(settings),
      attachmentName: CAPTCHA_ATTACHMENT_NAME,
      options: optionCodes,
    }),
    files: [attachment],
  });
}

async function handleCaptchaVerifyInteraction(interaction) {
  const guildId = interaction.guildId;
  if (!guildId) return;

  try {
    await acknowledgeCaptchaVerifyInteraction(interaction);

    const runtime = await getGuildCaptchaRuntime(guildId);
    const settings = runtime?.settings;

    if (!runtime?.licenseUsable || !settings?.enabled) {
      await replaceCaptchaVerifyMessage(
        interaction,
        buildCaptchaFailureResult(
          "O modulo de captcha esta indisponivel neste servidor no momento.",
        ),
      );
      return;
    }

    const selectedCode = String(interaction.values?.[0] || "").trim();
    const session = await getGuildCaptchaSession(guildId, interaction.user.id);

    if (!session) {
      await replaceCaptchaVerifyMessage(
        interaction,
        buildCaptchaFailureResult(
          "Nenhuma verificacao ativa foi encontrada. Clique em Iniciar novamente.",
        ),
      );
      return;
    }

    if (new Date(session.expires_at).getTime() <= Date.now()) {
      await deleteGuildCaptchaSession(guildId, interaction.user.id);
      await replaceCaptchaVerifyMessage(
        interaction,
        buildCaptchaFailureResult(
          "O tempo da verificacao expirou. Clique em Iniciar novamente.",
        ),
      );
      return;
    }

    const correctCode = String(session.correct_code || "").trim();

    if (selectedCode && selectedCode === correctCode) {
      await deleteGuildCaptchaSession(guildId, interaction.user.id);
      await assignVerifiedRoles(interaction.member, settings.verified_role_ids);
      await sendCaptchaVerificationLog({
        guild: interaction.guild,
        member: interaction.member,
        settings,
      });

      await replaceCaptchaVerifyMessage(
        interaction,
        buildCaptchaSuccessResult(
          String(settings.success_message || "").trim() || DEFAULT_SUCCESS_MESSAGE,
        ),
      );
      return;
    }

    const attemptsRemaining = Math.max(
      0,
      Number(session.attempts_remaining || 0) - 1,
    );

    if (attemptsRemaining <= 0) {
      await deleteGuildCaptchaSession(guildId, interaction.user.id);

      if (settings.kick_on_fail && interaction.member?.kickable) {
        await interaction.member
          .kick("Falhou na verificacao de captcha.")
          .catch(() => null);
      }

      await replaceCaptchaVerifyMessage(
        interaction,
        buildCaptchaFailureResult(
          "Voce esgotou as tentativas de verificacao. Tente novamente mais tarde.",
        ),
      );
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

    await replaceCaptchaVerifyMessage(
      interaction,
      buildCaptchaChallengePayload({
        title: settings.challenge_title,
        description: normalizeChallengeDescription(
          settings,
          `Codigo incorreto. Tentativas restantes: **${attemptsRemaining}**.`,
        ),
        attachmentName: CAPTCHA_ATTACHMENT_NAME,
        options: nextOptionCodes,
      }),
      [attachment],
    );
  } catch (error) {
    console.error("[captcha-verify]", error);
    await replaceCaptchaVerifyMessage(
      interaction,
      buildCaptchaFailureResult(
        "Nao foi possivel concluir a verificacao. Clique em Iniciar novamente.",
      ),
    );
  }
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
