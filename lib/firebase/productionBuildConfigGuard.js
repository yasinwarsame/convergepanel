/**
 * I-1 M-2 — fail the PRODUCTION BUILD when the browser Firebase configuration or the deployment identity is not valid.
 * Owner decision 2026-11-05: a deployment must never pass CI and then break Production sign-in at runtime.
 *
 * Called from next.config.js, so it runs before any page is built. CommonJS on purpose (next.config.js is CommonJS); the
 * rule mirrors lib/firebase/projectIsolation.ts, and a parity test (projectIsolation.spec.ts) keeps the two in step.
 *
 * When it applies:
 *   - a Vercel build (`VERCEL` set) MUST carry a deployment identity (`VERCEL_ENV`); a missing one fails the build;
 *   - a Production build (`VERCEL_ENV === "production"`, or `NEXT_PUBLIC_VERCEL_ENV === "production"`) MUST have
 *     `NEXT_PUBLIC_VERCEL_ENV === "production"` (it is inlined into the browser bundle and decides the browser rule) and
 *     all six NEXT_PUBLIC_FIREBASE_* values present, trimmed, and identifying the Production project — never the
 *     placeholder. A Production build carrying non-Production config would also break sign-in, so it fails too.
 * Preview, development, local and CI builds (no VERCEL / non-production VERCEL_ENV) are not checked here: there the
 * browser rule already fails closed to the placeholder, and CI has no Firebase configuration at all.
 *
 * Values are never printed: failures name the variable and the reason only.
 */
"use strict";

const PRODUCTION_PROJECT_ID = "convergepanel";
const PRODUCTION_PROJECT_NUMBER = "907484474744";
const PLACEHOLDER_PROJECT_ID = "FIREBASE_CONFIG_UNAVAILABLE";
const KEYS = [
  "NEXT_PUBLIC_FIREBASE_API_KEY",
  "NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN",
  "NEXT_PUBLIC_FIREBASE_PROJECT_ID",
  "NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET",
  "NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID",
  "NEXT_PUBLIC_FIREBASE_APP_ID",
];

/** Pure. Returns the list of problems (empty = OK). */
function productionBuildConfigProblems(env) {
  const problems = [];
  const onVercel = typeof env.VERCEL === "string" && env.VERCEL !== "";
  const vercelEnv = env.VERCEL_ENV;
  if (onVercel && (typeof vercelEnv !== "string" || vercelEnv === "")) {
    problems.push("VERCEL_ENV is missing on a Vercel build (system environment variables not exposed?)");
    return problems;
  }
  const isProductionBuild = vercelEnv === "production" || env.NEXT_PUBLIC_VERCEL_ENV === "production";
  if (!isProductionBuild) return problems;

  if (env.NEXT_PUBLIC_VERCEL_ENV !== "production") problems.push("NEXT_PUBLIC_VERCEL_ENV must be exactly \"production\" in a Production build");
  if (vercelEnv !== undefined && vercelEnv !== "production") problems.push("VERCEL_ENV and NEXT_PUBLIC_VERCEL_ENV disagree");
  for (const k of KEYS) {
    const v = env[k];
    if (typeof v !== "string" || v.length === 0) problems.push(`${k} is missing`);
    else if (v.trim() !== v) problems.push(`${k} has surrounding whitespace`);
  }
  if (problems.length > 0) return problems;
  if (env.NEXT_PUBLIC_FIREBASE_PROJECT_ID === PLACEHOLDER_PROJECT_ID) problems.push("NEXT_PUBLIC_FIREBASE_PROJECT_ID is the unavailable placeholder");
  if (env.NEXT_PUBLIC_FIREBASE_PROJECT_ID !== PRODUCTION_PROJECT_ID) problems.push("NEXT_PUBLIC_FIREBASE_PROJECT_ID does not identify the Production project");
  if (!env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN.startsWith(`${PRODUCTION_PROJECT_ID}.`)) problems.push("NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN does not belong to the Production project");
  if (!env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET.startsWith(`${PRODUCTION_PROJECT_ID}.`)) problems.push("NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET does not belong to the Production project");
  if (env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID !== PRODUCTION_PROJECT_NUMBER) problems.push("NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID is not the Production project number");
  if (!env.NEXT_PUBLIC_FIREBASE_APP_ID.includes(`:${PRODUCTION_PROJECT_NUMBER}:`)) problems.push("NEXT_PUBLIC_FIREBASE_APP_ID does not belong to the Production project");
  return problems;
}

/** Throws (failing `next build`) when the configuration is not valid for the build being made. */
function assertProductionBuildConfig(env = process.env) {
  const problems = productionBuildConfigProblems(env);
  if (problems.length > 0) {
    throw new Error(`[firebase-build-guard] Refusing to build: ${problems.join("; ")}. See docs/operations/firebase-environment-isolation.md.`);
  }
}

module.exports = { productionBuildConfigProblems, assertProductionBuildConfig, PRODUCTION_PROJECT_ID, PRODUCTION_PROJECT_NUMBER };
