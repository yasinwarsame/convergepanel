/**
 * Load / persist org governance policy document (appConfig/governancePolicy).
 */

import "server-only";
import { FieldValue, type DocumentData } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import { sanitizeForFirestore } from "@/lib/firestore/sanitizeForFirestore";
import {
  getDefaultGovernancePolicy,
  type GovernancePolicy,
} from "./evaluateGovernance";
import { GOVERNANCE_POLICY_DOC_PATH } from "./governanceFirestore";

function pickPolicyFields(d: Record<string, unknown>): GovernancePolicy {
  const def = getDefaultGovernancePolicy();
  const verdictIn = d.reviewIfVerificationVerdictIn;
  return {
    policyVersion: typeof d.policyVersion === "number" ? d.policyVersion : def.policyVersion,
    minConsensusToApprove:
      typeof d.minConsensusToApprove === "number" ? d.minConsensusToApprove : def.minConsensusToApprove,
    minConsensusToAvoidReview:
      typeof d.minConsensusToAvoidReview === "number"
        ? d.minConsensusToAvoidReview
        : def.minConsensusToAvoidReview,
    blockIfSourceBackedMissingSources:
      typeof d.blockIfSourceBackedMissingSources === "boolean"
        ? d.blockIfSourceBackedMissingSources
        : def.blockIfSourceBackedMissingSources,
    reviewIfAnyModelSubstituted:
      typeof d.reviewIfAnyModelSubstituted === "boolean"
        ? d.reviewIfAnyModelSubstituted
        : def.reviewIfAnyModelSubstituted,
    reviewIfAnyModelFailed:
      typeof d.reviewIfAnyModelFailed === "boolean"
        ? d.reviewIfAnyModelFailed
        : def.reviewIfAnyModelFailed,
    sensitiveDomainsEnabled:
      typeof d.sensitiveDomainsEnabled === "boolean"
        ? d.sensitiveDomainsEnabled
        : def.sensitiveDomainsEnabled,
    sensitiveMinConsensusToApprove:
      typeof d.sensitiveMinConsensusToApprove === "number"
        ? d.sensitiveMinConsensusToApprove
        : def.sensitiveMinConsensusToApprove,
    sensitiveMinConsensusToAvoidReview:
      typeof d.sensitiveMinConsensusToAvoidReview === "number"
        ? d.sensitiveMinConsensusToAvoidReview
        : def.sensitiveMinConsensusToAvoidReview,
    reviewIfEvidenceQualityWeak:
      typeof d.reviewIfEvidenceQualityWeak === "boolean"
        ? d.reviewIfEvidenceQualityWeak
        : def.reviewIfEvidenceQualityWeak,
    reviewIfVerificationVerdictIn: Array.isArray(verdictIn)
      ? verdictIn.filter((x): x is string => typeof x === "string")
      : def.reviewIfVerificationVerdictIn,
  };
}

export async function loadGovernancePolicy(): Promise<GovernancePolicy> {
  if (!adminDb) {
    throw new Error("Firestore is not available");
  }
  const ref = adminDb.collection(GOVERNANCE_POLICY_DOC_PATH.collection).doc(GOVERNANCE_POLICY_DOC_PATH.docId);
  const snap = await ref.get();
  const raw = snap.data() as Record<string, unknown> | undefined;
  console.log(`[governance/policy] Firestore appConfig/governancePolicy:`, {
    exists: snap.exists,
    policyVersion: raw?.policyVersion,
    fields: snap.exists && raw ? Object.keys(raw) : "N/A",
  });
  if (!snap.exists) {
    const policy = getDefaultGovernancePolicy();
    await ref.set({
      ...policy,
      updatedAt: FieldValue.serverTimestamp(),
      updatedBy: "system",
    });
    console.log("[governance/policy] Created default policy document");
    const created = await ref.get();
    return pickPolicyFields((created.data() as Record<string, unknown>) ?? {});
  }
  return pickPolicyFields(snap.data() as Record<string, unknown>);
}

function mergePolicyUpdate(
  current: GovernancePolicy,
  partial: Partial<GovernancePolicy>
): GovernancePolicy {
  const keys = Object.keys(getDefaultGovernancePolicy()) as (keyof GovernancePolicy)[];
  const next = { ...current };
  for (const k of keys) {
    if (k === "policyVersion") continue;
    if (partial[k] !== undefined) {
      (next as Record<string, unknown>)[k] = partial[k] as unknown;
    }
  }
  next.policyVersion = current.policyVersion + 1;
  return next;
}

/**
 * Step 6.0a — POLICY VERSION ATOMICITY.
 *
 * The read of the current policy, the version increment and the write are ONE
 * Firestore transaction. Previously they were a plain read-then-`set`, so two
 * concurrent successful saves could both read version N and both commit N+1 —
 * two different policies sharing one version number. Inside the transaction a
 * concurrent commit invalidates this attempt's read and Firestore retries it
 * against the newer document, so every successful mutation receives a unique,
 * monotonically increasing version derived from the current persisted one.
 *
 * The per-version `auditEvents` entry is written in the SAME transaction, so a
 * version number appears in that history exactly once, and only for a commit
 * that actually happened. Authorization and the returned value are unchanged.
 */
export async function saveGovernancePolicyMerge(
  partial: Partial<GovernancePolicy>,
  uid: string,
  email: string,
  comment: string,
  changedFieldNames: string[]
): Promise<GovernancePolicy> {
  if (!adminDb) throw new Error("Firestore is not available");
  const db = adminDb;
  const ref = db.collection(GOVERNANCE_POLICY_DOC_PATH.collection).doc(GOVERNANCE_POLICY_DOC_PATH.docId);

  return db.runTransaction(async (txn) => {
    const currentSnap = await txn.get(ref);
    const current = currentSnap.exists
      ? pickPolicyFields(currentSnap.data() as Record<string, unknown>)
      : getDefaultGovernancePolicy();

    const next = mergePolicyUpdate(current, partial);

    txn.set(
      ref,
      {
        ...next,
        updatedAt: FieldValue.serverTimestamp(),
        updatedBy: uid,
      },
      { merge: true }
    );

    txn.set(
      ref.collection("auditEvents").doc(),
      sanitizeForFirestore({
        action: "policy_updated",
        byUid: uid,
        byEmail: email,
        at: new Date().toISOString(),
        policyVersion: next.policyVersion,
        comment,
        changes: changedFieldNames,
      }) as DocumentData
    );

    return next;
  });
}
