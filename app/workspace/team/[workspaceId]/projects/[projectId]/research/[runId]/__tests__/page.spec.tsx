/**
 * Team Research Detail, Phase 12A.4 —
 * `GET /workspace/team/{workspaceId}/projects/{projectId}/research/{runId}`
 * server-gate tests. Same technique as the sibling Project detail /
 * research composer gate specs: calls the Server Component function
 * directly, renders the resulting element tree with `react-test-renderer`,
 * and asserts real `next/navigation` `notFound()` behavior (digest
 * `"NEXT_NOT_FOUND"`) for every containment failure.
 *
 * Extends the Project detail page's containment coverage (identity ->
 * Workspace access -> `research.read` capability -> Project found ->
 * Project's own Workspace matches the route) with the NEW dimension this
 * page adds: the fetched run must belong to BOTH the route's Workspace AND
 * the route's Project, entirely via `getTeamWorkspaceRun()`
 * (`lib/firestore/teamWorkspaceRuns.ts`), mocked here at the module
 * boundary — this file exercises only the PAGE's gating/rendering
 * sequence, not `getTeamWorkspaceRun()`'s own internal Firestore logic
 * (see the dedicated `lib/firestore/__tests__/teamWorkspaceRuns.spec.ts`
 * suite for that).
 */

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";

jest.mock("next/link", () => {
  const MockLink = ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) =>
    require("react").createElement("a", { href, className }, children);
  return { __esModule: true, default: MockLink };
});

const mockedResolveServerComponentIdentity = jest.fn();
jest.mock("@/lib/auth/resolveServerComponentIdentity", () => ({
  resolveServerComponentIdentity: (...args: any[]) => mockedResolveServerComponentIdentity(...args),
}));

const mockedResolveWorkspaceAccess = jest.fn();
jest.mock("@/lib/workspaces/resolveWorkspaceAccess", () => ({
  resolveWorkspaceAccess: (...args: any[]) => mockedResolveWorkspaceAccess(...args),
}));

const mockedGetProject = jest.fn();
jest.mock("@/lib/firestore/projects", () => ({
  getProject: (...args: any[]) => mockedGetProject(...args),
}));

const mockedGetTeamWorkspaceRun = jest.fn();
jest.mock("@/lib/firestore/teamWorkspaceRuns", () => ({
  getTeamWorkspaceRun: (...args: any[]) => mockedGetTeamWorkspaceRun(...args),
}));

jest.mock("@/components/workspace/projects/TeamResearchResultView", () => ({
  __esModule: true,
  default: (props: any) => require("react").createElement("div", { "data-testid": "team-research-result-view", "data-run": JSON.stringify(props.run) }),
}));

import TeamResearchDetailPage from "@/app/workspace/team/[workspaceId]/projects/[projectId]/research/[runId]/page";

const WS_ID = "ws-1";
const OTHER_WS_ID = "ws-2";
const PROJECT_ID = "proj-1";
const RUN_ID = "run-1";
const UID = "uid-member";

function callPage(overrides: Partial<{ workspaceId: string; projectId: string; runId: string }> = {}) {
  return TeamResearchDetailPage({ params: { workspaceId: WS_ID, projectId: PROJECT_ID, runId: RUN_ID, ...overrides } });
}

async function expectRealNotFound(promise: Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeDefined();
  expect((caught as any)?.digest).toBe("NEXT_NOT_FOUND");
}

function grantedTeamAccess(overrides: Partial<{ capabilities: string[] }> = {}) {
  return {
    granted: true,
    workspaceType: "team",
    workspace: { id: WS_ID, name: "Acme Team" },
    membership: { role: "member" },
    capabilities: ["workspace.read", "projects.read", "research.read"],
    ...overrides,
  };
}

function foundProject(overrides: Record<string, unknown> = {}) {
  return {
    status: "found",
    project: { id: PROJECT_ID, workspaceId: WS_ID, name: "ABC Acquisition", status: "active", ...overrides },
  };
}

