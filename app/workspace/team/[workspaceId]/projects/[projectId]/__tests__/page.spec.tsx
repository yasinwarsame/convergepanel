/**
 * Team Projects UI, Phase 12A.2 — GET /workspace/team/{workspaceId}/projects/{projectId}
 * server-gate tests. Same technique as the sibling gate specs: calls the
 * Server Component function directly and asserts real `next/navigation`
 * `notFound()` behavior (digest `"NEXT_NOT_FOUND"`).
 */

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

// PR #164 review C1 — the page's own assignee presentation must never crash the page.
const mockedResolveWorkspaceReviewerDisplayNames = jest.fn();
jest.mock("@/lib/workspaces/workspaceReviewerIdentity", () => ({
  REVIEWER_UNAVAILABLE_LABEL: "Unavailable reviewer",
  resolveWorkspaceReviewerDisplayNames: (...a: unknown[]) => mockedResolveWorkspaceReviewerDisplayNames(...a),
}));
jest.mock("@/components/workspace/projects/TeamProjectDetailShell", () => ({
  __esModule: true,
  default: (props: any) => ({ __mockShell: true, props }),
}));

import TeamProjectDetailPage from "@/app/workspace/team/[workspaceId]/projects/[projectId]/page";

const WS_ID = "ws-1";
const OTHER_WS_ID = "ws-2";
const PROJECT_ID = "proj-1";
const UID = "uid-owner";

