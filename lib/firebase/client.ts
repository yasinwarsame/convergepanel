"use client";

/**
 * Firebase Client SDK Initialization
 * 
 * This module initializes the Firebase client SDK for use in browser/client components.
 * It provides authentication and Firestore database instances that can be used
 * throughout the application.
 * 
 * IMPORTANT: This file uses "use client" because Firebase client SDK can only
 * run in the browser. Never import this in server components.
 */

import { initializeApp, getApps, FirebaseApp } from "firebase/app";
import { getAuth, Auth } from "firebase/auth";
import { getFirestore, Firestore } from "firebase/firestore";
import { resolveBrowserFirebaseConfig } from "./projectIsolation";

/**
 * Firebase configuration (I-1, Preview isolation — owner decision 2026-11-04)
 *
 * There are NO hard-coded fallbacks. Every value must come from its NEXT_PUBLIC_FIREBASE_* variable (inlined at build).
 * If any is missing or malformed — or the values identify the PRODUCTION project while the build is not the Vercel
 * Production deployment (`NEXT_PUBLIC_VERCEL_ENV !== "production"`) — the SDK is initialized with an unroutable
 * placeholder project instead, so every auth/Firestore request fails rather than reaching Production. The module still
 * imports cleanly, so server rendering and CI builds (which have no Firebase variables) keep working.
 * Rule and identity checks: lib/firebase/projectIsolation.ts.
 */
const resolvedFirebaseConfig = resolveBrowserFirebaseConfig(
  {
    apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
    authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
    storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  },
  process.env.NEXT_PUBLIC_VERCEL_ENV,
);
if (resolvedFirebaseConfig.status !== "ok" && typeof window !== "undefined") {
  const message = `[firebase-client] Firebase is unavailable in this deployment (${resolvedFirebaseConfig.reason}). Sign-in and data access are disabled.`;
  // A Production build must never mask a misconfiguration behind the placeholder: fail loudly in the browser (error
  // boundary + error reporting). Server rendering and builds are unaffected (no window), so pages still prerender.
  if (process.env.NEXT_PUBLIC_VERCEL_ENV === "production") throw new Error(message);
  console.error(message);
}
const firebaseConfig = resolvedFirebaseConfig.config;

/**
 * Initialize Firebase App
 * 
 * Uses singleton pattern: if Firebase is already initialized (e.g., in hot reload),
 * reuse the existing instance. Otherwise, create a new one.
 * 
 * This prevents multiple Firebase instances which can cause issues.
 */
let app: FirebaseApp;
if (getApps().length === 0) {
  try {
    app = initializeApp(firebaseConfig);
  } catch (error) {
    console.error("Firebase initialization error:", error);
    throw error;
  }
} else {
  // Reuse existing Firebase app instance (important for Next.js hot reload)
  app = getApps()[0];
}

/**
 * Export Firebase services
 * 
 * - auth: Firebase Authentication instance for user sign-in, sign-up, etc.
 * - db: Firestore database instance for reading/writing data
 * - app: The Firebase app instance (rarely needed directly)
 */
export const auth = getAuth(app);
export const db = getFirestore(app);
export default app;

