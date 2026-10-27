/**
 * Order 6 S-1b.1 — the case matrix and oracle (a) for the P1/W1
 * `dsProvenance` acceptance suite (dsProvenanceRouteView.spec.ts).
 *
 * Fixtures are synthetic: Decision Support outputs and governance records are
 * taken from the sealed S-1a-min goldens (lib/adaptiveSchema/__tests__/fixtures),
 * run documents are built here. No production record or real user data.
 *
 * Oracle (a) is a literal transcription of the D-11(A) per-surface ceiling and
 * the owner's R11-OPEN-1 ruling, computed from the fixture record and the
 * viewer class alone. It never calls the builder or the route.
 */

import { readFileSync } from "fs";
import { join } from "path";

const GOLDENS = JSON.parse(readFileSync(join(process.cwd(), "lib/adaptiveSchema/__tests__/fixtures/dsProvenanceViewMin.goldens.json"), "utf-8")) as {
  semantics: { flagText: string; historyText: string };
  fixtures: { governance: Record<string, { record?: unknown; absent?: true }>; adaptive: Record<string, unknown> };
};
const clone = <T>(v: T): T => (v === undefined ? v : JSON.parse(JSON.stringify(v)));

export const RUN_ID = "run-parity-1";
export const OWNER = "uid-owner";
export const REVIEWER = "uid-rev-r";
export const STRANGER = "uid-stranger";
export const TEAM_UID = "uid-team-member";
export const WS_ID = "aTeamWorkspaceAutoId12345";
export const PROJECT_ID = "projAutoId0001";

// ─── Adaptive outputs ──────────────────────────────────────────────────────

export const ADAPTIVE = {
  ds_split: () => clone(GOLDENS.fixtures.adaptive["r10f:R1-02"]),
  ds_sources: () => clone(GOLDENS.fixtures.adaptive["ptr:R12L3:L3-SOURCES"]),
  deep_research: () => ({
    version: 1,
    schemaId: "deep_research",
    answerShape: "deep_research_view",
    classification: { queryType: "deep_research", confidence: 0.9 },
    meta: { limitations: ["l1"] },
    generatedAt: "2026-09-01T00:00:00.000Z",
    result: { executiveSummary: "Summary", findings: [{ id: "f1", summary: "Finding one", supportingModels: ["chatgpt"], confidence: "high" }], lowConfidenceFindings: [], totalModels: 2 },
  }),
  malformed: () => ({ version: 1, schemaId: "decision_support" }),
  absent: () => undefined,
} as const;
export type AdaptiveKey = keyof typeof ADAPTIVE;
export const DS_ADAPTIVE: ReadonlySet<AdaptiveKey> = new Set(["ds_split", "ds_sources"]);

// ─── Governance records ────────────────────────────────────────────────────

const g = (key: string) => () => clone(GOLDENS.fixtures.governance[key].record);
/** `parses`: the literal parser outcome recorded for the fixture in the sealed goldens (expectedParser.ok). */
export const RECORDS: Record<string, { make: () => unknown; parses: boolean; absentKey?: true }> = {
  absent: { make: () => undefined, parses: false, absentKey: true },
  null: { make: () => null, parses: false },
  malformed_status: { make: g("R12P:malformed_status"), parses: false },
  unsupported_version: { make: g("R12P:unsupported_version"), parses: false },
  non_object: { make: g("R12P:non_object"), parses: false },
  array: { make: () => [], parses: false },
  unreviewed: { make: g("R12P:unreviewed_writer"), parses: true },
  pending: { make: g("R12P:pending_injected_NON_WRITER"), parses: true },
  approved_single_no_via: { make: g("R12T:approved"), parses: true },
  changes_requested_personal: { make: g("R12P:changes_requested"), parses: true },
  rejected_personal: { make: g("R12P:rejected"), parses: true },
  personal_self_awc: { make: g("L5P:PERSONAL_SELF_AWC"), parses: true },
  team_panel_awc: { make: g("L5T:TEAM_PANEL_AWC"), parses: true },
  team_override_awc: { make: g("L5T:TEAM_OVERRIDE_AWC"), parses: true },
  decided_via_unknown: { make: g("R12T:decidedVia_unknown_string_NON_WRITER"), parses: true },
  decided_via_null: { make: g("R12T:decidedVia_null_NON_WRITER"), parses: true },
};
export type RecordKey = keyof typeof RECORDS;
export const UNREADABLE_OR_ABSENT: RecordKey[] = ["absent", "null", "malformed_status", "unsupported_version", "non_object", "array"];

