/**
 * Firestore persistence: typed reads/writes and helpers for server-side data.
 */

import "server-only";
import { adminDb } from "@/lib/firebase/admin";
import { Timestamp } from "firebase-admin/firestore";
import type { AuditBundle } from "@/lib/verification/auditBundle";
import type { ClaimVerdict } from "@/lib/verification/claimVerdict";
import type { ClaimVerificationOrigin } from "@/lib/verification/claimVerificationOrigin";
import { sanitizeForFirestore } from "@/lib/firestore/sanitizeForFirestore";

export type StoredVerificationModelSummary = {
  modelId: string;
  status: "ok" | "parse_error" | "failed";
  verdict: string;
  confidence: string;
  summary: string;
  correctParts: string[];
  incorrectParts: string[];
  unverifiableParts: string[];
};

export type ClaimVerificationFirestoreDoc = {
  userId: string;
  claim: string;
  type: "claim_verification";
  verdict: ClaimVerdict;
  consensusScore: number;
  confidenceLabel: "High" | "Medium" | "Low";
  evidenceQuality: "strong" | "mixed" | "weak";
  supportRatio: number;
  modelResults: StoredVerificationModelSummary[];
  auditBundle: AuditBundle;
  selectedModels: string[];
  timestamp: Timestamp;
  governanceStatus?: "approved" | "needs_review" | "blocked";
  /**
   * Phase 11A.1 — present only when this verification was created via
   * "Verify this claim" from a Deep Research finding. Optional, never
   * `null`; absent on every verification created before this field
   * existed. Write-once at creation (no update path in this codebase ever
   * rewrites a verification document). Not yet written by any route as of
   * this phase — see lib/verification/claimVerificationOrigin.ts.
   */
  origin?: ClaimVerificationOrigin;
};

export async function saveClaimVerification(
  verificationId: string,
  doc: Omit<ClaimVerificationFirestoreDoc, "timestamp"> & { timestamp?: Timestamp }
): Promise<void> {
  if (!adminDb) {
    throw new Error("Firestore is not available");
  }
  const payload: ClaimVerificationFirestoreDoc = {
    ...doc,
    timestamp: doc.timestamp ?? Timestamp.now(),
  };
  const safe = sanitizeForFirestore(payload) as ClaimVerificationFirestoreDoc;
  await adminDb.collection("verifications").doc(verificationId).set(safe);
}
