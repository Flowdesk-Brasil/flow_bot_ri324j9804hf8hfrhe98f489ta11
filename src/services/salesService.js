const crypto = require("node:crypto");
const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
} = require("discord.js");
const { createClient } = require("@supabase/supabase-js");
const { env } = require("../config/env");

const supabase = createClient(env.supabaseUrl, env.supabaseServiceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

const PRODUCT_SELECT =
  "id, guild_id, title, description, media_urls, price_amount, inventory_tracked, stock_quantity, sku, status, active, published_point_of_sale, published_virtual_store";
const CART_SELECT =
  "id, guild_id, discord_user_id, discord_channel_id, auth_user_id, status, subtotal_amount, total_amount, discount_id, discount_code, discount_kind, discount_amount, discount_snapshot, provider_payment_id, provider_status, provider_status_detail, provider_ticket_url, provider_qr_code, provider_qr_base64, payment_expires_at, discord_notification_sent_at";

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
const COMPONENTS_V2_FLAG = MessageFlags.IsComponentsV2 || 32768;
const cartQuantityUpdateQueues = new Map();

function unwrap(result, operation) {
  if (result.error) {
    throw new Error(`[Supabase] Falha em "${operation}": ${result.error.message}`);
  }
  return result.data;
}

function buildProductCode(id) {
  const digits = String(id || "").replace(/\D/g, "");
  const seed =
    digits ||
    Array.from(String(id || ""))
      .reduce((acc, char) => `${acc}${char.charCodeAt(0)}`, "");
  return `prd-${seed.padEnd(8, "0").slice(0, 8)}`;
}

function normalizeProductCode(value) {
  const code = String(value || "").trim().toLowerCase();
  return /^prd-[0-9]{8}$/.test(code) ? code : "";
}

function createCheckoutToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function hashCheckoutToken(token) {
  return crypto.createHash("sha256").update(String(token || "").trim()).digest("hex");
}

function formatMoney(value) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(Number(value || 0));
}

function roundMoney(value) {
  return Number(Math.max(0, Number(value || 0)).toFixed(2));
}

