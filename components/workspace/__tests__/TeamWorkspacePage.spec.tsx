/**
 * ZCA L-4 — the client half of the 11 Team Workspace pages (D-4 #8–#14, #22–#25). Ports every gate and
 * "what crosses to the client" case of the former Server Component specs, table-driven per page kind:
 *   - an endpoint 404 (every access denial) → the page's real notFound();
 *   - each required capability missing → the same notFound(), the shell never built;
 *   - granted → the page's own shell with EXACTLY the props its Server Component computed.
 */
type FakeUser = { uid: string; getIdToken: () => Promise<string> };
const AUTH: { user: FakeUser | null; authReady: boolean } = { user: null, authReady: true };
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => AUTH }));
const mockAuthedFetch = jest.fn();
jest.mock("@/lib/client/authedFetch", () => ({ authedFetch: (...a: unknown[]) => mockAuthedFetch(...a) }));
jest.mock("next/navigation", () => ({ ...jest.requireActual("next/navigation"), useRouter: () => ({ replace: jest.fn() }), usePathname: () => "/workspace/team/ws-1" }));

const mockShellProps: Array<{ shell: string; props: Record<string, unknown> }> = [];
const shell = (name: string) => (props: Record<string, unknown>) => { mockShellProps.push({ shell: name, props }); return null; };
jest.mock("@/components/workspace/WorkspaceOverviewShell", () => shell("WorkspaceOverviewShell"));
jest.mock("@/components/workspace/WorkspaceAuditLogShell", () => shell("WorkspaceAuditLogShell"));
jest.mock("@/components/workspace/claims/TeamWorkspaceClaimsShell", () => shell("TeamWorkspaceClaimsShell"));
jest.mock("@/components/workspace/projects/TeamClaimDetailShell", () => shell("TeamClaimDetailShell"));
jest.mock("@/components/workspace/claims/TeamClaimComposerShell", () => shell("TeamClaimComposerShell"));
jest.mock("@/components/workspace/WorkspaceMembersShell", () => shell("WorkspaceMembersShell"));
jest.mock("@/components/workspace/projects/TeamProjectsShell", () => shell("TeamProjectsShell"));
jest.mock("@/components/workspace/projects/TeamResearchDetailShell", () => shell("TeamResearchDetailShell"));
jest.mock("@/components/workspace/videos/TeamWorkspaceVideosShell", () => shell("TeamWorkspaceVideosShell"));
jest.mock("@/components/workspace/videos/TeamVideoComposerShell", () => shell("TeamVideoComposerShell"));
jest.mock("@/components/workspace/videos/TeamVideoDetailShell", () => shell("TeamVideoDetailShell"));

import { Component, createElement, type ReactNode } from "react";
import TestRenderer, { act } from "react-test-renderer";
import TeamWorkspacePage, { TEAM_PAGE_REQUIRED_CAPABILITIES, type TeamPageProps } from "@/components/workspace/TeamWorkspacePage";
import { CLIENT_WORKSPACE_CAPABILITIES } from "@/lib/workspaces/teamWorkspaceAccessTypes";

const ALL = [...CLIENT_WORKSPACE_CAPABILITIES];
const access = (capabilities: readonly string[], over: Record<string, unknown> = {}) => ({
  status: 200,
  json: async () => ({ ok: true, workspace: { id: "ws-canonical", name: "Acme Research" }, role: "admin", capabilities, reportReviewEnabled: false, projectAssignmentUiEnabled: false, ...over }),
});

class Boundary extends Component<{ children?: ReactNode; onError: (e: unknown) => void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(e: unknown) { this.props.onError(e); }
  render() { return this.state.failed ? null : this.props.children; }
}
let caught: unknown;
async function mount(page: TeamPageProps) {
  caught = undefined;
  await act(async () => {
    TestRenderer.create(createElement(Boundary, { onError: (e: unknown) => { caught = e; } }, createElement(TeamWorkspacePage, page)));
  });
}
const isNotFound = () => (caught as { digest?: string } | undefined)?.digest === "NEXT_NOT_FOUND";
const lastShell = () => mockShellProps[mockShellProps.length - 1];

