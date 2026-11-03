/**
 * Report review — reviewed-content integrity (owner Order A, 2026-11-03). Server-only, pure (no I/O).
 *
 * Every review cycle is bound to the exact research content that was submitted, by a server-computed fingerprint of a
 * versioned canonical representation of the saved run. The fingerprint is computed inside the submission transaction
 * from the run as read in that transaction, stored write-once on the cycle's record, and re-computed inside the
 * decision transaction: a decision on content that no longer matches is refused (`content_changed`). No client value
 * is ever trusted as a fingerprint or content version.
 *
 * CONTENT BOUNDARY (`rrc-v1`): DEFAULT INCLUDE. Every top-level field of the saved run document is reviewable content
 * EXCEPT the fields listed in REPORT_REVIEW_CONTENT_EXCLUDED_FIELDS, each excluded because it is shown to be unrelated
 * to what the report says (ownership/binding, timestamps, usage metrics, counters, assignment, review state). Fields
 * nested inside included fields are all included, except per-model usage/timing metrics
 * (REPORT_REVIEW_CONTENT_EXCLUDED_MODEL_FIELDS). Consequence: a field nobody classified (for example one added by a
 * future writer) is INCLUDED, so it can only cause a spurious "content changed" (safe direction: renewed review), never
 * let changed content pass as reviewed.
 *
 * Included in practice: question, questionContext, selectedModels, status, every saved model response (runDocument /
 * resultsCompact / legacy results: model, status, text, truncation, provider, substitution), the saved structured result
 * (legacyAdaptiveOutput, including claims, disagreement/alignment, gate, synthesis report, trust summary), the saved
 * synthesis (synthesizedStructuredReport, schemaVersion, synthesizedBy, synthesisConsensusSummary,
 * policyConsensusSummary, synthesisConsensusAudit), truncation flags, and any other unclassified field.
 *
 * CANONICAL FORM: UTF-8 JSON with object keys sorted by UTF-16 code unit order, arrays in stored order, no whitespace.
 * `null` is serialized as null; an absent field is absent (absence and null are distinct). Numbers must be finite and are
 * serialized by ECMAScript Number-to-String (so 1 and 1.0 are the same value, as Firestore stores them; -0 becomes 0).
 * Firestore Timestamps (and Dates) become {"$timestamp":"<seconds>.<9-digit nanoseconds>"}. Any other non-JSON value
 * (GeoPoint, DocumentReference, bytes, NaN, Infinity, functions, symbols, bigint) makes the content UNFINGERPRINTABLE:
 * submission fails closed rather than recording a fingerprint that does not cover the content.
 *
 * FINGERPRINT: SHA-256 (hex) over the UTF-8 bytes of "rrc-v1\n" followed by the canonical JSON. Bounded: canonical
 * content over REPORT_REVIEW_CONTENT_MAX_BYTES fails closed (`too_large`) — never a partial fingerprint.
 */
import "server-only";
import { createHash } from "crypto";

export const REPORT_REVIEW_CONTENT_VERSION = "rrc-v1" as const;
export const REPORT_REVIEW_CONTENT_ALGORITHM = "sha256" as const;
/**
 * S1: the canonical content is stored, write-once, as ONE snapshot document (runs/{R}/reportReviewSnapshots/{cycle}), and a
 * Firestore document is at most 1 MiB. 900,000 bytes leaves room for the snapshot's other fields. Larger content fails
 * closed (`too_large`): it is never fingerprinted without being preserved. Runs are already truncated to fit Firestore.
 */
export const REPORT_REVIEW_CONTENT_MAX_BYTES = 900_000;

/** Top-level run fields that are NOT report content, with the reason each is unrelated to report meaning. */
export const REPORT_REVIEW_CONTENT_EXCLUDED_FIELDS: Readonly<Record<string, string>> = Object.freeze({
  userId: "ownership (who ran it), not what the report says",
  workspaceId: "binding to a Workspace",
  projectId: "filing (a run can be moved between Projects without changing its content)",
  assigneeUid: "research assignment (responsibility), not content",
  assigneeUids: "research assignment (responsibility), not content",
  origin: "provenance of a Team snapshot (where it was copied from), not content",
  createdAt: "timestamp",
  completedAt: "timestamp",
  synthesizedAt: "timestamp (a regenerated synthesis changes the synthesis fields themselves)",
  synthesisInputHash: "cache key for synthesis inputs (the inputs themselves are included)",
  synthesisMetadata: "timing and size metrics of the synthesis call",
  tokenUsage: "usage metric",
  totalTokens: "usage metric",
  tokensByModel: "usage metric",
  tokensByProvider: "usage metric",
  promptTokensByProvider: "usage metric",
  completionTokensByProvider: "usage metric",
  geminiHasUsageMetadata: "usage-metric audit flag",
  documentSizeChars: "storage-size metric",
  adaptiveExportCounter: "count of exports made (increments on every export)",
  reportReview: "the review record itself (status, decision, fingerprint)",
  governanceRecord: "governed-review record (a report-review run never has one; B1 invariant)",
  teamGovernance: "Team policy evaluation snapshot (governance state, not report content)",
  errorMessage: "failure text of a run that did not complete (such runs are not eligible)",
  deletion: "research-deletion workflow marker (lib/firestore/researchDeletion.ts), not content",
  governanceStatus: "organization policy evaluation result (governance state, like teamGovernance), written after synthesis",
  governanceReasons: "organization policy evaluation reasons (governance state), written after synthesis",
  governanceMeta: "organization policy evaluation metadata (incl. evaluatedAt), written after synthesis",
  adaptiveRetryUsage: "usage accounting for adaptive retries, written after completion",
});

