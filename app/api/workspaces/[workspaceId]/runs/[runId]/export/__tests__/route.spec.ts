/**
 * TEAM_EXPORT_E1 — `POST /api/workspaces/{workspaceId}/runs/{runId}/export`.
 *
 * Identity, the Team run access resolver, entitlements, the renderer, the
 * export-record writers, the generated-by resolver and the audit writer are
 * mocked at their module boundaries. The capability matrix, the row
 * validator, the response family, the snapshot builder and the export
 * verdict are REAL — the authority decisions this slice exists to make are
 * never stubbed.
 *
 * The Firestore fake is PATH-AWARE and throws on any path the test did not
 * configure, so a mis-pathed read can never silently resolve to the run
 * document (the false-positive shape found in the PR #188/#189 harnesses).
 */

/** The export surface is flag-gated; these mirror the Personal export spec's own getter idiom so a single test can flip them. DOCX/JSON stay OFF so "a real but disabled format" is genuinely disabled here. */
let mockExportFlagEnabled = true;
const mockDocxFlagEnabled = false;
const mockJsonFlagEnabled = false;
jest.mock("@/lib/env", () => ({
  get ADAPTIVE_RESEARCH_EXPORT_ENABLED() {
    return mockExportFlagEnabled;
  },
  get ADAPTIVE_RESEARCH_DOCX_EXPORT_ENABLED() {
    return mockDocxFlagEnabled;
  },
  get ADAPTIVE_RESEARCH_JSON_EXPORT_ENABLED() {
    return mockJsonFlagEnabled;
  },
}));

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({ resolveRequestIdentity: (...a: unknown[]) => mockedResolveRequestIdentity(...a) }));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));
const mockedAccess = jest.fn();
jest.mock("@/lib/workspaces/resolveTeamRunWorkspaceAccess", () => ({ resolveTeamRunWorkspaceAccess: (...a: unknown[]) => mockedAccess(...a) }));
const mockedEntitlements = jest.fn();
jest.mock("@/lib/admin/entitlements", () => ({ getEffectiveEntitlements: (...a: unknown[]) => mockedEntitlements(...a) }));
const mockedRender = jest.fn();
jest.mock("@/lib/pdf/renderAdaptiveResearchPdf", () => ({ renderAdaptiveResearchExport: (...a: unknown[]) => mockedRender(...a) }));
const mockedCreateRecord = jest.fn();
const mockedMarkReady = jest.fn();
const mockedMarkFailed = jest.fn();
const mockedSupersede = jest.fn();
jest.mock("@/lib/firestore/adaptiveExports", () => ({
  createAdaptiveExportRecord: (...a: unknown[]) => mockedCreateRecord(...a),
  markAdaptiveExportReady: (...a: unknown[]) => mockedMarkReady(...a),
  markAdaptiveExportFailed: (...a: unknown[]) => mockedMarkFailed(...a),
  supersedeOlderAdaptiveExports: (...a: unknown[]) => mockedSupersede(...a),
}));
const mockedGeneratedBy = jest.fn();
jest.mock("@/lib/adaptiveSchema/exportGeneratedBy", () => ({ resolveExportGeneratedBy: (...a: unknown[]) => mockedGeneratedBy(...a) }));
const mockedGetProject = jest.fn();
jest.mock("@/lib/firestore/projects", () => ({ getProject: (...a: unknown[]) => mockedGetProject(...a) }));
const mockedAudit = jest.fn();
jest.mock("@/lib/governance/auditLog", () => ({ writeAdaptiveExportAdminAuditEvent: (...a: unknown[]) => mockedAudit(...a) }));

