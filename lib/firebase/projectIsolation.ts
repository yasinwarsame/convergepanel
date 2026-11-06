/**
 * Firebase project isolation — the single invariant shared by the Admin SDK (server) and the client SDK (browser).
 * Owner decision 2026-11-04 (Preview isolation, items I-1 and I-2).
 *
 *   A Firebase connection that targets the PRODUCTION project is allowed only when the deployment environment is
 *   exactly "production". Everything else — Vercel Preview, development, unset (local `next dev`, Jest, CI builds),
 *   any other value — is refused, and the caller fails closed.
 *
 * "Targets Production" is decided from the RESOLVED identity, never from which variable supplied it:
 *   - server: the resolved projectId, or a service-account client_email in the Production project's IAM domain;
 *   - browser: projectId, authDomain, storageBucket, messagingSenderId (project number) or appId (which embeds it).
 * Comparison is trimmed and case-insensitive, so near-variants are treated as Production, never as "something else".
 *
 * Pure: no environment reads and no "server-only", so both sides share it. Each caller passes its own trusted
 * deployment signal (server: `process.env.VERCEL_ENV`, read at runtime; browser: `process.env.NEXT_PUBLIC_VERCEL_ENV`,
 * inlined by Vercel at build time). Neither comes from request data.
 */

export const PRODUCTION_FIREBASE_PROJECT_ID = "convergepanel";
/** Production project NUMBER (appears as messagingSenderId and inside appId). */
export const PRODUCTION_FIREBASE_PROJECT_NUMBER = "907484474744";
/**
 * Production web API key. Firebase Auth (Identity Toolkit) resolves the project FROM THE API KEY, not from projectId, so a
 * Preview config carrying this key would sign users in against Production Auth. Public by design (shipped in every
 * Production bundle); listed here only so it is recognised as Production identity.
 */
export const PRODUCTION_FIREBASE_WEB_API_KEY = "AIzaSyCUr6oygS_YWxpdXa2pXVryebPzSnOUxdo";
/**
 * Used when the browser configuration is missing, malformed or refused. Uppercase and underscores make it impossible as
 * a real Firebase project id, so every request made with it fails; it is never the Production project.
 */
export const UNAVAILABLE_FIREBASE_PROJECT_ID = "FIREBASE_CONFIG_UNAVAILABLE";

const norm = (v: unknown) => (typeof v === "string" ? v.trim().toLowerCase() : "");

export function isProductionDeploymentEnv(deploymentEnv: unknown): boolean {
  return deploymentEnv === "production";
}

/**
 * The project a service-account email belongs to, when its form names one:
 *   <name>@<project>.iam.gserviceaccount.com, <project>@appspot.gserviceaccount.com (App Engine default),
 *   <number>-compute@developer.gserviceaccount.com (Compute default), service-<number>@<…>.iam.gserviceaccount.com
 *   (Google-managed). Returns the project id or number, or null when the form is not recognised.
 */
export function serviceAccountProject(clientEmail: unknown): string | null {
  const e = norm(clientEmail);
  let m = /^service-(\d+)@[a-z0-9.-]+\.iam\.gserviceaccount\.com$/.exec(e);
  if (m) return m[1];
  m = /^[^@]+@([a-z0-9-]+)\.iam\.gserviceaccount\.com$/.exec(e);
  if (m) return m[1];
  m = /^([a-z0-9-]+)@appspot\.gserviceaccount\.com$/.exec(e);
  if (m) return m[1];
  m = /^(\d+)-compute@developer\.gserviceaccount\.com$/.exec(e);
  if (m) return m[1];
  return null;
}

export function serverIdentityTargetsProduction(args: { projectId: unknown; clientEmail?: unknown }): boolean {
  if (norm(args.projectId) === PRODUCTION_FIREBASE_PROJECT_ID) return true;
  const saProject = serviceAccountProject(args.clientEmail);
  return saProject === PRODUCTION_FIREBASE_PROJECT_ID || saProject === PRODUCTION_FIREBASE_PROJECT_NUMBER;
}

