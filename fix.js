"use strict";

const REQUIRED_ENV_GROUPS = [
  ["DISCORD_TOKEN", "DISCORD_BOT_TOKEN"],
  ["DISCORD_CLIENT_ID"],
  ["SUPABASE_URL"],
  ["SUPABASE_SERVICE_ROLE_KEY"],
];

function hasEnvironmentValue(key) {
  const value = process.env[key];
  return typeof value === "string" && value.trim().length > 0;
}

const missingGroups = REQUIRED_ENV_GROUPS.filter(
  (keys) => !keys.some(hasEnvironmentValue),
);

if (missingGroups.length > 0) {
  console.error(
    "[squarecloud-env] Variaveis obrigatorias ausentes: " +
      missingGroups.map((keys) => keys.join(" ou ")).join(", "),
  );
  console.error(
    "[squarecloud-env] Configure esses valores em Environment Variables na Square Cloud. Nenhum arquivo local do site sera lido.",
  );
  process.exit(1);
}

console.log(
  "[squarecloud-env] Usando variaveis do ambiente da Square Cloud. Nenhum arquivo local do site sera lido.",
);

require("./src/main");