function callPage(projectId: string = PROJECT_ID) {
  return TeamProjectDetailPage({ params: { workspaceId: WS_ID, projectId } });
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
    capabilities: ["workspace.read", "projects.read"],
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("TeamProjectDetailPage — gate (server-authoritative, UX-only re-check)", () => {
  it("unauthenticated -> notFound", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue(null);
    await expectRealNotFound(callPage());
    expect(mockedResolveWorkspaceAccess).not.toHaveBeenCalled();
    expect(mockedGetProject).not.toHaveBeenCalled();
  });

  it("resolveWorkspaceAccess denies -> notFound, getProject never called", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue({ granted: false, reason: "membership_not_found" });
    await expectRealNotFound(callPage());
    expect(mockedGetProject).not.toHaveBeenCalled();
  });

  it("wrong workspace type (Personal) -> notFound", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue({ granted: true, workspaceType: "personal", workspace: { id: WS_ID, name: "Personal" } });
    await expectRealNotFound(callPage());
  });

  it("granted Team role WITHOUT projects.read -> notFound, getProject never called", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue(grantedTeamAccess({ capabilities: ["workspace.read"] }));
    await expectRealNotFound(callPage());
    expect(mockedGetProject).not.toHaveBeenCalled();
  });

  it("Project not found -> notFound", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue(grantedTeamAccess());
    mockedGetProject.mockResolvedValue({ status: "not_found" });
    await expectRealNotFound(callPage());
  });

  it("Project malformed -> notFound", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue(grantedTeamAccess());
    mockedGetProject.mockResolvedValue({ status: "malformed" });
    await expectRealNotFound(callPage());
  });

  it("CRITICAL — a Project belonging to a DIFFERENT Workspace than the route's own workspaceId -> notFound, concealed identically to not-found (cross-Workspace containment)", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue(grantedTeamAccess());
    mockedGetProject.mockResolvedValue({
      status: "found",
      project: { id: PROJECT_ID, workspaceId: OTHER_WS_ID, name: "Foreign Project", status: "active" },
    });
    await expectRealNotFound(callPage());
  });

  it("Project belonging to the exact requested Workspace -> renders the shell with correct project meta", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue(grantedTeamAccess({ capabilities: ["workspace.read", "projects.read", "audit.read"] }));
    mockedGetProject.mockResolvedValue({
      status: "found",
      project: { id: PROJECT_ID, workspaceId: WS_ID, name: "ABC Acquisition", status: "active" },
    });
    const result: any = await callPage();
    expect(result.props.workspaceId).toBe(WS_ID);
    expect(result.props.workspaceName).toBe("Acme Team");
    expect(result.props.canReadAudit).toBe(true);
    expect(result.props.project).toEqual({ id: PROJECT_ID, name: "ABC Acquisition", status: "active", assignees: [] });
  });

  it("getProject is called with exactly the route's projectId, never workspaceId or any other value", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue(grantedTeamAccess());
    mockedGetProject.mockResolvedValue({
      status: "found",
      project: { id: PROJECT_ID, workspaceId: WS_ID, name: "X", status: "active" },
    });
    await callPage(PROJECT_ID);
    expect(mockedGetProject).toHaveBeenCalledWith(PROJECT_ID);
  });

  describe("TRANSIENT FAILURE — must throw, never notFound()", () => {
    async function expectGenericThrow(promise: Promise<unknown>): Promise<void> {
      await expect(promise).rejects.toThrow("Something went wrong while loading this page. Please try again.");
    }

    it("resolveWorkspaceAccess returns lookup_failed -> throws generic Error, NOT notFound()", async () => {
      mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
      mockedResolveWorkspaceAccess.mockResolvedValue({ granted: false, reason: "lookup_failed" });
      await expectGenericThrow(callPage());
      expect(mockedGetProject).not.toHaveBeenCalled();
    });

    it("getProject returns firestore_unavailable -> throws generic Error, NOT notFound()", async () => {
      mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
      mockedResolveWorkspaceAccess.mockResolvedValue(grantedTeamAccess());
      mockedGetProject.mockResolvedValue({ status: "firestore_unavailable" });
      await expectGenericThrow(callPage());
    });

    it("getProject returns read_failed -> throws generic Error, NOT notFound()", async () => {
      mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
      mockedResolveWorkspaceAccess.mockResolvedValue(grantedTeamAccess());
      mockedGetProject.mockResolvedValue({ status: "read_failed" });
      await expectGenericThrow(callPage());
    });

    it("thrown error message never leaks projectId, workspaceId, or a Firestore collection name, and is byte-identical across every transient stage", async () => {
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

      expect(messageA).toBe(messageB);
      expect(messageA).not.toMatch(new RegExp(PROJECT_ID));
      expect(messageA).not.toMatch(new RegExp(WS_ID));
      expect(messageA.toLowerCase()).not.toContain("firestore");
      expect(messageA.toLowerCase()).not.toContain("project");
    });
  });

  describe("PHASE 12A.3 — canStartResearch derivation (research.create AND research.organize)", () => {
    async function propsWithCapabilities(capabilities: string[]) {
      mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
      mockedResolveWorkspaceAccess.mockResolvedValue(grantedTeamAccess({ capabilities }));
      mockedGetProject.mockResolvedValue({ status: "found", project: { id: PROJECT_ID, workspaceId: WS_ID, name: "X", status: "active" } });
      const result: any = await callPage();
      return result.props.canStartResearch;
    }

    it("has BOTH research.create and research.organize -> canStartResearch: true", async () => {
      expect(await propsWithCapabilities(["workspace.read", "projects.read", "research.create", "research.organize"])).toBe(true);
    });

    it("has research.create but NOT research.organize -> canStartResearch: false (matches the exact server requirement for a Project-bound run)", async () => {
      expect(await propsWithCapabilities(["workspace.read", "projects.read", "research.create"])).toBe(false);
    });

    it("has neither -> canStartResearch: false", async () => {
      expect(await propsWithCapabilities(["workspace.read", "projects.read"])).toBe(false);
    });
  });

  describe("TEAM-VERIFICATION-PARITY-R5-I2 — canReadVideos derivation (research.read ALONE)", () => {
    async function videoHintFor(capabilities: string[]) {
      mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
      mockedResolveWorkspaceAccess.mockResolvedValue(grantedTeamAccess({ capabilities }));
      mockedGetProject.mockResolvedValue({ status: "found", project: { id: PROJECT_ID, workspaceId: WS_ID, name: "X", status: "active" } });
      const result: any = await callPage();
      return result.props.canReadVideos;
    }

    it("research.read alone is enough to READ the Project's Videos", async () => {
      expect(await videoHintFor(["workspace.read", "projects.read", "research.read"])).toBe(true);
    });

    it("research.organize is NOT required — a reader without it still reads Videos", async () => {
      // The R5-I1 Project list endpoint requires research.read only; requiring
      // organize here would hide a section the server would happily serve.
      expect(await videoHintFor(["workspace.read", "projects.read", "research.read"])).toBe(true);
      expect(await videoHintFor(["workspace.read", "projects.read", "research.read", "research.organize"])).toBe(true);
    });

    it("without research.read the section is not offered at all", async () => {
      expect(await videoHintFor(["workspace.read", "projects.read"])).toBe(false);
    });

    it("matches the Claims read hint exactly — both are research.read", async () => {
      mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
      mockedResolveWorkspaceAccess.mockResolvedValue(grantedTeamAccess({ capabilities: ["workspace.read", "projects.read", "research.read"] }));
      mockedGetProject.mockResolvedValue({ status: "found", project: { id: PROJECT_ID, workspaceId: WS_ID, name: "X", status: "active" } });
      const result: any = await callPage();
      expect(result.props.canReadVideos).toBe(result.props.canReadClaims);
    });
  });
});

describe("PR #164 review C1 — assignee presentation failure never crashes the detail page", () => {
  it("a rejecting name resolver ⇒ the page still renders, assignees degrade to the fallback label + stale (positive control: a healthy resolver names them)", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "owner-1" });
    mockedResolveWorkspaceAccess.mockResolvedValue({ granted: true, workspaceType: "team", workspace: { id: WS_ID, name: "Acme Team" }, membership: { role: "owner" }, capabilities: ["workspace.read", "projects.read", "research.read", "research.organize"] });
    mockedGetProject.mockResolvedValue({ status: "found", project: { id: PROJECT_ID, workspaceId: WS_ID, name: "ABC Acquisition", status: "active", assigneeUids: ["member-1"] } });
    mockedResolveWorkspaceReviewerDisplayNames.mockRejectedValueOnce(new Error("UNAVAILABLE"));
    const degraded: any = await callPage();
    expect(degraded.props.project.assignees).toEqual([{ uid: "member-1", displayName: "Unavailable reviewer", state: "stale" }]);
    mockedResolveWorkspaceReviewerDisplayNames.mockResolvedValueOnce(new Map([["member-1", "Bao"]]));
    const healthy: any = await callPage();
    expect(healthy.props.project.assignees[0].displayName).toBe("Bao");
  });
});
