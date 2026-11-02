/**
 * Order B, Stage B1 (owner-authorized 2026-11-02): the Report Review record. It lets a Team research result that has
 * no governance record (Generic and the other non-Milestone-2 result types) be explicitly submitted for human approval.
 * Design contract: docs/workspaces/approval-b-report-review-design.md (rev 5).
 *
 * Pure: types, constants, a strict parser, the eligibility rule and builders. No I/O. The transactional writers live in
 * lib/workspaces/reportReviewMutations.ts.
 *
 * WHAT APPROVAL MEANS (D-B1): the report was reviewed and found acceptable for its stated purpose. It never certifies
 * factual correctness, claim verification, model confidence, or the existence of analysis the run does not have.
 * Nothing in this module synthesizes analysis: `scope` is copied from fields the saved run already has.
 */

import { Timestamp } from "firebase-admin/firestore";
import { SCHEMA_ANSWER_SHAPE, isPersistedLegacyAdaptiveSchemaId } from "@/lib/adaptiveSchema/persistedOutput";

// ---------------------------------------------------------------------------------------------------------------------
// Fixed copy and limits
// ---------------------------------------------------------------------------------------------------------------------

/** Fixed text shown with every report-review approval (D-B1). Never configurable, never replaced by the purpose note. */
export const REPORT_REVIEW_DISCLAIMER =
  "Approval means a reviewer read this report and found it acceptable for its stated purpose. It does not mean its factual claims, sources or model confidence were verified, or that analysis missing from the report exists.";

/** D-B1a: the fixed purpose categories. Workflow labels only; never certifications. */
export const REPORT_REVIEW_PURPOSES = Object.freeze(["internal_review", "client_delivery", "publication_review", "other"] as const);
export type ReportReviewPurposeCode = (typeof REPORT_REVIEW_PURPOSES)[number];

export const REPORT_REVIEW_PURPOSE_LABELS: Readonly<Record<ReportReviewPurposeCode, string>> = Object.freeze({
  internal_review: "Internal review",
  client_delivery: "Client delivery",
  publication_review: "Publication review",
  other: "Other",
});

/** D-B1a: optional note, at most 280 characters (counted as Unicode code points). */
export const REPORT_REVIEW_NOTE_MAX_CHARS = 280;

/**
 * #274 (5165761c) merged 2026-11-01T21:00:29Z; before it, a Generic run could never carry a legacy envelope. Runs
 * created before this instant may be submitted without an envelope: their single execution finished long ago, and a
 * governance record is only ever created inside a run's own execution (or on a brand-new snapshot run).
 */
export const REPORT_REVIEW_ENVELOPE_CUTOFF = Timestamp.fromDate(new Date("2026-11-01T21:00:29Z"));

// ---------------------------------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------------------------------

export type ReportReviewStatus = "unreviewed" | "pending" | "approved" | "approved_with_conditions" | "changes_requested" | "rejected";
const STATUSES: ReadonlySet<string> = new Set<ReportReviewStatus>(["unreviewed", "pending", "approved", "approved_with_conditions", "changes_requested", "rejected"]);
const OPEN_STATUSES: ReadonlySet<string> = new Set<ReportReviewStatus>(["unreviewed", "pending"]);

export interface ReportReviewPurpose {
  code: ReportReviewPurposeCode;
  note: string | null;
}

export interface ReportReviewScope {
  schemaId: string | null;
  unifiedAnswer: "present" | "absent";
  synthesis: "present" | "absent";
  consensus: "present" | "absent";
  respondedModels: number;
  requestedModels: number;
}

export interface ReportReviewHumanReview {
  status: ReportReviewStatus;
  reviewerId?: string;
  reviewedAt?: string;
  comment?: string;
  conditions?: string[];
}

export interface ReportReviewRecordV1 {
  version: 1;
  kind: "report_review";
  /** D-B6: the CURRENT cycle (1, 2, …). Earlier cycles live, write-once, in runs/{id}/reportReviewCycles/{n}. */
  cycle: number;
  scope: ReportReviewScope;
  purpose: ReportReviewPurpose;
  humanReview: ReportReviewHumanReview;
  submittedAt: string;
  submittedByUserId: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------------------------------------------------
// Purpose validation
// ---------------------------------------------------------------------------------------------------------------------

export type PurposeValidation = { ok: true; purpose: ReportReviewPurpose } | { ok: false; reason: "invalid_purpose" };

/** Exactly `{ code, note? }`: a known code and an optional string note of at most 280 code points (blank ⇒ null). */
export function validateReportReviewPurpose(raw: unknown): PurposeValidation {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, reason: "invalid_purpose" };
  const r = raw as Record<string, unknown>;
  if (!Object.keys(r).every((k) => k === "code" || k === "note")) return { ok: false, reason: "invalid_purpose" };
  if (typeof r.code !== "string" || !(REPORT_REVIEW_PURPOSES as readonly string[]).includes(r.code)) return { ok: false, reason: "invalid_purpose" };
  let note: string | null = null;
  if (r.note !== undefined && r.note !== null) {
    if (typeof r.note !== "string") return { ok: false, reason: "invalid_purpose" };
    const trimmed = r.note.trim();
    if (Array.from(trimmed).length > REPORT_REVIEW_NOTE_MAX_CHARS) return { ok: false, reason: "invalid_purpose" };
    note = trimmed.length > 0 ? trimmed : null;
  }
  return { ok: true, purpose: { code: r.code as ReportReviewPurposeCode, note } };
}

