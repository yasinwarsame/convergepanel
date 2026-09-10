/**
 * PERSONAL-RESEARCH-URL-P0 — the read-AVAILABILITY contract for
 * `GET /api/user/runs/[runId]`.
 *
 * This endpoint is about to back a durable, bookmarkable Personal research URL.
 * Before this phase it answered "Run not found" (404) for three situations that
 * are not absence at all:
 *
 *   1. Firebase Admin unavailable — folded into the same branch as a blank run id;
 *   2. the initial `runs/{runId}.get()` throwing — no route-level boundary existed,
 *      so it escaped as an unhandled rejection rather than this route's contract;
 *   3. `validateRunWorkspaceAssociation()` returning `workspace_lookup_failed` —
 *      the integrity checker reporting it could not COMPLETE the lookup, collapsed
 *      in with genuinely invalid associations.
 *
 * Each is now a sanitized, retryable 500. CONFIRMED absence and CONFIRMED integrity
 * failures keep their concealed 404 exactly as before, and the Team branch's
 * deliberate `lookup_failed -> concealed 404` posture is asserted here precisely so
 * a Personal availability correction cannot silently change Team tenant-enumeration
 * behaviour.
 *
 * Mocking discipline: the route's REAL mapping is exercised throughout. Only the
 * boundaries are controlled — identity, the Firestore handle, the integrity checker
 * and the Team access resolver — and each test says which seam it is driving.
 */

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({
  resolveRequestIdentity: (...args: any[]) => mockedResolveRequestIdentity(...args),
}));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({
  logIdentityResolutionFailure: jest.fn(),
}));

const mockedRunGet = jest.fn();
/** Flipped to null by the adminDb-unavailable test only. */
let adminDbAvailable = true;
const mockAdminDb: any = {
  collection: () => ({ doc: () => ({ get: async () => mockedRunGet() }) }),
};
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return adminDbAvailable ? mockAdminDb : null;
  },
}));

jest.mock("@/lib/user/runDocumentToPublicResults", () => ({
  runDocumentToPublicResults: jest.fn().mockReturnValue([{ modelId: "chatgpt" }]),
}));
jest.mock("@/lib/panel/publicize", () => ({ publicizePanelResults: jest.fn() }));
jest.mock("@/lib/adaptiveSchema/persistedOutput", () => ({
  ...jest.requireActual("@/lib/adaptiveSchema/persistedOutput"),
  parsePersistedAdaptiveOutput: jest.fn().mockReturnValue({ ok: false, reason: "absent" }),
  parsePersistedLegacyAdaptiveOutput: jest.fn().mockReturnValue({ ok: false, reason: "absent" }),
}));
jest.mock("@/lib/adaptiveSchema/governanceRecordParser", () => ({
  ...jest.requireActual("@/lib/adaptiveSchema/governanceRecordParser"),
  parseGovernanceRecord: jest.fn().mockReturnValue({ ok: false, reason: "absent" }),
}));
jest.mock("@/lib/firestore/runs", () => ({ getAdaptiveHumanReviewAssignment: jest.fn().mockResolvedValue({ status: "absent" }) }));
jest.mock("@/lib/teams/teamApiAuth", () => ({ loadUserAndTeam: jest.fn() }));
jest.mock("@/lib/firestore/teamRuns", () => ({ getAdaptiveTeamRunProjection: jest.fn() }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

/** The integrity checker — the seam for the Personal availability case. */
const mockedValidateRunWorkspaceAssociation = jest.fn();
jest.mock("@/lib/workspaces/runWorkspaceIntegrity", () => ({
  validateRunWorkspaceAssociation: (...args: any[]) => mockedValidateRunWorkspaceAssociation(...args),
}));

/** The Team access resolver — the seam for the Team-concealment regression. */
const mockedResolveTeamRunWorkspaceAccess = jest.fn();
jest.mock("@/lib/workspaces/resolveTeamRunWorkspaceAccess", () => ({
  resolveTeamRunWorkspaceAccess: (...args: any[]) => mockedResolveTeamRunWorkspaceAccess(...args),
}));

jest.mock("@/lib/env", () => ({ WORKSPACES_ENABLED: true, TEAM_WORKSPACES_ENABLED: true, TEAM_WORKSPACES_CANARY_UIDS: undefined }));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/user/runs/[runId]/route";

const OWNER_UID = "owner-1";
const OTHER_UID = "other-1";
const RUN_ID = "run-1";
const PERSONAL_WORKSPACE_ID = "personal-owner-1";
const TEAM_WORKSPACE_ID = "aBcDeFgHiJkLmNoPqRsT";

function runDoc(overrides: Record<string, unknown> = {}) {
  return {
    exists: true,
    data: () => ({ userId: OWNER_UID, question: "Q", selectedModels: ["chatgpt"], status: "complete", ...overrides }),
  };
}

async function callRoute(runId = RUN_ID) {
  const res = await GET(new NextRequest(`http://localhost/api/user/runs/${runId}`), {
    params: Promise.resolve({ runId }),
  });
  const json = await res.json().catch(() => null);
  return { res, json };
}

beforeEach(() => {
  jest.clearAllMocks();
  adminDbAvailable = true;
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: OWNER_UID, source: "session_cookie" });
  // Default: a plain legacy Personal run with a valid association.
  mockedRunGet.mockResolvedValue(runDoc());
  mockedValidateRunWorkspaceAssociation.mockResolvedValue({ classification: "valid" });
});

