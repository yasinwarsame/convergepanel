/**
 * ZCA L-5 — the client half of the seven Team Project pages (D-4 #15–#21). Ports the former Server
 * Components' gate and prop cases:
 *   - access 404 → notFound(), and the Project is never requested;
 *   - a required capability missing → notFound(), and the Project is never requested (the old order);
 *   - Project 404 (not found / malformed / another Workspace) → notFound();
 *   - creation pages: an ARCHIVED Project → notFound(), never a dead-end composer;
 *   - granted → the page's shell with exactly the former props, the Project's id/name from the endpoint.
 */
type FakeUser = { uid: string; getIdToken: () => Promise<string> };
const AUTH: { user: FakeUser | null; authReady: boolean } = { user: null, authReady: true };
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => AUTH }));
const mockAuthedFetch = jest.fn();
jest.mock("@/lib/client/authedFetch", () => ({ authedFetch: (...a: unknown[]) => mockAuthedFetch(...a) }));
jest.mock("next/navigation", () => ({ ...jest.requireActual("next/navigation"), useRouter: () => ({ replace: jest.fn() }), usePathname: () => "/workspace/team/ws-1/projects/p-1" }));

const mockShellProps: Array<{ shell: string; props: Record<string, unknown> }> = [];
const shell = (name: string) => (props: Record<string, unknown>) => { mockShellProps.push({ shell: name, props }); return null; };
jest.mock("@/components/workspace/projects/TeamProjectDetailShell", () => shell("TeamProjectDetailShell"));
jest.mock("@/components/workspace/claims/TeamClaimComposerShell", () => shell("TeamClaimComposerShell"));
jest.mock("@/components/workspace/projects/TeamClaimDetailShell", () => shell("TeamClaimDetailShell"));
jest.mock("@/components/workspace/projects/TeamResearchComposerShell", () => shell("TeamResearchComposerShell"));
jest.mock("@/components/workspace/projects/TeamResearchDetailShell", () => shell("TeamResearchDetailShell"));
jest.mock("@/components/workspace/videos/TeamVideoComposerShell", () => shell("TeamVideoComposerShell"));
jest.mock("@/components/workspace/videos/TeamVideoDetailShell", () => shell("TeamVideoDetailShell"));

import { Component, createElement, type ReactNode } from "react";
import TestRenderer, { act } from "react-test-renderer";
import TeamWorkspacePage, { TEAM_PAGE_REQUIRED_CAPABILITIES, TEAM_PROJECT_PAGE_REQUIRES_ACTIVE, type TeamPageProps } from "@/components/workspace/TeamWorkspacePage";
import { CLIENT_WORKSPACE_CAPABILITIES } from "@/lib/workspaces/teamWorkspaceAccessTypes";

const ALL = [...CLIENT_WORKSPACE_CAPABILITIES];
const ACCESS_URL = "/api/workspaces/ws-1";
const PROJECT_URL = "/api/workspaces/ws-1/projects/p-1";
const accessBody = (capabilities: readonly string[], over: Record<string, unknown> = {}) => ({ ok: true, workspace: { id: "ws-1", name: "Acme Research" }, role: "admin", capabilities, reportReviewEnabled: false, projectAssignmentUiEnabled: false, ...over });
const projectBody = (over: Record<string, unknown> = {}) => ({ ok: true, project: { id: "p-1", name: "ABC Acquisition", status: "active", ...over } });
type Answer = { status: number; body?: unknown };
let answers: { access: Answer; project: Answer };
const projectRequests = () => mockAuthedFetch.mock.calls.filter(([u]) => String(u).startsWith(PROJECT_URL));

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
const last = () => mockShellProps[mockShellProps.length - 1];

const PAGES = {
  projectDetail: { kind: "projectDetail", workspaceId: "ws-1", projectId: "p-1" },
  projectClaimNew: { kind: "projectClaimNew", workspaceId: "ws-1", projectId: "p-1" },
  projectClaimDetail: { kind: "projectClaimDetail", workspaceId: "ws-1", projectId: "p-1", verificationId: "v-1" },
  projectResearchNew: { kind: "projectResearchNew", workspaceId: "ws-1", projectId: "p-1" },
  projectResearchDetail: { kind: "projectResearchDetail", workspaceId: "ws-1", projectId: "p-1", runId: "r-1" },
  projectVideoNew: { kind: "projectVideoNew", workspaceId: "ws-1", projectId: "p-1" },
  projectVideoDetail: { kind: "projectVideoDetail", workspaceId: "ws-1", projectId: "p-1", verificationId: "v-2" },
} as const satisfies Record<string, TeamPageProps>;
type Kind = keyof typeof PAGES;

