import crypto from "node:crypto";
import { cookies } from "next/headers";
import type { NextRequest, NextResponse } from "next/server";
import {
  clearSharedAuthCookie,
  setSharedAuthCookie,
} from "@/lib/auth/cookies";
import {
  decryptFlowSecureValue,
  encryptFlowSecureValue,
} from "@/lib/security/flowSecure";
import { getSupabaseAdminClientOrThrow } from "@/lib/supabaseAdmin";
import type { HostingGitHubAccount, HostingRepository } from "@/lib/hosting/catalog";

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const GITHUB_API_URL = "https://api.github.com";
const GITHUB_STATE_COOKIE = "flowdesk_hosting_github_state";
const GITHUB_TOKEN_COOKIE = "flowdesk_hosting_github_token";
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const HANDOFF_TTL_MS = 2 * 60 * 1000;
const GITHUB_TOKEN_REFRESH_SKEW_MS = 5 * 60 * 1000;
const HOSTING_GITHUB_OAUTH_SCOPE = "read:user user:email read:org repo workflow admin:repo_hook";

export type HostingGitHubTokenBundle = {
  accessToken: string;
  refreshToken?: string | null;
  accessTokenExpiresAt?: string | null;
  refreshTokenExpiresAt?: string | null;
  scope?: string | null;
  tokenType?: string | null;
};

type GitHubUser = {
  id: number;
  login: string;
  name?: string | null;
  avatar_url?: string | null;
  type?: string | null;
};

type GitHubOrg = {
  id: number;
  login: string;
  avatar_url?: string | null;
};

type GitHubRepo = {
  id: number;
  node_id?: string | null;
  name: string;
  full_name: string;
  description?: string | null;
  language?: string | null;
  private: boolean;
  html_url?: string | null;
  updated_at?: string | null;
  pushed_at?: string | null;
  default_branch?: string | null;
  permissions?: {
    admin?: boolean;
    maintain?: boolean;
    push?: boolean;
    pull?: boolean;
  } | null;
  owner: {
    login: string;
  };
};

type GitHubTreeItem = {
  path?: string;
  type?: "blob" | "tree" | string;
  size?: number;
};

type GitHubTreeResponse = {
  tree?: GitHubTreeItem[];
  truncated?: boolean;
};

type GitHubContentResponse = {
  type?: string;
  encoding?: string;
  content?: string;
  name?: string;
  path?: string;
  sha?: string;
  size?: number;
  download_url?: string | null;
  html_url?: string | null;
};

type GitHubCommitFileResponse = {
  content?: {
    name?: string;
    path?: string;
    sha?: string;
    html_url?: string;
  } | null;
  commit?: {
    sha?: string;
    html_url?: string;
  } | null;
};

type GitHubCommitListItem = {
  sha?: string;
  html_url?: string | null;
  commit?: {
    message?: string | null;
    author?: {
      name?: string | null;
      date?: string | null;
    } | null;
    committer?: {
      name?: string | null;
      date?: string | null;
    } | null;
  } | null;
  author?: {
    login?: string | null;
    avatar_url?: string | null;
  } | null;
  committer?: {
    login?: string | null;
    avatar_url?: string | null;
  } | null;
};

type GitHubRefResponse = {
  ref?: string;
  object?: {
    sha?: string;
    type?: string;
  };
};

type GitHubPullRequestResponse = {
  number?: number;
  html_url?: string;
  state?: string;
};

type GitHubInstallationResponse = {
  id?: number;
  html_url?: string | null;
  repository_selection?: string | null;
  permissions?: Record<string, string | undefined> | null;
  app_slug?: string | null;
};

type GitHubInstallationTokenResponse = {
  token?: string;
  expires_at?: string;
};

export function isHostingGitHubConfigured() {
  return Boolean(
    process.env.GITHUB_CLIENT_ID?.trim() &&
      process.env.GITHUB_CLIENT_SECRET?.trim(),
  );
}

export function resolveHostingGitHubRedirectUri(request: NextRequest) {
  const explicit =
    process.env.GITHUB_HOSTING_REDIRECT_URI?.trim() ||
    process.env.GITHUB_REDIRECT_URI?.trim();
  if (explicit) {
    const requestHostname = request.nextUrl.hostname.toLowerCase();

    if (
      requestHostname === "localhost" ||
      requestHostname === "127.0.0.1" ||
      requestHostname === "0.0.0.0"
    ) {
      return new URL("/api/auth/github/hosting/callback", request.nextUrl.origin).toString();
    }

    try {
      new URL(explicit);
    } catch {
      return new URL("/api/auth/github/hosting/callback", request.nextUrl.origin).toString();
    }

    return explicit;
  }
  return new URL("/api/auth/github/hosting/callback", request.nextUrl.origin).toString();
}

