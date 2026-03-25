/**
 * Persist governance evaluation on run / verification documents (non-blocking for callers).
 */

import "server-only";
import type { DocumentData } from "firebase-admin/firestore";
import { getEffectiveEntitlements } from "@/lib/admin/entitlements";
import { adminDb } from "@/lib/firebase/admin";
import { sanitizeForFirestore } from "@/lib/firestore/sanitizeForFirestore";
import { loadGovernancePolicy } from "@/lib/governance/governancePolicyStore";
import { writeAuditEvent } from "@/lib/governance/auditLog";
import { evaluateGovernance } from "./evaluateGovernance";
import type { GovernanceInput, GovernancePolicy } from "./evaluateGovernance";

let cachedPolicy: GovernancePolicy | null = null;
let cachedPolicyTimestamp = 0;
const POLICY_CACHE_TTL_MS = 60_000;

async function loadPolicy(): Promise<GovernancePolicy> {
  const now = Date.now();
  if (cachedPolicy && now - cachedPolicyTimestamp < POLICY_CACHE_TTL_MS) {
    return cachedPolicy;
  }
  const policy = await loadGovernancePolicy();
  cachedPolicy = policy;
  cachedPolicyTimestamp = now;
  return policy;
}

export type GovernanceEvalStatus = "approved" | "needs_review" | "blocked";

export async function evaluateAndStoreGovernance(params: {
  runId: string;
  collection: "runs" | "verifications";
  input: GovernanceInput;
  /** When missing, evaluation is skipped (e.g. anonymous / unknown owner). */
  ownerUid?: string | null;
}): Promise<{ governanceStatus: GovernanceEvalStatus } | null> {
  try {
    if (!adminDb) {
      console.warn("[governance] evaluateAndStoreGovernance skipped: Firestore unavailable");
      return null;
    }

    const ownerUid = params.ownerUid?.trim();
    if (!ownerUid) {
      return null;
    }

    const entitlements = await getEffectiveEntitlements(ownerUid);
    if (entitlements.planId === "free") {
      return null;
    }

    const policy = await loadPolicy();
    const result = evaluateGovernance(params.input, policy);

    await adminDb
      .collection(params.collection)
      .doc(params.runId)
      .set(
        sanitizeForFirestore({
          governanceStatus: result.status,
          governanceReasons: result.reasons,
          governanceMeta: result.meta,
        }) as DocumentData,
        { merge: true }
      );

    await adminDb
      .collection(params.collection)
      .doc(params.runId)
      .collection("governanceEvents")
      .add(
        sanitizeForFirestore({
          action: "evaluated",
          byUid: "system",
          byEmail: "system",
          at: new Date().toISOString(),
          nextStatus: result.status,
          reasons: result.reasons,
          policyVersion: policy.policyVersion,
        }) as DocumentData
      );

    const parentSnap = await adminDb.collection(params.collection).doc(params.runId).get();
    const parentData = (parentSnap.data() ?? {}) as Record<string, unknown>;
    const runOwnerEmail = typeof parentData.userEmail === "string" ? parentData.userEmail : "";

    await writeAuditEvent({
      runId: params.runId,
      collection: params.collection,
      runType: params.input.runType === "verification" ? "claim" : "research",
      action: "evaluated",
      byUid: "system",
      byEmail: "system",
      nextStatus: result.status,
      reasons: result.reasons,
      policyVersion: policy.policyVersion,
      runOwnerUid: ownerUid,
      runOwnerEmail,
      question: (params.input.question || "").substring(0, 200),
      consensusScore: params.input.consensusScore,
    });

    console.log(
      `[governance] Evaluated run ${params.runId} → ${result.status} (${result.reasons.length} reasons, policy v${policy.policyVersion})`
    );

    return { governanceStatus: result.status };
  } catch (err) {
    console.error("[governance] Evaluation failed (non-blocking):", err);
    return null;
  }
}
