/**
 * Team Research Detail (Project address) — Server Component gate.
 *
 * TEAM-RESEARCH-PARITY-R3 rewrote this suite with the page: the page no longer
 * reads the run itself (Phase 12A.4's `getTeamWorkspaceRun()` + limited
 * `TeamResearchResultView`). It gates identity → Team Workspace access →
 * `research.read` → Project found → Project/Workspace containment, then hands
 * the authorized context to `TeamResearchDetailShell`, which reads the run
 * through the canonical R1 endpoint with `?projectId=`. Run-level containment,
 * Team chrome (breadcrumb, heading, assignee, WorkspaceNav, composition order)
 * and every run state now live in `TeamResearchDetailShell.spec.tsx`.
 *
 * Every Phase 12A.4 / 11B gate invariant is kept here: real `notFound()`
 * (digest "NEXT_NOT_FOUND") for every denial, a generic byte-identical throw
 * for transient infra failures, and nothing rendered (so no Workspace/Project
 * name) on any denied path.
 */

import { readFileSync } from "fs";
import { join } from "path";
import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";

const mockedResolveServerComponentIdentity = jest.fn();
jest.mock("@/lib/auth/resolveServerComponentIdentity", () => ({
  resolveServerComponentIdentity: (...args: unknown[]) => mockedResolveServerComponentIdentity(...args),
}));

const mockedResolveWorkspaceAccess = jest.fn();
jest.mock("@/lib/workspaces/resolveWorkspaceAccess", () => ({
  resolveWorkspaceAccess: (...args: unknown[]) => mockedResolveWorkspaceAccess(...args),
}));

const mockedGetProject = jest.fn();
jest.mock("@/lib/firestore/projects", () => ({
  getProject: (...args: unknown[]) => mockedGetProject(...args),
}));

/** R3 — the old direct run read must never be reached from this page again. */
const mockedGetTeamWorkspaceRun = jest.fn();
jest.mock("@/lib/firestore/teamWorkspaceRuns", () => ({
  getTeamWorkspaceRun: (...args: unknown[]) => mockedGetTeamWorkspaceRun(...args),
}));

const shellProps: Record<string, unknown>[] = [];
jest.mock("@/components/workspace/projects/TeamResearchDetailShell", () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    shellProps.push(props);
    return require("react").createElement("div", { "data-testid": "team-research-detail-shell" });
  },
}));

import TeamResearchDetailPage from "@/app/workspace/team/[workspaceId]/projects/[projectId]/research/[runId]/page";

const SOURCE = readFileSync(join(__dirname, "..", "page.tsx"), "utf8");
/** Comments stripped before any absence assertion, so the page's own doc comment cannot satisfy it. */
const CODE = SOURCE.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

const WS_ID = "ws-1";
const OTHER_WS_ID = "ws-2";
const PROJECT_ID = "proj-1";
const RUN_ID = "run-1";
const UID = "uid-member";
const TRANSIENT = "Something went wrong while loading this page. Please try again.";

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
  expect((caught as { digest?: string })?.digest).toBe("NEXT_NOT_FOUND");
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
  return { status: "found", project: { id: PROJECT_ID, workspaceId: WS_ID, name: "ABC Acquisition", status: "active", ...overrides } };
}

async function renderPage(overrides?: Partial<{ workspaceId: string; projectId: string; runId: string }>) {
  const element = await callPage(overrides);
  let renderer!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    renderer = TestRenderer.create(element as never);
  });
  return renderer;
}

function authorize(access = grantedTeamAccess()) {
  mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
  mockedResolveWorkspaceAccess.mockResolvedValue(access);
  mockedGetProject.mockResolvedValue(foundProject());
}

beforeEach(() => {
  jest.clearAllMocks();
  shellProps.length = 0;
});

