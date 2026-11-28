import "server-only";

/**
 * ZCA P3 R2 L-2 — the Vercel system environment variables that name THIS deployment's own hosts (host names, no
 * scheme): `VERCEL_URL` (the unique deployment URL) and `VERCEL_BRANCH_URL` (the git-branch alias). Both are set by
 * the platform, never by a request. Read at call time. Sole consumer: the session verification handshake's
 * allowed-origin set (app/api/auth/session/route.ts).
 *
 * Why not lib/env.ts: lib/env.ts is a byte-frozen file for three sealed feature boundaries
 * (dsProvenanceUiBoundaries, dsExportBoundaries, readableFrozenFiles). Like
 * lib/workspaces/reportReviewDeploymentEnvironment.ts (VERCEL_ENV), this platform-signal reader is its own module.
 */
export function getVercelDeploymentHosts(): readonly string[] {
  return [process.env.VERCEL_URL, process.env.VERCEL_BRANCH_URL]
    .filter((h): h is string => typeof h === "string" && h.trim() !== "")
    .map((h) => h.trim());
}
