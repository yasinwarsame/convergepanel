/**
 * TEAM_EXPORT_E2_A — `GET /api/workspaces/{workspaceId}/runs/{runId}/exports`.
 *
 * Identity, the Team run access resolver, the Project reader and the export-list
 * helper are mocked at their module boundaries. The capability matrix, the row
 * validator, the response family and the runId syntax guard are REAL.
 *
 * The Firestore fake is PATH-AWARE and throws on any path the test did not
 * configure, and it records every read so ordering invariants can be asserted
 * against actual I/O rather than HTTP status.
 */

let mockExportFlagEnabled = true;
jest.mock("@/lib/env", () => ({
  get ADAPTIVE_RESEARCH_EXPORT_ENABLED() {
    return mockExportFlagEnabled;
  },
}));

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({ resolveRequestIdentity: (...a: unknown[]) => mockedResolveRequestIdentity(...a) }));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));
const mockedAccess = jest.fn();
jest.mock("@/lib/workspaces/resolveTeamRunWorkspaceAccess", () => ({ resolveTeamRunWorkspaceAccess: (...a: unknown[]) => mockedAccess(...a) }));
const mockedGetProject = jest.fn();
jest.mock("@/lib/firestore/projects", () => ({ getProject: (...a: unknown[]) => mockedGetProject(...a) }));
const mockedListExports = jest.fn();
jest.mock("@/lib/firestore/adaptiveExports", () => ({ listAdaptiveExportRecords: (...a: unknown[]) => mockedListExports(...a) }));

