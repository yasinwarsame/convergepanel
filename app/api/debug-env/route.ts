import { NextResponse } from "next/server";

export async function GET() {
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;
  const privateKeyFixed = privateKey?.replace(/\\n/g, "\n");
  
  let firebaseError = null;
  let firebaseSuccess = false;
  
  try {
    const admin = await import("firebase-admin");
    const { getApps, initializeApp, cert } = await import("firebase-admin/app");
    
    if (getApps().length === 0) {
      initializeApp({
        credential: cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: privateKeyFixed,
        }),
      });
    }
    firebaseSuccess = true;
  } catch (e: any) {
    firebaseError = e.message;
  }
  
  return NextResponse.json({
    hasProjectId: !!process.env.FIREBASE_PROJECT_ID,
    hasClientEmail: !!process.env.FIREBASE_CLIENT_EMAIL,
    hasPrivateKey: !!privateKey,
    privateKeyLength: privateKey?.length || 0,
    privateKeyFixedLength: privateKeyFixed?.length || 0,
    privateKeyStart: privateKey?.substring(0, 40) || "MISSING",
    privateKeyFixedStart: privateKeyFixed?.substring(0, 40) || "MISSING",
    hasNewlineAfterBegin: privateKeyFixed?.includes("-----BEGIN PRIVATE KEY-----\n"),
    firebaseSuccess,
    firebaseError,
  });
}
