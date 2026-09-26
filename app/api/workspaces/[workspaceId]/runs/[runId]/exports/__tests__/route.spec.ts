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
/**
 * R7 §3 — INSTRUMENTATION LIVES AT THE MOCK BOUNDARY.
 *
 * R6 found the previous design structurally unsafe: wrapping happened inside a
 * `listFake` HELPER, so any test that reached for `mockResolvedValue` instead
 * silently opted out — and those opt-outs turned out to be the SOLE carriers of
 * the `generating`, `superseded`, `docx` and no-`fileHash` input classes. A leak
 * gated on `artifactStatus === "generating"` therefore passed 92/92 green.
 *
 * Now the module mock itself instruments whatever any test resolves, so opting
 * out is impossible by construction rather than by discipline. `instrumentListResult`
 * is applied to the awaited result on every call; tests hand over raw logical
 * results and cannot choose otherwise.
 */
jest.mock("@/lib/firestore/adaptiveExports", () => ({
  listAdaptiveExportRecords: async (...a: unknown[]) => instrumentListResult(await mockedListExports(...a)),
}));

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
import type { AlignedClaimCell, ComparisonMatrixResult } from "@/lib/adaptiveSchema/types";
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
 * types it writes, NOT from recollection. NOTE: `satisfies` here enforces
 * NOTHING — this file is excluded from `tsconfig.json` and ts-jest transpiles it
 * without type-checking, so treat it as editor assistance only (full retraction
 * below). Fixture completeness is therefore integration evidence, never proof;
 * the proof is E2A-S8A's runtime source-access instrumentation.
 *
 * Sentinel values are placed on the PROOF-RELEVANT free-form-string leaves — the
 * ones enumerated in `snapshotSentinelPaths` — not on every string in the
 * fixtures: subject/attribute ids, four `valuesByModel` entries and `raw.asOf`
 * deliberately carry ordinary values. Secrecy does not depend on sentinel
 * coverage at all (that is E2A-S8A's job); these are integration evidence. Where
 * the type does not admit a free-form string — enums (`consensusLevel`), `ModelId`, numbers, booleans — the
 * leak is caught by the exact DTO key allow-list instead, which fires for ANY
 * added key. Both mechanisms are load-bearing; neither alone is sufficient.
 */
/**
 * ─── SENTINEL REGISTRY ────────────────────────────────────────────────────
 * String sentinels for the proof-relevant free-form-string leaves, and
 * DISTINCTIVE NUMBERS for the numeric ones — R4 showed a leak is caught
 * iff the projected value SERIALIZES, so numeric leaves need detectable values
 * too, not just an allow-list entry.
 */
const SNAP = {
  QUESTION: "SENTINEL_SNAPSHOT_QUESTION",
  REPORT_TYPE_LABEL: "SENTINEL_REPORT_TYPE_LABEL",
  GENERATED_AT: "2031-12-31T23:59:59.001Z",
  // milestone2.result — real ComparisonMatrixResult leaves
  M2_DIRECT_CONCLUSION: "SENTINEL_M2_DIRECT_CONCLUSION",
  M2_TRADEOFF: "SENTINEL_M2_TRADEOFF",
  M2_BEST_USE: "SENTINEL_M2_BEST_USE",
  M2_RESULT_UNCERTAINTY: "SENTINEL_M2_RESULT_UNCERTAINTY",
  M2_SUBJECT_LABEL: "SENTINEL_M2_SUBJECT_LABEL",
  M2_LOWCONF_SUBJECT_LABEL: "SENTINEL_M2_LOWCONF_SUBJECT_LABEL",
  M2_ATTRIBUTE_LABEL: "SENTINEL_M2_ATTRIBUTE_LABEL",
  M2_LOWCONF_ATTRIBUTE_LABEL: "SENTINEL_M2_LOWCONF_ATTRIBUTE_LABEL",
  M2_CELL_VALUE: "SENTINEL_M2_CELL_VALUE",
  M2_CELL_CONSENSUS: "SENTINEL_M2_CELL_CONSENSUS",
  M2_CELL_RATIONALE: "SENTINEL_M2_CELL_RATIONALE",
  M2_CELL_SOURCE: "SENTINEL_M2_CELL_SOURCE",
  // milestone2.meta
  M2_META_UNCERTAINTY: "SENTINEL_M2_META_UNCERTAINTY",
  M2_META_BLINDSPOT: "SENTINEL_M2_META_BLINDSPOT",
  M2_META_CONSENSUS: "SENTINEL_M2_META_CONSENSUS_SUMMARY",
  M2_META_DISAGREEMENT: "SENTINEL_M2_META_DISAGREEMENT_SUMMARY",
  M2_META_NEXT_ACTION: "SENTINEL_M2_META_NEXT_ACTION",
  M2_META_LIMITATION: "SENTINEL_M2_META_LIMITATION",
  // decision receipt
  RECEIPT_CONCLUSION: "SENTINEL_RECEIPT_CONCLUSION",
  RECEIPT_BASIS: "SENTINEL_RECEIPT_BASIS",
  RECEIPT_ASSUMPTION: "SENTINEL_RECEIPT_ASSUMPTION",
  RECEIPT_UNCERTAINTY: "SENTINEL_RECEIPT_UNCERTAINTY",
  RECEIPT_LIMITATION: "SENTINEL_RECEIPT_LIMITATION",
  RECEIPT_SOURCE: "SENTINEL_RECEIPT_SOURCE",
  // legacy
  LEGACY_CLAIM_TEXT: "SENTINEL_LEGACY_ALIGNED_CLAIM",
  LEGACY_CLAIM_ID: "SENTINEL_LEGACY_CLAIM_ID",
  LEGACY_CLAIM_DISAGREEMENT_TYPE: "SENTINEL_LEGACY_CLAIM_DISAGREEMENT_TYPE",
  LEGACY_CELL_EXCERPT: "SENTINEL_LEGACY_CELL_EXCERPT",
  LEGACY_CELL_CAMP_LABEL: "SENTINEL_LEGACY_CELL_CAMP_LABEL",
  LEGACY_CELL_CAMP_POSITION: "SENTINEL_LEGACY_CELL_CAMP_POSITION",
  LEGACY_GATE_CLAIM_TEXT: "SENTINEL_LEGACY_GATE_CLAIM",
  LEGACY_GATE_CELL_EXCERPT: "SENTINEL_LEGACY_GATE_CELL_EXCERPT",
  LEGACY_UNIFIED_ANSWER: "SENTINEL_LEGACY_UNIFIED_ANSWER",
  LEGACY_PANEL_VERDICT: "SENTINEL_LEGACY_PANEL_VERDICT",
  LEGACY_EXEC_SUMMARY: "SENTINEL_LEGACY_EXEC_SUMMARY",
  LEGACY_CERTAINTY_TEXT: "SENTINEL_LEGACY_CERTAINTY_ASSESSMENT",
  LEGACY_AGREE: "SENTINEL_LEGACY_WHERE_MODELS_AGREE",
  LEGACY_DISAGREE: "SENTINEL_LEGACY_WHERE_MODELS_DISAGREE",
  LEGACY_NARRATIVE_TITLE: "SENTINEL_LEGACY_NARRATIVE_TITLE",
  LEGACY_NARRATIVE_BODY: "SENTINEL_LEGACY_NARRATIVE_BODY",
  LEGACY_DIS_TOPIC: "SENTINEL_LEGACY_DISAGREEMENT_TOPIC",
  LEGACY_DIS_WHY: "SENTINEL_LEGACY_DISAGREEMENT_WHY",
  LEGACY_DIS_POSITION: "SENTINEL_LEGACY_DISAGREEMENT_POSITION",
  LEGACY_BIAS_TYPE: "SENTINEL_LEGACY_BIAS_TYPE",
  LEGACY_BIAS_DESCRIPTION: "SENTINEL_LEGACY_BIAS_DESCRIPTION",
  LEGACY_BIAS_EXCERPT: "SENTINEL_LEGACY_BIAS_EXCERPT",
  LEGACY_BIAS_RATIONALE: "SENTINEL_LEGACY_BIAS_RATIONALE",
  LEGACY_BIAS_CAUSE: "SENTINEL_LEGACY_BIAS_CAUSE",
  LEGACY_BIAS_IMPACT: "SENTINEL_LEGACY_BIAS_IMPACT",
  LEGACY_BIAS_MITIGATION: "SENTINEL_LEGACY_BIAS_MITIGATION",
  LEGACY_GAP_DIMENSION: "SENTINEL_LEGACY_GAP_DIMENSION",
  LEGACY_GAP_WHY: "SENTINEL_LEGACY_GAP_WHY",
  LEGACY_GAP_FOLLOWUP: "SENTINEL_LEGACY_GAP_FOLLOWUP",
  LEGACY_VERDICT_TOP_CONSENSUS: "SENTINEL_LEGACY_VERDICT_TOP_CONSENSUS",
  LEGACY_VERDICT_KEY_DISAGREEMENT: "SENTINEL_LEGACY_VERDICT_KEY_DISAGREEMENT",
  LEGACY_VERDICT_DETAIL: "SENTINEL_LEGACY_VERDICT_DETAIL",
  LEGACY_VERDICT_CAVEAT: "SENTINEL_LEGACY_VERDICT_CAVEAT",
  LEGACY_VERDICT_NEXT_STEP: "SENTINEL_LEGACY_VERDICT_NEXT_STEP",
  LEGACY_MODEL_THESIS: "SENTINEL_LEGACY_MODEL_THESIS",
  LEGACY_MODEL_PARSE_ERROR: "SENTINEL_LEGACY_MODEL_PARSE_ERROR",
  LEGACY_MODEL_TRUNCATED_FIELD: "SENTINEL_LEGACY_MODEL_TRUNCATED_FIELD",
  LEGACY_MODEL_INVALID_FIELD: "SENTINEL_LEGACY_MODEL_INVALID_FIELD",
  LEGACY_COERCION_RAW: "SENTINEL_LEGACY_COERCION_RAW",
  LEGACY_COERCION_COERCED: "SENTINEL_LEGACY_COERCION_COERCED",
  LEGACY_COERCION_PATH: "SENTINEL_LEGACY_COERCION_PATH",
  LEGACY_RAW_METRIC_LABEL: "SENTINEL_LEGACY_RAW_METRIC_LABEL",
  LEGACY_RAW_METRIC_UNIT: "SENTINEL_LEGACY_RAW_METRIC_UNIT",
  LEGACY_RAW_METRIC_SOURCE: "SENTINEL_LEGACY_RAW_METRIC_SOURCE",
  LEGACY_MODEL_BULL_CASE: "SENTINEL_LEGACY_MODEL_BULL_CASE",
} as const;

/** Distinctive NUMBERS. R4's rule cuts both ways: a numeric leaf projected into the DTO serializes, so a recognisable value detects it — an allow-list entry alone would not survive a substitution into an already-allowed key. */
const NUM = {
  M2_SOURCE_SUPPORTED: 90111,
  M2_SOURCE_TOTAL: 90222,
  M2_SOURCE_RATIO: 0.90333,
  M2_TOTAL_MODELS: 90444,
  M2_SUCCESSFUL: 90555,
  M2_FAILED: 90666,
  M2_USABLE: 90777,
  TRUST_OVERALL: 0.91888,
  TRUST_CLAIMS: 91999,
  TRUST_MAJORITY: 0.92111,
  TRUST_CITATION: 0.92222,
  TRUST_CONTRADICTIONS: 92333,
  TRUST_SCORE: 0.92444,
  LEGACY_MODEL_LATENCY: 93555,
} as const;

const M2_RESULT = {
  subjects: [{ id: "subj-1", label: SNAP.M2_SUBJECT_LABEL, coverageCount: 2, totalModels: 2, coverageRatio: 1 }],
  lowConfidenceSubjects: [{ id: "subj-2", label: SNAP.M2_LOWCONF_SUBJECT_LABEL, coverageCount: 1, totalModels: 2, coverageRatio: 0.5 }],
  attributes: [{ id: "attr-1", label: SNAP.M2_ATTRIBUTE_LABEL, coverageCount: 2, totalModels: 2, coverageRatio: 1 }],
  lowConfidenceAttributes: [{ id: "attr-2", label: SNAP.M2_LOWCONF_ATTRIBUTE_LABEL, coverageCount: 1, totalModels: 2, coverageRatio: 0.5 }],
  cells: [
    {
      subjectId: "subj-1",
      subject: SNAP.M2_SUBJECT_LABEL,
      attributeId: "attr-1",
      attribute: SNAP.M2_ATTRIBUTE_LABEL,
      valuesByModel: { chatgpt: SNAP.M2_CELL_VALUE, claude: "ordinary", grok: "ordinary", perplexity: "ordinary", gemini: "ordinary" },
      coverageCount: 2,
      totalModels: 2,
      coverageRatio: 1,
      agreement: "consensus",
      consensusValue: SNAP.M2_CELL_CONSENSUS,
      verdictTally: { better: 1 },
      rationale: SNAP.M2_CELL_RATIONALE,
      sources: [SNAP.M2_CELL_SOURCE],
    },
  ],
  hasVerifiedSourceData: false,
  totalModels: 2,
  directConclusion: SNAP.M2_DIRECT_CONCLUSION,
  tradeoffs: [SNAP.M2_TRADEOFF],
  bestUseRecommendations: [SNAP.M2_BEST_USE],
  uncertainties: [SNAP.M2_RESULT_UNCERTAINTY],
} satisfies ComparisonMatrixResult;

/**
 * ─── RECURSIVE HOSTILE reportSnapshot FIXTURES ────────────────────────────
 *
 * THE PERMANENT RULE, sharpened by R4: a projected leaf is caught IF AND ONLY IF
 * its fixture value SERIALIZES. `JSON.stringify` drops `undefined`-valued keys,
 * so an undefined leaf defeats BOTH detection mechanisms — the sentinel AND the
 * exact key-set allow-list, because `Object.keys()` on the parsed response never
 * sees the key either. R3's fix populated the branches; R4 found every remaining
 * OPTIONAL leaf and every EMPTY ARRAY still invisible, including the most
 * sensitive content in the system: verbatim model excerpts, disagreement
 * positions and bias evidence. `null` and `[]` serialize and are therefore safe;
 * `undefined` is not.
 *
 * So: every proof-relevant optional leaf holds a value, and every content-bearing
 * array holds at least one populated element.
 *
 * Shapes come from `buildExportSnapshot` (`lib/adaptiveSchema/exportSnapshot.ts`)
 * and the types it writes.
 *
 * `satisfies` HERE ENFORCES NOTHING — retracted claim, stated plainly. An earlier
 * revision said it "pins required leaves at compile time (the Quality Gate runs
 * `tsc --noEmit`)". Disproved: `tsconfig.json` excludes every spec file by glob,
 * `tsc --listFilesOnly` lists zero route-spec files, ts-jest transpiles without
 * type-checking, and `const x: number = "a string"` inserted here gives `tsc` exit
 * 0 with Jest green. Treat every `satisfies` in this file as editor assistance
 * only. Nothing in the secrecy proof depends on it: E2A-S8A traps the source read
 * at the root, which needs no type-level guarantee about the fixture. `result` is
 * `unknown` at the snapshot boundary and its union has NINE members; only
 * `ComparisonMatrixResult` is instantiated, and no coverage of the other eight is
 * claimed — E2A-S8A makes that census unnecessary.
 *
 * `M2_RESULT` is still typed `satisfies ComparisonMatrixResult`
 * rather than leaning on `result: unknown` — R4 found the previous fixture paired
 * `schemaId: "comparison_matrix"` with `{ executiveSummary }`, a field that type
 * does not have (it belongs to `DeepResearchResult`), so the single result
 * sentinel sat at a path production cannot produce while all six real result
 * leaves were absent and invisible.
 *
 * A NOTE ON `meta`: the two builders populate different halves.
 * `buildCommonResponseMeta` always writes the execution fields (`totalModels` …
 * `sourceCoverage`, `limitations`) and always writes `uncertainties: []`,
 * `blindSpots: []`, `dataBasis: "training_prior"`,
 * `evidenceQuality: "not_applicable"`; `buildCommonMeta` (`commonMeta.ts:31-36`)
 * is what writes `consensusSummary`, `disagreementSummary` and
 * `recommendedNextAction` — but only onto `GracefulLimitationResponse.meta`,
 * NEVER a `PersistedAdaptiveOutputV1`. So this fixture is NOT a union of both
 * builders: an earlier revision said it was, which was false. It carries only
 * what `buildCommonResponseMeta` — the sole producer of this persisted path —
 * actually writes.
 */
const MILESTONE2_SNAPSHOT = {
  question: SNAP.QUESTION,
  models: [{ modelId: "chatgpt" as ModelId, ok: true }],
  reportTypeLabel: SNAP.REPORT_TYPE_LABEL,
  consensusLevel: "split",
  sourceGroundingLevel: "weak",
  reportGeneratedAt: SNAP.GENERATED_AT,
  milestone2: {
    schemaId: "comparison_matrix",
    result: M2_RESULT,
    meta: {
      schemaVersion: 1,
      queryType: "comparison_matrix",
      answerShape: "comparison_grid",
      dataBasis: "training_prior",
      freshness: "timeless",
      riskLevel: "professional",
      evidenceQuality: "not_applicable",
      // R5/§24: an earlier revision put sentinels on `consensusSummary`,
      // `disagreementSummary` and `recommendedNextAction` and attributed them to
      // `buildCommonMeta`. Source-traced, that attribution is FALSE:
      // `buildCommonMeta` has one caller (`routeClassifiedQuery.ts`) and writes
      // only onto `GracefulLimitationResponse.meta`, NEVER a
      // `PersistedAdaptiveOutputV1`. The sole producer of THIS persisted path is
      // `buildCommonResponseMeta`, which never writes those three and always
      // writes `uncertainties: []` / `blindSpots: []`. The fixture now matches
      // the real writer instead of inventing a superset, and the three invented
      // inventory paths are gone.
      uncertainties: [],
      blindSpots: [],
      humanReviewNeeded: true,
      generatedAt: SNAP.GENERATED_AT,
      schemaId: "comparison_matrix",
      routingKind: "active",
      totalModels: NUM.M2_TOTAL_MODELS,
      successfulModels: NUM.M2_SUCCESSFUL,
      failedModels: NUM.M2_FAILED,
      modelsWithUsableOutput: NUM.M2_USABLE,
      sourceBacked: true,
      sourceCoverage: { supportedUnits: NUM.M2_SOURCE_SUPPORTED, totalUnits: NUM.M2_SOURCE_TOTAL, ratio: NUM.M2_SOURCE_RATIO },
      limitations: [SNAP.M2_META_LIMITATION],
      executionStatus: "partial",
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

const LEGACY_CELL = {
  modelId: "chatgpt" as ModelId,
  stance: "agrees",
  rawStance: "asserts",
  confidence: "majority_view",
  camps: [{ label: SNAP.LEGACY_CELL_CAMP_LABEL, position: SNAP.LEGACY_CELL_CAMP_POSITION }],
  excerpt: SNAP.LEGACY_CELL_EXCERPT,
  evidenceType: "empirical",
  backfilled: false,
  // R5: `raw` carries real model content — `fieldAlignment.ts` writes a Metric,
  // Scenario or Step here, and `Scenario.narrative` can be tens of words of model
  // prose while `Metric.source` is a citation. Populated as integration evidence.
  // It is NOT the proof: E2A-S8A blocks the root read regardless.
  raw: { label: SNAP.LEGACY_RAW_METRIC_LABEL, value: 1, unit: SNAP.LEGACY_RAW_METRIC_UNIT, asOf: "2026", source: SNAP.LEGACY_RAW_METRIC_SOURCE },
} satisfies AlignedClaimCell;

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
      {
        id: SNAP.LEGACY_CLAIM_ID,
        claimText: SNAP.LEGACY_CLAIM_TEXT,
        cells: [LEGACY_CELL],
        agreementScore: 0.5,
        certaintyScore: 0.5,
        status: "split",
        disagreementType: SNAP.LEGACY_CLAIM_DISAGREEMENT_TYPE,
      },
    ],
    gate: {
      status: "caution",
      runCertainty: 0.5,
      loadBearingSplitCount: 1,
      loadBearingClaims: [
        {
          id: "gate-claim-1",
          claimText: SNAP.LEGACY_GATE_CLAIM_TEXT,
          cells: [{ ...LEGACY_CELL, excerpt: SNAP.LEGACY_GATE_CELL_EXCERPT }],
          agreementScore: 0.1,
          certaintyScore: 0.1,
          status: "split",
        },
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
      disagreements: [
        {
          topic: SNAP.LEGACY_DIS_TOPIC,
          whyTheyDiffer: SNAP.LEGACY_DIS_WHY,
          positions: [{ modelId: "chatgpt" as ModelId, position: SNAP.LEGACY_DIS_POSITION }],
          stakes: "decision-critical",
        },
      ],
      biasAndBlindSpots: [
        {
          biasType: SNAP.LEGACY_BIAS_TYPE,
          description: SNAP.LEGACY_BIAS_DESCRIPTION,
          modelsImplicated: ["chatgpt" as ModelId],
          evidence: [{ modelId: "chatgpt" as ModelId, excerpt: SNAP.LEGACY_BIAS_EXCERPT, rationale: SNAP.LEGACY_BIAS_RATIONALE }],
          likelyCauses: [SNAP.LEGACY_BIAS_CAUSE],
          impact: SNAP.LEGACY_BIAS_IMPACT,
          mitigationSteps: [SNAP.LEGACY_BIAS_MITIGATION],
        },
      ],
      biasEmptyReason: null,
      panelCoverageGaps: [{ dimension: SNAP.LEGACY_GAP_DIMENSION, whyItMatters: SNAP.LEGACY_GAP_WHY, followUpQuestion: SNAP.LEGACY_GAP_FOLLOWUP }],
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
        keyDisagreement: SNAP.LEGACY_VERDICT_KEY_DISAGREEMENT,
        disagreementDetail: SNAP.LEGACY_VERDICT_DETAIL,
        disagreementModelCount: 1,
        caveat: SNAP.LEGACY_VERDICT_CAVEAT,
        recommendedNextSteps: [SNAP.LEGACY_VERDICT_NEXT_STEP],
      },
      degraded: true,
    },
    trustSummary: {
      perModel: [
        {
          modelId: "chatgpt" as ModelId,
          claimsContributed: NUM.TRUST_CLAIMS,
          majorityAlignment: NUM.TRUST_MAJORITY,
          citationScore: NUM.TRUST_CITATION,
          contradictionCount: NUM.TRUST_CONTRADICTIONS,
          parseHealth: "degraded",
          trustScore: NUM.TRUST_SCORE,
          capped: true,
        },
      ],
      overallTrust: NUM.TRUST_OVERALL,
    },
    modelResponses: [
      {
        modelId: "chatgpt" as ModelId,
        schemaId: "financial_valuation",
        ok: false,
        // an open `Record<string, AdaptiveFieldValue>`; two realistic keys as
        // integration evidence. Exhaustive coverage of an open record is
        // impossible, which is exactly why E2A-S8A is the proof and this is not.
        data: { thesis: SNAP.LEGACY_MODEL_THESIS, bullCase: SNAP.LEGACY_MODEL_BULL_CASE },
        parseError: SNAP.LEGACY_MODEL_PARSE_ERROR,
        truncatedFields: [SNAP.LEGACY_MODEL_TRUNCATED_FIELD],
        invalidFields: [SNAP.LEGACY_MODEL_INVALID_FIELD],
        coercions: [
          { modelId: "chatgpt" as ModelId, schemaId: "financial_valuation", field: "stance", path: SNAP.LEGACY_COERCION_PATH, raw: SNAP.LEGACY_COERCION_RAW, coerced: SNAP.LEGACY_COERCION_COERCED },
        ],
        retried: true,
        latencyMs: NUM.LEGACY_MODEL_LATENCY,
      },
    ],
  },
} satisfies AdaptiveExportReportSnapshot;

/**
 * ─── THE SELF-CHECK INVENTORY ─────────────────────────────────────────────
 * Every path the non-disclosure proof relies on, with the kind of evidence it
 * carries. `string`/`number` entries are detectable in a serialized response;
 * `present` entries are structural (enums, ids) and rely on the key-set
 * allow-list, but are still enumerated so that DELETING them breaks the
 * self-check — R4 found `trustSummary` had no entry at all, so removing it from
 * the fixture passed 77/77 and then projecting it became invisible.
 */
type SentinelKind = "string" | "number" | "present";
const snapshotSentinelPaths = (snapshot: AdaptiveExportReportSnapshot): [string, unknown, SentinelKind][] => {
  const m2 = snapshot.milestone2;
  const lg = snapshot.legacy;
  const out: [string, unknown, SentinelKind][] = [
    ["question", snapshot.question, "string"],
    ["reportTypeLabel", snapshot.reportTypeLabel, "string"],
    ["reportGeneratedAt", snapshot.reportGeneratedAt, "present"],
    ["consensusLevel", snapshot.consensusLevel, "present"],
    ["sourceGroundingLevel", snapshot.sourceGroundingLevel, "present"],
    ["models[0].modelId", snapshot.models[0]?.modelId, "present"],
  ];
  if (m2) {
    const res = m2.result as ComparisonMatrixResult;
    const meta = m2.meta;
    const rec = m2.decisionReceipt;
    out.push(
      ["milestone2.schemaId", m2.schemaId, "present"],
      ["milestone2.result.directConclusion", res.directConclusion, "string"],
      ["milestone2.result.tradeoffs[0]", res.tradeoffs[0], "string"],
      ["milestone2.result.bestUseRecommendations[0]", res.bestUseRecommendations[0], "string"],
      ["milestone2.result.uncertainties[0]", res.uncertainties[0], "string"],
      ["milestone2.result.subjects[0].label", res.subjects[0]?.label, "string"],
      ["milestone2.result.lowConfidenceSubjects[0].label", res.lowConfidenceSubjects[0]?.label, "string"],
      ["milestone2.result.attributes[0].label", res.attributes[0]?.label, "string"],
      ["milestone2.result.lowConfidenceAttributes[0].label", res.lowConfidenceAttributes[0]?.label, "string"],
      ["milestone2.result.cells[0].valuesByModel.chatgpt", res.cells[0]?.valuesByModel.chatgpt, "string"],
      ["milestone2.result.cells[0].consensusValue", res.cells[0]?.consensusValue, "string"],
      ["milestone2.result.cells[0].rationale", res.cells[0]?.rationale, "string"],
      ["milestone2.result.cells[0].sources[0]", res.cells[0]?.sources?.[0], "string"],
      ["milestone2.meta.limitations[0]", meta.limitations?.[0], "string"],
      ["milestone2.meta.totalModels", meta.totalModels, "number"],
      ["milestone2.meta.successfulModels", meta.successfulModels, "number"],
      ["milestone2.meta.failedModels", meta.failedModels, "number"],
      ["milestone2.meta.modelsWithUsableOutput", meta.modelsWithUsableOutput, "number"],
      ["milestone2.meta.sourceCoverage.supportedUnits", meta.sourceCoverage?.supportedUnits, "number"],
      ["milestone2.meta.sourceCoverage.totalUnits", meta.sourceCoverage?.totalUnits, "number"],
      ["milestone2.meta.sourceCoverage.ratio", meta.sourceCoverage?.ratio, "number"],
      ["milestone2.meta.executionStatus", meta.executionStatus, "present"],
      ["milestone2.meta.sourceBacked", meta.sourceBacked, "present"],
      ["milestone2.decisionReceipt.conclusion", rec?.conclusion, "string"],
      ["milestone2.decisionReceipt.basis[0]", rec?.basis[0], "string"],
      ["milestone2.decisionReceipt.assumptions[0]", rec?.assumptions[0], "string"],
      ["milestone2.decisionReceipt.uncertainties[0]", rec?.uncertainties[0], "string"],
      ["milestone2.decisionReceipt.limitations[0]", rec?.limitations[0], "string"],
      ["milestone2.decisionReceipt.sources[0]", rec?.sources[0], "string"]
    );
  }
  if (lg) {
    const sr = lg.synthesisReport;
    const claim = lg.alignedClaims[0];
    const cell = claim?.cells[0];
    const trust = lg.trustSummary;
    const mr = lg.modelResponses?.[0];
    out.push(
      ["legacy.schemaId", lg.schemaId, "present"],
      ["legacy.alignedClaims[0].id", claim?.id, "string"],
      ["legacy.alignedClaims[0].claimText", claim?.claimText, "string"],
      ["legacy.alignedClaims[0].disagreementType", claim?.disagreementType, "string"],
      ["legacy.alignedClaims[0].cells[0].excerpt", cell?.excerpt, "string"],
      ["legacy.alignedClaims[0].cells[0].camps[0].label", cell?.camps?.[0]?.label, "string"],
      ["legacy.alignedClaims[0].cells[0].camps[0].position", cell?.camps?.[0]?.position, "string"],
      ["legacy.alignedClaims[0].cells[0].raw.label", (cell?.raw as { label?: string } | undefined)?.label, "string"],
      ["legacy.alignedClaims[0].cells[0].raw.source", (cell?.raw as { source?: string } | undefined)?.source, "string"],
      ["legacy.gate.loadBearingClaims[0].claimText", lg.gate?.loadBearingClaims[0]?.claimText, "string"],
      ["legacy.gate.loadBearingClaims[0].cells[0].excerpt", lg.gate?.loadBearingClaims[0]?.cells[0]?.excerpt, "string"],
      ["legacy.synthesisReport.unifiedAnswer", sr?.unifiedAnswer, "string"],
      ["legacy.synthesisReport.panelVerdict", sr?.panelVerdict, "string"],
      ["legacy.synthesisReport.executiveSummary", sr?.executiveSummary, "string"],
      ["legacy.synthesisReport.certaintyAssessment", sr?.certaintyAssessment, "string"],
      ["legacy.synthesisReport.whereModelsAgree[0]", sr?.whereModelsAgree[0], "string"],
      ["legacy.synthesisReport.whereModelsDisagree[0]", sr?.whereModelsDisagree[0], "string"],
      ["legacy.synthesisReport.narrativeSections[0].title", sr?.narrativeSections[0]?.title, "string"],
      ["legacy.synthesisReport.narrativeSections[0].body", sr?.narrativeSections[0]?.body, "string"],
      ["legacy.synthesisReport.disagreements[0].topic", sr?.disagreements[0]?.topic, "string"],
      ["legacy.synthesisReport.disagreements[0].whyTheyDiffer", sr?.disagreements[0]?.whyTheyDiffer, "string"],
      ["legacy.synthesisReport.disagreements[0].positions[0].position", sr?.disagreements[0]?.positions[0]?.position, "string"],
      ["legacy.synthesisReport.biasAndBlindSpots[0].biasType", sr?.biasAndBlindSpots[0]?.biasType, "string"],
      ["legacy.synthesisReport.biasAndBlindSpots[0].description", sr?.biasAndBlindSpots[0]?.description, "string"],
      ["legacy.synthesisReport.biasAndBlindSpots[0].evidence[0].excerpt", sr?.biasAndBlindSpots[0]?.evidence[0]?.excerpt, "string"],
      ["legacy.synthesisReport.biasAndBlindSpots[0].evidence[0].rationale", sr?.biasAndBlindSpots[0]?.evidence[0]?.rationale, "string"],
      ["legacy.synthesisReport.biasAndBlindSpots[0].likelyCauses[0]", sr?.biasAndBlindSpots[0]?.likelyCauses[0], "string"],
      ["legacy.synthesisReport.biasAndBlindSpots[0].impact", sr?.biasAndBlindSpots[0]?.impact, "string"],
      ["legacy.synthesisReport.biasAndBlindSpots[0].mitigationSteps[0]", sr?.biasAndBlindSpots[0]?.mitigationSteps[0], "string"],
      ["legacy.synthesisReport.panelCoverageGaps[0].dimension", sr?.panelCoverageGaps[0]?.dimension, "string"],
      ["legacy.synthesisReport.panelCoverageGaps[0].whyItMatters", sr?.panelCoverageGaps[0]?.whyItMatters, "string"],
      ["legacy.synthesisReport.panelCoverageGaps[0].followUpQuestion", sr?.panelCoverageGaps[0]?.followUpQuestion, "string"],
      ["legacy.synthesisReport.verdictCard.topConsensus", sr?.verdictCard.topConsensus, "string"],
      ["legacy.synthesisReport.verdictCard.keyDisagreement", sr?.verdictCard.keyDisagreement, "string"],
      ["legacy.synthesisReport.verdictCard.disagreementDetail", sr?.verdictCard.disagreementDetail, "string"],
      ["legacy.synthesisReport.verdictCard.caveat", sr?.verdictCard.caveat, "string"],
      ["legacy.synthesisReport.verdictCard.recommendedNextSteps[0]", sr?.verdictCard.recommendedNextSteps[0], "string"],
      ["legacy.trustSummary.overallTrust", trust?.overallTrust, "number"],
      ["legacy.trustSummary.perModel[0].modelId", trust?.perModel[0]?.modelId, "present"],
      ["legacy.trustSummary.perModel[0].claimsContributed", trust?.perModel[0]?.claimsContributed, "number"],
      ["legacy.trustSummary.perModel[0].majorityAlignment", trust?.perModel[0]?.majorityAlignment, "number"],
      ["legacy.trustSummary.perModel[0].citationScore", trust?.perModel[0]?.citationScore, "number"],
      ["legacy.trustSummary.perModel[0].contradictionCount", trust?.perModel[0]?.contradictionCount, "number"],
      ["legacy.trustSummary.perModel[0].trustScore", trust?.perModel[0]?.trustScore, "number"],
      ["legacy.trustSummary.perModel[0].parseHealth", trust?.perModel[0]?.parseHealth, "present"],
      ["legacy.modelResponses[0].data.thesis", (mr?.data as { thesis?: string } | null | undefined)?.thesis, "string"],
      ["legacy.modelResponses[0].data.bullCase", (mr?.data as { bullCase?: string } | null | undefined)?.bullCase, "string"],
      ["legacy.modelResponses[0].parseError", mr?.parseError, "string"],
      ["legacy.modelResponses[0].truncatedFields[0]", mr?.truncatedFields?.[0], "string"],
      ["legacy.modelResponses[0].invalidFields[0]", mr?.invalidFields?.[0], "string"],
      ["legacy.modelResponses[0].coercions[0].raw", mr?.coercions?.[0]?.raw, "string"],
      ["legacy.modelResponses[0].coercions[0].coerced", mr?.coercions?.[0]?.coerced, "string"],
      ["legacy.modelResponses[0].coercions[0].path", mr?.coercions?.[0]?.path, "string"],
      ["legacy.modelResponses[0].latencyMs", mr?.latencyMs, "number"]
    );
  }
  return out;
};

const NUMERIC_SENTINELS: readonly number[] = Object.values(NUM);

const assertSnapshotSentinelsReachable = (snapshot: AdaptiveExportReportSnapshot) => {
  for (const [path, value, kind] of snapshotSentinelPaths(snapshot)) {
    if (value === undefined || value === null) {
      throw new Error(`fixture value ABSENT at ${path} (got ${String(value)}) — an undefined leaf proves nothing, it serializes to nothing`);
    }
    if (kind === "string" && !(typeof value === "string" && value.startsWith("SENTINEL_"))) {
      throw new Error(`fixture sentinel missing at ${path}: got ${JSON.stringify(value)}`);
    }
    if (kind === "number" && !(typeof value === "number" && NUMERIC_SENTINELS.includes(value))) {
      throw new Error(`fixture numeric sentinel missing at ${path}: got ${JSON.stringify(value)}`);
    }
  }
};

/** The detectable needles of ONE family: string sentinels plus numeric sentinels rendered as they serialize. `present`-kind paths are excluded — they carry no distinctive value and are covered by the exact key-set allow-list. */
const familySentinels = (snapshot: AdaptiveExportReportSnapshot): [string, string][] =>
  snapshotSentinelPaths(snapshot)
    .filter(([, , kind]) => kind !== "present")
    .map(([path, value]) => [path, String(value)] as [string, string]);

/** Every needle that must never appear in a response — derived FROM THE FIXTURES, so adding a leaf cannot be forgotten here. Numeric sentinels are included as strings, because a projected number serializes just as a string does. */
const allSnapshotSentinels = () => {
  const needles: string[] = [];
  for (const snap of [MILESTONE2_SNAPSHOT, LEGACY_SNAPSHOT] as AdaptiveExportReportSnapshot[]) {
    for (const [, value, kind] of snapshotSentinelPaths(snap)) {
      if (kind === "string" && typeof value === "string") needles.push(value);
      if (kind === "number" && typeof value === "number") needles.push(String(value));
    }
  }
  return Array.from(new Set(needles));
};

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
 * Representative non-DTO fields carry sentinel VALUES (never a type name —
 * `"milestone2"` could not serve, since `schemaFamily` legitimately carries it).
 * This is deliberately NOT an exhaustive-sentinel claim: several non-DTO fields
 * hold ordinary values, and secrecy does not rest on this fixture at all. It rests
 * on E2A-S8A (the projection never READS a forbidden source) plus E2A-S8B (deep
 * equality on the response); these records are integration evidence that the
 * route behaves correctly against realistic data.
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
  // §14: a realistic FUTURE persisted field, deliberately absent from the
  // allowed-read policy. It is not "forbidden" either — the point is that the
  // Proxy is DEFAULT-DENY, so the route reading anything off-policy is caught
  // without the test pretending to know the type's future shape.
  futurePrivateField: "SENTINEL_FUTURE_PRIVATE_FIELD",
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
/** Raw logical results only — instrumentation is applied at the mock boundary above, so this helper cannot opt out and neither can any other call site. */
const listFake = (records = [exportRecord(3), exportRecord(2)], hasMore = false) =>
  async (runId: string) => (runId === RUN ? { ok: true, records, hasMore } : { ok: true, records: [], hasMore: false });


/**
 * ─── E2A-S8A: THE SOURCE-ACCESS TRAP (primary secrecy mechanism) ──────────
 *
 * WHY THIS REPLACED RECURSIVE FIXTURE COMPLETENESS. Five review rounds each
 * found the *next* missing leaf, because an exhaustive hand-maintained
 * inventory of `reportSnapshot` cannot be made safe: an `undefined` optional
 * leaf, an empty array, an open `Record`, an `unknown`-typed field, an
 * uncovered member of a 9-variant union, or any newly added nested field all
 * make a sentinel-based proof vacuous, and `JSON.stringify` erases the
 * difference between "absent from the response" and "absent from the fixture".
 *
 * The stronger invariant does not depend on the shape of the data at all:
 *
 *      THE LIST PROJECTION NEVER READS `reportSnapshot`.
 *
 * If the source property is never consulted, no leaf beneath it can reach the
 * response — at any depth, for any variant, for any field added later. The
 * mechanism is a `Proxy` around each record the list helper returns, which
 * RECORDS every property access. Recording (rather than throwing) is
 * deliberate: a throw could in principle be caught and swallowed by the code
 * under test, whereas the push into `sourceReads` has already happened by the
 * time any handler runs, and it names the offending property precisely instead
 * of collapsing the whole suite.
 *
 * `ownKeys` / `getOwnPropertyDescriptor` are trapped too, because a future
 * refactor could bypass a `get`-only trap with `{ ...record }`,
 * `Object.assign({}, record)` or `Object.entries(record)` — none of which
 * touches `reportSnapshot` by name.
 *
 * THE LEDGER below is derived from the route's actual projection, not from
 * intent. Anything the projection legitimately consumes is ALLOWED; everything
 * else the persisted record carries is FORBIDDEN, so consuming it in future
 * has to be a deliberate, visible change to this list.
 */
/**
 * §15 — THE ALLOWED-READ POLICY. This is NOT a mirror of
 * `AdaptiveResearchExportV1` (that claim was withdrawn in R7); it is the set of
 * persistence-record properties this endpoint is authorized to consult. The Proxy
 * mode is DEFAULT-DENY, so anything absent — including a field added to the type
 * tomorrow — fails when read.
 *
 *   | source property           | LIST may read? | reason                        |
 *   |---------------------------|----------------|-------------------------------|
 *   | exportId                  | yes            | → DTO.exportId                |
 *   | reportVersion             | yes            | → DTO + continuation cursor   |
 *   | schemaId / schemaFamily   | yes            | → DTO                         |
 *   | format                    | yes            | → DTO + isHashReproducible()  |
 *   | artifactStatus            | yes            | → DTO                         |
 *   | createdAt / createdBy     | yes            | → DTO (metadata, not authority)|
 *   | classification            | yes            | → DTO                         |
 *   | governanceStatusAtExport  | yes            | → DTO (copied wholesale)      |
 *   | exportMetadata            | yes            | fileHash trio ONLY            |
 *   | reportSnapshot            | NO             | the frozen report content     |
 *   | generatedBy               | NO             | creator display name + email  |
 *   | failureReason             | NO             | internal failure text         |
 *   | version / runId / schemaVersion | NO       | not DTO fields                |
 *   | anything else             | NO             | default deny                  |
 */
const ALLOWED_SOURCE_PROPS: readonly string[] = [
  "exportId",                 // → DTO.exportId
  "reportVersion",            // → DTO.reportVersion, and the continuation cursor
  "schemaId",                 // → DTO.schemaId
  "schemaFamily",             // → DTO.schemaFamily
  "format",                   // → DTO.format, and isHashReproducible()
  "artifactStatus",           // → DTO.artifactStatus
  "createdAt",                // → DTO.createdAt
  "createdBy",                // → DTO.createdBy (metadata, never authority)
  "classification",           // → DTO.classification
  "governanceStatusAtExport", // → DTO.governanceStatusAtExport
  "exportMetadata",           // → fileHash / hashAlgorithm / hashReproducible ONLY
];
/** Every other property `AdaptiveResearchExportV1` actually carries. `reportSnapshot` is the one this invariant is named for; the rest are forbidden because the DTO does not consume them, so a future read is a deliberate contract change rather than a silent one. */
const FORBIDDEN_SOURCE_PROPS: readonly string[] = [
  "reportSnapshot", // the frozen report content — the whole point
  "generatedBy",    // the creator's frozen display name + masked email
  "failureReason",  // internal failure text
  "version",        // contract version, not a DTO field
  "runId",          // the envelope carries the route's own runId, not the record's
  "schemaVersion",  // not a DTO field
];

/**
 * R8 §3/§4 — WHY THERE IS A SINK ABSTRACTION.
 *
 * R7's blocker: instrumentation was universal but CHECKING it was opt-in per
 * test, so any input class whose tests forgot `expectNoForbiddenSourceAccess()`
 * was unprotected — and the class list omitted every `reportVersion` variant and
 * `format: "json"`. A leak gated on `r.reportVersion === 0` put the whole frozen
 * report on the wire with 106/106 green.
 *
 * The fix is a GLOBAL `afterEach` that asserts the tracker for EVERY test. That
 * creates one problem: the mechanism self-tests deliberately trigger forbidden
 * access, and they must not be exempted by a flag — `skipSecurityCheck` would
 * recreate the opt-out defect in a new shape. So instead of a flag, those tests
 * pass their OWN sink. The global sink is what the global postcondition watches;
 * a local sink is invisible to it. There is no way to silence the global check.
 */
/**
 * R9 §17/§18 — NESTED READS ARE RECORDED STRUCTURALLY, NOT BY STRING PREFIX.
 * An earlier revision labelled container reads `rec0.exportMetadata.<prop>` and
 * then had the default-deny filter skip every recorded name containing a `.` —
 * which meant a DOTTED TOP-LEVEL property escaped the policy entirely.
 * `r["exportMetadata.fileHash"]` passed the whole suite, and that is not a
 * hypothetical name: these records historically carried exactly that flat key.
 * A property name is not safe because it looks like Firestore path notation. Top
 * level and nested are now separate arrays, so the policy compares exact property
 * names with no syntax heuristic of any kind.
 */
type AccessSink = { reads: string[]; nested: string[]; forbidden: string[]; enumerations: string[] };
const newSink = (): AccessSink => ({ reads: [], nested: [], forbidden: [], enumerations: [] });

/**
 * R9 §11/§12 — THE SINK BINDING IS IMMUTABLE. R8 showed the universal
 * postcondition could be disarmed in three lines: `globalSink` was a reassignable
 * `let`, and Jest runs inner `afterEach` hooks BEFORE outer ones, so an inner
 * `afterEach(() => { globalSink = newSink(); })` emptied the tracker before the
 * global check read it. An unconditional clone leak went from 15 failures to
 * green. The binding is now `const`; `resetGlobalSink()` clears the arrays IN
 * PLACE so instrumentation and postcondition always share one identity, and the
 * postcondition asserts that identity at runtime rather than trusting `const`.
 */
const GLOBAL_SINK: AccessSink = newSink();
const globalSink = GLOBAL_SINK;
const resetGlobalSink = () => {
  GLOBAL_SINK.reads.length = 0;
  GLOBAL_SINK.nested.length = 0;
  GLOBAL_SINK.forbidden.length = 0;
  GLOBAL_SINK.enumerations.length = 0;
};

/**
 * Two INDEPENDENT mechanisms, selected by `trapMode`, because R6 proved neither
 * covers every JavaScript operation:
 *
 *   "proxy"    — default-deny Proxy. Sees explicit reads, destructuring,
 *                `Reflect.get`, unclassified-property reads, and enumeration via
 *                `ownKeys`/`getOwnPropertyDescriptor`.
 *                BLIND SPOT (R6 P1-2): `structuredClone(proxy)` throws
 *                `DataCloneError` BEFORE any trap runs — zero traps fire — so a
 *                production `try { structuredClone(r).reportSnapshot } catch {}`
 *                passed green while leaking in production, where records are
 *                plain objects.
 *
 *   "accessor" — plain-object tripwire. A real plain object (NOT proxied, which
 *                is the point) whose forbidden properties are `defineProperty`
 *                getters that RECORD the access and return the real value. This
 *                is what production looks like, so `structuredClone`,
 *                `JSON.stringify`, spread, `Object.values`/`entries`/`assign` all
 *                traverse it and fire the getter without throwing.
 *
 * Both RECORD rather than throw (§11): a production mutation may catch an
 * exception, and a caught exception must not erase the proof that forbidden data
 * was reached. The recorded flag is checked as a postcondition.
 */
/**
 * R9 §2/§3 — ACCESSOR IS THE ORDINARY DEFAULT, PROXY IS A SUPPLEMENT.
 *
 * R8's finding: accessor mode — the only mode that observes value-obtaining
 * operations on a plain object (`structuredClone`, `v8.serialize`,
 * `util.inspect`, getter traversal), because `structuredClone(proxy)` throws
 * `DataCloneError` before any trap runs — reached the route through 15
 * record-shape rows in ONE request context. Clone leaks gated on an unfiled run,
 * `?cursor=`, a reviewer role or a degraded Project were invisible.
 *
 * So accessor is now the default for EVERY ordinary route test, and the Proxy
 * runs as an additional focused matrix for the classes only it observes
 * (enumeration, descriptor access, off-policy top-level reads). There is no
 * `"none"` mode and no bypass flag: an ordinary test cannot end up uninstrumented
 * or instrumented in the weaker mode by omission.
 */
let trapMode: "proxy" | "accessor" = "accessor";

/**
 * R7 P2-3 — AN ALLOWED CONTAINER IS NOT AN ALLOWED SUBTREE. `exportMetadata` is
 * on the allowed list, but the DTO consumes exactly ONE field of it. The rest —
 * `requestingUser`, `exportedSections`, `finalReportVersion`, `runId`,
 * `schemaVersion` — are persisted data the response has no business reading, and
 * a depth-1 policy could not see them: `void r.exportMetadata?.requestingUser`
 * passed the whole suite. The container is therefore trapped one level deep with
 * its own allow-list.
 */
const ALLOWED_EXPORT_METADATA_PROPS: readonly string[] = ["fileHash"];

const trapContainer = (value: unknown, label: string, allowed: readonly string[], sink: AccessSink): unknown => {
  if (value === null || typeof value !== "object") return value;
  return new Proxy(value as Record<string, unknown>, {
    get(target, prop, receiver) {
      if (typeof prop === "string") {
        sink.nested.push(`${label}:${prop}`); // structural: never mixed with top-level names
        if (!allowed.includes(prop)) sink.forbidden.push(`${label}:${prop}`);
      }
      return Reflect.get(target, prop, receiver);
    },
    ownKeys(target) {
      sink.enumerations.push(`ownKeys(${label})`);
      return Reflect.ownKeys(target);
    },
  });
};

const trapRecord = (record: Record<string, unknown>, label: string, sink: AccessSink = globalSink): Record<string, unknown> =>
  new Proxy(record, {
    get(target, prop, receiver) {
      if (typeof prop === "string") {
        sink.reads.push(prop);
        if (FORBIDDEN_SOURCE_PROPS.includes(prop)) sink.forbidden.push(`${label}.${prop}`);
        if (prop === "exportMetadata") {
          return trapContainer(Reflect.get(target, prop, receiver), `${label}.exportMetadata`, ALLOWED_EXPORT_METADATA_PROPS, sink);
        }
      }
      return Reflect.get(target, prop, receiver);
    },
    ownKeys(target) {
      // fires on { ...record }, Object.keys/entries/assign, JSON.stringify(record)
      sink.enumerations.push(`ownKeys(${label})`);
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, prop) {
      if (typeof prop === "string") sink.enumerations.push(`descriptor(${label}:${prop})`);
      return Reflect.getOwnPropertyDescriptor(target, prop);
    },
  });

/**
 * Mechanism B — the plain-object accessor tripwire. Deliberately NOT wrapped in
 * the Proxy: R6 showed `structuredClone` rejects a Proxy before traversing it, so
 * the clone proof has to run against a genuine plain object.
 */
const accessorRecord = (record: Record<string, unknown>, label: string, sink: AccessSink = globalSink): Record<string, unknown> => {
  const plain: Record<string, unknown> = {};
  // EVERY own property becomes a recording accessor, not just the forbidden ones.
  // R8: an earlier revision left allowed properties as plain data, so in accessor
  // mode `sink.reads` stayed empty — which meant this mode had no non-vacuity
  // signal that the projection had run AND no default-deny coverage for
  // off-policy reads. Recording every read makes the two modes symmetric in what
  // they can assert, differing only in which OPERATIONS reach them.
  for (const [prop, value] of Object.entries(record)) {
    Object.defineProperty(plain, prop, {
      enumerable: true, // production records enumerate these; the tripwire must too
      configurable: true,
      get() {
        sink.reads.push(prop);
        if (FORBIDDEN_SOURCE_PROPS.includes(prop)) sink.forbidden.push(`${label}.${prop}`);
        if (prop === "exportMetadata") {
          return trapContainer(value, `${label}.exportMetadata`, ALLOWED_EXPORT_METADATA_PROPS, sink);
        }
        return value;
      },
    });
  }
  return plain;
};

/** §3 — the single instrumentation boundary. Every list result from the mocked helper passes through here, whatever a test resolved. */
const instrumentListResult = (result: unknown): unknown => {
  const r = result as { ok?: boolean; records?: unknown[] } | null;
  if (!r || r.ok !== true || !Array.isArray(r.records)) return result;
  const wrap = trapMode === "accessor" ? accessorRecord : trapRecord;
  return { ...r, records: r.records.map((rec, i) => wrap(rec as Record<string, unknown>, `rec${i}`)) };
};

/**
 * THE UNIVERSAL E2A-S8A POSTCONDITION (§3). Registered as a global `afterEach`
 * below, so it runs for EVERY test in this file whether or not that test thought
 * about security. This is the whole point: R7 showed that a per-test assertion is
 * only as good as the author's memory, and the memory failed for every
 * `reportVersion` variant and for `format: "json"`.
 *
 * It asserts three things about the global sink:
 *   • no FORBIDDEN source property was read;
 *   • the record was never enumerated/spread wholesale;
 *   • nothing OFF-POLICY was read either (default deny) — R7 found this filter
 *     was applied in only 3 of the tests that exercise the projection.
 */
const assertGlobalSourceAccessPolicy = () => {
  // §12: the instrumentation and this assertion must be looking at the SAME object.
  // A nested scope that rebinds or shadows the sink would otherwise silence this.
  expect(globalSink).toBe(GLOBAL_SINK);
  expect(GLOBAL_SINK.forbidden).toEqual([]);
  expect(GLOBAL_SINK.enumerations).toEqual([]);
  // §18: exact property names, DEFAULT DENY, no syntax heuristic. Nested container
  // reads live in their own array and were already classified by the container's
  // own allow-list, so nothing is skipped here for looking "nested".
  expect(Array.from(new Set(GLOBAL_SINK.reads)).filter((p) => !ALLOWED_SOURCE_PROPS.includes(p))).toEqual([]);
};

/** Retained for tests that want to say it locally too; the global hook makes it redundant, never load-bearing. */
const expectNoForbiddenSourceAccess = () => assertGlobalSourceAccessPolicy();

/** Non-vacuity companion: the trap must actually have observed the projection doing its job. */
const expectSourceWasRead = (...props: string[]) => {
  for (const p of props) expect(globalSink.reads).toContain(p);
};

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
  resetGlobalSink();
  trapMode = "accessor"; // §2: ordinary route tests get the accessor tripwire
  mockExportFlagEnabled = true;
  runDocs.set(RUN, teamRun());
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID });
  mockedAccess.mockImplementation(accessFake());
  mockedGetProject.mockImplementation(projectFake);
  mockedListExports.mockImplementation(listFake());
});