export function createHostingGitHubState() {
  const state = encryptFlowSecureValue(
    JSON.stringify({
      nonce: crypto.randomBytes(24).toString("base64url"),
      exp: Date.now() + 10 * 60 * 1000,
    }),
    {
      purpose: "auth_session_oauth",
      subcontext: "hosting_github_state",
    },
  );

  return state || crypto.randomBytes(24).toString("base64url");
}

export function validateHostingGitHubState(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return false;

  const decrypted = decryptFlowSecureValue(value, {
    purpose: "auth_session_oauth",
    subcontext: "hosting_github_state",
    allowPlaintextFallback: false,
  });

  if (!decrypted) return false;

  try {
    const parsed = JSON.parse(decrypted) as {
      nonce?: unknown;
      exp?: unknown;
    };
    return (
      typeof parsed.nonce === "string" &&
      parsed.nonce.length >= 16 &&
      typeof parsed.exp === "number" &&
      parsed.exp >= Date.now()
    );
  } catch {
    return false;
  }
}

export function setHostingGitHubStateCookie(
  request: NextRequest,
  response: NextResponse,
  state: string,
) {
  setSharedAuthCookie(request, response, GITHUB_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: 10 * 60,
    path: "/",
    priority: "high",
  });
}

export async function readHostingGitHubStateCookie() {
  return (await cookies()).get(GITHUB_STATE_COOKIE)?.value || null;
}

export function clearHostingGitHubStateCookie(
  request: NextRequest,
  response: NextResponse,
) {
  clearSharedAuthCookie(request, response, GITHUB_STATE_COOKIE, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    priority: "high",
  });
}

export function setHostingGitHubTokenCookie(
  request: NextRequest,
  response: NextResponse,
  token: string,
) {
  const encrypted = encryptFlowSecureValue(token, {
    purpose: "auth_session_oauth",
    subcontext: "hosting_github",
  });
  if (!encrypted) return;

  setSharedAuthCookie(request, response, GITHUB_TOKEN_COOKIE, encrypted, {
    httpOnly: true,
    sameSite: "lax",
    maxAge: COOKIE_MAX_AGE_SECONDS,
    path: "/",
    priority: "high",
  });
}

function encryptHostingGitHubTokenForUser(userId: number, token: string) {
  return encryptFlowSecureValue(token, {
    purpose: "hosting_github_token",
    subcontext: `user:${userId}`,
  });
}

function decryptHostingGitHubTokenForUser(userId: number, value: string | null | undefined) {
  return decryptFlowSecureValue(value, {
    purpose: "hosting_github_token",
    subcontext: `user:${userId}`,
    allowPlaintextFallback: false,
  });
}

export async function storeHostingGitHubTokenForUser(input: {
  userId: number;
  token: string;
  refreshToken?: string | null;
  accessTokenExpiresAt?: string | null;
  refreshTokenExpiresAt?: string | null;
  scope?: string | null;
  tokenType?: string | null;
  login?: string | null;
  accountType?: string | null;
  avatarUrl?: string | null;
}) {
  const encryptedToken = encryptHostingGitHubTokenForUser(input.userId, input.token);
  if (!encryptedToken) throw new Error("Nao foi possivel proteger o token do GitHub.");
  const encryptedRefreshToken = input.refreshToken
    ? encryptHostingGitHubTokenForUser(input.userId, input.refreshToken)
    : null;
  const payload: Record<string, unknown> = {
    user_id: input.userId,
    encrypted_token: encryptedToken,
    token_status: "active",
    last_validated_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  if (input.login !== undefined) payload.github_login = input.login || null;
  if (input.accountType !== undefined) payload.github_account_type = input.accountType || null;
  if (input.avatarUrl !== undefined) payload.github_avatar_url = input.avatarUrl || null;
  if (input.refreshToken !== undefined) payload.encrypted_refresh_token = encryptedRefreshToken;
  if (input.accessTokenExpiresAt !== undefined) payload.access_token_expires_at = input.accessTokenExpiresAt || null;
  if (input.refreshTokenExpiresAt !== undefined) payload.refresh_token_expires_at = input.refreshTokenExpiresAt || null;
  if (input.scope !== undefined) payload.scopes = input.scope || null;
  if (input.tokenType !== undefined) payload.token_type = input.tokenType || null;
  if (input.refreshToken !== undefined) payload.refreshed_at = new Date().toISOString();

  await getSupabaseAdminClientOrThrow()
    .from("hosting_github_connections")
    .upsert(payload, { onConflict: "user_id" });
}

async function refreshHostingGitHubStoredToken(input: {
  userId: number;
  refreshToken: string;
}) {
  const response = await fetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: process.env.GITHUB_CLIENT_ID?.trim(),
      client_secret: process.env.GITHUB_CLIENT_SECRET?.trim(),
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
    }),
  });
  const payload = await response.json() as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
    refresh_token_expires_in?: number;
    scope?: string;
    token_type?: string;
    error?: string;
    error_description?: string;
  };
  if (!response.ok || !payload.access_token) {
    throw new Error(payload.error_description || payload.error || "Falha ao renovar GitHub.");
  }
  const now = Date.now();
  const bundle: HostingGitHubTokenBundle = {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token || input.refreshToken,
    accessTokenExpiresAt: typeof payload.expires_in === "number"
      ? new Date(now + payload.expires_in * 1000).toISOString()
      : null,
    refreshTokenExpiresAt: typeof payload.refresh_token_expires_in === "number"
      ? new Date(now + payload.refresh_token_expires_in * 1000).toISOString()
      : null,
    scope: payload.scope || null,
    tokenType: payload.token_type || null,
  };
  await storeHostingGitHubTokenForUser({
    userId: input.userId,
    token: bundle.accessToken,
    refreshToken: bundle.refreshToken,
    accessTokenExpiresAt: bundle.accessTokenExpiresAt,
    refreshTokenExpiresAt: bundle.refreshTokenExpiresAt,
    scope: bundle.scope,
    tokenType: bundle.tokenType,
  });
  return bundle.accessToken;
}