const runDocs = new Map<string, Record<string, unknown>>();
let runGetThrows = false;
let adminDbAvailable = true;
const readPaths: string[] = [];
/** E2-A must write nothing at all. */
const writeAttempts: string[] = [];
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    if (!adminDbAvailable) return null;
    const record = (op: string) => async () => {
      writeAttempts.push(op);
      throw new Error(`unexpected write: ${op}`);
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
            collection: (sub: string) => ({
              doc: (subId: string) => ({ id: subId, __path: `${path}/${sub}/${subId}` }),
              orderBy: () => {
                readPaths.push(`${path}/${sub}[query]`);
                throw new Error("test fake: export subcollection queried directly; the route must use listAdaptiveExportRecords");
              },
            }),
          };
        },
      }),
      batch: () => ({ set: record("batch.set"), commit: record("batch.commit") }),
      runTransaction: record("runTransaction"),
    };
  },
}));
const mockedLoggerWarn = jest.fn();
// deferred reference (same pattern as the other mocks here) so the hoisted
// factory does not touch the const before its initializer has run
jest.mock("@/lib/logger", () => ({ logger: { warn: (...a: unknown[]) => mockedLoggerWarn(...a), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { NextRequest } from "next/server";
import { Timestamp } from "firebase-admin/firestore";
import { GET } from "@/app/api/workspaces/[workspaceId]/runs/[runId]/exports/route";
import { FIXTURE_PROJECT_ID, FIXTURE_RUN_ID, FIXTURE_WORKSPACE_ID, fullTeamRunData } from "@/lib/runs/__tests__/runReadFixtures";
import { ROLE_CAPABILITIES } from "@/lib/workspaces/capabilities";
import type { AdaptiveExportReportSnapshot } from "@/lib/adaptiveSchema/researchExport";
import type { ModelId } from "@/lib/types";
import { teamRunLookupUnavailableResponse } from "@/lib/workspaces/teamRunAccessResponse";

const UID = "member-b";
const OTHER_UID = "someone-else-entirely";
const OTHER_PROJECT_ID = "projAutoId0002";
const CREATOR_UID = "member-a";
const WS = FIXTURE_WORKSPACE_ID;
const OTHER_WS = "bOtherWorkspaceAutoId9999";
const RUN = FIXTURE_RUN_ID;
const RUN_PATH = `runs/${RUN}`;
const CREATED = Timestamp.fromDate(new Date("2026-09-02T10:00:00.000Z"));
const teamRun = (overrides: Record<string, unknown> = {}) => fullTeamRunData({ createdAt: CREATED, ...overrides });

/**
 * R2 §2 — THE AUTHORITY-MOCK RULE. A mocked security collaborator is not proven
 * by having been called; its security-relevant arguments must be pinned, and
 * where practical the fake must BEHAVE DIFFERENTLY when they are wrong. R2
 * showed why: with unconditional fakes, `resolveTeamRunWorkspaceAccess({ uid:
 * "attacker-static", workspaceId })`, `{ workspaceId: runId }` and
 * `getProject(workspaceId)` all passed 35/35. Ordering was pinned; IDENTITY,
 * TENANT and RESOURCE were not.
 *
 * So each fake below is a function of its arguments, and every discrimination
 * has its own CONTROL test proving the fake actually discriminates — otherwise
 * the fake itself would be the new vacuous assertion.
 */
const grant = (role: "owner" | "admin" | "member" | "reviewer" | "viewer") => ({
  granted: true,
  workspace: { schemaVersion: 1, id: WS, type: "team", name: "WS", ownerUserId: "owner-1", createdByUserId: "owner-1", createdAt: CREATED, updatedAt: CREATED },
  membership: { uid: UID, role },
  capabilities: ROLE_CAPABILITIES[role],
});


/**
 * ─── RECURSIVE HOSTILE reportSnapshot FIXTURES (R3 §2-§4) ──────────────────
 *
 * THE PERMANENT RULE: fixture fidelity is RECURSIVE. A nested field can only
 * prove non-disclosure if the production-valid fixture actually contains a
 * non-undefined value at that exact path BEFORE DTO projection. R3 proved the
 * cost of ignoring it: the previous fixture populated only
 * `reportSnapshot.question`, so projecting `milestone2.decisionReceipt`,
 * `milestone2.meta`, the five top-level report leaves, or the whole `legacy`
 * branch LEAF BY LEAF left all 60 tests green. `JSON.stringify` drops
 * `undefined` at every depth, so an absent leaf is not evidence of protection —
 * it is the absence of evidence.
 *
 * Shapes are taken from `buildExportSnapshot` (`lib/adaptiveSchema/
 * exportSnapshot.ts:141-154` for milestone2, `:174-189` for legacy) and the
 * types it writes, NOT from recollection. `satisfies` gives compile-time
 * enforcement of every REQUIRED leaf (the Quality Gate runs `tsc --noEmit`;
 * jest is transpile-only under `isolatedModules`, so `satisfies` alone is not
 * enough), and OPTIONAL leaves are covered by the runtime self-check below.
 *
 * Sentinel values are used wherever the type admits a free-form string. Where
 * it does not — enums (`consensusLevel`), `ModelId`, numbers, booleans — the
 * leak is caught by the exact DTO key allow-list instead, which fires for ANY
 * added key. Both mechanisms are load-bearing; neither alone is sufficient.
 */
const SNAP = {
  QUESTION: "SENTINEL_SNAPSHOT_QUESTION",
  REPORT_TYPE_LABEL: "SENTINEL_REPORT_TYPE_LABEL",
  GENERATED_AT: "2031-12-31T23:59:59.001Z",
  M2_RESULT: "SENTINEL_M2_RESULT_BODY",
  M2_META_UNCERTAINTY: "SENTINEL_M2_META_UNCERTAINTY",
  M2_META_BLINDSPOT: "SENTINEL_M2_META_BLINDSPOT",
  M2_META_CONSENSUS: "SENTINEL_M2_META_CONSENSUS_SUMMARY",
  M2_META_DISAGREEMENT: "SENTINEL_M2_META_DISAGREEMENT_SUMMARY",
  M2_META_NEXT_ACTION: "SENTINEL_M2_META_NEXT_ACTION",
  M2_META_LIMITATION: "SENTINEL_M2_META_LIMITATION",
  RECEIPT_CONCLUSION: "SENTINEL_RECEIPT_CONCLUSION",
  RECEIPT_BASIS: "SENTINEL_RECEIPT_BASIS",
  RECEIPT_ASSUMPTION: "SENTINEL_RECEIPT_ASSUMPTION",
  RECEIPT_UNCERTAINTY: "SENTINEL_RECEIPT_UNCERTAINTY",
  RECEIPT_LIMITATION: "SENTINEL_RECEIPT_LIMITATION",
  RECEIPT_SOURCE: "SENTINEL_RECEIPT_SOURCE",
  LEGACY_CLAIM_TEXT: "SENTINEL_LEGACY_ALIGNED_CLAIM",
  LEGACY_CLAIM_ID: "SENTINEL_LEGACY_CLAIM_ID",
  LEGACY_UNIFIED_ANSWER: "SENTINEL_LEGACY_UNIFIED_ANSWER",
  LEGACY_PANEL_VERDICT: "SENTINEL_LEGACY_PANEL_VERDICT",
  LEGACY_EXEC_SUMMARY: "SENTINEL_LEGACY_EXEC_SUMMARY",
  LEGACY_CERTAINTY_TEXT: "SENTINEL_LEGACY_CERTAINTY_ASSESSMENT",
  LEGACY_AGREE: "SENTINEL_LEGACY_WHERE_MODELS_AGREE",
  LEGACY_DISAGREE: "SENTINEL_LEGACY_WHERE_MODELS_DISAGREE",
  LEGACY_NARRATIVE_TITLE: "SENTINEL_LEGACY_NARRATIVE_TITLE",
  LEGACY_NARRATIVE_BODY: "SENTINEL_LEGACY_NARRATIVE_BODY",
  LEGACY_VERDICT_TOP_CONSENSUS: "SENTINEL_LEGACY_VERDICT_TOP_CONSENSUS",
  LEGACY_VERDICT_NEXT_STEP: "SENTINEL_LEGACY_VERDICT_NEXT_STEP",
  LEGACY_MODEL_THESIS: "SENTINEL_LEGACY_MODEL_THESIS",
  LEGACY_GATE_CLAIM_TEXT: "SENTINEL_LEGACY_GATE_CLAIM",
} as const;

const MILESTONE2_SNAPSHOT = {
  question: SNAP.QUESTION,
  models: [{ modelId: "chatgpt" as ModelId, ok: true }],
  reportTypeLabel: SNAP.REPORT_TYPE_LABEL,
  consensusLevel: "split",
  sourceGroundingLevel: "weak",
  reportGeneratedAt: SNAP.GENERATED_AT,
  milestone2: {
    schemaId: "comparison_matrix",
    result: { executiveSummary: SNAP.M2_RESULT },
    meta: {
      schemaVersion: 1,
      queryType: "comparison_matrix",
      answerShape: "comparison_grid",
      dataBasis: "mixed",
      freshness: "timeless",
      riskLevel: "professional",
      evidenceQuality: "moderate",
      consensusSummary: SNAP.M2_META_CONSENSUS,
      disagreementSummary: SNAP.M2_META_DISAGREEMENT,
      uncertainties: [SNAP.M2_META_UNCERTAINTY],
      blindSpots: [SNAP.M2_META_BLINDSPOT],
      humanReviewNeeded: true,
      recommendedNextAction: SNAP.M2_META_NEXT_ACTION,
      generatedAt: SNAP.GENERATED_AT,
      limitations: [SNAP.M2_META_LIMITATION],
    },
    decisionReceipt: {
      conclusion: SNAP.RECEIPT_CONCLUSION,
      basis: [SNAP.RECEIPT_BASIS],
      assumptions: [SNAP.RECEIPT_ASSUMPTION],
      uncertainties: [SNAP.RECEIPT_UNCERTAINTY],
      limitations: [SNAP.RECEIPT_LIMITATION],
      sources: [SNAP.RECEIPT_SOURCE],
      sourceBacked: true,
      humanReviewNeeded: true,
    },
  },
} satisfies AdaptiveExportReportSnapshot;

const LEGACY_SNAPSHOT = {
  question: SNAP.QUESTION,
  models: [{ modelId: "chatgpt" as ModelId, ok: true }],
  reportTypeLabel: SNAP.REPORT_TYPE_LABEL,
  consensusLevel: "split",
  sourceGroundingLevel: "weak",
  reportGeneratedAt: SNAP.GENERATED_AT,
  legacy: {
    schemaId: "financial_valuation",
    alignedClaims: [
      { id: SNAP.LEGACY_CLAIM_ID, claimText: SNAP.LEGACY_CLAIM_TEXT, cells: [], agreementScore: 0.5, certaintyScore: 0.5, status: "split" },
    ],
    gate: {
      status: "caution",
      runCertainty: 0.5,
      loadBearingSplitCount: 1,
      loadBearingClaims: [
        { id: "gate-claim-1", claimText: SNAP.LEGACY_GATE_CLAIM_TEXT, cells: [], agreementScore: 0.1, certaintyScore: 0.1, status: "split" },
      ],
    },
    synthesisReport: {
      unifiedAnswer: SNAP.LEGACY_UNIFIED_ANSWER,
      panelVerdict: SNAP.LEGACY_PANEL_VERDICT,
      gate: "caution",
      runCertainty: 0.5,
      whereModelsAgree: [SNAP.LEGACY_AGREE],
      whereModelsDisagree: [SNAP.LEGACY_DISAGREE],
      certaintyAssessment: SNAP.LEGACY_CERTAINTY_TEXT,
      narrativeSections: [{ title: SNAP.LEGACY_NARRATIVE_TITLE, body: SNAP.LEGACY_NARRATIVE_BODY }],
      executiveSummary: SNAP.LEGACY_EXEC_SUMMARY,
      disagreements: [],
      biasAndBlindSpots: [],
      biasEmptyReason: "below_threshold",
      panelCoverageGaps: [],
      diagnostics: {
        citedClaimCount: 1,
        totalClaimCount: 1,
        evidenceMix: { empirical: 1, theoretical: 0, anecdotal: 0, authoritative: 0 },
        homogeneityFlag: false,
        meanAgreement: 0.5,
      },
      verdictCard: {
        question: SNAP.QUESTION,
        topConsensus: SNAP.LEGACY_VERDICT_TOP_CONSENSUS,
        consensusModelCount: 1,
        keyDisagreement: null,
        disagreementDetail: null,
        disagreementModelCount: 0,
        caveat: null,
        recommendedNextSteps: [SNAP.LEGACY_VERDICT_NEXT_STEP],
      },
      degraded: true,
    },
    trustSummary: { perModel: [], overallTrust: 0.5 },
    modelResponses: [
      { modelId: "chatgpt" as ModelId, schemaId: "financial_valuation", ok: true, data: { thesis: SNAP.LEGACY_MODEL_THESIS } },
    ],
  },
} satisfies AdaptiveExportReportSnapshot;

/**
 * §4/§7 REACHABILITY SELF-CHECK. Proves each sentinel is present at its EXACT
 * path in the fixture BEFORE the route runs. Without this, a future fixture edit
 * that drops a leaf would silently restore the R3 proof hole: the
 * `not.toContain` assertions would all still pass, on a value that is no longer
 * there. Checking `reportSnapshot !== undefined` would not catch that; only
 * per-path checks do.
 */
const snapshotSentinelPaths = (snapshot: AdaptiveExportReportSnapshot): [string, string][] => {
  const m2 = snapshot.milestone2;
  const lg = snapshot.legacy;
  const paths: [string, string][] = [
    ["question", snapshot.question],
    ["reportTypeLabel", snapshot.reportTypeLabel],
    ["reportGeneratedAt", snapshot.reportGeneratedAt],
  ];
  if (m2) {
    paths.push(
      ["milestone2.result.executiveSummary", String((m2.result as { executiveSummary?: string }).executiveSummary)],
      ["milestone2.meta.consensusSummary", String(m2.meta.consensusSummary)],
      ["milestone2.meta.disagreementSummary", String(m2.meta.disagreementSummary)],
      ["milestone2.meta.uncertainties[0]", String(m2.meta.uncertainties[0])],
      ["milestone2.meta.blindSpots[0]", String(m2.meta.blindSpots[0])],
      ["milestone2.meta.recommendedNextAction", String(m2.meta.recommendedNextAction)],
      ["milestone2.meta.limitations[0]", String(m2.meta.limitations?.[0])],
      ["milestone2.decisionReceipt.conclusion", String(m2.decisionReceipt?.conclusion)],
      ["milestone2.decisionReceipt.basis[0]", String(m2.decisionReceipt?.basis[0])],
      ["milestone2.decisionReceipt.assumptions[0]", String(m2.decisionReceipt?.assumptions[0])],
      ["milestone2.decisionReceipt.uncertainties[0]", String(m2.decisionReceipt?.uncertainties[0])],
      ["milestone2.decisionReceipt.limitations[0]", String(m2.decisionReceipt?.limitations[0])],
      ["milestone2.decisionReceipt.sources[0]", String(m2.decisionReceipt?.sources[0])]
    );
  }
  if (lg) {
    paths.push(
      ["legacy.alignedClaims[0].claimText", String(lg.alignedClaims[0]?.claimText)],
      ["legacy.alignedClaims[0].id", String(lg.alignedClaims[0]?.id)],
      ["legacy.gate.loadBearingClaims[0].claimText", String(lg.gate?.loadBearingClaims[0]?.claimText)],
      ["legacy.synthesisReport.unifiedAnswer", String(lg.synthesisReport?.unifiedAnswer)],
      ["legacy.synthesisReport.panelVerdict", String(lg.synthesisReport?.panelVerdict)],
      ["legacy.synthesisReport.executiveSummary", String(lg.synthesisReport?.executiveSummary)],
      ["legacy.synthesisReport.certaintyAssessment", String(lg.synthesisReport?.certaintyAssessment)],
      ["legacy.synthesisReport.whereModelsAgree[0]", String(lg.synthesisReport?.whereModelsAgree[0])],
      ["legacy.synthesisReport.whereModelsDisagree[0]", String(lg.synthesisReport?.whereModelsDisagree[0])],
      ["legacy.synthesisReport.narrativeSections[0].title", String(lg.synthesisReport?.narrativeSections[0]?.title)],
      ["legacy.synthesisReport.narrativeSections[0].body", String(lg.synthesisReport?.narrativeSections[0]?.body)],
      ["legacy.synthesisReport.verdictCard.topConsensus", String(lg.synthesisReport?.verdictCard.topConsensus)],
      ["legacy.synthesisReport.verdictCard.recommendedNextSteps[0]", String(lg.synthesisReport?.verdictCard.recommendedNextSteps[0])],
      ["legacy.modelResponses[0].data.thesis", String((lg.modelResponses?.[0]?.data as { thesis?: string } | null)?.thesis)]
    );
  }
  return paths;
};

const assertSnapshotSentinelsReachable = (snapshot: AdaptiveExportReportSnapshot) => {
  for (const [path, value] of snapshotSentinelPaths(snapshot)) {
    if (!value.startsWith("SENTINEL_") && value !== SNAP.GENERATED_AT) {
      throw new Error(`fixture sentinel missing at ${path}: got ${JSON.stringify(value)}`);
    }
  }
};

/** Every sentinel that must never appear in a response, derived from the fixtures themselves rather than hand-listed (so adding a sentinel cannot be forgotten here). */
const allSnapshotSentinels = () => [
  ...snapshotSentinelPaths(MILESTONE2_SNAPSHOT).map(([, v]) => v),
  ...snapshotSentinelPaths(LEGACY_SNAPSHOT).map(([, v]) => v),
].filter((v) => v.startsWith("SENTINEL_"));

/**
 * R2 §16 — every field here is one the REAL E1 writer persists, checked against
 * `app/api/workspaces/[workspaceId]/runs/[runId]/export/route.ts:391-417`
 * (`recordBase`), `createAdaptiveExportRecord` (which adds `reportVersion` and
 * `exportMetadata.finalReportVersion`) and `markAdaptiveExportReady`
 * (`exportMetadata.fileHash`). The previous fixture omitted `version`, `runId`,
 * `schemaVersion`, `generatedBy` and `exportedSections`, so the E2A-S8 key-set
 * assertion could not see a projection of them — `JSON.stringify` drops
 * `undefined`, so projecting a field absent from the fixture changed nothing.
 * R2 proved it: adding `generatedBy` + `failureReason` to the DTO passed 35/35.
 *
 * Created by SOMEONE ELSE, so `createdBy` can never be the thing granting access.
 * Every non-DTO field carries a sentinel VALUE (never a type name — `"milestone2"`
 * could not serve, since `schemaFamily` legitimately carries it).
 */
const exportRecord = (reportVersion: number, over: Record<string, unknown> = {}) => ({
  version: 1,
  exportId: `exp-${reportVersion}`,
  runId: RUN,
  schemaId: "comparison_matrix",
  schemaFamily: "milestone2",
  schemaVersion: 1,
  reportVersion,
  format: "pdf",
  artifactStatus: "ready",
  createdAt: "2026-09-02T11:00:00.000Z",
  createdBy: CREATOR_UID,
  // E1 writes this UNCONDITIONALLY (`resolveExportGeneratedBy(uid)`), so every
  // real Team record carries the creator's frozen display name and masked
  // email. It is NOT in the DTO — Personal excludes it too (identical 13 keys).
  generatedBy: { displayName: "SENTINEL_CREATOR_DISPLAY_NAME", maskedEmail: "SENTINEL_MASKED_EMAIL" },
  governanceStatusAtExport: { family: "milestone2", kind: "approved", isOwnerOverride: false },
  classification: "internal",
  reportSnapshot: MILESTONE2_SNAPSHOT,
  exportMetadata: {
    exportId: `exp-${reportVersion}`,
    runId: RUN,
    schemaVersion: 1,
    exportedSections: ["SENTINEL_EXPORTED_SECTION"],
    createdAt: "2026-09-02T11:00:00.000Z",
    requestingUser: "SENTINEL_REQUESTING_USER",
    finalReportVersion: reportVersion,
    fileHash: "f".repeat(64),
  },
  ...over,
});

/** A production-valid LEGACY-family record: `schemaFamily: "legacy"` with the legacy snapshot branch, exactly as `buildExportSnapshot`'s legacy path writes it. */
const legacyExportRecord = (reportVersion: number) =>
  exportRecord(reportVersion, {
    schemaId: "financial_valuation",
    schemaFamily: "legacy",
    governanceStatusAtExport: { family: "legacy", status: "needs_review" },
    reportSnapshot: LEGACY_SNAPSHOT,
  });

/** `failureReason` is written ONLY by `markAdaptiveExportFailed`, always together with `artifactStatus: "failed"` — and a failed export produced no bytes, so it has no `fileHash`. Using it on a "ready" record would be a shape production cannot make (§36). */
const failedExportRecord = (reportVersion: number) => {
  const r = exportRecord(reportVersion, { artifactStatus: "failed", failureReason: "SENTINEL_FAILURE_REASON" }) as Record<string, unknown>;
  const meta = { ...(r.exportMetadata as Record<string, unknown>) };
  delete meta.fileHash;
  return { ...r, exportMetadata: meta };
};

/** Admission succeeds ONLY for the exact authenticated caller against the exact addressed Workspace. Any other principal or tenant gets the concealed denial production gives it. */
const accessFake = (role: "owner" | "admin" | "member" | "reviewer" | "viewer" = "member") =>
  async (args: { uid: string; workspaceId: string }) =>
    args.uid === UID && args.workspaceId === WS ? grant(role) : { granted: false, reason: "membership_not_found" };

/** The run's OWN Project resolves inside this Workspace; ANY other id resolves to a Project of another Workspace, so reading the wrong document is visibly concealed rather than silently tolerated. */
const projectFake = async (projectId: string) =>
  projectId === FIXTURE_PROJECT_ID
    ? { status: "found", project: { id: FIXTURE_PROJECT_ID, name: "P", status: "active", workspaceId: WS } }
    : { status: "found", project: { id: String(projectId), name: "Foreign", status: "active", workspaceId: OTHER_WS } };

/** History exists for the ADDRESSED run only — a helper that returns the same records for any runId would hide a cross-run read. */
const listFake = (records = [exportRecord(3), exportRecord(2)], hasMore = false) =>
  async (runId: string) => (runId === RUN ? { ok: true, records, hasMore } : { ok: true, records: [], hasMore: false });

const submit = async (query = "", workspaceId = WS, runId = RUN) => {
  const res = await GET(new NextRequest(`http://localhost/api/workspaces/${workspaceId}/runs/${runId}/exports${query}`), { params: { workspaceId, runId } });
  return { status: res.status, json: await res.json() };
};

beforeEach(() => {
  jest.clearAllMocks();
  runDocs.clear();
  readPaths.length = 0;
  writeAttempts.length = 0;
  runGetThrows = false;
  adminDbAvailable = true;
  mockExportFlagEnabled = true;
  runDocs.set(RUN, teamRun());
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID });
  mockedAccess.mockImplementation(accessFake());
  mockedGetProject.mockImplementation(projectFake);
  mockedListExports.mockImplementation(listFake());
});

/**
 * E2A-S1/S2 — NO target-associated I/O: the run, the Project and the export
 * subcollection. R1 found the Project read outside this boundary, so a mutation
 * moving `getProject` above admission survived; it is counted now.
 */
const expectNoTargetIO = () => {
  expect(readPaths.filter((p) => p.startsWith("runs/"))).toEqual([]);
  expect(mockedGetProject).not.toHaveBeenCalled();
  expect(mockedListExports).not.toHaveBeenCalled();
};
const noWrites = () => expect(writeAttempts).toEqual([]);
// R1 FROZEN RULE: for a positive "this caller CAN list/read X" test, `status 200`
// is insufficient — it survives an empty list, and a universal predicate over an
// empty array is vacuously true. Every positive read asserts non-emptiness by
// CARDINALITY and by IDENTITY.
const expectTheFixtureHistory = (r: { status: number; json: { exports: { exportId: string }[] } }) => {
  expect(r.status).toBe(200);
  expect(r.json.exports).toHaveLength(2);
  expect(r.json.exports.map((e) => e.exportId)).toEqual(["exp-3", "exp-2"]);
};

describe("E2-A — the authorized list path", () => {
  it("returns metadata newest-first for an authorized Research reader", async () => {
    const r = await submit();
    expect(r.status).toBe(200);
    expect(r.json.ok).toBe(true);
    expect(r.json.runId).toBe(RUN);
    expect(r.json.exports.map((e: { reportVersion: number }) => e.reportVersion)).toEqual([3, 2]);
    expect(r.json.hasMore).toBe(false);
    expect(r.json.nextCursor).toBeNull();
    expect(mockedListExports).toHaveBeenCalledWith(RUN, { limit: undefined, beforeReportVersion: undefined });
    // the control that gives the negative I/O assertions meaning
    expect(readPaths).toEqual([RUN_PATH]);
  });

  it("E2A-S8 the response exposes only the approved metadata DTO — proved against what E1 really persists", async () => {
    // R2: the old fixture omitted fields E1 writes, so projecting them changed
    // nothing (`JSON.stringify` drops `undefined`) and the key-set assertion was
    // blind to the two most likely additions. Both records below carry every
    // real persisted field, each non-DTO one holding a sentinel VALUE.
    mockedListExports.mockImplementation(listFake([exportRecord(3), failedExportRecord(2)]));
    const r = await submit();
    const blob = JSON.stringify(r.json);
    for (const sentinel of [
      "SENTINEL_CREATOR_DISPLAY_NAME", // generatedBy.displayName
      "SENTINEL_MASKED_EMAIL",         // generatedBy.maskedEmail
      "SENTINEL_FAILURE_REASON",       // failureReason
      "SENTINEL_EXPORTED_SECTION",     // exportMetadata.exportedSections
      "SENTINEL_REQUESTING_USER",      // exportMetadata.requestingUser
      ...allSnapshotSentinels(),       // every reportSnapshot leaf, both families
    ]) {
      expect(blob).not.toContain(sentinel);
    }
    // container names too: no raw persisted object is forwarded wholesale
    for (const container of ["reportSnapshot", "exportMetadata", "generatedBy", "failureReason", "schemaVersion", "finalReportVersion"]) {
      expect(blob).not.toContain(container);
    }
    // the item projection is an allow-list: exactly these keys
    expect(Object.keys(r.json.exports[0]).sort()).toEqual([...["artifactStatus", "classification", "createdAt", "createdBy", "exportId", "format", "governanceStatusAtExport", "reportVersion", "schemaFamily", "schemaId"], ...["fileHash", "hashAlgorithm", "hashReproducible"]].sort());
    // the FAILED record produced no bytes, so it carries none of the hash trio
    expect(Object.keys(r.json.exports[1]).sort()).toEqual(["artifactStatus", "classification", "createdAt", "createdBy", "exportId", "format", "governanceStatusAtExport", "reportVersion", "schemaFamily", "schemaId"].sort());
    // R2 (reviewer 1) P3: the TOP-LEVEL envelope is an allow-list too. Without
    // this, emitting the whole run document beside the list passed 35/35.
    expect(Object.keys(r.json).sort()).toEqual(["exports", "hasMore", "nextCursor", "ok", "runId"]);
  });

  it("E2A-S7 a current reader who did NOT create the exports receives them", async () => {
    // R1 P2: the previous version could not fail under the violation it named.
    // `status 200` survives an EMPTY list, `[].every(...)` is true, and
    // comparing two module constants can never fail — so a route filtering by
    // `createdBy === uid` passed this test. Cardinality and identity now carry
    // the proof: if the records a non-creator is entitled to disappear, this
    // fails, which is exactly what the mutation does.
    const r = await submit();
    expect(r.status).toBe(200);
    expect(r.json.exports).toHaveLength(2);
    expect(r.json.exports.map((e: { exportId: string }) => e.exportId)).toEqual(["exp-3", "exp-2"]);
    expect(r.json.exports.map((e: { reportVersion: number }) => e.reportVersion)).toEqual([3, 2]);
    // supporting evidence only: every returned record was created by someone else
    expect(r.json.exports.map((e: { createdBy: string }) => e.createdBy)).toEqual([CREATOR_UID, CREATOR_UID]);
  });

  it("E2A-S9 a role with research.read but WITHOUT exports.create can list", async () => {
    for (const role of ["reviewer", "viewer"] as const) {
      expect(ROLE_CAPABILITIES[role]).toContain("research.read");
      expect(ROLE_CAPABILITIES[role]).not.toContain("exports.create");
      mockedAccess.mockImplementation(accessFake(role));
      // Not merely "not refused": this role receives the actual history.
      expectTheFixtureHistory(await submit());
    }
  });

  it("E2-A writes nothing and never queries the export subcollection directly", async () => {
    await submit();
    noWrites();
    expect(readPaths.filter((p) => p.includes("[query]"))).toEqual([]);
  });

  it("surfaces hasMore/nextCursor from the helper", async () => {
    mockedListExports.mockResolvedValue({ ok: true, records: [exportRecord(9), exportRecord(8)], hasMore: true });
    const r = await submit();
    expect(r.json.hasMore).toBe(true);
    expect(r.json.nextCursor).toBe(8);
  });

  it("a TYPED persistence failure is 503 — one contract for one condition", async () => {
    // R1 INFORMATIONAL-3: this used to be 500 while the identical condition on
    // the run read was 503. Normalised on the helper's own typed reasons.
    for (const reason of ["firestore_unavailable", "read_failed"]) {
      mockedListExports.mockResolvedValue({ ok: false, reason });
      const r = await submit();
      expect(r.status).toBe(503);
      expect(r.json.errorCode).toBe("team_workspace_unavailable");
    }
  });

  // R2 §28: a test asserting that an UNRECOGNISED reason falls through to 500
  // used to live here. It was DELETED, not repaired: the 500 branch was dead by
  // type, and the only way to reach it was to make an untyped mock return a
  // reason `ListAdaptiveExportsResult` cannot carry. A test that can only pass
  // by fabricating an impossible state proves nothing about production. The
  // guarantee it reached for — a future added reason must not be silently
  // laundered into 503 — is now enforced by the route's `never` exhaustiveness
  // check, at COMPILE time, which no mock can defeat.
});

describe("E2-A — authority ordering", () => {
  it("E2A-S1 a NON-MEMBER performs zero run, Project and export I/O", async () => {
    mockedAccess.mockResolvedValue({ granted: false, reason: "membership_not_found" });
    const r = await submit();
    expect(r.status).toBe(404);
    expect(r.json.errorCode).toBe("team_workspace_not_found");
    expectNoTargetIO();
    noWrites();
  });

  it("E2A-S2 a caller WITHOUT research.read performs zero run, Project and export I/O", async () => {
    // A real role lacking research.read does not exist today, so the capability
    // set is narrowed directly — the route reads `capabilities`, not the label.
    // R2 P3-8: the set deliberately HOLDS `reviews.read` and `exports.create`,
    // so a gate asking for either of those instead of `research.read` would be
    // admitted here and this test would fail. With the old `["workspace.read"]`
    // set, substituting `reviews.read` for `research.read` passed 35/35.
    mockedAccess.mockResolvedValue({ ...grant("member"), capabilities: ["workspace.read", "reviews.read", "exports.create"] });
    const r = await submit();
    expect(r.status).toBe(403);
    expect(r.json.errorCode).toBe("insufficient_capability");
    expectNoTargetIO();
    noWrites();
  });

  it("signed out: denied before any authority work", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "missing_credentials" });
    const r = await submit();
    expect(r.status).toBe(401);
    expect(mockedAccess).not.toHaveBeenCalled();
    expectNoTargetIO();
  });

  it("E2A-S6 CROSS-WORKSPACE: a run bound to another Workspace is concealed and never listed", async () => {
    runDocs.set(RUN, teamRun({ workspaceId: OTHER_WS }));
    const r = await submit();
    expect(r.status).toBe(404);
    expect(r.json.errorCode).toBe("run_not_found");
    expect(mockedListExports).not.toHaveBeenCalled();
  });

  it("E2A-S6 a Project belonging to another Workspace is concealed", async () => {
    mockedGetProject.mockResolvedValue({ status: "found", project: { id: "projAutoId0001", name: "P", status: "active", workspaceId: OTHER_WS } });
    const r = await submit();
    expect(r.status).toBe(404);
    expect(r.json.errorCode).toBe("run_not_found");
    expect(mockedListExports).not.toHaveBeenCalled();
  });

  it("POSITIVE CONTROL: a same-Workspace Project lists normally", async () => {
    mockedGetProject.mockResolvedValue({ status: "found", project: { id: "projAutoId0001", name: "P", status: "active", workspaceId: WS } });
    expectTheFixtureHistory(await submit());
  });

  it("E2A-S6/S7 a FORMER member — including the export creator — is concealed", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: CREATOR_UID });
    mockedAccess.mockResolvedValue({ granted: false, reason: "membership_removed" });
    const r = await submit();
    expect(r.status).toBe(404);
    expectNoTargetIO();
  });

  it("a missing run is concealed; an infrastructure failure is 503", async () => {
    runDocs.clear();
    expect((await submit()).json.errorCode).toBe("run_not_found");
    runDocs.set(RUN, teamRun());
    runGetThrows = true;
    const r = await submit();
    expect(r.status).toBe(503);
    expect(r.json.errorCode).toBe("team_workspace_unavailable");
  });
});

