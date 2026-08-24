const { spawnSync } = require("node:child_process");
const readline = require("node:readline");
const path = require("node:path");
const fs = require("node:fs");
const {
  ensureGitHubLogin,
  syncGitIdentityForGitHubAccount,
} = require("./github-auth");

const rootDir = path.resolve(__dirname, "..");
const DEFAULT_SITE_GITHUB_REMOTE =
  "https://github.com/Flowdesk-Brasil/Fl0wD3sk_845983_wjcwf0328roifldvn_934320fn02rg0g89.git";
const DEFAULT_BOT_GITHUB_REMOTE =
  "https://github.com/Flowdesk-Brasil/flow_bot_ri324j9804hf8hfrhe98f489ta11.git";

function execute(command, args, cwd = rootDir, options = {}) {
  const relPath = path.relative(rootDir, cwd) || ".";
  const printable = `${command} ${args.join(" ")}`;

  if (options.printCommand !== false) {
    console.log(`\n[${relPath}] > ${printable}`);
  }

  const result = spawnSync(command, args, {
    cwd,
    stdio: "pipe",
    encoding: "utf8",
  });

  const stdout = result.stdout || "";
  const stderr = result.stderr || "";

  if (options.printOutput !== false) {
    if (stdout) process.stdout.write(stdout);
    if (stderr) process.stderr.write(stderr);
  }

  return {
    status: typeof result.status === "number" ? result.status : 1,
    stdout,
    stderr,
    printable,
    relPath,
  };
}

function run(command, args, cwd = rootDir, options = {}) {
  const result = execute(command, args, cwd, options);
  if (result.status === 0) {
    return result;
  }

  const details = `${result.stdout}${result.stderr}`.trim();
  throw new Error(
    `Falha ao executar em ${result.relPath}: ${result.printable}${details ? `\n${details}` : ""}`,
  );
}

function capture(command, args, cwd = rootDir) {
  const result = execute(command, args, cwd, {
    printCommand: false,
    printOutput: false,
  });
  return (result.stdout || "").trim();
}

async function askCommitMessage(repoName, rl) {
  return new Promise((resolve) => {
    rl.question(
      `\nMudancas detectadas em [${repoName}].\n> O que voce alterou? (Mensagem de commit): `,
      (answer) => {
        resolve(answer.trim());
      },
    );
  });
}

function sanitizeBranchSegment(value) {
  return (value || "sync")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "sync";
}

function buildProtectedPublishBranch(repoName, githubAccount) {
  const repoSegment = sanitizeBranchSegment(repoName);
  const accountSegment = sanitizeBranchSegment(githubAccount || "github");
  return `pr/${accountSegment}/${repoSegment}`;
}

function buildUniqueProtectedPublishBranch(repoName, githubAccount, targetDir) {
  const baseBranch = buildProtectedPublishBranch(repoName, githubAccount);
  const shortSha = capture("git", ["rev-parse", "--short=8", "HEAD"], targetDir) || Date.now().toString(36);
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\..+$/, "")
    .toLowerCase();
  return `${baseBranch}-${timestamp}-${shortSha}`;
}

function normalizeGitHubRepoWebUrl(remoteUrl) {
  if (!remoteUrl) return null;

  const normalized = remoteUrl.trim().replace(/\.git$/i, "");
  if (normalized.startsWith("https://github.com/")) {
    return normalized;
  }

  const sshMatch = normalized.match(/^git@github\.com:(.+)$/i);
  if (sshMatch) {
    return `https://github.com/${sshMatch[1]}`;
  }

  return null;
}

function buildPullRequestCompareUrl(remoteUrl, baseBranch, publishBranch) {
  const repoWebUrl = normalizeGitHubRepoWebUrl(remoteUrl);
  if (!repoWebUrl) return null;
  return `${repoWebUrl}/compare/${encodeURIComponent(baseBranch)}...${encodeURIComponent(publishBranch)}?expand=1`;
}

function ensureRemoteOrigin(targetDir, repoName, remoteUrl) {
  if (!remoteUrl) {
    return;
  }

  const currentOrigin = capture("git", ["remote", "get-url", "origin"], targetDir);
  if (currentOrigin === remoteUrl) {
    return;
  }

  const remoteList = capture("git", ["remote"], targetDir)
    .split(/\r?\n/)
    .map((value) => value.trim())
    .filter(Boolean);

  if (remoteList.includes("origin")) {
    console.log(`\nAtualizando remote [${repoName}] para o repositorio novo...`);
    run("git", ["remote", "set-url", "origin", remoteUrl], targetDir);
    return;
  }

  console.log(`\nConfigurando remote [${repoName}]...`);
  run("git", ["remote", "add", "origin", remoteUrl], targetDir);
}

function getFetchedBaseBranch(targetDir) {
  const candidates = ["main", "master"];

  for (const branch of candidates) {
    const result = execute(
      "git",
      ["rev-parse", "--verify", `origin/${branch}`],
      targetDir,
      {
        printCommand: false,
        printOutput: false,
      },
    );

    if (result.status === 0) {
      return branch;
    }
  }

  const originHead = capture("git", ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], targetDir);
  if (originHead.startsWith("origin/")) {
    return originHead.slice("origin/".length);
  }

  return null;
}