/**
 * §3 — THE POSTCONDITION IS UNAVOIDABLE. Every test in this file, present and
 * future, asserts the S8A access policy whether or not it mentions security.
 * There is deliberately NO opt-out flag (§4): mechanism self-tests use their own
 * local sink, which this hook does not watch.
 */
afterEach(() => {
  assertGlobalSourceAccessPolicy();
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
    // real persisted field, with sentinels on the representative and
    // highest-sensitivity non-DTO ones. Integration evidence, not the proof.
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
   * BLIND_CAST_HARDENING — NOT a known historical producer.
   *
   * R4 caught this docblock still asserting the claim the route itself retracts.
   * The retraction is the correct side, source-traced twice independently: the
   * pre-fix `markAdaptiveExportReady` wrote the flat `"exportMetadata.fileHash"`
   * key via `.set(…, { merge: true })` onto a document
   * `createAdaptiveExportRecord` had ALREADY written with a full nested
   * `exportMetadata` (the flat-key WRITE was introduced in fe1891f alongside the
   * create writer, and 86185a6 is the FIX that replaced it with a nested merge —
   * an earlier revision here had that backwards; the create writer has required
   * `exportMetadata` since fe1891f, and `sanitizeForFirestore` never drops keys). Legacy records
   * therefore carry BOTH, and the normalizer merges the flat value in and strips
   * the key. NO writer in this repository has been demonstrated to produce a
   * record lacking `exportMetadata`.
   *
   * The guard is justified instead by the BLIND CAST at a public API boundary:
   * `normalizeAdaptiveExportRecord` returns `raw as AdaptiveResearchExportV1`
   * with no shape validation, so the required-ness of `exportMetadata` is an
   * assumption about persisted data rather than a guarantee about it. Unguarded,
   * `r.exportMetadata.fileHash` threw a TypeError out of GET — the one failure
   * path with no `{ok:false}` envelope. These fixtures are therefore hostile
   * inputs for a defensive guard, not reproductions of a known bad record.
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

  it("the legacy flat-key shape — a hostile blind-cast input, not a known producer — lists and never forwards the raw key", async () => {
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
 * R3 §2-§7 — the per-leaf non-disclosure evidence, now SECONDARY to E2A-S8A.
 * The fixtures are deeply populated for BOTH families (`satisfies
 * AdaptiveExportReportSnapshot` is editor assistance only — nothing type-checks
 * this file) and every sentinel's presence at its exact path is asserted at
 * RUNTIME before any projection claim is made. These tests demonstrate correct
 * behaviour against realistic data; they are no longer the secrecy proof.
 */
describe("E2A-S8 — no reportSnapshot leaf reaches the response", () => {
  it("REACHABILITY: every sentinel exists at its exact path in both fixtures BEFORE projection", () => {
    expect(() => assertSnapshotSentinelsReachable(MILESTONE2_SNAPSHOT)).not.toThrow();
    expect(() => assertSnapshotSentinelsReachable(LEGACY_SNAPSHOT)).not.toThrow();
    // and there is genuinely something to hide, at a useful depth
    // exact counts, so neither a dropped path nor an unreviewed addition is silent
    expect(snapshotSentinelPaths(MILESTONE2_SNAPSHOT).length).toBe(35);
    expect(snapshotSentinelPaths(LEGACY_SNAPSHOT).length).toBe(60);
    expect(allSnapshotSentinels().length).toBe(79);
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

    // R4 found `trustSummary` had NO inventory entry, so deleting it from the
    // fixture passed the whole suite — and projecting it then became invisible.
    // It carries no free-form string, only numbers, which is exactly why it was
    // overlooked; numeric sentinels make it detectable and this proves the
    // inventory now covers it.
    const damagedTrust = JSON.parse(JSON.stringify(LEGACY_SNAPSHOT)) as AdaptiveExportReportSnapshot;
    delete damagedTrust.legacy!.trustSummary;
    expect(() => assertSnapshotSentinelsReachable(damagedTrust)).toThrow(/trustSummary\.overallTrust/);

    // ...and emptying a content-bearing ARRAY is caught too — an empty array
    // serializes, so it silently proves nothing about its element type.
    const emptiedCells = JSON.parse(JSON.stringify(LEGACY_SNAPSHOT)) as AdaptiveExportReportSnapshot;
    emptiedCells.legacy!.alignedClaims[0].cells = [];
    expect(() => assertSnapshotSentinelsReachable(emptiedCells)).toThrow(/cells\[0\]\.excerpt/);

    const emptiedDisagreements = JSON.parse(JSON.stringify(LEGACY_SNAPSHOT)) as AdaptiveExportReportSnapshot;
    emptiedDisagreements.legacy!.synthesisReport!.disagreements = [];
    expect(() => assertSnapshotSentinelsReachable(emptiedDisagreements)).toThrow(/disagreements\[0\]\.topic/);

    // ...and an optional leaf replaced by an ordinary value, not just deleted
    const plainValue = JSON.parse(JSON.stringify(MILESTONE2_SNAPSHOT)) as AdaptiveExportReportSnapshot;
    (plainValue.milestone2!.meta as { limitations?: string[] }).limitations = ["an ordinary limitation"];
    expect(() => assertSnapshotSentinelsReachable(plainValue)).toThrow(/meta\.limitations\[0\]/);

    // ...and a numeric sentinel replaced by an ordinary number
    const plainNumber = JSON.parse(JSON.stringify(MILESTONE2_SNAPSHOT)) as AdaptiveExportReportSnapshot;
    plainNumber.milestone2!.meta.totalModels = 3;
    expect(() => assertSnapshotSentinelsReachable(plainNumber)).toThrow(/meta\.totalModels/);
  });

  it("E2A-S8 no milestone2 reportSnapshot leaf reaches the response", async () => {
    mockedListExports.mockImplementation(listFake([exportRecord(3)]));
    const r = await submit();
    expect(r.status).toBe(200);
    expect(r.json.exports).toHaveLength(1);
    const blob = JSON.stringify(r.json);
    const needles = familySentinels(MILESTONE2_SNAPSHOT);
    // non-vacuity: the loop below must actually iterate a substantial set
    // EXACT, not a threshold: R4 showed `>= 30` against 31 entries was defeated by
    // dropping one. An exact count fails on any silent shrink AND on any silent
    // growth that was not accompanied by a deliberate update here.
    expect(needles.length).toBe(28);
    for (const [path, needle] of needles) {
      // `path` is in the message so a failure names the leaking leaf, not just the value
      expect(`${path}=${blob.includes(needle)}`).toBe(`${path}=false`);
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
    const needles = familySentinels(LEGACY_SNAPSHOT);
    expect(needles.length).toBe(53);
    for (const [path, needle] of needles) {
      expect(`${path}=${blob.includes(needle)}`).toBe(`${path}=false`);
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

  it("the cross-Workspace Project integrity anomaly is logged — the sole trace of a cross-tenant filing inconsistency", async () => {
    mockedGetProject.mockResolvedValue({ status: "found", project: { id: FIXTURE_PROJECT_ID, name: "F", status: "active", workspaceId: OTHER_WS } });
    const r = await submit();
    expect(r.status).toBe(404);
    const calls = mockedLoggerWarn.mock.calls.filter((c) => typeof c[0] === "string" && c[0].includes("integrity anomaly"));
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual(expect.objectContaining({ workspaceId: WS, runId: RUN }));
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

  it.each([["NaN", Number.NaN], ["Infinity", Number.POSITIVE_INFINITY], ["-Infinity", Number.NEGATIVE_INFINITY]])(
    "a NON-FINITE terminal reportVersion (%s) is refused — it serializes to null, which is the trap",
    async (_label, value) => {
      // R4: dropping `Number.isFinite` from the guard passed the whole suite,
      // because the only cases here were a MISSING key and a STRING, both of
      // which `typeof === "number"` alone already rejects. A non-finite number
      // passes `typeof` and `JSON.stringify` turns it into `null` — producing
      // exactly `{hasMore:true, nextCursor:null}`, the envelope this invariant
      // exists to forbid, plus a 6th key in violation of the allow-list.
      mockedListExports.mockImplementation(listFake([exportRecord(3, { reportVersion: value })], true));
      const r = await submit();
      expect(r.status).toBe(503);
      expect(r.json.errorCode).toBe("team_workspace_unavailable");
      expect(r.json.hasMore).toBeUndefined();
      expect(r.json.nextCursor).toBeUndefined();
      noWrites();
    }
  );

  it("reportVersion 0 IS a usable cursor and must still page — the guard tests finiteness, not truthiness", async () => {
    // R4: replacing `nextCursor === null` with `!nextCursor` passed the whole
    // suite, yet it turns this page into a permanent 503. `0` round-trips
    // correctly — `?cursor=0` maps back to `beforeReportVersion: 0`, which the
    // helper honours — so refusing it would break a legitimate page. The guard's
    // premise is that this route reads blind-cast persistence and cannot assume
    // `reportVersion >= 1`, which makes `0` exactly as admissible as `"3"`.
    mockedListExports.mockImplementation(listFake([exportRecord(3, { reportVersion: 0 })], true));
    const r = await submit();
    expect(r.status).toBe(200);
    expect(r.json.hasMore).toBe(true);
    expect(r.json.nextCursor).toBe(0);
    expect(Object.keys(r.json).sort()).toEqual(["exports", "hasMore", "nextCursor", "ok", "runId"]);
  });

  it("a NEGATIVE terminal reportVersion is finite, so it pages rather than being refused", async () => {
    mockedListExports.mockImplementation(listFake([exportRecord(3, { reportVersion: -5 })], true));
    const r = await submit();
    expect(r.status).toBe(200);
    expect(r.json.nextCursor).toBe(-5);
  });

  it("the integrity refusal emits a STRUCTURED operator warning — the only signal distinguishing it from a transient 503", async () => {
    // R5 P2-2: this branch answers with a status, errorCode and message
    // byte-identical to three TRANSIENT failures, so the response carries no
    // signal at all and this warning is the only way an operator can tell a
    // permanently-stuck run from a retryable blip. Deleting it passed 82/82.
    // Deemed contractual and pinned on its STRUCTURED fields, not its prose.
    mockedListExports.mockImplementation(listFake([exportRecord(3, { reportVersion: Number.NaN })], true));
    const r = await submit();
    expect(r.status).toBe(503);
    const calls = mockedLoggerWarn.mock.calls.filter((c) => typeof c[0] === "string" && c[0].includes("continuation cursor"));
    expect(calls).toHaveLength(1);
    expect(calls[0][1]).toEqual(
      expect.objectContaining({ workspaceId: WS, runId: RUN, itemCount: 1, lastReportVersionType: "number", lastReportVersionFinite: false })
    );
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

/**
 * ─── E2A-S8A — SOURCE ACCESS (primary) ────────────────────────────────────
 * The projection never reads a forbidden persisted source. This is the
 * invariant that ends the five-round "next missing leaf" loop: it holds for
 * every depth, every optional field, every array element, every member of the
 * 9-variant `result` union and every field added in future, because the ROOT is
 * never consulted.
 */
describe("E2A-S8A — the LIST projection never reads reportSnapshot", () => {
  it("E2A-S8A a normal list reads only allow-listed source properties", async () => {
    const r = await submit();
    expectTheFixtureHistory(r);
    expectNoForbiddenSourceAccess();
    // non-vacuity: the trap really did observe the projection working
    expectSourceWasRead("exportId", "reportVersion", "format", "exportMetadata", "governanceStatusAtExport");
    // and every property it read is on the ledger
    assertGlobalSourceAccessPolicy();
  });

  it("E2A-S8A holds for BOTH schema families and a failed record", async () => {
    mockedListExports.mockImplementation(listFake([exportRecord(4), legacyExportRecord(3), failedExportRecord(2)]));
    const r = await submit();
    expect(r.json.exports).toHaveLength(3);
    expectNoForbiddenSourceAccess();
  });

  it("E2A-S8A holds on the malformed-record path too", async () => {
    const bad = exportRecord(3) as Record<string, unknown>;
    delete bad.exportMetadata;
    mockedListExports.mockImplementation(listFake([bad]));
    const r = await submit();
    expect(r.status).toBe(200);
    expectNoForbiddenSourceAccess();
  });

  it("E2A-S8A the allowed-read policy is DEFAULT-DENY, so an unclassified property is still caught", async () => {
    // R6/§13: an earlier revision asserted this ledger was "exhaustive over
    // AdaptiveResearchExportV1", so that "a new persisted field cannot sit
    // unclassified". That was FALSE — the test compared the two lists against a
    // third hand-written literal in the same file, nothing derived from the type,
    // and jest does not type-check, so adding a field to the type left 92/92
    // green. The claim is withdrawn rather than propped up with a second
    // hand-maintained mirror of the schema.
    //
    // What actually carries the property is DEFAULT DENY: the policy lists what
    // this projection is AUTHORIZED to consult, and any read outside it — a
    // future field included — shows up in `sourceReads` and fails the filter
    // below. The fixture carries `futurePrivateField` precisely to make that
    // concrete.
    const r = await submit();
    expectTheFixtureHistory(r);
    expect(globalSink.reads).not.toContain("futurePrivateField");
    assertGlobalSourceAccessPolicy();
    // the two lists must not overlap, which IS checkable without the type
    expect(ALLOWED_SOURCE_PROPS.filter((p) => FORBIDDEN_SOURCE_PROPS.includes(p))).toEqual([]);
  });

  it("E2A-S8A the record is never enumerated or spread wholesale", async () => {
    await submit();
    // `{ ...record }`, Object.keys/entries/assign and JSON.stringify(record) all
    // trip `ownKeys`; a get-only trap would miss every one of them.
    expect(globalSink.enumerations).toEqual([]);
  });

  it("MECHANISM PROOF: the trap fires on a forbidden read, and on enumeration", async () => {
    // §4 — a LOCAL sink, so deliberately tripping the trap here cannot be
    // confused with route evidence and needs no exemption from the global hook.
    const sink = newSink();
    const probe = trapRecord({ exportId: "x", reportSnapshot: { deep: { leaf: 1 } } }, "probe", sink);
    expect(sink.forbidden).toEqual([]);
    void probe.reportSnapshot;
    expect(sink.forbidden).toEqual(["probe.reportSnapshot"]);

    // a DEEP leaf whose value is undefined still trips the ROOT read — the
    // property sentinel completeness could never give us
    const probe2 = trapRecord({ exportId: "y" }, "probe2", sink);
    void (probe2.reportSnapshot as undefined);
    expect(sink.forbidden).toContain("probe2.reportSnapshot");

    // enumeration
    sink.enumerations.length = 0;
    void { ...probe };
    expect(sink.enumerations).toContain("ownKeys(probe)");
  });
});

/**
 * ─── E2A-S8B — RESPONSE SHAPE (independent of S8A) ────────────────────────
 * A deep, exact comparison of the whole response. Unlike `Object.keys`, this
 * catches a forbidden value nested INSIDE an allowed object — the gap R5 found
 * by hiding a snapshot leaf under `governanceStatusAtExport`.
 */
describe("E2A-S8B — the response is exactly the approved DTO, deeply", () => {
  it("E2A-S8B deep-equals the expected response, so no nested extra survives", async () => {
    mockedListExports.mockImplementation(listFake([exportRecord(3)]));
    const r = await submit();
    expect(r.json).toEqual({
      ok: true,
      runId: RUN,
      exports: [
        {
          exportId: "exp-3",
          reportVersion: 3,
          schemaId: "comparison_matrix",
          schemaFamily: "milestone2",
          format: "pdf",
          artifactStatus: "ready",
          createdAt: "2026-09-02T11:00:00.000Z",
          createdBy: CREATOR_UID,
          governanceStatusAtExport: { family: "milestone2", kind: "approved", isOwnerOverride: false },
          classification: "internal",
          fileHash: "f".repeat(64),
          hashAlgorithm: "sha256",
          hashReproducible: true,
        },
      ],
      hasMore: false,
      nextCursor: null,
    });
  });

  it("E2A-S8B deep-equals for the legacy family and a failed record", async () => {
    mockedListExports.mockImplementation(listFake([legacyExportRecord(3), failedExportRecord(2)]));
    const r = await submit();
    expect(r.json.exports).toEqual([
      {
        exportId: "exp-3",
        reportVersion: 3,
        schemaId: "financial_valuation",
        schemaFamily: "legacy",
        format: "pdf",
        artifactStatus: "ready",
        createdAt: "2026-09-02T11:00:00.000Z",
        createdBy: CREATOR_UID,
        governanceStatusAtExport: { family: "legacy", status: "needs_review" },
        classification: "internal",
        fileHash: "f".repeat(64),
        hashAlgorithm: "sha256",
        hashReproducible: true,
      },
      {
        exportId: "exp-2",
        reportVersion: 2,
        schemaId: "comparison_matrix",
        schemaFamily: "milestone2",
        format: "pdf",
        artifactStatus: "failed",
        createdAt: "2026-09-02T11:00:00.000Z",
        createdBy: CREATOR_UID,
        governanceStatusAtExport: { family: "milestone2", kind: "approved", isOwnerOverride: false },
        classification: "internal",
      },
    ]);
  });

  it("E2A-S8B MECHANISM PROOF: a value nested inside an ALLOWED key is caught", () => {
    // The gap this replaces: `Object.keys(item)` is depth-1, so nesting data
    // under the already-allowed `governanceStatusAtExport` left the key set
    // intact and passed. Deep equality does not have that blind spot — proved
    // here against the matcher itself rather than asserted in prose.
    const approved = { family: "milestone2", kind: "approved", isOwnerOverride: false };
    expect(() => expect({ governanceStatusAtExport: { ...approved, smuggled: "x" } }).toEqual({ governanceStatusAtExport: approved })).toThrow();
    expect(() => expect({ governanceStatusAtExport: approved }).toEqual({ governanceStatusAtExport: approved })).not.toThrow();
  });
});

/**
 * ─── §4/§5/§17 — INPUT-CLASS COVERAGE, and proof there is no bypass ───────
 * R6's blocker was not a missing assertion but a missing BOUNDARY: four input
 * classes only ever appeared on paths that opted out of wrapping. These tests
 * exercise every DTO-branch-selecting input class THROUGH the central boundary,
 * and the first one proves the boundary itself cannot be opted out of.
 */
/**
 * ─── §6–§11 — MECHANISM B: the plain-object accessor tripwire ─────────────
 * The Proxy's blind spot, closed. `structuredClone(proxy)` throws
 * `DataCloneError` before any trap runs, so a production
 * `try { structuredClone(r).reportSnapshot } catch {}` was invisible while
 * leaking in production, where records are plain objects. The accessor tripwire
 * IS a plain object, so clone/serialize/enumerate operations traverse it and fire
 * the getter — and it RECORDS rather than throws, so catching an exception cannot
 * erase the evidence.
 */
describe("E2A-S8A mechanism B — plain-object accessor tripwire", () => {
  beforeEach(() => {
    trapMode = "accessor";
  });

  it("§8 MECHANISM PROOF: every clone/serialize/enumerate operation fires the tripwire", () => {
    const fired = (op: (rec: Record<string, unknown>) => unknown) => {
      const sink = newSink(); // §4: local, so the global hook stays armed
      const rec = accessorRecord({ exportId: "x", reportSnapshot: { q: "SECRET" } }, "probe", sink);
      try { op(rec); } catch { /* the operation itself may throw; the record is what matters */ }
      return sink.forbidden.length > 0;
    };
    // §8 asks for ACTUAL JavaScript behaviour, recorded rather than assumed
    expect(fired((r) => r.reportSnapshot)).toBe(true);           // direct read
    expect(fired((r) => JSON.stringify(r))).toBe(true);          // serialization
    expect(fired((r) => ({ ...r }))).toBe(true);                 // spread
    expect(fired((r) => Object.values(r))).toBe(true);
    expect(fired((r) => Object.entries(r))).toBe(true);
    expect(fired((r) => Object.assign({}, r))).toBe(true);
    expect(fired((r) => structuredClone(r))).toBe(true);         // the R6 blind spot
    // and the one that does NOT traverse values, recorded honestly:
    expect(fired((r) => Object.keys(r))).toBe(false);
  });

  it("§9/§10 a SWALLOWED structuredClone still leaves the access recorded", () => {
    // The precise R6 attack: the exception is caught, so nothing propagates —
    // but the getter already ran, and that is what the assertion checks.
    const sink = newSink(); // §4: local sink, global hook stays armed
    const rec = accessorRecord({ exportId: "x", reportSnapshot: { q: "SECRET" } }, "probe", sink);
    try {
      void (structuredClone(rec) as Record<string, unknown>).reportSnapshot;
    } catch {
      /* swallowed, exactly as the attacking mutation would */
    }
    expect(sink.forbidden).toEqual(["probe.reportSnapshot"]);
  });

  // The route-level coverage that used to live here is now the SHARED input-class
  // table below, run under BOTH modes. R7 found this block was the sole carrier of
  // accessor-mode route coverage over five hand-picked shapes, so three gated
  // clone leaks (`superseded`, no-`exportMetadata`, `hasMore`) passed the suite.
});

/**
 * ─── §7/§8/§9 — ONE INPUT-CLASS TABLE, BOTH TRAP MODES ────────────────────
 *
 * R7's second blocker: the trap MODE was chosen per-`describe`, so the accessor
 * tripwire — the only mechanism that can see a swallowed `structuredClone`,
 * because the Proxy is rejected by it before any trap runs — covered five
 * hand-picked shapes. Gated clone leaks on `superseded`, no-`exportMetadata` and
 * the `hasMore` path all passed 106/106. Two independently maintained lists drift;
 * this is one list, run twice.
 *
 * Coverage is by BRANCH, not by Cartesian product: every class below selects a
 * materially different path through the projection or the cursor logic. The
 * `reportVersion` rows exist because R7 exploited exactly that gap — they were
 * absent from every table while being the field the route branches on hardest.
 */
const S8A_INPUT_CLASSES: ReadonlyArray<readonly [string, () => Record<string, unknown>[], boolean]> = [
  ["ready pdf, milestone2", () => [exportRecord(3)], false],
  ["ready docx", () => [exportRecord(3, { format: "docx" })], false],
  ["json format", () => [exportRecord(3, { format: "json" })], false],
  ["generating", () => [exportRecord(3, { artifactStatus: "generating" })], false],
  ["superseded", () => [exportRecord(3, { artifactStatus: "superseded" })], false],
  ["failed (no fileHash)", () => [failedExportRecord(3) as Record<string, unknown>], false],
  ["no fileHash on a ready record", () => [exportRecord(3, { exportMetadata: { exportId: "exp-3", runId: RUN, schemaVersion: 1, requestingUser: CREATOR_UID } })], false],
  ["no exportMetadata at all", () => { const r = exportRecord(3) as Record<string, unknown>; delete r.exportMetadata; return [r]; }, false],
  ["legacy family", () => [legacyExportRecord(3) as Record<string, unknown>], false],
  ["both families together", () => [exportRecord(4), legacyExportRecord(3) as Record<string, unknown>], false],
  ["hasMore paging", () => [exportRecord(3), exportRecord(2)], true],
  ["reportVersion 0 (usable cursor)", () => [exportRecord(3, { reportVersion: 0 })], true],
  ["reportVersion negative", () => [exportRecord(3, { reportVersion: -5 })], true],
  ["reportVersion non-numeric (integrity 503 path)", () => [exportRecord(3, { reportVersion: "3" })], true],
  ["reportVersion NaN (integrity 503 path)", () => [exportRecord(3, { reportVersion: Number.NaN })], true],
];

describe("E2A-S8A — the instrumentation boundary cannot be opted out of", () => {
  it("§5 instrumentation is applied by the MOCK BOUNDARY, so a raw mockResolvedValue cannot opt out", async () => {
    // The exact shape that bypassed the old per-fixture wrapper. R6 moved wrapping
    // into the jest.mock factory; this test is the standing proof that a test which
    // never mentions `listFake` is still instrumented.
    mockedListExports.mockResolvedValue({ ok: true, records: [exportRecord(3)], hasMore: false });
    const r = await submit();
    expect(r.status).toBe(200);
    // the record really was wrapped: the projection's reads were observed
    expectSourceWasRead("exportId", "reportVersion", "format");
    // (the S8A policy itself is asserted by the global afterEach)
  });

  // A source-grep test asserting "GET is only invoked inside submit()" lived here
  // briefly and was removed: it read its own file, so it counted the needle in its
  // own source. More importantly it was redundant — the postcondition is a GLOBAL
  // `afterEach`, so it covers any invocation path, including a future direct one.
  // The single entry point is a readability convenience, not the guarantee.
});

describe.each(["proxy", "accessor"] as const)("E2A-S8A [%s mode] — the shared input-class table", (mode) => {
  beforeEach(() => {
    trapMode = mode;
  });

  it.each(S8A_INPUT_CLASSES)("%s", async (_label, build, hasMore) => {
    mockedListExports.mockResolvedValue({ ok: true, records: build(), hasMore });
    const r = await submit();
    // Either a normal listing or the E2A-S15 integrity refusal; both run the
    // projection, which is what must not touch forbidden sources.
    expect([200, 503]).toContain(r.status);
    // non-vacuity: the projection really executed under instrumentation
    expectSourceWasRead("exportId", "format");
    // ...and the S8A policy itself is asserted by the GLOBAL afterEach, not here.
    // That is the point of this round: no row of this table can forget it.
  });
});

/**
 * ─── §4/§5/§28 — THE REQUEST / AUTHORITY CONTEXT MATRIX ───────────────────
 *
 * R8's second blocker was a DIMENSION, not a mode: instrumentation covered
 * record SHAPES in one fixed request context, so a leak gated on the request or
 * the caller's authority was invisible. Verified then: gates on an unfiled run,
 * `?cursor=`, `?limit=`, a reviewer role, a degraded Project, ≥3 records and the
 * legacy flat-key shape all passed the suite.
 *
 * Worst of all was `createdBy === uid`: every fixture is created by a DIFFERENT
 * uid than the caller (deliberately, to prove E2A-S7), so the single most common
 * production case — a member listing exports they created themselves — had ZERO
 * tests in either mode, and emitting the whole frozen report for exactly those
 * records passed 126/126. That is a fixture-VALUE gap; no mode default fixes it.
 *
 * Each row below is a materially different branch that can influence DTO
 * construction or which source properties get consulted. Deliberately NOT a
 * Cartesian product with the record-shape table — the smallest set that reaches
 * every distinct branch. All rows run under the ORDINARY default, which is now
 * accessor mode, so the clone/serialize family is covered across every context.
 */
type ContextRow = readonly [string, () => void, string];
const REQUEST_CONTEXTS: ReadonlyArray<ContextRow> = [
  ["creator listing their OWN export", () => {
    mockedListExports.mockResolvedValue({ ok: true, records: [exportRecord(3, { createdBy: UID }), exportRecord(2, { createdBy: UID })], hasMore: false });
  }, ""],
  ["non-creator authorized member (E2A-S7 case)", () => { /* default fixtures */ }, ""],
  ["mixed: one own record, one someone else's", () => {
    mockedListExports.mockResolvedValue({ ok: true, records: [exportRecord(3, { createdBy: UID }), exportRecord(2)], hasMore: false });
  }, ""],
  ["reviewer role", () => { mockedAccess.mockImplementation(accessFake("reviewer")); }, ""],
  ["viewer role", () => { mockedAccess.mockImplementation(accessFake("viewer")); }, ""],
  ["owner role", () => { mockedAccess.mockImplementation(accessFake("owner")); }, ""],
  ["UNFILED run (projectId null, no Project read)", () => { runDocs.set(RUN, teamRun({ projectId: null })); }, ""],
  ["filed run, same-Workspace Project (default)", () => { /* default */ }, ""],
  ["degraded Project: not_found, listing proceeds", () => { mockedGetProject.mockResolvedValue({ status: "not_found" }); }, ""],
  ["degraded Project: malformed, listing proceeds", () => { mockedGetProject.mockResolvedValue({ status: "malformed" }); }, ""],
  ["cursor supplied", () => { /* default records */ }, "?cursor=5"],
  ["EMPTY cursor (characterized inherited behaviour)", () => { /* default */ }, "?cursor="],
  ["limit supplied", () => { /* default */ }, "?limit=10"],
  ["EMPTY limit (characterized inherited behaviour)", () => { /* default */ }, "?limit="],
  ["hasMore continuation path", () => {
    mockedListExports.mockResolvedValue({ ok: true, records: [exportRecord(3), exportRecord(2)], hasMore: true });
  }, ""],
  ["exactly ONE record", () => { mockedListExports.mockResolvedValue({ ok: true, records: [exportRecord(3)], hasMore: false }); }, ""],
  ["THREE OR MORE records", () => {
    mockedListExports.mockResolvedValue({ ok: true, records: [exportRecord(4), exportRecord(3), legacyExportRecord(2) as Record<string, unknown>, failedExportRecord(1) as Record<string, unknown>], hasMore: false });
  }, ""],
  ["alternate classification", () => { mockedListExports.mockResolvedValue({ ok: true, records: [exportRecord(3, { classification: "restricted" })], hasMore: false }); }, ""],
  ["alternate schemaId", () => { mockedListExports.mockResolvedValue({ ok: true, records: [exportRecord(3, { schemaId: "deep_research" })], hasMore: false }); }, ""],
  ["alternate governanceStatusAtExport shape", () => {
    mockedListExports.mockResolvedValue({ ok: true, records: [exportRecord(3, { governanceStatusAtExport: { family: "milestone2", kind: "blocked", isOwnerOverride: true, conditions: ["SENTINEL_GOV_CONDITION"] } })], hasMore: false });
  }, ""],
  ["legacy flat-key record shape", () => {
    const legacy = exportRecord(3) as Record<string, unknown>;
    delete legacy.exportMetadata;
    legacy["exportMetadata.fileHash"] = "b".repeat(64);
    mockedListExports.mockResolvedValue({ ok: true, records: [legacy], hasMore: false });
  }, ""],
];

describe("E2A-S8A — the request/authority context matrix (accessor default)", () => {
  it.each(REQUEST_CONTEXTS)("%s", async (_label, setup, query) => {
    setup();
    const r = await submit(query);
    // Every context must reach the projection; 200 normally, 503 only on the
    // integrity path (which none of these rows triggers).
    expect(r.status).toBe(200);
    expect(Array.isArray(r.json.exports)).toBe(true);
    // non-vacuity: instrumentation observed the projection under THIS context
    expectSourceWasRead("exportId", "format");
    // The S8A policy itself is asserted by the GLOBAL afterEach — deliberately not
    // here, so no row can forget it and no row needs to remember.
  });

  it("the matrix reaches every context it claims to (non-vacuity of the table itself)", () => {
    expect(REQUEST_CONTEXTS.length).toBe(21);
    const labels = REQUEST_CONTEXTS.map(([l]) => l);
    expect(new Set(labels).size).toBe(labels.length); // no duplicate rows
    for (const needle of ["OWN export", "reviewer", "viewer", "UNFILED", "not_found", "cursor", "limit", "hasMore", "THREE OR MORE", "flat-key"]) {
      expect(labels.some((l) => l.includes(needle))).toBe(true);
    }
  });
});

/**
 * ─── §9/§10 — THE FOCUSED PROXY OPERATION MATRIX ──────────────────────────
 * Accessor mode is the ordinary default because it sees value-obtaining
 * operations. It does NOT observe key-enumeration that obtains no value, and the
 * Proxy does. Neither mode dominates universally, so this matrix covers exactly
 * the operation classes whose proof depends on Proxy traps. Empirically
 * established, not asserted: see the MECHANISM PROOF tests for what each mode
 * actually observes.
 */
describe("E2A-S8A — Proxy-specific operation classes", () => {
  beforeEach(() => {
    trapMode = "proxy";
  });

  it("MECHANISM PROOF: the Proxy observes enumeration that obtains no values; the accessor does not", () => {
    const enumerationFires = (mode: "proxy" | "accessor") => {
      const sink = newSink();
      const wrap = mode === "proxy" ? trapRecord : accessorRecord;
      const rec = wrap({ exportId: "x", reportSnapshot: { q: "SECRET" } }, "probe", sink);
      void Object.keys(rec);
      return { enumerations: sink.enumerations.length > 0, forbidden: sink.forbidden.length > 0 };
    };
    // Proxy: sees the enumeration, obtains no value
    expect(enumerationFires("proxy")).toEqual({ enumerations: true, forbidden: false });
    // Accessor: Object.keys reads no values, so nothing fires — recorded honestly,
    // and it is why the Proxy matrix still exists.
    expect(enumerationFires("accessor")).toEqual({ enumerations: false, forbidden: false });
  });

  it("an off-policy TOP-LEVEL property is denied by default under the Proxy", async () => {
    const r = await submit();
    expect(r.status).toBe(200);
    expect(globalSink.reads).not.toContain("futurePrivateField");
  });

  it("a DOTTED top-level property name gets no free pass from its punctuation", async () => {
    // §17/§20: the policy used to skip any recorded name containing a ".", so
    // `r["exportMetadata.fileHash"]` — a key these records historically carried —
    // escaped default-deny entirely. Top-level and nested reads are now separate
    // arrays, so a dotted name is compared exactly like any other.
    const legacy = exportRecord(3) as Record<string, unknown>;
    delete legacy.exportMetadata;
    legacy["exportMetadata.fileHash"] = "c".repeat(64);
    mockedListExports.mockResolvedValue({ ok: true, records: [legacy], hasMore: false });
    const r = await submit();
    expect(r.status).toBe(200);
    expect(globalSink.reads).not.toContain("exportMetadata.fileHash");
    expect(ALLOWED_SOURCE_PROPS).not.toContain("exportMetadata.fileHash");
  });
});
