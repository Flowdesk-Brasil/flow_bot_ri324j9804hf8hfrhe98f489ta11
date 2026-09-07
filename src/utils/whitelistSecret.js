const { createCipheriv, createDecipheriv, createHash } = require("crypto");

const PREFIX = "wl.v1";

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

function decryptWhitelistSecret(cipherText, guildId) {
  const raw = String(cipherText || "");
  if (!raw) return "";
  const parts = raw.split(".");
  if (parts.length !== 4 || parts[0] !== PREFIX) {
    throw new Error("Envelope de senha invalido.");
  }
  const iv = Buffer.from(parts[1], "base64url");
  const data = Buffer.from(parts[2], "base64url");
  const tag = Buffer.from(parts[3], "base64url");
  const decipher = createDecipheriv("aes-256-gcm", resolveSecret(), iv);
  decipher.setAAD(Buffer.from(String(guildId || ""), "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

module.exports = { decryptWhitelistSecret };
