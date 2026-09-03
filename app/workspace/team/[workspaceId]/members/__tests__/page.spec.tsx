/**
 * Team Workspace Self-Service Onboarding — GET /workspace/team/{workspaceId}/members
 * server-gate tests. Same technique as
 * `app/workspace/team/[workspaceId]/audit/__tests__/page.spec.tsx`: calls
 * the Server Component function directly and asserts real
 * `next/navigation` `notFound()` behavior (digest `"NEXT_NOT_FOUND"`).
 *
 * Added alongside the transient-vs-genuine-denial fix (see
 * `app/workspace/team/[workspaceId]/members/page.tsx`'s gate): this page
 * had no dedicated test file before this change.
 */

const mockedResolveServerComponentIdentity = jest.fn();
jest.mock("@/lib/auth/resolveServerComponentIdentity", () => ({
  resolveServerComponentIdentity: (...args: any[]) => mockedResolveServerComponentIdentity(...args),
}));

const mockedResolveWorkspaceAccess = jest.fn();
jest.mock("@/lib/workspaces/resolveWorkspaceAccess", () => ({
  resolveWorkspaceAccess: (...args: any[]) => mockedResolveWorkspaceAccess(...args),
}));

jest.mock("@/components/workspace/WorkspaceMembersShell", () => ({
  __esModule: true,
  default: (props: any) => ({ __mockShell: true, props }),
}));

import WorkspaceMembersPage from "@/app/workspace/team/[workspaceId]/members/page";

const WS_ID = "ws-1";
const UID = "uid-owner";

function callPage() {
  return WorkspaceMembersPage({ params: { workspaceId: WS_ID } });
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

describe("WorkspaceMembersPage — gate (server-authoritative, UX-only re-check)", () => {
  it("unauthenticated -> notFound", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue(null);
    await expectRealNotFound(callPage());
    expect(mockedResolveWorkspaceAccess).not.toHaveBeenCalled();
  });

  it("resolveWorkspaceAccess denies -> notFound", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue({ granted: false, reason: "membership_not_found" });
    await expectRealNotFound(callPage());
  });

  it("wrong workspace type (Personal) -> notFound", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue({ granted: true, workspaceType: "personal", workspace: { id: WS_ID, name: "Personal" } });
    await expectRealNotFound(callPage());
  });

  it("granted Team role WITHOUT members.read -> notFound, never renders the shell", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue({
      granted: true,
      workspaceType: "team",
      workspace: { id: WS_ID, name: "Acme Team" },
      membership: { role: "member" },
      capabilities: ["workspace.read"],
    });
    await expectRealNotFound(callPage());
  });

  it("Owner (members.read present) -> renders WorkspaceMembersShell with the correct workspaceId/workspaceName/callerRole", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue({
      granted: true,
      workspaceType: "team",
      workspace: { id: WS_ID, name: "Acme Team" },
      membership: { role: "owner" },
      capabilities: ["members.read", "members.invite", "members.manage", "audit.read"],
    });
    const result: any = await callPage();
    expect(result.props.workspaceId).toBe(WS_ID);
    expect(result.props.workspaceName).toBe("Acme Team");
    expect(result.props.callerRole).toBe("owner");
    expect(result.props.canInvite).toBe(true);
    expect(result.props.canManageInvitations).toBe(true);
    expect(result.props.canReadAudit).toBe(true);
  });

  it("resolveWorkspaceAccess returns lookup_failed -> throws generic Error, NOT notFound()", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue({ granted: false, reason: "lookup_failed" });
    await expect(callPage()).rejects.toThrow("Something went wrong while loading this page. Please try again.");
  });
});
