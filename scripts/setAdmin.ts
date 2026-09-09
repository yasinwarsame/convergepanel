/**
 * CLASSIFICATION: MINTS-AUTHORITY (service-account bootstrap tool).
 *
 * SAFE-PROBE:PROHIBITION — this script GRANTS SYSTEM_ADMIN. It is never a
 * secret-liveness probe and must not be used to check whether an old
 * ADMIN_SECRET still works: it does not use ADMIN_SECRET at all, and running it
 * mints the claim unconditionally. To verify a rotation use
 * `scripts/probe-admin-secret.mjs`, which cannot mint anything.
 *
 * (C12: this file escaped the previous inventory because that inventory matched
 * the filename pattern `set-admin*` and this name is camelCase. The inventory
 * is now a content predicate.)
 *
 * One-off script to promote a specific user to admin.
 * 
 * This script:
 * 1. Looks up the user by email
 * 2. Sets Firebase custom claims { admin: true }
 * 3. Updates Firestore users/{uid} with role: "admin"
 * 
 * Usage: npx ts-node --compiler-options '{"module":"CommonJS"}' scripts/setAdmin.ts
 * 
 * IMPORTANT: After running this script, the user must sign out and sign back in
 * for the new admin claim to be picked up in their ID token.
 */

// Load environment variables from .env.local BEFORE importing Firebase Admin
// Use require for CommonJS compatibility
const dotenv = require("dotenv");
const path = require("path");

// Load .env.local file (same file used by Next.js)
dotenv.config({ path: path.resolve(__dirname, "../.env.local") });

// Initialize Firebase Admin directly (bypassing server-only module)
import * as admin from "firebase-admin";
import { getApps, initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

// Initialize Firebase Admin if not already initialized
if (getApps().length === 0) {
  const projectId = process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || "convergepanel";
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");

  if (!clientEmail || !privateKey) {
    throw new Error(
      `Firebase Admin SDK requires service account credentials. ` +
      `Missing: ${!clientEmail ? "FIREBASE_CLIENT_EMAIL" : ""} ${!privateKey ? "FIREBASE_PRIVATE_KEY" : ""}. ` +
      `Get these from Firebase Console > Project Settings > Service Accounts > Generate new private key`
    );
  }

  initializeApp({
    credential: cert({
      projectId,
      clientEmail,
      privateKey,
    }),
    projectId,
  });
}

const adminAuth = getAuth();
const adminDb = getFirestore();

async function main() {
  try {
    const email = "ywarsame@convergepanel.com";
    console.log(`🔎 Looking up user by email: ${email}...`);

    const user = await adminAuth.getUserByEmail(email);
    const uid = user.uid;

    console.log(`✅ Found user. UID: ${uid}`);

    console.log("🔐 Setting custom claims { admin: true }...");
    await adminAuth.setCustomUserClaims(uid, { admin: true });

    console.log("📝 Updating Firestore users/{uid} role to 'admin'...");
    await adminDb
      .collection("users")
      .doc(uid)
      .set(
        {
          role: "admin",
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

    console.log(
      `🎉 Done. User ${email} (uid: ${uid}) is now an admin (custom claim + Firestore).`
    );
    console.log(
      "ℹ️ Important: this user must sign out and sign back in so the new admin claim is picked up in their ID token."
    );
    process.exit(0);
  } catch (error: any) {
    console.error("❌ Failed to set admin:", error);
    process.exit(1);
  }
}

main();