const ORIGIN = { runId: "run-9", claimId: "claim-3" };
const PAGES: Record<TeamPageProps["kind"], TeamPageProps> = {
  overview: { kind: "overview", workspaceId: "ws-1" },
  audit: { kind: "audit", workspaceId: "ws-1", showGovernanceSummary: true, showReviewIntegrityMetrics: false },
  claims: { kind: "claims", workspaceId: "ws-1" },
  claimDetail: { kind: "claimDetail", workspaceId: "ws-1", verificationId: "ver-1" },
  claimNew: { kind: "claimNew", workspaceId: "ws-1", originTarget: ORIGIN as never },
  members: { kind: "members", workspaceId: "ws-1" },
  projects: { kind: "projects", workspaceId: "ws-1" },
  researchDetail: { kind: "researchDetail", workspaceId: "ws-1", runId: "run-1" },
  videos: { kind: "videos", workspaceId: "ws-1" },
  videoNew: { kind: "videoNew", workspaceId: "ws-1" },
  videoDetail: { kind: "videoDetail", workspaceId: "ws-1", verificationId: "ver-2" },
};

beforeEach(() => {
  jest.clearAllMocks();
  mockShellProps.length = 0;
  AUTH.user = { uid: "u1", getIdToken: async () => "t" };
  AUTH.authReady = true;
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => (console.error as jest.Mock).mockRestore?.());

describe.each(Object.keys(PAGES) as Array<TeamPageProps["kind"]>)("kind %s — gate", (kind) => {
  it("loads access for the route's workspace with the bearer helper", async () => {
    mockAuthedFetch.mockResolvedValue(access(ALL));
    await mount(PAGES[kind]);
    expect(mockAuthedFetch).toHaveBeenCalledWith("/api/workspaces/ws-1", expect.objectContaining({ user: AUTH.user, method: "GET" }));
  });
  it("an access denial (404) → notFound(), no shell", async () => {
    mockAuthedFetch.mockResolvedValue({ status: 404, json: async () => ({}) });
    await mount(PAGES[kind]);
    expect(isNotFound()).toBe(true);
    expect(mockShellProps).toEqual([]);
  });
  it("signed out locally → nothing requested, no shell", async () => {
    AUTH.user = null;
    await mount(PAGES[kind]);
    expect(mockAuthedFetch).not.toHaveBeenCalled();
    expect(mockShellProps).toEqual([]);
  });
  for (const cap of TEAM_PAGE_REQUIRED_CAPABILITIES[kind]) {
    it(`missing ${cap} → notFound(), the shell is never built`, async () => {
      mockAuthedFetch.mockResolvedValue(access(ALL.filter((c) => c !== cap)));
      await mount(PAGES[kind]);
      expect(isNotFound()).toBe(true);
      expect(mockShellProps).toEqual([]);
    });
  }
  it("all capabilities → renders (control for the denials above)", async () => {
    mockAuthedFetch.mockResolvedValue(access(ALL));
    await mount(PAGES[kind]);
    expect(isNotFound()).toBe(false);
    expect(mockShellProps.length).toBeGreaterThan(0);
  });
});

describe("required capabilities are exactly the former pages' checks", () => {
  it("pins the table", () => {
    expect(TEAM_PAGE_REQUIRED_CAPABILITIES).toEqual({
      overview: [],
      audit: ["audit.read"],
      claims: ["research.read"],
      claimDetail: ["research.read"],
      claimNew: ["research.create"],
      members: ["members.read"],
      projects: ["projects.read"],
      researchDetail: ["research.read"],
      videos: ["research.read"],
      videoNew: ["research.create"],
      videoDetail: ["research.read"],
    });
  });
});

describe("exact props per page (what crosses to the shell)", () => {
  const MINIMAL: Record<TeamPageProps["kind"], string[]> = { ...TEAM_PAGE_REQUIRED_CAPABILITIES } as never;
  async function renderWith(kind: TeamPageProps["kind"], caps: readonly string[], over: Record<string, unknown> = {}) {
    mockAuthedFetch.mockResolvedValue(access(caps, over));
    await mount(PAGES[kind]);
    return lastShell();
  }

  it("overview: every hint derives from its capability; canStartResearch needs research.create AND research.organize", async () => {
    expect(await renderWith("overview", ALL)).toEqual({ shell: "WorkspaceOverviewShell", props: { workspaceId: "ws-1", workspaceName: "Acme Research", canInvite: true, canManageInvitations: true, canCreateProject: true, canStartResearch: true, canReadMembers: true, canReadAudit: true } });
    expect((await renderWith("overview", ["research.create"])).props.canStartResearch).toBe(false);
    expect(await renderWith("overview", [])).toEqual({ shell: "WorkspaceOverviewShell", props: { workspaceId: "ws-1", workspaceName: "Acme Research", canInvite: false, canManageInvitations: false, canCreateProject: false, canStartResearch: false, canReadMembers: false, canReadAudit: false } });
  });
  it("audit: the static deployment flags pass through from the server render unchanged", async () => {
    expect(await renderWith("audit", ["audit.read"])).toEqual({ shell: "WorkspaceAuditLogShell", props: { workspaceId: "ws-1", workspaceName: "Acme Research", canReadMembers: false, showGovernanceSummary: true, showReviewIntegrityMetrics: false } });
  });
  it("claims: canCreateClaim is research.create", async () => {
    expect(await renderWith("claims", ["research.read", "research.create"])).toEqual({ shell: "TeamWorkspaceClaimsShell", props: { workspaceId: "ws-1", workspaceName: "Acme Research", showMembers: false, showAudit: false, canCreateClaim: true } });
  });
  it("claimDetail: the route's verification id and a null (Unfiled) project", async () => {
    expect(await renderWith("claimDetail", MINIMAL.claimDetail)).toEqual({ shell: "TeamClaimDetailShell", props: { workspaceId: "ws-1", workspaceName: "Acme Research", verificationId: "ver-1", project: null, showMembers: false, showAudit: false } });
  });
  it("claimNew: renders with research.create WITHOUT research.organize; null project; the origin passes through", async () => {
    expect(await renderWith("claimNew", ["research.create"])).toEqual({ shell: "TeamClaimComposerShell", props: { workspaceId: "ws-1", workspaceName: "Acme Research", showMembers: false, showAudit: false, project: null, originTarget: ORIGIN } });
  });
  it("members: callerRole is the membership role from the endpoint", async () => {
    expect(await renderWith("members", ["members.read", "members.invite"], { role: "member" })).toEqual({ shell: "WorkspaceMembersShell", props: { workspaceId: "ws-1", workspaceName: "Acme Research", callerRole: "member", canInvite: true, canManageInvitations: false, canReadMembers: true, canReadAudit: false } });
  });
  it("projects: assignmentUiEnabled is the endpoint's per-uid flag", async () => {
    expect(await renderWith("projects", ["projects.read"], { projectAssignmentUiEnabled: true })).toEqual({ shell: "TeamProjectsShell", props: { workspaceId: "ws-1", workspaceName: "Acme Research", canCreateProject: false, canManageProjects: false, canReadMembers: false, canReadAudit: false, assignmentUiEnabled: true } });
  });
  it("researchDetail: canVerifyClaim = research.create (no organize), canCreateExport = exports.create, reportReviewEnabled from the endpoint", async () => {
    expect(await renderWith("researchDetail", ["research.read"], { reportReviewEnabled: true })).toEqual({ shell: "TeamResearchDetailShell", props: { workspaceId: "ws-1", workspaceName: "Acme Research", runId: "run-1", project: null, showMembers: false, showAudit: false, canVerifyClaim: false, canCreateExport: false, reportReviewEnabled: true } });
    const p = (await renderWith("researchDetail", ["research.read", "research.create", "exports.create"])).props;
    expect([p.canVerifyClaim, p.canCreateExport, p.reportReviewEnabled]).toEqual([true, true, false]);
  });
  it("videos: canCreateVideo is research.create", async () => {
    expect(await renderWith("videos", ["research.read", "research.create"])).toEqual({ shell: "TeamWorkspaceVideosShell", props: { workspaceId: "ws-1", workspaceName: "Acme Research", showMembers: false, showAudit: false, canCreateVideo: true } });
  });
  it("videoNew: null (Unfiled) project", async () => {
    expect(await renderWith("videoNew", ["research.create"])).toEqual({ shell: "TeamVideoComposerShell", props: { workspaceId: "ws-1", workspaceName: "Acme Research", showMembers: false, showAudit: false, project: null } });
  });
  it("videoDetail: the route's verification id", async () => {
    expect(await renderWith("videoDetail", ["research.read", "members.read", "audit.read"])).toEqual({ shell: "TeamVideoDetailShell", props: { workspaceId: "ws-1", workspaceName: "Acme Research", verificationId: "ver-2", project: null, showMembers: true, showAudit: true } });
  });
  it("an unknown capability string rejects the whole body (unavailable, no shell)", async () => {
    mockAuthedFetch.mockResolvedValue(access([...ALL, "everything.admin"]));
    await mount(PAGES.overview);
    expect(mockShellProps).toEqual([]);
  });
});
