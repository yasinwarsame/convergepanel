/**
 * Approval Workflow, Phase 9C.1 — GET /workspace/reviews route gate.
 * Mirrors `app/workspace/__tests__/page.spec.tsx`'s own established
 * pattern: calls the Server Component function directly and asserts real
 * `next/navigation` `notFound()` behavior (digest `"NEXT_NOT_FOUND"`)
 * rather than mocking `notFound` itself.
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

const mockedResolveViewerTeamWorkspaceId = jest.fn();
jest.mock("@/lib/workspaces/resolveViewerTeamWorkspaceId", () => ({
  resolveViewerTeamWorkspaceId: (...args: any[]) => mockedResolveViewerTeamWorkspaceId(...args),
}));

const mockedResolveTeamRunWorkspaceAccess = jest.fn();
jest.mock("@/lib/workspaces/resolveTeamRunWorkspaceAccess", () => ({
  resolveTeamRunWorkspaceAccess: (...args: any[]) => mockedResolveTeamRunWorkspaceAccess(...args),
}));

jest.mock("@/components/workspace/WorkspaceReviewQueueShell", () => ({
  __esModule: true,
  default: () => "WORKSPACE_REVIEW_QUEUE_SHELL_RENDERED_MARKER",
}));

import WorkspaceReviewsPage from "@/app/workspace/reviews/page";

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

const GRANTED_ACCESS = { granted: true, capabilities: ["research.read", "reviews.read", "reviews.manage"] };

beforeEach(() => {
  approvalGlobal = false;
  approvalCanary = undefined;
  jest.clearAllMocks();
});

describe("GET /workspace/reviews — route gate matrix", () => {
  it("unauthenticated -> real notFound(), regardless of every other flag", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue(null);
    approvalGlobal = true;
    await expectRealNotFound(WorkspaceReviewsPage());
    expect(mockedResolveViewerTeamWorkspaceId).not.toHaveBeenCalled();
  });

  it("authenticated, Approval Workflow not admitted -> real notFound(), never reaches Team Workspace discovery (cheapest gate first)", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "u1" });
    await expectRealNotFound(WorkspaceReviewsPage());
    expect(mockedResolveViewerTeamWorkspaceId).not.toHaveBeenCalled();
  });

  it("SECURITY: Approval Workflow admitted, canary present but uid does not match -> real notFound()", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "u2" });
    approvalCanary = "u1";
    await expectRealNotFound(WorkspaceReviewsPage());
  });

  it("admitted, no discoverable Team Workspace -> real notFound()", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "u1" });
    approvalGlobal = true;
    mockedResolveViewerTeamWorkspaceId.mockResolvedValue({ status: "not_found" });
    await expectRealNotFound(WorkspaceReviewsPage());
    expect(mockedResolveTeamRunWorkspaceAccess).not.toHaveBeenCalled();
  });

  it("admitted, Team Workspace discovery lookup_failed -> real notFound(), fails closed (never fabricates a workspace)", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "u1" });
    approvalGlobal = true;
    mockedResolveViewerTeamWorkspaceId.mockResolvedValue({ status: "lookup_failed" });
    await expectRealNotFound(WorkspaceReviewsPage());
  });

  it("admitted, Team Workspace found but access denied -> real notFound()", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "u1" });
    approvalGlobal = true;
    mockedResolveViewerTeamWorkspaceId.mockResolvedValue({ status: "found", workspaceId: "ws-1" });
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValue({ granted: false, reason: "membership_removed" });
    await expectRealNotFound(WorkspaceReviewsPage());
  });

  it("admitted, access granted but missing reviews.read capability -> real notFound()", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "u1" });
    approvalGlobal = true;
    mockedResolveViewerTeamWorkspaceId.mockResolvedValue({ status: "found", workspaceId: "ws-1" });
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValue({ granted: true, capabilities: ["research.read"] });
    await expectRealNotFound(WorkspaceReviewsPage());
  });

  it("admitted, access granted but missing research.read capability -> real notFound()", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "u1" });
    approvalGlobal = true;
    mockedResolveViewerTeamWorkspaceId.mockResolvedValue({ status: "found", workspaceId: "ws-1" });
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValue({ granted: true, capabilities: ["reviews.read"] });
    await expectRealNotFound(WorkspaceReviewsPage());
  });

  it("fully eligible -> renders the queue shell, no notFound() thrown", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "u1" });
    approvalGlobal = true;
    mockedResolveViewerTeamWorkspaceId.mockResolvedValue({ status: "found", workspaceId: "ws-1" });
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValue(GRANTED_ACCESS);
    const result = await WorkspaceReviewsPage();
    expect(result).toBeTruthy();
  });

  it("eligible via canary (not global) -> renders the queue shell", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "canary-uid" });
    approvalCanary = "canary-uid";
    mockedResolveViewerTeamWorkspaceId.mockResolvedValue({ status: "found", workspaceId: "ws-1" });
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValue(GRANTED_ACCESS);
    const result = await WorkspaceReviewsPage();
    expect(result).toBeTruthy();
  });

  it("SECURITY: malformed canary config while global is off -> real notFound(), never falls open", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "u1" });
    approvalCanary = "not/a/valid/uid";
    await expectRealNotFound(WorkspaceReviewsPage());
  });

  it("passes the discovered workspaceId (never a hardcoded/route-param value) to resolveTeamRunWorkspaceAccess and the rendered shell", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "u1" });
    approvalGlobal = true;
    mockedResolveViewerTeamWorkspaceId.mockResolvedValue({ status: "found", workspaceId: "ws-discovered-42" });
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValue(GRANTED_ACCESS);
    await WorkspaceReviewsPage();
    expect(mockedResolveTeamRunWorkspaceAccess).toHaveBeenCalledWith({ uid: "u1", workspaceId: "ws-discovered-42" });
  });
});
