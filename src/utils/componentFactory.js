const { MessageFlags, SeparatorSpacingSize } = require("discord.js");
const { CUSTOM_IDS } = require("../constants/customIds");

const DEFAULT_TICKET_PANEL_TITLE = "Abrir atendimento";
const DEFAULT_TICKET_PANEL_DESCRIPTION =
  "Escolha uma opcao abaixo para falar com a equipe responsavel.";
const DEFAULT_TICKET_PANEL_BUTTON_LABEL = "Abrir ticket";

const DISABLED_TICKET_MESSAGE =
  "O sistema de tickets esta indisponivel neste servidor no momento.\nContate a administracao caso ache que isso e um erro e informe a **Flowdesk**.";
const TICKET_MODULE_DISABLED_MESSAGE =
  "A abertura de tickets foi desativada pela administracao deste servidor no momento.\nTente novamente mais tarde ou fale com a equipe responsavel.";
const TICKET_LICENSE_UNAVAILABLE_MESSAGE =
  "O sistema de tickets nao pode abrir atendimentos neste servidor agora porque a licenca do modulo esta indisponivel no momento.\nContate a administracao caso ache que isso e um erro e informe a **Flowdesk**.";

const COMPONENT_TYPE = {
  ACTION_ROW: 1,
  BUTTON: 2,
  STRING_SELECT: 3,
  SECTION: 9,
  TEXT_DISPLAY: 10,
  THUMBNAIL: 11,
  MEDIA_GALLERY: 12,
  SEPARATOR: 14,
  CONTAINER: 17,
};

const BUTTON_STYLE = {
  PRIMARY: 1,
  SECONDARY: 2,
  SUCCESS: 3,
  DANGER: 4,
  LINK: 5,
};

const MESSAGE_FLAG_IS_COMPONENTS_V2 = 32768;
const WELCOME_TOKEN_REGEX = /\{(user\.id|user\.tag|user\.avatar|user|inviter|server\.id|server|memberCount)\}/g;
const USER_THUMBNAIL_ACCESSORY_TYPES = new Set([
  "user_thumbnail",
  "user-thumbnail",
  "user_avatar",
  "user-avatar",
  "userthumbnail",
  "useravatar",
  "avatar",
]);

