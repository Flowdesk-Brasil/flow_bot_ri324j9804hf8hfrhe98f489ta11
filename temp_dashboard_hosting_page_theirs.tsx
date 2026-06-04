import { HostingWorkspace } from "@/components/dashboard/HostingWorkspace";
import { getCurrentUserFromSessionCookieSafe } from "@/lib/auth/session";
import {
  fetchHostingGitHubProfile,
  isPermanentHostingGitHubAuthError,
  markHostingGitHubTokenInvalid,
  readHostingGitHubToken,
} from "@/lib/hosting/github";
import { getSupabaseAdminClientOrThrow } from "@/lib/supabaseAdmin";
import type { HostingProjectCard } from "@/components/dashboard/HostingWorkspace";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function DashboardHostingPage() {
  const session = await getCurrentUserFromSessionCookieSafe();
  let projects: HostingProjectCard[] = [];
  let githubConnected = false;

  if (session.user?.id) {
    const token = await readHostingGitHubToken(session.user.id);
    if (token) {
      githubConnected = true;
      try {
        await fetchHostingGitHubProfile(token);
      } catch (error) {
        if (isPermanentHostingGitHubAuthError(error)) {
          await markHostingGitHubTokenInvalid(
            session.user.id,
            error instanceof Error ? error.message : "GitHub invalido.",
          ).catch(() => null);
          githubConnected = false;
        }
      }
    }
    const supabase = getSupabaseAdminClientOrThrow();
    const { data } = await supabase
      .from("hosting_projects")
      .select("id, vps_code, payment_order_id, hosting_kind, hosting_plan_id, hosting_region_id, github_owner, github_repo, github_branch, status, runtime_status, billing_status, access_expires_at, refund_access_until, created_at")
      .eq("user_id", session.user.id)
      .order("created_at", { ascending: false })
      .limit(12);

    const rows = data || [];
    const orderIds = rows
      .map((item) => item.payment_order_id)
      .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    const { data: orders } = orderIds.length
      ? await supabase
          .from("payment_orders")
          .select("id, status, amount, currency, paid_at, expires_at")
          .in("id", orderIds)
      : { data: [] };
    const ordersById = new Map((orders || []).map((order) => [order.id, order]));

    projects = rows.map((project) => ({
      ...project,
      payment_orders: project.payment_order_id
        ? ordersById.get(project.payment_order_id) || null
        : null,
    })) as HostingProjectCard[];
  }

  return <HostingWorkspace initialStep="kind" initialProjects={projects} githubConnected={githubConnected} />;
}