beforeEach(() => {
  jest.clearAllMocks();
  mockShellProps.length = 0;
  AUTH.user = { uid: "u1", getIdToken: async () => "t" };
  AUTH.authReady = true;
  answers = { access: { status: 200, body: accessBody(ALL) }, project: { status: 200, body: projectBody() } };
  mockAuthedFetch.mockImplementation(async (url: string) => {
    const a = String(url).startsWith(PROJECT_URL) ? answers.project : answers.access;
    return { status: a.status, json: async () => a.body ?? {} };
  });
  jest.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => (console.error as jest.Mock).mockRestore?.());

describe.each(Object.keys(PAGES) as Kind[])("kind %s — gate", (kind) => {
  it("access 404 → notFound(); the Project is never requested", async () => {
    answers.access = { status: 404 };
    await mount(PAGES[kind]);
    expect(isNotFound()).toBe(true);
    expect(projectRequests()).toEqual([]);
  });
  for (const cap of TEAM_PAGE_REQUIRED_CAPABILITIES[kind]) {
    it(`missing ${cap} → notFound(); the Project is never requested`, async () => {
      answers.access = { status: 200, body: accessBody(ALL.filter((c) => c !== cap)) };
      await mount(PAGES[kind]);
      expect(isNotFound()).toBe(true);
      expect(projectRequests()).toEqual([]);
      expect(mockShellProps).toEqual([]);
    });
  }
  it("Project 404 (not found / malformed / another Workspace) → notFound()", async () => {
    answers.project = { status: 404 };
    await mount(PAGES[kind]);
    expect(isNotFound()).toBe(true);
    expect(mockShellProps).toEqual([]);
  });
  it(`archived Project → ${TEAM_PROJECT_PAGE_REQUIRES_ACTIVE[kind] ? "notFound() (creation page)" : "renders (read page)"}`, async () => {
    answers.project = { status: 200, body: projectBody({ status: "archived" }) };
    await mount(PAGES[kind]);
    expect(isNotFound()).toBe(TEAM_PROJECT_PAGE_REQUIRES_ACTIVE[kind]);
    expect(mockShellProps.length > 0).toBe(!TEAM_PROJECT_PAGE_REQUIRES_ACTIVE[kind]);
  });
  it("granted → requests the route's Project after access, and renders", async () => {
    await mount(PAGES[kind]);
    const urls = mockAuthedFetch.mock.calls.map(([u]) => String(u));
    expect(urls[0]).toBe(ACCESS_URL);
    expect(urls[1]).toBe(kind === "projectDetail" ? `${PROJECT_URL}?include=assignees` : PROJECT_URL);
    expect(isNotFound()).toBe(false);
    expect(mockShellProps.length).toBeGreaterThan(0);
  });
});

describe("the former pages' guards and active rules, pinned", () => {
  it("required capabilities", () => {
    expect(Object.fromEntries((Object.keys(PAGES) as Kind[]).map((k) => [k, TEAM_PAGE_REQUIRED_CAPABILITIES[k]]))).toEqual({
      projectDetail: ["projects.read"],
      projectClaimNew: ["research.create", "research.organize"],
      projectClaimDetail: ["research.read"],
      projectResearchNew: ["projects.read", "research.create", "research.organize"],
      projectResearchDetail: ["research.read"],
      projectVideoNew: ["research.create", "research.organize"],
      projectVideoDetail: ["research.read"],
    });
  });
  it("active-only pages are exactly the three composers", () => {
    expect(TEAM_PROJECT_PAGE_REQUIRES_ACTIVE).toEqual({ projectDetail: false, projectClaimNew: true, projectClaimDetail: false, projectResearchNew: true, projectResearchDetail: false, projectVideoNew: true, projectVideoDetail: false });
  });
});

describe("exact props", () => {
  const REF = { id: "p-1", name: "ABC Acquisition" };
  it("projectDetail: every hint, the assignment flag, and the Project meta with assignees", async () => {
    answers.access = { status: 200, body: accessBody(["projects.read", "research.read", "research.create", "research.organize"], { projectAssignmentUiEnabled: true }) };
    answers.project = { status: 200, body: projectBody({ assignees: [{ uid: "m1", displayName: "Bao", state: "active" }] }) };
    await mount(PAGES.projectDetail);
    expect(last()).toEqual({ shell: "TeamProjectDetailShell", props: { workspaceId: "ws-1", workspaceName: "Acme Research", canReadMembers: false, canReadAudit: false, canReadClaims: true, canReadVideos: true, canCreateClaim: true, canCreateVideo: true, canStartResearch: true, canAssignResearch: true, assignmentUiEnabled: true, project: { id: "p-1", name: "ABC Acquisition", status: "active", assignees: [{ uid: "m1", displayName: "Bao", state: "active" }] } } });
  });
  it("projectDetail: research.create without research.organize → canStartResearch/canCreateClaim/canCreateVideo false", async () => {
    answers.access = { status: 200, body: accessBody(["projects.read", "research.read", "research.create"]) };
    await mount(PAGES.projectDetail);
    const p = last().props;
    expect([p.canStartResearch, p.canCreateClaim, p.canCreateVideo, p.canAssignResearch, p.canReadVideos]).toEqual([false, false, false, false, true]);
  });
  it("projectClaimNew: four props, the endpoint's Project id and name, no origin", async () => {
    answers.access = { status: 200, body: accessBody(["research.create", "research.organize"]) };
    await mount(PAGES.projectClaimNew);
    expect(last()).toEqual({ shell: "TeamClaimComposerShell", props: { workspaceId: "ws-1", workspaceName: "Acme Research", showMembers: false, showAudit: false, project: REF } });
  });
  it("projectClaimDetail", async () => {
    answers.access = { status: 200, body: accessBody(["research.read", "members.read"]) };
    await mount(PAGES.projectClaimDetail);
    expect(last()).toEqual({ shell: "TeamClaimDetailShell", props: { workspaceId: "ws-1", workspaceName: "Acme Research", verificationId: "v-1", project: REF, showMembers: true, showAudit: false } });
  });
  it("projectResearchNew", async () => {
    answers.access = { status: 200, body: accessBody(["projects.read", "research.create", "research.organize", "audit.read"]) };
    await mount(PAGES.projectResearchNew);
    expect(last()).toEqual({ shell: "TeamResearchComposerShell", props: { workspaceId: "ws-1", workspaceName: "Acme Research", canReadMembers: false, canReadAudit: true, project: REF } });
  });
  it("projectResearchDetail: on a Project, canVerifyClaim needs research.create AND research.organize; export is exports.create", async () => {
    answers.access = { status: 200, body: accessBody(["research.read", "research.create", "exports.create"], { reportReviewEnabled: true }) };
    await mount(PAGES.projectResearchDetail);
    expect(last()).toEqual({ shell: "TeamResearchDetailShell", props: { workspaceId: "ws-1", workspaceName: "Acme Research", runId: "r-1", project: REF, showMembers: false, showAudit: false, canVerifyClaim: false, canCreateExport: true, reportReviewEnabled: true } });
    mockShellProps.length = 0;
    answers.access = { status: 200, body: accessBody(["research.read", "research.create", "research.organize"]) };
    await mount(PAGES.projectResearchDetail);
    expect([last().props.canVerifyClaim, last().props.canCreateExport]).toEqual([true, false]);
  });
  it("projectVideoNew", async () => {
    answers.access = { status: 200, body: accessBody(["research.create", "research.organize"]) };
    await mount(PAGES.projectVideoNew);
    expect(last()).toEqual({ shell: "TeamVideoComposerShell", props: { workspaceId: "ws-1", workspaceName: "Acme Research", showMembers: false, showAudit: false, project: REF } });
  });
  it("projectVideoDetail", async () => {
    answers.access = { status: 200, body: accessBody(["research.read", "audit.read"]) };
    await mount(PAGES.projectVideoDetail);
    expect(last()).toEqual({ shell: "TeamVideoDetailShell", props: { workspaceId: "ws-1", workspaceName: "Acme Research", verificationId: "v-2", project: REF, showMembers: false, showAudit: true } });
  });
});
