import { createHash, createHmac } from "crypto";
import { getSupabaseAdminClientOrThrow } from "@/lib/supabaseAdmin";
import type { HostingKind } from "@/lib/hosting/catalog";
import {
  decryptFlowSecureValue,
  encryptFlowSecureValue,
} from "@/lib/security/flowSecure";

export type VpsRuntimeStatus =
  | "online"
  | "offline"
  | "restarting"
  | "deploying"
  | "crashed"
  | "suspended"
  | "unknown";

export type VpsAction = "start" | "stop" | "restart" | "deploy" | "rollback" | "sync";

export type HostingProjectAccess = {
  id: number;
  vps_code: string;
  user_id: number;
  payment_order_id: number | null;
  hosting_kind: HostingKind;
  hosting_plan_id: string;
  hosting_region_id: string;
  github_owner: string;
  github_repo: string;
  github_repo_id: string | null;
  github_branch: string;
  status: string;
  runtime_status?: VpsRuntimeStatus;
  runtime_status_payload?: unknown;
  runtime_last_seen_at?: string | null;
  billing_status?: string | null;
  access_expires_at?: string | null;
  refund_access_until?: string | null;
  refunded_at?: string | null;
  suspended_at?: string | null;
  suspension_reason?: string | null;
  windows_runtime: string;
  provisioning_payload: unknown;
  created_at: string;
  updated_at: string;
};

export type AgentRequestInput = {
  project: HostingProjectAccess;
  path: string;
  method?: "GET" | "POST" | "PUT" | "DELETE";
  body?: unknown;
  timeoutMs?: number;
};