const runDocs = new Map<string, Record<string, unknown>>();
let runGetThrows = false;
/** Any durable write surface other than the mocked export writers records here — E1 must never introduce one (§24). */
const rawWriteAttempts: string[] = [];
const readPaths: string[] = [];
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    const record = (op: string) => async () => {
      rawWriteAttempts.push(op);
      throw new Error(`unexpected durable write: ${op}`);
    };
    return {
      collection: (name: string) => ({
        doc: (id: string) => {
          const path = `${name}/${id}`;
          return {
            id,
            __path: path,
            get: async () => {
              readPaths.push(path);
              if (name !== "runs") throw new Error(`test fake: unconfigured collection "${name}"`);
              if (runGetThrows) throw new Error("firestore down");
              return { exists: runDocs.has(id), data: () => runDocs.get(id) };
            },
            set: record(`${path}.set`),
            update: record(`${path}.update`),
            create: record(`${path}.create`),
            collection: (sub: string) => ({ doc: (subId: string) => ({ id: subId, __path: `${path}/${sub}/${subId}`, set: record(`${path}/${sub}/${subId}.set`) }) }),
          };
        },
      }),
      runTransaction: record("runTransaction"),
      batch: () => ({ set: record("batch.set"), commit: record("batch.commit") }),
    };
  },
}));
jest.mock("@/lib/connectors", () => new Proxy({}, { get: (_t, key) => { throw new Error(`model connector touched: ${String(key)}`); } }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { NextRequest } from "next/server";
import { Timestamp } from "firebase-admin/firestore";
import { POST } from "@/app/api/workspaces/[workspaceId]/runs/[runId]/export/route";
import { FIXTURE_RUN_ID, FIXTURE_WORKSPACE_ID, fullTeamRunData, governanceRecord } from "@/lib/runs/__tests__/runReadFixtures";
import { ROLE_CAPABILITIES } from "@/lib/workspaces/capabilities";

const UID = "member-b";
const WS = FIXTURE_WORKSPACE_ID;
const OTHER_WS = "bOtherWorkspaceAutoId9999";
const RUN = FIXTURE_RUN_ID;
const RUN_PATH = `runs/${RUN}`;
const OWNER_UID = String(fullTeamRunData().userId);
/** uid -> planId, so a test can give the caller and the run owner DIFFERENT plans. */
const entitlementsByUid = new Map<string, string>();
/** `validateTeamRunRowShape` requires a genuine Timestamp `createdAt`; a blind-cast object is rejected by design. */
const CREATED = Timestamp.fromDate(new Date("2026-09-02T10:00:00.000Z"));
/**
 * A `comparison_matrix` output — the same shape `exportSnapshot.spec.ts`
 * uses as its known-good Milestone-2 fixture. Deliberately NOT the shared
 * `deepResearchAdaptiveOutput()`: that fixture omits `disagreements`,
 * `panelBlindSpots` and several other arrays which `parsePersistedAdaptiveOutput`
 * ACCEPTS but `reportSummary.ts` then dereferences unguarded — a PRE-EXISTING
 * latent defect in shared export code that would crash the Personal export
 * route identically. Recorded as a finding; deliberately not fixed in E1.
 */
const exportableAdaptiveOutput = () => ({
  version: 1,
  schemaId: "comparison_matrix",
  answerShape: "comparison_grid",
  classification: { queryType: "comparison_matrix", confidence: 0.9 },
  meta: {
    schemaVersion: 1,
    queryType: "comparison_matrix",
    answerShape: "comparison_grid",
    dataBasis: "mixed",
    freshness: "timeless",
    riskLevel: "professional",
    evidenceQuality: "moderate",
    uncertainties: [],
    blindSpots: [],
    humanReviewNeeded: false,
    generatedAt: "2026-01-01T00:00:00.000Z",
  },
  generatedAt: "2026-01-01T00:00:00.000Z",
  result: { subjects: [], attributes: [], cells: [], totalModels: 2, lowConfidenceSubjects: [], lowConfidenceAttributes: [], hasVerifiedSourceData: false },
});
const teamRun = (overrides: Record<string, unknown> = {}) => fullTeamRunData({ createdAt: CREATED, adaptiveOutput: exportableAdaptiveOutput(), ...overrides });

const grant = (role: "owner" | "admin" | "member" | "reviewer" | "viewer") => ({
  granted: true,
  workspace: { schemaVersion: 1, id: WS, type: "team", name: "WS", ownerUserId: "owner-1", createdByUserId: "owner-1", createdAt: CREATED, updatedAt: CREATED },
  membership: { uid: UID, role },
  capabilities: ROLE_CAPABILITIES[role],
});

const submit = async (body: unknown = { format: "pdf" }, workspaceId = WS, runId = RUN) => {
  const res = await POST(
    new NextRequest(`http://localhost/api/workspaces/${workspaceId}/runs/${runId}/export`, { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
    { params: { workspaceId, runId } }
  );
  const type = res.headers.get("Content-Type") ?? "";
  return { status: res.status, headers: res.headers, json: type.includes("application/json") ? await res.json() : null, bytes: type.includes("application/json") ? null : Buffer.from(await res.arrayBuffer()) };
};

beforeEach(() => {
  jest.clearAllMocks();
  runDocs.clear();
  rawWriteAttempts.length = 0;
  readPaths.length = 0;
  runGetThrows = false;
  mockExportFlagEnabled = true;
  runDocs.set(RUN, teamRun({ governanceRecord: governanceRecord("approved") }));
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID });
  mockedAccess.mockResolvedValue(grant("member"));
  // R2 §4 — entitlements are keyed BY UID. A single global result cannot
  // distinguish "the acting caller's plan" from "the run owner's plan", which
  // is exactly why the owner-substitution mutation previously survived.
  entitlementsByUid.clear();
  entitlementsByUid.set(UID, "full");
  entitlementsByUid.set(OWNER_UID, "full");
  mockedEntitlements.mockImplementation(async (uid: string) => ({ planId: entitlementsByUid.get(uid) ?? "free" }));
  // R2 §17 — the REAL `AdaptiveExportGeneratedBy` is {displayName, maskedEmail}
  // and its contract is "never persists a raw Firebase UID". The previous
  // `{kind, uid}` fixture put a raw uid into the record, contradicting
  // production and quietly weakening the redaction blob assertion.
  mockedGeneratedBy.mockResolvedValue({ displayName: "Member B", maskedEmail: "m***@example.com" });
  mockedCreateRecord.mockResolvedValue({ ok: true, reportVersion: 3 });
  mockedMarkReady.mockResolvedValue({ ok: true });
  mockedSupersede.mockResolvedValue({ ok: true });
  mockedMarkFailed.mockResolvedValue({ ok: true });
  mockedRender.mockResolvedValue({ bytes: Buffer.from("%PDF-1.7 fixture"), sha256: "a".repeat(64) });
  // the fixture run declares FIXTURE_PROJECT_ID; by default that Project lives in THIS Workspace
  mockedGetProject.mockResolvedValue({ status: "found", project: { id: "projAutoId0001", name: "P", status: "active", workspaceId: WS } });
});

/** R1 P2-1 — the canonical run path must not be read at all. Asserting the
 * response alone cannot detect a reordering that reads the run first and only
 * then denies: that ordering is what turns two distinct 404 codes into a
 * cross-tenant run-existence oracle. */
const expectNoRunRead = () => {
  expect(readPaths).not.toContain(RUN_PATH);
  expect(readPaths.filter((p) => p.startsWith("runs/"))).toEqual([]);
};

/** Every side effect that a denied request must not produce. */
const noSideEffects = () => {
  expect(mockedCreateRecord).not.toHaveBeenCalled();
  expect(mockedRender).not.toHaveBeenCalled();
  expect(mockedMarkReady).not.toHaveBeenCalled();
  expect(mockedAudit).not.toHaveBeenCalled();
  expect(rawWriteAttempts).toEqual([]);
};

describe("E1 — the authorized Team export path", () => {
  it("POSITIVE: a member with exports.create exports, and the bytes stream back", async () => {
    const r = await submit();

    expect(r.status).toBe(200);
    expect(r.headers.get("Content-Disposition")).toBe(`attachment; filename="convergepanel-export-${RUN}-v3.pdf"`);
    expect(r.headers.get("Content-Type")).toBe("application/pdf");
    expect(r.bytes?.toString()).toBe("%PDF-1.7 fixture");

    // the full lifecycle actually ran, in order
    expect(mockedCreateRecord).toHaveBeenCalledTimes(1);
    expect(mockedRender).toHaveBeenCalledTimes(1);
    expect(mockedMarkReady).toHaveBeenCalledWith(RUN, expect.stringMatching(/^exp-/), "a".repeat(64));
    expect(mockedSupersede).toHaveBeenCalledTimes(1);
    // §46 — the audit writer genuinely fires on the success path, which is
    // what makes every `not.toHaveBeenCalled()` below non-vacuous.
    expect(mockedAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "adaptive_export_generated", actorUid: UID, runId: RUN, reportVersion: 3 }));
  });

  it("§47 persists the export under the canonical runs/{runId}/exports authority, keyed by the ACTING caller", async () => {
    await submit();
    const arg = mockedCreateRecord.mock.calls[0][0] as { runId: string; exportId: string; record: Record<string, unknown> };
    expect(arg.runId).toBe(RUN);
    expect(arg.record.createdBy).toBe(UID);
    expect((arg.record.exportMetadata as Record<string, unknown>).requestingUser).toBe(UID);
    // never the run's owner, which is a different uid in the fixture
    expect(arg.record.createdBy).not.toBe(fullTeamRunData().userId);
  });

  it("§24 introduces no durable byte storage, and the only PROTECTED document it reads is the run", async () => {
    // Corrected wording after R2. This is not "no other reads whatsoever":
    // production also reads `users/{uid}` for export provenance and transacts
    // on the run for the export record — both mocked here. The invariant that
    // matters is about the PROTECTED target resource: an unauthorized request
    // must never read the target run (pinned by the ordering tests below).
    await submit();
    expect(rawWriteAttempts).toEqual([]);
    expect(readPaths.filter((p) => p.startsWith("runs/"))).toEqual([RUN_PATH]);
  });

  it("§13/§39 the frozen snapshot carries no reviewer identity and no private comment text", async () => {
    runDocs.set(RUN, teamRun({ governanceRecord: governanceRecord("approved", { humanReview: { status: "approved", reviewerId: "secret-reviewer-uid", reviewerComment: "SECRET COMMENT", conditions: ["c1"], decidedVia: "multi_reviewer_panel" } }) }));
    await submit();
    const blob = JSON.stringify((mockedCreateRecord.mock.calls[0][0] as { record: unknown }).record);
    expect(blob).not.toContain("secret-reviewer-uid");
    expect(blob).not.toContain("SECRET COMMENT");
    expect(blob).not.toContain("reviewerId");
  });

  it("R2 P3-C — the frozen provenance block carries no raw Firebase uid", async () => {
    // `AdaptiveExportGeneratedBy`'s own contract: "Never persists a raw
    // Firebase UID or unmasked email … only a human-facing display name and an
    // already-masked email". The previous fixture mocked `{kind, uid}`, which
    // contradicted production and put a raw uid in the record.
    await submit();
    const record = (mockedCreateRecord.mock.calls[0][0] as { record: Record<string, unknown> }).record;
    expect(record.generatedBy).toEqual({ displayName: "Member B", maskedEmail: "m***@example.com" });
    expect(JSON.stringify(record.generatedBy)).not.toContain(UID);
  });
});

