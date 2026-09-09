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

  it("getTeamWorkspaceRun reports firestore_unavailable -> throws a generic Error (transient infra failure, never crashes as notFound, never renders) — see the dedicated TRANSIENT FAILURE describe block below for the full assertion", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue(grantedTeamAccess());
    mockedGetProject.mockResolvedValue(foundProject());
    mockedGetTeamWorkspaceRun.mockResolvedValue({ status: "firestore_unavailable" });
    await expect(callPage()).rejects.toThrow("Something went wrong while loading this page. Please try again.");
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

  describe("TRANSIENT FAILURE — must throw, never notFound()", () => {
    async function expectGenericThrow(promise: Promise<unknown>): Promise<void> {
      await expect(promise).rejects.toThrow("Something went wrong while loading this page. Please try again.");
    }

    it("resolveWorkspaceAccess returns lookup_failed -> throws generic Error, NOT notFound(), getProject/getTeamWorkspaceRun never called", async () => {
      mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
      mockedResolveWorkspaceAccess.mockResolvedValue({ granted: false, reason: "lookup_failed" });
      await expectGenericThrow(callPage());
      expect(mockedGetProject).not.toHaveBeenCalled();
      expect(mockedGetTeamWorkspaceRun).not.toHaveBeenCalled();
    });

    it("getProject returns firestore_unavailable -> throws generic Error, NOT notFound(), getTeamWorkspaceRun never called", async () => {
      mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
      mockedResolveWorkspaceAccess.mockResolvedValue(grantedTeamAccess());
      mockedGetProject.mockResolvedValue({ status: "firestore_unavailable" });
      await expectGenericThrow(callPage());
      expect(mockedGetTeamWorkspaceRun).not.toHaveBeenCalled();
    });

    it("getProject returns read_failed -> throws generic Error, NOT notFound()", async () => {
      mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
      mockedResolveWorkspaceAccess.mockResolvedValue(grantedTeamAccess());
      mockedGetProject.mockResolvedValue({ status: "read_failed" });
      await expectGenericThrow(callPage());
    });

    it("getTeamWorkspaceRun returns firestore_unavailable -> throws generic Error, NOT notFound()", async () => {
      mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
      mockedResolveWorkspaceAccess.mockResolvedValue(grantedTeamAccess());
      mockedGetProject.mockResolvedValue(foundProject());
      mockedGetTeamWorkspaceRun.mockResolvedValue({ status: "firestore_unavailable" });
      await expectGenericThrow(callPage());
    });

    it("thrown error message never leaks workspaceId/projectId/runId or a Firestore collection name, and is byte-identical across every transient stage", async () => {
      mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });

      mockedResolveWorkspaceAccess.mockResolvedValue({ granted: false, reason: "lookup_failed" });
      let messageA = "";
      try {
        await callPage();
      } catch (err) {
        messageA = (err as Error).message;
      }

      mockedResolveWorkspaceAccess.mockResolvedValue(grantedTeamAccess());
      mockedGetProject.mockResolvedValue({ status: "firestore_unavailable" });
      let messageB = "";
      try {
        await callPage();
      } catch (err) {
        messageB = (err as Error).message;
      }

      mockedGetProject.mockResolvedValue(foundProject());
      mockedGetTeamWorkspaceRun.mockResolvedValue({ status: "firestore_unavailable" });
      let messageC = "";
      try {
        await callPage();
      } catch (err) {
        messageC = (err as Error).message;
      }

      expect(messageA).toBe(messageB);
      expect(messageB).toBe(messageC);
      expect(messageA).not.toMatch(new RegExp(WS_ID));
      expect(messageA).not.toMatch(new RegExp(PROJECT_ID));
      expect(messageA).not.toMatch(new RegExp(RUN_ID));
      expect(messageA.toLowerCase()).not.toContain("firestore");
      expect(messageA.toLowerCase()).not.toContain("run-");
    });
  });
});


