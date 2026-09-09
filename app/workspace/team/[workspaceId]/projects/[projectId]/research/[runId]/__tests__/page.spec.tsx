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

  /**
   * Elements carrying aria-current INSIDE the WorkspaceNav specifically.
   *
   * Phase 11B.3 added a Breadcrumb, which correctly marks its own final segment
   * `aria-current="page"`. An unscoped query would conflate the two navs, so
   * each is asserted against its own landmark — and the fact that each carries
   * exactly one current item is itself part of the accessibility contract.
   */
  function currentItemsIn(renderer: TestRenderer.ReactTestRenderer, navLabel: string) {
    const navs = renderer.root.findAll((n) => n.type === "nav" && n.props?.["aria-label"] === navLabel, { deep: true });
    return navs.flatMap((nav) =>
      nav
        .findAll((n) => typeof n.type === "string" && n.props?.["aria-current"] === "page", { deep: true })
        .map((n) => JSON.stringify(n.children))
    );
  }
  const currentItems = (renderer: TestRenderer.ReactTestRenderer) => currentItemsIn(renderer, "Workspace");
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

  it("T5 — Phase 11B.3: the isolated Back to Project link is ABSORBED by the breadcrumb, which now owns parent navigation", async () => {
    const r = await renderAuthorized(WITHOUT_AUDIT);
    // The one-off link is gone — two equivalent hierarchy affordances would be redundant.
    expect(visibleText(r)).not.toContain("Back to Project");
    // ...but the destination is NOT lost: the breadcrumb's Project segment keeps it reachable.
    expect(anchorHrefs(r)).toContain(`/workspace/team/${WS_ID}/projects/${PROJECT_ID}`);
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

/* ------------------------------------------------------------------ *
 * Phase 11B.3 — Breadcrumb inspection helpers.
 *
 * The REAL `Breadcrumb` is rendered (never mocked), so these read the shipped
 * component's own markup: its `<nav aria-label="Breadcrumb">` landmark, the
 * desktop `<ol>` hierarchy, and the separate mobile parent affordance.
 * `aria-hidden` nodes (the "/" separators and the "←" glyph) are excluded, so a
 * label assertion can never accidentally pass on decorative text.
 * ------------------------------------------------------------------ */
type BcSeg = { label: string; href?: string; current: boolean };

function visibleTextOf(node: TestRenderer.ReactTestInstance): string {
  const out: string[] = [];
  const walk = (n: TestRenderer.ReactTestInstance) => {
    n.children.forEach((c) => {
      if (typeof c === "string") out.push(c);
      else if (c.props?.["aria-hidden"] !== "true") walk(c);
    });
  };
  walk(node);
  return out.join("").replace(/\s+/g, " ").trim();
}

function breadcrumbNav(r: TestRenderer.ReactTestRenderer) {
  return r.root.findAll((n) => n.type === "nav" && n.props?.["aria-label"] === "Breadcrumb", { deep: true });
}

function bcSegments(r: TestRenderer.ReactTestRenderer): BcSeg[] {
  const navs = breadcrumbNav(r);
  if (navs.length === 0) return [];
  const ol = navs[0].findAllByType("ol")[0];
  return ol.findAllByType("li").map((li) => {
    const el = li.findAll((n) => (n.type === "a" || n.type === "span") && n.props?.["aria-hidden"] !== "true", { deep: true })[0];
    return {
      label: visibleTextOf(el),
      href: el.type === "a" ? String(el.props.href) : undefined,
      current: el.props["aria-current"] === "page",
    };
  });
}

function bcMobileParent(r: TestRenderer.ReactTestRenderer): { label: string; href?: string } | null {
  const navs = breadcrumbNav(r);
  if (navs.length === 0) return null;
  const wrap = navs[0].findAll(
    (n) => n.type === "div" && typeof n.props?.className === "string" && n.props.className.includes("sm:hidden"),
    { deep: true }
  );
  if (wrap.length === 0) return null;
  const el = wrap[0].findAll((n) => n.type === "a" || n.type === "span", { deep: true })[0];
  return { label: visibleTextOf(el), href: el.type === "a" ? String(el.props.href) : undefined };
}

function h1Texts(r: TestRenderer.ReactTestRenderer): string[] {
  return r.root.findAllByType("h1").map(visibleTextOf);
}

describe("Phase 11B.3 — Team research detail breadcrumb", () => {
  const WS = "ws_123";
  const WS_NAME = "Acme Risk Lab";
  const PID = "proj_456";
  const PNAME = "Election Evidence";
  const RID = "run_789";
  const QUESTION = "What changed in the source evidence?";

  /** Every label deliberately differs from its id, so no assertion can pass on an id. */
  function wire({ workspaceId = WS, projectId = PID, runId = RID } = {}) {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue({
      granted: true,
      workspaceType: "team",
      workspace: { id: workspaceId, name: WS_NAME },
      membership: { role: "member" },
      capabilities: ["workspace.read", "projects.read", "research.read"],
    });
    mockedGetProject.mockResolvedValue({
      status: "found",
      project: { id: projectId, workspaceId, name: PNAME, status: "active" },
    });
    mockedGetTeamWorkspaceRun.mockResolvedValue({ status: "complete", runId, question: QUESTION, results: [] });
    return renderPage({ workspaceId, projectId, runId });
  }

  it("AE1 — full four-level hierarchy, each parent linked, the question final and non-linking", async () => {
    expect(bcSegments(await wire())).toEqual([
      { label: WS_NAME, href: `/workspace/team/${WS}`, current: false },
      { label: "Projects", href: `/workspace/team/${WS}/projects`, current: false },
      { label: PNAME, href: `/workspace/team/${WS}/projects/${PID}`, current: false },
      { label: QUESTION, href: undefined, current: true },
    ]);
  });

  it("AE2 — mobileParent is the Project, the genuine immediate parent", async () => {
    expect(bcMobileParent(await wire())).toEqual({ label: PNAME, href: `/workspace/team/${WS}/projects/${PID}` });
  });

  it("AE3 — NON-VACUITY: labels are the resolved NAMES and the question — never workspaceId, projectId or runId", async () => {
    const labels = bcSegments(await wire()).map((x) => x.label);
    expect(labels).toEqual([WS_NAME, "Projects", PNAME, QUESTION]);
    for (const id of [WS, PID, RID]) expect(labels).not.toContain(id);
    // the run id never appears in a breadcrumb href either — no segment points at this page
    for (const seg of bcSegments(await wire())) expect(seg.href ?? "").not.toContain(RID);
  });

  it("AE4 — the run question is the page's single h1", async () => {
    expect(h1Texts(await wire())).toEqual([QUESTION]);
  });

  it("AE5 — the isolated 'Back to Project' link is ABSENT; the breadcrumb owns parent navigation now", async () => {
    const r = await wire();
    expect(JSON.stringify(r.toJSON())).not.toContain("Back to Project");
    expect(bcSegments(r).map((x) => x.href)).toContain(`/workspace/team/${WS}/projects/${PID}`);
  });

  it("AE6 — WorkspaceNav is untouched and still marks Projects current; each nav carries exactly one aria-current", async () => {
    const r = await wire();
    const currentIn = (label: string) =>
      r.root
        .findAll((n) => n.type === "nav" && n.props?.["aria-label"] === label, { deep: true })
        .flatMap((nav) => nav.findAll((n) => n.props?.["aria-current"] === "page", { deep: true }).map(visibleTextOf));
    expect(currentIn("Workspace")).toEqual(["Projects"]);
    expect(currentIn("Breadcrumb")).toEqual([QUESTION]);
  });

  it("AE7 — a PENDING run still renders the full breadcrumb and the in-progress state", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue({
      granted: true, workspaceType: "team", workspace: { id: WS, name: WS_NAME },
      membership: { role: "member" }, capabilities: ["workspace.read", "projects.read", "research.read"],
    });
    mockedGetProject.mockResolvedValue({ status: "found", project: { id: PID, workspaceId: WS, name: PNAME, status: "active" } });
    mockedGetTeamWorkspaceRun.mockResolvedValue({ status: "pending", runId: RID, question: QUESTION });
    const r = await renderPage({ workspaceId: WS, projectId: PID, runId: RID });
    expect(bcSegments(r).map((x) => x.label)).toEqual([WS_NAME, "Projects", PNAME, QUESTION]);
    expect(JSON.stringify(r.toJSON())).toContain("still in progress");
  });

  it("AE8 — ENCODING: reserved characters in workspaceId and projectId are percent-encoded in every href", async () => {
    const r = await wire({ workspaceId: "ws/a b", projectId: "proj/x y" });
    const segs = bcSegments(r);
    expect(segs[0].href).toBe("/workspace/team/ws%2Fa%20b");
    expect(segs[1].href).toBe("/workspace/team/ws%2Fa%20b/projects");
    expect(segs[2].href).toBe("/workspace/team/ws%2Fa%20b/projects/proj%2Fx%20y");
    expect(bcMobileParent(r)!.href).toBe("/workspace/team/ws%2Fa%20b/projects/proj%2Fx%20y");
    for (const seg of segs) expect(seg.href ?? "").not.toContain("ws/a b");
  });
});

describe("Phase 11B.3 — NO breadcrumb (and therefore no Workspace/Project name) leaks on any denied, absent or transient path", () => {
  /**
   * Each case drives the REAL page boundary. A `notFound()` or a thrown transient
   * Error means nothing rendered at all, so no label could reach a viewer — these
   * assert that the page never gets far enough to build a breadcrumb, which is
   * the property that matters, not the absence of a DOM node.
   */
  const CAPS = ["workspace.read", "projects.read", "research.read"];
  const granted = (over: Record<string, unknown> = {}) => ({
    granted: true, workspaceType: "team", workspace: { id: WS_ID, name: "Acme Risk Lab" },
    membership: { role: "member" }, capabilities: CAPS, ...over,
  });
  const project = (over: Record<string, unknown> = {}) => ({
    status: "found", project: { id: PROJECT_ID, workspaceId: WS_ID, name: "Election Evidence", status: "active", ...over },
  });
  const okRun = { status: "complete", runId: RUN_ID, question: "What changed in the source evidence?", results: [] };

  async function expectNoRender(kind: "notFound" | "throws") {
    let caught: unknown;
    try {
      await callPage();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    if (kind === "notFound") expect((caught as any)?.digest).toBe("NEXT_NOT_FOUND");
    else expect((caught as any)?.digest).not.toBe("NEXT_NOT_FOUND");
  }

  it("AF1 — unauthenticated", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue(null);
    await expectNoRender("notFound");
  });

  it("AF2 — Workspace access denied", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue({ granted: false, reason: "not_a_member" });
    await expectNoRender("notFound");
  });

  it("AF3 — wrong Workspace type (Personal)", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue(granted({ workspaceType: "personal" }));
    await expectNoRender("notFound");
  });

  it("AF4 — missing research.read", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue(granted({ capabilities: ["workspace.read", "projects.read"] }));
    await expectNoRender("notFound");
  });

  it("AF5 — Project not found", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue(granted());
    mockedGetProject.mockResolvedValue({ status: "not_found" });
    await expectNoRender("notFound");
  });

  it("AF6 — cross-Workspace Project", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue(granted());
    mockedGetProject.mockResolvedValue(project({ workspaceId: "some-other-workspace" }));
    await expectNoRender("notFound");
  });

  it("AF7 — run not found", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue(granted());
    mockedGetProject.mockResolvedValue(project());
    mockedGetTeamWorkspaceRun.mockResolvedValue({ status: "not_found" });
    await expectNoRender("notFound");
  });

  it("AF8 — cross-Project run (the resolver conceals it as not_found)", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue(granted());
    mockedGetProject.mockResolvedValue(project());
    mockedGetTeamWorkspaceRun.mockResolvedValue({ status: "not_found" });
    await expectNoRender("notFound");
    expect(mockedGetTeamWorkspaceRun).toHaveBeenCalledWith({ workspaceId: WS_ID, projectId: PROJECT_ID, runId: RUN_ID });
  });

  it("AF9 — transient Workspace lookup failure throws, and never reaches the Project read", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue({ granted: false, reason: "lookup_failed" });
    await expectNoRender("throws");
    expect(mockedGetProject).not.toHaveBeenCalled();
  });

  it("AF10 — transient Project failure throws, and never reaches the run read", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue(granted());
    mockedGetProject.mockResolvedValue({ status: "firestore_unavailable" });
    await expectNoRender("throws");
    expect(mockedGetTeamWorkspaceRun).not.toHaveBeenCalled();
  });

  it("AF11 — transient run failure throws", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue(granted());
    mockedGetProject.mockResolvedValue(project());
    mockedGetTeamWorkspaceRun.mockResolvedValue({ status: "firestore_unavailable" });
    await expectNoRender("throws");
  });

  it("AF12 — CONTROL: the same fixtures on the fully-authorized path DO render the breadcrumb, so AF1-AF11 are not passing on a broken harness", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue(granted());
    mockedGetProject.mockResolvedValue(project());
    mockedGetTeamWorkspaceRun.mockResolvedValue(okRun);
    const r = await renderPage();
    expect(bcSegments(r).map((x) => x.label)).toEqual([
      "Acme Risk Lab", "Projects", "Election Evidence", "What changed in the source evidence?",
    ]);
  });
});