describe("E2A-S3 — the flag is concealed until authorization", () => {
  const bothStates = async () => {
    mockExportFlagEnabled = false;
    const off = await submit();
    expect(mockedListExports).not.toHaveBeenCalled();
    jest.clearAllMocks();
    mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID });
    mockExportFlagEnabled = true;
    const on = await submit();
    return { off, on };
  };

  it("a non-member cannot distinguish the flag state", async () => {
    mockedAccess.mockImplementation(async () => ({ granted: false, reason: "membership_not_found" }));
    const { off, on } = await bothStates();
    expect(off.status).toBe(on.status);
    expect(off.json).toEqual(on.json);
    expect(off.json.errorCode).toBe("team_workspace_not_found");
  });

  it("a caller without research.read cannot distinguish the flag state", async () => {
    mockedAccess.mockImplementation(async () => ({ ...grant("member"), capabilities: ["workspace.read"] }));
    const { off, on } = await bothStates();
    expect(off.json).toEqual(on.json);
    expect(off.json.errorCode).toBe("insufficient_capability");
  });

  it("POSITIVE CONTROL: an authorized reader DOES observe the flag", async () => {
    mockExportFlagEnabled = false;
    const off = await submit();
    expect(off.status).toBe(404);
    expect(off.json.errorCode).toBe("run_not_found");
    expect(mockedListExports).not.toHaveBeenCalled();
    expect(readPaths.filter((p) => p.startsWith("runs/"))).toEqual([]);
  });
});

