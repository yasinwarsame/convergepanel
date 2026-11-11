/**
 * Firebase client or Admin SDK setup, auth helpers, and shared config.
 */

import "server-only";

import admin from "firebase-admin";
import { App, applicationDefault, cert, getApps, initializeApp } from "firebase-admin/app";
import { Auth, getAuth } from "firebase-admin/auth";
import { Firestore, getFirestore } from "firebase-admin/firestore";
import { resolvePreviewWorkloadIdentity } from "./previewWorkloadIdentity";
import { adcWellKnownFilePath, inspectAdcFile, resolveDevelopmentAdc } from "./developmentAdc";
import { evaluateServerFirebaseIsolation, serviceAccountProject, PRODUCTION_FIREBASE_PROJECT_ID, PRODUCTION_FIREBASE_PROJECT_NUMBER, type FirebaseIsolationVerdict } from "./projectIsolation";
import { readOperatorGrant } from "./operatorGrant";

/**
 * Applies the isolation verdict. The ONLY exception: a Production refusal outside Production is lifted by a valid
 * operator grant (lib/firebase/operatorGrant.ts) that names exactly this project, created in this process by an operator
 * script from explicit argv. Every other refusal stands.
 */
function enforceFirebaseIsolation(verdict: FirebaseIsolationVerdict, projectId: unknown, clientEmail: unknown): void {
  if (verdict.ok) return;
  if (verdict.reason === "production_project_outside_production") {
    const grant = readOperatorGrant();
    const pid = typeof projectId === "string" ? projectId.trim().toLowerCase() : "";
    const saProject = serviceAccountProject(clientEmail);
    // Review m-1: lifted ONLY for exactly the Production project, with a credential that is a Production service account.
    const credentialIsProduction = saProject === PRODUCTION_FIREBASE_PROJECT_ID || saProject === PRODUCTION_FIREBASE_PROJECT_NUMBER;
    if (grant && pid === PRODUCTION_FIREBASE_PROJECT_ID && grant.projectId === pid && credentialIsProduction) {
      console.error(`[firebase-admin] OPERATOR access to Production project "${pid}" (operation=${grant.operation}, mode=${grant.mode}, granted ${grant.grantedAt})`);
      return;
    }
  }
  throw new Error(`Firebase Admin initialization refused: ${verdict.reason}`);
}

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

  // Order 33 (Preview isolation): a Vercel PREVIEW deployment configured for keyless Workload Identity Federation
  // authenticates to the isolated Preview project only. Production and local runs never enter this branch.
  const wif = resolvePreviewWorkloadIdentity(process.env);
  if (wif.kind === "refused") throw new Error(`Firebase Admin initialization refused: preview_workload_identity_${wif.reason}`);
  if (wif.kind === "ok") {
    const { projectId, serviceAccountEmail } = wif.config;
    enforceFirebaseIsolation(evaluateServerFirebaseIsolation({ projectId, clientEmail: serviceAccountEmail, deploymentEnv: process.env.VERCEL_ENV }), projectId, serviceAccountEmail);
    console.log("[firebase-admin] projectId:", projectId, "(preview workload identity)");
    // Loaded only here, so Production and local runs never load the federated-client dependencies.
    const { createPreviewWorkloadIdentityClient, previewWorkloadIdentityCredential } = require("./previewWorkloadIdentityClient") as typeof import("./previewWorkloadIdentityClient");
    const client = createPreviewWorkloadIdentityClient(wif.config);
    const existing = getApps().find((a) => a.name === "[DEFAULT]");
    app = existing ?? initializeApp({ credential: previewWorkloadIdentityCredential(client), projectId });
    try {
      enforceFirebaseIsolation(evaluateServerFirebaseIsolation({ projectId: app.options.projectId, clientEmail: serviceAccountEmail, deploymentEnv: process.env.VERCEL_ENV }), app.options.projectId, serviceAccountEmail);
    } catch (refused) {
      app = undefined;
      throw refused;
    }
    adminAuth = getAuth(app);
    // firebase-admin's getFirestore() accepts only a certificate or application-default credential, so the Preview
    // Firestore client is built directly on the federated auth client (same settings as the certificate path).
    adminDb = new Firestore({ projectId, authClient: client, ignoreUndefinedProperties: true } as ConstructorParameters<typeof Firestore>[0]);
    console.log("[firebase-admin] Initialization complete (preview workload identity)");
    return;
  }

  // Order 35 G (Development isolation D-2): a local / `vercel dev` run that opts in with FIREBASE_ADMIN_CREDENTIAL_SOURCE=adc
  // authenticates keylessly (the developer's impersonated application-default credential) to a non-Production project.
  // A refusal throws: there is no fallback to a certificate.
  const dev = resolveDevelopmentAdc(process.env);
  if (dev.kind === "refused") throw new Error(`Firebase Admin initialization refused: development_adc_${dev.reason}`);
  if (dev.kind === "ok") {
    const { projectId } = dev;
    // Review M-1: only an impersonated developer service account; its address goes through the #294 guard.
    const { readFileSync } = require("fs") as typeof import("fs");
    const adcPath = adcWellKnownFilePath(process.env, process.platform);
    let adcText: string | null = null;
    try {
      adcText = adcPath === null ? null : readFileSync(adcPath, "utf8");
    } catch {
      adcText = null;
    }
    const adc = inspectAdcFile(adcText);
    adcText = null;
    if (adc.kind === "refused") throw new Error(`Firebase Admin initialization refused: development_adc_${adc.reason}`);
    const clientEmail = adc.serviceAccountEmail;
    enforceFirebaseIsolation(evaluateServerFirebaseIsolation({ projectId, clientEmail, deploymentEnv: process.env.VERCEL_ENV }), projectId, clientEmail);
    console.log("[firebase-admin] projectId:", projectId, "(development application-default credential, impersonated service account)");
    const existing = getApps().find((a) => a.name === "[DEFAULT]");
    // Review N-2: an existing default app for another project is never reused.
    if (existing && existing.options.projectId !== projectId) throw new Error("Firebase Admin initialization refused: development_adc_existing_app_project_mismatch");
    app = existing ?? initializeApp({ credential: applicationDefault(), projectId });
    try {
      enforceFirebaseIsolation(evaluateServerFirebaseIsolation({ projectId: app.options.projectId, clientEmail, deploymentEnv: process.env.VERCEL_ENV }), app.options.projectId, clientEmail);
    } catch (refused) {
      app = undefined;
      throw refused;
    }
    adminAuth = getAuth(app);
    adminDb = getFirestore(app);
    try {
      adminDb.settings({ ignoreUndefinedProperties: true });
    } catch (settingsError: any) {
      const alreadySet = typeof settingsError?.message === "string" && settingsError.message.includes("already been initialized");
      if (!alreadySet) throw settingsError;
    }
    console.log("[firebase-admin] Initialization complete (development application-default credential)");
    return;
  }

  const sa = loadServiceAccount();

  // I-2 (Preview isolation): refuse to connect to the PRODUCTION Firebase project outside the Vercel Production
  // deployment, whatever credential format supplied it. Checked on the RESOLVED identity (projectId and the service
  // account's IAM domain), before any app is created. `VERCEL_ENV` is the Vercel system variable read at runtime; unset
  // (local dev, Jest, CI) is not Production. Throwing here lands in the outer catch below: Admin stays uninitialized
  // (adminDb/adminAuth undefined), which every route already treats as "Firestore unavailable" — fail closed.
  enforceFirebaseIsolation(evaluateServerFirebaseIsolation({ projectId: sa.projectId, clientEmail: sa.clientEmail, deploymentEnv: process.env.VERCEL_ENV }), sa.projectId, sa.clientEmail);
  
  console.log("[firebase-admin] projectId:", sa.projectId);
  console.log("[firebase-admin] clientEmail:", sa.clientEmail?.substring(0, 20) + "...");
  console.log("[firebase-admin] privateKey length:", sa.privateKey?.length);

  // Reuse only the DEFAULT app (the one this module creates); any other registered app is ignored.
  const existingDefault = getApps().find((a) => a.name === "[DEFAULT]");
  app = existingDefault
    ? existingDefault
    : initializeApp({
        credential: cert({
          projectId: sa.projectId,
          clientEmail: sa.clientEmail,
          privateKey: sa.privateKey,
        }),
        projectId: sa.projectId,
      });

  // An app that already exists in the SDK registry (e.g. after a dev-mode reload) must satisfy the same rule.
  try {
    enforceFirebaseIsolation(evaluateServerFirebaseIsolation({ projectId: app.options.projectId, clientEmail: sa.clientEmail, deploymentEnv: process.env.VERCEL_ENV }), app.options.projectId, sa.clientEmail);
  } catch (refused) {
    app = undefined;
    throw refused;
  }

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
