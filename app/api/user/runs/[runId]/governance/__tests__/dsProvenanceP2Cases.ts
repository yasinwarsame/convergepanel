/**
 * Order 6 S-1b.2 — the case matrix and oracle (a) for the P2 `dsProvenance`
 * acceptance suite (dsProvenanceP2View.spec.ts).
 *
 * Fixtures are synthetic: Decision Support outputs and governance records come
 * from the sealed S-1a-min goldens (via the S-1b.1 case module); run documents
 * are built by the spec. No production record or real user data.
 *
 * Oracle (a) is a literal transcription of the D-11(A) P2 ceiling, the owner's
 * R11-OPEN-1 ruling and the S-1b.2 rulings (D-P2, D-P2-X, C-P2), computed from
 * the fixture record and the viewer class alone. It never calls the builder,
 * the adapter or a route.
 */

import { ADAPTIVE, DS_ADAPTIVE, OWNER, OWNER_PERSONAL_WS, RECORDS as S1B1_RECORDS, REVIEWER, RESTRICTED_RECORD_VALUES, STRANGER, WS_ID, type AdaptiveKey } from "../../__tests__/dsProvenanceRouteCases";

export { ADAPTIVE, DS_ADAPTIVE, OWNER, OWNER_PERSONAL_WS, REVIEWER, STRANGER, type AdaptiveKey };

const withHumanReview = (base: string, edit: (hr: Record<string, unknown>) => void) => () => {
  const record = S1B1_RECORDS[base].make() as { humanReview: Record<string, unknown> };
  edit(record.humanReview);
  return record;
};

/**
 * The S-1b.1 record states plus the two shapes R1 found only the builder's own suite covered (R1 NIT-3): a
 * whitespace-only `reviewerId` (truthy, so the baseline `singleReviewer` gate admits it) and a pending review that
 * already carries `reviewedAt`. Both parse (`parses: true` verified against the real parser by the baseline).
 */
export const RECORDS: Record<string, { make: () => unknown; parses: boolean; absentKey?: true }> = {
  ...S1B1_RECORDS,
  whitespace_reviewer_id: { make: withHumanReview("approved_single_no_via", (hr) => (hr.reviewerId = "   ")), parses: true },
  pending_with_reviewed_at: { make: withHumanReview("pending", (hr) => Object.assign(hr, { reviewerId: REVIEWER, reviewedAt: "2026-10-20T00:00:00.000Z" })), parses: true },
};
export type RecordKey = keyof typeof RECORDS;

/** The stored humanReview of a parse-ok fixture record (raw, as persisted). */
export function storedHumanReview(record: RecordKey): Record<string, unknown> {
  return (RECORDS[record].make() as { humanReview: Record<string, unknown> }).humanReview;
}

export const RUN_ID = "run-parity-1";

export type HistoryMode = "qualifying" | "absent" | "team_row" | "throws";
export type WorkspaceMode = "resolved" | "lookup_failed" | "not_found" | "owner_mismatch";
export type AssignmentMode = "personal" | "team" | "unassigned" | "read_failed";

export interface P2Viewer {
  key: string;
  uid: string | null;
  /** The expected authorized P2 role, or null for a denial. */
  role: "owner" | "personal_reviewer" | null;
  identityFailure?: "missing_credentials" | "invalid_token";
  history?: HistoryMode;
  /** Present only for a run bound to a Workspace; how the (mocked) resolver answers. */
  workspace?: { workspaceId: string; mode: WorkspaceMode };
  assignment?: AssignmentMode;
  panel?: true;
  runAbsent?: true;
  runIdParam?: string;
  runOverrides?: Record<string, unknown>;
  /**
   * A malformed stored `runDocument.perModel` (owner ruling A2): `null_row` is O6-OBS-5; `non_array` is the separate
   * inherited `.map is not a function` defect. P2 never reads it; P1 throws on it after authorization.
   */
  perModelDefect?: { kind: "null_row" | "non_array"; value: unknown };
}

const PWS = (mode: WorkspaceMode = "resolved") => ({ workspaceId: OWNER_PERSONAL_WS, mode });
const LEGACY_FAMILY = { governanceStatus: "approved", governanceReasons: ["legacy-reason"], governanceReviewedBy: "uid-legacy-reviewer", governanceReviewedAt: "2026-08-01T00:00:00.000Z" };

const REVIEWER_HISTORIES: Array<[string, HistoryMode]> = [
  ["qualifying_row", "qualifying"],
  ["absent_row", "absent"],
  ["team_row", "team_row"],
  ["read_throws", "throws"],
];