/** Per-model fields that are usage/timing metrics, excluded wherever a model result appears. */
export const REPORT_REVIEW_CONTENT_EXCLUDED_MODEL_FIELDS: ReadonlySet<string> = new Set(["tokenUsage", "latencyMs", "usage", "costUsd", "timing", "elapsedMs"]);
const MODEL_RESULT_CONTAINERS: ReadonlySet<string> = new Set(["runDocument", "resultsCompact", "results"]);

export interface ReportReviewContentFingerprint {
  version: typeof REPORT_REVIEW_CONTENT_VERSION;
  algorithm: typeof REPORT_REVIEW_CONTENT_ALGORITHM;
  digest: string;
  canonicalBytes: number;
}

export type ReportReviewContentFingerprintResult = { ok: true; fingerprint: ReportReviewContentFingerprint; canonical: string } | { ok: false; reason: "unsupported_value" | "too_large" | "not_an_object" };

class Unsupported extends Error {}

function isTimestampLike(v: object): v is { seconds: number; nanoseconds: number } {
  const t = v as { seconds?: unknown; nanoseconds?: unknown; toDate?: unknown };
  return typeof t.toDate === "function" && typeof t.seconds === "number" && typeof t.nanoseconds === "number";
}

function canonicalValue(v: unknown, stripModelMetrics: boolean): unknown {
  if (v === null) return null;
  switch (typeof v) {
    case "string":
    case "boolean":
      return v;
    case "number":
      if (!Number.isFinite(v)) throw new Unsupported();
      return Object.is(v, -0) ? 0 : v;
    case "object":
      break;
    default:
      throw new Unsupported(); // undefined inside arrays, bigint, symbol, function
  }
  const o = v as object;
  if (Array.isArray(o)) return o.map((x) => canonicalValue(x, stripModelMetrics));
  if (o instanceof Date) {
    const ms = o.getTime();
    if (!Number.isFinite(ms)) throw new Unsupported();
    const seconds = Math.floor(ms / 1000);
    return { $timestamp: `${seconds}.${String((ms - seconds * 1000) * 1_000_000).padStart(9, "0")}` };
  }
  if (isTimestampLike(o)) {
    if (!Number.isInteger(o.seconds) || !Number.isInteger(o.nanoseconds) || o.nanoseconds < 0 || o.nanoseconds > 999_999_999) throw new Unsupported();
    return { $timestamp: `${o.seconds}.${String(o.nanoseconds).padStart(9, "0")}` };
  }
  const proto = Object.getPrototypeOf(o);
  if (proto !== Object.prototype && proto !== null) throw new Unsupported(); // GeoPoint, DocumentReference, Buffer, …
  // A stored map can never be mistaken for a Timestamp's encoding: a "$timestamp" key fails closed (unambiguous form).
  if (Object.prototype.hasOwnProperty.call(o, "$timestamp")) throw new Unsupported();
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o).sort()) {
    const val = (o as Record<string, unknown>)[k];
    if (val === undefined) continue; // Firestore never stores undefined; treated as absent
    if (stripModelMetrics && REPORT_REVIEW_CONTENT_EXCLUDED_MODEL_FIELDS.has(k)) continue;
    out[k] = canonicalValue(val, stripModelMetrics);
  }
  return out;
}

/** Stable JSON: keys of every object sorted (canonicalValue already returns key-sorted objects), no whitespace. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
    .join(",")}}`;
}

/** The canonical reviewable content of a saved run (rrc-v1), as a string. Throws nothing: failures are returned. */
export function canonicalReportReviewContent(run: unknown): { ok: true; canonical: string } | { ok: false; reason: "unsupported_value" | "too_large" | "not_an_object" } {
  if (typeof run !== "object" || run === null || Array.isArray(run)) return { ok: false, reason: "not_an_object" };
  const content: Record<string, unknown> = {};
  try {
    for (const k of Object.keys(run).sort()) {
      if (Object.prototype.hasOwnProperty.call(REPORT_REVIEW_CONTENT_EXCLUDED_FIELDS, k)) continue;
      const val = (run as Record<string, unknown>)[k];
      if (val === undefined) continue;
      content[k] = canonicalValue(val, MODEL_RESULT_CONTAINERS.has(k));
    }
  } catch (e) {
    if (e instanceof Unsupported) return { ok: false, reason: "unsupported_value" };
    throw e;
  }
  const canonical = stableStringify(content);
  if (Buffer.byteLength(canonical, "utf8") > REPORT_REVIEW_CONTENT_MAX_BYTES) return { ok: false, reason: "too_large" };
  return { ok: true, canonical };
}