describe("E2A-S4 — pagination validity is concealed until authorization", () => {
  it("an unauthorized caller cannot distinguish pagination validity", async () => {
    mockedAccess.mockImplementation(async () => ({ granted: false, reason: "membership_not_found" }));
    const valid = await submit("?cursor=5&limit=10");
    const malformed = await submit("?cursor=not-a-number&limit=abc");
    const absurd = await submit("?cursor=-Infinity&limit=99999999");
    expect(malformed.json).toEqual(valid.json);
    expect(absurd.json).toEqual(valid.json);
    for (const r of [valid, malformed, absurd]) {
      expect(r.status).toBe(404);
      expect(JSON.stringify(r.json)).not.toMatch(/cursor|limit|pagination/i);
    }
    expectNoTargetIO();
  });
});

describe("E2A-S10 — this route forwards paging and owns no paging policy", () => {
  const lastCall = () => mockedListExports.mock.calls[mockedListExports.mock.calls.length - 1][1] as { limit?: number; beforeReportVersion?: number };

  it("passes cursor and limit through, truncating fractions", async () => {
    await submit("?cursor=7&limit=10");
    expect(lastCall()).toEqual({ limit: 10, beforeReportVersion: 7 });
    await submit("?cursor=7.9&limit=10.5");
    expect(lastCall()).toEqual({ limit: 10, beforeReportVersion: 7 });
  });

  it("omits non-finite values so the helper applies its own defaults and clamp", async () => {
    await submit("?cursor=abc&limit=xyz");
    expect(lastCall()).toEqual({ limit: undefined, beforeReportVersion: undefined });
    await submit("?limit=Infinity");
    expect(lastCall()).toEqual({ limit: undefined, beforeReportVersion: undefined });
  });

  it("does not clamp in the route — the helper owns the [1,50] bound (one implementation)", async () => {
    await submit("?limit=99999");
    expect(lastCall().limit).toBe(99999);
  });

  it("lists every persisted status without Team-only filtering", async () => {
    mockedListExports.mockResolvedValue({
      ok: true,
      records: [exportRecord(4, { artifactStatus: "ready" }), exportRecord(3, { artifactStatus: "superseded" }), exportRecord(2, { artifactStatus: "failed" }), exportRecord(1, { artifactStatus: "generating" })],
      hasMore: false,
    });
    const r = await submit();
    expect(r.json.exports.map((e: { artifactStatus: string }) => e.artifactStatus)).toEqual(["ready", "superseded", "failed", "generating"]);
  });

  it("omits the hash trio when no fileHash was persisted", async () => {
    mockedListExports.mockResolvedValue({ ok: true, records: [exportRecord(1, { exportMetadata: { exportId: "exp-1", runId: RUN, schemaVersion: 1, requestingUser: CREATOR_UID } })], hasMore: false });
    const item = (await submit()).json.exports[0];
    // R2 P3-9: `hashAlgorithm` was unasserted, so emitting it unconditionally
    // passed 35/35. All THREE members of the trio now have explicit disposition.
    // `hashAlgorithm` is NOT a persisted field — `AdaptiveExportManifest` has no
    // such key and grep finds it only in the two route DTOs. It is derived
    // (`"sha256" as const`), so it cannot be proved by putting a sentinel in
    // persisted metadata without inventing a shape production cannot make (§36).
    // Its contract is therefore CONDITIONAL EMISSION (pinned by the key set
    // below) plus its VALUE where it IS emitted (pinned in the docx/pdf test).
    expect(item.fileHash).toBeUndefined();
    expect(item.hashAlgorithm).toBeUndefined();
    expect(item.hashReproducible).toBeUndefined();
    expect(Object.keys(item).sort()).toEqual(["artifactStatus", "classification", "createdAt", "createdBy", "exportId", "format", "governanceStatusAtExport", "reportVersion", "schemaFamily", "schemaId"].sort());
  });

  it("marks docx as non-reproducible and pdf as reproducible", async () => {
    mockedListExports.mockResolvedValue({ ok: true, records: [exportRecord(2, { format: "docx" }), exportRecord(1, { format: "pdf" })], hasMore: false });
    const items = (await submit()).json.exports;
    expect(items[0].hashReproducible).toBe(false);
    expect(items[1].hashReproducible).toBe(true);
    // R3 P3-c: the label's VALUE was pinned only by its literal type, which jest
    // does not check (transpile-only under isolatedModules). A wrong algorithm
    // label beside a sha256 digest is an integrity-labelling defect.
    expect(items[0].hashAlgorithm).toBe("sha256");
    expect(items[1].hashAlgorithm).toBe("sha256");
  });
});

