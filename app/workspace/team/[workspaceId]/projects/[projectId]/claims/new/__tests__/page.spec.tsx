/**
 * TEAM-VERIFICATION-PARITY-R4-I3 §AI — the Project-bound Claim creation gate
 * `/workspace/team/{workspaceId}/projects/{projectId}/claims/new`.
 *
 * The Project the composer receives must come from the SERVER-resolved record,
 * never from the browser's path segment, and an archived Project is concealed
 * rather than offered as a dead-end form.
 */

import { readFileSync } from "fs";
import { join } from "path";

const mockedIdentity = jest.fn();
jest.mock("@/lib/auth/resolveServerComponentIdentity", () => ({ resolveServerComponentIdentity: (...a: unknown[]) => mockedIdentity(...a) }));
const mockedAccess = jest.fn();
jest.mock("@/lib/workspaces/resolveWorkspaceAccess", () => ({ resolveWorkspaceAccess: (...a: unknown[]) => mockedAccess(...a) }));
const mockedGetProject = jest.fn();
jest.mock("@/lib/firestore/projects", () => ({ getProject: (...a: unknown[]) => mockedGetProject(...a) }));
jest.mock("@/components/workspace/claims/TeamClaimComposerShell", () => ({
  __esModule: true,
  default: () => require("react").createElement("div", { "data-testid": "composer" }),
}));

import Page from "@/app/workspace/team/[workspaceId]/projects/[projectId]/claims/new/page";

const CODE = readFileSync(join(__dirname, "..", "page.tsx"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const WS = "ws-1";
const P = "proj-1";
const UID = "uid-member";
const call = () => Page({ params: { workspaceId: WS, projectId: P } });
const propsOf = async () => ((await call()) as unknown as { props: Record<string, unknown> }).props;

async function expectNotFound(p: Promise<unknown>) {
  let caught: unknown;
  try { await p; } catch (e) { caught = e; }
  expect((caught as { digest?: string })?.digest).toBe("NEXT_NOT_FOUND");
}

const granted = (capabilities: string[]) => ({ granted: true, workspaceType: "team", workspace: { id: WS, name: "Acme Team" }, membership: { role: "member" }, capabilities });
const FULL = ["workspace.read", "research.read", "research.create", "research.organize"];
const activeProject = (over: Record<string, unknown> = {}) => ({ status: "found", project: { id: P, name: "Launch Plan", workspaceId: WS, status: "active", ...over } });

beforeEach(() => {
  jest.clearAllMocks();
  mockedIdentity.mockResolvedValue({ uid: UID });
  mockedAccess.mockResolvedValue(granted(FULL));
  mockedGetProject.mockResolvedValue(activeProject());
});

describe("gate", () => {
  it("conceals an unauthenticated visitor", async () => {
    mockedIdentity.mockResolvedValue(null);
    await expectNotFound(call());
    expect(mockedAccess).not.toHaveBeenCalled();
  });

  it("throws on a transient Workspace lookup failure", async () => {
    mockedAccess.mockResolvedValue({ granted: false, reason: "lookup_failed" });
    await expect(call()).rejects.toThrow("Something went wrong while loading this page. Please try again.");
  });

  it("conceals a member lacking research.create", async () => {
    mockedAccess.mockResolvedValue(granted(["workspace.read", "research.read"]));
    await expectNotFound(call());
    expect(mockedGetProject).not.toHaveBeenCalled();
  });

  it("conceals a member lacking research.organize — filing needs it", async () => {
    mockedAccess.mockResolvedValue(granted(["workspace.read", "research.read", "research.create"]));
    await expectNotFound(call());
    expect(mockedGetProject).not.toHaveBeenCalled();
  });

  it.each([
    ["firestore_unavailable"],
    ["read_failed"],
  ])("throws on a Project read failure (%s)", async (status) => {
    mockedGetProject.mockResolvedValue({ status });
    await expect(call()).rejects.toThrow("Something went wrong while loading this page. Please try again.");
  });

  it("conceals a missing Project", async () => {
    mockedGetProject.mockResolvedValue({ status: "not_found" });
    await expectNotFound(call());
  });

  it("conceals a cross-Workspace Project", async () => {
    mockedGetProject.mockResolvedValue(activeProject({ workspaceId: "ws-other" }));
    await expectNotFound(call());
  });

  it("conceals an ARCHIVED Project rather than rendering a dead-end form", async () => {
    mockedGetProject.mockResolvedValue(activeProject({ status: "archived" }));
    await expectNotFound(call());
  });

  it("renders the composer for an active, contained Project", async () => {
    const props = await propsOf();
    expect(props.workspaceId).toBe(WS);
    expect(mockedGetProject).toHaveBeenCalledWith(P);
  });
});

describe("what crosses to the client", () => {
  it("passes the SERVER-resolved Project id and name", async () => {
    mockedGetProject.mockResolvedValue(activeProject({ name: "Server Resolved Name" }));
    const props = await propsOf();
    expect(props.project).toEqual({ id: P, name: "Server Resolved Name" });
  });

  it("passes only the four expected props, never capabilities", async () => {
    const props = await propsOf();
    expect(Object.keys(props).sort()).toEqual(["project", "showAudit", "workspaceId", "workspaceName"]);
    expect(JSON.stringify(props)).not.toContain("capabilities");
    expect(CODE).not.toMatch(/capabilities=\{/);
  });

  it("requires both creation capabilities in source", () => {
    expect(CODE).toContain('access.capabilities.includes("research.create")');
    expect(CODE).toContain('access.capabilities.includes("research.organize")');
    expect(CODE).toContain('projectResult.project.workspaceId !== params.workspaceId');
    expect(CODE).toContain('projectResult.project.status !== "active"');
  });
});
