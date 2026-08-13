/**
 * Firebase client or Admin SDK setup, auth helpers, and shared config.
 */

import "server-only";

import admin from "firebase-admin";
import { App, cert, getApps, initializeApp } from "firebase-admin/app";
import { Auth, getAuth } from "firebase-admin/auth";
import { Firestore, getFirestore } from "firebase-admin/firestore";

export const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "convergepanel";

let app: App | undefined;
let adminAuth: Auth | undefined;
let adminDb: Firestore | undefined;

type ServiceAccountLike = {
  projectId: string;
  clientEmail: string;
  privateKey: string;
};

function loadServiceAccount(): ServiceAccountLike {
  // Option 1: Base64-encoded service account JSON (recommended for Vercel)
  const base64Json = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (base64Json) {
    console.log("[firebase-admin] Using base64-encoded service account JSON");
    const decoded = Buffer.from(base64Json, 'base64').toString('utf-8');
    const parsed = JSON.parse(decoded);
    return {
      projectId: parsed.project_id || FIREBASE_PROJECT_ID,
      clientEmail: parsed.client_email,
      privateKey: parsed.private_key,
    };
  }

  // Option 2: Raw JSON string
  const jsonStr = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (jsonStr) {
    console.log("[firebase-admin] Using raw service account JSON");
    const parsed = JSON.parse(jsonStr);
    return {
      projectId: parsed.project_id || FIREBASE_PROJECT_ID,
      clientEmail: parsed.client_email,
      privateKey: parsed.private_key,
    };
  }

  // Option 3: Separate env vars (fallback)
  console.log("[firebase-admin] Using separate env vars");
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  let privateKey = process.env.FIREBASE_PRIVATE_KEY;
  
  if (privateKey) {
    privateKey = privateKey.replace(/\\n/g, "\n");
  }

  if (!clientEmail || !privateKey) {
    throw new Error("Missing FIREBASE_CLIENT_EMAIL or FIREBASE_PRIVATE_KEY");
  }

  return {
    projectId: FIREBASE_PROJECT_ID,
    clientEmail,
    privateKey,
  };
}

function initFirebaseAdmin() {
  if (app && adminAuth && adminDb) return;

  console.log("[firebase-admin] Starting initialization...");

  const sa = loadServiceAccount();
  
  console.log("[firebase-admin] projectId:", sa.projectId);
  console.log("[firebase-admin] clientEmail:", sa.clientEmail?.substring(0, 20) + "...");
  console.log("[firebase-admin] privateKey length:", sa.privateKey?.length);

  const existingApps = getApps();
  app = existingApps.length > 0
    ? existingApps[0]
    : initializeApp({
        credential: cert({
          projectId: sa.projectId,
          clientEmail: sa.clientEmail,
          privateKey: sa.privateKey,
        }),
        projectId: sa.projectId,
      });

  adminAuth = getAuth(app);
  adminDb = getFirestore(app);
  // Multi-Reviewer Production-Readiness Hardening, Step 5.6 — discovered via
  // a real (non-mocked) Firestore write during seeded end-to-end
  // verification: the Admin SDK rejects ANY `undefined` field value by
  // default (`Cannot use "undefined" as a Firestore value`), but many
  // production builders throughout this codebase legitimately produce
  // `undefined` for absent optional fields (e.g. a vote's `comment` when
  // none was given, `governanceRecord.humanReview.conditions` for a plain
  // approval, `automatedGovernanceStatus` before automated evaluation ever
  // ran). This was NEVER caught by the existing Jest suite because every
  // test uses an in-memory Firestore-shaped fake that doesn't enforce this
  // real SDK restriction. `ignoreUndefinedProperties: true` is the
  // standard, Google-documented fix — it strips `undefined` keys before
  // writing rather than throwing, matching this codebase's own existing
  // convention of using `undefined` (never `null`) to mean "absent" on
  // every optional field. Purely additive: no write that previously
  // succeeded is affected, since it only changes behavior for a write that
  // would otherwise have thrown.
  //
  // `.settings()` may only be called ONCE, ever, on a given Firestore
  // instance — calling it again throws "Firestore has already been
  // initialized." Under Next.js dev-mode Fast Refresh, THIS module can be
  // re-evaluated (resetting the module-level `app`/`adminAuth`/`adminDb`
  // `let` bindings to `undefined`) while the underlying Firebase Admin app
  // — and its Firestore instance — persists across the reload in the SDK's
  // own global registry (`getApps()`), already configured from the FIRST
  // evaluation. Without this guard, that second, spurious `.settings()`
  // call throws, which the outer try/catch below then treats as a total
  // init failure — wiping out `adminAuth` too, even though auth was never
  // actually broken. Swallowing ONLY this specific, benign
  // already-configured case (never a genuinely unexpected error) fixes it.
  try {
    adminDb.settings({ ignoreUndefinedProperties: true });
  } catch (settingsError: any) {
    const alreadySet = typeof settingsError?.message === "string" && settingsError.message.includes("already been initialized");
    if (!alreadySet) throw settingsError;
  }

  console.log("[firebase-admin] Initialized successfully");
}

try {
  initFirebaseAdmin();
} catch (error: any) {
  console.error("[firebase-admin] INIT ERROR:", error?.message);
  app = undefined;
  adminAuth = undefined;
  adminDb = undefined;
}

/**
 * Returns the Firebase project id the Admin SDK app was ACTUALLY
 * initialized with — read back from the live `App` instance's own
 * `options.projectId`, not re-derived from an environment variable.
 * `initFirebaseAdmin()` above always passes an explicit `projectId` to
 * `initializeApp()` on every credential-loading branch (base64 JSON, raw
 * JSON, or separate env vars), so this is guaranteed populated whenever
 * `app` itself is defined. Returns `undefined` only if Admin init failed
 * entirely (`app` is `undefined`) — callers that need a hard identity
 * guarantee (e.g. the Phase 2B bulk provisioner) must treat `undefined`
 * as "unknown project, fail closed," never substitute another source.
 */
export function getInitializedFirebaseProjectId(): string | undefined {
  return app?.options.projectId;
}

export { admin, adminAuth, adminDb };
export const firebaseAdmin = admin;
export default app;
