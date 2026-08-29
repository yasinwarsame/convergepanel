/**
 * Team Workspace Boundary Hardening, backend correction (10C.4A-U2B) — the
 * ONE shared definition of "substantively usable decision receipt,"
 * reused by both the Team review client (`lib/client/workspaceReviewClient.ts`,
 * which additionally structurally validates untrusted wire data before
 * calling this) and every Team Workspace backend mutation that records a
 * substantive human judgment (`submitWorkspaceReviewDecision`,
 * `submitWorkspaceReviewPanelVote`, `overrideWorkspaceReviewPanel` — see
 * their own call sites for the exact transactional placement).
 *
 * Deliberately importable from client code: no `"server-only"` guard, no
 * Firestore/admin import, no React/browser dependency. Pure and
 * side-effect free.
 *
 * A receipt can be structurally valid (every field present, correctly
 * typed — `parseGovernanceRecord()` already guarantees this before any
 * caller ever reaches this function) while substantively empty: at least
 * 5 of 9 `decisionReceiptBuilder.ts` schemas pass a raw per-model field
 * straight through as `conclusion`, and that field's upstream alignment
 * logic can legitimately resolve to an empty string when every
 * contributing model returns no usable text for it — a real
 * partial-degradation state, not corrupted data. Structural validity and
 * substantive usability are independent questions; this function answers
 * only the second one, given a value already known to satisfy the first.
 *
 * Deliberately does NOT require any supporting list (`basis`/
 * `assumptions`/`uncertainties`/`limitations`) to be non-empty — at least
 * 3 schemas' own legitimate "nothing found" paths (e.g.
 * `comparison_matrix`'s non-convergence conclusion) produce a meaningful,
 * honest conclusion with every supporting list empty. Requiring
 * supporting content would incorrectly reject those valid receipts.
 */
export function isSubstantiveDecisionReceiptConclusion(conclusion: string): boolean {
  return conclusion.trim().length > 0;
}
