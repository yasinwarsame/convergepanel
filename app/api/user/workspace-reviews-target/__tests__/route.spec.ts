/**
 * ZCA L-6 — `GET /api/user/workspace-reviews-target`: the former `/workspace/reviews` Server Component gate
 * (admission → cardinality → chooser or explicit/single Workspace → access + capabilities), on the bearer.
 * Ports every case of the former page spec.
 */
const mockResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({ resolveRequestIdentity: (...a: unknown[]) => mockResolveRequestIdentity(...a) }));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));
const mockSelection = jest.fn();
jest.mock("@/lib/workspaces/resolveViewerTeamWorkspaceSelection", () => ({ resolveViewerTeamWorkspaceSelection: (...a: unknown[]) => mockSelection(...a) }));
const mockAccess = jest.fn();
jest.mock("@/lib/workspaces/resolveTeamRunWorkspaceAccess", () => ({ resolveTeamRunWorkspaceAccess: (...a: unknown[]) => mockAccess(...a) }));
let approvalGlobal = false;
let approvalCanary: string | undefined = undefined;
jest.mock("@/lib/env", () => ({
  get APPROVAL_WORKFLOW_ENABLED() { return approvalGlobal; },
  get APPROVAL_WORKFLOW_CANARY_UIDS() { return approvalCanary; },
}));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/user/workspace-reviews-target/route";

const call = (workspace?: string) => GET(new NextRequest(`http://localhost/api/user/workspace-reviews-target${workspace === undefined ? "" : `?workspace=${encodeURIComponent(workspace)}`}`));
const authed = (uid = "u1") => mockResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid, source: "bearer_token" });
const granted = (name = "Acme", caps = ["research.read", "reviews.read"]) => ({ granted: true, workspace: { id: "x", name }, membership: { role: "member" }, capabilities: caps });

beforeEach(() => { jest.clearAllMocks(); approvalGlobal = true; approvalCanary = undefined; });

describe("gate", () => {
  it("unauthenticated → 401 regardless of every other flag; nothing discovered", async () => {
    mockResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "missing_credentials" });
    expect((await call()).status).toBe(401);
    expect(mockSelection).not.toHaveBeenCalled();
  });
  it("a verifier outage → 503", async () => {
    mockResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "auth_unavailable" });
    expect((await call()).status).toBe(503);
  });
  it("Approval Workflow not admitted → 404, never reaches discovery (cheapest gate first)", async () => {
    authed();
    approvalGlobal = false;
    expect((await call()).status).toBe(404);
    expect(mockSelection).not.toHaveBeenCalled();
  });
  it("SECURITY: canary present but the bearer's uid does not match → 404", async () => {
    authed("u2");
    approvalGlobal = false;
    approvalCanary = "u1";
    expect((await call()).status).toBe(404);
  });
  it("SECURITY: malformed canary that contains the uid, global off → 404 (control: well-formed admits)", async () => {
    authed("u1");
    approvalGlobal = false;
    mockSelection.mockResolvedValue({ kind: "single", workspaceId: "ws-a" });
    mockAccess.mockResolvedValue(granted());
    approvalCanary = "u1,not/a/valid/uid";
    expect((await call()).status).toBe(404);
    approvalCanary = "u1";
    expect((await call()).status).toBe(200);
  });
  it.each([["none"], ["lookup_failed"]])("discovery %s → 404 (fails closed, never fabricates a Workspace)", async (kind) => {
    authed();
    mockSelection.mockResolvedValue({ kind });
    expect((await call()).status).toBe(404);
    expect(mockAccess).not.toHaveBeenCalled();
  });
  it("single Workspace, access denied → 404", async () => {
    authed();
    mockSelection.mockResolvedValue({ kind: "single", workspaceId: "ws-a" });
    mockAccess.mockResolvedValue({ granted: false, reason: "membership_not_found" });
    expect((await call()).status).toBe(404);
  });
  it.each([["reviews.read", ["research.read"]], ["research.read", ["reviews.read"]]])("missing %s → 404", async (_m, caps) => {
    authed();
    mockSelection.mockResolvedValue({ kind: "single", workspaceId: "ws-a" });
    mockAccess.mockResolvedValue(granted("Acme", caps));
    expect((await call()).status).toBe(404);
  });
  it("every ineligible case answers the identical 404", async () => {
    authed();
    const bodies: string[] = [];
    approvalGlobal = false;
    bodies.push(await (await call()).text());
    approvalGlobal = true;
    mockSelection.mockResolvedValueOnce({ kind: "none" });
    bodies.push(await (await call()).text());
    mockSelection.mockResolvedValueOnce({ kind: "single", workspaceId: "ws-a" });
    mockAccess.mockResolvedValueOnce({ granted: false, reason: "membership_not_found" });
    bodies.push(await (await call()).text());
    expect(new Set(bodies).size).toBe(1);
  });
});