describe("E2A-S5 — runId syntax is load-bearing for path integrity", () => {
  // Probed against the real @google-cloud/firestore: an EVEN component count is
  // ACCEPTED and redirects the reference — `otherRun/exports/exp-1` resolves to
  // `runs/otherRun/exports/exp-1`, a real document location. Odd counts throw.
  it.each(["a/b/c", "otherRun/exports/exp-1", "..", " x", "a/b", ""])("rejects %p before any document path is constructed", async (bad) => {
    const r = await submit("", WS, bad);
    expect(r.status).toBe(404);
    expect(r.json.errorCode).toBe("run_not_found");
    expect(readPaths).toEqual([]);
    expect(mockedAccess).not.toHaveBeenCalled();
    expectNoTargetIO();
  });

  it("a valid runId is accepted (isolating the syntax gate as the cause)", async () => {
    expectTheFixtureHistory(await submit());
  });
});

describe("E2-A — infrastructure and identity envelopes", () => {
  it("§7 an unavailable database short-circuits before ALL authority work and all target I/O", async () => {
    adminDbAvailable = false;
    const r = await submit();
    expect(r.status).toBe(404);
    expect(r.json.errorCode).toBe("run_not_found");
    expect(mockedAccess).not.toHaveBeenCalled();
    expectNoTargetIO();
    noWrites();
  });

  it("§10 identity failures keep DISTINCT pre-auth vocabulary, so a later edit cannot collapse them into an oracle", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "missing_credentials" });
    const missing = await submit();
    expect(missing.status).toBe(401);
    expect(missing.json.errorCode).toBe("unauthorized");

    mockedResolveRequestIdentity.mockResolvedValue({ status: "unauthenticated", reason: "invalid_token" });
    const invalid = await submit();
    expect(invalid.status).toBe(401);
    expect(invalid.json.errorCode).toBe("auth_error");

    // distinct codes, and neither reveals anything about the target
    expect(missing.json.errorCode).not.toBe(invalid.json.errorCode);
    expectNoTargetIO();
  });
});

