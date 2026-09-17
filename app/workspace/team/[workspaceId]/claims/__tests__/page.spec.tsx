/**
 * TEAM-VERIFICATION-PARITY-R4-I2 §AG — the Workspace Claims address
 * `/workspace/team/{workspaceId}/claims`: Server Component gate.
 *
 * Mirrors the Team research detail gate spec: identity → Workspace access →
 * Team type → `research.read`, with `lookup_failed` throwing rather than
 * concealing, and only the single `audit.read` presentation hint crossing to
 * the client.
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
jest.mock("@/components/workspace/claims/TeamWorkspaceClaimsShell", () => ({
  __esModule: true,
  default: () => require("react").createElement("div", { "data-testid": "team-workspace-claims-shell" }),
}));

import TeamWorkspaceClaimsPage from "@/app/workspace/team/[workspaceId]/claims/page";

const CODE = readFileSync(join(__dirname, "..", "page.tsx"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/[^\n]*/g, "");

const WS_ID = "ws-1";
const UID = "uid-member";

const call = () => TeamWorkspaceClaimsPage({ params: { workspaceId: WS_ID } });

/** The props the Server Component hands to the client shell. */
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
    const el = (await call()) as unknown as { props: Record<string, unknown> };
    expect(el).toBeTruthy();
    expect(el.props.workspaceId).toBe(WS_ID);
    expect(mockedResolveWorkspaceAccess).toHaveBeenCalledWith({ uid: UID, workspaceId: WS_ID });
  });

  it("resolves access from the server identity, never from the URL alone", () => {
    expect(CODE).toContain("resolveServerComponentIdentity");
    expect(CODE).toContain("uid: identity.uid");
  });
});

describe("what crosses to the client", () => {
  it("passes only the Workspace id, name and the audit.read hint", async () => {
    const props = await shellPropsOf();
    expect(Object.keys(props).sort()).toEqual(["showAudit", "workspaceId", "workspaceName"]);
    expect(props.workspaceId).toBe(WS_ID);
    expect(props.workspaceName).toBe("Acme Team");
  });

  it("derives showAudit from the server capability set", async () => {
    mockedResolveWorkspaceAccess.mockResolvedValue(granted(["workspace.read", "research.read", "audit.read"]));
    expect((await shellPropsOf()).showAudit).toBe(true);

    mockedResolveWorkspaceAccess.mockResolvedValue(granted(["workspace.read", "research.read"]));
    expect((await shellPropsOf()).showAudit).toBe(false);
  });

  it("never hands the capability array or membership to the client", async () => {
    const serialized = JSON.stringify(await shellPropsOf());
    expect(serialized).not.toContain("capabilities");
    expect(serialized).not.toContain("membership");
    expect(serialized).not.toContain("viewer");
    expect(CODE).not.toMatch(/capabilities=\{/);
  });

  it("requires research.read, the same capability the R3 list endpoints enforce", () => {
    expect(CODE).toContain('access.capabilities.includes("research.read")');
  });
});
