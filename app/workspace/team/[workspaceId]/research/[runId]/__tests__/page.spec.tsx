/**
 * TEAM-RESEARCH-PARITY-R3 §H/§W — the Unfiled Team research detail address
 * `/workspace/team/{workspaceId}/research/{runId}`: Server Component gate.
 * The `team.projectId === null` route containment lives in the shell and is
 * proven in `TeamResearchDetailShell.spec.tsx`.
 */

import { readFileSync } from "fs";
import { join } from "path";
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
jest.mock("@/lib/firestore/projects", () => ({ getProject: (...args: unknown[]) => mockedGetProject(...args) }));
const shellProps: Record<string, unknown>[] = [];
jest.mock("@/components/workspace/projects/TeamResearchDetailShell", () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    shellProps.push(props);
    return require("react").createElement("div", { "data-testid": "team-research-detail-shell" });
  },
}));

import TeamUnfiledResearchDetailPage from "@/app/workspace/team/[workspaceId]/research/[runId]/page";

const CODE = readFileSync(join(__dirname, "..", "page.tsx"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const WS_ID = "ws-1";
const RUN_ID = "run-unfiled-1";
const UID = "uid-member";

const call = () => TeamUnfiledResearchDetailPage({ params: { workspaceId: WS_ID, runId: RUN_ID } });

async function expectRealNotFound(promise: Promise<unknown>) {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect((caught as { digest?: string })?.digest).toBe("NEXT_NOT_FOUND");
}

function granted(capabilities = ["workspace.read", "research.read"]) {
  return { granted: true, workspaceType: "team", workspace: { id: WS_ID, name: "Acme Team" }, membership: { role: "viewer" }, capabilities };
}

beforeEach(() => {
  jest.clearAllMocks();
  shellProps.length = 0;
});

describe("TeamUnfiledResearchDetailPage — gate", () => {
  it("unauthenticated -> notFound, nothing rendered", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue(null);
    await expectRealNotFound(call());
    expect(mockedResolveWorkspaceAccess).not.toHaveBeenCalled();
    expect(shellProps).toHaveLength(0);
  });

  it.each(["membership_not_found", "membership_removed", "workspace_not_found", "team_workspaces_disabled"])("non-member / denied (%s) -> notFound", async (reason) => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue({ granted: false, reason });
    await expectRealNotFound(call());
    expect(shellProps).toHaveLength(0);
  });

  it("Personal Workspace type -> notFound", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue({ ...granted(), workspaceType: "personal" });
    await expectRealNotFound(call());
  });

  it("missing research.read -> notFound", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue(granted(["workspace.read", "projects.read"]));
    await expectRealNotFound(call());
    expect(shellProps).toHaveLength(0);
  });

  it("lookup_failed -> generic throw, never notFound", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue({ granted: false, reason: "lookup_failed" });
    await expect(call()).rejects.toThrow("Something went wrong while loading this page. Please try again.");
  });
});

describe("TeamUnfiledResearchDetailPage — renders the shell in Unfiled mode", () => {
  it("passes project=null (Unfiled address), the server-resolved Workspace name, the route runId and the audit hint", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue(granted(["workspace.read", "research.read", "audit.read"]));
    const element = await call();
    let r!: TestRenderer.ReactTestRenderer;
    await act(async () => {
      r = TestRenderer.create(element as never);
    });
    expect(r.root.findAllByProps({ "data-testid": "team-research-detail-shell" })).toHaveLength(1);
    expect(shellProps[0]).toEqual({ workspaceId: WS_ID, workspaceName: "Acme Team", runId: RUN_ID, project: null, showAudit: true, canVerifyClaim: false });
  });

  it("performs no Project lookup and no direct run read, and names no Personal endpoint or address", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
    mockedResolveWorkspaceAccess.mockResolvedValue(granted());
    await call();
    expect(mockedGetProject).not.toHaveBeenCalled();
    expect(CODE).not.toMatch(/getProject|getTeamWorkspaceRun|teamWorkspaceRuns/);
    expect(CODE).not.toMatch(/\/api\/user\/runs|\/workspace\/research\/|personalResearchHref/);
  });
});

describe("R4-I4 Verify-this-claim presentation hint", () => {
  it("is false without research.create, while the page stays readable", async () => {
    mockedResolveWorkspaceAccess.mockResolvedValue(granted(["workspace.read", "research.read"]));
    await act(async () => {
      TestRenderer.create((await call()) as never);
    });
    expect(shellProps).toHaveLength(1);
    expect(shellProps[0].canVerifyClaim).toBe(false);
  });

  it("is true with research.create — research.organize is NOT required on the Unfiled address", async () => {
    mockedResolveWorkspaceAccess.mockResolvedValue(granted(["workspace.read", "research.read", "research.create"]));
    await act(async () => {
      TestRenderer.create((await call()) as never);
    });
    expect(shellProps[0].canVerifyClaim).toBe(true);
  });

  it("never turns the action hint into a view gate", () => {
    expect(CODE).toContain('access.capabilities.includes("research.read")');
    expect(CODE).not.toMatch(/if \(!access\.capabilities\.includes\("research\.create"\)\)/);
  });
});