describe("E1 — admission, capability and binding are three independent gates", () => {
  it("§30 signed out: denied with zero side effects", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "missing_credentials" });
    const r = await submit();
    expect(r.status).toBe(401);
    expect(mockedAccess).not.toHaveBeenCalled();
    noSideEffects();
  });

  it("§31 non-member: the Team concealment family, never the Personal 403", async () => {
    mockedAccess.mockResolvedValue({ granted: false, reason: "membership_not_found" });
    const r = await submit();
    expect(r.status).toBe(404);
    expect(r.json.errorCode).toBe("team_workspace_not_found");
    noSideEffects();
  });

  it("§32 admitted but WITHOUT exports.create (reviewer) is refused — admission is not capability", async () => {
    mockedAccess.mockResolvedValue(grant("reviewer"));
    const r = await submit();
    expect(r.status).toBe(403);
    expect(r.json.errorCode).toBe("insufficient_capability");
    noSideEffects();
  });

  it("§32 viewer is refused for the same reason", async () => {
    mockedAccess.mockResolvedValue(grant("viewer"));
    const r = await submit();
    expect(r.status).toBe(403);
    noSideEffects();
  });

  it("§33 CROSS-WORKSPACE: admitted to A, run bound to B — concealed, never exported", async () => {
    // The caller is genuinely admitted to the addressed Workspace…
    mockedAccess.mockResolvedValue({ ...grant("member"), workspace: { ...grant("member").workspace, id: OTHER_WS } });
    // …but the run's own canonical binding is a different Workspace.
    const r = await submit({ format: "pdf" }, OTHER_WS, RUN);
    expect(r.status).toBe(404);
    expect(r.json.errorCode).toBe("run_not_found");
    noSideEffects();
  });

  it("R1 P2-1: a NON-MEMBER triggers zero run I/O — denial precedes any run read", async () => {
    mockedAccess.mockResolvedValue({ granted: false, reason: "membership_not_found" });
    const r = await submit();
    expect(r.status).toBe(404);
    expect(r.json.errorCode).toBe("team_workspace_not_found");
    expectNoRunRead();
    noSideEffects();
  });

  it("R1 P2-1: for a non-member, an EXISTING and a MISSING run are indistinguishable AND neither is read", async () => {
    mockedAccess.mockResolvedValue({ granted: false, reason: "membership_not_found" });

    // Case A — the run exists.
    runDocs.set(RUN, teamRun());
    const present = await submit();
    const pathsWhenPresent = [...readPaths];

    readPaths.length = 0;
    // Case B — the run does not exist.
    runDocs.clear();
    const missing = await submit();

    // Identical externally…
    expect(missing.status).toBe(present.status);
    expect(missing.json).toEqual(present.json);
    // …and, the part a response comparison cannot show, no run I/O either way.
    expect(pathsWhenPresent.filter((p) => p.startsWith("runs/"))).toEqual([]);
    expect(readPaths.filter((p) => p.startsWith("runs/"))).toEqual([]);
    noSideEffects();
  });

  it("R1 P2-1: a caller WITHOUT exports.create triggers zero run I/O — capability precedes the run read", async () => {
    mockedAccess.mockResolvedValue(grant("reviewer"));
    const r = await submit();
    expect(r.status).toBe(403);
    expect(r.json.errorCode).toBe("insufficient_capability");
    expectNoRunRead();
    noSideEffects();
  });

  it("E1-S3: a NON-MEMBER's request body is never parsed", async () => {
    mockedAccess.mockResolvedValue({ granted: false, reason: "membership_not_found" });
    // A request whose json() is observable: if authorization ran first, it is
    // never called. Asserting the status alone cannot show that.
    const json = jest.fn().mockResolvedValue({ format: "pdf" });
    const req = new NextRequest(`http://localhost/api/workspaces/${WS}/runs/${RUN}/export`, { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
    Object.defineProperty(req, "json", { value: json });

    const res = await POST(req, { params: { workspaceId: WS, runId: RUN } });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ ok: false, errorCode: "team_workspace_not_found", message: "This Team Workspace could not be found." });
    expect(json).not.toHaveBeenCalled();
    expectNoRunRead();
    noSideEffects();
  });

  it("E1-S3: a non-member gets the SAME concealed answer for an enabled and a disabled format — no format oracle", async () => {
    mockedAccess.mockResolvedValue({ granted: false, reason: "membership_not_found" });
    const enabled = await submit({ format: "pdf" });
    const disabled = await submit({ format: "docx" });
    const malformed = await POST(
      new NextRequest(`http://localhost/api/workspaces/${WS}/runs/${RUN}/export`, { method: "POST", body: "not json", headers: { "Content-Type": "application/json" } }),
      { params: { workspaceId: WS, runId: RUN } }
    );

    expect(enabled.status).toBe(404);
    expect(disabled.json).toEqual(enabled.json);
    expect(malformed.status).toBe(404);
    // None of the three may leak format vocabulary.
    for (const blob of [JSON.stringify(enabled.json), JSON.stringify(disabled.json), JSON.stringify(await malformed.json())]) {
      expect(blob).not.toContain("unsupported_format");
      expect(blob).not.toContain("invalid_request");
      expect(blob).not.toMatch(/pdf|docx|json"/i);
    }
    noSideEffects();
  });

  it("E1-S3: a caller WITHOUT exports.create also never has their body parsed", async () => {
    mockedAccess.mockResolvedValue(grant("reviewer"));
    const json = jest.fn().mockResolvedValue({ format: "totally-made-up" });
    const req = new NextRequest(`http://localhost/api/workspaces/${WS}/runs/${RUN}/export`, { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } });
    Object.defineProperty(req, "json", { value: json });

    const res = await POST(req, { params: { workspaceId: WS, runId: RUN } });
    expect(res.status).toBe(403);
    expect(json).not.toHaveBeenCalled();
    expectNoRunRead();
    noSideEffects();
  });

  it("R1 P2-1: the AUTHORIZED exporter does read the canonical run — the control that makes the assertions above meaningful", async () => {
    const r = await submit();
    expect(r.status).toBe(200);
    expect(readPaths).toEqual([RUN_PATH]);
  });

  it("§37 the RUN OWNER gets no Personal fallback: ownership never substitutes for Workspace authority", async () => {
    // The caller is the run's own creator — the identity the Personal export
    // route would authorize outright — but the run is not canonically bound
    // to the addressed Workspace. Workspace export must still conceal it;
    // this route is not Personal export with a different URL.
    const ownerUid = String(fullTeamRunData().userId);
    mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: ownerUid });
    mockedAccess.mockResolvedValue(grant("member"));
    runDocs.set(RUN, teamRun({ workspaceId: OTHER_WS }));

    const r = await submit();
    expect(r.status).toBe(404);
    expect(r.json.errorCode).toBe("run_not_found");
    noSideEffects();
  });

  it("§37 a run owner who is NOT admitted to the Workspace is refused by the Team family", async () => {
    const ownerUid = String(fullTeamRunData().userId);
    mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: ownerUid });
    mockedAccess.mockResolvedValue({ granted: false, reason: "membership_not_found" });

    const r = await submit();
    expect(r.status).toBe(404);
    expect(r.json.errorCode).toBe("team_workspace_not_found");
    noSideEffects();
  });

  it("owner and admin both hold the capability", async () => {
    for (const role of ["owner", "admin"] as const) {
      jest.clearAllMocks();
      mockedAccess.mockResolvedValue(grant(role));
      mockedEntitlements.mockResolvedValue({ planId: "full" });
      mockedGeneratedBy.mockResolvedValue({ displayName: "Member B", maskedEmail: "m***@example.com" });
      mockedCreateRecord.mockResolvedValue({ ok: true, reportVersion: 1 });
      mockedMarkReady.mockResolvedValue({ ok: true });
      mockedSupersede.mockResolvedValue({ ok: true });
      mockedRender.mockResolvedValue({ bytes: Buffer.from("x"), sha256: "b".repeat(64) });
      expect((await submit()).status).toBe(200);
    }
  });

  it("a missing run is concealed identically to a foreign one", async () => {
    runDocs.clear();
    const r = await submit();
    expect(r.status).toBe(404);
    expect(r.json.errorCode).toBe("run_not_found");
    noSideEffects();
  });

  it("an infrastructure failure reading the run is 503, not a concealed 404", async () => {
    runGetThrows = true;
    const r = await submit();
    expect(r.status).toBe(503);
    expect(r.json.errorCode).toBe("team_workspace_unavailable");
    noSideEffects();
  });
});