// ─── Viewers ───────────────────────────────────────────────────────────────

export type HistoryMode = "qualifying" | "absent" | "team_row" | "throws";

export interface Viewer {
  key: string;
  route: "P1" | "W1";
  /** P1 only: which authorization path the run takes. */
  runKind: "personal" | "team";
  uid: string | null;
  /** The expected authorized role, or null for a denial. */
  role: "owner" | "personal_reviewer" | "team_member" | "team_reviewer" | null;
  history?: HistoryMode;
  capabilities?: string[];
  assignedTeamReviewer?: boolean;
  teamAccess?: { granted: false; reason: string };
  integrity?: { classification: "invalid"; reason: string };
  runAbsent?: true;
  runOverrides?: Record<string, unknown>;
  dropRunKeys?: string[];
  query?: string;
  project?: "found" | "not_found" | "read_failed" | "other_workspace";
}

const MEMBER_CAPS = ["workspace.read", "research.read"];
const REVIEWER_CAPS = ["workspace.read", "research.read", "reviews.submit"];

export const SUCCESS_VIEWERS: Viewer[] = [
  { key: "p1.owner", route: "P1", runKind: "personal", uid: OWNER, role: "owner" },
  { key: "p1.rev.qualifying_row", route: "P1", runKind: "personal", uid: REVIEWER, role: "personal_reviewer", history: "qualifying" },
  { key: "p1.rev.absent_row", route: "P1", runKind: "personal", uid: REVIEWER, role: "personal_reviewer", history: "absent" },
  { key: "p1.rev.team_row", route: "P1", runKind: "personal", uid: REVIEWER, role: "personal_reviewer", history: "team_row" },
  { key: "p1.rev.read_throws", route: "P1", runKind: "personal", uid: REVIEWER, role: "personal_reviewer", history: "throws" },
  { key: "p1.team.member", route: "P1", runKind: "team", uid: TEAM_UID, role: "team_member", capabilities: MEMBER_CAPS },
  { key: "p1.team.reviewer", route: "P1", runKind: "team", uid: TEAM_UID, role: "team_reviewer", capabilities: REVIEWER_CAPS, assignedTeamReviewer: true },
  { key: "w1.member", route: "W1", runKind: "team", uid: TEAM_UID, role: "team_member", capabilities: MEMBER_CAPS, project: "found" },
  { key: "w1.reviewer", route: "W1", runKind: "team", uid: TEAM_UID, role: "team_reviewer", capabilities: REVIEWER_CAPS, assignedTeamReviewer: true, project: "found" },
  { key: "w1.member.project_label_unresolved", route: "W1", runKind: "team", uid: TEAM_UID, role: "team_member", capabilities: MEMBER_CAPS, project: "not_found" },
];

