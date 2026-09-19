/**
 * TEAM-VERIFICATION-PARITY-R5-I3-B — the Unfiled Video creation address
 * `/workspace/team/{workspaceId}/videos/new`: Server Component gate.
 *
 * identity → Workspace access → Team type → `research.create`, with
 * `lookup_failed` throwing rather than concealing, and only the single
 * `audit.read` presentation hint crossing to the client.
 *
 * The capability asserted here is exactly the one the POST's Gate 1 and Gate 2
 * require, and deliberately NOT `research.organize`: this address can never
 * file into a Project.
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
jest.mock("@/components/workspace/videos/TeamVideoComposerShell", () => ({
  __esModule: true,
  default: () => require("react").createElement("div", { "data-testid": "team-video-composer-shell" }),
}));

import TeamUnfiledVideoCreatePage from "@/app/workspace/team/[workspaceId]/videos/new/page";

const CODE = readFileSync(join(__dirname, "..", "page.tsx"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/[^\n]*/g, "");

const WS_ID = "ws-1";
const UID = "uid-member";

const call = () => TeamUnfiledVideoCreatePage({ params: { workspaceId: WS_ID } });

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

function granted(capabilities = ["workspace.read", "research.read", "research.create"]) {
  return { granted: true, workspaceType: "team", workspace: { id: WS_ID, name: "Acme Team" }, membership: { role: "member" }, capabilities };
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

  it("conceals a reader who cannot create", async () => {
    mockedResolveWorkspaceAccess.mockResolvedValue(granted(["workspace.read", "research.read"]));
    await expectRealNotFound(call());
  });

  it("admits a member holding research.create", async () => {
    const props = await shellPropsOf();
    expect(props.workspaceId).toBe(WS_ID);
    expect(props.project).toBeNull();
  });

  it("does NOT require research.organize — this address never files", async () => {
    mockedResolveWorkspaceAccess.mockResolvedValue(granted(["workspace.read", "research.read", "research.create"]));
    await expect(call()).resolves.toBeTruthy();
    expect(CODE).not.toContain("research.organize");
  });

  it("resolves access for the authenticated uid and the addressed Workspace only", async () => {
    await call();
    expect(mockedResolveWorkspaceAccess).toHaveBeenCalledWith({ uid: UID, workspaceId: WS_ID });
  });
});

describe("what crosses to the client", () => {
  it("passes the server-resolved Workspace name and a single audit hint", async () => {
    const props = await shellPropsOf();
    expect(props.workspaceName).toBe("Acme Team");
    expect(props.showAudit).toBe(false);
  });

  it("turns the audit hint on only when audit.read is held", async () => {
    mockedResolveWorkspaceAccess.mockResolvedValue(granted(["workspace.read", "research.read", "research.create", "audit.read"]));
    expect((await shellPropsOf()).showAudit).toBe(true);
  });

  it("never sends the capability set, membership or uid to the client", async () => {
    const props = await shellPropsOf();
    expect(Object.keys(props).sort()).toEqual(["project", "showAudit", "workspaceId", "workspaceName"]);
    const blob = JSON.stringify(props);
    expect(blob).not.toContain(UID);
    expect(blob).not.toContain("research.create");
    expect(blob).not.toContain("membership");
  });
});

describe("source-level gate shape", () => {
  it("is dynamic, never cached", () => {
    expect(CODE).toContain('export const dynamic = "force-dynamic"');
  });

  it("performs no Firestore read of its own", () => {
    for (const forbidden of ["getProject", "adminDb", "firestore", "collection("]) {
      expect(CODE).not.toContain(forbidden);
    }
  });

  it("names no Project concept on the Unfiled address", () => {
    expect(CODE).not.toContain("projectId");
  });
});