describe("TeamResearchDetailPage — gate (server-authoritative)", () => {
  it("unauthenticated -> notFound, nothing further called", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue(null);
    await expectRealNotFound(callPage());
    expect(mockedResolveWorkspaceAccess).not.toHaveBeenCalled();
    expect(mockedGetProject).not.toHaveBeenCalled();
    expect(shellProps).toHaveLength(0);
  });

  it.each(["membership_not_found", "membership_removed", "workspace_not_found", "team_workspaces_disabled"])("access denied (%s) -> notFound (non-member / removed member concealed)", async (reason) => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue({ granted: false, reason });
    await expectRealNotFound(callPage());
    expect(mockedGetProject).not.toHaveBeenCalled();
    expect(shellProps).toHaveLength(0);
  });

  it("wrong workspace type (Personal) -> notFound", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue({ granted: true, workspaceType: "personal", workspace: { id: WS_ID, name: "Personal" }, capabilities: ["research.read"] });
    await expectRealNotFound(callPage());
  });

  it("granted Team role WITHOUT research.read (projects.read only) -> notFound, Project never read", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue(grantedTeamAccess({ capabilities: ["workspace.read", "projects.read"] }));
    await expectRealNotFound(callPage());
    expect(mockedGetProject).not.toHaveBeenCalled();
  });

  it("Project not found / malformed -> notFound", async () => {
    for (const status of ["not_found", "malformed"]) {
      authorize();
      mockedGetProject.mockResolvedValue({ status });
      await expectRealNotFound(callPage());
    }
    expect(shellProps).toHaveLength(0);
  });

  it("CRITICAL — Project belongs to a DIFFERENT Workspace -> notFound, concealed identically to not-found", async () => {
    authorize();
    mockedGetProject.mockResolvedValue(foundProject({ workspaceId: OTHER_WS_ID }));
    await expectRealNotFound(callPage());
    expect(shellProps).toHaveLength(0);
  });

  it("an ARCHIVED Project in the right Workspace stays readable", async () => {
    authorize();
    mockedGetProject.mockResolvedValue(foundProject({ status: "archived" }));
    await renderPage();
    expect(shellProps).toHaveLength(1);
  });
});

describe("TeamResearchDetailPage — hands authorized context to the Team detail shell (R3)", () => {
  it("renders exactly the shell with server-resolved Workspace name, contained Project, route runId and the audit hint", async () => {
    authorize(grantedTeamAccess({ capabilities: ["workspace.read", "projects.read", "research.read", "audit.read"] }));
    const r = await renderPage();
    expect(r.root.findAllByProps({ "data-testid": "team-research-detail-shell" })).toHaveLength(1);
    expect(shellProps).toHaveLength(1);
    expect(shellProps[0]).toEqual({ workspaceId: WS_ID, workspaceName: "Acme Team", runId: RUN_ID, project: { id: PROJECT_ID, name: "ABC Acquisition" }, showAudit: true, canVerifyClaim: false });
  });

  it("showAudit is false without audit.read, and research.read access is unaffected", async () => {
    authorize(grantedTeamAccess({ capabilities: ["workspace.read", "research.read"] }));
    await renderPage();
    expect(shellProps[0]).toMatchObject({ showAudit: false });
  });

  it("the Project in the shell props is the Workspace-contained Project read, never derived from the route id alone", async () => {
    authorize();
    mockedGetProject.mockResolvedValue(foundProject({ name: "Resolved Name" }));
    await renderPage();
    expect(shellProps[0].project).toEqual({ id: PROJECT_ID, name: "Resolved Name" });
    expect(mockedGetProject).toHaveBeenCalledWith(PROJECT_ID);
  });

  it("R3 — the page never reads the run itself: getTeamWorkspaceRun is neither called nor imported, and no result renderer is imported", async () => {
    authorize();
    await renderPage();
    expect(mockedGetTeamWorkspaceRun).not.toHaveBeenCalled();
    expect(CODE).not.toMatch(/getTeamWorkspaceRun/);
    expect(CODE).not.toMatch(/teamWorkspaceRuns/);
    expect(CODE).not.toMatch(/TeamResearchResultView|ResultsDisplay|PersistedResearchResultView/);
  });

  it("the page never calls or names the Personal run endpoint", () => {
    expect(CODE).not.toMatch(/\/api\/user\/runs/);
    expect(CODE).not.toMatch(/personalResearchHref|\/workspace\/research\//);
  });
});

describe("TRANSIENT FAILURE — must throw, never notFound()", () => {
  it("resolveWorkspaceAccess lookup_failed -> generic throw, Project never read", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue({ granted: false, reason: "lookup_failed" });
    await expect(callPage()).rejects.toThrow(TRANSIENT);
    expect(mockedGetProject).not.toHaveBeenCalled();
  });

  it.each(["firestore_unavailable", "read_failed"])("getProject %s -> generic throw, shell never rendered", async (status) => {
    authorize();
    mockedGetProject.mockResolvedValue({ status });
    await expect(callPage()).rejects.toThrow(TRANSIENT);
    expect(shellProps).toHaveLength(0);
  });

  it("the thrown message never leaks ids or storage names and is byte-identical across stages", async () => {
    const messages: string[] = [];
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue({ granted: false, reason: "lookup_failed" });
    await callPage().catch((e: Error) => messages.push(e.message));
    authorize();
    mockedGetProject.mockResolvedValue({ status: "firestore_unavailable" });
    await callPage().catch((e: Error) => messages.push(e.message));
    expect(messages).toHaveLength(2);
    expect(messages[0]).toBe(messages[1]);
    for (const id of [WS_ID, PROJECT_ID, RUN_ID]) expect(messages[0]).not.toContain(id);
    expect(messages[0].toLowerCase()).not.toContain("firestore");
  });
});