describe("E1 — verdict axes", () => {
  it("§42 plan: an unentitled caller is refused after authority succeeds", async () => {
    entitlementsByUid.set(UID, "free");
    const r = await submit();
    expect(r.status).toBe(403);
    expect(r.json.errorCode).toBe("plan_not_entitled");
    noSideEffects();
  });

  it("R2 P2 / TEST A — caller NOT entitled, run owner IS: refused, and the metering subject is the CALLER", async () => {
    // The run's owner could export this run. The acting caller cannot. The
    // owner must not be able to donate paid entitlement to another member.
    entitlementsByUid.set(UID, "free");
    entitlementsByUid.set(OWNER_UID, "full");

    const r = await submit();
    expect(r.status).toBe(403);
    expect(r.json.errorCode).toBe("plan_not_entitled");
    // Pin the LOOKUP SUBJECT, not just the outcome: a denial alone stays green
    // even when the wrong identity is metered.
    expect(mockedEntitlements).toHaveBeenCalledWith(UID);
    expect(mockedEntitlements).not.toHaveBeenCalledWith(OWNER_UID);
    noSideEffects();
  });

  it("R2 P2 / TEST B — caller IS entitled, run owner is NOT: proceeds (the isolating control for direction)", async () => {
    // The mirror image. Together with Test A this proves directionality: the
    // caller's plan governs in BOTH directions, so neither a generous owner
    // nor a restricted owner changes the caller's eligibility.
    entitlementsByUid.set(UID, "full");
    entitlementsByUid.set(OWNER_UID, "free");

    const r = await submit();
    expect(r.status).toBe(200);
    expect(mockedEntitlements).toHaveBeenCalledWith(UID);
    expect(mockedEntitlements).not.toHaveBeenCalledWith(OWNER_UID);
    expect(mockedCreateRecord).toHaveBeenCalledTimes(1);
  });

  it("§40 governance: a rejected run is never exportable, even for an entitled owner", async () => {
    mockedAccess.mockResolvedValue(grant("owner"));
    runDocs.set(RUN, teamRun({ governanceRecord: governanceRecord("rejected") }));
    const r = await submit();
    expect(r.status).toBe(403);
    expect(r.json.errorCode).toBe("governance_state_blocked");
    noSideEffects();
  });

  it("a run with no adaptive report is 422, not a crash", async () => {
    runDocs.set(RUN, teamRun({ adaptiveOutput: undefined, legacyAdaptiveOutput: undefined }));
    const r = await submit();
    expect(r.status).toBe(422);
    expect(r.json.errorCode).toBe("no_report");
    noSideEffects();
  });
});

