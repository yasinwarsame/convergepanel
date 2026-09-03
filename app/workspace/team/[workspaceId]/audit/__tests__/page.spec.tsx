/**
 * Workspace Audit Log, Phase TEAM-GOV-I1 — GET /workspace/team/{workspaceId}/audit
 * server-gate tests. Same technique as
 * `app/workspace/reviews/[runId]/__tests__/page.spec.tsx`: calls the
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

jest.mock("@/components/workspace/WorkspaceAuditLogShell", () => ({
  __esModule: true,
  default: (props: any) => ({ __mockShell: true, props }),
}));

import WorkspaceAuditLogPage from "@/app/workspace/team/[workspaceId]/audit/page";

const WS_ID = "ws-1";
const UID = "uid-owner";

function callPage() {
  return WorkspaceAuditLogPage({ params: { workspaceId: WS_ID } });
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

beforeEach(() => {
  jest.clearAllMocks();
});

describe("WorkspaceAuditLogPage — gate (server-authoritative, UX-only re-check)", () => {
  it("H (page-level). unauthenticated -> notFound", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue(null);
    await expectRealNotFound(callPage());
    expect(mockedResolveWorkspaceAccess).not.toHaveBeenCalled();
  });

  it("I (page-level). resolveWorkspaceAccess denies -> notFound", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue({ granted: false, reason: "membership_not_found" });
    await expectRealNotFound(callPage());
  });

  it("wrong workspace type (Personal) -> notFound", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue({ granted: true, workspaceType: "personal", workspace: { id: WS_ID, name: "Personal" } });
    await expectRealNotFound(callPage());
  });

  it("AC. Member/Reviewer/Viewer (granted but no audit.read) -> notFound, never renders the shell", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue({
      granted: true,
      workspaceType: "team",
      workspace: { id: WS_ID, name: "Acme Team" },
      membership: { role: "member" },
      capabilities: ["workspace.read", "projects.read"],
    });
    await expectRealNotFound(callPage());
  });

  it("Z/AA. Owner/Admin (audit.read present) -> renders WorkspaceAuditLogShell with the correct workspaceId/workspaceName", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue({
      granted: true,
      workspaceType: "team",
      workspace: { id: WS_ID, name: "Acme Team" },
      membership: { role: "owner" },
      capabilities: ["audit.read", "workspace.read"],
    });
    const result: any = await callPage();
    expect(result.props.workspaceId).toBe(WS_ID);
    expect(result.props.workspaceName).toBe("Acme Team");
  });

  it("resolveWorkspaceAccess returns lookup_failed -> throws generic Error, NOT notFound()", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue({ granted: false, reason: "lookup_failed" });
    await expect(callPage()).rejects.toThrow("Something went wrong while loading this page. Please try again.");
  });
});
