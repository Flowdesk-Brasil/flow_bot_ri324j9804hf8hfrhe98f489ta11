const { createCipheriv, createDecipheriv, createHash } = require("crypto");

const WL_KIND = "wl";
const WL_VERSION = "v1";

function resolveSecret() {
  const value =
    process.env.FLOWDESK_WHITELIST_DB_SECRET ||
    process.env.FLOWSECURE_MASTER_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    "";
  if (!String(value).trim()) {
    throw new Error("Segredo de criptografia da whitelist indisponivel.");
  }
  return createHash("sha256").update(`whitelist-db:${String(value).trim()}`).digest();
}

function isWlV1Envelope(raw) {
  const parts = String(raw || "").split(".");
  return parts.length === 5 && parts[0] === WL_KIND && parts[1] === WL_VERSION;
}

function decryptWlV1(cipherText, guildId) {
  const parts = cipherText.split(".");
  const iv = Buffer.from(parts[2], "base64url");
  const data = Buffer.from(parts[3], "base64url");
  const tag = Buffer.from(parts[4], "base64url");
  const decipher = createDecipheriv("aes-256-gcm", resolveSecret(), iv);
  decipher.setAAD(Buffer.from(String(guildId || ""), "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

function decryptWhitelistSecret(cipherText, guildId) {
  const raw = String(cipherText || "").trim();
  if (!raw) return "";
  if (isWlV1Envelope(raw)) {
    try {
      return decryptWlV1(raw, guildId);
    } catch {
      return "";
    }
  }
  if (raw.startsWith("flws.v1.")) {
    return "";
  }
  if (raw.length <= 255 && !raw.includes("\n")) {
    return raw;
  }
  return "";
}

module.exports = { decryptWhitelistSecret };