/**
 * R2 §3/§4/§7/§32/§33 — THE ARGUMENT LEDGER. Ordering was already pinned; these
 * pin WHO, WHICH TENANT and WHICH RESOURCE. Each `it` is the primary diagnostic
 * for exactly one wrong-argument mutation, and each CONTROL proves the
 * argument-sensitive fake genuinely discriminates on that dimension — without
 * the controls, the fakes would be the next vacuous assertion.
 *
 * | Collaborator                        | Required argument      | Wrong-argument mutation              |
 * |-------------------------------------|------------------------|--------------------------------------|
 * | resolveTeamRunWorkspaceAccess.uid   | the authenticated uid  | uid: "attacker-static"               |
 * | resolveTeamRunWorkspaceAccess.wsId  | the addressed wsId     | workspaceId: runId                   |
 * | capability                          | "research.read"        | "reviews.read" / "exports.create"    |
 * | getProject.projectId                | validated.projectId    | getProject(workspaceId)              |
 * | getProject (unfiled)                | not called at all      | `!== undefined` → getProject(null)   |
 * | listAdaptiveExportRecords.runId     | the addressed runId    | a different runId                    |
 */
describe("E2A-S11 — admission is evaluated for THIS caller against THIS Workspace", () => {
  it("E2A-S11a admission receives the AUTHENTICATED caller's uid", async () => {
    const r = await submit();
    expect(mockedAccess).toHaveBeenCalledTimes(1);
    // asserted on the uid dimension ALONE so this test fails for the principal
    // mutation and not for the tenant one — the two stay independently pinned
    expect(mockedAccess.mock.calls[0][0]).toMatchObject({ uid: UID });
    expectTheFixtureHistory(r);
  });

  it("E2A-S11a CONTROL: the fake is uid-sensitive — a different authenticated caller is concealed", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: OTHER_UID });
    const r = await submit();
    expect(r.status).toBe(404);
    expect(r.json.errorCode).toBe("team_workspace_not_found");
    expect(mockedAccess.mock.calls[0][0]).toMatchObject({ uid: OTHER_UID });
    expectNoTargetIO();
  });

  it("E2A-S11b admission receives the ADDRESSED workspaceId", async () => {
    const r = await submit();
    expect(mockedAccess.mock.calls[0][0]).toMatchObject({ workspaceId: WS });
    expectTheFixtureHistory(r);
  });

  it("E2A-S11b CONTROL: the fake is workspace-sensitive — the same caller addressing another Workspace is concealed", async () => {
    const r = await submit("", OTHER_WS);
    expect(r.status).toBe(404);
    expect(mockedAccess.mock.calls[0][0]).toMatchObject({ workspaceId: OTHER_WS });
    expectNoTargetIO();
  });

  it("E2A-S11 admission is passed EXACTLY the caller and the Workspace — nothing else", async () => {
    await submit();
    expect(mockedAccess).toHaveBeenCalledWith({ uid: UID, workspaceId: WS });
  });
});

describe("E2A-S12 — the Project integrity read targets the VALIDATED Project", () => {
  it("E2A-S12 getProject receives validated.projectId", async () => {
    const r = await submit();
    expect(mockedGetProject).toHaveBeenCalledTimes(1);
    expect(mockedGetProject).toHaveBeenCalledWith(FIXTURE_PROJECT_ID);
    expectTheFixtureHistory(r);
  });

  it("E2A-S12 CONTROL: the fake is projectId-sensitive — any other id resolves to a FOREIGN Workspace and is concealed", async () => {
    runDocs.set(RUN, teamRun({ projectId: OTHER_PROJECT_ID }));
    const r = await submit();
    expect(mockedGetProject).toHaveBeenCalledWith(OTHER_PROJECT_ID);
    expect(r.status).toBe(404);
    expect(r.json.errorCode).toBe("run_not_found");
    expect(mockedListExports).not.toHaveBeenCalled();
  });

  it("E2A-S13 an UNFILED run (projectId null) lists WITHOUT any Project read", async () => {
    runDocs.set(RUN, teamRun({ projectId: null }));
    const r = await submit();
    expectTheFixtureHistory(r);
    expect(mockedGetProject).not.toHaveBeenCalled();
  });
});

describe("E2A-S14 — the export-history read is scoped to the addressed run", () => {
  it("E2A-S14 the helper receives the addressed runId", async () => {
    const r = await submit();
    expect(mockedListExports).toHaveBeenCalledWith(RUN, { limit: undefined, beforeReportVersion: undefined });
    expectTheFixtureHistory(r);
  });

  it("E2A-S14 CONTROL: the fake is runId-sensitive — another run's id yields no records", async () => {
    await expect(mockedListExports("some-other-run", {})).resolves.toEqual({ ok: true, records: [], hasMore: false });
  });
});

describe("E2A-S9b — the gate asks for research.read SPECIFICALLY", () => {
  it("a caller holding reviews.read AND exports.create but NOT research.read is refused", async () => {
    // R2 P3-8: substituting `reviews.read` for `research.read` was invisible,
    // because no role holds one without the other and the denial fixture held
    // neither. This set holds both neighbours and not the required one, so any
    // gate on a neighbour would admit and this test would fail.
    mockedAccess.mockResolvedValue({ ...grant("member"), capabilities: ["workspace.read", "reviews.read", "exports.create"] });
    const r = await submit();
    expect(r.status).toBe(403);
    expect(r.json.errorCode).toBe("insufficient_capability");
    expectNoTargetIO();
  });

  it("POSITIVE CONTROL: research.read ALONE is sufficient", async () => {
    mockedAccess.mockResolvedValue({ ...grant("member"), capabilities: ["workspace.read", "research.read"] });
    expectTheFixtureHistory(await submit());
  });
});

describe("R2 P2-4 — a malformed historical record cannot crash the list", () => {
  /**
   * REACHABLE, not hypothetical. `normalizeAdaptiveExportRecord` blind-casts
   * (`raw as AdaptiveResearchExportV1`) with no shape validation, and its legacy
   * branch for the flat `"exportMetadata.fileHash"` key only merges into an
   * EXISTING nested map (`if (rest.exportMetadata && …)`). A legacy document
   * whose only hash carrier was the flat key therefore arrives with no
   * `exportMetadata` at all. Unguarded, `r.exportMetadata.fileHash` threw a
   * TypeError out of GET — the one failure path with no `{ok:false}` envelope.
   */
  const withoutMetadata = () => {
    const r = exportRecord(3) as Record<string, unknown>;
    delete r.exportMetadata;
    return r;
  };

  it("a record with NO exportMetadata still lists, with the hash trio omitted", async () => {
    mockedListExports.mockImplementation(listFake([withoutMetadata(), exportRecord(2)]));
    const r = await submit();
    expect(r.status).toBe(200);
    expect(r.json.exports).toHaveLength(2);
    expect(r.json.exports.map((e: { exportId: string }) => e.exportId)).toEqual(["exp-3", "exp-2"]);
    expect(Object.keys(r.json.exports[0]).sort()).toEqual(["artifactStatus", "classification", "createdAt", "createdBy", "exportId", "format", "governanceStatusAtExport", "reportVersion", "schemaFamily", "schemaId"].sort());
    // no synthesized hash, and the sibling record is unaffected
    expect(r.json.exports[0].fileHash).toBeUndefined();
    expect(r.json.exports[1].fileHash).toBe("f".repeat(64));
  });

  it("the LEGACY flat-key shape — the real producer — lists and never forwards the raw key", async () => {
    const legacy = withoutMetadata();
    legacy["exportMetadata.fileHash"] = "a".repeat(64);
    mockedListExports.mockImplementation(listFake([legacy]));
    const r = await submit();
    expect(r.status).toBe(200);
    expect(r.json.exports).toHaveLength(1);
    expect(r.json.exports[0].exportId).toBe("exp-3");
    expect(JSON.stringify(r.json)).not.toContain("exportMetadata");
    expect(JSON.stringify(r.json)).not.toContain("a".repeat(64));
  });
});