/* ------------------------------------------------------------------ *
 * Phase 11B.3-C1 — RELATIVE DOM ORDER.
 *
 * The 11B.3 tests proved the breadcrumb's contents, the h1's contents and
 * WorkspaceNav's state each independently — and every one of them passed while
 * four surfaces still rendered WorkspaceNav ABOVE the heading, in violation of
 * the frozen composition contract. This helper closes that gap by pinning the
 * one property none of them expressed: document order.
 *
 * Positions come from a depth-first walk of the RENDERED tree (`toTree()`), not
 * from source text, so it measures what a viewer actually gets.
 * ------------------------------------------------------------------ */
function documentOrder(r: TestRenderer.ReactTestRenderer): { breadcrumb: number; h1: number; workspaceNav: number } {
  const flat: { type: string; props: Record<string, unknown> }[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) return node.forEach(walk);
    const n = node as { type?: unknown; props?: Record<string, unknown>; rendered?: unknown };
    if (typeof n.type === "string") flat.push({ type: n.type, props: n.props ?? {} });
    walk(n.rendered);
  };
  walk(r.toTree());

  const at = (pred: (e: { type: string; props: Record<string, unknown> }) => boolean) => flat.findIndex(pred);
  return {
    breadcrumb: at((e) => e.type === "nav" && e.props["aria-label"] === "Breadcrumb"),
    h1: at((e) => e.type === "h1"),
    workspaceNav: at((e) => e.type === "nav" && e.props["aria-label"] === "Workspace"),
  };
}