describe("targets", () => {
  it("single Workspace → queue for the DISCOVERED id, revalidated for the bearer's uid; hasMultipleWorkspaces false", async () => {
    authed("u-bearer");
    mockSelection.mockResolvedValue({ kind: "single", workspaceId: "ws-a" });
    mockAccess.mockResolvedValue(granted("Acme Research"));
    await expect((await call()).json()).resolves.toEqual({ ok: true, mode: "queue", workspaceId: "ws-a", workspaceName: "Acme Research", hasMultipleWorkspaces: false });
    expect(mockSelection).toHaveBeenCalledWith("u-bearer");
    expect(mockAccess).toHaveBeenCalledWith({ uid: "u-bearer", workspaceId: "ws-a" });
  });
  it("multiple Workspaces, no ?workspace= → the CHOOSER, and no Workspace is resolved", async () => {
    authed();
    mockSelection.mockResolvedValue({ kind: "multiple" });
    await expect((await call()).json()).resolves.toEqual({ ok: true, mode: "chooser" });
    expect(mockAccess).not.toHaveBeenCalled();
  });
  it.each([["ws-a"], ["ws-b"]])("multiple Workspaces, ?workspace=%s → that exact Workspace's queue, hasMultipleWorkspaces true", async (ws) => {
    authed();
    mockSelection.mockResolvedValue({ kind: "multiple" });
    mockAccess.mockResolvedValue(granted(`Name of ${ws}`));
    await expect((await call(ws)).json()).resolves.toEqual({ ok: true, mode: "queue", workspaceId: ws, workspaceName: `Name of ${ws}`, hasMultipleWorkspaces: true });
    expect(mockAccess).toHaveBeenCalledWith({ uid: "u1", workspaceId: ws });
  });
  it("SECURITY: member of A/B requests ?workspace=C (unauthorized) → 404, never falls back to A/B", async () => {
    authed();
    mockSelection.mockResolvedValue({ kind: "multiple" });
    mockAccess.mockImplementation(async ({ workspaceId }: { workspaceId: string }) => (workspaceId === "ws-c" ? { granted: false, reason: "membership_not_found" } : granted()));
    expect((await call("ws-c")).status).toBe(404);
    expect(mockAccess).toHaveBeenCalledTimes(1);
  });
  it("single Workspace, explicit ?workspace= for a DIFFERENT, unauthorized id → 404, never substitutes the discovered one", async () => {
    authed();
    mockSelection.mockResolvedValue({ kind: "single", workspaceId: "ws-a" });
    mockAccess.mockImplementation(async ({ workspaceId }: { workspaceId: string }) => (workspaceId === "ws-a" ? granted() : { granted: false, reason: "membership_not_found" }));
    expect((await call("ws-other")).status).toBe(404);
    expect(mockAccess).toHaveBeenCalledWith({ uid: "u1", workspaceId: "ws-other" });
  });
  it("private, no-store", async () => {
    authed();
    mockSelection.mockResolvedValue({ kind: "multiple" });
    expect((await call()).headers.get("Cache-Control")).toBe("private, no-store");
  });
});
