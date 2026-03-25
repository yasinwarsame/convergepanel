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

export { admin, adminAuth, adminDb };
export const firebaseAdmin = admin;
export default app;
