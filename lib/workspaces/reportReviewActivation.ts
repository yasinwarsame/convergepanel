/**
 * Owner Order B (2026-11-03) — the ONE activation rule for every report-review read and write surface.
 *
 *   isReportReviewEnabledForWorkspace(workspaceId) ⇔ the server runs in the Vercel Production deployment
 *                                                  ∧ REPORT_REVIEW_ENABLED
 *                                                  ∧ the allow-list configuration is valid
 *                                                  ∧ workspaceId is a string listed in it
 *
 * Valid configuration (anything else disables report review EVERYWHERE — fail closed, never "allow all"):
 *   - an array of strings, each a plausible Firestore document id (1–128 of [A-Za-z0-9_-]);
 *   - no duplicates;
 *   - at most REPORT_REVIEW_MAX_ACTIVE_WORKSPACES entries (a single-workspace trial; widening needs a reviewed change).
 *
 * This rule ADDS a restriction; it never grants anything. Membership, capabilities, reviewer eligibility, self-review and
 * submitter/creator restrictions and Workspace containment are all still enforced by each surface exactly as before, and
 * the Workspace checked here is always the one the operation targets (the route's Workspace for HTTP surfaces, the run's
 * own validated binding for run-level hooks), so a member of the trial Workspace gains nothing in any other Workspace.
 * Governed review never consults this rule.
 */
import { REPORT_REVIEW_ENABLED, REPORT_REVIEW_WORKSPACE_ALLOWLIST } from "./reportReviewRollout";
import { isProductionDeployment } from "./reportReviewDeploymentEnvironment";

export const REPORT_REVIEW_MAX_ACTIVE_WORKSPACES = 1;
const WORKSPACE_ID = /^[A-Za-z0-9_-]{1,128}$/;

export type ReportReviewActivationConfig = { status: "disabled" } | { status: "invalid" } | { status: "active"; workspaceIds: ReadonlySet<string> };

/** Pure: evaluates a configuration. Exported for tests; production code calls the two functions below. */
export function evaluateReportReviewActivation(enabled: unknown, allowlist: unknown): ReportReviewActivationConfig {
  if (enabled !== true) return { status: "disabled" };
  if (!Array.isArray(allowlist)) return { status: "invalid" };
  if (allowlist.length === 0) return { status: "disabled" };
  if (allowlist.length > REPORT_REVIEW_MAX_ACTIVE_WORKSPACES) return { status: "invalid" };
  if (!allowlist.every((id) => typeof id === "string" && WORKSPACE_ID.test(id))) return { status: "invalid" };
  const ids = new Set(allowlist as string[]);
  if (ids.size !== allowlist.length) return { status: "invalid" };
  return { status: "active", workspaceIds: ids };
}

export function reportReviewActivationConfig(): ReportReviewActivationConfig {
  // Production-only guard (Option C): outside the Vercel Production deployment report review is disabled everywhere,
  // whatever the switch and allow-list say. Checked first, so no other configuration is consulted there.
  if (!isProductionDeployment()) return { status: "disabled" };
  return evaluateReportReviewActivation(REPORT_REVIEW_ENABLED, REPORT_REVIEW_WORKSPACE_ALLOWLIST);
}

export function isReportReviewEnabledForWorkspace(workspaceId: unknown): boolean {
  if (typeof workspaceId !== "string") return false;
  const cfg = reportReviewActivationConfig();
  return cfg.status === "active" && cfg.workspaceIds.has(workspaceId);
}
