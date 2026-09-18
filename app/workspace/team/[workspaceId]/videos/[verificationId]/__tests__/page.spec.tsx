/**
 * TEAM-VERIFICATION-PARITY-R5-I2 §AO — the Unfiled Team Video detail address
 * `/workspace/team/{workspaceId}/videos/{verificationId}`: Server Component gate.
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
jest.mock("@/components/workspace/videos/TeamVideoDetailShell", () => ({
  __esModule: true,
  default: () => require("react").createElement("div", { "data-testid": "team-video-detail-shell" }),
}));

import TeamUnfiledVideoDetailPage from "@/app/workspace/team/[workspaceId]/videos/[verificationId]/page";

const CODE = readFileSync(join(__dirname, "..", "page.tsx"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/[^\n]*/g, "");

const WS_ID = "ws-1";
const V = "vid-1";
const UID = "uid-member";

const call = () => TeamUnfiledVideoDetailPage({ params: { workspaceId: WS_ID, verificationId: V } });
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
  it("conceals an unauthenticated visitor", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue(null);
    await expectRealNotFound(call());
    expect(mockedResolveWorkspaceAccess).not.toHaveBeenCalled();
  });

  it("throws on a transient lookup failure", async () => {
    mockedResolveWorkspaceAccess.mockResolvedValue({ granted: false, reason: "lookup_failed" });
    await expect(call()).rejects.toThrow("Something went wrong while loading this page. Please try again.");
  });

  it.each([
    ["a non-member", { granted: false, reason: "not_a_member" }],
    ["a missing Workspace", { granted: false, reason: "not_found" }],
  ])("conceals %s", async (_l, access) => {
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

  it("renders the shell with a null Project for the Unfiled address", async () => {
    const props = await shellPropsOf();
    expect(props.verificationId).toBe(V);
    expect(props.project).toBeNull();
  });

  it("performs NO Project lookup on this address", () => {
    expect(CODE).not.toContain("getProject");
  });

  it("never reads the Video artifact itself in the Server Component", () => {
    for (const forbidden of ["adminDb", "videoVerifications", "authedFetch", "/api/"]) {
      expect(CODE).not.toContain(forbidden);
    }
  });

  it("passes audit.read as the only capability-derived hint", async () => {
    expect((await shellPropsOf()).showAudit).toBe(false);
    mockedResolveWorkspaceAccess.mockResolvedValue(granted(["workspace.read", "research.read", "audit.read"]));
    expect((await shellPropsOf()).showAudit).toBe(true);
  });

  it("never hands the capability array to the client", async () => {
    const props = await shellPropsOf();
    expect(Object.keys(props).sort()).toEqual(["project", "showAudit", "verificationId", "workspaceId", "workspaceName"]);
  });
});