function remoteBranchExists(targetDir, branch) {
  if (!branch) return false;
  const result = execute(
    "git",
    ["ls-remote", "--exit-code", "--heads", "origin", branch],
    targetDir,
    {
      printCommand: false,
      printOutput: false,
    },
  );
  return result.status === 0;
}

function resolveSyncBaseBranch(targetDir, currentBranch) {
  if (remoteBranchExists(targetDir, currentBranch)) {
    return currentBranch;
  }
  return getFetchedBaseBranch(targetDir) || currentBranch || "main";
}

function ensureGitRepository(targetDir, repoName, remoteUrl) {
  const gitDir = path.join(targetDir, ".git");
  if (fs.existsSync(gitDir)) {
    ensureRemoteOrigin(targetDir, repoName, remoteUrl);
    return;
  }

  console.log(`\nPreparando Git em [${repoName}]...`);
  run("git", ["init"], targetDir);
  ensureRemoteOrigin(targetDir, repoName, remoteUrl);

  console.log(`\nLigando [${repoName}] ao historico do GitHub...`);
  const fetchResult = execute("git", ["fetch", "origin"], targetDir);
  const baseBranch = fetchResult.status === 0 ? getFetchedBaseBranch(targetDir) : null;

  if (baseBranch) {
    run("git", ["branch", "-M", baseBranch], targetDir);
    run("git", ["reset", "--mixed", `origin/${baseBranch}`], targetDir);
    return;
  }

  console.warn(`\nAviso: nao encontrei branch remota para [${repoName}]. Usando 'main'.`);
  run("git", ["branch", "-M", "main"], targetDir);
}

function isResolvingConflict(targetDir) {
  const gitDir = path.join(targetDir, ".git");
  return (
    fs.existsSync(path.join(gitDir, "MERGE_HEAD")) ||
    fs.existsSync(path.join(gitDir, "rebase-merge")) ||
    fs.existsSync(path.join(gitDir, "rebase-apply")) ||
    fs.existsSync(path.join(gitDir, "BISECT_LOG"))
  );
}

function isProtectedBranchPushFailure(result) {
  const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return (
    combined.includes("gh013") ||
    combined.includes("cannot update this protected ref") ||
    combined.includes("changes must be made through a pull request")
  );
}

function isNonFastForwardPushFailure(result) {
  const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
  return (
    combined.includes("non-fast-forward") ||
    combined.includes("fetch first") ||
    combined.includes("tip is behind its remote counterpart") ||
    combined.includes("updates were rejected")
  );
}

function pushToProtectedPublishBranch(input, publishBranch) {
  return execute(
    "git",
    ["push", "origin", `HEAD:refs/heads/${publishBranch}`],
    input.targetDir,
  );
}

function pushWithProtectedBranchFallback(input) {
  const directPush = execute(
    "git",
    ["push", "origin", `HEAD:refs/heads/${input.baseBranch}`],
    input.targetDir,
  );

  if (directPush.status === 0) {
    console.log(`\n[${input.repoName}] sincronizado e salvo com sucesso.`);
    return;
  }

  if (!isProtectedBranchPushFailure(directPush)) {
    throw new Error(
      `Falha ao executar em ${path.relative(rootDir, input.targetDir) || "."}: git push origin ${input.baseBranch}`,
    );
  }

  const publishBranch = buildProtectedPublishBranch(
    input.repoName,
    input.githubAccount,
  );

  console.log(`\n[${input.repoName}] usa branch protegida em '${input.baseBranch}'.`);
  console.log(`Enviando automaticamente para a branch de PR '${publishBranch}'...`);

  let finalPublishBranch = publishBranch;
  let branchPush = pushToProtectedPublishBranch(input, finalPublishBranch);

  if (branchPush.status !== 0 && isNonFastForwardPushFailure(branchPush)) {
    const uniquePublishBranch = buildUniqueProtectedPublishBranch(
      input.repoName,
      input.githubAccount,
      input.targetDir,
    );
    console.log(`\n[${input.repoName}] a branch de PR '${publishBranch}' ja existe e esta diferente do seu historico local.`);
    console.log(`Para nao sobrescrever alteracoes remotas, vou publicar em '${uniquePublishBranch}'.`);
    finalPublishBranch = uniquePublishBranch;
    branchPush = pushToProtectedPublishBranch(input, finalPublishBranch);
  }

  if (branchPush.status !== 0) {
    throw new Error(
      `Falha ao executar em ${path.relative(rootDir, input.targetDir) || "."}: git push origin HEAD:refs/heads/${finalPublishBranch}`,
    );
  }

  const compareUrl = buildPullRequestCompareUrl(
    input.remoteUrl,
    input.baseBranch,
    finalPublishBranch,
  );

  console.log(`\n[${input.repoName}] enviado para a branch de PR com sucesso.`);
  if (compareUrl) {
    console.log("Abra este link para criar o pull request:");
    console.log(compareUrl);
  }
}

