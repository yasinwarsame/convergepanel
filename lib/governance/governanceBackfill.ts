/**
 * Lazy backfill of governance fields on run / verification documents.
 */

import "server-only";
import type { DocumentData } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import { sanitizeForFirestore } from "@/lib/firestore/sanitizeForFirestore";
import { evaluateGovernance } from "./evaluateGovernance";
import { governanceInputFromResearchRun, governanceInputFromVerificationDoc } from "./governanceInputFromDocs";
import { loadGovernancePolicy } from "./governancePolicyStore";

/** In-process dedupe: parallel queue requests (e.g. stats) must not evaluate the same doc twice before the first write lands. */
const inflightGovernanceBackfill = new Set<string>();

function governanceDocKey(collection: "runs" | "verifications", docId: string): string {
  return `${collection}/${docId}`;
}

export async function ensureDocumentGovernanceEvaluated(
  collection: "runs" | "verifications",
  docId: string,
  data: Record<string, unknown>,
  actor: { uid: string; email: string }
): Promise<Record<string, unknown>> {
  if (!adminDb) return data;

  if (data.governanceStatus !== undefined && data.governanceStatus !== null) {
    return data;
  }

  const meta = data.governanceMeta as { evaluatedAt?: unknown } | undefined;
  if (meta != null && typeof meta === "object" && meta.evaluatedAt != null && meta.evaluatedAt !== "") {
    return data;
  }

  const dedupeKey = governanceDocKey(collection, docId);
  if (inflightGovernanceBackfill.has(dedupeKey)) {
    return data;
  }
  inflightGovernanceBackfill.add(dedupeKey);
  try {
    const policy = await loadGovernancePolicy();
    const input =
      collection === "runs"
        ? governanceInputFromResearchRun(data)
        : governanceInputFromVerificationDoc(data);
    const result = evaluateGovernance(input, policy);

    const patch = {
      governanceStatus: result.status,
      governanceReasons: result.reasons,
      governanceMeta: result.meta,
    };

    await adminDb.collection(collection).doc(docId).set(sanitizeForFirestore(patch) as DocumentData, {
      merge: true,
    });

    await adminDb
      .collection(collection)
      .doc(docId)
      .collection("governanceEvents")
      .add(
        sanitizeForFirestore({
          action: "evaluated",
          byUid: actor.uid,
          byEmail: actor.email,
          at: new Date().toISOString(),
          reasons: result.reasons,
          policyVersion: policy.policyVersion,
          nextStatus: result.status,
        }) as DocumentData
      );

    console.warn(`[governance] Backfilled governance for ${collection}/${docId} → ${result.status}`);
    return { ...data, ...patch };
  } finally {
    inflightGovernanceBackfill.delete(dedupeKey);
  }
}