export function computeReportReviewContentFingerprint(run: unknown): ReportReviewContentFingerprintResult {
  const c = canonicalReportReviewContent(run);
  if (!c.ok) return c;
  const digest = createHash("sha256").update(`${REPORT_REVIEW_CONTENT_VERSION}\n${c.canonical}`, "utf8").digest("hex");
  return { ok: true, canonical: c.canonical, fingerprint: { version: REPORT_REVIEW_CONTENT_VERSION, algorithm: REPORT_REVIEW_CONTENT_ALGORITHM, digest, canonicalBytes: Buffer.byteLength(c.canonical, "utf8") } };
}

export function isReportReviewContentFingerprint(v: unknown): v is ReportReviewContentFingerprint {
  if (typeof v !== "object" || v === null) return false;
  const f = v as Record<string, unknown>;
  return f.version === REPORT_REVIEW_CONTENT_VERSION && f.algorithm === REPORT_REVIEW_CONTENT_ALGORITHM && typeof f.digest === "string" && /^[0-9a-f]{64}$/.test(f.digest) && typeof f.canonicalBytes === "number" && Number.isInteger(f.canonicalBytes) && f.canonicalBytes >= 2;
}

export function sameReportReviewContent(a: ReportReviewContentFingerprint, b: ReportReviewContentFingerprint): boolean {
  return a.version === b.version && a.algorithm === b.algorithm && a.digest === b.digest && a.canonicalBytes === b.canonicalBytes;
}

/**
 * S1 — the reviewed-content snapshot: the exact canonical content a cycle was submitted with, stored write-once
 * (`tx.create`) in the SAME transaction that records the cycle's fingerprint, at runs/{R}/reportReviewSnapshots/{cycle}.
 * It is readable only through server routes that have already authorized the caller for THIS run's Workspace, and every
 * read re-verifies it (verifyReportReviewContentSnapshot). It is deleted only by the research-deletion workflow
 * (lib/firestore/researchDeletion.ts), together with the run.
 */
export interface ReportReviewContentSnapshotV1 {
  version: 1;
  runId: string;
  workspaceId: string;
  cycle: number;
  fingerprint: ReportReviewContentFingerprint;
  canonical: string;
  createdAt: string;
  createdByUserId: string;
}

export function buildReportReviewContentSnapshot(args: { runId: string; workspaceId: string; cycle: number; fingerprint: ReportReviewContentFingerprint; canonical: string; now: string; actorUid: string }): ReportReviewContentSnapshotV1 {
  return { version: 1, runId: args.runId, workspaceId: args.workspaceId, cycle: args.cycle, fingerprint: { ...args.fingerprint }, canonical: args.canonical, createdAt: args.now, createdByUserId: args.actorUid };
}

/**
 * Re-verifies a stored snapshot against the cycle's own fingerprint and binding. Anything else is "invalid" (never
 * presented): wrong run/Workspace/cycle, a fingerprint that differs from the record's, or content whose digest no longer
 * matches. Returns the parsed reviewed content on success.
 */
export function verifyReportReviewContentSnapshot(
  raw: unknown,
  expected: { runId: string; workspaceId: string; cycle: number; fingerprint: ReportReviewContentFingerprint }
): { ok: true; content: Record<string, unknown> } | { ok: false } {
  if (typeof raw !== "object" || raw === null) return { ok: false };
  const s = raw as Record<string, unknown>;
  if (s.version !== 1 || s.runId !== expected.runId || s.workspaceId !== expected.workspaceId || s.cycle !== expected.cycle) return { ok: false };
  if (!isReportReviewContentFingerprint(s.fingerprint) || !sameReportReviewContent(s.fingerprint, expected.fingerprint)) return { ok: false };
  if (typeof s.canonical !== "string") return { ok: false };
  const digest = createHash("sha256").update(`${REPORT_REVIEW_CONTENT_VERSION}\n${s.canonical}`, "utf8").digest("hex");
  if (digest !== expected.fingerprint.digest || Buffer.byteLength(s.canonical, "utf8") !== expected.fingerprint.canonicalBytes) return { ok: false };
  try {
    const content = JSON.parse(s.canonical);
    return typeof content === "object" && content !== null && !Array.isArray(content) ? { ok: true, content } : { ok: false };
  } catch {
    return { ok: false };
  }
}
