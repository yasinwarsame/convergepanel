/**
 * Team Workspace Activation Flow, Phase 12A.1 — GET /workspace/team/{workspaceId}
 * server-gate tests. Same technique as
 * `app/workspace/team/[workspaceId]/audit/__tests__/page.spec.tsx`: calls
 * the Server Component function directly and asserts real
 * `next/navigation` `notFound()` behavior (digest `"NEXT_NOT_FOUND"`).
 */

const mockedResolveServerComponentIdentity = jest.fn();
jest.mock("@/lib/auth/resolveServerComponentIdentity", () => ({
  resolveServerComponentIdentity: (...args: any[]) => mockedResolveServerComponentIdentity(...args),
}));

const mockedResolveWorkspaceAccess = jest.fn();
jest.mock("@/lib/workspaces/resolveWorkspaceAccess", () => ({
  resolveWorkspaceAccess: (...args: any[]) => mockedResolveWorkspaceAccess(...args),
}));

jest.mock("@/components/workspace/WorkspaceOverviewShell", () => ({
  __esModule: true,
  default: (props: any) => ({ __mockShell: true, props }),
}));

import WorkspaceOverviewPage from "@/app/workspace/team/[workspaceId]/page";

const WS_ID = "ws-1";
const UID = "uid-owner";

function callPage() {
  return WorkspaceOverviewPage({ params: { workspaceId: WS_ID } });
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

describe("WorkspaceOverviewPage — gate (server-authoritative, UX-only re-check)", () => {
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

  it("any granted Team role (even with the fewest capabilities) renders the shell — Overview has no capability gate of its own, unlike Members/Audit", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue({
      granted: true,
      workspaceType: "team",
      workspace: { id: WS_ID, name: "Acme Team" },
      membership: { role: "viewer" },
      capabilities: ["workspace.read", "projects.read", "research.read"],
    });
    const result: any = await callPage();
    expect(result.props.workspaceId).toBe(WS_ID);
    expect(result.props.workspaceName).toBe("Acme Team");
    expect(result.props.canInvite).toBe(false);
    expect(result.props.canManageInvitations).toBe(false);
    expect(result.props.canReadAudit).toBe(false);
  });

  it("Owner (full capabilities) renders the shell with every capability flag true", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue({
      granted: true,
      workspaceType: "team",
      workspace: { id: WS_ID, name: "Acme Team" },
      membership: { role: "owner" },
      capabilities: ["workspace.read", "members.invite", "members.manage", "audit.read"],
    });
    const result: any = await callPage();
    expect(result.props.canInvite).toBe(true);
    expect(result.props.canManageInvitations).toBe(true);
    expect(result.props.canReadAudit).toBe(true);
  });
});
