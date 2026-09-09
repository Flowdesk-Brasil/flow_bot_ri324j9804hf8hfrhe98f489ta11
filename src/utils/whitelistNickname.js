const DEFAULT_NICKNAME_FORMAT = "{nome} | {ID}";

function normalizeNicknameFormat(value) {
  const text = String(value || "").trim().slice(0, 80);
  if (!text) return DEFAULT_NICKNAME_FORMAT;
  if (!/\{nome\}/i.test(text) && !/\{id\}/i.test(text)) {
    return DEFAULT_NICKNAME_FORMAT;
  }
  return text;
}

function resolveNicknameFormat(settings) {
  return normalizeNicknameFormat(
    settings?.nickname_format ||
      settings?.nicknameFormat ||
      settings?.mapping?.nicknameFormat,
  );
}

function sanitizePlayerName(value) {
  const text = String(value || "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/[<>@#:`*_~|]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 24);
  if (text.length < 2) {
    return { ok: false, message: "Informe seu nome do jogo com pelo menos 2 letras." };
  }
  if (!/[A-Za-zÀ-ÿ]/.test(text)) {
    return { ok: false, message: "O nome precisa ter letras. Nao use so numeros ou simbolos." };
  }
  return { ok: true, value: text };
}

function applyNicknameFormat(format, nome, id) {
  const safeId = String(id || "")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .trim()
    .slice(0, 32);
  const safeNome = String(nome || "Jogador")
    .replace(/[\u0000-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 32) || "Jogador";
  const template = normalizeNicknameFormat(format);
  const withId = template.replace(/\{id\}/gi, safeId);
  const overhead = withId.replace(/\{nome\}/gi, "").length;
  const nomeBudget = Math.max(1, 32 - overhead);
  return withId
    .replace(/\{nome\}/gi, safeNome.slice(0, nomeBudget))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 32);
}

module.exports = {
  DEFAULT_NICKNAME_FORMAT,
  normalizeNicknameFormat,
  resolveNicknameFormat,
  applyNicknameFormat,
  sanitizePlayerName,
};
