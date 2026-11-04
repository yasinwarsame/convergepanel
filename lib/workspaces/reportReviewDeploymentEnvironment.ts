/**
 * Report review — Production-only deployment guard (owner decision 2026-11-04, Option C).
 *
 * Report review may operate ONLY in the Vercel Production deployment. Vercel Preview currently shares Production's
 * Firebase project, so a Preview build of an activating commit would otherwise run the feature against Production data.
 * This guard is independent of the compile-time switch and the allow-list: all three must pass
 * (see lib/workspaces/reportReviewActivation.ts).
 *
 * Trusted signal: `VERCEL_ENV`, a Vercel system environment variable set by the platform for the deployment
 * (`production` | `preview` | `development`). It is read on the server at call time. It is never taken from a request
 * header, query parameter, cookie or browser configuration, and it has no NEXT_PUBLIC_ variant.
 *
 * Fail closed: anything other than the exact string "production" — unset, empty, "preview", "development", a different
 * case, surrounding whitespace — is NOT Production. Local `next dev`, Jest and CI therefore do not activate report review
 * UNLESS `VERCEL_ENV=production` is supplied explicitly — a test declaring it, or a local `.env.local` written by
 * `vercel env pull --environment=production` (which sets it). Operators must not run a local server with pulled
 * Production environment. In Production the value depends on Vercel's "Automatically expose System Environment
 * Variables" setting (currently on); verify the runtime value before relying on the guard for an activation.
 *
 * Read directly from process.env (not lib/env.ts) because lib/env.ts is frozen by the Order 6 boundary suites. Precedent:
 * lib/email/workspaceInvitations.ts reads `process.env.VERCEL_ENV` for the same Preview-safety purpose. A static test
 * pins this module as the only report-review module that reads VERCEL_ENV.
 */
import "server-only";

export function isProductionDeployment(): boolean {
  return process.env.VERCEL_ENV === "production";
}
