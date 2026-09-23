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
  workspace: { workspaceId: WS, type: "team" },
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
  mockedEntitlements.mockResolvedValue({ planId: "full" });
  mockedGeneratedBy.mockResolvedValue({ kind: "user", uid: UID });
  mockedCreateRecord.mockResolvedValue({ ok: true, reportVersion: 3 });
  mockedMarkReady.mockResolvedValue({ ok: true });
  mockedSupersede.mockResolvedValue({ ok: true });
  mockedMarkFailed.mockResolvedValue({ ok: true });
  mockedRender.mockResolvedValue({ bytes: Buffer.from("%PDF-1.7 fixture"), sha256: "a".repeat(64) });
});

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

  it("§24 introduces no durable byte storage and reads only the run document", async () => {
    await submit();
    expect(rawWriteAttempts).toEqual([]);
    expect(readPaths).toEqual([RUN_PATH]);
  });

  it("§13/§39 the frozen snapshot carries no reviewer identity and no private comment text", async () => {
    runDocs.set(RUN, teamRun({ governanceRecord: governanceRecord("approved", { humanReview: { status: "approved", reviewerId: "secret-reviewer-uid", reviewerComment: "SECRET COMMENT", conditions: ["c1"], decidedVia: "multi_reviewer_panel" } }) }));
    await submit();
    const blob = JSON.stringify((mockedCreateRecord.mock.calls[0][0] as { record: unknown }).record);
    expect(blob).not.toContain("secret-reviewer-uid");
    expect(blob).not.toContain("SECRET COMMENT");
    expect(blob).not.toContain("reviewerId");
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
    mockedAccess.mockResolvedValue({ ...grant("member"), workspace: { workspaceId: OTHER_WS, type: "team" } });
    // …but the run's own canonical binding is a different Workspace.
    const r = await submit({ format: "pdf" }, OTHER_WS, RUN);
    expect(r.status).toBe(404);
    expect(r.json.errorCode).toBe("run_not_found");
    noSideEffects();
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
      mockedGeneratedBy.mockResolvedValue({ kind: "user", uid: UID });
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
    mockedEntitlements.mockResolvedValue({ planId: "free" });
    const r = await submit();
    expect(r.status).toBe(403);
    expect(r.json.errorCode).toBe("plan_not_entitled");
    noSideEffects();
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
