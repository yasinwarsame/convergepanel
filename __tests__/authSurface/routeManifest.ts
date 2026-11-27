/**
 * ZCA L-1 — the CLOSED-WORLD authorization inventory of every Route Handler in `app/`.
 *
 * Each entry records the exact file, its exported HTTP methods, its authorization class
 * and the exact enforcement function(s) that establish identity. `authSurfaceStatic.spec.ts`
 * derives the same facts from the source tree and fails when:
 *   - a route file exists that is not listed here (or a listed one no longer exists);
 *   - a route exports a method that is not listed (or stops exporting a listed one);
 *   - a route starts or stops calling an identity helper without this file being updated.
 * A new route therefore cannot ship without a reviewed classification.
 *
 * Classes:
 *   shared-identity  resolveRequestIdentity (directly)
 *   team             getRequestUid (lib/teams/teamApiAuth.ts; wraps resolveRequestIdentity)
 *   report-review    reportReviewCaller (lib/workspaces/reportReviewRouteSupport.ts; wraps resolveRequestIdentity)
 *   governance       resolveGovernanceRequestUser (lib/governance/authCheck.ts) -> authenticatePrivilegedPrincipal
 *                    (governance/policy also gates POST with requirePrivilegedAccess("GOVERNANCE_ADMIN"))
 *   privileged       requirePrivilegedAccess(tier) (lib/admin/privilegedAccess.ts); `tiers` per method
 *   session          /api/auth/session (POST mints from an ID token; DELETE clears). GET was removed in ZCA L-2.
 *                    It imports `isVerifierUnavailableCode` from resolveRequestIdentity (outage classification only).
 *   signature        authenticated by a provider signature only; resolves no user identity
 *   telemetry-proxy  first-party analytics proxies; credentials are stripped in middleware; no identity
 */
export type AuthClass = "shared-identity" | "team" | "report-review" | "governance" | "privileged" | "session" | "signature" | "telemetry-proxy";
export type Tier = "ADMIN_PORTAL" | "SYSTEM_ADMIN" | "GOVERNANCE_ADMIN";
export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD" | "OPTIONS";
export type RouteEntry = Readonly<{
  path: string;
  methods: readonly HttpMethod[];
  cls: AuthClass;
  enforcement: readonly string[];
  /** Privileged tier per method (privileged class, and the privileged method of a mixed route). */
  tiers?: Readonly<Partial<Record<HttpMethod, Tier>>>;
}>;