function normalizeDiscountCode(value) {
  return String(value || "")
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

function truncateText(value, maxLength) {
  const text = String(value || "").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function textDisplay(content) {
  return {
    type: COMPONENT_TYPE.TEXT_DISPLAY,
    content: truncateText(content, 3900),
  };
}

function buildProductUnavailableReply(productCode) {
  return {
    flags: MessageFlags.Ephemeral | COMPONENTS_V2_FLAG,
    components: [
      {
        type: COMPONENT_TYPE.CONTAINER,
        accent_color: 0xdb4646,
        components: [
          textDisplay(
            [
              "## Produto indisponivel",
              "Este produto foi removido do catalogo ou esta indisponivel no momento.",
              productCode
                ? `Codigo: \`${productCode}\``
                : "Atualize a loja do servidor para ver os produtos ativos.",
            ].join("\n"),
          ),
        ],
      },
    ],
  };
}

function enqueueCartQuantityUpdate(key, task) {
  const previous = cartQuantityUpdateQueues.get(key) || Promise.resolve();
  const next = previous.catch(() => null).then(task);
  const cleanup = next.catch(() => null).finally(() => {
    if (cartQuantityUpdateQueues.get(key) === cleanup) {
      cartQuantityUpdateQueues.delete(key);
    }
  });
  cartQuantityUpdateQueues.set(key, cleanup);
  return next;
}

async function acknowledgeEphemeralInteraction(interaction, context) {
  if (interaction.deferred || interaction.replied) return true;
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    return true;
  } catch (error) {
    console.warn("[salesService] Falha ao reconhecer interacao efemera.", {
      context,
      interactionId: interaction.id,
      customId: interaction.customId,
      ageMs: Date.now() - interaction.createdTimestamp,
      message: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

async function respondEphemeralInteraction(interaction, content) {
  try {
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content });
      return;
    }
    await interaction.reply({ flags: MessageFlags.Ephemeral, content });
  } catch (error) {
    console.warn("[salesService] Falha ao responder interacao efemera.", {
      interactionId: interaction.id,
      customId: interaction.customId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

function formatStockLimitMessage(quantity) {
  const stock = Math.max(0, Math.floor(Number(quantity || 0)));
  if (stock <= 0) return "Este produto esta sem estoque disponivel.";
  return `Este produto so possui ${stock} ${stock === 1 ? "unidade" : "unidades"} em estoque.`;
}

function separator() {
  return {
    type: COMPONENT_TYPE.SEPARATOR,
    divider: true,
    spacing: 1,
  };
}

function actionRow(components) {
  return {
    type: COMPONENT_TYPE.ACTION_ROW,
    components,
  };
}

function button({ customId, label, style = ButtonStyle.Secondary, url, disabled = false }) {
  return {
    type: COMPONENT_TYPE.BUTTON,
    style,
    label: truncateText(label, 80),
    disabled,
    ...(url ? { url } : { custom_id: customId }),
  };
}

function selectMenu({ customId, placeholder, options }) {
  return {
    type: COMPONENT_TYPE.STRING_SELECT,
    custom_id: customId,
    placeholder,
    min_values: 1,
    max_values: 1,
    options,
  };
}

function v2Message(components, extra = {}) {
  return {
    flags: COMPONENTS_V2_FLAG,
    allowedMentions: { parse: [] },
    components,
    ...extra,
  };
}

function sanitizeChannelName(value) {
  const base = String(value || "cliente")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42);
  return `carrinho-${base || "cliente"}`;
}

function checkoutUrl(token) {
  return `${String(env.appUrl || "https://www.flwdesk.com").replace(/\/+$/, "")}/checkout/discord/${encodeURIComponent(token)}`;
}

function deliveryUrl(cartId) {
  return `${String(env.appUrl || "https://www.flwdesk.com").replace(/\/+$/, "")}/checkout/orders/${encodeURIComponent(cartId)}`;
}

function parseSalesCustomId(customId) {
  const parts = String(customId || "").split(":");
  if (parts[0] !== "sales") return null;
  return parts;
}

function isSalesComponentInteraction(interaction) {
  return (
    (interaction.isButton?.() || interaction.isStringSelectMenu?.() || interaction.isModalSubmit?.()) &&
    String(interaction.customId || "").startsWith("sales:")
  );
}

async function getSalesSettings(guildId) {
  const result = await supabase
    .from("guild_sales_settings")
    .select("enabled, carts_category_id")
    .eq("guild_id", guildId)
    .maybeSingle();
  return unwrap(result, "getSalesSettings") || null;
}

async function getActivePaymentMethods(guildId) {
  const result = await supabase
    .from("guild_sales_payment_methods")
    .select("method_key, provider, display_name, payment_rail, status, credentials_configured, last_health_status")
    .eq("guild_id", guildId)
    .eq("status", "active");
  return unwrap(result, "getActivePaymentMethods") || [];
}

function isMercadoPagoPixReady(method) {
  if (!method || method.method_key !== "mercado_pago") return false;
  const provider = String(method.provider || "").trim();
  const rail = String(method.payment_rail || "").trim();
  return (
    method.status === "active" &&
    (method.credentials_configured === true || method.last_health_status !== "failed") &&
    (!provider || provider === "mercado_pago") &&
    (!rail || rail === "pix")
  );
}

function getReadyMercadoPagoMethods(methods) {
  return methods.filter(isMercadoPagoPixReady);
}

function productHasStock(product, quantity = 1) {
  if (product?.inventory_tracked === false) return true;
  return Number(product?.stock_quantity || 0) >= Math.max(1, Number(quantity || 1));
}

async function getAvailableStockQuantity(guildId, productId, fallbackQuantity = 0) {
  const result = await supabase
    .from("guild_sales_stock_items")
    .select("quantity")
    .eq("guild_id", guildId)
    .eq("product_id", productId)
    .eq("status", "available")
    .gt("quantity", 0);

  if (result.error) {
    const message = String(result.error.message || "").toLowerCase();
    if (
      result.error.code === "42P01" ||
      result.error.code === "PGRST205" ||
      message.includes("guild_sales_stock_items")
    ) {
      return {
        quantity: Math.max(0, Number(fallbackQuantity || 0)),
        reliable: false,
      };
    }
    throw new Error(`[Supabase] Falha em "getAvailableStockQuantity": ${result.error.message}`);
  }

  return {
    quantity: (result.data || []).reduce(
      (sum, item) => sum + Math.max(0, Number(item.quantity || 0)),
      0,
    ),
    reliable: true,
  };
}

function isMissingStockSyncRpcError(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || "").toLowerCase();
  return code === "42883" || message.includes("sync_guild_sales_product_stock_quantity");
}

async function getCanonicalAvailableStockQuantity(product) {
  const storedQuantity = Number(product?.stock_quantity || 0);
  if (!product?.guild_id || !product?.id) {
    return { quantity: storedQuantity, reliable: false };
  }

  const rpcResult = await supabase
    .rpc("sync_guild_sales_product_stock_quantity", {
      p_guild_id: product.guild_id,
      p_product_id: product.id,
    });
  if (!rpcResult.error && Number.isFinite(Number(rpcResult.data))) {
    return { quantity: Math.max(0, Number(rpcResult.data || 0)), reliable: true };
  }
  if (rpcResult.error && !isMissingStockSyncRpcError(rpcResult.error)) {
    console.warn("[salesService] Falha ao sincronizar estoque via RPC.", {
      guildId: product.guild_id,
      productId: product.id,
      error: rpcResult.error.message,
    });
  }

  const availableQuantity = await getAvailableStockQuantity(
    product.guild_id,
    product.id,
    storedQuantity,
  );
  if (availableQuantity.reliable) {
    return availableQuantity;
  }

  const freshProduct = await supabase
    .from("guild_sales_products")
    .select("stock_quantity")
    .eq("guild_id", product.guild_id)
    .eq("id", product.id)
    .maybeSingle();
  if (!freshProduct.error && freshProduct.data) {
    return {
      quantity: Math.max(0, Number(freshProduct.data.stock_quantity || 0)),
      reliable: false,
    };
  }

  return availableQuantity;
}

async function productHasEffectiveStock(product, quantity = 1) {
  if (product?.inventory_tracked === false) return true;
  const storedQuantity = Number(product?.stock_quantity || 0);
  const availableQuantity = await getCanonicalAvailableStockQuantity(product);
  const effectiveQuantity = availableQuantity.quantity;
  if (availableQuantity.reliable && availableQuantity.quantity !== storedQuantity) {
    const repairResult = await supabase
      .from("guild_sales_products")
      .update({ stock_quantity: availableQuantity.quantity })
      .eq("guild_id", product.guild_id)
      .eq("id", product.id);
    if (repairResult.error) {
      console.warn("[salesService] Falha ao sincronizar estoque do produto.", {
        guildId: product.guild_id,
        productId: product.id,
        error: repairResult.error.message,
      });
    }
  }
  return effectiveQuantity >= Math.max(1, Number(quantity || 1));
}

async function getProductByCode(guildId, productCode) {
  const result = await supabase
    .from("guild_sales_products")
    .select(PRODUCT_SELECT)
    .eq("guild_id", guildId)
    .limit(500);
  const rows = unwrap(result, "getProductByCode") || [];
  return rows.find((row) => buildProductCode(row.id) === productCode) || null;
}

async function getCart(cartId) {
  const result = await supabase
    .from("guild_sales_carts")
    .select(CART_SELECT)
    .eq("id", cartId)
    .maybeSingle();
  return unwrap(result, "getCart") || null;
}

async function getOpenCartForUser(guildId, discordUserId) {
  const result = await supabase
    .from("guild_sales_carts")
    .select(CART_SELECT)
    .eq("guild_id", guildId)
    .eq("discord_user_id", discordUserId)
    .in("status", ["link_required", "open"])
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return unwrap(result, "getOpenCartForUser") || null;
}

function cartMessageCustomIdExists(components, cartId) {
  if (!Array.isArray(components)) return false;
  for (const component of components) {
    if (!component || typeof component !== "object") continue;
    const customId = component.customId || component.custom_id;
    if (typeof customId === "string" && customId.includes(`:${cartId}`)) return true;
    if (cartMessageCustomIdExists(component.components, cartId)) return true;
    if (component.accessory && cartMessageCustomIdExists([component.accessory], cartId)) return true;
  }
  return false;
}

async function replaceCartChannelMessage(channel, cart, options = {}) {
  if (!channel?.send) return null;
  const items = await getCartItems(cart.id);
  const messages = await channel.messages?.fetch({ limit: 25 }).catch(() => null);
  if (messages) {
    await Promise.all(
      Array.from(messages.values())
        .filter((message) => message.author?.bot && cartMessageCustomIdExists(message.components, cart.id))
        .map((message) => message.delete().catch(() => null)),
    );
  }
  return channel.send(buildCartMessagePayload({
    cart,
    items,
    linked: Boolean(cart.auth_user_id),
    linkUrl: options.linkUrl,
  }));
}

async function getCartItems(cartId) {
  const result = await supabase
    .from("guild_sales_cart_items")
    .select("id, cart_id, guild_id, product_id, quantity, unit_price_amount, total_amount, product_snapshot")
    .eq("cart_id", cartId)
    .order("created_at", { ascending: true });
  return unwrap(result, "getCartItems") || [];
}

async function loadDiscountById(discountId) {
  if (!discountId) return null;
  const result = await supabase
    .from("guild_sales_discounts")
    .select("id, guild_id, kind, code, title, status, discount_type, discount_value, remaining_amount, minimum_order_amount, applies_to_all_products, product_ids, starts_at, expires_at")
    .eq("id", discountId)
    .maybeSingle();
  if (result.error) return null;
  return result.data || null;
}

function isDateWindowActive(startsAt, expiresAt) {
  const now = Date.now();
  if (startsAt) {
    const starts = new Date(startsAt).getTime();
    if (Number.isFinite(starts) && starts > now) return false;
  }
  if (expiresAt) {
    const expires = new Date(expiresAt).getTime();
    if (Number.isFinite(expires) && expires < now) return false;
  }
  return true;
}

function calculateItemsSubtotal(items) {
  return roundMoney(items.reduce((sum, item) => {
    const quantity = Math.max(1, Math.floor(Number(item.quantity || 1)));
    return sum + quantity * Number(item.unit_price_amount || 0);
  }, 0));
}

function calculateDiscountAmount(items, discount) {
  if (!discount || discount.status !== "active") return 0;
  if (!isDateWindowActive(discount.starts_at, discount.expires_at)) return 0;
  const subtotal = calculateItemsSubtotal(items);
  if (subtotal < Number(discount.minimum_order_amount || 0)) return 0;
  const eligibleProductIds = new Set(Array.isArray(discount.product_ids) ? discount.product_ids : []);
  const eligibleSubtotal = discount.applies_to_all_products
    ? subtotal
    : roundMoney(items.reduce((sum, item) => {
        if (!eligibleProductIds.has(item.product_id)) return sum;
        const quantity = Math.max(1, Math.floor(Number(item.quantity || 1)));
        return sum + quantity * Number(item.unit_price_amount || 0);
      }, 0));
  if (eligibleSubtotal <= 0) return 0;
  if (discount.kind === "gift_card") {
    return roundMoney(Math.min(eligibleSubtotal, Number(discount.remaining_amount || 0)));
  }
  if (discount.discount_type === "percent") {
    return roundMoney(eligibleSubtotal * Math.min(100, Number(discount.discount_value || 0)) / 100);
  }
  return roundMoney(Math.min(eligibleSubtotal, Number(discount.discount_value || 0)));
}

async function updateCartTotals(cartId, items) {
  const subtotal = calculateItemsSubtotal(items);
  const currentCart = await getCart(cartId);
  const discount = await loadDiscountById(currentCart?.discount_id);
  const discountAmount = calculateDiscountAmount(items, discount);
  const total = roundMoney(subtotal - discountAmount);
  const result = await supabase
    .from("guild_sales_carts")
    .update({
      subtotal_amount: subtotal,
      total_amount: total,
      discount_id: discountAmount > 0 ? discount.id : null,
      discount_code: discountAmount > 0 ? discount.code : "",
      discount_kind: discountAmount > 0 ? discount.kind : "",
      discount_amount: discountAmount,
      discount_snapshot: discountAmount > 0 ? {
        id: discount.id,
        code: discount.code,
        title: discount.title,
        kind: discount.kind,
      } : {},
    })
    .eq("id", cartId)
    .select(CART_SELECT)
    .single();
  return unwrap(result, "updateCartTotals");
}

function resolveItemProduct(item) {
  const snapshot = item?.product_snapshot && typeof item.product_snapshot === "object"
    ? item.product_snapshot
    : {};
  return {
    title: snapshot.title || "Produto",
    sku: snapshot.sku || "",
    priceAmount: Number(item?.unit_price_amount || 0),
    stockQuantity: Number(snapshot.stockQuantity || 0),
    mediaUrls: Array.isArray(snapshot.mediaUrls) ? snapshot.mediaUrls : [],
  };
}

function buildCartItemsMarkdown(items) {
  if (!items.length) return "Carrinho vazio.";
  return items
    .map((item, index) => {
      const product = resolveItemProduct(item);
      const quantity = Math.max(1, Math.floor(Number(item.quantity || 1)));
      const total = Number(item.total_amount || quantity * product.priceAmount);
      return [
        `**${index + 1}. ${truncateText(product.title, 80)}**`,
        `${product.sku || product.code || "SKU automatico"} - ${quantity} un. x ${formatMoney(product.priceAmount)} = **${formatMoney(total)}**`,
      ].join("\n");
    })
    .join("\n\n");
}

function buildCartTotalsMarkdown(cart) {
  const subtotal = Number(cart.subtotal_amount || cart.total_amount || 0);
  const discountAmount = Number(cart.discount_amount || 0);
  if (discountAmount > 0) {
    return [
      `**Subtotal:** ${formatMoney(subtotal)}`,
      `**Desconto (${cart.discount_code || "cupom/gift"}):** -${formatMoney(discountAmount)}`,
      `**Total:** ${formatMoney(cart.total_amount)}`,
    ].join("\n");
  }
  return `**Total:** ${formatMoney(cart.total_amount)}`;
}

function buildCartMessagePayload({ cart, items, linked, linkUrl }) {
  const title = linked ? "## Carrinho vinculado" : "## Vincule sua compra";
  const subtitle = linked
    ? "A conta Flowdesk foi confirmada. Ajuste as quantidades e prossiga para o pagamento."
    : "Antes do pagamento, confirme no site que este carrinho pertence a sua conta Flowdesk.";
  const controlsDisabled = ["payment_pending", "paid", "delivered", "delivery_failed"].includes(cart.status);
  const components = [
    {
      type: COMPONENT_TYPE.CONTAINER,
      accent_color: linked ? 0x7ce2a0 : 0xf1f1f1,
      components: [
        textDisplay(`${title}\n${subtitle}`),
        separator(),
        textDisplay(buildCartItemsMarkdown(items)),
        separator(),
        textDisplay(buildCartTotalsMarkdown(cart)),
      ],
    },
  ];

  if (!linked && linkUrl) {
    components.push(actionRow([
      button({ label: "Vincular compra", style: ButtonStyle.Link, url: linkUrl }),
      button({ customId: `sales:cart:linked:${cart.id}`, label: "Ja vinculei" }),
    ]));
    return v2Message(components);
  }

  if (linked && !controlsDisabled) {
    for (const item of items.slice(0, 5)) {
      const product = resolveItemProduct(item);
      components.push(actionRow([
        button({ customId: `sales:cart:qty_dec:${cart.id}:${item.id}`, label: "-" }),
        button({
          customId: `sales:cart:item:${cart.id}:${item.id}`,
          label: `${truncateText(product.title, 36)} (${Math.max(1, Number(item.quantity || 1))})`,
          disabled: true,
        }),
        button({ customId: `sales:cart:qty_inc:${cart.id}:${item.id}`, label: "+" }),
      ]));
    }
    components.push(actionRow([
      button({ customId: `sales:cart:discount:${cart.id}`, label: "Adicionar Cupom ou Gift", style: ButtonStyle.Secondary }),
      button({ customId: `sales:cart:checkout:${cart.id}`, label: "Prosseguir", style: ButtonStyle.Success }),
    ]));
  }

  if (cart.status === "payment_pending") {
    components.push(actionRow([
      button({ customId: `sales:cart:check:${cart.id}`, label: "Atualizar status", style: ButtonStyle.Primary }),
    ]));
  }

  return v2Message(components);
}

function buildPaymentSelectionPayload(cart, items, methods) {
  const options = methods
    .filter((method) => method.method_key === "mercado_pago")
    .map((method) => ({
      label: method.display_name || "Mercado Pago",
      description: "PIX automatico",
      value: method.method_key,
    }));

  return v2Message([
    {
      type: COMPONENT_TYPE.CONTAINER,
      accent_color: 0x8fdbff,
      components: [
        textDisplay("## Escolha o metodo de pagamento\nAs quantidades foram bloqueadas para evitar alteracoes enquanto voce escolhe o pagamento."),
        separator(),
        textDisplay(`${buildCartItemsMarkdown(items)}\n\n${buildCartTotalsMarkdown(cart)}`),
      ],
    },
    actionRow([
      selectMenu({
        customId: `sales:cart:payment:${cart.id}`,
        placeholder: "Selecione o metodo de pagamento",
        options,
      }),
    ]),
    actionRow([
      button({ customId: `sales:cart:back:${cart.id}`, label: "Voltar" }),
    ]),
  ]);
}

async function refreshCartMessage(message, cartId, options = {}) {
  const cart = await getCart(cartId);
  if (!cart) return;
  const items = await getCartItems(cartId);
  const linked = Boolean(cart.auth_user_id);
  await message.edit(buildCartMessagePayload({
    cart,
    items,
    linked,
    linkUrl: options.linkUrl,
  })).catch(() => null);
}

async function createCartChannel(interaction, settings) {
  const guild = interaction.guild;
  const botMember = guild.members.me || (await guild.members.fetchMe().catch(() => null));
  return guild.channels.create({
    name: sanitizeChannelName(interaction.user.username),
    type: ChannelType.GuildText,
    parent: settings.carts_category_id || undefined,
    topic: `Carrinho Flowdesk de ${interaction.user.tag} (${interaction.user.id})`,
    permissionOverwrites: [
      {
        id: guild.roles.everyone.id,
        deny: [PermissionFlagsBits.ViewChannel],
      },
      {
        id: interaction.user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
        ],
      },
      ...(botMember
        ? [
            {
              id: botMember.id,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ManageChannels,
                PermissionFlagsBits.ReadMessageHistory,
              ],
            },
          ]
        : []),
    ],
  });
}

async function createCartRecord({ guildId, discordUserId, channelId, product }) {
  const amount = Number(product.price_amount || 0);
  const cartResult = await supabase
    .from("guild_sales_carts")
    .insert({
      guild_id: guildId,
      discord_user_id: discordUserId,
      discord_channel_id: channelId,
      status: "link_required",
      currency: "BRL",
      subtotal_amount: amount,
      total_amount: amount,
    })
    .select(CART_SELECT)
    .single();
  const cart = unwrap(cartResult, "createCartRecord.cart");

  const snapshot = {
    code: buildProductCode(product.id),
    title: product.title,
    sku: product.sku || "",
    priceAmount: amount,
    stockQuantity: Number(product.stock_quantity || 0),
    mediaUrls: Array.isArray(product.media_urls) ? product.media_urls : [],
  };

  const itemResult = await supabase
    .from("guild_sales_cart_items")
    .insert({
      cart_id: cart.id,
      guild_id: guildId,
      product_id: product.id,
      quantity: 1,
      unit_price_amount: amount,
      total_amount: amount,
      product_snapshot: snapshot,
    })
    .select("id")
    .single();
  unwrap(itemResult, "createCartRecord.item");

  const token = createCheckoutToken();
  const linkResult = await supabase
    .from("guild_sales_checkout_links")
    .insert({
      cart_id: cart.id,
      guild_id: guildId,
      discord_user_id: discordUserId,
      token_hash: hashCheckoutToken(token),
      status: "pending",
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    })
    .select("id")
    .single();
  unwrap(linkResult, "createCartRecord.checkoutLink");

  return { cart, token };
}

async function createCheckoutLinkToken(cart) {
  const token = createCheckoutToken();
  const linkResult = await supabase
    .from("guild_sales_checkout_links")
    .insert({
      cart_id: cart.id,
      guild_id: cart.guild_id,
      discord_user_id: cart.discord_user_id,
      token_hash: hashCheckoutToken(token),
      status: "pending",
      expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
    })
    .select("id")
    .single();
  unwrap(linkResult, "createCheckoutLinkToken");
  return token;
}

function buildProductSnapshot(product, amount) {
  return {
    code: buildProductCode(product.id),
    title: product.title,
    sku: product.sku || "",
    priceAmount: amount,
    stockQuantity: Number(product.stock_quantity || 0),
    mediaUrls: Array.isArray(product.media_urls) ? product.media_urls : [],
  };
}

async function addProductToCart(cart, product) {
  const amount = Number(product.price_amount || 0);
  const items = await getCartItems(cart.id);
  const existing = items.find((item) => item.product_id === product.id);
  const currentQuantity = Math.max(0, Number(existing?.quantity || 0));
  if (!(await productHasEffectiveStock(product, currentQuantity + 1))) {
    if (existing) {
      const updatedCart = await updateCartTotals(cart.id, items);
      return { cart: updatedCart, added: false, maxStockReached: true };
    }
    throw new Error("Produto sem estoque disponivel para adicionar outra unidade.");
  }

  if (existing) {
    const nextQuantity = currentQuantity + 1;
    const updateResult = await supabase
      .from("guild_sales_cart_items")
      .update({
        quantity: nextQuantity,
        unit_price_amount: amount,
        total_amount: Number((nextQuantity * amount).toFixed(2)),
        product_snapshot: buildProductSnapshot(product, amount),
      })
      .eq("id", existing.id);
    unwrap(updateResult, "addProductToCart.updateItem");
  } else {
    const insertResult = await supabase
      .from("guild_sales_cart_items")
      .insert({
        cart_id: cart.id,
        guild_id: cart.guild_id,
        product_id: product.id,
        quantity: 1,
        unit_price_amount: amount,
        total_amount: amount,
        product_snapshot: buildProductSnapshot(product, amount),
      });
    unwrap(insertResult, "addProductToCart.insertItem");
  }

  const updatedItems = await getCartItems(cart.id);
  const updatedCart = await updateCartTotals(cart.id, updatedItems);
  return { cart: updatedCart, added: true, maxStockReached: false };
}

async function callSalesInternalApi(action, cartId, extra = {}) {
  if (!env.salesInternalApiToken) {
    throw new Error("SALES_INTERNAL_API_TOKEN/CRON_SECRET nao configurado para o bot.");
  }

  const response = await fetch(env.salesInternalApiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${env.salesInternalApiToken}`,
    },
    body: JSON.stringify({ action, cartId, ...extra }),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload.ok) {
    throw new Error(payload.message || "Falha ao comunicar com checkout interno.");
  }
  return payload;
}

async function showDiscountModal(interaction, cartId) {
  const cart = await getCart(cartId);
  if (!cart || cart.discord_user_id !== interaction.user.id) {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: "Carrinho nao encontrado." });
    return;
  }
  if (!cart.auth_user_id) {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: "Vincule a compra antes de adicionar cupom ou gift." });
    return;
  }
  if (cart.provider_payment_id || cart.status === "payment_pending") {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: "PIX ja foi gerado para este carrinho." });
    return;
  }

  const modal = new ModalBuilder()
    .setCustomId(`sales:cart:discount_submit:${cartId}`)
    .setTitle("Adicionar cupom ou gift");
  const codeInput = new TextInputBuilder()
    .setCustomId("discount_code")
    .setLabel("Codigo do cupom ou gift")
    .setPlaceholder("Ex.: BEMVINDO10")
    .setStyle(TextInputStyle.Short)
    .setRequired(true)
    .setMaxLength(64);
  modal.addComponents(new ActionRowBuilder().addComponents(codeInput));
  await interaction.showModal(modal);
}

async function handleDiscountModalSubmit(interaction, cartId) {
  const code = normalizeDiscountCode(interaction.fields?.getTextInputValue("discount_code"));
  if (!code) {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: "Informe um codigo valido." });
    return;
  }
  const existingCart = await getCart(cartId);
  if (!existingCart || existingCart.discord_user_id !== interaction.user.id) {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: "Carrinho nao encontrado." });
    return;
  }
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    await callSalesInternalApi("apply_discount", cartId, { code });
    const cart = await getCart(cartId);
    await interaction.editReply(
      `Cupom/gift aplicado. Desconto: ${formatMoney(cart?.discount_amount || 0)}. Total: ${formatMoney(cart?.total_amount || 0)}.`,
    );
    const messages = await interaction.channel?.messages?.fetch({ limit: 10 }).catch(() => null);
    const cartMessage = messages
      ? Array.from(messages.values()).find((message) => message.author?.bot && cartMessageCustomIdExists(message.components, cartId))
      : null;
    if (cartMessage) await refreshCartMessage(cartMessage, cartId);
  } catch (error) {
    await interaction.editReply(error instanceof Error ? error.message : "Nao foi possivel aplicar cupom ou gift.");
  }
}

async function handleMissingPayment(interaction) {
  const content =
    "Este servidor ainda nao ativou PIX via Mercado Pago. Peca para um administrador configurar em Vendas > Metodos de pagamento.";
  if (interaction.deferred || interaction.replied) {
    await interaction.editReply(content).catch(() => null);
    return;
  }
  await interaction.reply({ flags: MessageFlags.Ephemeral, content });
}

async function handleAddToCartInteraction(interaction) {
  const parts = parseSalesCustomId(interaction.customId);
  const mode = parts?.[2];
  const productCode = normalizeProductCode(parts?.[3]);
  if (!productCode || (mode !== "add" && mode !== "missing_payment")) return false;

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const guildId = interaction.guildId;
  const settings = await getSalesSettings(guildId);
  if (!settings?.enabled || !settings.carts_category_id) {
    await interaction.editReply(
      "O modulo de vendas ainda nao esta ativo ou a categoria de carrinhos nao foi definida.",
    );
    return true;
  }

  const methods = await getActivePaymentMethods(guildId);
  if (!getReadyMercadoPagoMethods(methods).length) {
    await handleMissingPayment(interaction);
    return true;
  }

  const product = await getProductByCode(guildId, productCode);
  if (!product || product.status !== "active" || product.active === false) {
    await interaction.editReply(buildProductUnavailableReply(productCode));
    return true;
  }
  if (!(await productHasEffectiveStock(product, 1))) {
    await interaction.editReply("Produto sem estoque disponivel.");
    return true;
  }

  const existingCart = await getOpenCartForUser(guildId, interaction.user.id);
  if (existingCart) {
    const addResult = await addProductToCart(existingCart, product);
    const updatedCart = addResult.cart;
    let channel = interaction.guild.channels.cache.get(existingCart.discord_channel_id);
    if (!channel && existingCart.discord_channel_id) {
      channel = await interaction.guild.channels.fetch(existingCart.discord_channel_id).catch(() => null);
    }
    if (!channel) {
      channel = await createCartChannel(interaction, settings);
      const updateResult = await supabase
        .from("guild_sales_carts")
        .update({ discord_channel_id: channel.id })
        .eq("id", existingCart.id)
        .select(CART_SELECT)
        .single();
      Object.assign(updatedCart, unwrap(updateResult, "handleAddToCartInteraction.repairChannel"));
    }
    const token = updatedCart.auth_user_id ? null : await createCheckoutLinkToken(updatedCart);
    await replaceCartChannelMessage(channel, updatedCart, {
      linkUrl: token ? checkoutUrl(token) : null,
    });
    await interaction.editReply(
      addResult.added
        ? `Produto adicionado ao carrinho aberto: ${channel}`
        : `Este produto ja esta no carrinho aberto: ${channel}`,
    );
    return true;
  }

  const channel = await createCartChannel(interaction, settings);
  const { cart, token } = await createCartRecord({
    guildId,
    discordUserId: interaction.user.id,
    channelId: channel.id,
    product,
  });
  const items = await getCartItems(cart.id);
  const linkUrl = checkoutUrl(token);

  await channel.send({
    ...buildCartMessagePayload({ cart, items, linked: false, linkUrl }),
    allowedMentions: { users: [interaction.user.id] },
  });

  await interaction.editReply(`Carrinho criado: ${channel}`);
  return true;
}

async function handleLinkedButton(interaction, cartId) {
  const cart = await getCart(cartId);
  if (!cart || cart.discord_user_id !== interaction.user.id) {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: "Carrinho nao encontrado." });
    return;
  }
  if (!cart.auth_user_id) {
    await interaction.reply({
      flags: MessageFlags.Ephemeral,
      content: "Ainda nao detectei a vinculacao. Confirme no site e clique novamente.",
    });
    return;
  }
  await interaction.deferUpdate();
  await refreshCartMessage(interaction.message, cartId);
}

async function handleQuantityButton(interaction, cartId, direction, itemId = null) {
  const acknowledged = await acknowledgeEphemeralInteraction(
    interaction,
    "sales.cart.quantity",
  );
  if (!acknowledged) return;

  const queueKey = `${cartId}:${itemId || "first"}`;
  try {
    const message = await enqueueCartQuantityUpdate(queueKey, async () => {
      const cart = await getCart(cartId);
      if (!cart || cart.discord_user_id !== interaction.user.id) {
        return "Carrinho nao encontrado.";
      }
      if (!cart.auth_user_id) {
        return "Vincule a compra antes de alterar quantidade.";
      }
      if (cart.status === "payment_pending") {
        return "Pagamento ja foi gerado para este carrinho.";
      }

      const items = await getCartItems(cartId);
      const item = itemId
        ? items.find((entry) => entry.id === itemId)
        : items[0];
      if (!item) {
        return "Carrinho vazio.";
      }
      const productResult = await supabase
        .from("guild_sales_products")
        .select(PRODUCT_SELECT)
        .eq("id", item.product_id)
        .maybeSingle();
      const product = unwrap(productResult, "handleQuantityButton.product");
      if (!product) {
        return "Produto do carrinho nao foi encontrado.";
      }

      const current = Math.max(1, Math.floor(Number(item.quantity || 1)));
      let nextQuantity = direction === "inc" ? current + 1 : current - 1;
      if (direction !== "inc" && current <= 1) {
        return "A quantidade minima e 1 unidade.";
      }

      if (product.inventory_tracked !== false && direction === "inc") {
        const availableStock = await getCanonicalAvailableStockQuantity(product);
        const stock = Math.max(0, Math.floor(Number(availableStock.quantity || 0)));
        if (nextQuantity > stock) {
          return formatStockLimitMessage(stock);
        }
      }

      nextQuantity = Math.max(1, nextQuantity);
      if (
        direction === "inc" &&
        product.inventory_tracked !== false &&
        !(await productHasEffectiveStock(product, nextQuantity))
      ) {
        const availableStock = await getCanonicalAvailableStockQuantity(product);
        return formatStockLimitMessage(availableStock.quantity);
      }

      const unit = Number(item.unit_price_amount || 0);
      const updateResult = await supabase
        .from("guild_sales_cart_items")
        .update({
          quantity: nextQuantity,
          total_amount: Number((nextQuantity * unit).toFixed(2)),
        })
        .eq("id", item.id);
      unwrap(updateResult, "handleQuantityButton.updateItem");

      const updatedItems = await getCartItems(cartId);
      await updateCartTotals(cartId, updatedItems);
      await refreshCartMessage(interaction.message, cartId).catch((error) => {
        console.warn("[salesService] Falha ao atualizar mensagem do carrinho.", {
          cartId,
          itemId: item.id,
          message: error instanceof Error ? error.message : String(error),
        });
      });

      return `Quantidade atualizada para ${nextQuantity}.`;
    });

    await respondEphemeralInteraction(interaction, message);
  } catch (error) {
    console.warn("[salesService] Falha ao atualizar quantidade do carrinho.", {
      cartId,
      itemId,
      direction,
      userId: interaction.user.id,
      message: error instanceof Error ? error.message : String(error),
    });
    await respondEphemeralInteraction(
      interaction,
      "Nao consegui atualizar a quantidade agora. Tente novamente em instantes.",
    );
  }
}

async function handleCheckoutButton(interaction, cartId) {
  const cart = await getCart(cartId);
  if (!cart || cart.discord_user_id !== interaction.user.id) {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: "Carrinho nao encontrado." });
    return;
  }
  if (!cart.auth_user_id) {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: "Vincule a compra antes de pagar." });
    return;
  }
  const methods = await getActivePaymentMethods(cart.guild_id);
  const available = getReadyMercadoPagoMethods(methods);
  if (!available.length) {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: "Nenhum metodo de pagamento ativo com credenciais validas." });
    return;
  }

  const items = await getCartItems(cartId);
  if (!items.length) {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: "Carrinho vazio." });
    return;
  }

  await interaction.update(buildPaymentSelectionPayload(cart, items, available));
}

function buildPixPaymentMessage(cartId, payment) {
  const files = [];
  const body = [
    "## PIX gerado",
    "Pague com o QR Code ou copia e cola. O status sera atualizado automaticamente aqui no carrinho.",
    "",
    `**Valor:** ${formatMoney(payment.amount)}`,
    `**Status:** ${payment.status || "pending"}`,
  ];
  if (payment.qrBase64) {
    const raw = String(payment.qrBase64).replace(/^data:image\/png;base64,/i, "");
    const buffer = Buffer.from(raw, "base64");
    files.push(new AttachmentBuilder(buffer, { name: "pix.png" }));
  }

  if (payment.qrCode) {
    body.push("", "**PIX copia e cola**", `\`\`\`${String(payment.qrCode).slice(0, 990)}\`\`\``);
  }

  const containerComponents = [textDisplay(body.join("\n"))];
  if (payment.qrBase64) {
    containerComponents.push({
      type: COMPONENT_TYPE.MEDIA_GALLERY,
      items: [{ media: { url: "attachment://pix.png" } }],
    });
  }

  const components = [
    {
      type: COMPONENT_TYPE.CONTAINER,
      accent_color: 0x8fdbff,
      components: containerComponents,
    },
    actionRow([
      button({ customId: `sales:cart:check:${cartId}`, label: "Atualizar status", style: ButtonStyle.Primary }),
      ...(payment.ticketUrl
        ? [button({ label: "Abrir Mercado Pago", style: ButtonStyle.Link, url: payment.ticketUrl })]
        : []),
    ]),
  ];

  return v2Message(components, { files });
}

function isFinalUnpaidSalesStatus(status) {
  return ["expired", "rejected", "cancelled", "canceled"].includes(
    String(status || "").trim().toLowerCase(),
  );
}

function resolveFinalPaymentPresentation(status, payment, cart) {
  const normalizedStatus = String(status || cart?.status || payment?.status || "").trim().toLowerCase();
  const providerStatus = String(
    payment?.status || cart?.provider_status || "",
  ).trim().toLowerCase();
  const detail = String(
    payment?.statusDetail ||
      payment?.status_detail ||
      cart?.provider_status_detail ||
      "",
  ).trim().toLowerCase();
  const deadlineExpired =
    normalizedStatus === "expired" ||
    detail.includes("deadline") ||
    detail.includes("expired") ||
    detail.includes("expiration");
  const refunded =
    providerStatus === "refunded" ||
    providerStatus === "charged_back" ||
    detail.includes("refund") ||
    detail.includes("reembols") ||
    detail.includes("chargeback");

  if (refunded) {
    return {
      title: "Pagamento reembolsado",
      description:
        "O Mercado Pago informou que esse pagamento foi reembolsado ou estornado. A compra nao sera entregue por este carrinho.",
      color: 0xffb86b,
      dm:
        "Seu pagamento no carrinho do Discord foi reembolsado ou estornado pelo Mercado Pago. O canal sera fechado e a compra nao foi entregue.",
    };
  }
  if (deadlineExpired) {
    return {
      title: "Pagamento indisponivel",
      description:
        "O prazo para pagar esse PIX acabou. O QR Code e o link do Mercado Pago foram desativados.",
      color: 0xffb86b,
      dm:
        "O prazo para pagar o PIX do seu carrinho no Discord acabou. O canal sera fechado; crie um novo carrinho para tentar novamente.",
    };
  }
  if (normalizedStatus === "rejected") {
    return {
      title: "Pagamento recusado",
      description:
        "O Mercado Pago recusou esse pagamento. O QR Code deste carrinho nao esta mais valido.",
      color: 0xff6b6b,
      dm:
        "O Mercado Pago recusou o pagamento do seu carrinho no Discord. O canal sera fechado; tente novamente criando um novo pagamento.",
    };
  }
  return {
    title: "Pagamento cancelado",
    description:
      "Esse pagamento foi cancelado ou ficou indisponivel no Mercado Pago. O QR Code deste carrinho nao esta mais valido.",
    color: 0xffb86b,
    dm:
      "O pagamento do seu carrinho no Discord foi cancelado ou ficou indisponivel no Mercado Pago. O canal sera fechado.",
  };
}

function buildFinalUnpaidPaymentPayload(cartId, payment, status, cart) {
  const presentation = resolveFinalPaymentPresentation(status, payment, cart);
  return v2Message([
    {
      type: COMPONENT_TYPE.CONTAINER,
      accent_color: presentation.color,
      components: [
        textDisplay([
          `## ${presentation.title}`,
          presentation.description,
          "",
          `**Valor:** ${formatMoney(payment?.amount || cart?.total_amount || 0)}`,
          `**Status:** ${status || payment?.status || cart?.status || "indisponivel"}`,
          "Este canal sera fechado em 20 segundos.",
        ].join("\n")),
      ],
    },
  ], { files: [], attachments: [] });
}

async function acquireFinalUnpaidPaymentNotificationLock(cart, status) {
  const eventKey = `payment_final_unpaid_notified:${String(status || "final").toLowerCase()}`;
  const result = await supabase
    .from("guild_sales_order_events")
    .insert({
      cart_id: cart.id,
      guild_id: cart.guild_id,
      auth_user_id: cart.auth_user_id || null,
      discord_user_id: cart.discord_user_id,
      event_type: "payment_final_unpaid_notified",
      event_key: eventKey,
      event_payload: {
        status,
        providerStatus: cart.provider_status || null,
        providerStatusDetail: cart.provider_status_detail || null,
      },
    })
    .select("id")
    .maybeSingle();

  if (!result.error) return true;
  if (result.error.code === "23505") return false;
  const message = String(result.error.message || "").toLowerCase();
  if (result.error.code === "42P01" || message.includes("guild_sales_order_events")) {
    return true;
  }
  console.warn("[salesService] Falha ao travar notificacao final do pagamento.", result.error.message);
  return true;
}

async function handleFinalUnpaidPayment(interaction, payload, paymentMessage) {
  const cart = payload.cart || {};
  const payment = payload.payment || {};
  const status = cart.status || payment.status || "cancelled";
  const presentation = resolveFinalPaymentPresentation(status, payment, cart);
  const finalPayload = buildFinalUnpaidPaymentPayload(cart.id, payment, status, cart);

  await paymentMessage?.edit(finalPayload).catch(() => null);
  if (!paymentMessage) {
    await interaction.channel?.send(finalPayload).catch(() => null);
  }

  const shouldNotify = await acquireFinalUnpaidPaymentNotificationLock(cart, status);
  if (shouldNotify) {
    await interaction.user.send(v2Message([
      {
        type: COMPONENT_TYPE.CONTAINER,
        accent_color: presentation.color,
        components: [
          textDisplay([
            `## ${presentation.title}`,
            presentation.dm,
            cart.id ? `Pedido: ${cart.id}` : null,
          ].filter(Boolean).join("\n")),
        ],
      },
    ])).catch(() => null);
  }

  setTimeout(() => {
    interaction.channel?.delete("Carrinho Flowdesk encerrado por pagamento indisponivel").catch(() => null);
  }, 20_000);
}

async function deliverApprovedCart(interaction, payload) {
  const deliveries = Array.isArray(payload.deliveries) ? payload.deliveries : [];
  const orderUrl = deliveryUrl(payload.cart.id);
  const user = interaction.user;
  const lockResult = await supabase
    .from("guild_sales_carts")
    .update({
      discord_notification_sent_at: new Date().toISOString(),
      discord_notification_error: "",
    })
    .eq("id", payload.cart.id)
    .is("discord_notification_sent_at", null)
    .select("id")
    .maybeSingle();
  if (lockResult.error) {
    console.warn("[salesService] Falha ao travar notificacao de entrega.", lockResult.error.message);
  }
  if (!lockResult.data && !lockResult.error) {
    return false;
  }

  const receiptEmail =
    typeof payload.user?.email === "string" && payload.user.email.trim()
      ? payload.user.email.trim()
      : null;
  const emailDeliveryCount = deliveries.filter(
    (delivery) => delivery.deliveryMethod === "email" && delivery.status !== "failed",
  ).length;
  const discordDeliveryCount = deliveries.filter(
    (delivery) => delivery.deliveryMethod !== "email" || delivery.status === "failed",
  ).length;
  await user.send(v2Message([
    {
      type: COMPONENT_TYPE.CONTAINER,
      accent_color: 0x7ce2a0,
      components: [
        textDisplay([
          "## Pagamento aprovado",
          `Compra aprovada no servidor ${interaction.guild?.name || "Discord"}.`,
          receiptEmail ? `Comprovante enviado para: ${receiptEmail}.` : null,
          emailDeliveryCount
            ? `${emailDeliveryCount} entrega(s) por email foram enviadas para o email cadastrado.`
            : null,
          discordDeliveryCount
            ? `${discordDeliveryCount} entrega(s) seguem abaixo em mensagens separadas.`
            : null,
        ].filter(Boolean).join("\n")),
      ],
    },
    actionRow([
      button({ label: "Abrir pedido", style: ButtonStyle.Link, url: orderUrl }),
    ]),
  ])).catch(() => null);

  for (const [index, delivery] of deliveries.entries()) {
    if (delivery.deliveryMethod === "email" && delivery.status !== "failed") {
      continue;
    }
    await user.send(v2Message([
      {
        type: COMPONENT_TYPE.CONTAINER,
        accent_color: delivery.status === "failed" ? 0xffb86b : 0x7ce2a0,
        components: [
          textDisplay([
            `## Entrega ${index + 1}/${deliveries.length}`,
            `**${delivery.productTitle || "Produto"}**`,
            delivery.status === "failed"
              ? (delivery.message || "Entrega pendente. Abra um ticket com o comprovante.")
              : (delivery.message || "Entrega disponivel pelo link do pedido."),
          ].join("\n").slice(0, 3900)),
        ],
      },
      actionRow([
        button({ label: "Abrir pedido", style: ButtonStyle.Link, url: orderUrl }),
      ]),
    ])).catch(() => null);
  }

  await interaction.channel?.send(v2Message([
    {
      type: COMPONENT_TYPE.CONTAINER,
      accent_color: 0x7ce2a0,
      components: [
        textDisplay(
          `## Pagamento aprovado\nEntrega liberada para <@${user.id}>. Enviei ${deliveries.length || "as"} entrega(s) em mensagens separadas por DM quando possivel.`,
        ),
      ],
    },
    actionRow([
      button({ label: "Ver entrega", style: ButtonStyle.Link, url: orderUrl }),
    ]),
  ], {
    allowedMentions: { users: [user.id] },
  })).catch(() => null);

  setTimeout(() => {
    interaction.channel?.delete("Carrinho Flowdesk finalizado").catch(() => null);
  }, 10_000);

  return true;
}

function buildPaymentStatusPayload(cartId, payment, status) {
  return v2Message([
    {
      type: COMPONENT_TYPE.CONTAINER,
      accent_color: status === "delivered" || status === "delivery_failed" ? 0x7ce2a0 : 0x8fdbff,
      components: [
        textDisplay([
          status === "delivered" || status === "delivery_failed"
            ? "## Pagamento aprovado"
            : "## Aguardando pagamento",
          `**Valor:** ${formatMoney(payment?.amount || 0)}`,
          `**Status:** ${status || payment?.status || "payment_pending"}`,
          status === "delivered" || status === "delivery_failed"
            ? "Entrega liberada. Este canal sera removido em alguns segundos."
            : "Assim que o Mercado Pago aprovar, eu atualizo automaticamente.",
        ].join("\n")),
      ],
    },
    actionRow([
      button({ customId: `sales:cart:check:${cartId}`, label: "Atualizar status", style: ButtonStyle.Primary }),
      ...(payment?.ticketUrl
        ? [button({ label: "Abrir Mercado Pago", style: ButtonStyle.Link, url: payment.ticketUrl })]
        : []),
    ]),
  ]);
}

function startPaymentAutoSync(interaction, cartId, paymentMessage) {
  const startedAt = Date.now();
  const maxDurationMs = 30 * 60_000;
  const intervalMs = 7_500;

  const tick = async () => {
    if (Date.now() - startedAt > maxDurationMs) return;
    let payload;
    try {
      payload = await callSalesInternalApi("sync_payment", cartId);
    } catch (error) {
      console.warn("[salesService] Falha no auto sync do pagamento.", {
        cartId,
        error: error instanceof Error ? error.message : error,
      });
      setTimeout(tick, intervalMs);
      return;
    }

    const status = payload.cart?.status || payload.payment?.status || "payment_pending";
    if (status === "delivered" || status === "delivery_failed") {
      await paymentMessage?.edit(buildPaymentStatusPayload(cartId, payload.payment, status)).catch(() => null);
      await deliverApprovedCart(interaction, payload);
      return;
    }
    if (isFinalUnpaidSalesStatus(status)) {
      await handleFinalUnpaidPayment(interaction, payload, paymentMessage);
      return;
    }
    setTimeout(tick, intervalMs);
  };

  setTimeout(tick, intervalMs);
}

async function handlePaymentSelect(interaction) {
  const parts = parseSalesCustomId(interaction.customId);
  const cartId = parts?.[3];
  if (!cartId || interaction.values?.[0] !== "mercado_pago") return false;

  const cart = await getCart(cartId);
  if (!cart || cart.discord_user_id !== interaction.user.id) {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: "Carrinho nao encontrado." });
    return true;
  }

  await interaction.deferUpdate();
  let payload;
  try {
    payload = await callSalesInternalApi("create_pix_payment", cartId);
  } catch (error) {
    await interaction.followUp({
      flags: MessageFlags.Ephemeral,
      content: error instanceof Error ? error.message : "Nao foi possivel gerar o pagamento.",
    }).catch(() => null);
    return true;
  }
  if (payload.cart?.status === "delivered" || payload.cart?.status === "delivery_failed") {
    await deliverApprovedCart(interaction, payload);
    return true;
  }
  if (isFinalUnpaidSalesStatus(payload.cart?.status || payload.payment?.status)) {
    await handleFinalUnpaidPayment(interaction, payload, null);
    return true;
  }

  await interaction.message?.edit(v2Message([
    {
      type: COMPONENT_TYPE.CONTAINER,
      accent_color: 0x8fdbff,
      components: [
        textDisplay("## Pagamento gerado\nAs quantidades foram bloqueadas. Use o QR Code abaixo para pagar."),
      ],
    },
  ])).catch(() => null);
  const paymentMessage = await interaction.channel?.send(buildPixPaymentMessage(cartId, payload.payment));
  startPaymentAutoSync(interaction, cartId, paymentMessage);
  return true;
}

