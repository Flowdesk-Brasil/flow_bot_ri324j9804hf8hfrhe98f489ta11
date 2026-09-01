const {
  AttachmentBuilder,
  MessageFlags,
  PermissionsBitField,
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
  normalizeCaptchaCode,
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
  "Selecione o codigo (letras e numeros) que aparece na imagem acima.";
const DEFAULT_SUCCESS_MESSAGE =
  "Verificacao concluida com sucesso. Bem-vindo ao servidor!";

function normalizeRoleIds(value) {
  if (!value) return [];
  const raw = Array.isArray(value) ? value : [value];
  return raw.map((roleId) => String(roleId || "").trim()).filter(Boolean);
}

function memberHasAnyRole(member, roleIds = []) {
  const normalizedRoleIds = normalizeRoleIds(roleIds);
  if (!member?.roles?.cache || !normalizedRoleIds.length) {
    return false;
  }
  return normalizedRoleIds.some((roleId) => member.roles.cache.has(roleId));
}

async function resolveGuildMember(guild, memberRef) {
  if (!guild) return null;

  const userId =
    typeof memberRef === "string"
      ? memberRef
      : memberRef?.id || memberRef?.user?.id;

  if (!userId) return null;

  const cachedMember = guild.members.cache.get(userId);
  if (cachedMember) return cachedMember;

  return guild.members.fetch(userId).catch(() => null);
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

  const verifiedRoles = normalizeRoleIds(settings.verified_role_ids);
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

async function assignVerifiedRoles(guild, memberRef, roleIds = []) {
  const normalizedRoleIds = normalizeRoleIds(roleIds);
  if (!normalizedRoleIds.length) {
    return { ok: false, reason: "no_roles_configured", added: [] };
  }

  const member = await resolveGuildMember(guild, memberRef);
  if (!member) {
    return { ok: false, reason: "member_not_found", added: [] };
  }

  const me =
    guild.members.me || (await guild.members.fetchMe().catch(() => null));
  if (!me?.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
    console.error("[captcha-roles] bot sem permissao ManageRoles");
    return { ok: false, reason: "missing_manage_roles", added: [] };
  }

  await guild.roles.fetch().catch(() => null);

  const assignableRoleIds = normalizedRoleIds.filter((roleId) => {
    if (roleId === guild.id) return false;
    const role = guild.roles.cache.get(roleId);
    if (!role || role.managed) return false;
    if (!me.roles?.highest) return false;
    return me.roles.highest.comparePositionTo(role) > 0;
  });

  if (!assignableRoleIds.length) {
    console.error("[captcha-roles] nenhum cargo atribuivel", {
      guildId: guild.id,
      configuredRoleIds: normalizedRoleIds,
      botHighestRole: me.roles?.highest?.id || null,
    });
    return { ok: false, reason: "no_assignable_roles", added: [] };
  }

  const missingRoleIds = assignableRoleIds.filter(
    (roleId) => !member.roles.cache.has(roleId),
  );

  if (!missingRoleIds.length) {
    return { ok: true, reason: "already_has_roles", added: [] };
  }

  try {
    await member.roles.add(missingRoleIds, "Captcha verificado");
    return { ok: true, reason: "added", added: missingRoleIds };
  } catch (error) {
    console.error("[captcha-roles] falha ao adicionar cargo", error);
    return {
      ok: false,
      reason: "add_failed",
      added: [],
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function buildRoleAssignmentNotice(roleResult) {
  if (!roleResult || roleResult.ok) return "";

  switch (roleResult.reason) {
    case "no_roles_configured":
      return "Nenhum cargo de verificado esta configurado no painel.";
    case "missing_manage_roles":
      return "O bot nao tem permissao de **Gerenciar cargos**.";
    case "no_assignable_roles":
      return "O cargo de verificado esta acima do cargo do bot ou e invalido.";
    case "add_failed":
      return "Nao foi possivel aplicar o cargo automaticamente. Contate a equipe.";
    default:
      return "Nao foi possivel aplicar o cargo de verificado.";
  }
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
  const verifiedRoleIds = normalizeRoleIds(settings.verified_role_ids);
  const bypassRoleIds = normalizeRoleIds(settings.bypass_role_ids);

  if (memberHasAnyRole(member, verifiedRoleIds)) {
    await replyCaptchaMessage(
      interaction,
      buildCaptchaSuccessResult("Voce ja esta verificado neste servidor."),
    );
    return;
  }

  if (memberHasAnyRole(member, bypassRoleIds)) {
    await assignVerifiedRoles(interaction.guild, member, verifiedRoleIds);
    await replyCaptchaMessage(
      interaction,
      buildCaptchaSuccessResult(
        "Seu cargo permite pular a verificacao. Acesso liberado.",
      ),
    );
    return;
  }

  const correctCode = generateCaptchaCode();
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

    const selectedCode = normalizeCaptchaCode(interaction.values?.[0]);
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

    const correctCode = normalizeCaptchaCode(session.correct_code);

    if (selectedCode && selectedCode === correctCode) {
      await deleteGuildCaptchaSession(guildId, interaction.user.id);
      const roleResult = await assignVerifiedRoles(
        interaction.guild,
        interaction.user.id,
        settings.verified_role_ids,
      );
      await sendCaptchaVerificationLog({
        guild: interaction.guild,
        member:
          (await resolveGuildMember(interaction.guild, interaction.user.id)) ||
          interaction.member,
        settings,
      });

      let successMessage =
        String(settings.success_message || "").trim() || DEFAULT_SUCCESS_MESSAGE;
      const roleNotice = buildRoleAssignmentNotice(roleResult);
      if (roleNotice) {
        successMessage = `${successMessage}\n\n${roleNotice}`;
      }

      await replaceCaptchaVerifyMessage(
        interaction,
        buildCaptchaSuccessResult(successMessage),
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

    const nextCorrectCode = generateCaptchaCode();
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