export const DENIAL_VIEWERS: Viewer[] = [
  { key: "p1.unauthenticated", route: "P1", runKind: "personal", uid: null, role: null },
  { key: "p1.stranger", route: "P1", runKind: "personal", uid: STRANGER, role: null },
  { key: "p1.run_absent", route: "P1", runKind: "personal", uid: OWNER, role: null, runAbsent: true },
  { key: "p1.integrity_invalid", route: "P1", runKind: "personal", uid: OWNER, role: null, integrity: { classification: "invalid", reason: "deterministic_id_mismatch" } },
  { key: "p1.integrity_lookup_failed", route: "P1", runKind: "personal", uid: OWNER, role: null, integrity: { classification: "invalid", reason: "workspace_lookup_failed" } },
  { key: "p1.team.membership_not_found", route: "P1", runKind: "team", uid: TEAM_UID, role: null, teamAccess: { granted: false, reason: "membership_not_found" } },
  { key: "p1.team.workspace_not_found", route: "P1", runKind: "team", uid: TEAM_UID, role: null, teamAccess: { granted: false, reason: "workspace_not_found" } },
  { key: "p1.team.no_research_read", route: "P1", runKind: "team", uid: TEAM_UID, role: null, capabilities: ["workspace.read"] },
  { key: "p1.team.project_id_absent", route: "P1", runKind: "team", uid: TEAM_UID, role: null, capabilities: MEMBER_CAPS, dropRunKeys: ["projectId"] },
  { key: "w1.unauthenticated", route: "W1", runKind: "team", uid: null, role: null },
  { key: "w1.membership_not_found", route: "W1", runKind: "team", uid: TEAM_UID, role: null, teamAccess: { granted: false, reason: "membership_not_found" } },
  { key: "w1.no_research_read", route: "W1", runKind: "team", uid: TEAM_UID, role: null, capabilities: ["workspace.read"] },
  { key: "w1.run_absent", route: "W1", runKind: "team", uid: TEAM_UID, role: null, capabilities: MEMBER_CAPS, runAbsent: true },
  { key: "w1.foreign_workspace_run", route: "W1", runKind: "team", uid: TEAM_UID, role: null, capabilities: MEMBER_CAPS, runOverrides: { workspaceId: "anotherTeamWorkspace00001" } },
  { key: "w1.expected_project_mismatch", route: "W1", runKind: "team", uid: TEAM_UID, role: null, capabilities: MEMBER_CAPS, query: "?projectId=projAutoId0002", project: "found" },
  { key: "w1.project_read_failed", route: "W1", runKind: "team", uid: TEAM_UID, role: null, capabilities: MEMBER_CAPS, project: "read_failed" },
  { key: "w1.project_in_other_workspace", route: "W1", runKind: "team", uid: TEAM_UID, role: null, capabilities: MEMBER_CAPS, project: "other_workspace" },
];

export interface RouteCase {
  id: string;
  viewer: Viewer;
  record: RecordKey;
  adaptive: AdaptiveKey;
}

const DENIAL_RECORDS: RecordKey[] = ["absent", "malformed_status", "team_panel_awc", "personal_self_awc"];
const DENIAL_ADAPTIVE: AdaptiveKey[] = ["ds_split", "absent"];

export const CASES: RouteCase[] = [
  ...SUCCESS_VIEWERS.flatMap((viewer) =>
    (Object.keys(RECORDS) as RecordKey[]).flatMap((record) =>
      (Object.keys(ADAPTIVE) as AdaptiveKey[]).map((adaptive) => ({ id: `${viewer.key}|${record}|${adaptive}`, viewer, record, adaptive })),
    ),
  ),
  ...DENIAL_VIEWERS.flatMap((viewer) =>
    DENIAL_RECORDS.flatMap((record) => DENIAL_ADAPTIVE.map((adaptive) => ({ id: `${viewer.key}|${record}|${adaptive}`, viewer, record, adaptive }))),
  ),
];

// ─── Oracle (a): the literal D-11(A) table ────────────────────────────────

const KNOWN_DECIDED_VIA = new Set(["single_reviewer", "multi_reviewer_panel", "multi_reviewer_owner_override"]);
const PENDING = new Set(["unreviewed", "pending"]);
const TEAM_SCOPED_VIA = new Set(["multi_reviewer_panel", "multi_reviewer_owner_override"]);

export type OracleA =
  | { built: false }
  | { built: true; surfaceId: "P1" | "W1"; humanReview: Record<string, unknown>; decidedViaAllowed: boolean; contentAllowed: boolean };

/** The stored humanReview of a parse-ok fixture record (raw, as persisted). */
export function storedHumanReview(record: RecordKey): Record<string, unknown> {
  return (RECORDS[record].make() as { humanReview: Record<string, unknown> }).humanReview;
}

