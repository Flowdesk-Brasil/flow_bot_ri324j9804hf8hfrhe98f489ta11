const OWNER_HINT =
  "Isso nao e um erro da Flowdesk. O MySQL/MariaDB roda na sua VPS e precisa estar ligado para a whitelist sincronizar.";

function rawErrorText(error) {
  if (error instanceof Error) {
    const cause = error.cause && typeof error.cause === "object" ? error.cause : null;
    return [
      error.name,
      error.message,
      error.code,
      error.errno,
      error.sqlMessage,
      cause?.code,
      cause?.errno,
      cause?.message,
      cause?.sqlMessage,
    ]
      .filter(Boolean)
      .join(" ");
  }
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    return [error.code, error.errno, error.message, error.sqlMessage].filter(Boolean).join(" ");
  }
  return "";
}

function errnoOf(error) {
  const direct = String(error?.code || error?.errno || "").toUpperCase();
  if (direct && direct !== "DB_ERROR") return direct;
  const cause = error?.cause && typeof error.cause === "object" ? error.cause : null;
  return String(cause?.code || cause?.errno || "").toUpperCase();
}

function uniqueNotice(message, hint) {
  const msg = String(message || "").trim();
  const extra = String(hint || "").trim();
  if (!extra) return msg;
  if (msg.includes(extra)) return msg;
  return `${msg} ${extra}`.trim();
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
      hint: "Abra o HeidiSQL na VPS e confira o nome exato do banco.",
      retryable: false,
      evictPool: false,
    };
  }

  if (
    lowered.includes("unknown column") ||
    lowered.includes("doesn't exist") && lowered.includes("column") ||
    errno === "ER_BAD_FIELD_ERROR"
  ) {
    return {
      code: "unknown_column",
      title: "A coluna da whitelist nao existe",
      message: "A tabela existe, mas a coluna configurada no painel nao foi encontrada no MySQL.",
      hint: "No painel, confira a coluna do ID e a coluna da whitelist. O teste de conexao so prova que o banco liga, nao que o mapping esta certo.",
      retryable: false,
      evictPool: false,
    };
  }

  if (
    lowered.includes("doesn't exist") ||
    lowered.includes("unknown table") ||
    errno === "ER_NO_SUCH_TABLE"
  ) {
    return {
      code: "unknown_table",
      title: "Essa tabela nao existe no banco",
      message: "A tabela da whitelist configurada no painel nao existe neste MySQL.",
      hint: "Confira o nome da tabela no HeidiSQL. Conectar o banco no site nao valida a tabela.",
      retryable: false,
      evictPool: false,
    };
  }

  if (
    lowered.includes("command denied") ||
    lowered.includes("access denied for") && lowered.includes("to table") ||
    errno === "ER_TABLEACCESS_DENIED_ERROR" ||
    errno === "ER_COLUMNACCESS_DENIED_ERROR" ||
    errno === "ER_DBACCESS_DENIED_ERROR"
  ) {
    return {
      code: "missing_grant",
      title: "O usuario do banco nao pode alterar a whitelist",
      message: "O MySQL aceitou o login, mas este usuario nao tem permissao de UPDATE na tabela.",
      hint: "No HeidiSQL, conceda SELECT e UPDATE na tabela da whitelist para o usuario da Flowdesk.",
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
      hint: "Se o HeidiSQL na VPS entra e o bot nao, o usuario so existe em localhost. Rode o SQL do painel de novo — ele agora libera o host %.",
      retryable: false,
      evictPool: false,
    };
  }

  if (
    lowered.includes("is not allowed to connect") ||
    lowered.includes("host is not allowed") ||
    errno === "ER_HOST_NOT_PRIVILEGED" ||
    errno === "ER_HOST_IS_BLOCKED"
  ) {
    return {
      code: "ip_not_allowed",
      title: "O MySQL recusou o IP do bot",
      message: "O usuario do banco nao pode conectar a partir do servidor da Flowdesk.",
      hint: "No HeidiSQL, libere o host do usuario para % . O teste do site e o bot saem de IPs diferentes.",
      retryable: false,
      evictPool: false,
    };
  }

  if (
    lowered.includes("caching_sha2") ||
    lowered.includes("auth plugin") ||
    lowered.includes("authentication plugin") ||
    lowered.includes("er_not_supported_auth") ||
    errno === "ER_NOT_SUPPORTED_AUTH_MODE"
  ) {
    return {
      code: "auth_plugin",
      title: "O banco recusou o tipo de autenticacao",
      message: "Este MySQL exige um plugin de senha que o bot nao usa.",
      hint: "No HeidiSQL, altere o usuario para mysql_native_password.",
      retryable: false,
      evictPool: false,
    };
  }

  if (
    lowered.includes("unsupported") && lowered.includes("prepared") ||
    lowered.includes("er_unsupported_ps") ||
    errno === "ER_UNSUPPORTED_PS"
  ) {
    return {
      code: "unsupported_ps",
      title: "O MariaDB recusou o modo da consulta",
      message: "O banco da cidade nao aceitou a consulta preparada.",
      hint: "O bot agora usa o mesmo modo do painel. Tente de novo; se persistir, reinicie o processo do bot.",
      retryable: true,
      evictPool: true,
    };
  }

  if (lowered.includes("query timeout") || lowered.includes("excedeu o tempo limite")) {
    return {
      code: "timeout",
      title: "O banco da cidade nao respondeu",
      message: "A consulta da whitelist estourou o tempo no MySQL da sua VPS.",
      hint: `${OWNER_HINT} Confira se a tabela tem indice na coluna do ID.`,
      retryable: true,
      evictPool: true,
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
    lowered.includes("econnreset") ||
    lowered.includes("protocol_connection_lost") ||
    lowered.includes("malformed packet") ||
    errno === "ECONNRESET" ||
    errno === "PROTOCOL_CONNECTION_LOST" ||
    errno === "ER_MALFORMED_PACKET"
  ) {
    return {
      code: "offline",
      title: "A conexao com o banco caiu",
      message: "O MySQL da sua VPS fechou a conexao no meio da sincronizacao.",
      hint: `${OWNER_HINT} O bot tenta de novo sozinho. Se repetir, aumente wait_timeout no MariaDB.`,
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
      hint: "Feche conexoes ociosas no HeidiSQL ou aumente max_connections.",
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

  if (
    lowered.includes("nao foi possivel sincronizar") ||
    lowered.includes("banco da cidade recusou")
  ) {
    return {
      code: error?.code && error.code !== "db_error" ? String(error.code) : "db_error",
      title: "O banco da cidade recusou a operacao",
      message: "Nao foi possivel sincronizar a whitelist com o MySQL da sua VPS.",
      hint: OWNER_HINT,
      retryable: false,
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
  return uniqueNotice(issue.message, issue.hint);
}

module.exports = {
  OWNER_HINT,
  explainCityDbFailure,
  publicCityDbMessage,
  uniqueNotice,
};
