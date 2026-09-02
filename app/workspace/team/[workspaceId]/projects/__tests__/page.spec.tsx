/**
 * Team Projects UI, Phase 12A.2 — GET /workspace/team/{workspaceId}/projects
 * server-gate tests. Same technique as
 * `app/workspace/team/[workspaceId]/__tests__/page.spec.tsx`: calls the
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

jest.mock("@/components/workspace/projects/TeamProjectsShell", () => ({
  __esModule: true,
  default: (props: any) => ({ __mockShell: true, props }),
}));

import TeamProjectsPage from "@/app/workspace/team/[workspaceId]/projects/page";

const WS_ID = "ws-1";
const UID = "uid-owner";

function callPage() {
  return TeamProjectsPage({ params: { workspaceId: WS_ID } });
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

describe("TeamProjectsPage — gate (server-authoritative, UX-only re-check)", () => {
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

  it("granted Team role WITHOUT projects.read -> notFound, never renders the shell", async () => {
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

  it("Reviewer (projects.read but not projects.create) renders the shell with canCreateProject: false — Projects nav is a PERMANENT, read-accessible surface even without create rights", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue({
      granted: true,
      workspaceType: "team",
      workspace: { id: WS_ID, name: "Acme Team" },
      membership: { role: "reviewer" },
      capabilities: ["workspace.read", "projects.read", "research.read"],
    });
    const result: any = await callPage();
    expect(result.props.workspaceId).toBe(WS_ID);
    expect(result.props.workspaceName).toBe("Acme Team");
    expect(result.props.canCreateProject).toBe(false);
    expect(result.props.canReadAudit).toBe(false);
  });

  it("Owner (full capabilities) renders the shell with canCreateProject: true", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue({
      granted: true,
      workspaceType: "team",
      workspace: { id: WS_ID, name: "Acme Team" },
      membership: { role: "owner" },
      capabilities: ["workspace.read", "projects.read", "projects.create", "audit.read"],
    });
    const result: any = await callPage();
    expect(result.props.canCreateProject).toBe(true);
    expect(result.props.canReadAudit).toBe(true);
  });
});
