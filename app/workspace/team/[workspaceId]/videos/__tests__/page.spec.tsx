/**
 * TEAM-VERIFICATION-PARITY-R5-I2 §AN — the Workspace Videos address
 * `/workspace/team/{workspaceId}/videos`: Server Component gate.
 *
 * identity → Workspace access → Team type → `research.read`, with
 * `lookup_failed` throwing rather than concealing, and only the single
 * `audit.read` presentation hint crossing to the client.
 */

import { readFileSync } from "fs";
import { join } from "path";

const mockedResolveServerComponentIdentity = jest.fn();
jest.mock("@/lib/auth/resolveServerComponentIdentity", () => ({
  resolveServerComponentIdentity: (...args: unknown[]) => mockedResolveServerComponentIdentity(...args),
}));
const mockedResolveWorkspaceAccess = jest.fn();
jest.mock("@/lib/workspaces/resolveWorkspaceAccess", () => ({
  resolveWorkspaceAccess: (...args: unknown[]) => mockedResolveWorkspaceAccess(...args),
}));
jest.mock("@/components/workspace/videos/TeamWorkspaceVideosShell", () => ({
  __esModule: true,
  default: () => require("react").createElement("div", { "data-testid": "team-workspace-videos-shell" }),
}));

import TeamWorkspaceVideosPage from "@/app/workspace/team/[workspaceId]/videos/page";

const CODE = readFileSync(join(__dirname, "..", "page.tsx"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/[^\n]*/g, "");

const WS_ID = "ws-1";
const UID = "uid-member";

const call = () => TeamWorkspaceVideosPage({ params: { workspaceId: WS_ID } });

async function shellPropsOf(): Promise<Record<string, unknown>> {
  const el = (await call()) as unknown as { props: Record<string, unknown> };
  return el.props;
}

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
  mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
  mockedResolveWorkspaceAccess.mockResolvedValue(granted());
});

describe("gate", () => {
  it("conceals an unauthenticated visitor before any access lookup", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue(null);
    await expectRealNotFound(call());
    expect(mockedResolveWorkspaceAccess).not.toHaveBeenCalled();
  });

  it("throws on a transient lookup failure rather than concealing it", async () => {
    mockedResolveWorkspaceAccess.mockResolvedValue({ granted: false, reason: "lookup_failed" });
    await expect(call()).rejects.toThrow("Something went wrong while loading this page. Please try again.");
  });

  it.each([
    ["a non-member", { granted: false, reason: "not_a_member" }],
    ["a missing Workspace", { granted: false, reason: "not_found" }],
  ])("conceals %s", async (_label, access) => {
    mockedResolveWorkspaceAccess.mockResolvedValue(access);
    await expectRealNotFound(call());
  });

  it("conceals a Personal Workspace", async () => {
    mockedResolveWorkspaceAccess.mockResolvedValue({ ...granted(), workspaceType: "personal" });
    await expectRealNotFound(call());
  });

  it("conceals a member lacking research.read", async () => {
    mockedResolveWorkspaceAccess.mockResolvedValue(granted(["workspace.read", "projects.read"]));
    await expectRealNotFound(call());
  });

  it("renders the shell for a member holding research.read", async () => {
    const props = await shellPropsOf();
    expect(props.workspaceId).toBe(WS_ID);
    expect(props.workspaceName).toBe("Acme Team");
    expect(mockedResolveWorkspaceAccess).toHaveBeenCalledWith({ uid: UID, workspaceId: WS_ID });
  });

  it.each(["owner", "admin", "member", "reviewer", "viewer"])("role %s holding research.read is admitted", async (role) => {
    mockedResolveWorkspaceAccess.mockResolvedValue({ ...granted(), membership: { role } });
    await expect(shellPropsOf()).resolves.toBeTruthy();
  });

  it("performs NO Project lookup on this address", () => {
    expect(CODE).not.toContain("getProject");
  });
});

describe("what crosses to the client", () => {
  it("passes audit.read as the only capability-derived hint", async () => {
    expect((await shellPropsOf()).showAudit).toBe(false);
    mockedResolveWorkspaceAccess.mockResolvedValue(granted(["workspace.read", "research.read", "audit.read"]));
    expect((await shellPropsOf()).showAudit).toBe(true);
  });

  it("never hands the capability array, role or membership to the client", async () => {
    const props = await shellPropsOf();
    expect(Object.keys(props).sort()).toEqual(["canCreateVideo", "showAudit", "workspaceId", "workspaceName"]);
    expect(JSON.stringify(props)).not.toContain("research.read");
  });

  it("passes the create hint derived from research.create alone (R5-I3-B)", async () => {
    // Read access does NOT imply create access: this page admits `research.read`
    // but must hand the composer entry point only to a holder of
    // `research.create`.
    expect((await shellPropsOf()).canCreateVideo).toBe(false);
    mockedResolveWorkspaceAccess.mockResolvedValue(granted(["workspace.read", "research.read", "research.create"]));
    expect((await shellPropsOf()).canCreateVideo).toBe(true);
  });
});