export const SUCCESS_VIEWERS: P2Viewer[] = [
  { key: "p2.owner", uid: OWNER, role: "owner" },
  { key: "p2.owner.panel", uid: OWNER, role: "owner", panel: true },
  { key: "p2.owner.legacy_family", uid: OWNER, role: "owner", runOverrides: LEGACY_FAMILY },
  ...REVIEWER_HISTORIES.map(([k, history]): P2Viewer => ({ key: `p2.rev.${k}`, uid: REVIEWER, role: "personal_reviewer", history })),
  { key: "p2.rev.panel_present", uid: REVIEWER, role: "personal_reviewer", history: "qualifying", panel: true },
  // The same viewers on a run bound to the owner's Personal Workspace (resolver consulted).
  { key: "p2ws.owner", uid: OWNER, role: "owner", workspace: PWS() },
  ...REVIEWER_HISTORIES.map(([k, history]): P2Viewer => ({ key: `p2ws.rev.${k}`, uid: REVIEWER, role: "personal_reviewer", history, workspace: PWS() })),
];

const ROW = { modelId: "chatgpt", status: "ok", rawTextTruncated: "A", latencyMs: 120, wasTruncated: false, provider: "openai", requestedModel: "gpt-5" };
export const NULL_ROW = { kind: "null_row" as const, value: [null, ROW] };
export const NON_ARRAY_STRING = { kind: "non_array" as const, value: "corrupt-per-model" };
export const NON_ARRAY_OBJECT = { kind: "non_array" as const, value: { length: 1, 0: ROW } };

/** Authorized viewers on runs whose stored perModel is malformed: P1 throws; the A2 exception must cover each one. */
export const MALFORMED_PERMODEL_VIEWERS: P2Viewer[] = [
  { key: "p2.owner.permodel_null_row", uid: OWNER, role: "owner", perModelDefect: NULL_ROW },
  { key: "p2.rev.qualifying_row.permodel_null_row", uid: REVIEWER, role: "personal_reviewer", history: "qualifying", perModelDefect: NULL_ROW },
  { key: "p2ws.owner.permodel_null_row", uid: OWNER, role: "owner", workspace: PWS(), perModelDefect: NULL_ROW },
  { key: "p2.owner.permodel_string", uid: OWNER, role: "owner", perModelDefect: NON_ARRAY_STRING },
  { key: "p2.rev.absent_row.permodel_object", uid: REVIEWER, role: "personal_reviewer", history: "absent", perModelDefect: NON_ARRAY_OBJECT },
  { key: "p2ws.rev.qualifying_row.permodel_string", uid: REVIEWER, role: "personal_reviewer", history: "qualifying", workspace: PWS(), perModelDefect: NON_ARRAY_STRING },
];

export const DENIAL_VIEWERS: P2Viewer[] = [
  { key: "p2.unauthenticated", uid: null, role: null, identityFailure: "missing_credentials" },
  { key: "p2.auth_error", uid: null, role: null, identityFailure: "invalid_token" },
  { key: "p2.blank_run_id", uid: OWNER, role: null, runIdParam: " " },
  { key: "p2.run_absent", uid: OWNER, role: null, runAbsent: true },
  { key: "p2.stranger", uid: STRANGER, role: null },
  { key: "p2.stranger.panel_present", uid: STRANGER, role: null, panel: true },
  { key: "p2ws.stranger", uid: STRANGER, role: null, workspace: PWS() },
  { key: "p2.rev.team_assignment", uid: REVIEWER, role: null, assignment: "team", history: "qualifying" },
  { key: "p2.rev.unassigned", uid: REVIEWER, role: null, assignment: "unassigned", history: "qualifying" },
  { key: "p2.rev.assignment_read_failed", uid: REVIEWER, role: null, assignment: "read_failed", history: "qualifying" },
  { key: "p2.owner.team_bound_run", uid: OWNER, role: null, workspace: { workspaceId: WS_ID, mode: "resolved" } },
  { key: "p2ws.owner.lookup_failed", uid: OWNER, role: null, workspace: PWS("lookup_failed") },
  { key: "p2ws.owner.not_found", uid: OWNER, role: null, workspace: PWS("not_found") },
  { key: "p2ws.owner.owner_mismatch", uid: OWNER, role: null, workspace: PWS("owner_mismatch") },
  { key: "p2ws.rev.lookup_failed", uid: REVIEWER, role: null, history: "qualifying", workspace: PWS("lookup_failed") },
  { key: "p2.owner.malformed_workspace_id", uid: OWNER, role: null, runOverrides: { workspaceId: "" } },
  // A malformed perModel never excuses an authorization or integrity failure: these still deny, with no view.
  { key: "p2.stranger.permodel_null_row", uid: STRANGER, role: null, perModelDefect: NULL_ROW },
  { key: "p2.rev.unassigned.permodel_string", uid: REVIEWER, role: null, assignment: "unassigned", history: "qualifying", perModelDefect: NON_ARRAY_STRING },
  { key: "p2.owner.team_bound_run.permodel_null_row", uid: OWNER, role: null, workspace: { workspaceId: WS_ID, mode: "resolved" }, perModelDefect: NULL_ROW },
  { key: "p2ws.owner.lookup_failed.permodel_string", uid: OWNER, role: null, workspace: PWS("lookup_failed"), perModelDefect: NON_ARRAY_STRING },
];

