import { NextRequest, NextResponse } from "next/server";
import {
  fetchHostingGitHubRepositories,
  isHostingGitHubConfigured,
  readHostingGitHubToken,
} from "@/lib/hosting/github";
import { getCurrentAuthSessionFromCookie } from "@/lib/auth/session";
import { applyNoStoreHeaders } from "@/lib/security/http";
import { getSupabaseAdminClientOrThrow } from "@/lib/supabaseAdmin";

export async function GET(request: NextRequest) {
  if (!isHostingGitHubConfigured()) {
    return applyNoStoreHeaders(
      NextResponse.json({
        ok: false,
        repositories: [],
        message: "GitHub OAuth nao configurado.",
      }, { status: 503 }),
    );
  }

  const session = await getCurrentAuthSessionFromCookie();
  const token = await readHostingGitHubToken(session?.user?.id);
  if (!session?.user?.id || !token) {
    return applyNoStoreHeaders(
      NextResponse.json({
        ok: false,
        repositories: [],
        message: "Conecte sua conta GitHub primeiro.",
      }, { status: 401 }),
    );
  }

  try {
    const { data: usedProjects } = await getSupabaseAdminClientOrThrow()
      .from("hosting_projects")
      .select("github_owner, github_repo, github_repo_id, vps_code, status")
      .eq("user_id", session.user.id)
      .not("status", "in", "(deleted,cancelled)");
    const usedRepositoryIds = new Set(
      (usedProjects || [])
        .map((project) => String(project.github_repo_id || "").trim())
        .filter(Boolean),
    );
    const usedRepositoryNames = new Set(
      (usedProjects || [])
        .map((project) => `${String(project.github_owner || "").toLowerCase()}/${String(project.github_repo || "").toLowerCase()}`)
        .filter((value) => value !== "/"),
    );
    const repositories = await fetchHostingGitHubRepositories({
      token,
      owner: request.nextUrl.searchParams.get("owner"),
      ownerType: request.nextUrl.searchParams.get("ownerType"),
      query: request.nextUrl.searchParams.get("q"),
    });
    const writableRepositories = repositories.filter((repo) => repo.canWrite !== false);
    const availableRepositories = writableRepositories.filter((repo) => {
      const repoId = String(repo.id || "").trim();
      const fullName = `${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}`;
      return !usedRepositoryIds.has(repoId) && !usedRepositoryNames.has(fullName);
    });
    return applyNoStoreHeaders(
      NextResponse.json({
        ok: true,
        repositories: availableRepositories,
        hiddenUsedCount: writableRepositories.length - availableRepositories.length,
        hiddenNoWriteCount: repositories.length - writableRepositories.length,
      }),
    );
  } catch (error) {
    return applyNoStoreHeaders(
      NextResponse.json({
        ok: false,
        repositories: [],
        message: error instanceof Error ? error.message : "Nao foi possivel carregar repositorios.",
      }, { status: 502 }),
    );
  }
}
