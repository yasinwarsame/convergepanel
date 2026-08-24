/**
 * Approval Workflow, Phase 9C.1 (corrected 9C.1-R1C) — GET /workspace/reviews
 * route gate. Mirrors `app/workspace/__tests__/page.spec.tsx`'s own
 * established pattern: calls the Server Component function directly and
 * asserts real `next/navigation` `notFound()` behavior (digest
 * `"NEXT_NOT_FOUND"`) rather than mocking `notFound` itself.
 *
 * Phase 9C.1-R1C adds the multi-Workspace matrix: `resolveViewerTeamWorkspaceId`
 * (which silently picked one Workspace) is replaced by
 * `resolveViewerTeamWorkspaceSelection`, a discriminated
 * `"none"/"single"/"multiple"` result the page must never collapse into a
 * silent choice.
 */

const mockedResolveServerComponentIdentity = jest.fn();
jest.mock("@/lib/auth/resolveServerComponentIdentity", () => ({
  resolveServerComponentIdentity: (...args: any[]) => mockedResolveServerComponentIdentity(...args),
}));

let approvalGlobal = false;
let approvalCanary: string | undefined = undefined;
jest.mock("@/lib/env", () => ({
  get APPROVAL_WORKFLOW_ENABLED() {
    return approvalGlobal;
  },
  get APPROVAL_WORKFLOW_CANARY_UIDS() {
    return approvalCanary;
  },
}));

const mockedResolveViewerTeamWorkspaceSelection = jest.fn();
jest.mock("@/lib/workspaces/resolveViewerTeamWorkspaceSelection", () => ({
  resolveViewerTeamWorkspaceSelection: (...args: any[]) => mockedResolveViewerTeamWorkspaceSelection(...args),
}));

const mockedResolveTeamRunWorkspaceAccess = jest.fn();
jest.mock("@/lib/workspaces/resolveTeamRunWorkspaceAccess", () => ({
  resolveTeamRunWorkspaceAccess: (...args: any[]) => mockedResolveTeamRunWorkspaceAccess(...args),
}));

jest.mock("@/components/workspace/WorkspaceReviewQueueShell", () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock("@/components/workspace/WorkspaceReviewsChooser", () => ({
  __esModule: true,
  default: () => null,
}));

import WorkspaceReviewsPage from "@/app/workspace/reviews/page";
import WorkspaceReviewQueueShell from "@/components/workspace/WorkspaceReviewQueueShell";
import WorkspaceReviewsChooser from "@/components/workspace/WorkspaceReviewsChooser";

function callPage(searchParams: Record<string, string | string[] | undefined> = {}) {
  return WorkspaceReviewsPage({ searchParams });
}

async function expectRealNotFound(promise: Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeDefined();
  expect(typeof caught).toBe("object");
  expect(caught).not.toBeNull();
  expect((caught as any)?.digest).toBe("NEXT_NOT_FOUND");
}

const GRANTED_ACCESS = { granted: true, capabilities: ["research.read", "reviews.read", "reviews.manage"], workspace: { name: "Acme Research" } };

beforeEach(() => {
  approvalGlobal = false;
  approvalCanary = undefined;
  jest.clearAllMocks();
});

describe("GET /workspace/reviews — route gate matrix", () => {
  it("unauthenticated -> real notFound(), regardless of every other flag", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue(null);
    approvalGlobal = true;
    await expectRealNotFound(callPage());
    expect(mockedResolveViewerTeamWorkspaceSelection).not.toHaveBeenCalled();
  });

  it("authenticated, Approval Workflow not admitted -> real notFound(), never reaches Team Workspace discovery (cheapest gate first)", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "u1" });
    await expectRealNotFound(callPage());
    expect(mockedResolveViewerTeamWorkspaceSelection).not.toHaveBeenCalled();
  });

  it("SECURITY: Approval Workflow admitted, canary present but uid does not match -> real notFound()", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "u2" });
    approvalCanary = "u1";
    await expectRealNotFound(callPage());
  });

  it("admitted, no discoverable Team Workspace -> real notFound()", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "u1" });
    approvalGlobal = true;
    mockedResolveViewerTeamWorkspaceSelection.mockResolvedValue({ kind: "none" });
    await expectRealNotFound(callPage());
    expect(mockedResolveTeamRunWorkspaceAccess).not.toHaveBeenCalled();
  });

  it("admitted, Team Workspace discovery lookup_failed -> real notFound(), fails closed (never fabricates a workspace)", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "u1" });
    approvalGlobal = true;
    mockedResolveViewerTeamWorkspaceSelection.mockResolvedValue({ kind: "lookup_failed" });
    await expectRealNotFound(callPage());
  });

  it("admitted, single Team Workspace but access denied -> real notFound()", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "u1" });
    approvalGlobal = true;
    mockedResolveViewerTeamWorkspaceSelection.mockResolvedValue({ kind: "single", workspaceId: "ws-1" });
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValue({ granted: false, reason: "membership_removed" });
    await expectRealNotFound(callPage());
  });

  it("admitted, access granted but missing reviews.read capability -> real notFound()", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "u1" });
    approvalGlobal = true;
    mockedResolveViewerTeamWorkspaceSelection.mockResolvedValue({ kind: "single", workspaceId: "ws-1" });
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValue({ granted: true, capabilities: ["research.read"], workspace: { name: "Acme" } });
    await expectRealNotFound(callPage());
  });

  it("admitted, access granted but missing research.read capability -> real notFound()", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "u1" });
    approvalGlobal = true;
    mockedResolveViewerTeamWorkspaceSelection.mockResolvedValue({ kind: "single", workspaceId: "ws-1" });
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValue({ granted: true, capabilities: ["reviews.read"], workspace: { name: "Acme" } });
    await expectRealNotFound(callPage());
  });

  it("fully eligible, single Workspace -> renders the queue shell, no notFound() thrown", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "u1" });
    approvalGlobal = true;
    mockedResolveViewerTeamWorkspaceSelection.mockResolvedValue({ kind: "single", workspaceId: "ws-1" });
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValue(GRANTED_ACCESS);
    const result = await callPage();
    expect(result).toBeTruthy();
  });

  it("eligible via canary (not global) -> renders the queue shell", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "canary-uid" });
    approvalCanary = "canary-uid";
    mockedResolveViewerTeamWorkspaceSelection.mockResolvedValue({ kind: "single", workspaceId: "ws-1" });
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValue(GRANTED_ACCESS);
    const result = await callPage();
    expect(result).toBeTruthy();
  });

  it("SECURITY: malformed canary config while global is off -> real notFound(), never falls open", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "u1" });
    approvalCanary = "not/a/valid/uid";
    await expectRealNotFound(callPage());
  });

  it("passes the discovered workspaceId (never a hardcoded/route-param value) to resolveTeamRunWorkspaceAccess and the rendered shell", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "u1" });
    approvalGlobal = true;
    mockedResolveViewerTeamWorkspaceSelection.mockResolvedValue({ kind: "single", workspaceId: "ws-discovered-42" });
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValue(GRANTED_ACCESS);
    await callPage();
    expect(mockedResolveTeamRunWorkspaceAccess).toHaveBeenCalledWith({ uid: "u1", workspaceId: "ws-discovered-42" });
  });
});