describe("GET /api/user/runs/[runId] — availability vs absence", () => {
  it("T1 — authentication happens FIRST: an unauthenticated caller still gets 401 even when adminDb is unavailable, so it cannot probe infrastructure state", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "missing_credentials" });
    adminDbAvailable = false;
    const { res, json } = await callRoute();
    expect(res.status).toBe(401);
    expect(json.errorCode).toBe("unauthorized");
    expect(json.errorCode).not.toBe("internal_error");
    expect(mockedRunGet).not.toHaveBeenCalled();
  });

  it("T2 — a blank/whitespace run id remains a concealed 404: that is a confirmed non-existent address, not a failure", async () => {
    const { res, json } = await callRoute("   ");
    expect(res.status).toBe(404);
    expect(json.errorCode).toBe("not_found");
    expect(mockedRunGet).not.toHaveBeenCalled();
  });

  it("T3 — adminDb unavailable is a sanitized 500, no longer folded into the blank-run-id 404", async () => {
    adminDbAvailable = false;
    const { res, json } = await callRoute();
    expect(res.status).toBe(500);
    expect(json).toEqual({ ok: false, errorCode: "internal_error", message: "Something went wrong. Please try again." });
  });

  it("T4 — a THROWN initial run-document lookup is a sanitized 500, and the Firestore error never reaches the client", async () => {
    mockedRunGet.mockRejectedValue(new Error("SECRET_FIRESTORE_SENTINEL"));
    const { res, json } = await callRoute();
    expect(res.status).toBe(500);
    expect(json.errorCode).toBe("internal_error");
    expect(JSON.stringify(json)).not.toContain("SECRET_FIRESTORE_SENTINEL");
  });

  it("T5 — a lookup that SUCCEEDS and reports the run absent remains a concealed 404: confirmed absence is not failure", async () => {
    mockedRunGet.mockResolvedValue({ exists: false, data: () => undefined });
    const { res, json } = await callRoute();
    expect(res.status).toBe(404);
    expect(json.errorCode).toBe("not_found");
  });

  it("T6 — Personal `workspace_lookup_failed` is a sanitized 500: the integrity lookup could not complete, which is not an invalid association", async () => {
    mockedRunGet.mockResolvedValue(runDoc({ workspaceId: PERSONAL_WORKSPACE_ID }));
    mockedValidateRunWorkspaceAssociation.mockResolvedValue({ classification: "invalid", reason: "workspace_lookup_failed" });
    const { res, json } = await callRoute();
    expect(res.status).toBe(500);
    expect(json.errorCode).toBe("internal_error");
  });

  it("T7 — Personal `workspace_not_found` remains a concealed 404: a COMPLETED lookup proving the Workspace is gone", async () => {
    mockedRunGet.mockResolvedValue(runDoc({ workspaceId: PERSONAL_WORKSPACE_ID }));
    mockedValidateRunWorkspaceAssociation.mockResolvedValue({ classification: "invalid", reason: "workspace_not_found" });
    const { res, json } = await callRoute();
    expect(res.status).toBe(404);
    expect(json.errorCode).toBe("not_found");
  });

  it("T8 — every other confirmed Personal integrity failure remains a concealed 404, including the deliberate workspaces_disabled policy state", async () => {
    for (const reason of [
      "workspace_malformed",
      "malformed_workspace_id",
      "run_owner_invalid",
      "deterministic_id_mismatch",
      "workspace_wrong_type",
      "workspace_owner_mismatch",
      "workspaces_disabled",
    ]) {
      jest.clearAllMocks();
      mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: OWNER_UID, source: "session_cookie" });
      mockedRunGet.mockResolvedValue(runDoc({ workspaceId: PERSONAL_WORKSPACE_ID }));
      mockedValidateRunWorkspaceAssociation.mockResolvedValue({ classification: "invalid", reason });
      const { res, json } = await callRoute();
      expect(res.status).toBe(404);
      expect(json.errorCode).toBe("not_found");
    }
  });

  it("T9 — MANDATORY: the TEAM branch's `lookup_failed` stays a concealed 404. A Personal availability fix must not change Team tenant-enumeration posture", async () => {
    mockedRunGet.mockResolvedValue(runDoc({ workspaceId: TEAM_WORKSPACE_ID, userId: OTHER_UID }));
    mockedResolveTeamRunWorkspaceAccess.mockResolvedValue({ granted: false, reason: "lookup_failed" });
    const { res, json } = await callRoute();
    expect(mockedResolveTeamRunWorkspaceAccess).toHaveBeenCalled();
    expect(res.status).toBe(404);
    expect(json.errorCode).toBe("not_found");
    expect(res.status).not.toBe(500);
  });

  it("T10 — an ordinary valid Personal owner run still returns 200 with the existing success DTO", async () => {
    const { res, json } = await callRoute();
    expect(res.status).toBe(200);
    expect(json.ok).toBe(true);
    expect(json.question).toBe("Q");
    expect(json.results).toEqual([{ modelId: "chatgpt" }]);
    expect(json.viewerRole).toBeDefined();
  });

  it("T11 — a foreign Personal run preserves its existing denial, and is not reclassified as an availability failure", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: OTHER_UID, source: "session_cookie" });
    const { res, json } = await callRoute();
    expect([403, 404]).toContain(res.status);
    expect(json.errorCode).not.toBe("internal_error");
  });

  it("T12 — no transient response ever carries a Firestore error, Workspace id, or owner uid", async () => {
    // thrown lookup
    mockedRunGet.mockRejectedValue(new Error(`SENTINEL ${PERSONAL_WORKSPACE_ID} ${OWNER_UID}`));
    const thrown = await callRoute();
    // adminDb unavailable
    jest.clearAllMocks();
    mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: OWNER_UID, source: "session_cookie" });
    adminDbAvailable = false;
    const unavailable = await callRoute();
    // integrity lookup failure
    jest.clearAllMocks();
    adminDbAvailable = true;
    mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: OWNER_UID, source: "session_cookie" });
    mockedRunGet.mockResolvedValue(runDoc({ workspaceId: PERSONAL_WORKSPACE_ID }));
    mockedValidateRunWorkspaceAssociation.mockResolvedValue({ classification: "invalid", reason: "workspace_lookup_failed" });
    const integrity = await callRoute();

    for (const { json } of [thrown, unavailable, integrity]) {
      const body = JSON.stringify(json);
      expect(body).not.toContain("SENTINEL");
      expect(body).not.toContain(PERSONAL_WORKSPACE_ID);
      expect(body).not.toContain(OWNER_UID);
      expect(body).not.toMatch(/stack|FirebaseError|credential/i);
      expect(json).toEqual({ ok: false, errorCode: "internal_error", message: "Something went wrong. Please try again." });
    }
  });
});