export function oracleA(c: RouteCase): OracleA {
  const v = c.viewer;
  // R11-OPEN-1 (owner): only an authorized response that already carries a usable review.
  if (v.role === null || !DS_ADAPTIVE.has(c.adaptive) || !RECORDS[c.record].parses) return { built: false };
  const hr = storedHumanReview(c.record);
  const status = hr.status as string;
  const surfaceId = v.route;

  // D-11(A): decidedVia on P1 for owner / team_member / team_reviewer, and on W1; never a personal reviewer.
  const decidedViaAllowed = surfaceId === "W1" || v.role === "owner" || v.role === "team_member" || v.role === "team_reviewer";
  // D-11(A): reviewedAt / conditions on P1 only with decision-content authority (owner, Team roles, or a personal
  // reviewer whose decision is proven Personal by the qualifying history row), and always on W1.
  const personalProven =
    v.role === "personal_reviewer" &&
    v.history === "qualifying" &&
    !TEAM_SCOPED_VIA.has(hr.decidedVia as string) &&
    typeof hr.reviewerId === "string" &&
    hr.reviewerId.length > 0 &&
    typeof hr.reviewedAt === "string" &&
    hr.reviewedAt.length > 0;
  const contentAllowed = surfaceId === "W1" || v.role === "owner" || v.role === "team_member" || v.role === "team_reviewer" || personalProven;

  if (PENDING.has(status)) {
    return { built: true, surfaceId, humanReview: { state: "pending", decision: status, reviewedContent: "run_result_by_id_only" }, decidedViaAllowed, contentAllowed };
  }
  const expected: Record<string, unknown> = { state: "decided", decision: status, reviewedContent: "run_result_by_id_only" };
  if (decidedViaAllowed) {
    expected.decidedVia = !Object.prototype.hasOwnProperty.call(hr, "decidedVia")
      ? "single_or_legacy"
      : KNOWN_DECIDED_VIA.has(hr.decidedVia as string)
        ? hr.decidedVia
        : "unknown";
  }
  if (contentAllowed && typeof hr.reviewedAt === "string") expected.reviewedAt = hr.reviewedAt;
  if (contentAllowed && Array.isArray(hr.conditions)) expected.conditions = hr.conditions;
  return { built: true, surfaceId, humanReview: expected, decidedViaAllowed, contentAllowed };
}

/** Values that identify a reviewer, panel member, finalizer or overriding owner, or carry review text, in any fixture record. */
export const RESTRICTED_RECORD_VALUES = ["uid-admin", "uid-ws-owner", "uid-reviewer", "uid-rev-r", "Rita Recorder", "rita comment", "R-COMMENT", "OWNER-JUSTIFICATION", "fix"];

/**
 * The role the route derives for this viewer. A viewer configured as an assigned Team reviewer is `team_reviewer`
 * only while the record's human-review status is still reviewable (unreviewed / pending); otherwise `team_member`.
 */
export function expectedViewerRole(c: RouteCase): string | null {
  const v = c.viewer;
  if (v.role !== "team_reviewer") return v.role;
  const reviewable = RECORDS[c.record].parses && PENDING.has(storedHumanReview(c.record).status as string);
  return reviewable ? "team_reviewer" : "team_member";
}

// ─── Oracle (a), whole view: L1–L4 transcribed from the sealed S-1a-min contract (B §3.5) ───
//
// Computed from the SAME response body the view is attached to (its `results` and `adaptive.output`), never from the
// builder. Combined with `oracleA(...).humanReview`, it is the exact expected view: any key the view carries beyond
// this, at any depth, fails the suite.

const PUBLIC_SLOT_STATUSES = new Set(["ok", "substituted", "failed"]);
const own = (o: unknown, k: string): unknown => (o && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k) ? (o as Record<string, unknown>)[k] : undefined);
const str = (x: unknown) => (typeof x === "string" ? x : "unknown");
const bool = (x: unknown) => (typeof x === "boolean" ? x : "unknown");
const count = (x: unknown) => (typeof x === "number" && Number.isSafeInteger(x) && x >= 0 ? x : "unknown");
const recorded = (row: unknown, k: string) => {
  const x = own(row, k);
  if (x === undefined) return "not_recorded";
  return typeof x === "string" && x.trim() !== "" ? x : "unknown";
};