export async function readHostingGitHubStoredToken(userId: number) {
  try {
    const { data } = await getSupabaseAdminClientOrThrow()
      .from("hosting_github_connections")
      .select("encrypted_token, encrypted_refresh_token, token_status, access_token_expires_at, refresh_token_expires_at")
      .eq("user_id", userId)
      .maybeSingle<{
        encrypted_token: string | null;
        encrypted_refresh_token: string | null;
        token_status: string | null;
        access_token_expires_at: string | null;
        refresh_token_expires_at: string | null;
      }>();

    if (!data?.encrypted_token) return null;
    if (data.token_status === "revoked") return null;
    const token = decryptHostingGitHubTokenForUser(userId, data.encrypted_token);
    if (!token) return null;
    const expiresAtMs = data.access_token_expires_at ? Date.parse(data.access_token_expires_at) : Number.NaN;
    if (!Number.isFinite(expiresAtMs) || expiresAtMs - GITHUB_TOKEN_REFRESH_SKEW_MS > Date.now()) return token;
    const refreshToken = decryptHostingGitHubTokenForUser(userId, data.encrypted_refresh_token);
    if (!refreshToken) return token;
    const refreshExpiresAtMs = data.refresh_token_expires_at ? Date.parse(data.refresh_token_expires_at) : Number.NaN;
    if (Number.isFinite(refreshExpiresAtMs) && refreshExpiresAtMs <= Date.now()) return token;
    return await refreshHostingGitHubStoredToken({ userId, refreshToken });
  } catch {
    return null;
  }
}

export async function markHostingGitHubTokenInvalid(userId: number, reason?: string | null) {
  await getSupabaseAdminClientOrThrow()
    .from("hosting_github_connections")
    .update({
      token_status: "invalid",
      last_error: reason || null,
      updated_at: new Date().toISOString(),
    })
    .eq("user_id", userId);
}

export async function readHostingGitHubToken(userId?: number | null) {
  const encrypted = (await cookies()).get(GITHUB_TOKEN_COOKIE)?.value || null;
  let cookieToken: string | null = null;
  if (encrypted) {
    try {
      cookieToken = decryptFlowSecureValue(encrypted, {
          purpose: "auth_session_oauth",
          subcontext: "hosting_github",
          allowPlaintextFallback: false,
        });
    } catch {
      cookieToken = null;
    }
  }
  if (cookieToken) return cookieToken;
  if (!userId) return null;
  return readHostingGitHubStoredToken(userId);
}

export async function hasHostingGitHubTokenCookie() {
  return Boolean((await cookies()).get(GITHUB_TOKEN_COOKIE)?.value);
}

export function createHostingGitHubHandoffToken(token: string) {
  return createHostingGitHubHandoffTokenBundle({ accessToken: token });
}

export function createHostingGitHubHandoffTokenBundle(bundle: HostingGitHubTokenBundle) {
  return encryptFlowSecureValue(
    JSON.stringify({
      token: bundle.accessToken,
      bundle,
      exp: Date.now() + HANDOFF_TTL_MS,
    }),
    {
      purpose: "auth_session_oauth",
      subcontext: "hosting_github_handoff",
    },
  );
}

export function consumeHostingGitHubHandoffToken(value: unknown) {
  const bundle = consumeHostingGitHubHandoffTokenBundle(value);
  return bundle?.accessToken || null;
}

