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
import { logger } from "@/lib/logger";
import {
  applyFamilyReviewThresholdsMutation,
  readPersistedFamilyReviewThresholds,
  type FamilyReviewThresholdsMutation,
} from "./familyReviewThresholds";

/**
 * A policy mutation as accepted by `saveGovernancePolicyMerge`: any legacy
 * field, plus the D5.2A score-type map in its MUTATION form (number = set,
 * null = clear). `policyVersion` is never caller-supplied.
 */
export type GovernancePolicyMutation = Partial<Omit<GovernancePolicy, "policyVersion" | "scoreFamilyReviewThresholds">> & {
  scoreFamilyReviewThresholds?: FamilyReviewThresholdsMutation;
};

/** Exported for tests: the runtime policy read from a persisted document. Never mutates the document. */
export function pickPolicyFields(d: Record<string, unknown>): GovernancePolicy {
  const def = getDefaultGovernancePolicy();
  const verdictIn = d.reviewIfVerificationVerdictIn;
  // D5.2A — only recognized score types with valid values become active
  // overrides; anything else degrades to the shared threshold. Names, never
  // values, are logged: a malformed entry is a configuration fault, not data.
  const family = readPersistedFamilyReviewThresholds(d.scoreFamilyReviewThresholds);
  if (family.discarded.length > 0) {
    logger.warn("[governance/policy] Ignoring malformed score-type review thresholds; the shared threshold applies", {
      discarded: family.discarded.slice(0, 10),
    });
  }
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
    // Conditional spread: absence stays absence (no `undefined` key ever reaches Firestore).
    ...(family.thresholds ? { scoreFamilyReviewThresholds: family.thresholds } : {}),
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
  partial: GovernancePolicyMutation
): GovernancePolicy {
  const keys = Object.keys(getDefaultGovernancePolicy()) as (keyof GovernancePolicy)[];
  const next = { ...current };
  for (const k of keys) {
    if (k === "policyVersion") continue;
    const value = (partial as Record<string, unknown>)[k];
    if (value !== undefined) {
      (next as Record<string, unknown>)[k] = value;
    }
  }
  if (partial.scoreFamilyReviewThresholds !== undefined) {
    const family = applyFamilyReviewThresholdsMutation(current.scoreFamilyReviewThresholds, partial.scoreFamilyReviewThresholds);
    if (family) next.scoreFamilyReviewThresholds = family;
    else delete next.scoreFamilyReviewThresholds;
  }
  next.policyVersion = current.policyVersion + 1;
  return next;
}

/** The runtime value of one (possibly dotted) policy field, `null` when absent. */
function policyFieldValue(policy: GovernancePolicy, name: string): unknown {
  const FAMILY_PREFIX = "scoreFamilyReviewThresholds.";
  if (name.startsWith(FAMILY_PREFIX)) {
    const family = name.slice(FAMILY_PREFIX.length) as keyof NonNullable<GovernancePolicy["scoreFamilyReviewThresholds"]>;
    return policy.scoreFamilyReviewThresholds?.[family] ?? null;
  }
  const value = (policy as unknown as Record<string, unknown>)[name];
  return value === undefined ? null : value;
}

/**
 * D5.2A — before/after values of exactly the changed fields, for the
 * per-version audit event. `null` means "absent" (for a score-type override:
 * the shared threshold applies). Values are the RUNTIME policy values on each
 * side of this one committed version.
 */
function changeSnapshot(current: GovernancePolicy, next: GovernancePolicy, changedFieldNames: string[]) {
  const before: Record<string, unknown> = {};
  const after: Record<string, unknown> = {};
  for (const name of changedFieldNames) {
    before[name] = policyFieldValue(current, name);
    after[name] = policyFieldValue(next, name);
  }
  return { before, after };
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
 *
 * Step 6 D5.2A:
 * - The score-type map is written as a DELTA: each changed family is set, or
 *   removed with `FieldValue.delete()`, under a merge write — so changing one
 *   family can never rewrite or drop the other, and a cleared override leaves
 *   no `null` behind for a reader to mistake for configuration.
 * - The audit event also records `before` / `after` values of exactly the
 *   changed fields, computed from the same transaction's read, so each
 *   policy version is reconstructable. Prospective only: older events keep
 *   their names-only shape.
 */
export async function saveGovernancePolicyMerge(
  partial: GovernancePolicyMutation,
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
    // The family map is never spread whole into the write (see the doc comment).
    const { scoreFamilyReviewThresholds: _nextFamily, ...legacyNext } = next;
    void _nextFamily;
    const familyDelta: Record<string, unknown> = {};
    for (const [family, value] of Object.entries(partial.scoreFamilyReviewThresholds ?? {})) {
      familyDelta[family] = value === null ? FieldValue.delete() : value;
    }

    txn.set(
      ref,
      {
        ...legacyNext,
        ...(Object.keys(familyDelta).length > 0 ? { scoreFamilyReviewThresholds: familyDelta } : {}),
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
        ...changeSnapshot(current, next, changedFieldNames),
      }) as DocumentData
    );

    return next;
  });
}
