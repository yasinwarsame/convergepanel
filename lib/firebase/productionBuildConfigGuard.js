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
 *     all six NEXT_PUBLIC_FIREBASE_* values present, trimmed, and EXACTLY equal to the approved Production web-app
 *     configuration pinned below (never the placeholder, never another project's key). The deployment-identity checks
 *     and the Firebase-identity checks are separate steps.
 * Preview, development, local and CI builds (no VERCEL / non-production VERCEL_ENV) are not checked here: there the
 * browser rule already fails closed to the placeholder, and CI has no Firebase configuration at all.
 *
 * Values are never printed: failures name the variable and the reason only.
 */
"use strict";

const PRODUCTION_PROJECT_ID = "convergepanel";
const PRODUCTION_PROJECT_NUMBER = "907484474744";
/**
 * The APPROVED Production Firebase web-app configuration, pinned (review M-2). Source of truth is NOT the environment
 * being validated: it was read on 2026-11-05 from the Firebase Management API (projects/convergepanel/webApps — exactly
 * one ACTIVE app, "ConvergePanel" — and its /config), and matches the live Production bundle. These are public,
 * client-side identifiers (shipped to every browser), not credentials. Rotating the web API key or re-creating the web
 * app therefore REQUIRES a reviewed change here; until then the Production build fails closed.
 */
const APPROVED_PRODUCTION_WEB_CONFIG = Object.freeze({
  NEXT_PUBLIC_FIREBASE_API_KEY: "AIzaSyCUr6oygS_YWxpdXa2pXVryebPzSnOUxdo",
  NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: "convergepanel.firebaseapp.com",
  NEXT_PUBLIC_FIREBASE_PROJECT_ID: PRODUCTION_PROJECT_ID,
  NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET: "convergepanel.firebasestorage.app",
  NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID: PRODUCTION_PROJECT_NUMBER,
  NEXT_PUBLIC_FIREBASE_APP_ID: "1:907484474744:web:19a931809616da203f6c8d",
});
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
  // Firebase identity: every value must equal the APPROVED Production web-app configuration exactly — an arbitrary,
  // plausible-looking or other-project value (e.g. another project's API key) is refused.
  for (const k of KEYS) {
    if (env[k] !== APPROVED_PRODUCTION_WEB_CONFIG[k]) problems.push(`${k} does not match the approved Production web-app configuration`);
  }
  return problems;
}

/** Throws (failing `next build`) when the configuration is not valid for the build being made. */
function assertProductionBuildConfig(env = process.env) {
  const problems = productionBuildConfigProblems(env);
  if (problems.length > 0) {
    throw new Error(`[firebase-build-guard] Refusing to build: ${problems.join("; ")}. See docs/operations/firebase-environment-isolation.md.`);
  }
}

module.exports = { productionBuildConfigProblems, assertProductionBuildConfig, PRODUCTION_PROJECT_ID, PRODUCTION_PROJECT_NUMBER, APPROVED_PRODUCTION_WEB_CONFIG };
