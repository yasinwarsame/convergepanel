/**
 * Order B, Stage B1 — Report Review rollout switch.
 *
 * Deliberately a COMPILE-TIME constant, not an environment variable: Stage B1 is authorized to ship dark only, and
 * `lib/env.ts` is frozen by the Order 6 boundary suites (dsExportBoundaries / dsProvenanceUiBoundaries pin it
 * byte-for-byte). Turning Report Review on therefore requires a separate, reviewed change and an owner enablement
 * decision — it cannot happen through configuration alone. Tests override this module with jest.mock.
 * (Stage history: B1–B3 shipped dark. The TeamCP pilot change, owner decision 2026-11-04, turns it on for one Workspace.)
 */
export const REPORT_REVIEW_ENABLED = true as boolean;

/**
 * Owner Order B (2026-11-03) — single-workspace activation allow-list. Report review operates ONLY for a Workspace listed
 * here, AND only while REPORT_REVIEW_ENABLED is true. Default deny: empty. The trial Workspace id is named by the owner in
 * a separate activation decision and added by a reviewed PR; it is never hard-coded speculatively. Validated by
 * lib/workspaces/reportReviewActivation.ts, which fails closed on any malformed configuration (see there). The shipped
 * value is pinned (real module, no mock) by lib/workspaces/__tests__/reportReviewTeamcpPilot.spec.ts.
 */
export const REPORT_REVIEW_WORKSPACE_ALLOWLIST: readonly string[] = [
  // Owner pilot decision (2026-11-04): Team Workspace "TeamCP" only. Rollback = revert this change (switch false, list []).
  "Aw6kbjROOaOIhCXUiKlq",
];
