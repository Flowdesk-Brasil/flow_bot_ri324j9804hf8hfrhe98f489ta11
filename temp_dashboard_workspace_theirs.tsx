"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Bot,
  Check,
  CheckCircle2,
  ChevronRight,
  Cpu,
  Database,
  ExternalLink,
  GitBranch,
  Globe2,
  HardDrive,
  Image as ImageIcon,
  Loader2,
  MapPin,
  Rocket,
  Search,
  ShieldCheck,
  Zap,
} from "lucide-react";
import { ButtonLoader } from "@/components/login/ButtonLoader";
import { buildBrowserRoutingTargetFromInternalPath } from "@/lib/routing/subdomains";
import {
  HOSTING_KIND_OPTIONS,
  HOSTING_PLANS,
  HOSTING_REGIONS,
  HOSTING_STEP_PATH_BY_STEP,
  MOCK_GITHUB_REPOSITORIES,
  getHostingKindLabel,
  type HostingGitHubAccount,
  type HostingKind,
  type HostingPlan,
  type HostingRegion,
  type HostingRepository,
  type HostingStep,
} from "@/lib/hosting/catalog";

type HostingDraft = {
  kind: HostingKind | null;
  githubConnected: boolean;
  selectedGithubAccountLogin: string | null;
  selectedRepositoryId: string | null;
  selectedRepository: HostingRepository | null;
  selectedRegionId: string;
  selectedPlanId: string | null;
  vpsCode: string | null;
  step: HostingStep;
};

const STORAGE_KEY = "flowdesk_hosting_onboarding_v1";
const LEGACY_STORAGE_KEY = "flowdesk_hosting_onboarding_v1";
const GITHUB_HANDOFF_STORAGE_KEY = "flowdesk_hosting_github_handoff_v1";

const DEFAULT_DRAFT: HostingDraft = {
  kind: null,
  githubConnected: false,
  selectedGithubAccountLogin: null,
  selectedRepositoryId: null,
  selectedRepository: null,
  selectedRegionId: "br-sp",
  selectedPlanId: null,
  vpsCode: null,
  step: "kind",
};

const STEP_ORDER: HostingStep[] = ["kind", "github", "repository", "region", "plan", "payment", "ready"];

type StepDirection = "forward" | "backward";

type GitHubStatusResponse = {
  ok: boolean;
  connected: boolean;
  message?: string;
  accounts?: HostingGitHubAccount[];
  user?: HostingGitHubAccount;
  diagnostics?: {
    configured?: boolean;
    tokenPresent?: boolean;
    accountsCount?: number;
  };
};

type GitHubCompleteResponse = GitHubStatusResponse;

type GitHubRepositoriesResponse = {
  ok: boolean;
  message?: string;
  repositories?: HostingRepository[];
  hiddenUsedCount?: number;
  hiddenNoWriteCount?: number;
};

type HostingProvisionResponse = {
  ok: boolean;
  message?: string;
  vpsCode?: string;
  redirectUrl?: string;
};

export type HostingProjectCard = {
  id: number;
  vps_code: string;
  hosting_kind: HostingKind;
  hosting_plan_id: string;
  hosting_region_id: string;
  github_owner: string;
  github_repo: string;
  github_branch: string;
  status: string;
  runtime_status?: string | null;
  billing_status?: string | null;
  access_expires_at?: string | null;
  refund_access_until?: string | null;
  created_at?: string | null;
  payment_orders?: {
    status?: string | null;
    amount?: number | null;
    currency?: string | null;
    paid_at?: string | null;
    expires_at?: string | null;
  } | Array<{
    status?: string | null;
    amount?: number | null;
    currency?: string | null;
    paid_at?: string | null;
    expires_at?: string | null;
  }> | null;
};

function resolveStepDirection(from: HostingStep, to: HostingStep): StepDirection {
  return STEP_ORDER.indexOf(to) >= STEP_ORDER.indexOf(from) ? "forward" : "backward";
}

function formatMoney(amount: number, currency = "BRL") {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.round(amount * 100) / 100);
}

function readDraft() {
  if (typeof window === "undefined") return DEFAULT_DRAFT;
  try {
    window.localStorage.removeItem(LEGACY_STORAGE_KEY);
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_DRAFT;
    const parsed = JSON.parse(raw) as Partial<HostingDraft>;
    return {
      ...DEFAULT_DRAFT,
      ...parsed,
      selectedRegionId: parsed.selectedRegionId || "br-sp",
      step: STEP_ORDER.includes(parsed.step as HostingStep)
        ? (parsed.step as HostingStep)
        : "kind",
    };
  } catch {
    return DEFAULT_DRAFT;
  }
}

function writeDraft(draft: HostingDraft) {
  if (typeof window === "undefined") return;
  window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(draft));
}

function resolveVpsDisplayUrl(code: string) {
  return `https://fdesk.flwdesk.com/vps/${code}`;
}

function resolveVpsInternalPath(code: string) {
  return `/vps/${code}`;
}

function resolveKindIcon(kind: HostingKind) {
  if (kind === "site") return Globe2;
  if (kind === "bot") return Bot;
  return ImageIcon;
}

function formatHostingDate(value?: string | null) {
  if (!value) return "Sem data";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Sem data";
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
}

function readProjectPayment(project: HostingProjectCard) {
  return Array.isArray(project.payment_orders)
    ? project.payment_orders[0] || null
    : project.payment_orders || null;
}

function resolveProjectCardStatus(project: HostingProjectCard) {
  const payment = readProjectPayment(project);
  const accessUntil = project.refund_access_until || project.access_expires_at || payment?.expires_at || null;
  const accessMs = accessUntil ? Date.parse(accessUntil) : Number.NaN;
  const expired = Boolean(accessUntil && Number.isFinite(accessMs) && accessMs <= Date.now());
  const paymentStatus = String(payment?.status || "").toLowerCase();
  const billingStatus = String(project.billing_status || "").toLowerCase();
  if (paymentStatus === "charged_back" || billingStatus === "charged_back") {
    return { label: "Contestada", tone: "danger" as const, accessUntil };
  }
  if (expired || billingStatus === "expired") {
    return { label: "Expirada", tone: "danger" as const, accessUntil };
  }
  if (project.status === "suspended" || billingStatus === "past_due") {
    return { label: "Suspensa", tone: "warning" as const, accessUntil };
  }
  if (paymentStatus === "refunded" || paymentStatus === "partially_refunded" || billingStatus === "refunded") {
    return { label: "Restornada ate vencimento", tone: "warning" as const, accessUntil };
  }
  if (project.status === "active") {
    return { label: "Ativa", tone: "success" as const, accessUntil };
  }
  return { label: "Provisionando", tone: "info" as const, accessUntil };
}

