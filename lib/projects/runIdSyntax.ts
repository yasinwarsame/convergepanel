/**
 * Run/Project Association, Phase 6D.4A — narrow syntax validation for a
 * caller-supplied run id, applied before any `runs/{runId}` lookup. This
 * is defense-in-depth, not authorization: a syntactically valid id can
 * still fail to resolve, belong to another user, or not exist at all —
 * those are `associateRunWithProject()`'s concern, and both failure kinds
 * collapse to the same concealed response so a malformed id can never be
 * distinguished from a well-formed-but-foreign one (no enumeration
 * oracle). Exact structural mirror of `lib/projects/projectId.ts`; run ids
 * are also opaque strings used directly as a Firestore document path
 * segment, so the same defensive checks apply unchanged.
 */

import "server-only";

export type ValidateRunIdResult = { ok: true; runId: string } | { ok: false; reason: "invalid_run_id" };

// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_PATTERN = /[\x00-\x1f\x7f]/;

const MAX_RUN_ID_BYTES = 1500; // Firestore's own document-id byte limit

export function validateRunIdSyntax(runId: unknown): ValidateRunIdResult {
  if (typeof runId !== "string") return { ok: false, reason: "invalid_run_id" };
  if (runId.length === 0) return { ok: false, reason: "invalid_run_id" };
  if (runId.trim() !== runId) return { ok: false, reason: "invalid_run_id" };
  if (CONTROL_CHAR_PATTERN.test(runId)) return { ok: false, reason: "invalid_run_id" };
  if (runId.includes("/")) return { ok: false, reason: "invalid_run_id" };
  if (runId === "." || runId === "..") return { ok: false, reason: "invalid_run_id" };
  if (Buffer.byteLength(runId, "utf8") > MAX_RUN_ID_BYTES) return { ok: false, reason: "invalid_run_id" };

  return { ok: true, runId };
}
