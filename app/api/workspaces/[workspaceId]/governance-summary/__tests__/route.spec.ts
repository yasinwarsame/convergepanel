/**
 * Step 6.3 — GET /api/workspaces/{workspaceId}/governance-summary.
 * audit.read is the ONLY capability gate (real ROLE_CAPABILITIES matrix), the
 * release flag defaults off and is concealed, and no Firestore work happens on
 * any denial path.
 */
let flag = true;
jest.mock("@/lib/env", () => ({
  get WORKSPACE_GOVERNANCE_SUMMARY_ENABLED() {
    return flag;
  },
}));
const mockedIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({ resolveRequestIdentity: (...a: unknown[]) => mockedIdentity(...a) }));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));
const mockedAccess = jest.fn();
jest.mock("@/lib/workspaces/resolveWorkspaceAuditAccess", () => ({ resolveWorkspaceAuditAccess: (...a: unknown[]) => mockedAccess(...a) }));
jest.mock("@/lib/firebase/admin", () => ({ adminDb: { marker: "db" } }));
const mockedLoad = jest.fn();
jest.mock("@/lib/governance/workspaceGovernanceSummaryFirestore", () => ({ loadWorkspaceGovernanceSummary: (...a: unknown[]) => mockedLoad(...a) }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() } }));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/workspaces/[workspaceId]/governance-summary/route";
import { ROLE_CAPABILITIES } from "@/lib/workspaces/capabilities";

const W = "ws-1";
const call = () => GET(new NextRequest(`http://localhost/api/workspaces/${W}/governance-summary`), { params: { workspaceId: W } });
const grant = (capabilities: readonly string[]) => ({ granted: true, capabilities });
const SUMMARY = { workspaceId: W, rows: [], totals: [], anomalies: [] };

beforeEach(() => {
  jest.clearAllMocks();
  flag = true;
  mockedIdentity.mockResolvedValue({ status: "authenticated", uid: "u1" });
  mockedAccess.mockResolvedValue(grant(ROLE_CAPABILITIES.owner));
  mockedLoad.mockResolvedValue({ ok: true, summary: SUMMARY });
});

it("unauthenticated → 401, no access lookup, no Firestore work", async () => {
  mockedIdentity.mockResolvedValue({ status: "unauthenticated", reason: "missing_credentials" });
  expect((await call()).status).toBe(401);
  expect(mockedAccess).not.toHaveBeenCalled();
  expect(mockedLoad).not.toHaveBeenCalled();
});

it("no admission → the audit route's concealed denial, no Firestore work", async () => {
  mockedAccess.mockResolvedValue({ granted: false, reason: "membership_not_found" });
  const res = await call();
  expect(res.status).toBe(404);
  expect(mockedLoad).not.toHaveBeenCalled();
});

it.each(Object.keys(ROLE_CAPABILITIES) as Array<keyof typeof ROLE_CAPABILITIES>)("role %s: allowed exactly when the real capability matrix grants audit.read", async (role) => {
  mockedAccess.mockResolvedValue(grant(ROLE_CAPABILITIES[role]));
  const res = await call();
  const allowed = ROLE_CAPABILITIES[role].includes("audit.read");
  expect(res.status).toBe(allowed ? 200 : 403);
  expect(mockedLoad).toHaveBeenCalledTimes(allowed ? 1 : 0);
});

it("the matrix at this SHA grants audit.read to owner and admin only (pinned)", () => {
  expect((Object.keys(ROLE_CAPABILITIES) as Array<keyof typeof ROLE_CAPABILITIES>).filter((r) => ROLE_CAPABILITIES[r].includes("audit.read")).sort()).toEqual(["admin", "owner"]);
});

it("audit.read is the ONLY capability gate: every other capability without it → 403; audit.read alone → 200", async () => {
  const everythingElse = Array.from(new Set(Object.values(ROLE_CAPABILITIES).flat())).filter((c) => c !== "audit.read");
  mockedAccess.mockResolvedValue(grant(everythingElse));
  expect((await call()).status).toBe(403);
  mockedAccess.mockResolvedValue(grant(["audit.read"]));
  expect((await call()).status).toBe(200);
});

it("flag off → concealed 404 AFTER authorization, and no Firestore work", async () => {
  flag = false;
  const res = await call();
  expect(res.status).toBe(404);
  expect(mockedLoad).not.toHaveBeenCalled();
  // concealment only after authorization: an unauthorized caller still gets 403, not a feature-state signal
  mockedAccess.mockResolvedValue(grant([]));
  expect((await call()).status).toBe(403);
});

it("authorized + flag on → 200 with the summary, for this Workspace only", async () => {
  const res = await call();
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true, summary: SUMMARY });
  expect(mockedLoad).toHaveBeenCalledWith({ marker: "db" }, W);
});

it("unreconcilable counts → 503, no numbers", async () => {
  mockedLoad.mockResolvedValue({ ok: false, reason: "inconsistent" });
  const res = await call();
  expect(res.status).toBe(503);
  expect(JSON.stringify(await res.json())).not.toContain("summary\":");
});

it("a count query failure (e.g. a missing index) → 500 internal error, nothing created", async () => {
  mockedLoad.mockRejectedValue(new Error("FAILED_PRECONDITION: The query requires an index"));
  expect((await call()).status).toBe(500);
});