export function consumeHostingGitHubHandoffTokenBundle(value: unknown): HostingGitHubTokenBundle | null {
  if (typeof value !== "string" || !value.trim()) return null;

  const decrypted = decryptFlowSecureValue(value, {
    purpose: "auth_session_oauth",
    subcontext: "hosting_github_handoff",
    allowPlaintextFallback: false,
  });

  if (!decrypted) return null;

  try {
    const parsed = JSON.parse(decrypted) as {
      token?: unknown;
      bundle?: unknown;
      exp?: unknown;
    };
    if (typeof parsed.exp !== "number" || parsed.exp < Date.now()) return null;
    const bundle = parsed.bundle && typeof parsed.bundle === "object"
      ? parsed.bundle as Partial<HostingGitHubTokenBundle>
      : null;
    const accessToken = typeof bundle?.accessToken === "string" && bundle.accessToken.trim()
      ? bundle.accessToken
      : typeof parsed.token === "string" && parsed.token.trim()
        ? parsed.token
        : null;
    if (!accessToken) return null;
    return {
      accessToken,
      refreshToken: typeof bundle?.refreshToken === "string" ? bundle.refreshToken : null,
      accessTokenExpiresAt: typeof bundle?.accessTokenExpiresAt === "string" ? bundle.accessTokenExpiresAt : null,
      refreshTokenExpiresAt: typeof bundle?.refreshTokenExpiresAt === "string" ? bundle.refreshTokenExpiresAt : null,
      scope: typeof bundle?.scope === "string" ? bundle.scope : null,
      tokenType: typeof bundle?.tokenType === "string" ? bundle.tokenType : null,
    };
  } catch {
    return null;
  }
}

export function buildHostingGitHubAuthorizeUrl(request: NextRequest, state: string) {
  const params = new URLSearchParams({
    client_id: process.env.GITHUB_CLIENT_ID?.trim() || "",
    redirect_uri: resolveHostingGitHubRedirectUri(request),
    scope: HOSTING_GITHUB_OAUTH_SCOPE,
    state,
    allow_signup: "true",
    prompt: "consent",
  });

  return `${GITHUB_AUTHORIZE_URL}?${params.toString()}`;
}

export async function exchangeHostingGitHubCode(input: {
  code: string;
  request: NextRequest;
}) {
  const response = await fetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      client_id: process.env.GITHUB_CLIENT_ID?.trim(),
      client_secret: process.env.GITHUB_CLIENT_SECRET?.trim(),
      code: input.code,
      redirect_uri: resolveHostingGitHubRedirectUri(input.request),
    }),
  });

  const payload = await response.json() as {
    access_token?: string;
    expires_in?: number;
    refresh_token?: string;
    refresh_token_expires_in?: number;
    scope?: string;
    token_type?: string;
    error?: string;
    error_description?: string;
  };

  if (!response.ok || !payload.access_token) {
    throw new Error(payload.error_description || payload.error || "Falha ao vincular o GitHub.");
  }

  const now = Date.now();
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token || null,
    accessTokenExpiresAt: typeof payload.expires_in === "number"
      ? new Date(now + payload.expires_in * 1000).toISOString()
      : null,
    refreshTokenExpiresAt: typeof payload.refresh_token_expires_in === "number"
      ? new Date(now + payload.refresh_token_expires_in * 1000).toISOString()
      : null,
    scope: payload.scope || null,
    tokenType: payload.token_type || null,
  } satisfies HostingGitHubTokenBundle;
}

export class HostingGitHubApiError extends Error {
  status: number;
  githubMessage: string | null;
  documentationUrl: string | null;
  ssoUrl: string | null;
  constructor(status: number, message?: string, details?: {
    githubMessage?: string | null;
    documentationUrl?: string | null;
    ssoUrl?: string | null;
  }) {
    super(message || details?.githubMessage || `GitHub respondeu ${status}.`);
    this.name = "HostingGitHubApiError";
    this.status = status;
    this.githubMessage = details?.githubMessage || null;
    this.documentationUrl = details?.documentationUrl || null;
    this.ssoUrl = details?.ssoUrl || null;
  }
}

export function isPermanentHostingGitHubAuthError(error: unknown) {
  return error instanceof HostingGitHubApiError && (error.status === 401 || error.status === 403);
}

function encodeBase64UrlJson(value: unknown) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function createHostingGitHubAppJwt() {
  const appId = resolveHostingGitHubAppId();
  const privateKey = resolveHostingGitHubAppPrivateKey();
  if (!appId || !privateKey) return null;

  const now = Math.floor(Date.now() / 1000);
  const unsigned = [
    encodeBase64UrlJson({ alg: "RS256", typ: "JWT" }),
    encodeBase64UrlJson({
      iat: now - 60,
      exp: now + 9 * 60,
      iss: appId,
    }),
  ].join(".");

  try {
    const signer = crypto.createSign("RSA-SHA256");
    signer.update(unsigned);
    signer.end();
    return `${unsigned}.${signer.sign(privateKey).toString("base64url")}`;
  } catch {
    return null;
  }
}