describe("R2 §23/§24/§29 — every REACHABLE persistence failure has its own envelope", () => {
  it("admission lookup_failed is 503, NOT laundered into the concealed 404", async () => {
    // An infrastructure inability to verify membership is not evidence about
    // membership. Laundering it into the 404 would make an outage
    // indistinguishable from — and retried like — a genuine absence.
    mockedAccess.mockResolvedValue({ granted: false, reason: "lookup_failed" });
    const r = await submit();
    expect(r.status).toBe(503);
    expect(r.json.errorCode).toBe("team_workspace_unavailable");
    expectNoTargetIO();
    noWrites();
  });

  it.each(["firestore_unavailable", "read_failed"] as const)("a Project read failure (%s) is 503 and lists nothing", async (status) => {
    mockedGetProject.mockResolvedValue({ status });
    const r = await submit();
    expect(r.status).toBe(503);
    expect(r.json.errorCode).toBe("team_workspace_unavailable");
    expect(mockedListExports).not.toHaveBeenCalled();
    noWrites();
  });

  it("the only reason the list helper can REALLY return is read_failed, and it is 503", async () => {
    // `listAdaptiveExportRecords` never throws (it catches and returns
    // `read_failed`), and its `firestore_unavailable` arm fires only on
    // `!adminDb`, which GET already answered with a concealed 404. So
    // `read_failed` is the one reachable failure from this route. The former
    // 500 `list_failed` fallback was dead by type and is gone, along with the
    // test that could only reach it via an untyped mock.
    mockedListExports.mockResolvedValue({ ok: false, reason: "read_failed" });
    const r = await submit();
    expect(r.status).toBe(503);
    expect(r.json.errorCode).toBe("team_workspace_unavailable");
  });

  it("every post-authorization 503 carries a STAGE-ACCURATE message, not \"couldn't verify your access\"", async () => {
    // R2 P3-5: access was verified stages earlier. Status and errorCode stay
    // byte-identical to the family's; only this route's own wording changes.
    mockedListExports.mockResolvedValue({ ok: false, reason: "read_failed" });
    const listFailed = await submit();
    expect(listFailed.json.message).not.toContain("verify your access");
    expect(listFailed.json.message).toContain("export history");

    // ...while the ADMISSION failure keeps the shared family envelope verbatim.
    // R3 P3-1: this used to assert `toContain("verify your access")` — the SHARED
    // helper's prose — while the route tells clients to key on status/errorCode
    // and never on wording. That held this test to a standard the route forbids
    // others, and rewording a shared module would have broken this PR's spec.
    // Compared against the helper's own value instead, so the split stays pinned
    // without freezing copy this route does not own.
    mockedAccess.mockResolvedValue({ granted: false, reason: "lookup_failed" });
    const admissionFailed = await submit();
    expect(admissionFailed.status).toBe(503);
    expect(admissionFailed.json.message).toBe(teamRunLookupUnavailableResponse().body.message);
    expect(listFailed.json.message).not.toBe(admissionFailed.json.message);
  });
});

describe("R2 P3-7 — the nextCursor guard", () => {
  it("hasMore with a NON-EMPTY page: the cursor is the last item's reportVersion", async () => {
    mockedListExports.mockImplementation(listFake([exportRecord(3), exportRecord(2)], true));
    const r = await submit();
    expect(r.json.exports).toHaveLength(2);
    expect(r.json.hasMore).toBe(true);
    expect(r.json.nextCursor).toBe(2);
  });

  it("hasMore with an EMPTY page cannot crash or invent a cursor", async () => {
    // Without the length guard this dereferences `items[-1]` and throws.
    // R3 §23 then unified the contract: an empty page and a page whose terminal
    // record has no usable `reportVersion` are the SAME condition — `hasMore`
    // says there is more and nothing can address it — so both take the integrity
    // path rather than emitting a contradictory envelope. (Unreachable from the
    // real helper, which only sets `hasMore` when it read more than `limit`
    // documents and `limit >= 1`; handled because the route cannot assume it.)
    mockedListExports.mockImplementation(listFake([], true));
    const r = await submit();
    expect(r.status).toBe(503);
    expect(r.json.errorCode).toBe("team_workspace_unavailable");
    expect(r.json.nextCursor).toBeUndefined();
    expect(r.json.hasMore).toBeUndefined();
  });

  it("an empty page with hasMore:FALSE is a normal empty history, not an error", async () => {
    mockedListExports.mockImplementation(listFake([], false));
    const r = await submit();
    expect(r.status).toBe(200);
    expect(r.json.exports).toEqual([]);
    expect(r.json.hasMore).toBe(false);
    expect(r.json.nextCursor).toBeNull();
  });
});

/**
 * R2 §13/§15/§38 — CHARACTERIZATION of `SHARED_EXPORT_HISTORY_EMPTY_QUERY_PARAM_NORMALIZATION`.
 *
 * These tests record what the code DOES today, not what it should do. The
 * behaviour is inherited verbatim from the Personal list, which this PR must not
 * touch, and fixing it on one surface only would be worse than the shared
 * inconsistency. The empty-string case is a known defect, deliberately deferred
 * to a change that updates BOTH surfaces together; nothing here endorses it.
 *
 * `searchParams.get()` returns `""` — not `null` — for `?cursor=`, and
 * `Number("") === 0`, which IS finite, so the intended "absent" fallback never
 * fires. Four distinct input classes, only three of which behave alike:
 */
describe("empty query parameters — inherited behaviour, characterized not endorsed", () => {
  const lastArgs = () => mockedListExports.mock.calls[mockedListExports.mock.calls.length - 1][1];

  it("cursor ABSENT → undefined (a genuine first page)", async () => {
    await submit();
    expect(lastArgs().beforeReportVersion).toBeUndefined();
  });

  it("cursor MALFORMED → undefined (the documented fallback, which does work here)", async () => {
    await submit("?cursor=not-a-number");
    expect(lastArgs().beforeReportVersion).toBeUndefined();
  });

  it("cursor EMPTY → 0, NOT the first page — the known inherited defect", async () => {
    await submit("?cursor=");
    expect(lastArgs().beforeReportVersion).toBe(0);
    // consequence, spelled out: the helper applies `where("reportVersion", "<", 0)`
    // and `reportVersion` starts at 1, so a run WITH exports reports none.
  });

  it("limit ABSENT → undefined, so the helper applies its own default of 30", async () => {
    await submit();
    expect(lastArgs().limit).toBeUndefined();
  });

  it("limit EMPTY → 0, which the helper clamps UP to 1 rather than defaulting to 30", async () => {
    await submit("?limit=");
    expect(lastArgs().limit).toBe(0);
    // the clamp itself is the helper's, pinned in lib/firestore/__tests__/adaptiveExports.spec.ts
  });
});

/**
 * R3 §2-§7 — the recursive non-disclosure proof. The fixtures are schema-
 * complete for BOTH families (`satisfies AdaptiveExportReportSnapshot`, so every
 * REQUIRED leaf is enforced at compile time) and every sentinel's presence at
 * its exact path is asserted at RUNTIME before any projection claim is made.
 */
