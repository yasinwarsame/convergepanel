"use client";

/**
 * Query-Routing Redesign, Phase 2A, Step 7, Part E2 — a standalone,
 * testable submission service for the adaptive review decision route
 * (docs/governance-decision-receipts-design.md §26). Exactly one POST per
 * call, never retried automatically. The actual network call is injected
 * (`postJson`) so this function can be fully unit-tested without mocking
 * Firebase auth or rendering any component — the real caller wraps
 * `authedFetch`.
 *
 * Maps the route's REAL response shape and error codes (confirmed by
 * reading `app/api/teams/adaptive-runs/[runId]/decision/route.ts` directly,
 * Part D) — `stale_expected_updated_at` and `terminal_review_exists` are
 * the actual codes that route returns, not placeholders.
 */

import type { AdaptiveReviewDecisionRequest, AdaptiveReviewDecisionStatus } from "../governance/adaptiveReviewFormContract";

export type AdaptiveReviewSubmissionResult =
  | { kind: "success"; status: AdaptiveReviewDecisionStatus; reviewedAt: string; projectionSyncStatus: "synced" | "failed" }
  | { kind: "validation_error" }
  | { kind: "stale" }
  | { kind: "terminal" }
  | { kind: "unauthenticated" }
  | { kind: "forbidden" }
  | { kind: "not_found" }
  | { kind: "server_error" }
  | { kind: "unavailable" }
  /** A transport-level failure — the request may or may not have reached the server and committed. Never assumed to mean "the decision failed." */
  | { kind: "network_error" };

export interface PostJsonResponseLike {
  ok: boolean;
  status: number;
  json: () => Promise<any>;
}

export async function submitAdaptiveReviewDecision(args: {
  runId: string;
  request: AdaptiveReviewDecisionRequest;
  postJson: (url: string, body: unknown) => Promise<PostJsonResponseLike>;
}): Promise<AdaptiveReviewSubmissionResult> {
  let res: PostJsonResponseLike;
  try {
    res = await args.postJson(`/api/teams/adaptive-runs/${encodeURIComponent(args.runId)}/decision`, args.request);
  } catch {
    return { kind: "network_error" };
  }

  let body: any = null;
  try {
    body = await res.json();
  } catch {
    // Unreadable body — fall through to the generic server_error mapping below.
  }

  if (res.ok && body?.ok === true) {
    return {
      kind: "success",
      status: body.review?.status,
      reviewedAt: body.review?.reviewedAt,
      projectionSyncStatus: body.projectionSyncStatus === "synced" ? "synced" : "failed",
    };
  }

  const code = typeof body?.error?.code === "string" ? body.error.code : undefined;

  if (res.status === 401) return { kind: "unauthenticated" };
  if (res.status === 403) return { kind: "forbidden" };
  if (res.status === 404) return { kind: "not_found" };
  if (res.status === 409 && code === "stale_expected_updated_at") return { kind: "stale" };
  if (res.status === 409 && code === "terminal_review_exists") return { kind: "terminal" };
  if (res.status === 400) return { kind: "validation_error" };
  if (res.status === 503) return { kind: "unavailable" };
  return { kind: "server_error" };
}
