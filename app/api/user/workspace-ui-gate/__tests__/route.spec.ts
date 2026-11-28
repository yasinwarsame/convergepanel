/**
 * ZCA L-6 — `GET /api/user/workspace-ui-gate?gate=…`: the per-uid rollout gates the former Personal
 * workspace Server Components decided (/workspace, /workspace/projects, /workspace/team, and the
 * signed-in check of /workspace/research/[runId]). The REAL rollout/eligibility functions run, with the
 * deployment flags mocked exactly as the former page specs did, so canary edge cases are the real ones.
 */
const mockResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({ resolveRequestIdentity: (...a: unknown[]) => mockResolveRequestIdentity(...a) }));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));
const mockPersonalWorkspace = jest.fn();
jest.mock("@/lib/workspaces/resolvePersonalWorkspaceForOwner", () => ({ resolvePersonalWorkspaceForOwner: (...a: unknown[]) => mockPersonalWorkspace(...a) }));

const env: Record<string, unknown> = {};
jest.mock("@/lib/env", () => {
  const names = ["PERSONAL_WORKSPACE_UI_ENABLED", "PERSONAL_WORKSPACE_UI_CANARY_UIDS", "TEAM_WORKSPACES_ENABLED", "TEAM_WORKSPACES_CANARY_UIDS", "PROJECTS_UI_ENABLED", "PROJECTS_UI_CANARY_UIDS", "PROJECTS_ENABLED", "PROJECTS_CANARY_UIDS"];
  const o: Record<string, unknown> = {};
  for (const n of names) Object.defineProperty(o, n, { get: () => env[n], enumerable: true });
  return o;
});

import { NextRequest } from "next/server";
import { GET } from "@/app/api/user/workspace-ui-gate/route";

const call = (gate: string | null) => GET(new NextRequest(`http://localhost/api/user/workspace-ui-gate${gate === null ? "" : `?gate=${gate}`}`));
const authed = (uid = "u1") => mockResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid, source: "bearer_token" });
const reset = () => {
  for (const k of Object.keys(env)) delete env[k];
  Object.assign(env, { PERSONAL_WORKSPACE_UI_ENABLED: false, TEAM_WORKSPACES_ENABLED: false, PROJECTS_UI_ENABLED: false, PROJECTS_ENABLED: false });
};
beforeEach(() => { jest.clearAllMocks(); reset(); mockPersonalWorkspace.mockResolvedValue({ status: "found", workspace: { id: "w" } }); });

describe("identity", () => {
  it.each(["personal_workspace", "team_workspaces", "projects", "signed_in"])("%s: unauthenticated → 401 whatever the flags", async (gate) => {
    Object.assign(env, { PERSONAL_WORKSPACE_UI_ENABLED: true, TEAM_WORKSPACES_ENABLED: true, PROJECTS_UI_ENABLED: true, PROJECTS_ENABLED: true });
    mockResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "missing_credentials" });
    expect((await call(gate)).status).toBe(401);
    expect(mockPersonalWorkspace).not.toHaveBeenCalled();
  });
  it("a verifier outage → 503", async () => {
    mockResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "auth_unavailable" });
    expect((await call("signed_in")).status).toBe(503);
  });
  it("an unknown or missing gate → 404", async () => {
    authed();
    expect((await call("everything")).status).toBe(404);
    expect((await call(null)).status).toBe(404);
  });
  it("signed_in: any authenticated identity → 200 (the research page's only check; not rollout-gated)", async () => {
    authed();
    expect((await call("signed_in")).status).toBe(200);
  });
});

describe.each([
  ["personal_workspace", "PERSONAL_WORKSPACE_UI_ENABLED", "PERSONAL_WORKSPACE_UI_CANARY_UIDS"],
  ["team_workspaces", "TEAM_WORKSPACES_ENABLED", "TEAM_WORKSPACES_CANARY_UIDS"],
])("%s (former /workspace and /workspace/team page gates)", (gate, globalName, canaryName) => {
  it("global off, non-canary → 404", async () => {
    authed("u1");
    expect((await call(gate)).status).toBe(404);
  });
  it("canary match → 200", async () => {
    authed("u1");
    env[canaryName] = "u1";
    expect((await call(gate)).status).toBe(200);
  });
  it("SECURITY: canary present but the BEARER's uid does not match → 404", async () => {
    authed("u2");
    env[canaryName] = "u1";
    expect((await call(gate)).status).toBe(404);
  });
  it("global on → 200 for any authenticated uid", async () => {
    authed("anyone");
    env[globalName] = true;
    expect((await call(gate)).status).toBe(200);
  });
  it("SECURITY: a malformed canary list that CONTAINS the caller's uid, global off → 404 (the whole list fails closed)", async () => {
    authed("u1");
    env[canaryName] = "u1,not/a/valid/uid";
    expect((await call(gate)).status).toBe(404);
    env[canaryName] = "u1"; // control: the same uid in a well-formed list is admitted
    expect((await call(gate)).status).toBe(200);
  });
});

describe("projects (former /workspace/projects page gate)", () => {
  const eligibleGlobally = () => Object.assign(env, { PROJECTS_UI_ENABLED: true, PROJECTS_ENABLED: true });
  it.each([
    ["UI on, backend off", { PROJECTS_UI_ENABLED: true }],
    ["backend on, UI off", { PROJECTS_ENABLED: true }],
    ["neither", {}],
  ])("ineligible (%s) → 404 with no Workspace lookup", async (_n, flags) => {
    authed();
    Object.assign(env, flags);
    expect((await call("projects")).status).toBe(404);
    expect(mockPersonalWorkspace).not.toHaveBeenCalled();
  });
  it("SECURITY: UI canary hit but backend canary miss → 404, no Workspace lookup", async () => {
    authed("u1");
    Object.assign(env, { PROJECTS_UI_CANARY_UIDS: "u1", PROJECTS_CANARY_UIDS: "u9" });
    expect((await call("projects")).status).toBe(404);
    expect(mockPersonalWorkspace).not.toHaveBeenCalled();
  });
  it("both eligible via matching canaries + a Personal workspace → 200", async () => {
    authed("u1");
    Object.assign(env, { PROJECTS_UI_CANARY_UIDS: "u1", PROJECTS_CANARY_UIDS: "u1" });
    expect((await call("projects")).status).toBe(200);
  });
  it("eligible: the Personal workspace is resolved for the BEARER's uid", async () => {
    authed("u-bearer");
    eligibleGlobally();
    await call("projects");
    expect(mockPersonalWorkspace).toHaveBeenCalledWith("u-bearer");
  });
  it("every non-found Workspace outcome (incl. lookup_failed) → the identical 404", async () => {
    authed();
    eligibleGlobally();
    const bodies: string[] = [];
    for (const status of ["workspaces_disabled", "invalid_uid", "not_found", "malformed", "wrong_owner", "wrong_type", "lookup_failed"]) {
      mockPersonalWorkspace.mockResolvedValueOnce({ status });
      const res = await call("projects");
      expect(res.status).toBe(404);
      bodies.push(await res.text());
    }
    expect(new Set(bodies).size).toBe(1);
  });
});

it("every answer is private, no-store", async () => {
  authed();
  expect((await call("signed_in")).headers.get("Cache-Control")).toBe("private, no-store");
  expect((await call("projects")).headers.get("Cache-Control")).toBe("private, no-store");
});