async function githubFetch<TValue>(path: string, token: string) {
  const response = await fetch(`${GITHUB_API_URL}${path}`, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
    cache: "no-store",
  });

  if (!response.ok) {
    throw await createHostingGitHubApiError(response);
  }

  return await response.json() as TValue;
}

async function createHostingGitHubApiError(response: Response) {
  const ssoHeader = response.headers.get("x-github-sso");
  const ssoUrl = ssoHeader?.match(/url=([^;]+)/i)?.[1] || null;
  const payload = await response.json().catch(() => null) as {
    message?: string;
    documentation_url?: string;
  } | null;
  const githubMessage = typeof payload?.message === "string" ? payload.message : null;
  return new HostingGitHubApiError(response.status, githubMessage || undefined, {
    githubMessage,
    documentationUrl: typeof payload?.documentation_url === "string" ? payload.documentation_url : null,
    ssoUrl,
  });
}

async function githubRequest<TValue>(input: {
  token: string;
  method: "GET" | "POST" | "PATCH" | "PUT";
  path: string;
  body?: unknown;
}) {
  const response = await fetch(`${GITHUB_API_URL}${input.path}`, {
    method: input.method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${input.token}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
    cache: "no-store",
  });

  if (!response.ok) {
    throw await createHostingGitHubApiError(response);
  }

  return await response.json().catch(() => ({})) as TValue;
}

