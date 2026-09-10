const OWNER_HINT =
  "Isso nao e um erro da Flowdesk. O MySQL/MariaDB roda na sua VPS e precisa estar ligado para a whitelist sincronizar.";

function rawErrorText(error) {
  if (error instanceof Error) return `${error.name} ${error.message}`;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    return [error.code, error.errno, error.message, error.sqlMessage].filter(Boolean).join(" ");
  }
  return "";
}

function errnoOf(error) {
  return String(error?.code || error?.errno || "").toUpperCase();
}

function explainCityDbFailure(error) {
  const raw = rawErrorText(error);
  const lowered = raw.toLowerCase();
  const errno = errnoOf(error);

  if (
    lowered.includes("reading 'catch'") ||
    lowered.includes('reading "catch"') ||
    lowered.includes("reading catch") ||
    lowered.includes("cannot read properties of undefined")
  ) {
    return {
      code: "offline",
      title: "O banco da cidade nao esta online",
      message: "Nao foi possivel falar com o MySQL/MariaDB da sua VPS agora.",
      hint: `${OWNER_HINT} Ligue o servico do banco, confira a porta 3306 e tente de novo.`,
      retryable: true,
      evictPool: true,
    };
  }

  if (lowered.includes("unknown database") || errno === "ER_BAD_DB_ERROR") {
    return {
      code: "unknown_database",
      title: "Esse banco nao existe na VPS",
      message: "O nome do banco informado nao existe neste MySQL/MariaDB.",
      hint: "Abra o HeidiSQL na VPS e confira o nome exato do banco. Isso nao e uma falha da Flowdesk.",
      retryable: false,
      evictPool: false,
    };
  }

  if (
    lowered.includes("access denied") ||
    lowered.includes("er_access_denied") ||
    errno === "ER_ACCESS_DENIED_ERROR" ||
    errno === "28000"
  ) {
    return {
      code: "invalid_credentials",
      title: "O banco recusou o usuario",
      message: "Usuario ou senha nao conferem com o MySQL da sua VPS.",
      hint: "Use o mesmo usuario e senha do HeidiSQL. A Flowdesk so envia o que voce salvou no painel.",
      retryable: false,
      evictPool: false,
    };
  }

  if (lowered.includes("timeout") || lowered.includes("etimedout") || errno === "ETIMEDOUT") {
    return {
      code: "timeout",
      title: "O banco da cidade nao respondeu",
      message: "O MySQL/MariaDB da sua VPS nao respondeu a tempo.",
      hint: `${OWNER_HINT} Confira se o servico esta rodando e se a porta nao esta filtrada.`,
      retryable: true,
      evictPool: true,
    };
  }

  if (
    lowered.includes("econnrefused") ||
    lowered.includes("enotfound") ||
    lowered.includes("ehostunreach") ||
    lowered.includes("nao esta online") ||
    errno === "ECONNREFUSED" ||
    errno === "ENOTFOUND" ||
    errno === "EHOSTUNREACH"
  ) {
    return {
      code: "offline",
      title: "O banco da cidade nao esta online",
      message: "A Flowdesk chegou ate a sua VPS, mas o MySQL/MariaDB nao esta acessivel.",
      hint: "Ligue o banco na VPS, libere a porta 3306 e tente novamente. A plataforma esta funcionando.",
      retryable: true,
      evictPool: true,
    };
  }

  if (lowered.includes("too many connections") || errno === "ER_CON_COUNT_ERROR") {
    return {
      code: "pool_exhausted",
      title: "O banco da cidade esta sobrecarregado",
      message: "O MySQL da sua VPS atingiu o limite de conexoes.",
      hint: "Feche conexoes ociosas no HeidiSQL ou aumente max_connections. Isso nao e a Flowdesk.",
      retryable: true,
      evictPool: false,
    };
  }

  if (lowered.includes("player") && lowered.includes("nao encontrado")) {
    return {
      code: "player_not_found",
      title: "ID nao encontrado no banco da cidade",
      message: "Esse identificador nao existe na tabela configurada.",
      hint: "Confira o ID no HeidiSQL. A Flowdesk so atualiza um registro que ja existe na sua cidade.",
      retryable: false,
      evictPool: false,
    };
  }

  if (errno === "CIRCUIT_OPEN" || error?.code === "circuit_open") {
    return {
      code: "circuit_open",
      title: "O banco da cidade esta instavel",
      message: "O MySQL da sua VPS falhou varias vezes seguidas e a conexao foi pausada por alguns segundos.",
      hint: OWNER_HINT,
      retryable: true,
      evictPool: false,
    };
  }

  return {
    code: "db_error",
    title: "O banco da cidade recusou a operacao",
    message: "Nao foi possivel sincronizar a whitelist com o MySQL da sua VPS.",
    hint: OWNER_HINT,
    retryable: false,
    evictPool: false,
  };
}

function publicCityDbMessage(error) {
  const issue = explainCityDbFailure(error);
  return `${issue.message} ${issue.hint}`;
}

module.exports = {
  explainCityDbFailure,
  publicCityDbMessage,
};