export function expectedFullView(a: Extract<OracleA, { built: true }>, body: { results: unknown[]; adaptive: { output: Record<string, unknown> } }): Record<string, unknown> {
  const l1 = body.results.map((row) => {
    const status = PUBLIC_SLOT_STATUSES.has(own(row, "status") as string) ? own(row, "status") : "unknown";
    const slot: Record<string, unknown> = {
      slotId: str(own(row, "modelId")),
      status,
      requestedModel: recorded(row, "requestedModel"),
      answeredByProvider: recorded(row, "provider"),
      contributedRecommendation: "unknown",
    };
    if (status === "substituted") slot.substitutedFrom = recorded(row, "substitutedFrom");
    return slot;
  });

  const output = body.adaptive.output;
  const result = own(output, "result");
  const rec = own(result, "recommendation") ?? {};
  const m = count(own(result, "totalModels"));
  const k = count(own(rec, "totalModelsWithRecommendation"));
  const n = count(own(rec, "supportCount"));
  const recommendation: Record<string, unknown> = { action: str(own(rec, "action")), isContested: bool(own(rec, "isContested")) };
  if (own(rec, "recommendedOptionId") !== undefined) recommendation.recommendedOptionId = str(own(rec, "recommendedOptionId"));
  const l2 = {
    recommendation,
    dispatchedModels: m,
    recommendingModels: k,
    largestAgreeingGroup: n,
    dispatchedModelsLabel: "models dispatched",
    recommendingModelsLabel: "models that gave a recommendation",
    largestAgreeingGroupLabel: "largest group of models recommending the same action",
    denominatorStatement:
      m === "unknown" || k === "unknown" || n === "unknown" ? "unknown" : `${m} ${m === 1 ? "model" : "models"} dispatched; ${k} gave a recommendation; largest group recommending the same action: ${n}.`,
    humanReviewNeeded: bool(own(result, "humanReviewNeeded")),
    rules: { envelopeVersion: 1, aggregation: "not_recorded", optionMatcher: "not_recorded", thresholds: "not_recorded", prompt: "not_recorded" },
    computedAt: str(own(output, "generatedAt")),
  };

  const sources = own(result, "sources");
  const assessments = own(result, "assessments");
  const l3 = {
    sourcesListedByModels: Array.isArray(sources) ? { list: sources.map(str), count: sources.length } : { list: "unknown", count: "unknown" },
    modelSelfReportedEvidenceStrength: Array.isArray(assessments)
      ? assessments.map((x) => ({ optionId: str(own(x, "optionId")), criterionId: str(own(x, "criterionId")), evidenceStrength: str(own(x, "evidenceStrength")) }))
      : "unknown",
    modelSelfReportedEvidenceStrengthLabel: "self-reported by models",
    sourceCheck: "not_evaluated",
    freshness: "not_evaluated",
  };

  const l4 = {
    option_clustering_unverified: true,
    option_clustering_unverified_text: GOLDENS.semantics.flagText,
    option_clustering_unverified_knownDefect: "R5-P1-08",
    evidence_self_reported: true,
    sources_unchecked: true,
    freshness_not_evaluated: true,
    retry_text_not_retained: true,
    rules_unversioned: true,
    historical_rules_unknown: true,
    review_history_not_shown: true,
    review_history_not_shown_text: GOLDENS.semantics.historyText,
    coverage_partial: m === "unknown" || k === "unknown" ? "unknown" : k < m,
    contested: bool(own(rec, "isContested")),
  };

  return { kind: "ds_provenance_min", version: 1, surfaceId: a.surfaceId, l1, l2, l3, l4, humanReview: a.humanReview, useAuthorization: "not_authorized_no_policy" };
}