async function githubAppRequest<TValue>(input: {
  jwt: string;
  method: "GET" | "POST";
  path: string;
  body?: unknown;
}) {
  const response = await fetch(`${GITHUB_API_URL}${input.path}`, {
    method: input.method,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${input.jwt}`,
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: input.body === undefined ? undefined : JSON.stringify(input.body),
    cache: "no-store",
  });

  if (!response.ok) {
    throw await createHostingGitHubApiError(response);
  }

  return await response.json().catch(() => ({})) as TValue;
}

export async function readHostingGitHubInstallationTokenForRepository(input: {
  owner: string;
  repo: string;
}) {
  const jwt = createHostingGitHubAppJwt();
  if (!jwt) return null;

  try {
    const installation = await readHostingGitHubRepositoryInstallation(input, jwt);
    if (!installation?.id) return null;

    const tokenPayload = await githubAppRequest<GitHubInstallationTokenResponse>({
      jwt,
      method: "POST",
      path: `/app/installations/${installation.id}/access_tokens`,
      body: {
        permissions: {
          contents: "write",
          metadata: "read",
          pull_requests: "write",
          workflows: "write",
          actions: "write",
        },
      },
    }).catch(async (error) => {
      if (error instanceof HostingGitHubApiError && error.status === 422) {
        return githubAppRequest<GitHubInstallationTokenResponse>({
          jwt,
          method: "POST",
          path: `/app/installations/${installation.id}/access_tokens`,
        });
      }
      throw error;
    });

    return tokenPayload.token
      ? {
          token: tokenPayload.token,
          installationId: installation.id,
          installationUrl: installation.html_url || null,
          permissions: installation.permissions || null,
          permissionIssue: resolveHostingGitHubInstallationPermissionIssue(installation),
          expiresAt: tokenPayload.expires_at || null,
        }
      : null;
  } catch {
    return null;
  }
}

export async function readHostingGitHubRepositoryInstallation(input: {
  owner: string;
  repo: string;
}, jwtOverride?: string | null) {
  const jwt = jwtOverride || createHostingGitHubAppJwt();
  if (!jwt) return null;
  return await githubAppRequest<GitHubInstallationResponse>({
    jwt,
    method: "GET",
    path: `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/installation`,
  }).catch(() => null);
}

function mapUserToAccount(user: GitHubUser): HostingGitHubAccount {
  return {
    id: `user:${user.login}`,
    login: user.login,
    name: user.name || user.login,
    avatarUrl: user.avatar_url || null,
    type: "user",
  };
}

function mapOrgToAccount(org: GitHubOrg): HostingGitHubAccount {
  return {
    id: `org:${org.login}`,
    login: org.login,
    name: org.login,
    avatarUrl: org.avatar_url || null,
    type: "organization",
  };
}

function formatUpdatedAt(value: string | null | undefined) {
  if (!value) return "Atualizado recentemente";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Atualizado recentemente";
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  }).format(date);
}

function mapRepo(repo: GitHubRepo): HostingRepository {
  return {
    id: String(repo.id),
    nodeId: repo.node_id || null,
    owner: repo.owner.login,
    name: repo.name,
    fullName: repo.full_name,
    description: repo.description || "Repositorio sem descricao.",
    language: repo.language || "Projeto",
    updatedAt: formatUpdatedAt(repo.pushed_at || repo.updated_at),
    branch: repo.default_branch || "main",
    private: repo.private,
    canWrite: Boolean(repo.permissions?.admin || repo.permissions?.maintain || repo.permissions?.push),
    htmlUrl: repo.html_url || undefined,
  };
}

export async function fetchHostingGitHubProfile(token: string) {
  const [user, orgs] = await Promise.all([
    githubFetch<GitHubUser>("/user", token),
    githubFetch<GitHubOrg[]>("/user/orgs?per_page=100", token),
  ]);

  return {
    user: mapUserToAccount(user),
    accounts: [mapUserToAccount(user), ...orgs.map(mapOrgToAccount)],
  };
}

export async function fetchHostingGitHubRepositories(input: {
  token: string;
  owner?: string | null;
  ownerType?: string | null;
  query?: string | null;
}) {
  const owner = input.owner?.trim();
  const ownerType = input.ownerType?.trim().toLowerCase();
  const query = input.query?.trim().toLowerCase() || "";
  const path =
    owner && ownerType === "organization"
      ? `/orgs/${encodeURIComponent(owner)}/repos?per_page=100&sort=updated&type=all`
      : owner && ownerType === "user"
        ? "/user/repos?per_page=100&sort=updated&type=all"
        : "/user/repos?per_page=100&sort=updated&type=all";
  const repos = await githubFetch<GitHubRepo[]>(path, input.token);
  const mapped = repos.map(mapRepo);

  if (!query) return mapped;

  return mapped.filter((repo) =>
    `${repo.owner}/${repo.name} ${repo.description} ${repo.language} ${repo.branch}`
      .toLowerCase()
      .includes(query),
  );
}

function languageFromPath(path: string) {
  const extension = path.split(".").pop()?.toLowerCase() || "";
  const languages: Record<string, string> = {
    js: "javascript",
    jsx: "javascript",
    ts: "typescript",
    tsx: "typescript",
    json: "json",
    css: "css",
    scss: "scss",
    html: "html",
    md: "markdown",
    yml: "yaml",
    yaml: "yaml",
    py: "python",
    sql: "sql",
    env: "dotenv",
  };
  return languages[extension] || null;
}

export type HostingGitHubFileNode = {
  name: string;
  path: string;
  type: "file" | "directory";
  language?: string | null;
  children?: HostingGitHubFileNode[];
};

export async function fetchHostingGitHubRepositoryTree(input: {
  token: string;
  owner: string;
  repo: string;
  branch: string;
}) {
  const payload = await githubFetch<GitHubTreeResponse>(
    `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/git/trees/${encodeURIComponent(input.branch)}?recursive=1`,
    input.token,
  );
  const root: HostingGitHubFileNode = {
    name: input.repo,
    path: "/",
    type: "directory",
    children: [],
  };
  const directoryMap = new Map<string, HostingGitHubFileNode>([["", root]]);
  const sortedTree = [...(payload.tree || [])].sort((a, b) =>
    String(a.path || "").localeCompare(String(b.path || "")),
  );

  for (const item of sortedTree) {
    const itemPath = item.path?.replace(/^\/+/, "");
    if (!itemPath) continue;
    const parts = itemPath.split("/");
    const name = parts[parts.length - 1] || itemPath;
    const parentPath = parts.slice(0, -1).join("/");
    const parent = directoryMap.get(parentPath) || root;
    const isDirectory = item.type === "tree";
    const node: HostingGitHubFileNode = {
      name,
      path: itemPath,
      type: isDirectory ? "directory" : "file",
      language: isDirectory ? null : languageFromPath(itemPath),
      children: isDirectory ? [] : undefined,
    };
    parent.children = parent.children || [];
    parent.children.push(node);
    if (isDirectory) directoryMap.set(itemPath, node);
  }

  const sortChildren = (node: HostingGitHubFileNode) => {
    if (!node.children?.length) return;
    node.children.sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    node.children.forEach(sortChildren);
  };
  sortChildren(root);
  return root.children || [];
}

function encodeGitHubContentPath(path: string) {
  return path.split("/").map(encodeURIComponent).join("/");
}

function encodeGitHubRefBranch(branch: string) {
  return branch.split("/").map(encodeURIComponent).join("/");
}

function normalizeFallbackBranch(value: string) {
  return value
    .trim()
    .replace(/^refs\/heads\//, "")
    .replace(/[^A-Za-z0-9._/-]+/g, "-")
    .replace(/\/+/g, "/")
    .replace(/(^[./-]+|[./-]+$)/g, "")
    .slice(0, 120) || `flowdesk/update-${crypto.randomBytes(4).toString("hex")}`;
}

function shouldTryGitHubFallbackBranch(error: unknown) {
  return error instanceof HostingGitHubApiError && (
    error.status === 403 ||
    error.status === 409 ||
    error.status === 422
  );
}

function resolveHostingGitHubAppId() {
  return (
    process.env.GITHUB_HOSTING_APP_ID ||
    process.env.GITHUB_APP_ID ||
    ""
  ).trim();
}

function resolveHostingGitHubAppSlug() {
  return (
    process.env.GITHUB_HOSTING_APP_SLUG ||
    process.env.GITHUB_APP_SLUG ||
    ""
  ).trim();
}

function resolveHostingGitHubAppPrivateKey() {
  const raw =
    process.env.GITHUB_HOSTING_APP_PRIVATE_KEY ||
    process.env.GITHUB_APP_PRIVATE_KEY ||
    "";
  const base64 =
    process.env.GITHUB_HOSTING_APP_PRIVATE_KEY_BASE64 ||
    process.env.GITHUB_APP_PRIVATE_KEY_BASE64 ||
    "";

  if (raw.trim()) return raw.trim().replace(/\\n/g, "\n");
  if (!base64.trim()) return "";

  try {
    return Buffer.from(base64.trim(), "base64").toString("utf8").trim();
  } catch {
    return "";
  }
}

export function isHostingGitHubAppConfigured() {
  return Boolean(resolveHostingGitHubAppId() && resolveHostingGitHubAppPrivateKey());
}

export function buildHostingGitHubAppInstallUrl() {
  const slug = resolveHostingGitHubAppSlug();
  return slug ? `https://github.com/apps/${encodeURIComponent(slug)}/installations/new` : null;
}

export function resolveHostingGitHubInstallationPermissionIssue(
  installation: Pick<GitHubInstallationResponse, "permissions"> | null | undefined,
) {
  const permissions = installation?.permissions || {};
  const required: Array<[string, string]> = [
    ["contents", "write"],
    ["pull_requests", "write"],
    ["workflows", "write"],
  ];
  const missing = required.filter(([key, value]) => permissions[key] !== value);
  if (!missing.length) return null;
  const labels = missing.map(([key, value]) => `${key}: ${value}`).join(", ");
  return `O GitHub App esta instalado, mas ainda nao recebeu permissao suficiente. Atualize as permissoes do app para: ${labels}.`;
}

export async function fetchHostingGitHubRepositoryFile(input: {
  token: string;
  owner: string;
  repo: string;
  branch: string;
  path: string;
}) {
  const payload = await githubFetch<GitHubContentResponse>(
    `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/contents/${encodeGitHubContentPath(input.path)}?ref=${encodeURIComponent(input.branch)}`,
    input.token,
  );
  if (payload.type !== "file" || payload.encoding !== "base64" || !payload.content) {
    return null;
  }
  const contentBase64 = payload.content.replace(/\s/g, "");
  return {
    name: payload.name || input.path.split("/").pop() || input.path,
    path: payload.path || input.path,
    sha: payload.sha || null,
    encoding: payload.encoding || null,
    content: Buffer.from(contentBase64, "base64").toString("utf8"),
    contentBase64,
    size: typeof payload.size === "number" ? payload.size : null,
    downloadUrl: payload.download_url || null,
    htmlUrl: payload.html_url || null,
  };
}

export async function fetchHostingGitHubRepositoryCommits(input: {
  token: string;
  owner: string;
  repo: string;
  branch: string;
  perPage?: number;
}) {
  const commits = await githubFetch<GitHubCommitListItem[]>(
    `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/commits?sha=${encodeURIComponent(input.branch)}&per_page=${Math.min(100, Math.max(1, input.perPage || 30))}`,
    input.token,
  );

  return commits
    .filter((commit) => commit.sha)
    .map((commit) => ({
      sha: commit.sha || "",
      htmlUrl: commit.html_url || null,
      message: commit.commit?.message || "Commit sem mensagem",
      author: commit.author?.login || commit.commit?.author?.name || commit.commit?.committer?.name || "GitHub",
      authorAvatarUrl: commit.author?.avatar_url || commit.committer?.avatar_url || null,
      committedAt: commit.commit?.committer?.date || commit.commit?.author?.date || null,
    }));
}

async function readGitHubFileSha(input: {
  token: string;
  owner: string;
  repo: string;
  branch: string;
  path: string;
}) {
  try {
    const current = await githubFetch<GitHubContentResponse>(
      `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/contents/${encodeGitHubContentPath(input.path)}?ref=${encodeURIComponent(input.branch)}`,
      input.token,
    );
    return current.sha || null;
  } catch (error) {
    if (error instanceof HostingGitHubApiError && error.status === 404) return null;
    throw error;
  }
}

async function commitGitHubContentToBranch(input: {
  token: string;
  owner: string;
  repo: string;
  branch: string;
  path: string;
  content: string;
  message: string;
}) {
  const sha = await readGitHubFileSha(input);

  const payload = await githubRequest<GitHubCommitFileResponse>({
    token: input.token,
    method: "PUT",
    path: `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/contents/${encodeGitHubContentPath(input.path)}`,
    body: {
      message: input.message,
      content: Buffer.from(input.content, "utf8").toString("base64"),
      branch: input.branch,
      ...(sha ? { sha } : {}),
    },
  });

  return {
    path: payload.content?.path || input.path,
    sha: payload.content?.sha || null,
    htmlUrl: payload.content?.html_url || null,
    commitSha: payload.commit?.sha || null,
    commitUrl: payload.commit?.html_url || null,
  };
}

async function ensureGitHubFallbackBranch(input: {
  token: string;
  owner: string;
  repo: string;
  baseBranch: string;
  fallbackBranch: string;
}) {
  const baseRef = await githubFetch<GitHubRefResponse>(
    `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/git/ref/heads/${encodeGitHubRefBranch(input.baseBranch)}`,
    input.token,
  );
  const baseSha = baseRef.object?.sha;
  if (!baseSha) {
    throw new HostingGitHubApiError(422, "Nao consegui localizar a branch base no GitHub.");
  }

  try {
    await githubRequest<GitHubRefResponse>({
      token: input.token,
      method: "POST",
      path: `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/git/refs`,
      body: {
        ref: `refs/heads/${input.fallbackBranch}`,
        sha: baseSha,
      },
    });
  } catch (error) {
    if (!(error instanceof HostingGitHubApiError) || error.status !== 422) throw error;
  }

  return input.fallbackBranch;
}

async function findOpenGitHubPullRequest(input: {
  token: string;
  owner: string;
  repo: string;
  baseBranch: string;
  headBranch: string;
}) {
  const pulls = await githubFetch<GitHubPullRequestResponse[]>(
    `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/pulls?state=open&base=${encodeURIComponent(input.baseBranch)}&head=${encodeURIComponent(`${input.owner}:${input.headBranch}`)}`,
    input.token,
  ).catch(() => []);
  return pulls[0] || null;
}

async function createGitHubPullRequest(input: {
  token: string;
  owner: string;
  repo: string;
  baseBranch: string;
  headBranch: string;
  title: string;
  body: string;
}) {
  try {
    return await githubRequest<GitHubPullRequestResponse>({
      token: input.token,
      method: "POST",
      path: `/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}/pulls`,
      body: {
        title: input.title,
        head: `${input.owner}:${input.headBranch}`,
        base: input.baseBranch,
        body: input.body,
        maintainer_can_modify: true,
      },
    });
  } catch (error) {
    if (error instanceof HostingGitHubApiError && error.status === 422) {
      const existing = await findOpenGitHubPullRequest(input);
      if (existing) return existing;
    }
    throw error;
  }
}

export async function commitHostingGitHubRepositoryFile(input: {
  token: string;
  owner: string;
  repo: string;
  branch: string;
  path: string;
  content: string;
  message: string;
  fallbackBranch?: string | null;
  pullRequestTitle?: string | null;
  pullRequestBody?: string | null;
  allowFallbackBranch?: boolean;
}) {
  try {
    const commit = await commitGitHubContentToBranch(input);
    return {
      ...commit,
      mode: "direct" as const,
      branch: input.branch,
      baseBranch: input.branch,
      pullRequestUrl: null,
      pullRequestNumber: null,
      fallbackReason: null,
    };
  } catch (error) {
    if (!input.allowFallbackBranch || !shouldTryGitHubFallbackBranch(error)) throw error;

    const fallbackBranch = normalizeFallbackBranch(
      input.fallbackBranch || `flowdesk/vps-${crypto.randomBytes(6).toString("hex")}`,
    );
    await ensureGitHubFallbackBranch({
      token: input.token,
      owner: input.owner,
      repo: input.repo,
      baseBranch: input.branch,
      fallbackBranch,
    });
    const commit = await commitGitHubContentToBranch({
      ...input,
      branch: fallbackBranch,
      message: `${input.message} (branch Flowdesk)`,
    });
    const pullRequest = await createGitHubPullRequest({
      token: input.token,
      owner: input.owner,
      repo: input.repo,
      baseBranch: input.branch,
      headBranch: fallbackBranch,
      title: input.pullRequestTitle || `Flowdesk: atualiza ${input.path}`,
      body: input.pullRequestBody || [
        "Alteracao criada automaticamente pelo painel Flowdesk.",
        "",
        `Arquivo: \`${input.path}\``,
        `Branch base: \`${input.branch}\``,
      ].join("\n"),
    }).catch(() => null);

    return {
      ...commit,
      mode: "branch" as const,
      branch: fallbackBranch,
      baseBranch: input.branch,
      pullRequestUrl: pullRequest?.html_url || null,
      pullRequestNumber: pullRequest?.number || null,
      fallbackReason: error instanceof HostingGitHubApiError ? error.githubMessage || error.message : null,
    };
  }
}