export interface P2Case {
  id: string;
  viewer: P2Viewer;
  record: RecordKey;
  adaptive: AdaptiveKey;
}

const ALL_RECORDS = Object.keys(RECORDS) as RecordKey[];
const ALL_ADAPTIVE = Object.keys(ADAPTIVE) as AdaptiveKey[];
const DENIAL_ADAPTIVE: AdaptiveKey[] = ["ds_split", "absent"];

export const CASES: P2Case[] = [
  ...[...SUCCESS_VIEWERS, ...MALFORMED_PERMODEL_VIEWERS].flatMap((viewer) => ALL_RECORDS.flatMap((record) => ALL_ADAPTIVE.map((adaptive) => ({ id: `${viewer.key}|${record}|${adaptive}`, viewer, record, adaptive })))),
  // Every record state for every denial: the #259 403 must not depend on the record.
  ...DENIAL_VIEWERS.flatMap((viewer) => ALL_RECORDS.flatMap((record) => DENIAL_ADAPTIVE.map((adaptive) => ({ id: `${viewer.key}|${record}|${adaptive}`, viewer, record, adaptive })))),
];

// ─── Oracle (a): the literal P2 table ─────────────────────────────────────

const PENDING = new Set(["unreviewed", "pending"]);
const TEAM_SCOPED_VIA = new Set(["multi_reviewer_panel", "multi_reviewer_owner_override"]);

export type OracleA = { built: false } | { built: true; humanReview: Record<string, unknown>; identityAllowed: boolean };

const nonEmpty = (x: unknown): x is string => typeof x === "string" && x.length > 0;
const hasOwn = (o: Record<string, unknown>, k: string) => Object.prototype.hasOwnProperty.call(o, k) && o[k] !== undefined;

/**
 * Whether P2 releases the recorded decider's identity to this viewer: always for the owner; for a personal reviewer,
 * when they are the recorded decider, or when the decision is proven Personal by the qualifying history row.
 */
export function identityAllowed(c: P2Case): boolean {
  if (c.viewer.role === "owner") return true;
  if (c.viewer.role !== "personal_reviewer" || !RECORDS[c.record].parses) return false;
  const hr = storedHumanReview(c.record);
  if (hr.reviewerId === REVIEWER) return true;
  return c.viewer.history === "qualifying" && !TEAM_SCOPED_VIA.has(hr.decidedVia as string) && nonEmpty(hr.reviewerId) && nonEmpty(hr.reviewedAt);
}

export function oracleA(c: P2Case): OracleA {
  // R11-OPEN-1 + D-1(a): an authorized P2 200 that already carries a usable review, on a Decision Support run.
  if (c.viewer.role === null || !DS_ADAPTIVE.has(c.adaptive) || !RECORDS[c.record].parses) return { built: false };
  const hr = storedHumanReview(c.record);
  const status = hr.status as string;
  const allowed = identityAllowed(c);
  if (PENDING.has(status)) return { built: true, humanReview: { state: "pending", decision: status, reviewedContent: "run_result_by_id_only" }, identityAllowed: allowed };
  // D-11(A) on P2: never decidedVia, never conditions; reviewedAt only under the singleReviewer predicate.
  const expected: Record<string, unknown> = { state: "decided", decision: status, reviewedContent: "run_result_by_id_only" };
  const singleReviewer = allowed && nonEmpty(hr.reviewerId) && (!hasOwn(hr, "decidedVia") || hr.decidedVia === "single_reviewer");
  if (singleReviewer && typeof hr.reviewedAt === "string") expected.reviewedAt = hr.reviewedAt;
  return { built: true, humanReview: expected, identityAllowed: allowed };
}

export const P2_RESTRICTED_VALUES = [...RESTRICTED_RECORD_VALUES, "uid-legacy-reviewer", "legacy-reason", "reviewer-1", "reviewer-2", "admin-1"];

/** The exact P2 view (contract key order, B §3.5 types): L4 constants only, the oracle's humanReview, nothing else. */
export function expectedP2View(a: Extract<OracleA, { built: true }>, flagText: string, historyText: string): Record<string, unknown> {
  return {
    kind: "ds_provenance_min",
    version: 1,
    surfaceId: "P2",
    l4: {
      option_clustering_unverified: true,
      option_clustering_unverified_text: flagText,
      option_clustering_unverified_knownDefect: "R5-P1-08",
      evidence_self_reported: true,
      sources_unchecked: true,
      freshness_not_evaluated: true,
      retry_text_not_retained: true,
      rules_unversioned: true,
      historical_rules_unknown: true,
      review_history_not_shown: true,
      review_history_not_shown_text: historyText,
    },
    humanReview: a.humanReview,
    useAuthorization: "not_authorized_no_policy",
  };
}