export function normalizeVpsCode(value: unknown) {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
    normalized,
  )
    ? normalized
    : null;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function readNumber(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function resolveRuntimeStatus(value: unknown): VpsRuntimeStatus {
  return value === "online" ||
    value === "offline" ||
    value === "restarting" ||
    value === "deploying" ||
    value === "crashed" ||
    value === "suspended" ||
    value === "unknown"
    ? value
    : "unknown";
}

function resolveAgentBaseUrl() {
  return (
    process.env.HOSTING_AGENT_BASE_URL ||
    process.env.VPS_AGENT_BASE_URL ||
    process.env.FLOWDESK_VPS_AGENT_URL ||
    ""
  ).replace(/\/+$/, "");
}

function resolveAgentToken() {
  return (
    process.env.HOSTING_AGENT_TOKEN ||
    process.env.VPS_AGENT_TOKEN ||
    process.env.FLOWDESK_VPS_AGENT_TOKEN ||
    ""
  ).trim();
}

export function isVpsAgentConfigured() {
  return Boolean(resolveAgentBaseUrl() && resolveAgentToken());
}

export async function getHostingProjectForUser(input: {
  userId: number;
  vpsCode: string;
}) {
  const supabase = getSupabaseAdminClientOrThrow();
  const { data, error } = await supabase
    .from("hosting_projects")
    .select(
      "id, vps_code, user_id, payment_order_id, hosting_kind, hosting_plan_id, hosting_region_id, github_owner, github_repo, github_repo_id, github_branch, status, runtime_status, runtime_status_payload, runtime_last_seen_at, billing_status, access_expires_at, refund_access_until, refunded_at, suspended_at, suspension_reason, windows_runtime, provisioning_payload, created_at, updated_at",
    )
    .eq("vps_code", input.vpsCode)
    .eq("user_id", input.userId)
    .maybeSingle<HostingProjectAccess>();

  if (error) throw error;
  return data || null;
}

export function resolveHostingAccessState(input: {
  projectStatus?: string | null;
  billingStatus?: string | null;
  accessExpiresAt?: string | null;
  refundAccessUntil?: string | null;
  paymentStatus?: string | null;
}) {
  const nowMs = Date.now();
  const accessUntil = input.refundAccessUntil || input.accessExpiresAt || null;
  const accessUntilMs = accessUntil ? Date.parse(accessUntil) : Number.NaN;
  const isAccessExpired = Boolean(accessUntil && Number.isFinite(accessUntilMs) && accessUntilMs <= nowMs);
  const paymentStatus = String(input.paymentStatus || "").toLowerCase();
  const billingStatus = String(input.billingStatus || "").toLowerCase();
  const refunded = paymentStatus === "refunded" || paymentStatus === "partially_refunded" || billingStatus === "refunded";
  const chargedBack = paymentStatus === "charged_back" || billingStatus === "charged_back";
  const cancelled = billingStatus === "cancelled" || input.projectStatus === "cancelled";
  const suspended = input.projectStatus === "suspended" || billingStatus === "past_due" || billingStatus === "expired";
  const blocked = chargedBack || cancelled || isAccessExpired || (suspended && !refunded);

  return {
    accessUntil,
    isAccessExpired,
    refunded,
    chargedBack,
    cancelled,
    suspended,
    blocked,
    label: blocked
      ? "Bloqueada"
      : refunded
        ? "Restornada, acesso mantido ate a expiracao"
        : "Ativa",
  };
}

export async function appendVpsEvent(input: {
  projectId: number;
  userId: number | null;
  action: string;
  status: "pending" | "running" | "succeeded" | "failed";
  message?: string | null;
  requestPayload?: unknown;
  responsePayload?: unknown;
}) {
  const supabase = getSupabaseAdminClientOrThrow();
  await supabase.from("hosting_vps_action_events").insert({
    hosting_project_id: input.projectId,
    actor_user_id: input.userId,
    action: input.action,
    status: input.status,
    message: input.message || null,
    request_payload: input.requestPayload || {},
    response_payload: input.responsePayload || {},
    finished_at:
      input.status === "succeeded" || input.status === "failed"
        ? new Date().toISOString()
        : null,
  });
}

export async function updateProjectRuntimeStatus(input: {
  projectId: number;
  status: VpsRuntimeStatus;
  payload?: unknown;
}) {
  const supabase = getSupabaseAdminClientOrThrow();
  await supabase
    .from("hosting_projects")
    .update({
      runtime_status: input.status,
      runtime_status_payload: input.payload || {},
      runtime_last_seen_at: new Date().toISOString(),
      status:
        input.status === "suspended"
          ? "suspended"
          : input.status === "crashed"
            ? "failed"
            : undefined,
    })
    .eq("id", input.projectId);
}

export async function requestVpsAgent<T = unknown>(input: AgentRequestInput): Promise<T> {
  const baseUrl = resolveAgentBaseUrl();
  const token = resolveAgentToken();
  if (!baseUrl || !token) {
    throw new Error("Agente Windows da VPS nao configurado no backend.");
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), input.timeoutMs || 12_000);
  const body = input.body === undefined ? undefined : JSON.stringify(input.body);
  const signature = createHmac("sha256", token)
    .update(`${input.project.vps_code}:${input.method || "GET"}:${input.path}:${body || ""}`)
    .digest("hex");

  try {
    const response = await fetch(`${baseUrl}${input.path}`, {
      method: input.method || "GET",
      headers: {
        "Content-Type": "application/json",
        "X-Flowdesk-VPS": input.project.vps_code,
        "X-Flowdesk-Signature": signature,
        Authorization: `Bearer ${token}`,
      },
      body,
      cache: "no-store",
      signal: controller.signal,
    });
    const payload = (await response.json().catch(() => ({}))) as unknown;
    if (!response.ok) {
      const message = isRecord(payload) ? readString(payload.message) : null;
      throw new Error(message || `Agente recusou a operacao (${response.status}).`);
    }
    return payload as T;
  } finally {
    clearTimeout(timeoutId);
  }
}

export function maskSecretPreview(value: string) {
  if (!value) return "";
  if (value.length <= 4) return "ÔÇóÔÇóÔÇóÔÇó";
  return `${value.slice(0, 2)}ÔÇóÔÇóÔÇóÔÇó${value.slice(-2)}`;
}

function resolveEnvSecret() {
  return (
    process.env.HOSTING_ENV_SECRET ||
    process.env.VPS_ENV_SECRET ||
    process.env.AUTH_SECRET ||
    process.env.NEXTAUTH_SECRET ||
    ""
  );
}

export function encryptEnvValue(value: string) {
  const secret = resolveEnvSecret();
  if (!secret) throw new Error("HOSTING_ENV_SECRET nao configurado.");
  const encrypted = encryptFlowSecureValue(value, {
    purpose: "hosting_env_secret",
    subcontext: createHash("sha256").update(secret).digest("hex"),
  });
  if (!encrypted) throw new Error("Valor de variavel invalido.");
  return encrypted;
}

export function decryptEnvValue(value: string | null | undefined) {
  const secret = resolveEnvSecret();
  if (!secret) throw new Error("HOSTING_ENV_SECRET nao configurado.");
  return decryptFlowSecureValue(value, {
    purpose: "hosting_env_secret",
    subcontext: createHash("sha256").update(secret).digest("hex"),
    allowPlaintextFallback: false,
  });
}