export const ROUTE_MANIFEST: readonly RouteEntry[] = [
  { path: "app/api/admin/access/route.ts", methods: ["GET"], cls: "privileged", enforcement: ["requirePrivilegedAccess"], tiers: {"GET": "ADMIN_PORTAL"} },
  { path: "app/api/admin/keys/route.ts", methods: ["GET", "POST"], cls: "privileged", enforcement: ["requirePrivilegedAccess"], tiers: {"GET": "SYSTEM_ADMIN", "POST": "SYSTEM_ADMIN"} },
  { path: "app/api/admin/purge-runs/route.ts", methods: ["POST"], cls: "privileged", enforcement: ["requirePrivilegedAccess"], tiers: {"POST": "SYSTEM_ADMIN"} },
  { path: "app/api/admin/runs/[runId]/route.ts", methods: ["DELETE", "GET", "PATCH"], cls: "privileged", enforcement: ["requirePrivilegedAccess"], tiers: {"DELETE": "SYSTEM_ADMIN", "GET": "ADMIN_PORTAL", "PATCH": "SYSTEM_ADMIN"} },
  { path: "app/api/admin/runs/route.ts", methods: ["GET"], cls: "privileged", enforcement: ["requirePrivilegedAccess"], tiers: {"GET": "ADMIN_PORTAL"} },
  { path: "app/api/admin/set-role/route.ts", methods: ["POST"], cls: "privileged", enforcement: ["requirePrivilegedAccess"], tiers: {"POST": "SYSTEM_ADMIN"} },
  { path: "app/api/admin/sync-subscription/route.ts", methods: ["POST"], cls: "privileged", enforcement: ["requirePrivilegedAccess"], tiers: {"POST": "SYSTEM_ADMIN"} },
  { path: "app/api/admin/test-webhook/route.ts", methods: ["POST"], cls: "privileged", enforcement: ["requirePrivilegedAccess"], tiers: {"POST": "SYSTEM_ADMIN"} },
  { path: "app/api/admin/users/[uid]/details/route.ts", methods: ["GET"], cls: "privileged", enforcement: ["requirePrivilegedAccess"], tiers: {"GET": "SYSTEM_ADMIN"} },
  { path: "app/api/admin/users/[uid]/override/route.ts", methods: ["DELETE", "POST"], cls: "privileged", enforcement: ["requirePrivilegedAccess"], tiers: {"DELETE": "SYSTEM_ADMIN", "POST": "SYSTEM_ADMIN"} },
  { path: "app/api/admin/users/[uid]/route.ts", methods: ["DELETE", "PATCH"], cls: "privileged", enforcement: ["requirePrivilegedAccess"], tiers: {"DELETE": "SYSTEM_ADMIN", "PATCH": "SYSTEM_ADMIN"} },
  { path: "app/api/admin/users/[uid]/stripe/cancel/route.ts", methods: ["POST"], cls: "privileged", enforcement: ["requirePrivilegedAccess"], tiers: {"POST": "SYSTEM_ADMIN"} },
  { path: "app/api/admin/users/[uid]/stripe/reactivate/route.ts", methods: ["POST"], cls: "privileged", enforcement: ["requirePrivilegedAccess"], tiers: {"POST": "SYSTEM_ADMIN"} },
  { path: "app/api/admin/users/[uid]/stripe/sync/route.ts", methods: ["POST"], cls: "privileged", enforcement: ["requirePrivilegedAccess"], tiers: {"POST": "SYSTEM_ADMIN"} },
  { path: "app/api/admin/users/route.ts", methods: ["GET"], cls: "privileged", enforcement: ["requirePrivilegedAccess"], tiers: {"GET": "ADMIN_PORTAL"} },
  { path: "app/api/admin/users/search/route.ts", methods: ["GET"], cls: "privileged", enforcement: ["requirePrivilegedAccess"], tiers: {"GET": "SYSTEM_ADMIN"} },
  { path: "app/api/auth/session/route.ts", methods: ["DELETE", "POST"], cls: "session", enforcement: ["verifyIdToken (POST mint)", "none (DELETE)", "resolveRequestIdentity"] },
  { path: "app/api/billing/create-checkout-session/route.ts", methods: ["POST"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/billing/create-portal-session/route.ts", methods: ["POST"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/billing/sync-plan/route.ts", methods: ["POST"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/billing/validate-subscription/route.ts", methods: ["POST"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/governance/audit/backfill/route.ts", methods: ["POST"], cls: "privileged", enforcement: ["requirePrivilegedAccess"], tiers: {"POST": "GOVERNANCE_ADMIN"} },
  { path: "app/api/governance/audit/route.ts", methods: ["GET"], cls: "governance", enforcement: ["resolveGovernanceRequestUser"] },
  { path: "app/api/governance/policy/route.ts", methods: ["GET", "POST"], cls: "governance", enforcement: ["requirePrivilegedAccess", "resolveGovernanceRequestUser"], tiers: {"POST": "GOVERNANCE_ADMIN"} },
  { path: "app/api/governance/queue/route.ts", methods: ["GET"], cls: "governance", enforcement: ["resolveGovernanceRequestUser"] },
  { path: "app/api/governance/review/route.ts", methods: ["POST"], cls: "governance", enforcement: ["resolveGovernanceRequestUser"] },
  { path: "app/api/governance/reviewer/route.ts", methods: ["GET", "POST"], cls: "governance", enforcement: ["resolveGovernanceRequestUser"] },
  { path: "app/api/run-panel/route.ts", methods: ["POST"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/stripe/webhook/route.ts", methods: ["POST"], cls: "signature", enforcement: ["stripe.webhooks.constructEvent"] },
  { path: "app/api/synthesize-panel/route.ts", methods: ["GET", "POST"], cls: "shared-identity", enforcement: ["resolveRequestIdentity", "secret/signature"] },
  { path: "app/api/teams/adaptive-runs/[runId]/assignment/route.ts", methods: ["DELETE", "GET", "PUT"], cls: "team", enforcement: ["getRequestUid"] },
  { path: "app/api/teams/adaptive-runs/[runId]/decision/route.ts", methods: ["POST"], cls: "team", enforcement: ["getRequestUid"] },
  { path: "app/api/teams/adaptive-runs/[runId]/history/route.ts", methods: ["GET"], cls: "team", enforcement: ["getRequestUid"] },
  { path: "app/api/teams/adaptive-runs/[runId]/review-panel/finalize/route.ts", methods: ["POST"], cls: "team", enforcement: ["getRequestUid"] },
  { path: "app/api/teams/adaptive-runs/[runId]/review-panel/override/route.ts", methods: ["POST"], cls: "team", enforcement: ["getRequestUid"] },
  { path: "app/api/teams/adaptive-runs/[runId]/review-panel/route.ts", methods: ["DELETE", "GET", "PUT"], cls: "team", enforcement: ["getRequestUid"] },
  { path: "app/api/teams/adaptive-runs/[runId]/route.ts", methods: ["GET"], cls: "team", enforcement: ["getRequestUid"] },
  { path: "app/api/teams/adaptive-runs/[runId]/votes/route.ts", methods: ["GET", "POST"], cls: "team", enforcement: ["getRequestUid"] },
  { path: "app/api/teams/audit-export/route.ts", methods: ["GET"], cls: "team", enforcement: ["getRequestUid"] },
  { path: "app/api/teams/members/route.ts", methods: ["DELETE", "POST"], cls: "team", enforcement: ["getRequestUid"] },
  { path: "app/api/teams/policies/route.ts", methods: ["GET", "PUT"], cls: "team", enforcement: ["getRequestUid"] },
  { path: "app/api/teams/route.ts", methods: ["GET", "POST"], cls: "team", enforcement: ["getRequestUid"] },
  { path: "app/api/teams/runs/[runId]/decision/route.ts", methods: ["POST"], cls: "team", enforcement: ["getRequestUid"] },
  { path: "app/api/teams/runs/route.ts", methods: ["GET"], cls: "team", enforcement: ["getRequestUid"] },
  { path: "app/api/user/email-verification-telemetry/route.ts", methods: ["POST"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/user/panel-history/route.ts", methods: ["GET"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/user/project-runs/route.ts", methods: ["GET"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/user/projects/[projectId]/archive/route.ts", methods: ["POST"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/user/projects/[projectId]/restore/route.ts", methods: ["POST"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/user/projects/[projectId]/route.ts", methods: ["PATCH"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/user/projects/route.ts", methods: ["GET", "POST"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/user/reviews/route.ts", methods: ["GET"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/user/run-governance/route.ts", methods: ["GET"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/user/runs/[runId]/decision/route.ts", methods: ["POST"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/user/runs/[runId]/export/route.ts", methods: ["POST"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/user/runs/[runId]/exports/[exportId]/route.ts", methods: ["GET"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/user/runs/[runId]/exports/route.ts", methods: ["GET"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/user/runs/[runId]/governance/route.ts", methods: ["GET"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/user/runs/[runId]/project/route.ts", methods: ["PATCH"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/user/runs/[runId]/review-history/route.ts", methods: ["GET"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/user/runs/[runId]/route.ts", methods: ["GET"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/user/usage/route.ts", methods: ["GET"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/user/verifications/[verificationId]/route.ts", methods: ["GET"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/user/workspace/route.ts", methods: ["GET", "POST"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/user/workspace/runs/route.ts", methods: ["GET"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/verify-claim/route.ts", methods: ["POST"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/verify-video/route.ts", methods: ["POST"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/workspace-invitations/[invitationId]/accept/route.ts", methods: ["POST"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/workspaces/[workspaceId]/audit-events/route.ts", methods: ["GET"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/workspaces/[workspaceId]/governance-summary/route.ts", methods: ["GET"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/workspaces/[workspaceId]/invitations/[invitationId]/resend/route.ts", methods: ["POST"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/workspaces/[workspaceId]/invitations/[invitationId]/revoke/route.ts", methods: ["POST"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/workspaces/[workspaceId]/invitations/route.ts", methods: ["GET", "POST"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/workspaces/[workspaceId]/members/[uid]/change-role/route.ts", methods: ["POST"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/workspaces/[workspaceId]/members/[uid]/remove/route.ts", methods: ["POST"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/workspaces/[workspaceId]/members/route.ts", methods: ["GET"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/workspaces/[workspaceId]/projects/[projectId]/archive/route.ts", methods: ["POST"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/workspaces/[workspaceId]/projects/[projectId]/assignees/route.ts", methods: ["POST"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/workspaces/[workspaceId]/projects/[projectId]/research/snapshots/route.ts", methods: ["POST"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/workspaces/[workspaceId]/projects/[projectId]/restore/route.ts", methods: ["POST"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/workspaces/[workspaceId]/projects/[projectId]/route.ts", methods: ["PATCH"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/workspaces/[workspaceId]/projects/[projectId]/runs/route.ts", methods: ["GET"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/workspaces/[workspaceId]/projects/[projectId]/verifications/route.ts", methods: ["GET"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/workspaces/[workspaceId]/projects/[projectId]/video-verifications/route.ts", methods: ["GET"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/workspaces/[workspaceId]/projects/route.ts", methods: ["GET", "POST"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/workspaces/[workspaceId]/review-integrity-metrics/route.ts", methods: ["GET"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/workspaces/[workspaceId]/review-queue/route.ts", methods: ["GET"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/workspaces/[workspaceId]/runs/[runId]/assignee/route.ts", methods: ["GET", "PATCH"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/workspaces/[workspaceId]/runs/[runId]/export/route.ts", methods: ["POST"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/workspaces/[workspaceId]/runs/[runId]/exports/[exportId]/route.ts", methods: ["GET"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/workspaces/[workspaceId]/runs/[runId]/exports/route.ts", methods: ["GET"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/workspaces/[workspaceId]/runs/[runId]/project/route.ts", methods: ["PATCH"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/workspaces/[workspaceId]/runs/[runId]/report-review/decision/route.ts", methods: ["POST"], cls: "report-review", enforcement: ["reportReviewCaller"] },
  { path: "app/api/workspaces/[workspaceId]/runs/[runId]/report-review/export/route.ts", methods: ["GET"], cls: "report-review", enforcement: ["reportReviewCaller"] },
  { path: "app/api/workspaces/[workspaceId]/runs/[runId]/report-review/resubmit/route.ts", methods: ["POST"], cls: "report-review", enforcement: ["reportReviewCaller"] },
  { path: "app/api/workspaces/[workspaceId]/runs/[runId]/report-review/route.ts", methods: ["GET", "POST"], cls: "report-review", enforcement: ["reportReviewCaller"] },
  { path: "app/api/workspaces/[workspaceId]/runs/[runId]/review-assignment/route.ts", methods: ["DELETE", "GET", "PUT"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/workspaces/[workspaceId]/runs/[runId]/review-context/route.ts", methods: ["GET"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/workspaces/[workspaceId]/runs/[runId]/review-decision/route.ts", methods: ["POST"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/workspaces/[workspaceId]/runs/[runId]/review-override/route.ts", methods: ["POST"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/workspaces/[workspaceId]/runs/[runId]/review-panel/finalize/route.ts", methods: ["POST"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/workspaces/[workspaceId]/runs/[runId]/review-panel/route.ts", methods: ["DELETE", "GET", "PUT"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/workspaces/[workspaceId]/runs/[runId]/review-panel/vote/route.ts", methods: ["POST"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/workspaces/[workspaceId]/runs/[runId]/review-resubmit/route.ts", methods: ["POST"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/workspaces/[workspaceId]/runs/[runId]/reviewer-candidates/route.ts", methods: ["GET"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/workspaces/[workspaceId]/runs/[runId]/route.ts", methods: ["GET"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/workspaces/[workspaceId]/runs/route.ts", methods: ["GET", "POST"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/workspaces/[workspaceId]/source-authority/route.ts", methods: ["GET", "POST"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/workspaces/[workspaceId]/transfer-ownership/route.ts", methods: ["POST"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/workspaces/[workspaceId]/verifications/[verificationId]/route.ts", methods: ["GET"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/workspaces/[workspaceId]/verifications/route.ts", methods: ["GET", "POST"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/workspaces/[workspaceId]/video-verifications/[verificationId]/route.ts", methods: ["GET"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/workspaces/[workspaceId]/video-verifications/route.ts", methods: ["GET", "POST"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/api/workspaces/route.ts", methods: ["GET", "POST"], cls: "shared-identity", enforcement: ["resolveRequestIdentity"] },
  { path: "app/ingest/[...path]/route.ts", methods: ["GET", "HEAD", "POST"], cls: "telemetry-proxy", enforcement: ["stripProxyCredentials (middleware)"] },
  { path: "app/monitoring/route.ts", methods: ["POST"], cls: "telemetry-proxy", enforcement: ["stripProxyCredentials (middleware)"] },
];
