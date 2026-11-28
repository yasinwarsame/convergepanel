/**
 * ZCA Round 2, Phase B (owner decision 2): product analytics (PostHog) is active ONLY on the Vercel
 * Production deployment. Preview, development, test and any deployment whose environment signal is
 * missing, empty or unrecognised send NOTHING, whatever PostHog key or host is configured: a misconfigured
 * or inherited key can never route non-Production traffic to a PostHog project.
 *
 * Trusted signals (set by the Vercel platform, never by a request):
 *   - server: `VERCEL_ENV`;
 *   - browser: `NEXT_PUBLIC_VERCEL_ENV` (inlined at build time; the project exposes system env vars).
 * Fail closed: anything other than the exact string "production" disables analytics.
 */

/** Server side (posthog-node client, `/ingest` proxy). */
export function serverAnalyticsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.VERCEL_ENV === "production";
}

/**
 * Browser side. `process.env.NEXT_PUBLIC_VERCEL_ENV` must stay a literal member access so Next.js inlines it.
 * The optional argument exists for tests only.
 */
export function clientAnalyticsEnabled(deploymentEnv: string | undefined = process.env.NEXT_PUBLIC_VERCEL_ENV): boolean {
  return deploymentEnv === "production";
}