/** Breadcrumb -> page heading -> WorkspaceNav, with all three actually present. */
function expectFrozenComposition(r: TestRenderer.ReactTestRenderer) {
  const o = documentOrder(r);
  expect(o.breadcrumb).toBeGreaterThanOrEqual(0);
  expect(o.h1).toBeGreaterThanOrEqual(0);
  expect(o.workspaceNav).toBeGreaterThanOrEqual(0);
  expect(o.breadcrumb).toBeLessThan(o.h1);
  expect(o.h1).toBeLessThan(o.workspaceNav);
}

describe("Phase 11B.3-C1 — Research detail page composition order", () => {
  function wireOrder(runStatus: "complete" | "pending") {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue({
      granted: true, workspaceType: "team", workspace: { id: WS_ID, name: "Acme Risk Lab" },
      membership: { role: "member" }, capabilities: ["workspace.read", "projects.read", "research.read"],
    });
    mockedGetProject.mockResolvedValue({ status: "found", project: { id: PROJECT_ID, workspaceId: WS_ID, name: "Election Evidence", status: "active" } });
    mockedGetTeamWorkspaceRun.mockResolvedValue(
      runStatus === "complete"
        ? { status: "complete", runId: RUN_ID, question: "What changed in the source evidence?", results: [] }
        : { status: "pending", runId: RUN_ID, question: "What changed in the source evidence?" }
    );
    return renderPage();
  }

  it("C1-R1 — Breadcrumb -> h1 run question -> WorkspaceNav -> result content", async () => {
    const r = await wireOrder("complete");
    expectFrozenComposition(r);
    expect(h1Texts(r)).toEqual(["What changed in the source evidence?"]);
  });

  it("C1-R2 — the same order holds for a PENDING run", async () => {
    const r = await wireOrder("pending");
    expectFrozenComposition(r);
    expect(JSON.stringify(r.toJSON())).toContain("still in progress");
  });
});