describe("NO Workspace/Project name leaks on any denied, absent or transient path", () => {
  it("each denial renders nothing at all (no shell, so no breadcrumb, no names)", async () => {
    const cases: Array<() => void> = [
      () => mockedResolveServerComponentIdentity.mockResolvedValue(null),
      () => { mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID }); mockedResolveWorkspaceAccess.mockResolvedValue({ granted: false, reason: "membership_not_found" }); },
      () => { authorize(grantedTeamAccess({ capabilities: ["workspace.read"] })); },
      () => { authorize(); mockedGetProject.mockResolvedValue({ status: "not_found" }); },
      () => { authorize(); mockedGetProject.mockResolvedValue(foundProject({ workspaceId: OTHER_WS_ID })); },
    ];
    for (const setup of cases) {
      jest.clearAllMocks();
      shellProps.length = 0;
      setup();
      await expect(callPage()).rejects.toBeDefined();
      expect(shellProps).toHaveLength(0);
    }
  });

  it("CONTROL: the same fixtures on the authorized path DO render the shell", async () => {
    authorize();
    await renderPage();
    expect(shellProps).toHaveLength(1);
    expect(createElement).toBeDefined();
  });
});

describe("R4-I4 Verify-this-claim presentation hint", () => {
  const caps = (...extra: string[]) => ["workspace.read", "projects.read", "research.read", ...extra];

  it.each([
    ["neither creation capability", caps(), false],
    ["research.create only", caps("research.create"), false],
    ["research.organize only", caps("research.organize"), false],
    ["both creation capabilities", caps("research.create", "research.organize"), true],
  ])("with %s -> canVerifyClaim=%s", async (_l, capabilities, expected) => {
    // Filing a Claim from a Project-filed run needs BOTH, exactly as the POST
    // gates require. The page itself stays readable on research.read alone.
    mockedResolveWorkspaceAccess.mockResolvedValue(grantedTeamAccess({ capabilities: capabilities as string[] }));
    mockedGetProject.mockResolvedValue(foundProject());
    await renderPage();
    expect(shellProps).toHaveLength(1);
    expect(shellProps[0].canVerifyClaim).toBe(expected);
  });
});