function trimText(value, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function clampText(value, maxLength) {
  return String(value || "").slice(0, maxLength);
}

function stripMarkdownDecorators(value) {
  return String(value || "")
    .replace(/^\s{0,3}(?:#{1,6}|-#)\s*/, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .trim();
}

function getCandidateString(candidate, key, fallback, maxLength) {
  if (typeof candidate?.[key] === "string") {
    return clampText(candidate[key], maxLength);
  }

  return clampText(fallback, maxLength);
}

function normalizeAccessoryType(value) {
  return trimText(value).toLowerCase();
}

function sanitizeButtonStyle(value) {
  if (
    value === "primary" ||
    value === "secondary" ||
    value === "success" ||
    value === "danger"
  ) {
    return value;
  }

  return "primary";
}

function sanitizeSeparatorSpacing(value) {
  if (value === "sm" || value === "md" || value === "lg") {
    return value;
  }

  return "md";
}

function sanitizeButtonEmoji(value) {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, 120);
}

function parseButtonEmojiMarkup(value) {
  const normalized = sanitizeButtonEmoji(value);
  if (!normalized) return null;

  const customMatch = normalized.match(/^<(a?):([a-zA-Z0-9_]+):(\d{17,20})>$/);
  if (customMatch) {
    return {
      kind: "custom",
      animated: customMatch[1] === "a",
      name: customMatch[2],
      id: customMatch[3],
    };
  }

  return {
    kind: "unicode",
    name: normalized,
  };
}

function buildDiscordButtonEmojiPayload(value) {
  const parsed = parseButtonEmojiMarkup(value);
  if (!parsed) return undefined;

  if (parsed.kind === "custom") {
    return {
      id: parsed.id,
      name: parsed.name,
      animated: parsed.animated,
    };
  }

  return { name: parsed.name };
}

function sanitizeAccentColor(value) {
  const normalized = trimText(value);
  if (!normalized) return "";
  return /^#(?:[0-9a-fA-F]{6})$/.test(normalized) ? normalized : "";
}

function buildMarkdownFromLegacy(legacy) {
  const title = trimText(legacy?.panelTitle) || DEFAULT_TICKET_PANEL_TITLE;
  const description =
    trimText(legacy?.panelDescription) || DEFAULT_TICKET_PANEL_DESCRIPTION;

  return [`## ${title}`, description].filter(Boolean).join("\n");
}

function createDefaultTicketPanelLayout(legacy) {
  const buttonLabel =
    trimText(legacy?.panelButtonLabel) || DEFAULT_TICKET_PANEL_BUTTON_LABEL;

  return [
    {
      id: "content_default",
      type: "content",
      markdown: buildMarkdownFromLegacy(legacy),
      accessory: null,
    },
    {
      id: "separator_default",
      type: "separator",
      spacing: "md",
    },
        {
          id: "button_default",
          type: "button",
          label: buttonLabel,
          emoji: "",
          style: "primary",
          disabled: false,
        },
  ];
}

function normalizeSelectOptions(value) {
  if (!Array.isArray(value)) return [];

  return value
    .map((option, index) => {
      if (!option || typeof option !== "object") return null;
      return {
        id: trimText(option.id) || `option_${index + 1}`,
        label: getCandidateString(option, "label", "", 80),
        description: getCandidateString(option, "description", "", 160),
      };
    })
    .filter(Boolean);
}

function normalizeContentAccessory(value) {
  if (!value || typeof value !== "object") return null;
  const accessoryType = normalizeAccessoryType(value.type);

  if (accessoryType === "thumbnail") {
    return {
      type: "thumbnail",
      imageUrl: getCandidateString(value, "imageUrl", "", 1000),
      alt: getCandidateString(value, "alt", "", 120),
    };
  }

  if (USER_THUMBNAIL_ACCESSORY_TYPES.has(accessoryType)) {
    return {
      type: "user_thumbnail",
      alt: getCandidateString(value, "alt", "Foto do usuario", 120),
    };
  }

  if (accessoryType === "link_button") {
    return {
      type: "link_button",
      label: getCandidateString(value, "label", "Abrir link", 80),
      emoji: sanitizeButtonEmoji(value.emoji),
      url: getCandidateString(value, "url", "https://flowdesk.com.br", 1000),
    };
  }

  if (accessoryType === "button") {
    return {
      type: "button",
      label: getCandidateString(value, "label", "Acao", 80),
      emoji: sanitizeButtonEmoji(value.emoji),
      style: sanitizeButtonStyle(value.style),
      disabled: Boolean(value.disabled),
    };
  }

  return null;
}

function normalizeContentComponent(candidate, legacy) {
  const markdownFromField = getCandidateString(candidate, "markdown", "", 4000);
  const contentFromField = getCandidateString(candidate, "content", "", 4000);
  const title = getCandidateString(candidate, "title", "", 120);
  const description = getCandidateString(candidate, "description", "", 1200);
  const fallbackMarkdown = buildMarkdownFromLegacy(legacy);

  const markdown =
    markdownFromField ||
    contentFromField ||
    (title || description
      ? [title ? `## ${title}` : "", description].filter(Boolean).join("\n")
      : fallbackMarkdown);

  return {
    id: trimText(candidate.id) || "content_runtime",
    type: "content",
    markdown: clampText(markdown, 4000),
    accessory: normalizeContentAccessory(candidate.accessory),
  };
}

function normalizeNonContainerComponent(value, legacy) {
  if (!value || typeof value !== "object") return null;
  const type = value.type;

  switch (type) {
    case "content":
      return normalizeContentComponent(value, legacy);
    case "image":
      return {
        id: trimText(value.id) || "image_runtime",
        type,
        url: getCandidateString(value, "url", "", 1000),
        alt: "",
      };
    case "file":
      return {
        id: trimText(value.id) || "file_runtime",
        type,
        name: getCandidateString(value, "name", "Arquivo-flowdesk.pdf", 120),
        sizeLabel: getCandidateString(value, "sizeLabel", "PDF | 1.2 MB", 60),
      };
    case "separator":
      return {
        id: trimText(value.id) || "separator_runtime",
        type,
        spacing: sanitizeSeparatorSpacing(value.spacing),
      };
    case "button":
      return {
        id: trimText(value.id) || "button_runtime",
        type,
        label: getCandidateString(
          value,
          "label",
          DEFAULT_TICKET_PANEL_BUTTON_LABEL,
          80,
        ),
        emoji: sanitizeButtonEmoji(value.emoji),
        style: sanitizeButtonStyle(value.style),
        disabled: Boolean(value.disabled),
      };
    case "link_button":
      return {
        id: trimText(value.id) || "link_runtime",
        type,
        label: getCandidateString(value, "label", "Abrir link", 80),
        emoji: sanitizeButtonEmoji(value.emoji),
        url: getCandidateString(value, "url", "https://flowdesk.com.br", 1000),
      };
    case "select":
      return {
        id: trimText(value.id) || "select_runtime",
        type,
        placeholder: getCandidateString(
          value,
          "placeholder",
          "Escolha uma opcao",
          100,
        ),
        options: normalizeSelectOptions(value.options),
      };
    default:
      return null;
  }
}

function normalizeContainerChildren(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((child) => normalizeNonContainerComponent(child))
    .filter(Boolean);
}

function normalizeTicketPanelLayout(value, legacy) {
  if (!Array.isArray(value) || value.length === 0) {
    return createDefaultTicketPanelLayout(legacy);
  }

  const normalized = value
    .map((component) => {
      if (!component || typeof component !== "object") return null;

      if (component.type === "container") {
        let children = normalizeContainerChildren(component.children);

        if (
          children.length === 0 &&
          (trimText(component.title) || trimText(component.description))
        ) {
          children = [normalizeContentComponent(component, legacy)].filter(Boolean);
        }

        return {
          id: trimText(component.id) || "container_runtime",
          type: "container",
          accentColor: sanitizeAccentColor(component.accentColor),
          children,
        };
      }

      return normalizeNonContainerComponent(component, legacy);
    })
    .filter(Boolean);

  return normalized.length ? normalized : createDefaultTicketPanelLayout(legacy);
}

function resolveUserTag(user) {
  if (!user) return "";
  if (typeof user.tag === "string" && user.tag.trim()) return user.tag.trim();
  const username = trimText(user.username);
  const discriminator = trimText(user.discriminator);
  if (username && discriminator && discriminator !== "0") {
    return `${username}#${discriminator}`;
  }
  return username;
}

function resolveMemberAvatarUrl(member) {
  if (!member) return "";
  const avatarOptions = { size: 256, extension: "png", forceStatic: false };
  if (typeof member.displayAvatarURL === "function") {
    return member.displayAvatarURL(avatarOptions);
  }
  if (member.user && typeof member.user.displayAvatarURL === "function") {
    return member.user.displayAvatarURL(avatarOptions);
  }
  if (member.user && typeof member.user.avatarURL === "function") {
    return member.user.avatarURL(avatarOptions) || "";
  }
  return "";
}

function buildWelcomeTokenMap({ member, guild, inviter }) {
  const user = member?.user || member;
  const userId = trimText(user?.id);
  const inviterId = trimText(inviter?.id);
  const username = trimText(user?.username) || trimText(member?.displayName);
  const userTag = resolveUserTag(user) || username || "usuario";
  const avatarUrl = resolveMemberAvatarUrl(member);
  const guildName = trimText(guild?.name) || "servidor";
  const guildId = trimText(guild?.id);
  const memberCount =
    typeof guild?.memberCount === "number" && Number.isFinite(guild.memberCount)
      ? String(guild.memberCount)
      : "";

  return {
    "user": userId ? `<@${userId}>` : "usuario",
    "user.id": userId || "",
    "user.tag": userTag,
    "user.avatar": avatarUrl || "",
    "inviter": inviterId ? `<@${inviterId}>` : "Convite nao identificado",
    "server": guildName,
    "server.id": guildId || "",
    "memberCount": memberCount,
  };
}

function replaceWelcomeTokens(value, tokenMap) {
  if (typeof value !== "string") return value;
  return value.replace(WELCOME_TOKEN_REGEX, (match, token) => {
    if (token && tokenMap[token] !== undefined) {
      return tokenMap[token];
    }
    return match;
  });
}

function resolveWelcomeUserAvatarUrl(tokenMap, thumbnailOverrideUrl) {
  return trimText(thumbnailOverrideUrl) || trimText(tokenMap?.["user.avatar"]);
}

function replaceWelcomeAccessory(accessory, tokenMap, thumbnailOverrideUrl) {
  if (!accessory || typeof accessory !== "object") return accessory;

  if (accessory.type === "thumbnail") {
    return {
      ...accessory,
      imageUrl: thumbnailOverrideUrl || replaceWelcomeTokens(accessory.imageUrl, tokenMap),
    };
  }

  if (accessory.type === "user_thumbnail") {
    return {
      type: "thumbnail",
      imageUrl: resolveWelcomeUserAvatarUrl(tokenMap, thumbnailOverrideUrl),
      alt: replaceWelcomeTokens(accessory.alt || "Foto do usuario", tokenMap),
    };
  }

  if (accessory.type === "link_button") {
    return {
      ...accessory,
      label: replaceWelcomeTokens(accessory.label, tokenMap),
      url: replaceWelcomeTokens(accessory.url, tokenMap),
    };
  }

  if (accessory.type === "button") {
    return {
      ...accessory,
      label: replaceWelcomeTokens(accessory.label, tokenMap),
    };
  }

  return accessory;
}

function applyWelcomeTokensToLayout(layout, tokenMap, thumbnailOverrideUrl) {
  return layout.map((component) => {
    if (!component || typeof component !== "object") return component;

    if (component.type === "container") {
      return {
        ...component,
        children: applyWelcomeTokensToLayout(
          component.children || [],
          tokenMap,
          thumbnailOverrideUrl,
        ),
      };
    }

    if (component.type === "content") {
      return {
        ...component,
        markdown: replaceWelcomeTokens(component.markdown, tokenMap),
        accessory: replaceWelcomeAccessory(
          component.accessory,
          tokenMap,
          thumbnailOverrideUrl,
        ),
      };
    }

    if (component.type === "image") {
      return {
        ...component,
        url: replaceWelcomeTokens(component.url, tokenMap),
      };
    }

    if (component.type === "file") {
      return {
        ...component,
        name: replaceWelcomeTokens(component.name, tokenMap),
        sizeLabel: replaceWelcomeTokens(component.sizeLabel, tokenMap),
      };
    }

    if (component.type === "button" || component.type === "link_button") {
      return {
        ...component,
        label: replaceWelcomeTokens(component.label, tokenMap),
        url: component.type === "link_button"
          ? replaceWelcomeTokens(component.url, tokenMap)
          : component.url,
      };
    }

    if (component.type === "select") {
      return {
        ...component,
        placeholder: replaceWelcomeTokens(component.placeholder, tokenMap),
        options: Array.isArray(component.options)
          ? component.options.map((option) => ({
              ...option,
              label: replaceWelcomeTokens(option.label, tokenMap),
              description: replaceWelcomeTokens(option.description, tokenMap),
            }))
          : component.options,
      };
    }

    return component;
  });
}

function resolveButtonStyle(style) {
  switch (style) {
    case "secondary":
      return BUTTON_STYLE.SECONDARY;
    case "success":
      return BUTTON_STYLE.SUCCESS;
    case "danger":
      return BUTTON_STYLE.DANGER;
    default:
      return BUTTON_STYLE.PRIMARY;
  }
}

function buildTextContent(markdown) {
  const safeMarkdown = trimText(markdown);
  return safeMarkdown || `## ${DEFAULT_TICKET_PANEL_TITLE}`;
}

function buildTextDisplay(content) {
  return {
    type: COMPONENT_TYPE.TEXT_DISPLAY,
    content,
  };
}

function buildButton(component, state, options = {}) {
  const customId = trimText(options.customId) || CUSTOM_IDS.openTicket;
  const disableNonLink = Boolean(options.disableNonLink);
  const emoji = buildDiscordButtonEmojiPayload(component.emoji);

  if (component.type === "link_button") {
    return {
      type: COMPONENT_TYPE.BUTTON,
      style: BUTTON_STYLE.LINK,
      label: trimText(component.label) || "Abrir link",
      url: trimText(component.url) || "https://flowdesk.com.br",
      ...(emoji ? { emoji } : {}),
    };
  }

  state.hasInteractiveOpenAction = true;
  return {
    type: COMPONENT_TYPE.BUTTON,
    custom_id: customId,
    style: resolveButtonStyle(component.style),
    label: trimText(component.label) || DEFAULT_TICKET_PANEL_BUTTON_LABEL,
    disabled: disableNonLink || Boolean(component.disabled),
    ...(emoji ? { emoji } : {}),
  };
}

function chunkButtons(buttons) {
  const rows = [];
  for (let index = 0; index < buttons.length; index += 5) {
    rows.push({
      type: COMPONENT_TYPE.ACTION_ROW,
      components: buttons.slice(index, index + 5),
    });
  }
  return rows;
}

function buildSelectRow(component, actionOptions = {}) {
  const selectOptions = (
    component.options?.length
      ? component.options
      : [{ id: "fallback", label: "Opcao", description: "" }]
  ).slice(0, 25);
  const customId = trimText(actionOptions.customId) || "ticket:preview:select";
  const disabled =
    typeof actionOptions.disabled === "boolean" ? actionOptions.disabled : true;

  return {
    type: COMPONENT_TYPE.ACTION_ROW,
    components: [
      {
        type: COMPONENT_TYPE.STRING_SELECT,
        custom_id: customId,
        placeholder: trimText(component.placeholder) || "Escolha uma opcao",
        disabled,
        options: selectOptions.map((option, index) => ({
          label: trimText(option.label) || `Opcao ${index + 1}`,
          description: trimText(option.description) || undefined,
          value: trimText(option.id) || `option_${index + 1}`,
        })),
      },
    ],
  };
}

function addActionsToComponents(target, actions, state, actionOptions = {}) {
  const bufferedButtons = [];

  const flushButtons = () => {
    if (!bufferedButtons.length) return;
    target.push(...chunkButtons(bufferedButtons.splice(0, bufferedButtons.length)));
  };

  for (const action of actions) {
    if (action.type === "select") {
      flushButtons();
      target.push(buildSelectRow(action, actionOptions));
      continue;
    }

    bufferedButtons.push(buildButton(action, state, actionOptions));
  }

  flushButtons();
}

function addContentComponent(target, content, state, actionOptions = {}) {
  const textContent = buildTextContent(content.markdown);

  if (!content.accessory) {
    target.push(buildTextDisplay(textContent));
    return;
  }

  if (content.accessory.type === "thumbnail" && trimText(content.accessory.imageUrl)) {
    target.push({
      type: COMPONENT_TYPE.SECTION,
      components: [buildTextDisplay(textContent)],
      accessory: {
        type: COMPONENT_TYPE.THUMBNAIL,
        media: {
          url: trimText(content.accessory.imageUrl),
        },
      },
    });
    return;
  }

  if (
    (content.accessory.type === "button" ||
      content.accessory.type === "link_button") &&
    (content.accessory.type !== "link_button" || trimText(content.accessory.url))
  ) {
    target.push({
      type: COMPONENT_TYPE.SECTION,
      components: [buildTextDisplay(textContent)],
      accessory: buildButton(content.accessory, state, actionOptions),
    });
    return;
  }

  target.push(buildTextDisplay(textContent));
}

function mapSeparatorSpacing(spacing) {
  return spacing === "lg" ? 2 : 1;
}

function addDisplayComponent(target, component, state, actionOptions = {}) {
  if (component.type === "content") {
    addContentComponent(target, component, state, actionOptions);
    return;
  }

  if (component.type === "image" && trimText(component.url)) {
    target.push({
      type: COMPONENT_TYPE.MEDIA_GALLERY,
      items: [
        {
          media: {
            url: trimText(component.url),
          },
        },
      ],
    });
    return;
  }

  if (component.type === "file") {
    const fileText = [
      `### ${trimText(component.name) || "Arquivo"}`,
      trimText(component.sizeLabel) ? `-# ${trimText(component.sizeLabel)}` : "",
    ]
      .filter(Boolean)
      .join("\n");
    target.push(buildTextDisplay(fileText));
    return;
  }

  if (component.type === "separator") {
    target.push({
      type: COMPONENT_TYPE.SEPARATOR,
      divider: true,
      spacing: mapSeparatorSpacing(component.spacing),
    });
  }
}

function buildComponentList(components, state, actionOptions = {}) {
  const built = [];
  let pendingActions = [];

  const flushPendingActions = () => {
    if (!pendingActions.length) return;
    addActionsToComponents(built, pendingActions, state, actionOptions);
    pendingActions = [];
  };

  for (const component of components) {
    if (!component) continue;

    if (
      component.type === "button" ||
      component.type === "link_button" ||
      component.type === "select"
    ) {
      pendingActions.push(component);
      continue;
    }

    flushPendingActions();

    if (component.type === "container") {
      built.push({
        type: COMPONENT_TYPE.CONTAINER,
        accent_color: trimText(component.accentColor)
          ? Number.parseInt(trimText(component.accentColor).slice(1), 16)
          : undefined,
        components: buildComponentList(component.children || [], state, actionOptions),
      });
      continue;
    }

    addDisplayComponent(built, component, state, actionOptions);
  }

  flushPendingActions();
  return built;
}

function deriveLegacyFromLayout(layout, legacy) {
  let firstContent = null;
  let firstAction = null;

  const visit = (component) => {
    if (!component || (firstContent && firstAction)) return;

    if (component.type === "container") {
      for (const child of component.children || []) {
        visit(child);
      }
      return;
    }

    if (!firstContent && component.type === "content" && trimText(component.markdown)) {
      firstContent = component;
    }

    if (
      !firstAction &&
      (component.type === "button" ||
        component.type === "link_button" ||
        component.type === "select")
    ) {
      firstAction = component;
    }
  };

  for (const component of layout) {
    visit(component);
  }

  const markdownLines = String(firstContent?.markdown || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const firstMeaningfulLine = markdownLines[0] || "";
  const titleCandidate = stripMarkdownDecorators(firstMeaningfulLine);
  const descriptionCandidate = markdownLines
    .slice(1)
    .map((line) => stripMarkdownDecorators(line))
    .filter(Boolean)
    .join("\n")
    .trim();

  return {
    panelTitle: clampText(
      titleCandidate || legacy?.panelTitle || DEFAULT_TICKET_PANEL_TITLE,
      80,
    ),
    panelDescription: clampText(
      descriptionCandidate ||
        legacy?.panelDescription ||
        DEFAULT_TICKET_PANEL_DESCRIPTION,
      400,
    ),
    panelButtonLabel: clampText(
      (firstAction && (firstAction.placeholder || firstAction.label)) ||
        legacy?.panelButtonLabel ||
        DEFAULT_TICKET_PANEL_BUTTON_LABEL,
      40,
    ),
  };
}

function buildTicketPanelPayload({ settings, title, description, buttonLabel }) {
  const legacy = {
    panelTitle:
      trimText(settings?.panel_title) ||
      trimText(title) ||
      DEFAULT_TICKET_PANEL_TITLE,
    panelDescription:
      trimText(settings?.panel_description) ||
      trimText(description) ||
      DEFAULT_TICKET_PANEL_DESCRIPTION,
    panelButtonLabel:
      trimText(settings?.panel_button_label) ||
      trimText(buttonLabel) ||
      DEFAULT_TICKET_PANEL_BUTTON_LABEL,
  };

  const layout = normalizeTicketPanelLayout(settings?.panel_layout, legacy);
  const derived = deriveLegacyFromLayout(layout, legacy);
  const state = { hasInteractiveOpenAction: false };
  const components = buildComponentList(layout, state);

  if (!state.hasInteractiveOpenAction) {
    components.push({
      type: COMPONENT_TYPE.ACTION_ROW,
      components: [
        {
          type: COMPONENT_TYPE.BUTTON,
          custom_id: CUSTOM_IDS.openTicket,
          style: BUTTON_STYLE.PRIMARY,
          label: derived.panelButtonLabel || DEFAULT_TICKET_PANEL_BUTTON_LABEL,
        },
      ],
    });
  }

  return {
    flags: MESSAGE_FLAG_IS_COMPONENTS_V2,
    components,
    allowedMentions: { parse: [] },
  };
}

function buildCaptchaPanelPayload({ settings, title, description, buttonLabel }) {
  const legacy = {
    panelTitle:
      trimText(settings?.panel_title) ||
      trimText(title) ||
      "Iniciar captcha",
    panelDescription:
      trimText(settings?.panel_description) ||
      trimText(description) ||
      "Complete a verificacao abaixo para liberar o acesso aos canais.",
    panelButtonLabel:
      trimText(settings?.panel_button_label) ||
      trimText(buttonLabel) ||
      "Iniciar captcha",
  };

  const layout = normalizeTicketPanelLayout(settings?.panel_layout, legacy);
  const derived = deriveLegacyFromLayout(layout, legacy);
  const state = { hasInteractiveOpenAction: false };
  const actionOptions = { customId: CUSTOM_IDS.startCaptcha };
  const components = buildComponentList(layout, state, actionOptions);

  if (!state.hasInteractiveOpenAction) {
    components.push({
      type: COMPONENT_TYPE.ACTION_ROW,
      components: [
        {
          type: COMPONENT_TYPE.BUTTON,
          custom_id: CUSTOM_IDS.startCaptcha,
          style: BUTTON_STYLE.PRIMARY,
          label: derived.panelButtonLabel || "Iniciar captcha",
        },
      ],
    });
  }

  return {
    flags: MESSAGE_FLAG_IS_COMPONENTS_V2,
    components,
    allowedMentions: { parse: [] },
  };
}

function withEphemeralComponentsV2(payload = {}) {
  return {
    ...payload,
    flags: (payload.flags ?? MESSAGE_FLAG_IS_COMPONENTS_V2) | MessageFlags.Ephemeral,
    allowedMentions: { parse: [] },
  };
}

function buildCaptchaResultPayload({ title, message, tone = "neutral" }) {
  const safeTitle = trimText(title) || "Verificacao";
  const safeMessage =
    trimText(message) ||
    "Atualizacao da verificacao concluida. Clique em Iniciar novamente se precisar.";

  return withEphemeralComponentsV2({
    components: [
      {
        type: COMPONENT_TYPE.CONTAINER,
        accent_color: resolveTicketMessageToneColor(tone),
        components: [
          {
            type: COMPONENT_TYPE.TEXT_DISPLAY,
            content: [`### ${safeTitle}`, safeMessage].join("\n\n"),
          },
        ],
      },
    ],
  });
}

function buildCaptchaChallengePayload({
  title,
  description,
  attachmentName,
  options,
}) {
  const safeTitle = trimText(title) || "Verificacao de seguranca";
  const safeDescription =
    trimText(description) ||
    "Selecione o codigo que aparece na imagem acima.";
  const safeOptions = Array.isArray(options) ? options.slice(0, 5) : [];
  const selectOptions = safeOptions
    .map((code) => String(code || "").trim())
    .filter(Boolean)
    .slice(0, 5)
    .map((code) => ({
      label: code,
      value: code,
    }));

  const components = [
    {
      type: COMPONENT_TYPE.CONTAINER,
      accent_color: 0x5865f2,
      components: [
        {
          type: COMPONENT_TYPE.TEXT_DISPLAY,
          content: [`### ${safeTitle}`, safeDescription].join("\n\n"),
        },
        {
          type: COMPONENT_TYPE.MEDIA_GALLERY,
          items: [
            {
              media: {
                url: `attachment://${trimText(attachmentName) || "captcha.png"}`,
              },
            },
          ],
        },
      ],
    },
  ];

  if (selectOptions.length) {
    components.push({
      type: COMPONENT_TYPE.ACTION_ROW,
      components: [
        {
          type: COMPONENT_TYPE.STRING_SELECT,
          custom_id: CUSTOM_IDS.verifyCaptcha,
          placeholder: "Escolha o codigo correto",
          min_values: 1,
          max_values: 1,
          options: selectOptions,
        },
      ],
    });
  }

  return withEphemeralComponentsV2({ components });
}

function buildWelcomeMessagePayload({
  layout,
  fallbackMarkdown,
  member,
  guild,
  inviter,
  thumbnailMode,
}) {
  const baseLayout =
    Array.isArray(layout) && layout.length
      ? normalizeTicketPanelLayout(layout)
      : [
          {
            id: "welcome_default",
            type: "content",
            markdown: trimText(fallbackMarkdown) || "Bem-vindo!",
            accessory: null,
          },
        ];

  const tokenMap = buildWelcomeTokenMap({ member, guild, inviter });
  const thumbnailOverrideUrl =
    thumbnailMode === "avatar" ? resolveMemberAvatarUrl(member) : "";
  const hydratedLayout = applyWelcomeTokensToLayout(
    baseLayout,
    tokenMap,
    thumbnailOverrideUrl,
  );
  const state = { hasInteractiveOpenAction: false };
  const components = buildComponentList(hydratedLayout, state, {
    customId: "welcome:disabled",
    disableNonLink: true,
  });

  const allowedUsers = [];
  const userId = trimText(member?.user?.id || member?.id);
  const inviterId = trimText(inviter?.id);
  if (userId) allowedUsers.push(userId);
  if (inviterId) allowedUsers.push(inviterId);

  return {
    flags: MESSAGE_FLAG_IS_COMPONENTS_V2,
    components,
    allowedMentions: allowedUsers.length ? { users: allowedUsers } : { parse: [] },
  };
}

function buildTicketSystemDisabledPayload(input = {}) {
  const reason = trimText(input.reason) || "system_unavailable";

  if (reason === "module_disabled") {
    return {
      flags: MessageFlags.IsComponentsV2,
      components: [
        {
          type: COMPONENT_TYPE.CONTAINER,
          accent_color: resolveTicketMessageToneColor("warning"),
          components: [
            {
              type: COMPONENT_TYPE.TEXT_DISPLAY,
              content: [
                "### Ticket desativado no momento",
                TICKET_MODULE_DISABLED_MESSAGE,
              ].join("\n\n"),
            },
            {
              type: COMPONENT_TYPE.SEPARATOR,
              spacing: SeparatorSpacingSize.Small,
              divider: true,
            },
            {
              type: COMPONENT_TYPE.TEXT_DISPLAY,
              content:
                "-# O Flowdesk respeita essa configuracao automaticamente e bloqueia novas aberturas ate o modulo ser reativado.",
            },
          ],
        },
      ],
      allowedMentions: { parse: [] },
    };
  }

  if (reason === "license_unavailable") {
    return {
      flags: MessageFlags.IsComponentsV2,
      components: [
        {
          type: COMPONENT_TYPE.CONTAINER,
          accent_color: resolveTicketMessageToneColor("error"),
          components: [
            {
              type: COMPONENT_TYPE.TEXT_DISPLAY,
              content: [
                "### Sistema indisponivel",
                TICKET_LICENSE_UNAVAILABLE_MESSAGE,
              ].join("\n\n"),
            },
            {
              type: COMPONENT_TYPE.SEPARATOR,
              spacing: SeparatorSpacingSize.Small,
              divider: true,
            },
            {
              type: COMPONENT_TYPE.TEXT_DISPLAY,
              content:
                "-# Assim que a administracao regularizar o modulo no painel, a abertura de tickets volta a funcionar automaticamente.",
            },
          ],
        },
      ],
      allowedMentions: { parse: [] },
    };
  }

  return buildTicketSimpleMessagePayload({
    title: "Sistema indisponivel",
    message: DISABLED_TICKET_MESSAGE,
    tone: "error",
  });
}

function resolveTicketMessageToneColor(tone) {
  switch (tone) {
    case "success":
      return 0x2ecc71;
    case "warning":
      return 0xf1c40f;
    case "error":
      return 0xe74c3c;
    default:
      return 0x2b2d31;
  }
}

function buildTicketSimpleMessagePayload(input) {
  const normalizedInput =
    typeof input === "string"
      ? {
          message: input,
          title: "",
          tone: "neutral",
          hint: "",
          buttonLabel: "",
          buttonUrl: "",
        }
      : {
          message: String(input?.message || "").trim(),
          title: String(input?.title || "").trim(),
          tone: input?.tone || "neutral",
          hint: String(input?.hint || "").trim(),
          buttonLabel: String(input?.buttonLabel || "").trim(),
          buttonUrl: String(input?.buttonUrl || "").trim(),
        };

  const description = [
    normalizedInput.title ? `### ${normalizedInput.title}` : "",
    normalizedInput.message,
  ]
    .filter(Boolean)
    .join("\n\n")
    .trim();

  const containerComponents = [
    {
      type: COMPONENT_TYPE.TEXT_DISPLAY,
      content: description,
    },
  ];

  const hint = stripMarkdownDecorators(normalizedInput.hint);
  const hasLinkButton = normalizedInput.buttonLabel && normalizedInput.buttonUrl;

  if (hint || hasLinkButton) {
    containerComponents.push({
      type: COMPONENT_TYPE.SEPARATOR,
      divider: true,
      spacing: SeparatorSpacingSize.Small,
    });
  }

  if (hint) {
    containerComponents.push({
      type: COMPONENT_TYPE.TEXT_DISPLAY,
      content: `-# ${hint}`,
    });
  }

  if (hasLinkButton) {
    containerComponents.push({
      type: COMPONENT_TYPE.ACTION_ROW,
      components: [
        {
          type: COMPONENT_TYPE.BUTTON,
          style: BUTTON_STYLE.LINK,
          label: normalizedInput.buttonLabel,
          url: normalizedInput.buttonUrl,
        },
      ],
    });
  }

  return {
    flags: MessageFlags.IsComponentsV2,
    components: [
      {
        type: COMPONENT_TYPE.CONTAINER,
        accent_color: resolveTicketMessageToneColor(normalizedInput.tone),
        components: containerComponents,
      },
    ],
    allowedMentions: { parse: [] },
  };
}

function formatTicketNumber(ticketId) {
  return `#${String(ticketId || 0).padStart(4, "0")}`;
}

function sanitizeTicketReasonBlock(reason) {
  return String(reason || "")
    .replace(/```/g, "'''")
    .trim();
}

function buildTicketIntroPayload({ ticket } = {}) {
  const ticketNumber = ticket?.id ? formatTicketNumber(ticket.id) : "#0000";
  const protocol = String(ticket?.protocol || "").trim();
  const userId = String(ticket?.user_id || "").trim();
  const claimedBy = String(ticket?.claimed_by || "").trim();
  const openedReason = sanitizeTicketReasonBlock(ticket?.opened_reason);
  const openedAt = ticket?.opened_at
    ? new Date(ticket.opened_at).toLocaleString("pt-BR", {
        timeZone: "America/Sao_Paulo",
      })
    : "";
  const baseLines = [
    `### Ticket aberto ${ticketNumber}`,
    "",
    "Explique o que voce precisa com o maximo de detalhes. Nossa equipe foi notificada e vai responder por aqui.",
    "",
    protocol ? `-# Protocolo: \`${protocol}\`` : "",
    userId ? `-# Solicitante: <@${userId}>` : "",
    claimedBy ? `-# Staff: <@${claimedBy}>` : `-# Staff: \`nao assumido\``,
    userId ? `-# ID do usuario: \`${userId}\`` : "",
    openedAt ? `-# Aberto em: \`${openedAt}\`` : "",
    openedReason ? `> \`\`\`${openedReason}\`\`\`` : "",
  ].filter(Boolean);

  return {
    flags: MessageFlags.IsComponentsV2,
    components: [
      {
        type: COMPONENT_TYPE.CONTAINER,
        accent_color: resolveTicketMessageToneColor("neutral"),
        components: [
          {
            type: COMPONENT_TYPE.TEXT_DISPLAY,
            content: baseLines.join("\n"),
          },
          {
            type: COMPONENT_TYPE.SEPARATOR,
            divider: true,
            spacing: SeparatorSpacingSize.Small,
          },
          {
            type: COMPONENT_TYPE.ACTION_ROW,
            components: [
              {
                type: COMPONENT_TYPE.BUTTON,
                custom_id: CUSTOM_IDS.ticketAdminPanel,
                style: BUTTON_STYLE.SECONDARY,
                label: "Painel Admin",
              },
              {
                type: COMPONENT_TYPE.BUTTON,
                custom_id: CUSTOM_IDS.ticketStaffPanel,
                style: BUTTON_STYLE.SECONDARY,
                label: "Painel Staff",
              },
              {
                type: COMPONENT_TYPE.BUTTON,
                custom_id: CUSTOM_IDS.ticketMemberPanel,
                style: BUTTON_STYLE.SECONDARY,
                label: "Painel do membro",
              },
            ],
          },
          {
            type: COMPONENT_TYPE.ACTION_ROW,
            components: [
              {
                type: COMPONENT_TYPE.BUTTON,
                custom_id: CUSTOM_IDS.closeTicket,
                style: BUTTON_STYLE.DANGER,
                label: "Encerrar atendimento",
              },
            ],
          },
        ],
      },
    ],
    allowedMentions: { parse: [] },
  };
}

function buildSuggestionPanelPayload({ settings, title, description, buttonLabel }) {
  const legacy = {
    panelTitle:
      trimText(settings?.panel_title) ||
      trimText(title) ||
      "Sugestoes",
    panelDescription:
      trimText(settings?.panel_description) ||
      trimText(description) ||
      "Envie sua sugestao para a equipe do servidor.",
    panelButtonLabel:
      trimText(settings?.panel_button_label) ||
      trimText(buttonLabel) ||
      "Iniciar Sugestao",
  };

  const layout = normalizeTicketPanelLayout(settings?.panel_layout, legacy);
  const derived = deriveLegacyFromLayout(layout, legacy);
  const state = { hasInteractiveOpenAction: false };
  const actionOptions = { customId: CUSTOM_IDS.startSuggestion };
  const components = buildComponentList(layout, state, actionOptions);

  if (!state.hasInteractiveOpenAction) {
    components.push({
      type: COMPONENT_TYPE.ACTION_ROW,
      components: [
        {
          type: COMPONENT_TYPE.BUTTON,
          custom_id: CUSTOM_IDS.startSuggestion,
          style: BUTTON_STYLE.PRIMARY,
          label: derived.panelButtonLabel || "Iniciar Sugestao",
        },
      ],
    });
  }

  return {
    flags: MESSAGE_FLAG_IS_COMPONENTS_V2,
    components,
    allowedMentions: { parse: [] },
  };
}

function formatVotePercentage(count, total) {
  if (!total) return "0.00";
  return ((count / total) * 100).toFixed(2);
}

function buildSuggestionVoteCustomId(type, suggestionId) {
  return `suggestion:vote:${type}:${suggestionId}`;
}

function buildPublishedSuggestionPayload({
  suggestion,
  settings,
  authorMention,
  voteLabels,
}) {
  const header =
    trimText(settings?.published_header) || "NOVA SUGESTAO ENVIADA!";
  const footer =
    trimText(settings?.published_footer) || "Flowdesk | Sistema de sugestoes";
  const safeTitle = trimText(suggestion?.title) || "Sugestao";
  const safeBody = trimText(suggestion?.body) || "";
  const authorLine = authorMention
    ? `-# Enviada por ${authorMention}`
    : suggestion?.author_user_id
      ? `-# Enviada por <@${suggestion.author_user_id}>`
      : "";

  const yesVotes = Number(suggestion?.yes_votes || 0);
  const noVotes = Number(suggestion?.no_votes || 0);
  const totalVotes = yesVotes + noVotes;

  const yesLabel =
    voteLabels?.yes ||
    `✅ ${yesVotes} ${yesVotes === 1 ? "voto" : "votos"} | (${formatVotePercentage(yesVotes, totalVotes)}%)`;
  const noLabel =
    voteLabels?.no ||
    `❌ ${noVotes} ${noVotes === 1 ? "voto" : "votos"} | (${formatVotePercentage(noVotes, totalVotes)}%)`;
  const detailsLabel = voteLabels?.details || "?";

  const suggestionId = suggestion?.id;

  return {
    flags: MESSAGE_FLAG_IS_COMPONENTS_V2,
    components: [
      {
        type: COMPONENT_TYPE.CONTAINER,
        accent_color: 0x00bcd4,
        components: [
          {
            type: COMPONENT_TYPE.TEXT_DISPLAY,
            content: [
              `## 💡 ${header}`,
              "",
              `### ${safeTitle}`,
              safeBody,
              authorLine,
              `-# ${footer}`,
            ]
              .filter(Boolean)
              .join("\n"),
          },
        ],
      },
      {
        type: COMPONENT_TYPE.ACTION_ROW,
        components: [
          {
            type: COMPONENT_TYPE.BUTTON,
            custom_id: buildSuggestionVoteCustomId("yes", suggestionId),
            style: BUTTON_STYLE.SUCCESS,
            label: clampText(yesLabel, 80),
          },
          {
            type: COMPONENT_TYPE.BUTTON,
            custom_id: buildSuggestionVoteCustomId("no", suggestionId),
            style: BUTTON_STYLE.DANGER,
            label: clampText(noLabel, 80),
          },
          {
            type: COMPONENT_TYPE.BUTTON,
            custom_id: buildSuggestionVoteCustomId("details", suggestionId),
            style: BUTTON_STYLE.SECONDARY,
            label: clampText(detailsLabel, 80),
          },
        ],
      },
    ],
    allowedMentions: { parse: ["users"] },
  };
}

function buildSuggestionVoteDetailsPayload({
  suggestion,
  yesVoters,
  noVoters,
  settings,
}) {
  const safeTitle = trimText(suggestion?.title) || "Sugestao";
  const safeBody = trimText(suggestion?.body) || "";
  const yesVotes = Number(suggestion?.yes_votes || 0);
  const noVotes = Number(suggestion?.no_votes || 0);
  const totalVotes = yesVotes + noVotes;

  const yesList = Array.isArray(yesVoters) && yesVoters.length
    ? yesVoters.map((userId) => `<@${userId}>`).join(", ")
    : "Nenhum voto a favor ainda.";
  const noList = Array.isArray(noVoters) && noVoters.length
    ? noVoters.map((userId) => `<@${userId}>`).join(", ")
    : "Nenhum voto contra ainda.";

  const footer =
    trimText(settings?.published_footer) || "Flowdesk | Sistema de sugestoes";

  return withEphemeralComponentsV2({
    components: [
      {
        type: COMPONENT_TYPE.CONTAINER,
        accent_color: 0x00bcd4,
        components: [
          {
            type: COMPONENT_TYPE.TEXT_DISPLAY,
            content: [
              `## Detalhes da sugestao`,
              "",
              `### ${safeTitle}`,
              safeBody,
              "",
              `**Total de votos:** ${totalVotes}`,
              `**A favor:** ${yesVotes} (${formatVotePercentage(yesVotes, totalVotes)}%)`,
              `**Contra:** ${noVotes} (${formatVotePercentage(noVotes, totalVotes)}%)`,
              "",
              `**Votaram a favor:**`,
              yesList,
              "",
              `**Votaram contra:**`,
              noList,
              "",
              `-# ${footer}`,
            ].join("\n"),
          },
        ],
      },
    ],
  });
}

function buildLogPayload({
  accentColor,
  title,
  lines,
  linkUrl,
  linkLabel,
  actionLabel,
  actionDisabled = false,
}) {
  const containerComponents = [
    {
      type: COMPONENT_TYPE.TEXT_DISPLAY,
      content: [`## ${title.trim()}`, lines.join("\n")].filter(Boolean).join("\n\n"),
    },
  ];

  if (trimText(linkUrl)) {
    containerComponents.push({
      type: COMPONENT_TYPE.SEPARATOR,
      divider: true,
      spacing: SeparatorSpacingSize.Small,
    });
    containerComponents.push({
      type: COMPONENT_TYPE.ACTION_ROW,
      components: [
        {
          type: COMPONENT_TYPE.BUTTON,
          style: BUTTON_STYLE.LINK,
          label: trimText(linkLabel) || "Abrir transcript",
          url: trimText(linkUrl),
        },
      ],
    });
  } else if (trimText(actionLabel)) {
    containerComponents.push({
      type: COMPONENT_TYPE.SEPARATOR,
      divider: true,
      spacing: SeparatorSpacingSize.Small,
    });
    containerComponents.push({
      type: COMPONENT_TYPE.ACTION_ROW,
      components: [
        {
          type: COMPONENT_TYPE.BUTTON,
          style: BUTTON_STYLE.SECONDARY,
          label: trimText(actionLabel),
          custom_id: "flowdesk:transcript:unavailable",
          disabled: Boolean(actionDisabled),
        },
      ],
    });
  }

  return {
    flags: MessageFlags.IsComponentsV2,
    components: [
      {
        type: COMPONENT_TYPE.CONTAINER,
        accent_color:
          Number.isFinite(accentColor) && accentColor > 0
            ? accentColor
            : resolveTicketMessageToneColor("neutral"),
        components: containerComponents,
      },
    ],
    allowedMentions: { parse: [] },
  };
}

function buildTicketClosureDmPayload({
  ticket,
  transcriptUrl,
  accessCode,
  closedBy,
  transcriptAvailable = false,
  transcriptReason = "insufficient_messages",
}) {
  const formattedAccessCode = String(accessCode || "").trim();
  const unavailableText =
    transcriptReason === "generation_failed"
      ? "por falha ao gerar o historico agora"
      : "por falta de mensagens suficientes";
  const lines = [
    `### Ticket fechado ${formatTicketNumber(ticket?.id)}`,
    "",
    ticket?.protocol ? `-# Protocolo: \`${ticket.protocol}\`` : "",
    ticket?.user_id ? `-# Solicitante: <@${ticket.user_id}>` : "",
    closedBy ? `-# Fechado por: <@${closedBy}>` : "",
    transcriptAvailable
      ? "O transcript deste atendimento esta protegido por senha."
      : `O transcript deste atendimento ficou indisponivel ${unavailableText}.`,
    transcriptAvailable && formattedAccessCode
      ? `**Codigo de acesso:** \`${formattedAccessCode}\``
      : "",
    transcriptAvailable
      ? "-# O botao abaixo ja abre o transcript com o codigo preenchido. Depois da validacao, a sessao fica liberada por 10 minutos."
      : "",
  ].filter(Boolean);

  return {
    flags: MessageFlags.IsComponentsV2,
    components: [
      {
        type: COMPONENT_TYPE.CONTAINER,
        accent_color: resolveTicketMessageToneColor(
          transcriptAvailable ? "warning" : "neutral",
        ),
        components: [
          {
            type: COMPONENT_TYPE.TEXT_DISPLAY,
            content: lines.join("\n"),
          },
          {
            type: COMPONENT_TYPE.SEPARATOR,
            divider: true,
            spacing: SeparatorSpacingSize.Small,
          },
          {
            type: COMPONENT_TYPE.ACTION_ROW,
            components: [
              trimText(transcriptUrl) && transcriptAvailable
                ? {
                    type: COMPONENT_TYPE.BUTTON,
                    style: BUTTON_STYLE.LINK,
                    label: "Abrir transcript",
                    url: trimText(transcriptUrl),
                  }
                : {
                    type: COMPONENT_TYPE.BUTTON,
                    style: BUTTON_STYLE.SECONDARY,
                    label: "Transcript indisponivel",
                    custom_id: "flowdesk:transcript:unavailable",
                    disabled: true,
                  },
            ],
          },
        ],
      },
    ],
    allowedMentions: { parse: [] },
  };
}

function buildAiSuggestionPayload({ suggestion, guildName }) {
  const footerLine = `-# <:flowdesk_icon:1485070577982116000> Todos os direitos reservados (c) 2026 **Flowdesk®**. **FlowAI** pode cometer erros confira todas as informações geradas. Esta é uma sugestão automática. Se não resolveu, clique em "**Continuar com ticket**".`;

  return {
    flags: MessageFlags.IsComponentsV2,
    components: [
      {
        type: COMPONENT_TYPE.CONTAINER,
        accent_color: resolveTicketMessageToneColor("neutral"),
        components: [
          {
            type: COMPONENT_TYPE.TEXT_DISPLAY,
            content: `## Sugestão do assistente`,
          },
          {
            type: COMPONENT_TYPE.SEPARATOR,
            divider: true,
            spacing: SeparatorSpacingSize.Small,
          },
          {
            type: COMPONENT_TYPE.TEXT_DISPLAY,
            content: suggestion,
          },
          {
            type: COMPONENT_TYPE.SEPARATOR,
            divider: true,
            spacing: SeparatorSpacingSize.Small,
          },
          {
            type: COMPONENT_TYPE.TEXT_DISPLAY,
            content: footerLine,
          },
        ],
      },
      {
        type: COMPONENT_TYPE.ACTION_ROW,
        components: [
          {
            type: COMPONENT_TYPE.BUTTON,
            style: BUTTON_STYLE.SECONDARY,
            label: "Ajudou, Não abrir ticket",
            custom_id: CUSTOM_IDS.aiSuggestionHelped,
          },
          {
            type: COMPONENT_TYPE.BUTTON,
            style: BUTTON_STYLE.PRIMARY,
            label: "Continuar com ticket",
            custom_id: CUSTOM_IDS.aiSuggestionContinue,
          },
        ],
      },
    ],
    allowedMentions: { parse: [] },
  };
}

module.exports = {
  buildTicketPanelPayload,
  buildCaptchaPanelPayload,
  buildSuggestionPanelPayload,
  buildPublishedSuggestionPayload,
  buildSuggestionVoteDetailsPayload,
  buildCaptchaChallengePayload,
  buildCaptchaResultPayload,
  withEphemeralComponentsV2,
  buildWelcomeMessagePayload,
  buildTicketSimpleMessagePayload,
  buildTicketSystemDisabledPayload,
  buildTicketIntroPayload,
  buildLogPayload,
  buildTicketClosureDmPayload,
  buildAiSuggestionPayload,
};