describe("E2A-S8 — no reportSnapshot leaf reaches the response", () => {
  it("REACHABILITY: every sentinel exists at its exact path in both fixtures BEFORE projection", () => {
    expect(() => assertSnapshotSentinelsReachable(MILESTONE2_SNAPSHOT)).not.toThrow();
    expect(() => assertSnapshotSentinelsReachable(LEGACY_SNAPSHOT)).not.toThrow();
    // and there is genuinely something to hide, at a useful depth
    expect(snapshotSentinelPaths(MILESTONE2_SNAPSHOT).length).toBeGreaterThanOrEqual(16);
    expect(snapshotSentinelPaths(LEGACY_SNAPSHOT).length).toBeGreaterThanOrEqual(17);
    expect(allSnapshotSentinels().length).toBeGreaterThanOrEqual(30);
  });

  it("REACHABILITY CONTROL: dropping ONE nested leaf fails the self-check, before any non-disclosure claim", () => {
    // §7 — this is what stops future fixture drift from silently recreating the
    // R3 hole. Without it, deleting a leaf would leave every `not.toContain`
    // assertion passing, on a value that is no longer in the fixture at all.
    const damaged = JSON.parse(JSON.stringify(MILESTONE2_SNAPSHOT)) as AdaptiveExportReportSnapshot;
    delete damaged.milestone2!.decisionReceipt;
    expect(() => assertSnapshotSentinelsReachable(damaged)).toThrow(/decisionReceipt\.conclusion/);

    const damagedLegacy = JSON.parse(JSON.stringify(LEGACY_SNAPSHOT)) as AdaptiveExportReportSnapshot;
    delete damagedLegacy.legacy!.synthesisReport;
    expect(() => assertSnapshotSentinelsReachable(damagedLegacy)).toThrow(/synthesisReport\.unifiedAnswer/);
  });

  it("E2A-S8 no milestone2 reportSnapshot leaf reaches the response", async () => {
    mockedListExports.mockImplementation(listFake([exportRecord(3)]));
    const r = await submit();
    expect(r.status).toBe(200);
    expect(r.json.exports).toHaveLength(1);
    const blob = JSON.stringify(r.json);
    for (const [path, sentinel] of snapshotSentinelPaths(MILESTONE2_SNAPSHOT)) {
      if (!sentinel.startsWith("SENTINEL_")) continue;
      expect(blob).not.toContain(sentinel);
      expect(path).toBeTruthy();
    }
    expect(Object.keys(r.json.exports[0]).sort()).toEqual([...["artifactStatus", "classification", "createdAt", "createdBy", "exportId", "format", "governanceStatusAtExport", "reportVersion", "schemaFamily", "schemaId"], "fileHash", "hashAlgorithm", "hashReproducible"].sort());
  });

  it("E2A-S8 no legacy reportSnapshot leaf reaches the response", async () => {
    mockedListExports.mockImplementation(listFake([legacyExportRecord(3)]));
    const r = await submit();
    expect(r.status).toBe(200);
    expect(r.json.exports).toHaveLength(1);
    expect(r.json.exports[0].schemaFamily).toBe("legacy");
    const blob = JSON.stringify(r.json);
    for (const [, sentinel] of snapshotSentinelPaths(LEGACY_SNAPSHOT)) {
      if (!sentinel.startsWith("SENTINEL_")) continue;
      expect(blob).not.toContain(sentinel);
    }
    expect(Object.keys(r.json.exports[0]).sort()).toEqual([...["artifactStatus", "classification", "createdAt", "createdBy", "exportId", "format", "governanceStatusAtExport", "reportVersion", "schemaFamily", "schemaId"], "fileHash", "hashAlgorithm", "hashReproducible"].sort());
  });

  it("BOTH families list together, and neither leaks", async () => {
    mockedListExports.mockImplementation(listFake([exportRecord(4), legacyExportRecord(3), failedExportRecord(2)]));
    const r = await submit();
    expect(r.json.exports.map((e: { schemaFamily: string }) => e.schemaFamily)).toEqual(["milestone2", "legacy", "milestone2"]);
    const blob = JSON.stringify(r.json);
    for (const sentinel of allSnapshotSentinels()) expect(blob).not.toContain(sentinel);
  });
});

/**
 * R3 §9-§15 — the FULL Project outcome matrix. `getProject` has five outcomes
 * (`lib/firestore/projects.ts:17-22`) and E2-A must match the canonical Team
 * detail read on every one. R3 found `not_found`/`malformed` unpinned AND
 * unlogged: `if (projectResult.status !== "found") return concealed;` passed all
 * 60 tests while making history unlistable for a run the canonical read still
 * renders.
 */
describe("E2A-S6 — the Project outcome matrix matches the canonical read", () => {
  it("found + SAME Workspace: lists, and the exact Project id was read", async () => {
    const r = await submit();
    expect(mockedGetProject).toHaveBeenCalledWith(FIXTURE_PROJECT_ID);
    expectTheFixtureHistory(r);
  });

  it("found + FOREIGN Workspace: concealed, nothing listed", async () => {
    mockedGetProject.mockResolvedValue({ status: "found", project: { id: FIXTURE_PROJECT_ID, name: "F", status: "active", workspaceId: OTHER_WS } });
    const r = await submit();
    expect(r.status).toBe(404);
    expect(r.json.errorCode).toBe("run_not_found");
    expect(mockedListExports).not.toHaveBeenCalled();
  });

  it.each(["not_found", "malformed"] as const)("%s: logs and LISTS — parity with the canonical read, not concealment", async (status) => {
    // Canonical Team detail read: logs `filed run's Project unresolved; label
    // omitted` and renders the run. E1: logs `filed run's Project unresolved`
    // and exports. Neither treats it as an integrity anomaly, because a missing
    // Project document says nothing about which Workspace owns the run — that
    // was settled by validateTeamRunRowShape. E2-A carries no Project label at
    // all, so it lists.
    mockedGetProject.mockResolvedValue({ status });
    const r = await submit();
    expectTheFixtureHistory(r);
    expect(mockedLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining("Project unresolved"),
      expect.objectContaining({ errorCategory: status, workspaceId: WS, runId: RUN })
    );
  });

  it.each(["firestore_unavailable", "read_failed"] as const)("%s: 503, nothing listed", async (status) => {
    mockedGetProject.mockResolvedValue({ status });
    const r = await submit();
    expect(r.status).toBe(503);
    expect(r.json.errorCode).toBe("team_workspace_unavailable");
    expect(mockedListExports).not.toHaveBeenCalled();
    noWrites();
  });

  it("the degraded-Project warning carries NO report content, snapshot or governance data", async () => {
    mockedGetProject.mockResolvedValue({ status: "not_found" });
    await submit();
    const logged = JSON.stringify(mockedLoggerWarn.mock.calls);
    for (const sentinel of allSnapshotSentinels()) expect(logged).not.toContain(sentinel);
    for (const s of ["SENTINEL_CREATOR_DISPLAY_NAME", "SENTINEL_MASKED_EMAIL", "SENTINEL_FAILURE_REASON"]) {
      expect(logged).not.toContain(s);
    }
  });
});

/**
 * R3 §22-§24 — E2A-S15. A response must never say "there is more" without a
 * usable way to ask for it.
 */
describe("E2A-S15 — the paging envelope is never self-contradictory", () => {
  it("a page that cannot yield a continuation cursor is an integrity failure, not a trap", async () => {
    // Reproduced by R3: `reportVersion` missing on the terminal item made
    // `nextCursor` serialize away, leaving `{hasMore:true}` with no cursor — a
    // client paging on it re-requests page 1 for ever, and the envelope broke
    // this route's own 5-key allow-list.
    const noVersion = exportRecord(3) as Record<string, unknown>;
    delete noVersion.reportVersion;
    mockedListExports.mockImplementation(listFake([noVersion], true));
    const r = await submit();
    expect(r.status).toBe(503);
    expect(r.json.errorCode).toBe("team_workspace_unavailable");
    expect(r.json.hasMore).toBeUndefined();
    expect(r.json.exports).toBeUndefined();
    noWrites();
  });

  it("a NON-NUMERIC reportVersion is refused the same way", async () => {
    mockedListExports.mockImplementation(listFake([exportRecord(3, { reportVersion: "3" })], true));
    const r = await submit();
    expect(r.status).toBe(503);
    expect(r.json.errorCode).toBe("team_workspace_unavailable");
  });

  it("POSITIVE CONTROL: hasMore with a usable terminal reportVersion still pages", async () => {
    mockedListExports.mockImplementation(listFake([exportRecord(3), exportRecord(2)], true));
    const r = await submit();
    expect(r.status).toBe(200);
    expect(r.json.hasMore).toBe(true);
    expect(r.json.nextCursor).toBe(2);
    expect(Object.keys(r.json).sort()).toEqual(["exports", "hasMore", "nextCursor", "ok", "runId"]);
  });

  it("hasMore:false with a malformed terminal record is NOT refused — there is nothing to continue", async () => {
    const noVersion = exportRecord(3) as Record<string, unknown>;
    delete noVersion.reportVersion;
    mockedListExports.mockImplementation(listFake([noVersion], false));
    const r = await submit();
    expect(r.status).toBe(200);
    expect(r.json.hasMore).toBe(false);
    expect(r.json.nextCursor).toBeNull();
    expect(r.json.exports).toHaveLength(1);
  });
});