describe("E1 — format contract", () => {
  it("§43 a disabled format is rejected exactly like an unknown one (no feature disclosure)", async () => {
    const disabled = await submit({ format: "docx" });
    const unknown = await submit({ format: "totally-made-up" });
    expect(disabled.status).toBe(400);
    expect(disabled.json).toEqual(unknown.json);
    expect(JSON.stringify(disabled.json)).not.toMatch(/flag|enabled|disabled/i);
    noSideEffects();
  });

  it("a malformed body is rejected before any export work", async () => {
    const res = await POST(
      new NextRequest(`http://localhost/api/workspaces/${WS}/runs/${RUN}/export`, { method: "POST", body: "not json", headers: { "Content-Type": "application/json" } }),
      { params: { workspaceId: WS, runId: RUN } }
    );
    expect(res.status).toBe(400);
    noSideEffects();
  });
});

describe("E1 — failure semantics", () => {
  it("§44 render failure: marked failed, audited, no ready, no bytes", async () => {
    mockedRender.mockRejectedValue(new Error("renderer exploded"));
    const r = await submit();
    expect(r.status).toBe(500);
    expect(r.json.errorCode).toBe("export_generation_failed");
    expect(mockedMarkFailed).toHaveBeenCalledWith(RUN, expect.stringMatching(/^exp-/), "renderer exploded");
    expect(mockedMarkReady).not.toHaveBeenCalled();
    expect(mockedAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "adaptive_export_generation_failed" }));
  });

  it("§45 persistence failure creating the record: never renders, never falsely succeeds", async () => {
    mockedCreateRecord.mockResolvedValue({ ok: false, reason: "write_failed" });
    const r = await submit();
    expect(r.status).toBe(500);
    expect(r.json.errorCode).toBe("export_create_failed");
    expect(mockedRender).not.toHaveBeenCalled();
    expect(mockedMarkReady).not.toHaveBeenCalled();
  });

  it("post-generation bookkeeping failure must NOT turn a produced file into an error", async () => {
    mockedMarkReady.mockRejectedValue(new Error("firestore hiccup"));
    const r = await submit();
    expect(r.status).toBe(200);
    expect(r.bytes?.toString()).toBe("%PDF-1.7 fixture");
  });
});

