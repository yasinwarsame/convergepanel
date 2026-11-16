/**
 * One-time admin backfill: copy governanceEvents subdocuments into admin_audit_logs.
 *
 * SEC-3 / S2-b: GOVERNANCE_ADMIN only, via `requirePrivilegedAccess` — a live,
 * verified, enabled `GOVERNANCE_ADMIN_EMAILS` member. Neither the `admin` claim
 * nor `ADMIN_EMAILS` confers it.
 */

import { NextRequest, NextResponse } from "next/server";
import type { DocumentData } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import type { GovernanceAuditLogAction } from "@/lib/governance/auditLog";
import { sanitizeForFirestore } from "@/lib/firestore/sanitizeForFirestore";
import { isResearchWriteRefusedError, runResearchWrite } from "@/lib/firestore/researchDeletionBarrier";
import { privilegedDenialResponse, requirePrivilegedAccess } from "@/lib/admin/privilegedAccess";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const GOVERNANCE_STATUSES = ["approved", "needs_review", "blocked"] as const;
const MAX_PARENTS_PER_COLLECTION = 200;

const VALID_ACTIONS: GovernanceAuditLogAction[] = [
  "evaluated",
  "approved",
  "blocked",
  "changes_requested",
  "policy_updated",
];

function isAuditAction(s: string): s is GovernanceAuditLogAction {
  return (VALID_ACTIONS as string[]).includes(s);
}

async function backfillCollection(collection: "runs" | "verifications"): Promise<number> {
  if (!adminDb) return 0;
  let written = 0;
  const snap = await adminDb
    .collection(collection)
    .where("governanceStatus", "in", [...GOVERNANCE_STATUSES])
    .limit(MAX_PARENTS_PER_COLLECTION)
    .get();

  for (const parentDoc of snap.docs) {
    const data = parentDoc.data() as Record<string, unknown>;
    const runId = parentDoc.id;
    const ownerUid = String(data.userId ?? "");
    const runOwnerEmail = typeof data.userEmail === "string" ? data.userEmail : "";
    const questionOrClaim = String(data.question ?? data.claim ?? "").slice(0, 200);
    const consensusSummary = data.consensusSummary as Record<string, unknown> | undefined;
    const fromSummary =
      consensusSummary && typeof consensusSummary.overallConsensusScore === "number"
        ? consensusSummary.overallConsensusScore
        : null;
    const consensusScore =
      typeof data.consensusScore === "number" ? data.consensusScore : (fromSummary ?? null);
    const runType = collection === "verifications" ? "claim" : "research";

    const evSnap = await parentDoc.ref.collection("governanceEvents").get();
    for (const evDoc of evSnap.docs) {
      const raw = evDoc.data() as Record<string, unknown>;
      const actionStr = typeof raw.action === "string" ? raw.action : "";
      if (!isAuditAction(actionStr)) continue;

      const docId = `backfill__${collection}__${runId}__${evDoc.id}`;
      const at = typeof raw.at === "string" ? raw.at : new Date().toISOString();
      const payload = sanitizeForFirestore({
        runId,
        collection,
        runType,
        action: actionStr,
        byUid: typeof raw.byUid === "string" ? raw.byUid : "",
        byEmail: typeof raw.byEmail === "string" ? raw.byEmail : "",
        at,
        comment: typeof raw.comment === "string" ? raw.comment : undefined,
        prevStatus: typeof raw.prevStatus === "string" ? raw.prevStatus : undefined,
        nextStatus: typeof raw.nextStatus === "string" ? raw.nextStatus : undefined,
        reasons: Array.isArray(raw.reasons) ? raw.reasons : undefined,
        policyVersion: typeof raw.policyVersion === "number" ? raw.policyVersion : undefined,
        changes: Array.isArray(raw.changes) ? raw.changes : undefined,
        runOwnerUid: ownerUid,
        runOwnerEmail,
        question: questionOrClaim,
        consensusScore,
        backfilled: true,
      }) as DocumentData;

      const auditRef = adminDb.collection("admin_audit_logs").doc(docId);
      if (collection === "runs") {
        // Research deletion integrity: the payload (question, comment) comes from a read made before this write, so it is
        // written only in a transaction guarded by the deletion barrier. Without it, a run deleted meanwhile could have
        // its redacted audit row overwritten with the deleted text.
        try {
          await runResearchWrite(adminDb, runId, (tx) => void tx.set(auditRef, payload, { merge: true }));
        } catch (err) {
          if (isResearchWriteRefusedError(err)) continue;
          throw err;
        }
      } else {
        await auditRef.set(payload, { merge: true });
      }
      written += 1;
    }
  }
  return written;
}

export async function POST(request: NextRequest) {
  // Refused BEFORE any run is read or any audit row is written.
  const access = await requirePrivilegedAccess(request, "GOVERNANCE_ADMIN", { route: "POST /api/governance/audit/backfill" });
  if (!access.ok) return privilegedDenialResponse(access);

  if (!adminDb) {
    return NextResponse.json(
      { ok: false, error: { code: "internal_error", message: "Database unavailable" } },
      { status: 500 }
    );
  }

  try {
    const runsWritten = await backfillCollection("runs");
    const verificationsWritten = await backfillCollection("verifications");
    const total = runsWritten + verificationsWritten;
    console.log("[governance/audit/backfill] Complete:", { runsWritten, verificationsWritten, total });
    return NextResponse.json({
      ok: true,
      written: total,
      runsWritten,
      verificationsWritten,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Backfill failed";
    console.error("[governance/audit/backfill]", e);
    return NextResponse.json(
      { ok: false, error: { code: "internal_error", message: msg } },
      { status: 500 }
    );
  }
}