describe("GET /workspace/reviews — Phase 9C.1-R1C: multi-Workspace selection", () => {
  it("multiple active Workspaces, NO ?workspace= param -> renders the CHOOSER, never silently picks one", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "u1" });
    approvalGlobal = true;
    mockedResolveViewerTeamWorkspaceSelection.mockResolvedValue({ kind: "multiple" });
    const result: any = await callPage();
    expect(result.type).toBe(WorkspaceReviewsChooser);
    expect(mockedResolveTeamRunWorkspaceAccess).not.toHaveBeenCalled();
  });

  it("multiple active Workspaces, ?workspace=A -> revalidates and renders Workspace A's queue directly (no chooser)", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "u1" });
    approvalGlobal = true;
    mockedResolveViewerTeamWorkspaceSelection.mockResolvedValue({ kind: "multiple" });
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValue(GRANTED_ACCESS);
    const result: any = await callPage({ workspace: "A" });
    expect(mockedResolveTeamRunWorkspaceAccess).toHaveBeenCalledWith({ uid: "u1", workspaceId: "A" });
    expect(result.type).toBe(WorkspaceReviewQueueShell);
    expect(result.props.workspaceId).toBe("A");
    expect(result.props.hasMultipleWorkspaces).toBe(true);
  });

  it("multiple active Workspaces, ?workspace=B -> revalidates and renders Workspace B's queue, never falls back to A", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "u1" });
    approvalGlobal = true;
    mockedResolveViewerTeamWorkspaceSelection.mockResolvedValue({ kind: "multiple" });
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValue(GRANTED_ACCESS);
    await callPage({ workspace: "B" });
    expect(mockedResolveTeamRunWorkspaceAccess).toHaveBeenCalledWith({ uid: "u1", workspaceId: "B" });
  });

  it("SECURITY: user belongs to A/B, requests ?workspace=C (unauthorized) -> real notFound(), never falls back to A/B", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "u1" });
    approvalGlobal = true;
    mockedResolveViewerTeamWorkspaceSelection.mockResolvedValue({ kind: "multiple" });
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValue({ granted: false, reason: "membership_not_found" });
    await expectRealNotFound(callPage({ workspace: "C" }));
    expect(mockedResolveTeamRunWorkspaceAccess).toHaveBeenCalledWith({ uid: "u1", workspaceId: "C" });
  });

  it("single active Workspace, explicit ?workspace= for a DIFFERENT/unauthorized id -> real notFound(), never silently substitutes the single discovered Workspace", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "u1" });
    approvalGlobal = true;
    mockedResolveViewerTeamWorkspaceSelection.mockResolvedValue({ kind: "single", workspaceId: "ws-1" });
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValue({ granted: false, reason: "membership_not_found" });
    await expectRealNotFound(callPage({ workspace: "ws-other" }));
    expect(mockedResolveTeamRunWorkspaceAccess).toHaveBeenCalledWith({ uid: "u1", workspaceId: "ws-other" });
  });

  it("passes hasMultipleWorkspaces=false to the shell for a single-Workspace uid", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "u1" });
    approvalGlobal = true;
    mockedResolveViewerTeamWorkspaceSelection.mockResolvedValue({ kind: "single", workspaceId: "ws-1" });
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValue(GRANTED_ACCESS);
    const result: any = await callPage();
    expect(result.props.hasMultipleWorkspaces).toBe(false);
  });

  it("passes the resolved workspace name to the shell, never a raw id as the display value", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "u1" });
    approvalGlobal = true;
    mockedResolveViewerTeamWorkspaceSelection.mockResolvedValue({ kind: "single", workspaceId: "ws-1" });
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValue({ granted: true, capabilities: ["research.read", "reviews.read"], workspace: { name: "Real Workspace Name" } });
    const result: any = await callPage();
    expect(result.props.workspaceName).toBe("Real Workspace Name");
  });
});