describe("E1 — the feature flag", () => {
  it("with the export flag off the route is concealed as absent, before any authority work", async () => {
    mockExportFlagEnabled = false;
    const r = await submit();
    expect(r.status).toBe(404);
    expect(r.json.errorCode).toBe("run_not_found");
    expect(mockedAccess).not.toHaveBeenCalled();
    noSideEffects();
  });
});

describe("R1 P3 / R2 P3-A — runId syntax is load-bearing for path integrity", () => {
  // CORRECTED after R2. An earlier version of this comment claimed
  // `doc("a/b")` is a legal nested document path. It is NOT — probed against
  // the real @google-cloud/firestore in this repo:
  //
  //   "a/b"                     THROWS (odd component count)
  //   "runs/other"              THROWS
  //   "../escape"               THROWS
  //   ""                        THROWS
  //   "a/b/c"                   OK -> runs/a/b/c
  //   "otherRun/exports/exp-1"  OK -> runs/otherRun/exports/exp-1
  //   ".."                      OK -> runs/..
  //   " x"                      OK -> "runs/ x"
  //
  // The security fact is therefore NOT "any slash makes a nested document".
  // It is: certain malformed runIds containing an EVEN number of path
  // components are ACCEPTED by the document-path API and redirect the
  // reference to a different, valid document location. `runs/{runId}/exports/
  // {exportId}` is a real location in this repo (lib/firestore/adaptiveExports.ts),
  // so `otherRun/exports/exp-1` would address another run's export record.
  // That is what makes `validateRunIdSyntax` load-bearing.
  //
  // NOTE ON THE HARNESS: the fake below is MORE PERMISSIVE than the real SDK
  // (it will happily build `runs/a/b`). It is fine for exercising the route's
  // own validation, but it is NOT evidence of Firestore path legality — the
  // table above is, and it came from probing the real library.
  const sdkAccepted = ["a/b/c", "otherRun/exports/exp-1", "..", " x"];
  const sdkRejected = ["a/b", "runs/other", "../escape", ""];

  it.each(sdkAccepted)("rejects %p — a value the real SDK WOULD accept as a different document", async (badRunId) => {
    const r = await submit({ format: "pdf" }, WS, badRunId);
    expect(r.status).toBe(404);
    expect(r.json.errorCode).toBe("run_not_found");
    // Nothing was addressed at all — not the redirected path, not a run.
    expect(readPaths).toEqual([]);
    expect(mockedAccess).not.toHaveBeenCalled();
    noSideEffects();
  });

  it.each(sdkRejected)("also rejects %p, which the real SDK would throw on anyway", async (badRunId) => {
    const r = await submit({ format: "pdf" }, WS, badRunId);
    expect(r.status).toBe(404);
    expect(readPaths).toEqual([]);
    noSideEffects();
  });

  it("a syntactically valid runId is accepted (isolating the syntax gate as the cause)", async () => {
    expect((await submit()).status).toBe(200);
  });
});

