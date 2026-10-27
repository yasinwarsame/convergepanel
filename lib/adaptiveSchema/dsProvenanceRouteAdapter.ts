/**
 * AI Integrity Order 6, slice S-1b.1 — the route adapter that attaches the
 * S-1a-min Decision Support provenance view to an ALREADY-AUTHORIZED
 * successful read response on P1 (`GET /api/user/runs/[runId]`) and W1
 * (`GET /api/workspaces/[workspaceId]/runs/[runId]`), and (S-1b.2) on P2
 * (`GET /api/user/runs/[runId]/governance`) through `buildDsProvenanceP2View`.
 * Nothing else: W2 is deferred (owner ruling D-W2).
 *
 * Owner rulings (S-1b.1-GO): SC2-3 → S-1a-min is sufficient; R11-OPEN-1 →
 * build only when the response already carries a usable review; one optional
 * top-level `dsProvenance` field; default-off `DS_PROVENANCE_ROUTE_VIEW_ENABLED`.
 *
 * Pure: no I/O, logging, clock, environment or configuration read. The route
 * reads the flag and passes `enabled`; when it is false the builder is never
 * called. Every input is a value the route already holds for this viewer:
 *   - `payload` is the route's own `RunReadPayload` (its public projection);
 *   - `governanceRecord` is the run document's stored record, which the
 *     builder reads only through `parseGovernanceRecord`;
 *   - `surfaceRequest` is the route's own viewer context, passed through
 *     unchanged. The builder validates the exact shape and fails closed on
 *     any mismatch; this module derives no role, gate or permission.
 *
 * Returns the view, or `null` when no view may be attached. `null` covers
 * every not-built outcome — flag off, adaptive output not valid, no review in
 * the projection, not Decision Support, context mismatch, and any review the
 * view could only report as unavailable or absent — so a client can never
 * tell those cases apart (no reason code, no marker, no log).
 */

import type { RunReadPayload, RunReadViewerRole } from "@/lib/runs/runReadPayload";
import { buildDsProvenanceViewMin, type DsProvenanceViewMin } from "./dsProvenanceViewMin";
import { parseGovernanceRecord } from "./governanceRecordParser";
import { parsePersistedAdaptiveOutput } from "./persistedOutput";

export type DsProvenanceRouteView = Extract<DsProvenanceViewMin, { kind: "ds_provenance_min" }>;

/** The route's own viewer context, as it holds it. Combinations the builder does not accept are rejected there. */
export type DsProvenanceRouteSurfaceRequest =
  | { surfaceId: "P1"; path: "personal" | "team_bound"; role: RunReadViewerRole; mayReadDecisionContent: boolean }
  | { surfaceId: "W1"; role: RunReadViewerRole };

export function buildDsProvenanceRouteView(args: {
  enabled: boolean;
  surfaceRequest: DsProvenanceRouteSurfaceRequest;
  payload: Pick<RunReadPayload, "results" | "adaptive">;
  governanceRecord: unknown;
}): DsProvenanceRouteView | null {
  if (args.enabled !== true) return null;

  // R11-OPEN-1: only when this response already carries a usable review. The
  // payload's `humanReview` is non-null exactly when the adaptive output is
  // valid and the stored record parses, so an absent and an unreadable record
  // both stop here, identically.
  const { adaptive } = args.payload;
  if (adaptive.status !== "valid" || adaptive.humanReview === null) return null;

  const view = buildDsProvenanceViewMin({
    publicResults: args.payload.results,
    publicAdaptiveOutput: adaptive.output,
    governanceRecord: args.governanceRecord,
    surfaceRequest: args.surfaceRequest,
  });
  if (view.kind !== "ds_provenance_min") return null;
  // The gate above makes these unreachable; they still never reach a client.
  if (view.humanReview === undefined || view.humanReview.state === "none") return null;
  return view;
}

/** P2's own viewer context: the role and reviewer-identity gate the governance route already derived. */
export type DsProvenanceP2SurfaceRequest = { surfaceId: "P2"; role: "owner" | "personal_reviewer"; mayReadDecisionReviewer: boolean };

const P2_VIEW_KEYS = ["kind", "version", "surfaceId", "l4", "humanReview", "useAuthorization"];

/**
 * Order 6 S-1b.2 — the P2 (`GET /api/user/runs/[runId]/governance`) sibling of
 * `buildDsProvenanceRouteView`, under the same flag and the same rules.
 *
 * Owner rulings (S-1b.2-GO): D-P2 — the Decision Support gate input is the run
 * document's stored `adaptiveOutput`, parsed here exactly as P1's projection
 * parses it, from the document P2 already read (no read, no cross-route call);
 * D-P2-X — the view's presence may reveal that output's validity to the
 * already-authorized P2 viewer only; C-P2 — one optional top-level field.
 *
 * Pure, like the P1/W1 adapter. When `enabled` is false nothing is parsed and
 * the builder is never called. P2 carries no L1–L3 and no data-derived L4
 * (I-6), and no `decidedVia` or `conditions` (D-11(A)); the builder enforces
 * both, and the result is checked against that exact shape here as well.
 */
export function buildDsProvenanceP2View(args: {
  enabled: boolean;
  surfaceRequest: DsProvenanceP2SurfaceRequest;
  storedAdaptiveOutput: unknown;
  governanceRecord: unknown;
}): DsProvenanceRouteView | null {
  if (args.enabled !== true) return null;

  // R11-OPEN-1: only when the P2 response already carries a usable review —
  // the record parses, the same condition that gives it `humanReviewStatus`.
  if (!parseGovernanceRecord(args.governanceRecord).ok) return null;
  const output = parsePersistedAdaptiveOutput(args.storedAdaptiveOutput);
  if (!output.ok) return null;

  const view = buildDsProvenanceViewMin({
    publicResults: null,
    publicAdaptiveOutput: output.output,
    governanceRecord: args.governanceRecord,
    surfaceRequest: args.surfaceRequest,
  });
  if (view.kind !== "ds_provenance_min" || view.surfaceId !== "P2") return null;
  if (Object.keys(view).join() !== P2_VIEW_KEYS.join()) return null;
  const review = view.humanReview;
  if (review === undefined || review.state === "none") return null;
  if ("decidedVia" in review || "conditions" in review) return null;
  return view;
}