async function syncRepo(targetDir, repoName, rl, options = {}) {
  const relPath = path.relative(rootDir, targetDir) || ".";
  ensureGitRepository(targetDir, repoName, options.remoteUrl || null);

  if (isResolvingConflict(targetDir)) {
    console.log(`\n[${repoName}] ja esta com um conflito pendente.`);
    console.log("Resolva os conflitos, rode 'git add .' e finalize o rebase ou commit.");
    throw new Error(`Conflito pendente em ${repoName}`);
  }

  console.log(`\nVerificando atualizacoes no GitHub para [${repoName}]...`);
  try {
    run("git", ["fetch", "--prune", "origin"], targetDir);
  } catch {
    console.warn(`\nAviso: nao foi possivel conectar ao GitHub para [${repoName}]. Tentando continuar...`);
  }

  const currentBranch = capture("git", ["rev-parse", "--abbrev-ref", "HEAD"], targetDir) || "main";
  const branch = resolveSyncBaseBranch(targetDir, currentBranch);
  if (branch !== currentBranch) {
    console.log(`\n[${repoName}] branch local '${currentBranch}' nao existe no remoto. Sincronizando contra '${branch}'.`);
  }

  console.log(`\nVerificando mudancas locais em [${repoName}]...`);
  const status = capture("git", ["status", "--porcelain"], targetDir);
  const hasChanges = status.length > 0;

  if (hasChanges) {
    const commitMessage = await askCommitMessage(repoName, rl);
    const finalMessage = commitMessage || `update: ${new Date().toLocaleString("pt-BR")}`;

    try {
      run("git", ["add", "."], targetDir);
      run("git", ["commit", "-m", finalMessage], targetDir);
    } catch (error) {
      console.error(`\nErro ao salvar mudancas em [${repoName}].`);
      throw error;
    }
  } else {
    console.log(`\nNenhuma mudanca local em [${repoName}].`);
  }

  console.log(`\nSincronizando com o GitHub [${repoName}]...`);
  const pullResult = execute(
    "git",
    ["pull", "--rebase", "origin", branch],
    targetDir,
  );

  if (pullResult.status !== 0) {
    console.warn(`\nConflito detectado ao sincronizar [${repoName}].`);
    console.log("Revertendo para o estado seguro anterior (git rebase --abort)...");
    execute("git", ["rebase", "--abort"], targetDir, {
      printCommand: false,
    });

    console.log(`\nA sincronizacao de [${repoName}] foi cancelada.`);
    console.log("Motivo: alguem alterou o mesmo arquivo no GitHub.");
    console.log("Como resolver:");
    console.log(`1. Va na pasta '${relPath}'`);
    console.log(`2. Rode: git pull --rebase origin ${branch}`);
    console.log("3. Resolva os conflitos que o Git marcar.");
    console.log("4. Rode: git add .");
    console.log("5. Rode: git rebase --continue");
    console.log("6. Rode o 'npm run now' de novo.");

    throw new Error(`Conflito de sincronizacao em ${repoName}`);
  }

  console.log(`\nSubindo [${repoName}] para o GitHub...`);
  pushWithProtectedBranchFallback({
    targetDir,
    repoName,
    baseBranch: branch,
    remoteUrl: options.remoteUrl || null,
    githubAccount: options.githubAccount || null,
  });
}

async function main() {
  console.log("\n==================================================");
  console.log("BULLTEPROOF SYNC (npm run now)");
  console.log("==================================================\n");

  const authSession = ensureGitHubLogin({ showStatus: true });
  const primaryGitHubAccount = authSession.accounts[0] || null;
  await syncGitIdentityForGitHubAccount(primaryGitHubAccount, {
    showStatus: true,
  });

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const siteDir = path.join(rootDir, "site");
    if (fs.existsSync(siteDir)) {
      await syncRepo(siteDir, "SITE / DASHBOARD", rl, {
        remoteUrl: process.env.SITE_GITHUB_REMOTE || DEFAULT_SITE_GITHUB_REMOTE,
        githubAccount: primaryGitHubAccount,
      });
    }

    await syncRepo(rootDir, "BOT / CORE", rl, {
      remoteUrl: process.env.BOT_GITHUB_REMOTE || DEFAULT_BOT_GITHUB_REMOTE,
      githubAccount: primaryGitHubAccount,
    });

    console.log("\n==================================================");
    console.log("SUCESSO! Todo o seu codigo foi sincronizado.");
    console.log("==================================================\n");
  } catch (error) {
    if (!String(error.message || "").includes("Conflito de sincronizacao")) {
      console.error(`\nERRO CRITICO: ${error.message}`);
    }
    console.log("\nA sincronizacao foi interrompida com seguranca.");
    process.exit(1);
  } finally {
    rl.close();
  }
}

main().catch((error) => {
  console.error(`\nErro inesperado: ${error.message}`);
  process.exit(1);
});
