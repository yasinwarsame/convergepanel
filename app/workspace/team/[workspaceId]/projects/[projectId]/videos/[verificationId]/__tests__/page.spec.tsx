/**
 * TEAM-VERIFICATION-PARITY-R5-I2 §AO — the Project-filed Team Video detail
 * address `/workspace/team/{W}/projects/{P}/videos/{verificationId}`:
 * Server Component gate, including Project resolution and cross-Workspace
 * containment.
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
jest.mock("@/components/workspace/videos/TeamVideoDetailShell", () => ({
  __esModule: true,
  default: () => require("react").createElement("div", { "data-testid": "team-video-detail-shell" }),
}));

import TeamProjectVideoDetailPage from "@/app/workspace/team/[workspaceId]/projects/[projectId]/videos/[verificationId]/page";

const CODE = readFileSync(join(__dirname, "..", "page.tsx"), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/\/\/[^\n]*/g, "");

const WS_ID = "ws-1";
const P = "proj-1";
const V = "vid-1";
const UID = "uid-member";

const call = () => TeamProjectVideoDetailPage({ params: { workspaceId: WS_ID, projectId: P, verificationId: V } });
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
const foundProject = (over: Record<string, unknown> = {}) => ({
  status: "found",
  project: { id: P, workspaceId: WS_ID, name: "Launch Plan", status: "active", ...over },
});

beforeEach(() => {
  jest.clearAllMocks();
  mockedResolveServerComponentIdentity.mockResolvedValue({ uid: UID });
  mockedResolveWorkspaceAccess.mockResolvedValue(granted());
  mockedGetProject.mockResolvedValue(foundProject());
});

describe("Workspace gate precedes the Project lookup", () => {
  it("conceals an unauthenticated visitor before any lookup", async () => {
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

  it("conceals a member lacking research.read, without reading the Project", async () => {
    mockedResolveWorkspaceAccess.mockResolvedValue(granted(["workspace.read", "projects.read"]));
    await expectRealNotFound(call());
    expect(mockedGetProject).not.toHaveBeenCalled();
  });

  it("requires research.read, not projects.read", () => {
    expect(CODE).toContain('access.capabilities.includes("research.read")');
    expect(CODE).not.toContain('access.capabilities.includes("projects.read")');
  });
});

describe("Project resolution", () => {
  it.each(["not_found", "malformed"])("conceals a %s Project", async (status) => {
    mockedGetProject.mockResolvedValue({ status });
    await expectRealNotFound(call());
  });

  it.each(["firestore_unavailable", "read_failed"])("throws on a Project infrastructure failure (%s)", async (status) => {
    mockedGetProject.mockResolvedValue({ status });
    await expect(call()).rejects.toThrow("Something went wrong while loading this page. Please try again.");
  });

  it("conceals a cross-Workspace Project", async () => {
    mockedGetProject.mockResolvedValue(foundProject({ workspaceId: "ws-other" }));
    await expectRealNotFound(call());
  });

  it("renders the shell with the server-resolved Project", async () => {
    const props = await shellPropsOf();
    expect(props.project).toEqual({ id: P, name: "Launch Plan" });
    expect(props.verificationId).toBe(V);
    expect(mockedGetProject).toHaveBeenCalledWith(P);
  });

  it("an ARCHIVED Project stays readable", async () => {
    mockedGetProject.mockResolvedValue(foundProject({ status: "archived" }));
    const props = await shellPropsOf();
    expect(props.project).toEqual({ id: P, name: "Launch Plan" });
  });

  it("passes only the Project's id and name, never its full record", async () => {
    const props = await shellPropsOf();
    expect(Object.keys(props.project as object).sort()).toEqual(["id", "name"]);
  });
});

describe("boundaries", () => {
  it("never reads the Video artifact itself", () => {
    for (const forbidden of ["adminDb", "videoVerifications", "authedFetch", "/api/"]) {
      expect(CODE).not.toContain(forbidden);
    }
  });

  it("never hands the capability array to the client", async () => {
    const props = await shellPropsOf();
    expect(Object.keys(props).sort()).toEqual(["project", "showAudit", "verificationId", "workspaceId", "workspaceName"]);
  });

  it("passes audit.read as the only capability-derived hint", async () => {
    expect((await shellPropsOf()).showAudit).toBe(false);
    mockedResolveWorkspaceAccess.mockResolvedValue(granted(["workspace.read", "research.read", "audit.read"]));
    expect((await shellPropsOf()).showAudit).toBe(true);
  });
});