describe("R1 P2-2 — the verdict's capability axis is fed the DERIVED fact, not a literal", () => {
  // The route gate denies before the verdict is ever reached, so production
  // cannot exercise the verdict's capability axis with `false`. That makes the
  // axis defence-in-depth — valuable, but unreachable by a behavioural test.
  // Mutation M17 (re-hardcoding `true`) therefore survived the entire
  // behavioural suite. The call site is pinned structurally instead, which is
  // the only layer at which that mutation is observable, and the axis itself
  // is proven by its own unit tests in exportAuthorization.spec.ts.
  const source = () => require("fs").readFileSync("app/api/workspaces/[workspaceId]/runs/[runId]/export/route.ts", "utf8") as string;

  it("passes the derived capability constant into the export verdict", () => {
    expect(source()).toContain("hasExportsCreateCapability: hasExportsCreate,");
  });

  it("never asserts the capability as a literal at the call site", () => {
    expect(source()).not.toContain("hasExportsCreateCapability: true");
  });

  it("derives that constant from the resolver's canonical capability set, not a role list", () => {
    const src = source();
    expect(src).toContain('const hasExportsCreate = access.capabilities.includes("exports.create");');
    // exactly one derivation, reused — never recomputed at the verdict.
    expect(src.match(/access\.capabilities\.includes\("exports\.create"\)/g)).toHaveLength(1);
  });
});