// ===========================================================================
describe("Phase 11B.2 — WorkspaceNav on Team research detail", () => {
  /**
   * The Team research COMPOSER already rendered the shared WorkspaceNav; the
   * research DETAIL page did not, so the two research surfaces navigated
   * differently. This block pins the completed half.
   *
   * The REAL WorkspaceNav is used (not a mock) so these assertions exercise the
   * shipped component's own item set, active-state and href construction.
   */
  const NAV_LABELS = ["Overview", "Projects", "Members"];

  /** Every rendered element carrying aria-current, with its visible text. */
  function currentItems(renderer: TestRenderer.ReactTestRenderer) {
    return renderer.root
      .findAll((n) => typeof n.type === "string" && n.props?.["aria-current"] === "page", { deep: true })
      .map((n) => JSON.stringify(n.children));
  }
  function anchorHrefs(renderer: TestRenderer.ReactTestRenderer): string[] {
    return renderer.root
      .findAll((n) => n.type === "a", { deep: true })
      .map((n) => String(n.props.href ?? ""));
  }
  function visibleText(renderer: TestRenderer.ReactTestRenderer): string {
    return JSON.stringify(renderer.toJSON());
  }

  async function renderAuthorized(capabilities: string[]) {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue(grantedTeamAccess({ capabilities }));
    mockedGetProject.mockResolvedValue(foundProject());
    mockedGetTeamWorkspaceRun.mockResolvedValue({ status: "complete", runId: RUN_ID, question: "Q", results: [] });
    return renderPage();
  }

  const WITHOUT_AUDIT = ["workspace.read", "projects.read", "research.read"];
  const WITH_AUDIT = [...WITHOUT_AUDIT, "audit.read"];

  it("T1 — renders WorkspaceNav with Projects as the current tab", async () => {
    const r = await renderAuthorized(WITHOUT_AUDIT);
    const text = visibleText(r);
    for (const label of NAV_LABELS) expect(text).toContain(label);
    // exactly one current item, and it is Projects — the run itself is not a tab
    const current = currentItems(r);
    expect(current).toHaveLength(1);
    expect(current[0]).toContain("Projects");
  });

  it("T2 — a viewer WITH audit.read sees the Audit Log item", async () => {
    const r = await renderAuthorized(WITH_AUDIT);
    expect(visibleText(r)).toContain("Audit Log");
    expect(anchorHrefs(r)).toContain(`/workspace/team/${WS_ID}/audit`);
  });

  it("T3 — a viewer WITHOUT audit.read sees no Audit Log, and research still renders", async () => {
    const r = await renderAuthorized(WITHOUT_AUDIT);
    const text = visibleText(r);
    expect(text).not.toContain("Audit Log");
    expect(anchorHrefs(r)).not.toContain(`/workspace/team/${WS_ID}/audit`);
    // audit.read is a navigation-visibility hint ONLY — research.read still governs the page
    expect(text).toContain("team-research-result-view");
  });

  it("T4 — every WorkspaceNav link stays inside the server-validated Workspace", async () => {
    const r = await renderAuthorized(WITH_AUDIT);
    const hrefs = anchorHrefs(r);
    expect(hrefs).toEqual(expect.arrayContaining([
      `/workspace/team/${WS_ID}`,
      `/workspace/team/${WS_ID}/members`,
      `/workspace/team/${WS_ID}/audit`,
    ]));
    // no link escapes this Workspace
    for (const h of hrefs) expect(h.startsWith(`/workspace/team/${WS_ID}`)).toBe(true);
  });

  it("T5 — the existing Back to Project affordance is preserved (breadcrumbs are 11B.3)", async () => {
    const r = await renderAuthorized(WITHOUT_AUDIT);
    expect(visibleText(r)).toContain("Back to Project");
    expect(anchorHrefs(r)).toContain(`/workspace/team/${WS_ID}/projects/${PROJECT_ID}`);
    // 11B.2 must not introduce a breadcrumb
    expect(visibleText(r)).not.toContain("breadcrumb");
  });

  it("T6 — a PENDING run still renders the nav and the in-progress state", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue(grantedTeamAccess({ capabilities: WITHOUT_AUDIT }));
    mockedGetProject.mockResolvedValue(foundProject());
    mockedGetTeamWorkspaceRun.mockResolvedValue({ status: "pending", runId: RUN_ID, question: "Q?" });
    const r = await renderPage();
    const current = currentItems(r);
    expect(current).toHaveLength(1);
    expect(current[0]).toContain("Projects");
    expect(visibleText(r)).toContain("still in progress");
  });
});