function HostingProjectsOverview({
  projects,
  githubConnected,
  onCreate,
  onReconnect,
}: {
  projects: HostingProjectCard[];
  githubConnected: boolean;
  onCreate: () => void;
  onReconnect: () => void;
}) {
  const [reconnecting, setReconnecting] = useState(false);
  const [reconnectMessage, setReconnectMessage] = useState<string | null>(null);

  async function completeReconnect(handoffToken: unknown) {
    if (typeof handoffToken !== "string" || !handoffToken.trim()) {
      setReconnectMessage("GitHub autorizou, mas a validacao temporaria nao chegou ao painel.");
      return false;
    }

    const response = await fetch("/api/auth/me/hosting/github/complete", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      cache: "no-store",
      body: JSON.stringify({ handoffToken }),
    });
    const payload = await response.json() as GitHubCompleteResponse;
    setReconnectMessage(payload.message || null);
    if (response.ok && payload.connected) {
      onReconnect();
      return true;
    }
    return false;
  }

  async function processReconnectPayload(input: unknown) {
    const data = input as {
      source?: string;
      ok?: boolean;
      message?: string;
      handoffToken?: string | null;
    };
    if (data?.source !== "flowdesk-hosting-github") return false;
    window.localStorage.removeItem(GITHUB_HANDOFF_STORAGE_KEY);
    setReconnectMessage(data.message || null);
    if (!data.ok) return true;
    await completeReconnect(data.handoffToken);
    return true;
  }

  async function processStoredReconnectHandoff() {
    try {
      const raw = window.localStorage.getItem(GITHUB_HANDOFF_STORAGE_KEY);
      if (!raw) return false;
      return await processReconnectPayload(JSON.parse(raw) as unknown);
    } catch {
      window.localStorage.removeItem(GITHUB_HANDOFF_STORAGE_KEY);
      return false;
    }
  }

  async function reconnectGitHub() {
    if (reconnecting) return;
    setReconnecting(true);
    setReconnectMessage(null);
    const width = 540;
    const height = 720;
    const left = window.screenX + Math.max(0, (window.outerWidth - width) / 2);
    const top = window.screenY + Math.max(0, (window.outerHeight - height) / 2);
    const popup = window.open(
      "/api/auth/github/hosting/start?mode=reconnect",
      "flowdesk-hosting-github-reconnect",
      `width=${width},height=${height},left=${left},top=${top},popup=yes`,
    );

    if (!popup) {
      setReconnecting(false);
      setReconnectMessage("Permita popups para reconectar o GitHub.");
      return;
    }

    let finished = false;
    let timeoutId = 0;
    let pollIntervalId = 0;

    const finish = () => {
      finished = true;
      window.clearTimeout(timeoutId);
      window.clearInterval(pollIntervalId);
      window.removeEventListener("message", handleMessage);
      setReconnecting(false);
    };

    const poll = async () => {
      const processed = await processStoredReconnectHandoff();
      if (processed) {
        finish();
        return;
      }
      if (popup.closed) {
        const response = await fetch("/api/auth/me/hosting/github/status", { cache: "no-store" });
        const payload = await response.json() as GitHubStatusResponse;
        if (payload.connected) {
          onReconnect();
        } else {
          setReconnectMessage(payload.message || "A reconexao do GitHub nao foi concluida.");
        }
        finish();
      }
    };

    const handleMessage = (event: MessageEvent) => {
      void processReconnectPayload(event.data).then((processed) => {
        if (processed) finish();
      });
    };

    window.addEventListener("message", handleMessage);
    pollIntervalId = window.setInterval(() => {
      if (!finished) void poll();
    }, 700);
    timeoutId = window.setTimeout(() => {
      if (!finished) {
        setReconnectMessage("Tempo limite ao reconectar GitHub. Tente novamente.");
        finish();
      }
    }, 120_000);
  }

  if (!githubConnected) {
    return (
      <HostingShell>
        <div className="mx-auto flex min-h-[420px] w-full max-w-[620px] items-center justify-center">
          <div className="w-full rounded-[24px] border border-[#171717] bg-[#080808] p-[22px] text-center shadow-[0_24px_80px_rgba(0,0,0,0.28)]">
            <span className="mx-auto flex h-[56px] w-[56px] items-center justify-center rounded-[18px] border border-[#202020] bg-[#101010] text-white">
              <GitBranch className="h-[25px] w-[25px]" />
            </span>
            <h2 className="mt-[18px] text-[26px] font-semibold tracking-[-0.04em] text-white">
              Reconecte o GitHub
            </h2>
            <p className="mx-auto mt-[10px] max-w-[460px] text-[14px] leading-[1.55] text-[#8E8E8E]">
              Suas VPS continuam protegidas, mas precisamos validar o GitHub novamente para listar projetos, arquivos e deploys com seguranca.
            </p>
            <button
              type="button"
              onClick={() => void reconnectGitHub()}
              disabled={reconnecting}
              className="mt-[18px] inline-flex h-[44px] items-center justify-center gap-[9px] rounded-[12px] bg-[#F2F2F2] px-[16px] text-[13px] font-semibold text-[#050505] transition-colors hover:bg-white"
            >
              {reconnecting ? <Loader2 className="h-[16px] w-[16px] animate-spin" /> : <GitBranch className="h-[16px] w-[16px]" />}
              {reconnecting ? "Conectando..." : "Conectar GitHub"}
            </button>
            {reconnectMessage ? (
              <p className="mx-auto mt-[12px] max-w-[460px] rounded-[14px] border border-[#1B1B1B] bg-[#0B0B0B] px-[12px] py-[10px] text-[12px] leading-[1.5] text-[#8E8E8E]">
                {reconnectMessage}
              </p>
            ) : null}
          </div>
        </div>
      </HostingShell>
    );
  }

  return (
    <HostingShell>
      <div className="flex flex-col gap-[14px] md:flex-row md:items-end md:justify-between">
        <SectionHeader
          eyebrow="Hospedagem"
          title="Suas VPS"
          description="Gerencie as hospedagens ativas, acompanhe vencimento, repositorio, plano e abra o painel operacional de cada VPS."
        />
        <button
          type="button"
          onClick={onCreate}
          className="inline-flex h-[44px] items-center justify-center gap-[9px] rounded-[12px] bg-[#0F62FE] px-[16px] text-[13px] font-semibold text-white transition-colors hover:bg-[#2A73FF]"
        >
          <Rocket className="h-[16px] w-[16px]" />
          Adquirir uma hospedagem
        </button>
      </div>

      <div className="grid gap-[14px] xl:grid-cols-2">
        {projects.map((project) => {
          const Icon = resolveKindIcon(project.hosting_kind);
          const plan = HOSTING_PLANS[project.hosting_kind]?.find((item) => item.id === project.hosting_plan_id);
          const region = HOSTING_REGIONS.find((item) => item.id === project.hosting_region_id) || HOSTING_REGIONS[0];
          const status = resolveProjectCardStatus(project);
          const statusClass =
            status.tone === "success"
              ? "border-[rgba(52,168,83,0.28)] bg-[rgba(52,168,83,0.10)] text-[#9BE7AC]"
              : status.tone === "warning"
                ? "border-[rgba(255,190,80,0.28)] bg-[rgba(255,190,80,0.10)] text-[#FFD28A]"
                : status.tone === "danger"
                  ? "border-[rgba(255,82,82,0.28)] bg-[rgba(255,82,82,0.10)] text-[#FF9B9B]"
                  : "border-[rgba(15,98,254,0.28)] bg-[rgba(15,98,254,0.10)] text-[#9BC2FF]";
          return (
            <a
              key={project.vps_code}
              href={resolveVpsInternalPath(project.vps_code)}
              className="group overflow-hidden rounded-[22px] border border-[#171717] bg-[#080808] transition-colors hover:border-[#2A2A2A]"
            >
              <div className="grid min-h-[226px] md:grid-cols-[190px_minmax(0,1fr)]">
                <div className="relative overflow-hidden border-b border-[#171717] bg-[#0B0B0B] p-[18px] md:border-b-0 md:border-r">
                  <div className="absolute inset-x-0 bottom-0 h-[90px] bg-[linear-gradient(180deg,rgba(15,98,254,0)_0%,rgba(15,98,254,0.16)_100%)]" />
                  <div className="relative flex h-full min-h-[150px] flex-col justify-between">
                    <span className="flex h-[54px] w-[54px] items-center justify-center rounded-[16px] border border-[#202020] bg-[#111111] text-white">
                      <Icon className="h-[25px] w-[25px]" />
                    </span>
                    <div>
                      <p className="font-mono text-[12px] font-semibold text-[#777777]">{project.vps_code.slice(0, 8)}</p>
                      <p className="mt-[5px] text-[13px] font-semibold text-[#DADADA]">{getHostingKindLabel(project.hosting_kind)}</p>
                    </div>
                  </div>
                </div>
                <div className="min-w-0 p-[18px]">
                  <div className="flex flex-wrap items-start justify-between gap-[12px]">
                    <div className="min-w-0">
                      <h3 className="truncate text-[20px] font-semibold tracking-[-0.04em] text-white">
                        {project.github_repo}
                      </h3>
                      <p className="mt-[5px] truncate font-mono text-[12px] text-[#858585]">
                        {project.github_owner}/{project.github_repo} - {project.github_branch}
                      </p>
                    </div>
                    <span className={`rounded-full border px-[10px] py-[6px] text-[11px] font-bold uppercase tracking-[0.12em] ${statusClass}`}>
                      {status.label}
                    </span>
                  </div>
                  <div className="mt-[18px] grid gap-[10px] sm:grid-cols-3">
                    {[
                      ["Plano", plan?.name || project.hosting_plan_id],
                      ["Regiao", `${region.city}, ${region.country}`],
                      ["Acesso ate", formatHostingDate(status.accessUntil)],
                    ].map(([label, value]) => (
                      <div key={label} className="rounded-[14px] border border-[#151515] bg-[#0B0B0B] p-[12px]">
                        <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#555555]">{label}</p>
                        <p className="mt-[5px] truncate text-[13px] font-semibold text-[#DADADA]">{value}</p>
                      </div>
                    ))}
                  </div>
                  <div className="mt-[16px] flex items-center justify-between gap-[12px]">
                    <span className="text-[12px] text-[#777777]">Runtime: {project.runtime_status || "offline"}</span>
                    <span className="inline-flex items-center gap-[7px] text-[13px] font-semibold text-[#9BC2FF]">
                      Abrir painel
                      <ExternalLink className="h-[14px] w-[14px]" />
                    </span>
                  </div>
                </div>
              </div>
            </a>
          );
        })}
      </div>
    </HostingShell>
  );
}

function HostingShell({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <div className="mt-[26px] space-y-[18px] pb-[96px]">
      {children}
    </div>
  );
}