// ---------------------------------------------------------------------------------------------------------------------
// Eligibility (D-B7 option (a): positive evidence that the run can never hold a governance record)
// ---------------------------------------------------------------------------------------------------------------------

export type ReportReviewIneligibleReason =
  | "governed_run" // has, or will have, a governance record: uses the standard approval workflow
  | "already_submitted" // reportReview exists and is open
  | "already_decided" // reportReview exists and is decided: use resubmission (a new cycle)
  | "not_complete"
  | "no_review_information"; // D-B8: saved without the information approval review needs

export type ReportReviewEligibility = { eligible: true; scope: ReportReviewScope } | { eligible: false; reason: ReportReviewIneligibleReason };

/** The Milestone-2 (governed) schema ids: exactly the ids a governance record can be built for. */
export const GOVERNED_SCHEMA_IDS: ReadonlySet<string> = new Set(Object.keys(SCHEMA_ANSWER_SHAPE));

function hasOwn(o: Record<string, unknown>, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

/**
 * Decides, from the run document AS READ INSIDE THE SUBMISSION TRANSACTION, whether this run may enter report review.
 *
 * Exclusion invariant (proof in docs + reportReviewExclusion.spec.ts): a governance record is created only (1) by the
 * run's own single execution, after it saved a Milestone-2 `adaptiveOutput`, or (2) on a brand-new snapshot run. So a run
 * that (a) has no `governanceRecord`, (b) has no `adaptiveOutput`, and (c) carries a legacy envelope whose schema is not
 * Milestone-2 (or was created before legacy Generic envelopes existed) can never later receive a governance record.
 */
export function evaluateReportReviewEligibility(run: Record<string, unknown>): ReportReviewEligibility {
  if (hasOwn(run, "governanceRecord") && run.governanceRecord !== undefined && run.governanceRecord !== null) return { eligible: false, reason: "governed_run" };
  if (hasOwn(run, "adaptiveOutput") && run.adaptiveOutput !== undefined && run.adaptiveOutput !== null) return { eligible: false, reason: "governed_run" };
  if (hasOwn(run, "reportReview") && run.reportReview !== undefined && run.reportReview !== null) {
    const parsed = parseReportReviewRecord(run.reportReview);
    if (!parsed.ok) return { eligible: false, reason: "already_submitted" }; // fail closed: never overwrite an unreadable record
    return { eligible: false, reason: OPEN_STATUSES.has(parsed.record.humanReview.status) ? "already_submitted" : "already_decided" };
  }
  if (run.status !== "complete") return { eligible: false, reason: "not_complete" };

  const legacy = run.legacyAdaptiveOutput as Record<string, unknown> | undefined | null;
  let schemaId: string | null = null;
  if (legacy !== undefined && legacy !== null) {
    if (typeof legacy !== "object" || Array.isArray(legacy)) return { eligible: false, reason: "no_review_information" };
    const id = legacy.schemaId;
    if (typeof id !== "string" || GOVERNED_SCHEMA_IDS.has(id) || !isPersistedLegacyAdaptiveSchemaId(id)) return { eligible: false, reason: "no_review_information" };
    schemaId = id;
  } else {
    const createdAt = run.createdAt;
    if (!(createdAt instanceof Timestamp) || createdAt.toMillis() >= REPORT_REVIEW_ENVELOPE_CUTOFF.toMillis()) return { eligible: false, reason: "no_review_information" };
  }

  return { eligible: true, scope: deriveScope(run, schemaId) };
}

/** Copies what the saved run has. Never synthesizes, never upgrades. */
function deriveScope(run: Record<string, unknown>, schemaId: string | null): ReportReviewScope {
  const present = (v: unknown) => (v !== undefined && v !== null ? "present" : "absent") as "present" | "absent";
  const perModel = (run.runDocument as { perModel?: unknown } | undefined)?.perModel;
  const rows = Array.isArray(perModel) ? perModel : [];
  const responded = rows.filter((r) => {
    const s = (r as { status?: unknown })?.status;
    return s === "ok" || s === "substituted";
  }).length;
  const selected = Array.isArray(run.selectedModels) ? run.selectedModels.length : rows.length;
  const legacy = run.legacyAdaptiveOutput as Record<string, unknown> | undefined;
  return {
    schemaId,
    unifiedAnswer: present(run.synthesizedStructuredReport ?? legacy?.synthesisReport),
    synthesis: present(run.synthesizedStructuredReport ?? legacy?.synthesisReport),
    consensus: present(run.synthesisConsensusSummary ?? legacy?.trustSummary),
    respondedModels: responded,
    requestedModels: selected,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Parser (strict, fail closed)
// ---------------------------------------------------------------------------------------------------------------------

export type ReportReviewParse = { ok: true; record: ReportReviewRecordV1 } | { ok: false; reason: "absent" | "malformed" };

function isIso(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && !Number.isNaN(Date.parse(v));
}

export function parseReportReviewRecord(raw: unknown): ReportReviewParse {
  if (raw === undefined || raw === null) return { ok: false, reason: "absent" };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, reason: "malformed" };
  const r = raw as Record<string, unknown>;
  if (r.version !== 1 || r.kind !== "report_review") return { ok: false, reason: "malformed" };
  if (typeof r.cycle !== "number" || !Number.isInteger(r.cycle) || r.cycle < 1) return { ok: false, reason: "malformed" };
  const purpose = validateReportReviewPurpose(r.purpose);
  if (!purpose.ok) return { ok: false, reason: "malformed" };
  const hr = r.humanReview as Record<string, unknown> | undefined;
  if (!hr || typeof hr !== "object" || typeof hr.status !== "string" || !STATUSES.has(hr.status)) return { ok: false, reason: "malformed" };
  const sc = r.scope as Record<string, unknown> | undefined;
  const pa = (v: unknown) => v === "present" || v === "absent";
  if (
    !sc ||
    typeof sc !== "object" ||
    !(sc.schemaId === null || typeof sc.schemaId === "string") ||
    !pa(sc.unifiedAnswer) ||
    !pa(sc.synthesis) ||
    !pa(sc.consensus) ||
    typeof sc.respondedModels !== "number" ||
    typeof sc.requestedModels !== "number"
  )
    return { ok: false, reason: "malformed" };
  if (!isIso(r.submittedAt) || !isIso(r.createdAt) || !isIso(r.updatedAt) || typeof r.submittedByUserId !== "string" || r.submittedByUserId.length === 0) return { ok: false, reason: "malformed" };
  return { ok: true, record: r as unknown as ReportReviewRecordV1 };
}

export function isReportReviewDecided(record: ReportReviewRecordV1): boolean {
  return !OPEN_STATUSES.has(record.humanReview.status);
}

// ---------------------------------------------------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------------------------------------------------

export function buildReportReviewRecord(args: { cycle: number; scope: ReportReviewScope; purpose: ReportReviewPurpose; actorUid: string; now: string }): ReportReviewRecordV1 {
  return {
    version: 1,
    kind: "report_review",
    cycle: args.cycle,
    scope: { ...args.scope },
    purpose: { ...args.purpose },
    humanReview: { status: "unreviewed" },
    submittedAt: args.now,
    submittedByUserId: args.actorUid,
    createdAt: args.now,
    updatedAt: args.now,
  };
}

/** The immutable archive of one completed cycle: the record and its assignment exactly as they stood. */
export interface ReportReviewCycleArchiveV1 {
  version: 1;
  runId: string;
  cycle: number;
  record: ReportReviewRecordV1;
  assignment: Record<string, unknown> | null;
  archivedAt: string;
  archivedByUserId: string;
}

export function buildReportReviewCycleArchive(args: { runId: string; record: ReportReviewRecordV1; assignment: Record<string, unknown> | null; actorUid: string; now: string }): ReportReviewCycleArchiveV1 {
  return { version: 1, runId: args.runId, cycle: args.record.cycle, record: args.record, assignment: args.assignment, archivedAt: args.now, archivedByUserId: args.actorUid };
}

export type ReportReviewEventType = "report_review_submitted" | "report_review_resubmitted";

export interface ReportReviewEventV1 {
  version: 1;
  type: ReportReviewEventType;
  runId: string;
  workspaceId: string;
  projectId: string | null;
  actorUid: string;
  fromCycle: number | null;
  toCycle: number;
  purposeCode: ReportReviewPurposeCode;
  at: string;
}
