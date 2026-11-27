/**
 * ZCA L-6 — `GET /api/user/projects/[projectId]` (D-4 E-c): the former `/workspace/projects/[projectId]`
 * Server Component gate, in its order, on the bearer.
 */
const mockResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({ resolveRequestIdentity: (...a: unknown[]) => mockResolveRequestIdentity(...a) }));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));
const mockPersonalWorkspace = jest.fn();
jest.mock("@/lib/workspaces/resolvePersonalWorkspaceForOwner", () => ({ resolvePersonalWorkspaceForOwner: (...a: unknown[]) => mockPersonalWorkspace(...a) }));
const mockResolveProject = jest.fn();
jest.mock("@/lib/projects/resolveProjectForOwner", () => ({ resolveProjectForOwner: (...a: unknown[]) => mockResolveProject(...a) }));
const env: Record<string, unknown> = {};
jest.mock("@/lib/env", () => {
  const o: Record<string, unknown> = { ...jest.requireActual("@/lib/env") };
  for (const n of ["PROJECTS_UI_ENABLED", "PROJECTS_UI_CANARY_UIDS", "PROJECTS_ENABLED", "PROJECTS_CANARY_UIDS"]) Object.defineProperty(o, n, { get: () => env[n], enumerable: true });
  return o;
});
jest.mock("@/lib/firebase/admin", () => ({ adminDb: {}, adminAuth: {} }));
jest.mock("@/lib/logger", () => ({ logger: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() } }));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/user/projects/[projectId]/route";

const call = (projectId = "proj-1") => GET(new NextRequest(`http://localhost/api/user/projects/${projectId}`), { params: { projectId } });
const authed = (uid = "u1") => mockResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid, source: "bearer_token" });
const PROJECT = { id: "proj-1", name: "Q3 Market", status: "archived", ownerUserId: "u1", workspaceId: "w", createdAt: "x" };
beforeEach(() => {
  jest.clearAllMocks();
  Object.assign(env, { PROJECTS_UI_ENABLED: true, PROJECTS_ENABLED: true, PROJECTS_UI_CANARY_UIDS: undefined, PROJECTS_CANARY_UIDS: undefined });
  mockPersonalWorkspace.mockResolvedValue({ status: "found", workspace: { id: "w" } });
  mockResolveProject.mockResolvedValue({ status: "found", project: PROJECT, documentUpdateTime: { seconds: 1 } });
});

it("unauthenticated → 401, no Workspace or Project lookup", async () => {
  mockResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "missing_credentials" });
  expect((await call()).status).toBe(401);
  expect(mockPersonalWorkspace).not.toHaveBeenCalled();
  expect(mockResolveProject).not.toHaveBeenCalled();
});
it("a verifier outage → 503", async () => {
  mockResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "auth_unavailable" });
  expect((await call()).status).toBe(503);
});
it("Projects rollout ineligible → 404, no Workspace or Project lookup", async () => {
  authed();
  env.PROJECTS_ENABLED = false;
  expect((await call()).status).toBe(404);
  expect(mockPersonalWorkspace).not.toHaveBeenCalled();
  expect(mockResolveProject).not.toHaveBeenCalled();
});
it("no valid Personal workspace → 404, no Project lookup", async () => {
  authed();
  mockPersonalWorkspace.mockResolvedValue({ status: "malformed" });
  expect((await call()).status).toBe(404);
  expect(mockResolveProject).not.toHaveBeenCalled();
});
it("every concealed Project outcome answers the identical 404", async () => {
  authed();
  const bodies: string[] = [];
  for (const status of ["invalid_project_id", "not_found", "malformed", "workspace_mismatch", "workspaces_disabled", "workspace_missing"]) {
    mockResolveProject.mockResolvedValueOnce({ status });
    const res = await call();
    expect(res.status).toBe(404);
    bodies.push(await res.text());
  }
  mockPersonalWorkspace.mockResolvedValueOnce({ status: "not_found" });
  bodies.push(await (await call()).text());
  expect(new Set(bodies).size).toBe(1);
});
it("lookup_failed → 503, not concealed as non-existence", async () => {
  authed();
  mockResolveProject.mockResolvedValue({ status: "lookup_failed" });
  expect((await call()).status).toBe(503);
});
it("found (archived Projects are readable) → only { id, name, status }, never lifecycle/OCC fields", async () => {
  authed();
  await expect((await call()).json()).resolves.toEqual({ ok: true, project: { id: "proj-1", name: "Q3 Market", status: "archived" } });
});
it("SECURITY: resolves for the BEARER's uid and the route's projectId, unmodified", async () => {
  authed("u-bearer");
  await call("proj-%20x");
  expect(mockPersonalWorkspace).toHaveBeenCalledWith("u-bearer");
  expect(mockResolveProject).toHaveBeenCalledWith("u-bearer", "proj-%20x");
});
it("private, no-store", async () => {
  authed();
  expect((await call()).headers.get("Cache-Control")).toBe("private, no-store");
});