function StepRail({
  current,
  draft,
}: {
  current: HostingStep;
  draft: HostingDraft;
}) {
  const labels: Record<HostingStep, string> = {
    kind: "Tipo",
    github: "GitHub",
    repository: "Repositorio",
    region: "Localizacao",
    plan: "Plano",
    payment: "Pagamento",
    ready: "VPS",
  };
  const currentIndex = STEP_ORDER.indexOf(current);

  return (
    <div className="flex w-full gap-[8px] overflow-x-auto rounded-[18px] border border-[#171717] bg-[#080808] p-[8px]">
      {STEP_ORDER.map((step, index) => {
        const isActive = step === current;
        const isDone = index < currentIndex || (step === "github" && draft.githubConnected);
        return (
          <div
            key={step}
            className={`flex min-w-fit items-center gap-[8px] rounded-[12px] px-[12px] py-[9px] text-[12px] font-semibold transition-colors ${
              isActive
                ? "bg-[#0F62FE] text-white"
                : isDone
                  ? "bg-[rgba(52,168,83,0.10)] text-[#9BE7AC]"
                  : "bg-[#0D0D0D] text-[#666666]"
            }`}
          >
            <span className="flex h-[20px] w-[20px] items-center justify-center rounded-full bg-[rgba(255,255,255,0.08)]">
              {isDone ? <Check className="h-[12px] w-[12px]" /> : index + 1}
            </span>
            {labels[step]}
          </div>
        );
      })}
    </div>
  );
}

function SectionHeader({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div>
      <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-[#0F62FE]">
        {eyebrow}
      </p>
      <h2 className="mt-[8px] text-[26px] leading-[1.08] font-semibold tracking-[-0.04em] text-[#F1F1F1] md:text-[32px]">
        {title}
      </h2>
      <p className="mt-[10px] max-w-[760px] text-[14px] leading-[1.6] text-[#7D7D7D]">
        {description}
      </p>
    </div>
  );
}

function ActionButton({
  children,
  onClick,
  disabled = false,
  loading = false,
  icon,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  loading?: boolean;
  icon?: React.ReactNode;
}) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      onClick={onClick}
      className="inline-flex h-[44px] items-center justify-center gap-[9px] rounded-[12px] bg-[#0F62FE] px-[16px] text-[13px] font-semibold text-white transition-colors hover:bg-[#2A73FF] disabled:cursor-not-allowed disabled:bg-[#141414] disabled:text-[#555555]"
    >
      {loading ? <ButtonLoader size={16} colorClassName="text-white" /> : icon}
      {children}
    </button>
  );
}