describe("E1-S7 — Project binding integrity matches the canonical read", () => {
  it("conceals a run filed in a Project belonging to ANOTHER Workspace", async () => {
    // The run's own workspaceId IS the addressed Workspace, so containment
    // passes — but its Project lives elsewhere. The canonical Team detail read
    // treats that as an integrity anomaly and conceals; export must too, or it
    // would stream a report the canonical read refuses to show (E1-S6).
    mockedGetProject.mockResolvedValue({ status: "found", project: { id: "projAutoId0001", name: "P", status: "active", workspaceId: OTHER_WS } });

    const r = await submit();
    expect(r.status).toBe(404);
    expect(r.json.errorCode).toBe("run_not_found");
    noSideEffects();
  });

  it("POSITIVE CONTROL: a Project in the SAME Workspace exports normally", async () => {
    mockedGetProject.mockResolvedValue({ status: "found", project: { id: "projAutoId0001", name: "P", status: "active", workspaceId: WS } });
    const r = await submit();
    expect(r.status).toBe(200);
    expect(mockedCreateRecord).toHaveBeenCalledTimes(1);
  });

  it("an infrastructure failure resolving the Project is 503, not a concealed 404", async () => {
    mockedGetProject.mockResolvedValue({ status: "read_failed" });
    const r = await submit();
    expect(r.status).toBe(503);
    expect(r.json.errorCode).toBe("team_workspace_unavailable");
    noSideEffects();
  });

  it("a Project that simply no longer exists is NOT an integrity anomaly — export proceeds", async () => {
    // Matches the canonical read, which logs and continues without the label.
    mockedGetProject.mockResolvedValue({ status: "not_found" });
    expect((await submit()).status).toBe(200);
  });

  it("an UNFILED run performs no Project lookup at all", async () => {
    runDocs.set(RUN, teamRun({ projectId: null }));
    expect((await submit()).status).toBe(200);
    expect(mockedGetProject).not.toHaveBeenCalled();
  });
});