async function handleCheckPaymentButton(interaction, cartId) {
  const cart = await getCart(cartId);
  if (!cart || cart.discord_user_id !== interaction.user.id) {
    await interaction.reply({ flags: MessageFlags.Ephemeral, content: "Carrinho nao encontrado." });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const payload = await callSalesInternalApi("sync_payment", cartId);
  const status = payload.cart?.status || payload.payment?.status || "payment_pending";
  if (status === "delivered" || status === "delivery_failed") {
    const sent = await deliverApprovedCart(interaction, payload);
    await interaction.editReply(
      sent
        ? "Pagamento aprovado. Entrega liberada."
        : "Pagamento ja aprovado e entrega ja processada.",
    );
    return;
  }
  if (isFinalUnpaidSalesStatus(status)) {
    await handleFinalUnpaidPayment(interaction, payload, interaction.message);
    await interaction.editReply("Pagamento indisponivel. Atualizei o carrinho e enviei o aviso por DM quando possivel.");
    return;
  }
  await interaction.editReply(`Pagamento ainda nao aprovado. Status atual: ${status}.`);
}

async function handleCartButtonInteraction(interaction) {
  const parts = parseSalesCustomId(interaction.customId);
  if (parts?.[1] !== "cart") return false;
  const action = parts[2];
  const cartId = parts[3];
  if (!cartId) return false;

  if (action === "linked") {
    await handleLinkedButton(interaction, cartId);
    return true;
  }
  if (action === "qty_dec") {
    await handleQuantityButton(interaction, cartId, "dec", parts[4]);
    return true;
  }
  if (action === "qty_inc") {
    await handleQuantityButton(interaction, cartId, "inc", parts[4]);
    return true;
  }
  if (action === "checkout") {
    await handleCheckoutButton(interaction, cartId);
    return true;
  }
  if (action === "discount") {
    await showDiscountModal(interaction, cartId);
    return true;
  }
  if (action === "discount_submit") {
    await handleDiscountModalSubmit(interaction, cartId);
    return true;
  }
  if (action === "back") {
    const cart = await getCart(cartId);
    if (!cart || cart.discord_user_id !== interaction.user.id) {
      await interaction.reply({ flags: MessageFlags.Ephemeral, content: "Carrinho nao encontrado." });
      return true;
    }
    await interaction.deferUpdate();
    await refreshCartMessage(interaction.message, cartId);
    return true;
  }
  if (action === "check") {
    await handleCheckPaymentButton(interaction, cartId);
    return true;
  }

  return false;
}

async function handleSalesInteraction(interaction) {
  if (!isSalesComponentInteraction(interaction)) return false;

  if (interaction.isModalSubmit?.()) {
    if (await handleCartButtonInteraction(interaction)) return true;
  }

  if (interaction.isButton()) {
    if (await handleAddToCartInteraction(interaction)) return true;
    if (await handleCartButtonInteraction(interaction)) return true;
  }

  if (interaction.isStringSelectMenu()) {
    if (await handlePaymentSelect(interaction)) return true;
  }

  return false;
}

module.exports = {
  handleSalesInteraction,
  isSalesComponentInteraction,
};