async function renderPage(overrides?: Partial<{ workspaceId: string; projectId: string; runId: string }>) {
  const element = await callPage(overrides);
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(element as any);
  });
  return renderer;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("TeamResearchDetailPage — gate (server-authoritative)", () => {
  it("unauthenticated -> notFound", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue(null);
    await expectRealNotFound(callPage());
    expect(mockedResolveWorkspaceAccess).not.toHaveBeenCalled();
    expect(mockedGetProject).not.toHaveBeenCalled();
    expect(mockedGetTeamWorkspaceRun).not.toHaveBeenCalled();
  });

  it("resolveWorkspaceAccess denies -> notFound, nothing further called", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue({ granted: false, reason: "membership_not_found" });
    await expectRealNotFound(callPage());
    expect(mockedGetProject).not.toHaveBeenCalled();
    expect(mockedGetTeamWorkspaceRun).not.toHaveBeenCalled();
  });

  it("wrong workspace type (Personal) -> notFound", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue({ granted: true, workspaceType: "personal", workspace: { id: WS_ID, name: "Personal" } });
    await expectRealNotFound(callPage());
  });

  it("granted Team role WITHOUT research.read -> notFound, getProject/getTeamWorkspaceRun never called (this page needs research.read, not projects.read)", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue(grantedTeamAccess({ capabilities: ["workspace.read", "projects.read"] }));
    await expectRealNotFound(callPage());
    expect(mockedGetProject).not.toHaveBeenCalled();
    expect(mockedGetTeamWorkspaceRun).not.toHaveBeenCalled();
  });

  it("has projects.read but not research.read -> notFound", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue(grantedTeamAccess({ capabilities: ["workspace.read", "projects.read"] }));
    await expectRealNotFound(callPage());
  });

  it("Project not found -> notFound", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue(grantedTeamAccess());
    mockedGetProject.mockResolvedValue({ status: "not_found" });
    await expectRealNotFound(callPage());
    expect(mockedGetTeamWorkspaceRun).not.toHaveBeenCalled();
  });

  it("CRITICAL — Project belongs to a DIFFERENT Workspace than the route's own workspaceId -> notFound, concealed identically to not-found", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue(grantedTeamAccess());
    mockedGetProject.mockResolvedValue(foundProject({ workspaceId: OTHER_WS_ID }));
    await expectRealNotFound(callPage());
    expect(mockedGetTeamWorkspaceRun).not.toHaveBeenCalled();
  });

  it("run does not exist at all -> notFound", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue(grantedTeamAccess());
    mockedGetProject.mockResolvedValue(foundProject());
    mockedGetTeamWorkspaceRun.mockResolvedValue({ status: "not_found" });
    await expectRealNotFound(callPage());
    expect(mockedGetTeamWorkspaceRun).toHaveBeenCalledWith({ workspaceId: WS_ID, projectId: PROJECT_ID, runId: RUN_ID });
  });

  it("getTeamWorkspaceRun reports firestore_unavailable -> notFound (never crashes, never renders)", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue(grantedTeamAccess());
    mockedGetProject.mockResolvedValue(foundProject());
    mockedGetTeamWorkspaceRun.mockResolvedValue({ status: "firestore_unavailable" });
    await expectRealNotFound(callPage());
  });

  it("NEW CONTAINMENT DIMENSION — run genuinely exists in the SAME Workspace but belongs to a DIFFERENT Project -> notFound, concealed identically to not-found", async () => {
    // The page itself never re-derives this comparison — it is entirely
    // delegated to getTeamWorkspaceRun(), so this test proves the page
    // treats getTeamWorkspaceRun()'s own "not_found" result (which is what
    // a real cross-Project mismatch produces) as a genuine notFound(),
    // never rendering partial content.
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue(grantedTeamAccess());
    mockedGetProject.mockResolvedValue(foundProject());
    mockedGetTeamWorkspaceRun.mockResolvedValue({ status: "not_found" });
    await expectRealNotFound(callPage({ projectId: PROJECT_ID }));
    expect(mockedGetTeamWorkspaceRun).toHaveBeenCalledWith({ workspaceId: WS_ID, projectId: PROJECT_ID, runId: RUN_ID });
  });

  it("run status running -> renders an in-progress state, not a crash, not TeamResearchResultView", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue(grantedTeamAccess());
    mockedGetProject.mockResolvedValue(foundProject());
    mockedGetTeamWorkspaceRun.mockResolvedValue({ status: "pending", runId: RUN_ID, question: "What is the market size?" });
    const renderer = await renderPage();
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("still in progress");
    expect(text).toContain("What is the market size?");
    expect(renderer.root.findAllByProps({ "data-testid": "team-research-result-view" }).length).toBe(0);
    // "Back to Project" link is present regardless of status.
    const backLink = renderer.root.findAllByType("a").find((el) => JSON.stringify(el.props.href).includes(`/workspace/team/${WS_ID}/projects/${PROJECT_ID}`));
    expect(backLink).toBeDefined();
  });

  it("authorized, run belongs to the exact requested Workspace+Project, status complete -> renders TeamResearchResultView with the run's results/governanceStatus", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue(grantedTeamAccess());
    mockedGetProject.mockResolvedValue(foundProject());
    const results = [{ modelId: "chatgpt", status: "ok", rawTextFull: "Answer text" }];
    mockedGetTeamWorkspaceRun.mockResolvedValue({
      status: "complete",
      runId: RUN_ID,
      question: "What is the market size?",
      governanceStatus: "approved",
      results,
    });
    const renderer = await renderPage();
    const view = renderer.root.findAllByProps({ "data-testid": "team-research-result-view" });
    expect(view.length).toBe(1);
    const runProp = JSON.parse(view[0].props["data-run"]);
    expect(runProp).toEqual({ runId: RUN_ID, results, governanceStatus: "approved" });
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain("What is the market size?");
  });

  it("getTeamWorkspaceRun is called with exactly the route's workspaceId/projectId/runId", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue(grantedTeamAccess());
    mockedGetProject.mockResolvedValue(foundProject());
    mockedGetTeamWorkspaceRun.mockResolvedValue({ status: "complete", runId: RUN_ID, question: "Q", results: [] });
    await callPage();
    expect(mockedGetTeamWorkspaceRun).toHaveBeenCalledWith({ workspaceId: WS_ID, projectId: PROJECT_ID, runId: RUN_ID });
  });
});
