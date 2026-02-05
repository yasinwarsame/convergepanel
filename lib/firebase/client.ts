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

/**
 * Firebase configuration object
 * 
 * Reads configuration from environment variables (NEXT_PUBLIC_* prefix makes them
 * available to the browser). Falls back to default values for some fields if not set.
 * 
 * These values come from Firebase Console > Project Settings > Your apps > Web app
 */
const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY || "AIzaSyCUr6oygS_YWxpdXa2pXVryebPzSnOUxdo",
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN || "convergepanel.firebaseapp.com",
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || "convergepanel",
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET || "convergepanel.firebasestorage.app",
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID || "907484474744",
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID || "1:907484474744:web:19a931809616da203f6c8d",
};

/**
 * Validate required configuration before initialization
 * 
 * apiKey and appId are required for Firebase to work. If missing, throw an error
 * immediately to prevent runtime issues.
 */
if (!firebaseConfig.apiKey) {
  throw new Error(
    "Firebase API key is missing. Please set NEXT_PUBLIC_FIREBASE_API_KEY in .env.local"
  );
}

if (!firebaseConfig.appId) {
  throw new Error(
    "Firebase App ID is missing. Please set NEXT_PUBLIC_FIREBASE_APP_ID in .env.local"
  );
}

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