export type FirebaseIsolationVerdict = { ok: true } | { ok: false; reason: "missing_project_id" | "production_project_outside_production" | "credential_project_mismatch" };

/** Server (Admin SDK) rule. */
export function evaluateServerFirebaseIsolation(args: { projectId: unknown; clientEmail?: unknown; deploymentEnv: unknown }): FirebaseIsolationVerdict {
  if (typeof args.projectId !== "string" || args.projectId.trim().length === 0) return { ok: false, reason: "missing_project_id" };
  const production = isProductionDeploymentEnv(args.deploymentEnv);
  if (serverIdentityTargetsProduction(args) && !production) return { ok: false, reason: "production_project_outside_production" };
  // Outside Production, a credential that names a project by id must belong to the project it is used for (a relabelled
  // key is refused even when neither side is recognisably Production). Not enforced in Production, so an unusual but
  // working Production credential can never cause an outage here.
  if (!production) {
    const saProject = serviceAccountProject(args.clientEmail);
    if (saProject !== null && !/^\d+$/.test(saProject) && saProject !== norm(args.projectId)) return { ok: false, reason: "credential_project_mismatch" };
  }
  return { ok: true };
}

export interface BrowserFirebaseConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  storageBucket: string;
  messagingSenderId: string;
  appId: string;
}
const BROWSER_KEYS = ["apiKey", "authDomain", "projectId", "storageBucket", "messagingSenderId", "appId"] as const;

export const UNAVAILABLE_BROWSER_FIREBASE_CONFIG: Readonly<BrowserFirebaseConfig> = Object.freeze({
  apiKey: "firebase-config-unavailable",
  authDomain: "firebase-config-unavailable.invalid",
  projectId: UNAVAILABLE_FIREBASE_PROJECT_ID,
  storageBucket: "firebase-config-unavailable.invalid",
  messagingSenderId: "0",
  appId: "firebase-config-unavailable",
});

export function browserConfigTargetsProduction(c: Partial<Record<(typeof BROWSER_KEYS)[number], unknown>>): boolean {
  const p = PRODUCTION_FIREBASE_PROJECT_ID;
  return (
    (typeof c.apiKey === "string" && c.apiKey.trim() === PRODUCTION_FIREBASE_WEB_API_KEY) ||
    norm(c.projectId) === p ||
    norm(c.authDomain).startsWith(`${p}.`) ||
    norm(c.storageBucket).startsWith(`${p}.`) ||
    norm(c.messagingSenderId) === PRODUCTION_FIREBASE_PROJECT_NUMBER ||
    norm(c.appId).includes(`:${PRODUCTION_FIREBASE_PROJECT_NUMBER}:`)
  );
}

export type BrowserFirebaseConfigResolution =
  | { status: "ok"; config: BrowserFirebaseConfig }
  | { status: "unavailable"; reason: "missing_or_malformed" | "production_project_outside_production"; config: Readonly<BrowserFirebaseConfig> };

/** Browser (client SDK) rule. There is no fallback: a missing or malformed value never selects any real project. */
export function resolveBrowserFirebaseConfig(raw: Partial<Record<(typeof BROWSER_KEYS)[number], unknown>>, deploymentEnv: unknown): BrowserFirebaseConfigResolution {
  for (const k of BROWSER_KEYS) {
    const v = raw[k];
    if (typeof v !== "string" || v.length === 0 || v.trim() !== v) return { status: "unavailable", reason: "missing_or_malformed", config: UNAVAILABLE_BROWSER_FIREBASE_CONFIG };
  }
  if (browserConfigTargetsProduction(raw) && !isProductionDeploymentEnv(deploymentEnv)) {
    return { status: "unavailable", reason: "production_project_outside_production", config: UNAVAILABLE_BROWSER_FIREBASE_CONFIG };
  }
  return { status: "ok", config: { ...(raw as BrowserFirebaseConfig) } };
}
