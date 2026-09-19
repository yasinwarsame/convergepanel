/**
 * TEAM-VERIFICATION-PARITY-R5-I3-B — the Project-filed Video creation address
 * `/workspace/team/{workspaceId}/projects/{projectId}/videos/new`: Server
 * Component gate.
 *
 * identity → Workspace access → Team type → `research.create` →
 * `research.organize` → `getProject()` → exists → cross-Workspace containment →
 * `active`. Infra failures throw; every authorization outcome conceals.
 *
 * The browser's Project id is never the binding: this gate re-resolves the
 * Project server-side and hands the composer the resolved record.
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
const mockedGetProject = jest.fn();
jest.mock("@/lib/firestore/projects", () => ({ getProject: (...args: unknown[]) => mockedGetProject(...args) }));
jest.mock("@/components/workspace/videos/TeamVideoComposerShell", () => ({
  __esModule: true,
  default: () => require("react").createElement("div", { "data-testid": "team-video-composer-shell" }),
}));

import TeamProjectVideoCreatePage from "@/app/workspace/team/[workspaceId]/projects/[projectId]/videos/new/page";

const CODE = readFileSync(join(__dirname, "..", "page.tsx"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/[^\n]*/g, "");

const WS_ID = "ws-1";
const PROJ_ID = "proj-1";
const UID = "uid-member";

const call = () => TeamProjectVideoCreatePage({ params: { workspaceId: WS_ID, projectId: PROJ_ID } });

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

function granted(capabilities = ["workspace.read", "research.read", "research.create", "research.organize"]) {
  return { granted: true, workspaceType: "team", workspace: { id: WS_ID, name: "Acme Team" }, membership: { role: "admin" }, capabilities };
}
const foundProject = (over: Record<string, unknown> = {}) => ({
  status: "found",
  project: { id: PROJ_ID, name: "Apollo", workspaceId: WS_ID, status: "active", ...over },
});

beforeEach(() => {
  jest.clearAllMocks();
  mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
  mockedResolveWorkspaceAccess.mockResolvedValue(granted());
  mockedGetProject.mockResolvedValue(foundProject());
});

describe("gate", () => {
  it("conceals an unauthenticated visitor before any access or Project lookup", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue(null);
    await expectRealNotFound(call());
    expect(mockedResolveWorkspaceAccess).not.toHaveBeenCalled();
    expect(mockedGetProject).not.toHaveBeenCalled();
  });

  it("throws on a transient Workspace lookup failure", async () => {
    mockedResolveWorkspaceAccess.mockResolvedValue({ granted: false, reason: "lookup_failed" });
    await expect(call()).rejects.toThrow("Something went wrong while loading this page. Please try again.");
    expect(mockedGetProject).not.toHaveBeenCalled();
  });

  it.each([
    ["a non-member", { granted: false, reason: "not_a_member" }],
    ["a missing Workspace", { granted: false, reason: "not_found" }],
  ])("conceals %s without reading the Project", async (_label, access) => {
    mockedResolveWorkspaceAccess.mockResolvedValue(access);
    await expectRealNotFound(call());
    expect(mockedGetProject).not.toHaveBeenCalled();
  });

  it("conceals a Personal Workspace", async () => {
    mockedResolveWorkspaceAccess.mockResolvedValue({ ...granted(), workspaceType: "personal" });
    await expectRealNotFound(call());
  });

  it("conceals a member who cannot create", async () => {
    mockedResolveWorkspaceAccess.mockResolvedValue(granted(["workspace.read", "research.read"]));
    await expectRealNotFound(call());
    expect(mockedGetProject).not.toHaveBeenCalled();
  });

  it("conceals a creator who cannot organize — filing needs the extra capability", async () => {
    mockedResolveWorkspaceAccess.mockResolvedValue(granted(["workspace.read", "research.read", "research.create"]));
    await expectRealNotFound(call());
    expect(mockedGetProject).not.toHaveBeenCalled();
  });

  it.each([["firestore_unavailable"], ["read_failed"]])("throws on Project infra failure %s", async (status) => {
    mockedGetProject.mockResolvedValue({ status });
    await expect(call()).rejects.toThrow("Something went wrong while loading this page. Please try again.");
  });

  it("conceals a missing Project", async () => {
    mockedGetProject.mockResolvedValue({ status: "not_found" });
    await expectRealNotFound(call());
  });

  it("conceals a Project belonging to another Workspace — containment, not a picker", async () => {
    mockedGetProject.mockResolvedValue(foundProject({ workspaceId: "other-ws" }));
    await expectRealNotFound(call());
  });

  it("conceals an archived Project rather than offering a composer that cannot succeed", async () => {
    mockedGetProject.mockResolvedValue(foundProject({ status: "archived" }));
    await expectRealNotFound(call());
  });

  it("admits an organizer with an active, contained Project", async () => {
    const props = await shellPropsOf();
    expect(props.project).toEqual({ id: PROJ_ID, name: "Apollo" });
  });
});

describe("what crosses to the client", () => {
  it("hands the composer the SERVER-RESOLVED Project, not the URL value", async () => {
    mockedGetProject.mockResolvedValue(foundProject({ id: "canonical-id", name: "Renamed" }));
    const props = await shellPropsOf();
    expect(props.project).toEqual({ id: "canonical-id", name: "Renamed" });
  });

  it("passes no capability set, membership, uid or Project status", async () => {
    const props = await shellPropsOf();
    expect(Object.keys(props).sort()).toEqual(["project", "showAudit", "workspaceId", "workspaceName"]);
    const blob = JSON.stringify(props);
    expect(blob).not.toContain(UID);
    expect(blob).not.toContain("research.organize");
    expect(blob).not.toContain("archived");
    expect(blob).not.toContain("workspaceId\":\"" + WS_ID + "\",\"status");
  });
});

describe("source-level gate shape", () => {
  it("is dynamic, never cached", () => {
    expect(CODE).toContain('export const dynamic = "force-dynamic"');
  });

  it("requires BOTH create and organize", () => {
    expect(CODE).toContain('access.capabilities.includes("research.create")');
    expect(CODE).toContain('access.capabilities.includes("research.organize")');
  });

  it("checks containment and active status against the RESOLVED project", () => {
    expect(CODE).toContain("projectResult.project.workspaceId !== params.workspaceId");
    expect(CODE).toContain('projectResult.project.status !== "active"');
  });
});