function KindStep({
  draft,
  onPatch,
}: {
  draft: HostingDraft;
  onPatch: (patch: Partial<HostingDraft>) => void;
}) {
  return (
    <div className="space-y-[22px]">
      <SectionHeader
        eyebrow="Hospedagem"
        title="O que voce deseja hospedar?"
        description="Escolha o tipo de projeto para o painel preparar o fluxo correto de GitHub, recursos, plano e provisionamento na VPS Windows."
      />

      <div className="grid gap-[14px] lg:grid-cols-3">
        {HOSTING_KIND_OPTIONS.map((option) => {
          const Icon = resolveKindIcon(option.id);
          const selected = draft.kind === option.id;
          return (
            <button
              key={option.id}
              type="button"
              onClick={() =>
                onPatch({
                  kind: option.id,
                  selectedRepositoryId: null,
                  selectedRepository: null,
                  selectedPlanId: null,
                  vpsCode: null,
                  step: "github",
                })
              }
              className={`group flex min-h-[230px] flex-col justify-between rounded-[20px] border bg-[#080808] p-[18px] text-left transition-all ${
                selected
                  ? "border-[#0F62FE] shadow-[inset_0_0_0_1px_#0F62FE]"
                  : "border-[#171717] hover:border-[#2A2A2A]"
              }`}
            >
              <div>
                <div className="flex items-start justify-between gap-[16px]">
                  <span className="flex h-[48px] w-[48px] items-center justify-center rounded-[14px] border border-[#1B1B1B] bg-[#0E0E0E] text-[#E8E8E8]">
                    <Icon className="h-[22px] w-[22px]" />
                  </span>
                  <span
                    className={`flex h-[24px] w-[24px] items-center justify-center rounded-full border ${
                      selected
                        ? "border-[#0F62FE] bg-[#0F62FE] text-white"
                        : "border-[#2A2A2A] text-transparent"
                    }`}
                  >
                    <Check className="h-[13px] w-[13px]" />
                  </span>
                </div>
                <h3 className="mt-[20px] text-[20px] font-semibold tracking-[-0.04em] text-[#EEEEEE]">
                  {option.title}
                </h3>
                <p className="mt-[9px] text-[13px] leading-[1.6] text-[#858585]">
                  {option.description}
                </p>
              </div>
              <div className="mt-[18px] flex flex-wrap gap-[8px]">
                {option.bullets.map((bullet) => (
                  <span
                    key={bullet}
                    className="rounded-full border border-[#1D1D1D] bg-[#0D0D0D] px-[9px] py-[5px] text-[11px] font-semibold text-[#AFAFAF]"
                  >
                    {bullet}
                  </span>
                ))}
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function GithubStep({
  draft,
  onPatch,
}: {
  draft: HostingDraft;
  onPatch: (patch: Partial<HostingDraft>) => void;
}) {
  const [connecting, setConnecting] = useState(false);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [accounts, setAccounts] = useState<HostingGitHubAccount[]>([]);

  async function processGitHubPopupPayload(input: unknown) {
    const data = input as {
      source?: string;
      ok?: boolean;
      message?: string;
      handoffToken?: string | null;
      storedAt?: number;
    };

    if (data?.source !== "flowdesk-hosting-github") return false;
    window.localStorage.removeItem(GITHUB_HANDOFF_STORAGE_KEY);
    setMessage(data.message || null);

    if (!data.ok) {
      return true;
    }

    const completed = await completeGitHubConnection(data.handoffToken);
    if (!completed) {
      await refreshStatus(true);
    }

    return true;
  }

  async function processStoredGitHubHandoff() {
    let raw: string | null = null;
    try {
      raw = window.localStorage.getItem(GITHUB_HANDOFF_STORAGE_KEY);
    } catch {
      return false;
    }

    if (!raw) return false;

    try {
      const parsed = JSON.parse(raw) as unknown;
      return await processGitHubPopupPayload(parsed);
    } catch {
      window.localStorage.removeItem(GITHUB_HANDOFF_STORAGE_KEY);
      return false;
    }
  }

  async function completeGitHubConnection(handoffToken: unknown) {
    if (typeof handoffToken !== "string" || !handoffToken.trim()) {
      setMessage("GitHub autorizou, mas nao recebi a validacao temporaria do popup.");
      return false;
    }

    try {
      const response = await fetch("/api/auth/me/hosting/github/complete", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        cache: "no-store",
        body: JSON.stringify({ handoffToken }),
      });
      const payload = await response.json() as GitHubCompleteResponse;
      setMessage(payload.message || "GitHub conectado com sucesso.");
      setAccounts(payload.accounts || []);

      if (response.ok && payload.connected && payload.accounts?.length) {
        onPatch({
          githubConnected: true,
          selectedGithubAccountLogin:
            draft.selectedGithubAccountLogin || payload.accounts[0]?.login || null,
          step: "repository",
        });
        return true;
      }
    } catch {
      setMessage("Nao consegui concluir a validacao local do GitHub.");
    }

    return false;
  }

  async function refreshStatus(advanceWhenConnected = false) {
    setLoadingStatus(true);
    try {
      const response = await fetch("/api/auth/me/hosting/github/status", {
        cache: "no-store",
      });
      const payload = await response.json() as GitHubStatusResponse;
      setMessage(payload.message || null);
      setAccounts(payload.accounts || []);

      if (payload.connected && payload.accounts?.length) {
        onPatch({
          githubConnected: true,
          selectedGithubAccountLogin:
            draft.selectedGithubAccountLogin || payload.accounts[0]?.login || null,
          ...(advanceWhenConnected ? { step: "repository" as const } : {}),
        });
        return true;
      } else {
        onPatch({ githubConnected: false });
        if (advanceWhenConnected && !payload.message) {
          setMessage("GitHub ainda nao retornou uma conta valida para este dominio.");
        }
      }
    } catch {
      setMessage("Nao consegui consultar o GitHub agora.");
    } finally {
      setLoadingStatus(false);
    }

    return false;
  }

  useEffect(() => {
    processStoredGitHubHandoff().then((processed) => {
      if (!processed) {
        refreshStatus(false);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function connect() {
    setConnecting(true);
    setMessage(null);

    const width = 540;
    const height = 720;
    const left = window.screenX + Math.max(0, (window.outerWidth - width) / 2);
    const top = window.screenY + Math.max(0, (window.outerHeight - height) / 2);
    const popup = window.open(
      "/api/auth/github/hosting/start",
      "flowdesk-hosting-github",
      `width=${width},height=${height},left=${left},top=${top},popup=yes`,
    );

    if (!popup) {
      setConnecting(false);
      setMessage("Permita popups para conectar o GitHub.");
      return;
    }

    let timeoutId = 0;
    let pollIntervalId = 0;
    let finished = false;

    const finishConnectionAttempt = () => {
      finished = true;
      window.clearTimeout(timeoutId);
      window.clearInterval(pollIntervalId);
      window.removeEventListener("message", handleMessage);
      setConnecting(false);
    };

    const pollConnectionStatus = async () => {
      const processedHandoff = await processStoredGitHubHandoff();
      if (processedHandoff) {
        finishConnectionAttempt();
        return;
      }

      const connected = await refreshStatus(true);
      if (connected) {
        finishConnectionAttempt();
        return;
      }

      if (popup.closed && !finished) {
        finishConnectionAttempt();
        setMessage("GitHub autorizado. Conferindo permissao da conta...");
        await refreshStatus(true);
      }
    };

    const handleMessage = (event: MessageEvent) => {
      processGitHubPopupPayload(event.data).then((processed) => {
        if (processed) {
          finishConnectionAttempt();
        }
      });
    };

    timeoutId = window.setTimeout(() => {
      finishConnectionAttempt();
      setMessage("A janela do GitHub demorou para responder. Tente novamente.");
    }, 120_000);
    pollIntervalId = window.setInterval(pollConnectionStatus, 1_250);

    window.addEventListener("message", handleMessage);
  }

  return (
    <div className="grid gap-[18px] xl:grid-cols-[minmax(0,1fr)_380px]">
      <div className="rounded-[22px] border border-[#171717] bg-[#080808] p-[22px]">
        <SectionHeader
          eyebrow={draft.kind ? getHostingKindLabel(draft.kind) : "GitHub"}
          title="Conecte sua conta GitHub"
          description="O projeto continua no GitHub do usuario. A Flowdesk apenas recebe permissao para listar repositorios e preparar o clone/deploy na VPS Windows."
        />

        <div className="mt-[24px] rounded-[18px] border border-[#1A1A1A] bg-[#0B0B0B] p-[18px]">
          <div className="flex flex-col gap-[16px] md:flex-row md:items-center md:justify-between">
            <div className="flex items-center gap-[14px]">
              <span className="flex h-[52px] w-[52px] items-center justify-center rounded-[16px] bg-[#111111] text-white">
                <GitBranch className="h-[25px] w-[25px]" />
              </span>
              <div>
                <p className="text-[15px] font-semibold text-[#EEEEEE]">
                  {draft.githubConnected
                    ? `${draft.selectedGithubAccountLogin || accounts[0]?.login || "GitHub"} conectado`
                    : "GitHub ainda nao conectado"}
                </p>
                <p className="mt-[4px] text-[12px] text-[#777777]">
                  OAuth real com permissao para repositorios, organizacoes e clone seguro.
                </p>
                {message ? (
                  <p className="mt-[7px] text-[12px] font-medium text-[#9AAFFF]">{message}</p>
                ) : null}
              </div>
            </div>
            <ActionButton
              onClick={draft.githubConnected ? () => onPatch({ step: "repository" }) : connect}
              loading={connecting || loadingStatus}
              icon={draft.githubConnected ? <CheckCircle2 className="h-[16px] w-[16px]" /> : <GitBranch className="h-[16px] w-[16px]" />}
            >
              {draft.githubConnected ? "Continuar" : "Conectar GitHub"}
            </ActionButton>
          </div>
        </div>
      </div>

      <aside className="rounded-[22px] border border-[#171717] bg-[#080808] p-[18px]">
        <p className="text-[13px] font-bold uppercase tracking-[0.14em] text-[#606060]">
          Pipeline preparado
        </p>
        <div className="mt-[16px] space-y-[10px]">
          {[
            ["Clone seguro", "Puxa o repositorio escolhido sem armazenar credenciais abertas."],
            ["VPS Windows", "Provisionamento preparado para rodar Node, Python, builds e workers."],
            ["Deploy rastreavel", "Cada VPS recebe codigo unico, logs e painel de gerenciamento."],
          ].map(([title, description]) => (
            <div key={title} className="rounded-[14px] border border-[#151515] bg-[#0B0B0B] p-[13px]">
              <p className="text-[13px] font-semibold text-[#E8E8E8]">{title}</p>
              <p className="mt-[5px] text-[12px] leading-[1.5] text-[#777777]">{description}</p>
            </div>
          ))}
        </div>
      </aside>
    </div>
  );
}

function RepositoryStep({
  draft,
  onPatch,
}: {
  draft: HostingDraft;
  onPatch: (patch: Partial<HostingDraft>) => void;
}) {
  const [query, setQuery] = useState("");
  const [accounts, setAccounts] = useState<HostingGitHubAccount[]>([]);
  const [repositories, setRepositories] = useState<HostingRepository[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);
  const [hiddenUsedCount, setHiddenUsedCount] = useState(0);
  const [hiddenNoWriteCount, setHiddenNoWriteCount] = useState(0);
  const selectedAccount = draft.selectedGithubAccountLogin || accounts[0]?.login || "";
  const selectedAccountRecord = accounts.find((account) => account.login === selectedAccount) || accounts[0] || null;

  async function loadAccounts() {
    const response = await fetch("/api/auth/me/hosting/github/status", {
      cache: "no-store",
    });
    const payload = await response.json() as GitHubStatusResponse;
    if (!payload.connected) {
      onPatch({ githubConnected: false, step: "github" });
      return [];
    }
    const nextAccounts = payload.accounts || [];
    setAccounts(nextAccounts);
    if (!draft.selectedGithubAccountLogin && nextAccounts[0]) {
      onPatch({ selectedGithubAccountLogin: nextAccounts[0].login });
    }
    return nextAccounts;
  }

  async function loadRepositories(owner: string, search = query) {
    setLoading(true);
    setMessage(null);
    try {
      const params = new URLSearchParams();
      if (owner) params.set("owner", owner);
      const ownerType =
        accounts.find((account) => account.login === owner)?.type ||
        selectedAccountRecord?.type;
      if (ownerType) params.set("ownerType", ownerType);
      if (search.trim()) params.set("q", search.trim());
      const response = await fetch(`/api/auth/me/hosting/github/repositories?${params.toString()}`, {
        cache: "no-store",
      });
      const payload = await response.json() as GitHubRepositoriesResponse;
      if (!response.ok || !payload.ok) {
        throw new Error(payload.message || "Nao foi possivel carregar repositorios.");
      }
      setRepositories(payload.repositories || []);
      setHiddenUsedCount(payload.hiddenUsedCount || 0);
      setHiddenNoWriteCount(payload.hiddenNoWriteCount || 0);
    } catch (error) {
      setRepositories([]);
      setHiddenUsedCount(0);
      setHiddenNoWriteCount(0);
      setMessage(error instanceof Error ? error.message : "Nao foi possivel carregar repositorios.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      const nextAccounts = await loadAccounts();
      if (cancelled) return;
      const owner = draft.selectedGithubAccountLogin || nextAccounts[0]?.login || "";
      await loadRepositories(owner);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedAccount) return;
    const timeoutId = window.setTimeout(() => {
      loadRepositories(selectedAccount, query);
    }, 250);
    return () => window.clearTimeout(timeoutId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, selectedAccount]);

  return (
    <div className="space-y-[18px]">
      <SectionHeader
        eyebrow="Repositorio"
        title="Escolha o projeto que sera hospedado"
        description="Selecione o repositorio GitHub que o painel deve puxar para a VPS Windows. Depois voce escolhe a regiao e o plano."
      />
      <div className="grid gap-[10px] md:grid-cols-[minmax(0,1fr)_260px]">
        <div className="flex min-h-[46px] items-center gap-[10px] rounded-[14px] border border-[#171717] bg-[#090909] px-[14px]">
          <Search className="h-[17px] w-[17px] text-[#666666]" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Procurar repositorio..."
            className="h-full flex-1 bg-transparent text-[14px] text-[#E8E8E8] outline-none placeholder:text-[#555555]"
          />
        </div>
        <select
          value={selectedAccount}
          onChange={(event) => {
            if (event.target.value === "__add__") {
              onPatch({ step: "github" });
              return;
            }
            onPatch({
              selectedGithubAccountLogin: event.target.value,
              selectedRepositoryId: null,
              selectedRepository: null,
            });
          }}
          className="h-[46px] rounded-[14px] border border-[#171717] bg-[#090909] px-[13px] text-[13px] font-semibold text-[#E8E8E8] outline-none transition-colors hover:border-[#2A2A2A]"
        >
          {accounts.map((account) => (
            <option key={account.id} value={account.login}>
              {account.name || account.login}
            </option>
          ))}
          <option value="__add__">Add Github Account</option>
        </select>
      </div>
      <div className="overflow-hidden rounded-[20px] border border-[#171717] bg-[#080808]">
        <div className={repositories.length > 5 ? "max-h-[438px] overflow-y-auto" : ""}>
        {loading ? (
          <div className="flex min-h-[140px] items-center justify-center gap-[10px] text-[13px] font-semibold text-[#777777]">
            <Loader2 className="h-[17px] w-[17px] animate-spin" />
            Carregando repositorios...
          </div>
        ) : null}
        {!loading && message ? (
          <div className="p-[18px] text-[13px] font-medium text-[#F3DD7A]">{message}</div>
        ) : null}
        {!loading && !message && repositories.length === 0 ? (
          <div className="p-[18px] text-[13px] font-medium text-[#777777]">
            {hiddenUsedCount > 0
              ? "Todos os repositorios encontrados nessa conta ja estao vinculados a uma VPS. Escolha outra conta/organizacao ou crie um novo repositorio."
              : hiddenNoWriteCount > 0
                ? "Os repositorios encontrados nessa conta nao liberaram escrita para o Flowdesk. Reconecte o GitHub com acesso total ou ajuste a permissao da organizacao."
                : "Nenhum repositorio encontrado nessa conta."}
          </div>
        ) : null}
        {!loading && !message && hiddenUsedCount > 0 && repositories.length > 0 ? (
          <div className="border-b border-[#151515] bg-[#0B0B0B] px-[18px] py-[12px] text-[12px] font-medium text-[#8E8E8E]">
            {hiddenUsedCount} repositorio(s) ja vinculado(s) a outra VPS foram ocultados para evitar duplicidade.
          </div>
        ) : null}
        {!loading && !message && hiddenNoWriteCount > 0 ? (
          <div className="border-b border-[#151515] bg-[#0B0B0B] px-[18px] py-[12px] text-[12px] font-medium text-[#8E8E8E]">
            {hiddenNoWriteCount} repositorio(s) sem permissao de escrita foram ocultados. Reconecte o GitHub com acesso total ou ajuste a permissao na organizacao.
          </div>
        ) : null}
        {!loading && !message ? repositories.map((repo) => {
          const selected = draft.selectedRepositoryId === repo.id;
          return (
            <button
              key={repo.id}
              type="button"
            onClick={() =>
                onPatch({
                  selectedRepositoryId: repo.id,
                  selectedRepository: repo,
                  step: "region",
                })
              }
              className={`flex w-full items-center justify-between gap-[16px] border-b border-[#151515] px-[18px] py-[16px] text-left transition-colors last:border-b-0 ${
                selected ? "bg-[rgba(15,98,254,0.10)]" : "hover:bg-[#0D0D0D]"
              }`}
            >
              <div className="flex min-w-0 items-center gap-[14px]">
                <span className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-[13px] border border-[#1D1D1D] bg-[#0F0F0F] text-[#DADADA]">
                  <GitBranch className="h-[19px] w-[19px]" />
                </span>
                <div className="min-w-0">
                  <p className="truncate text-[15px] font-semibold text-[#EEEEEE]">
                    {repo.fullName || `${repo.owner}/${repo.name}`}
                  </p>
                  <p className="mt-[4px] line-clamp-1 text-[12px] text-[#777777]">{repo.description}</p>
                  <div className="mt-[8px] flex flex-wrap gap-[7px]">
                    <span className="rounded-full bg-[#111111] px-[8px] py-[4px] text-[11px] font-semibold text-[#AFAFAF]">
                      {repo.language}
                    </span>
                    <span className="rounded-full bg-[#111111] px-[8px] py-[4px] text-[11px] font-semibold text-[#AFAFAF]">
                      {repo.branch}
                    </span>
                    <span className="rounded-full bg-[#111111] px-[8px] py-[4px] text-[11px] font-semibold text-[#AFAFAF]">
                      {repo.private ? "Privado" : "Publico"}
                    </span>
                  </div>
                </div>
              </div>
              <div className="hidden items-center gap-[12px] md:flex">
                <span className="text-[12px] font-medium text-[#686868]">{repo.updatedAt}</span>
                <ChevronRight className="h-[18px] w-[18px] text-[#555555]" />
              </div>
            </button>
          );
        }) : null}
        </div>
      </div>
    </div>
  );
}

function WorldLatencyMap({ region }: { region: HostingRegion }) {
  const activePoint = {
    x: region.coordinates.x * 10,
    y: region.coordinates.y * 5.2,
  };
  const edgePoints = [
    { label: "Virginia", x: 260, y: 205, ping: 142 },
    { label: "Frankfurt", x: 507, y: 177, ping: 188 },
    { label: "London", x: 480, y: 160, ping: 176 },
    { label: "Singapore", x: 748, y: 295, ping: 312 },
    { label: "Tokyo", x: 836, y: 210, ping: 288 },
    { label: "Sydney", x: 850, y: 397, ping: 334 },
  ];

  return (
    <div className="relative min-h-[350px] overflow-hidden px-[2px] py-[4px]">
      <div className="absolute inset-x-[8%] top-[18%] h-[62%] rounded-full bg-[radial-gradient(circle_at_44%_58%,rgba(52,168,83,0.16),transparent_34%),radial-gradient(circle_at_70%_36%,rgba(15,98,254,0.13),transparent_42%)] blur-[2px]" />
      <div className="relative z-10 flex items-center justify-between gap-[14px]">
        <div>
          <p className="text-[13px] font-semibold text-[#E8E8E8]">Mapa mundial de latencia</p>
          <p className="mt-[4px] text-[12px] text-[#777777]">Ponto ativo em {region.city}, {region.country}</p>
        </div>
        <span className="rounded-full border border-[rgba(52,168,83,0.28)] bg-[rgba(52,168,83,0.12)] px-[10px] py-[6px] text-[12px] font-bold text-[#9BE7AC] shadow-[0_0_24px_rgba(52,168,83,0.12)]">
          {region.pingMs} ms
        </span>
      </div>
      <div className="relative z-10 mx-auto mt-[8px] aspect-[1.92] w-full max-w-[720px]">
        <svg viewBox="0 0 1000 520" className="h-full w-full" role="img" aria-label="Mapa mundial de latencia">
          <defs>
            <linearGradient id="mapLand" x1="0" x2="1" y1="0" y2="1">
              <stop offset="0%" stopColor="#EAF1FF" stopOpacity="0.28" />
              <stop offset="100%" stopColor="#9FB0CF" stopOpacity="0.13" />
            </linearGradient>
            <filter id="softGlow" x="-80%" y="-80%" width="260%" height="260%">
              <feGaussianBlur stdDeviation="8" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          <g fill="none" stroke="#FFFFFF" strokeOpacity="0.055" strokeWidth="1">
            {[120, 190, 260, 330, 400].map((y) => (
              <path key={y} d={`M54 ${y}C205 ${y - 22} 382 ${y + 18} 500 ${y}C650 ${y - 24} 804 ${y + 18} 946 ${y}`} />
            ))}
            {[160, 330, 500, 670, 840].map((x) => (
              <path key={x} d={`M${x} 72C${x - 32} 180 ${x + 32} 322 ${x} 458`} />
            ))}
          </g>

          <g fill="url(#mapLand)" stroke="#F5F8FF" strokeOpacity="0.16" strokeWidth="1.15">
            <path d="M126 152c31-31 81-43 131-34 42 8 82 34 91 72 8 33-18 50-44 58-27 8-38 22-36 49 2 32-19 58-50 67-31 9-70-2-86-30-13-24-31-34-62-40-39-8-63-32-64-67-1-30 24-53 58-61 23-5 41-8 62-14Z" />
            <path d="M260 306c23 9 42 35 42 70 0 36-24 74-59 91-20-46-21-111 17-161Z" />
            <path d="M400 133c38-31 91-43 155-31 46 8 79 31 89 63 10 34-10 55-39 62-21 6-30 18-20 35 13 22 47 27 71 47 28 23 22 62-10 83-42 28-101 22-135-13-21-22-40-26-75-10-45 20-91 5-110-34-18-37-3-74 35-91 25-11 34-31 21-58-9-19-3-38 18-53Z" />
            <path d="M583 145c44-35 105-45 172-28 50 13 78 46 67 83-9 30-1 48 28 65 45 27 50 74 13 105-34 28-88 29-122 3-25-19-49-23-80-12-39 14-79-3-96-41-18-40 1-81 42-94 25-8 34-31 23-56-7-15-16-20-47-25Z" />
            <path d="M766 346c36-15 83-6 112 22 30 30 24 78-14 101-50-23-83-66-98-123Z" />
            <path d="M488 110c19-15 56-16 83-4-21 20-59 22-83 4Z" opacity="0.74" />
            <path d="M642 96c30-15 69-13 97 4-28 16-68 18-97-4Z" opacity="0.68" />
          </g>

          <g strokeLinecap="round">
            {edgePoints.map((point) => (
              <path
                key={`${point.label}-route`}
                d={`M${activePoint.x} ${activePoint.y}C${(activePoint.x + point.x) / 2} ${Math.min(activePoint.y, point.y) - 58} ${(activePoint.x + point.x) / 2} ${Math.min(activePoint.y, point.y) - 58} ${point.x} ${point.y}`}
                fill="none"
                stroke="#7F8EA8"
                strokeOpacity="0.16"
                strokeWidth="1.4"
                strokeDasharray="4 8"
              />
            ))}
          </g>

          <g>
            {edgePoints.map((point) => (
              <g key={point.label}>
                <path
                  d={`M ${point.x} ${point.y} m -5 -8 a 8 8 0 1 1 10 0 c 0 6 -5 12 -5 12 s -5 -6 -5 -12`}
                  fill="#7C8AA5"
                  opacity="0.76"
                />
                <text x={point.x + 13} y={point.y + 4} fill="#8D98AD" fontSize="13" fontWeight="600">
                  {point.ping}ms
                </text>
              </g>
            ))}
          </g>

          <g filter="url(#softGlow)">
            <circle cx={activePoint.x} cy={activePoint.y} r="9" fill="#34A853" />
            <circle cx={activePoint.x} cy={activePoint.y} r="4" fill="#E8FFF0" />
            <circle cx={activePoint.x} cy={activePoint.y} r="24" fill="none" stroke="#34A853" strokeWidth="2" opacity="0.34">
              <animate attributeName="r" from="16" to="42" dur="1.9s" repeatCount="indefinite" />
              <animate attributeName="opacity" from="0.46" to="0" dur="1.9s" repeatCount="indefinite" />
            </circle>
            <circle cx={activePoint.x} cy={activePoint.y} r="44" fill="rgba(52,168,83,0.08)" />
          </g>
          <g>
            <rect x={activePoint.x + 16} y={activePoint.y - 42} width="132" height="34" rx="17" fill="#0B0F0D" fillOpacity="0.88" stroke="#34A853" strokeOpacity="0.2" />
            <text x={activePoint.x + 32} y={activePoint.y - 20} fill="#DFFFE8" fontSize="13" fontWeight="700">
              {region.city} - {region.pingMs}ms
            </text>
          </g>
        </svg>
      </div>
    </div>
  );
}

function RegionStep({
  draft,
  onPatch,
}: {
  draft: HostingDraft;
  onPatch: (patch: Partial<HostingDraft>) => void;
}) {
  const selectedRegion = HOSTING_REGIONS.find((region) => region.id === draft.selectedRegionId) || HOSTING_REGIONS[0];
  const [isRegionMenuOpen, setIsRegionMenuOpen] = useState(false);

  return (
    <div className="grid gap-[18px] xl:grid-cols-[minmax(0,0.88fr)_minmax(420px,1fr)]">
      <div className="space-y-[18px]">
        <SectionHeader
          eyebrow="Localizacao"
          title="Escolha o local de servidor"
          description="Por enquanto a primeira regiao disponivel e Sao Paulo. A estrutura ja esta preparada para novas regioes e comparacao de ping."
        />
        <div className="relative">
          <button
            type="button"
            aria-expanded={isRegionMenuOpen}
            onClick={() => setIsRegionMenuOpen((current) => !current)}
            className="flex min-h-[56px] w-full items-center gap-[12px] rounded-[16px] border border-[#171717] bg-[#080808] px-[14px] text-left transition-colors hover:border-[#252525] hover:bg-[#0C0C0C]"
          >
            <span className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[12px] border border-[rgba(155,231,172,0.22)] bg-[rgba(52,168,83,0.08)]">
              <MapPin className="h-[17px] w-[17px] text-[#9BE7AC]" />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[14px] font-semibold text-[#EEEEEE]">
                {selectedRegion.name}
              </span>
              <span className="mt-[3px] block truncate text-[12px] text-[#777777]">
                Melhor latencia {selectedRegion.pingMs} ms
              </span>
            </span>
            <span className="rounded-full border border-[rgba(52,168,83,0.2)] bg-[rgba(52,168,83,0.08)] px-[9px] py-[4px] text-[11px] font-semibold text-[#9BE7AC]">
              Disponivel
            </span>
            <ChevronRight
              className={`h-[18px] w-[18px] text-[#777777] transition-transform ${
                isRegionMenuOpen ? "-rotate-90" : "rotate-90"
              }`}
            />
          </button>
          {isRegionMenuOpen ? (
            <div className="absolute left-0 right-0 top-[64px] z-30 overflow-hidden rounded-[16px] border border-[#202020] bg-[#080808] p-[6px] shadow-[0_22px_60px_rgba(0,0,0,0.45)]">
              {HOSTING_REGIONS.map((region) => {
                const isSelected = region.id === selectedRegion.id;
                return (
                  <button
                    key={region.id}
                    type="button"
                    onClick={() => {
                      onPatch({ selectedRegionId: region.id });
                      setIsRegionMenuOpen(false);
                    }}
                    className={`flex w-full items-center gap-[12px] rounded-[12px] px-[10px] py-[10px] text-left transition-colors ${
                      isSelected ? "bg-[#101A12]" : "hover:bg-[#101010]"
                    }`}
                  >
                    <span className="flex h-[32px] w-[32px] shrink-0 items-center justify-center rounded-[11px] bg-[#111111]">
                      <MapPin className="h-[16px] w-[16px] text-[#9BE7AC]" />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] font-semibold text-[#EEEEEE]">
                        {region.name}
                      </span>
                      <span className="mt-[2px] block text-[12px] text-[#777777]">
                        {region.city}, {region.country} - {region.pingMs} ms
                      </span>
                    </span>
                    <span
                      className={`rounded-full px-[8px] py-[4px] text-[11px] font-semibold ${
                        region.status === "available"
                          ? "bg-[rgba(52,168,83,0.1)] text-[#9BE7AC]"
                          : "bg-[#151515] text-[#777777]"
                      }`}
                    >
                      {region.status === "available" ? "Ativo" : "Em breve"}
                    </span>
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
        <div className="rounded-[16px] border border-[rgba(52,168,83,0.18)] bg-[rgba(52,168,83,0.07)] p-[14px]">
          <p className="text-[13px] leading-[1.55] text-[#C8EAD0]">
            A VPS Windows sera provisionada nessa regiao e o deploy puxara o repositorio selecionado diretamente do GitHub.
          </p>
        </div>
        <ActionButton onClick={() => onPatch({ step: "plan" })} icon={<ChevronRight className="h-[16px] w-[16px]" />}>
          Continuar para planos
        </ActionButton>
      </div>
      <WorldLatencyMap region={selectedRegion} />
    </div>
  );
}

function HostingPlanCard({
  plan,
  selected,
  onSelect,
}: {
  plan: HostingPlan;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <div className="relative w-full max-w-[372px] justify-self-center min-[1580px]:max-w-none">
      {plan.recommended ? (
        <>
          <div className="pointer-events-none absolute inset-x-0 top-0 z-10 hidden h-[304px] rounded-[25px] bg-[#0062FF] min-[1580px]:top-[-43px] min-[1580px]:block" />
          <div className="absolute inset-x-0 top-0 z-30 hidden h-[45px] items-center justify-center px-[20px] text-center text-[13px] leading-none font-medium tracking-[0.02em] text-white min-[1580px]:top-[-43px] min-[1580px]:flex">
            RECOMENDADO
          </div>
        </>
      ) : null}
      <article
        className={`relative z-20 flex h-full flex-col items-start overflow-hidden rounded-[24px] bg-[#0A0A0A] px-[20px] pb-[18px] pt-[20px] text-left ${
          plan.recommended
            ? "shadow-[inset_0_0_0_2px_#0062FF] min-[1580px]:shadow-[inset_2px_0_0_#0062FF,inset_-2px_0_0_#0062FF,inset_0_-2px_0_#0062FF]"
            : "shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]"
        }`}
      >
        <div className="absolute right-[20px] top-[20px] rounded-[8px] bg-[#0062FF] px-[14px] py-[6px] text-[13px] leading-none font-medium text-white">
          {plan.badge}
        </div>
        <div className="mt-[28px] flex w-full flex-col items-start text-left">
          <h3 className="w-full max-w-[220px] text-[22px] leading-none font-normal text-[rgba(218,218,218,0.92)]">
            {plan.name}
          </h3>
          <p className="mt-[14px] w-full text-[16px] leading-none font-normal text-[rgba(255,255,255,0.2)] line-through">
            {formatMoney(plan.compareMonthlyAmount, plan.currency)}
          </p>
          <div className="mt-[10px] flex w-full items-baseline justify-start gap-[4px] overflow-visible pb-[4px] text-left">
            <span className="whitespace-nowrap text-[35px] leading-[1.02] font-semibold tracking-[-0.04em] text-[rgba(255,255,255,0.5)]">
              {formatMoney(plan.monthlyAmount, plan.currency)}
            </span>
            <span className="whitespace-nowrap text-[17px] leading-[1.02] font-semibold text-[rgba(255,255,255,0.5)]">
              {plan.billingLabel}
            </span>
          </div>
        </div>
        <div className="mt-[14px] flex min-h-[24px] w-full items-center justify-center rounded-[8px] bg-[#111111] px-[12px] text-center text-[12px] leading-none font-medium text-[#0062FF]">
          {plan.cycleBadge || plan.limitedOffer}
        </div>
        <button
          type="button"
          onClick={onSelect}
          className={`mt-[20px] inline-flex h-[50px] w-full items-center justify-center rounded-[12px] px-6 text-[16px] font-semibold transition-colors ${
            selected
              ? "bg-[#0F62FE] text-white"
              : "bg-white text-[#111111] hover:bg-[#E8E8E8]"
          }`}
        >
          {selected ? "Plano selecionado" : "Selecionar"}
        </button>
        <p className="mt-[16px] min-h-[48px] text-[13px] leading-[1.22] font-normal text-[rgba(218,218,218,0.3)]">
          {plan.description}
        </p>
        <div className="mt-[18px] h-px w-full bg-[rgba(255,255,255,0.04)]" />
        <div className="mt-[18px] flex flex-col gap-[14px]">
          {plan.specs.map((feature, index) => {
            const icons = [Cpu, Database, HardDrive, Zap, ShieldCheck];
            const Icon = icons[index] || CheckCircle2;
            return (
              <div key={feature} className="flex items-center gap-[10px]">
                <Icon className="h-[16px] w-[16px] text-[#0F62FE]" />
                <span className="text-[14px] leading-none font-medium text-[rgba(218,218,218,0.34)]">
                  {feature}
                </span>
              </div>
            );
          })}
        </div>
      </article>
    </div>
  );
}

function PlanStep({
  draft,
  onPatch,
}: {
  draft: HostingDraft;
  onPatch: (patch: Partial<HostingDraft>) => void;
}) {
  const plans = draft.kind ? HOSTING_PLANS[draft.kind] : [];
  const selectedPlan = plans.find((plan) => plan.id === draft.selectedPlanId) || null;

  return (
    <div className="space-y-[24px]">
      <div className="flex flex-col gap-[14px] md:flex-row md:items-end md:justify-between">
        <SectionHeader
          eyebrow="Planos"
          title={`Escolha o plano para ${draft.kind ? getHostingKindLabel(draft.kind).toLowerCase() : "hospedagem"}`}
          description="Cards no mesmo padrao visual de /servers/plans, com recursos adaptados para hospedagem em VPS Windows."
        />
        <ActionButton
          disabled={!selectedPlan}
          onClick={() => onPatch({ step: "payment" })}
          icon={<ChevronRight className="h-[16px] w-[16px]" />}
        >
          Continuar
        </ActionButton>
      </div>
      <div className="grid w-full max-w-[372px] grid-cols-1 items-start justify-items-center gap-x-[12px] gap-y-[26px] min-[900px]:max-w-[756px] min-[900px]:grid-cols-2 min-[1580px]:max-w-none min-[1580px]:grid-cols-3 min-[1580px]:justify-items-stretch">
        {plans.map((plan) => (
          <HostingPlanCard
            key={plan.id}
            plan={plan}
            selected={draft.selectedPlanId === plan.id}
            onSelect={() => onPatch({ selectedPlanId: plan.id })}
          />
        ))}
      </div>
    </div>
  );
}

function PaymentStep({
  draft,
  repository,
  region,
  plan,
  onPatch,
}: {
  draft: HostingDraft;
  repository: HostingRepository | null;
  region: HostingRegion;
  plan: HostingPlan | null;
  onPatch: (patch: Partial<HostingDraft>) => void;
}) {
  const [provisioning, setProvisioning] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [autoCheckoutStarted, setAutoCheckoutStarted] = useState(false);
  const checkoutHref = useMemo(() => {
    if (!plan || !draft.kind) return "#";
    const params = new URLSearchParams({
      source: "dashboard-hosting",
      hostingKind: draft.kind,
      hostingPlan: plan.id,
      hostingRegion: region.id,
      repository: repository ? `${repository.owner}/${repository.name}` : "",
      amount: String(plan.monthlyAmount),
      currency: plan.currency,
      return: "hosting",
      returnPath: HOSTING_STEP_PATH_BY_STEP.payment,
      fresh: "1",
    });
    const internalHref = `/payment/vps/${draft.kind}/${plan.id}?${params.toString()}`;
    if (typeof window === "undefined") return internalHref;
    return buildBrowserRoutingTargetFromInternalPath(internalHref, {
      fallbackHost: "pay",
    }).href;
  }, [draft.kind, plan, region.id, repository]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const approved = params.get("paymentApproved") === "1";
    const orderNumber = params.get("orderNumber") || params.get("order");
    if (!approved || !orderNumber || !draft.kind || !plan || !repository) return;

    setProvisioning(true);
    setMessage("Pagamento aprovado. Preparando a VPS e permissao de gerenciamento...");

    fetch("/api/auth/me/hosting/provision", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        orderNumber,
        kind: draft.kind,
        planId: plan.id,
        regionId: region.id,
        repository,
      }),
    })
      .then(async (response) => {
        const payload = await response.json() as HostingProvisionResponse;
        if (!response.ok || !payload.ok || !payload.vpsCode) {
          throw new Error(payload.message || "Nao foi possivel provisionar a VPS.");
        }
        onPatch({
          vpsCode: payload.vpsCode,
          step: "ready",
        });
      })
      .catch((error) => {
        setMessage(error instanceof Error ? error.message : "Nao foi possivel provisionar a VPS.");
      })
      .finally(() => {
        setProvisioning(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.kind, plan?.id, region.id, repository?.id]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (autoCheckoutStarted) return;
    if (params.has("paymentApproved") || params.has("orderNumber") || params.has("order")) return;
    if (checkoutHref === "#") return;

    setAutoCheckoutStarted(true);
    window.location.assign(checkoutHref);
  }, [autoCheckoutStarted, checkoutHref]);

  return (
    <div className="grid gap-[18px] xl:grid-cols-[minmax(0,1fr)_390px]">
      <div className="rounded-[22px] border border-[#171717] bg-[#080808] p-[22px]">
        <SectionHeader
          eyebrow="Pagamento"
          title="Confirme o pagamento da hospedagem"
          description="O checkout usa o fluxo seguro da Flowdesk. Apos aprovado, a VPS recebe um UUID e o painel de gerenciamento fica liberado."
        />
        <div className="mt-[22px] grid gap-[12px] md:grid-cols-[minmax(0,360px)]">
          <div className="inline-flex min-h-[52px] w-full items-center justify-center rounded-[14px] bg-white px-[18px] text-[14px] font-bold text-[#111111]">
            <div className="flex items-center gap-[10px] text-[#111111]">
              <Loader2 className="h-[16px] w-[16px] animate-spin" />
              Redirecionando para checkout seguro...
            </div>
          </div>
        </div>
        {provisioning ? (
          <p className="mt-[12px] flex items-center gap-[8px] text-[12px] font-semibold text-[#9AAFFF]">
            <Loader2 className="h-[14px] w-[14px] animate-spin" />
            {message}
          </p>
        ) : message ? (
          <p className="mt-[12px] text-[12px] leading-[1.55] text-[#F3DD7A]">{message}</p>
        ) : null}
      </div>
      <SummaryCard draft={draft} repository={repository} region={region} plan={plan} />
    </div>
  );
}

function SummaryCard({
  draft,
  repository,
  region,
  plan,
}: {
  draft: HostingDraft;
  repository: HostingRepository | null;
  region: HostingRegion | null;
  plan: HostingPlan | null;
}) {
  return (
    <aside className="rounded-[22px] border border-[#171717] bg-[#080808] p-[18px]">
      <p className="text-[13px] font-bold uppercase tracking-[0.14em] text-[#606060]">
        Resumo
      </p>
      <div className="mt-[14px] space-y-[10px]">
        {[
          ["Tipo", draft.kind ? getHostingKindLabel(draft.kind) : "Nao selecionado"],
          ["GitHub", draft.githubConnected ? "Conectado" : "Pendente"],
          ["Repositorio", repository ? `${repository.owner}/${repository.name}` : "Nao selecionado"],
          ["Regiao", region ? `${region.city}, ${region.country}` : "Nao selecionada"],
          ["Plano", plan ? `${plan.name} - ${formatMoney(plan.monthlyAmount, plan.currency)}/mes` : "Nao selecionado"],
        ].map(([label, value]) => (
          <div key={label} className="rounded-[14px] border border-[#151515] bg-[#0B0B0B] p-[12px]">
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#555555]">{label}</p>
            <p className="mt-[5px] break-words text-[13px] font-semibold text-[#DADADA]">{value}</p>
          </div>
        ))}
      </div>
    </aside>
  );
}

function ReadyStep({
  draft,
  repository,
  region,
  plan,
  onReset,
}: {
  draft: HostingDraft;
  repository: HostingRepository | null;
  region: HostingRegion;
  plan: HostingPlan | null;
  onReset: () => void;
}) {
  const vpsCode = draft.vpsCode;

  if (!vpsCode) {
    return (
      <div className="rounded-[22px] border border-[#1D1D1D] bg-[#080808] p-[22px]">
        <div className="flex h-[54px] w-[54px] items-center justify-center rounded-[17px] bg-[#111111] text-[#8E8E8E]">
          <Rocket className="h-[25px] w-[25px]" />
        </div>
        <h2 className="mt-[18px] text-[28px] font-semibold tracking-[-0.04em] text-[#F1F1F1]">
          Nenhuma VPS liberada nesta sessao
        </h2>
        <p className="mt-[10px] max-w-[720px] text-[14px] leading-[1.6] text-[#9B9B9B]">
          A tela de sucesso expira automaticamente para evitar mostrar uma VPS antiga em uma nova compra.
        </p>
        <button
          type="button"
          onClick={onReset}
          className="mt-[18px] inline-flex h-[44px] items-center justify-center rounded-[12px] bg-[#0F62FE] px-[16px] text-[13px] font-semibold text-white transition-colors hover:bg-[#2A73FF]"
        >
          Criar hospedagem
        </button>
      </div>
    );
  }

  const url = resolveVpsDisplayUrl(vpsCode);
  const panelPath = resolveVpsInternalPath(vpsCode);

  return (
    <div className="grid gap-[18px] xl:grid-cols-[minmax(0,1fr)_390px]">
      <div className="rounded-[22px] border border-[rgba(52,168,83,0.20)] bg-[rgba(52,168,83,0.06)] p-[22px]">
        <div className="flex h-[54px] w-[54px] items-center justify-center rounded-[17px] bg-[rgba(52,168,83,0.14)] text-[#9BE7AC]">
          <Rocket className="h-[25px] w-[25px]" />
        </div>
        <h2 className="mt-[18px] text-[28px] font-semibold tracking-[-0.04em] text-[#F1F1F1]">
          VPS pronta para gerenciamento
        </h2>
        <p className="mt-[10px] max-w-[720px] text-[14px] leading-[1.6] text-[#91B99B]">
          O identificador foi gerado no formato UUID e a URL final do painel ja esta preparada para quando a tela de gerenciamento for implementada.
        </p>
        <div className="mt-[18px] rounded-[16px] border border-[#1D1D1D] bg-[#050505] p-[14px]">
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#555555]">URL da VPS</p>
          <p className="mt-[6px] break-all font-mono text-[14px] font-semibold text-[#E8E8E8]">{url}</p>
        </div>
        <div className="mt-[18px] flex flex-wrap gap-[10px]">
          <a
            href={panelPath}
            className="inline-flex h-[44px] items-center justify-center gap-[9px] rounded-[12px] bg-[#0F62FE] px-[16px] text-[13px] font-semibold text-white transition-colors hover:bg-[#2A73FF]"
          >
            Abrir painel da VPS
            <ExternalLink className="h-[16px] w-[16px]" />
          </a>
          <button
            type="button"
            onClick={onReset}
            className="inline-flex h-[44px] items-center justify-center rounded-[12px] border border-[#1B1B1B] bg-[#0D0D0D] px-[16px] text-[13px] font-semibold text-[#AFAFAF] transition-colors hover:border-[#2A2A2A] hover:text-white"
          >
            Criar outra hospedagem
          </button>
        </div>
      </div>
      <SummaryCard draft={draft} repository={repository} region={region} plan={plan} />
    </div>
  );
}

export function HostingWorkspace({
  initialStep = "kind",
  initialProjects = [],
  forceOnboarding = false,
  githubConnected = false,
}: {
  initialStep?: HostingStep;
  initialProjects?: HostingProjectCard[];
  forceOnboarding?: boolean;
  githubConnected?: boolean;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<HostingDraft>({
    ...DEFAULT_DRAFT,
    step: initialStep,
  });
  const [hydrated, setHydrated] = useState(false);
  const [stepDirection, setStepDirection] = useState<StepDirection>("forward");
  const draftRef = useRef<HostingDraft>({
    ...DEFAULT_DRAFT,
    step: initialStep,
  });

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      const storedDraft = {
        ...readDraft(),
        step: initialStep,
      };
      draftRef.current = storedDraft;
      setDraft(storedDraft);
      setHydrated(true);
    }, 0);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [initialStep]);

  useEffect(() => {
    draftRef.current = draft;
    if (!hydrated) return;
    writeDraft(draft);
  }, [draft, hydrated]);

  useEffect(() => {
    if (!hydrated || draft.step !== "ready" || !draft.vpsCode) return;
    const vpsCode = draft.vpsCode;
    const timeoutId = window.setTimeout(() => {
      window.sessionStorage.removeItem(STORAGE_KEY);
      router.replace(resolveVpsInternalPath(vpsCode), {
        scroll: false,
      });
    }, 10_000);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [draft.step, draft.vpsCode, hydrated, router]);

  function patchDraft(patch: Partial<HostingDraft>) {
    const current = draftRef.current;
    const nextDraft = {
      ...current,
      ...patch,
    };

    if (patch.step && patch.step !== current.step) {
      setStepDirection(resolveStepDirection(current.step, patch.step));
      router.push(HOSTING_STEP_PATH_BY_STEP[patch.step], {
        scroll: false,
      });
    }

    draftRef.current = nextDraft;
    setDraft(nextDraft);
  }

  function reset() {
    setStepDirection(resolveStepDirection(draftRef.current.step, "kind"));
    draftRef.current = DEFAULT_DRAFT;
    setDraft(DEFAULT_DRAFT);
    router.push(HOSTING_STEP_PATH_BY_STEP.kind, {
      scroll: false,
    });
  }

  function startNewHosting() {
    if (typeof window !== "undefined") {
      window.sessionStorage.removeItem(STORAGE_KEY);
    }
    setStepDirection("forward");
    const next = { ...DEFAULT_DRAFT, step: "kind" as const };
    draftRef.current = next;
    setDraft(next);
    router.push(HOSTING_STEP_PATH_BY_STEP.kind, {
      scroll: false,
    });
  }

  function reconnectGithubFromOverview() {
    window.sessionStorage.removeItem(STORAGE_KEY);
    draftRef.current = DEFAULT_DRAFT;
    setDraft(DEFAULT_DRAFT);
    router.refresh();
  }

  const repository =
    draft.selectedRepository ||
    MOCK_GITHUB_REPOSITORIES.find((repo) => repo.id === draft.selectedRepositoryId) ||
    null;
  const region = HOSTING_REGIONS.find((item) => item.id === draft.selectedRegionId) || HOSTING_REGIONS[0];
  const plan = draft.kind
    ? HOSTING_PLANS[draft.kind].find((item) => item.id === draft.selectedPlanId) || null
    : null;

  function renderCurrentStep() {
    if (draft.step === "kind") return <KindStep draft={draft} onPatch={patchDraft} />;
    if (draft.step === "github") return <GithubStep draft={draft} onPatch={patchDraft} />;
    if (draft.step === "repository") return <RepositoryStep draft={draft} onPatch={patchDraft} />;
    if (draft.step === "region") return <RegionStep draft={draft} onPatch={patchDraft} />;
    if (draft.step === "plan") return <PlanStep draft={draft} onPatch={patchDraft} />;
    if (draft.step === "payment") {
      return (
        <PaymentStep
          draft={draft}
          repository={repository}
          region={region}
          plan={plan}
          onPatch={patchDraft}
        />
      );
    }

    return (
      <ReadyStep
        draft={draft}
        repository={repository}
        region={region}
        plan={plan}
        onReset={reset}
      />
    );
  }

  if (!forceOnboarding && initialStep === "kind" && initialProjects.length > 0) {
    return (
      <HostingProjectsOverview
        projects={initialProjects}
        githubConnected={githubConnected}
        onCreate={startNewHosting}
        onReconnect={reconnectGithubFromOverview}
      />
    );
  }

  return (
    <HostingShell>
      <StepRail current={draft.step} draft={draft} />

      <div
        key={draft.step}
        className={`min-w-0 will-change-transform animate-in fade-in duration-300 ${
          stepDirection === "forward" ? "slide-in-from-right-6" : "slide-in-from-left-6"
        }`}
      >
        {renderCurrentStep()}
      </div>

      {draft.step !== "kind" && draft.step !== "ready" ? (
        <div className="flex justify-between gap-[12px]">
          <button
            type="button"
            onClick={() => {
              const index = Math.max(0, STEP_ORDER.indexOf(draft.step) - 1);
              patchDraft({ step: STEP_ORDER[index] });
            }}
            className="inline-flex h-[40px] items-center justify-center rounded-[12px] border border-[#1B1B1B] bg-[#0D0D0D] px-[14px] text-[13px] font-semibold text-[#AFAFAF] transition-colors hover:border-[#2A2A2A] hover:text-white"
          >
            Voltar
          </button>
          <button
            type="button"
            onClick={reset}
            className="inline-flex h-[40px] items-center justify-center rounded-[12px] px-[14px] text-[13px] font-semibold text-[#666666] transition-colors hover:bg-[#0D0D0D] hover:text-[#DADADA]"
          >
            Reiniciar fluxo
          </button>
        </div>
      ) : null}
    </HostingShell>
  );
}
