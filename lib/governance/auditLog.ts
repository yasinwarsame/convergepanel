/**
 * Append-only global governance audit log (top-level collection).
 */

import "server-only";
import { randomUUID } from "crypto";
import type { DocumentData } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import { sanitizeForFirestore } from "@/lib/firestore/sanitizeForFirestore";

export type GovernanceAuditLogAction =
  | "evaluated"
  | "approved"
  | "blocked"
  | "changes_requested"
  | "policy_updated"
  | "admin_override"
  | "admin_deleted";

export async function writeAuditEvent(event: Record<string, any>): Promise<void> {
  if (!adminDb) return;
  try {
    console.log("[governance/audit] Writing audit event:", event.action, event.runId);
    const q =
      typeof event.question === "string" ? event.question.trim().substring(0, 200) : event.question;
    const ref = await adminDb.collection("admin_audit_logs").add(
      sanitizeForFirestore({
        ...event,
        question: q,
        at: new Date().toISOString(),
      }) as DocumentData
    );
    console.log("[governance/audit] Event written to admin_audit_logs:", ref.id);
  } catch (err) {
    console.error("[governance/audit] FAILED to write audit event:", err);
  }
}

/**
 * Immutable Adaptive Review History and Admin Audit Integration — a
 * deterministic-ID admin audit writer for adaptive human-review decisions
 * (docs/governance-decision-receipts-design.md §27.7). Deliberately NOT
 * `writeAuditEvent()` above: that function always uses `.add()` (a random
 * ID), which has no idempotency protection at all — a retried write would
 * create a second document. This one uses `.doc(id).create()` with a
 * deterministic ID (`adaptive-review:${decisionId}`), so a retried write
 * after a transient failure (or the repair service) can never create a
 * duplicate admin audit entry for the same committed decision.
 *
 * Writes into the SAME `admin_audit_logs` collection `writeAuditEvent()`
 * already uses — existing readers/queries (`/api/governance/audit`) work
 * against this document exactly as they do any other, since Firestore
 * collections aren't schema-enforced and the existing queries used here
 * (`.where("runId","==",...)`, `.orderBy("at","desc")`) require no new
 * index for it. `writeAuditEvent()` itself, and every one of its existing
 * call sites, are completely untouched.
 *
 * Never includes: comment, conditions, question, receipt conclusion,
 * receipt arrays, sources, model output, governance reasons, raw request
 * body, or a raw Firestore error — only the fixed, safe metadata fields
 * listed below.
 */
export type AdaptiveAdminAuditWriteResult = { status: "recorded" } | { status: "already_exists" } | { status: "failed" };

export async function writeAdaptiveAdminAuditEvent(args: {
  decisionId: string;
  actorUid: string;
  teamId: string | null;
  runId: string;
  schemaId: string;
  answerShape: string;
  priorStatus: string;
  newStatus: string;
  reviewedAt: string;
}): Promise<AdaptiveAdminAuditWriteResult> {
  if (!adminDb) {
    return { status: "failed" };
  }

  const docId = `adaptive-review:${args.decisionId}`;
  try {
    await adminDb
      .collection("admin_audit_logs")
      .doc(docId)
      .create({
        action: "adaptive_human_review_decided",
        byUid: args.actorUid,
        at: args.reviewedAt,
        teamId: args.teamId,
        runId: args.runId,
        collection: "runs",
        schemaId: args.schemaId,
        answerShape: args.answerShape,
        prevStatus: args.priorStatus,
        nextStatus: args.newStatus,
        decisionId: args.decisionId,
        outcome: "success",
        // Personal Reviewer Inbox + Action Flow — was hardcoded to
        // "adaptive_team_review" (accurate for every caller until this
        // feature added a second, non-team one). `teamId` on this SAME
        // record already disambiguates programmatically, but a fixed,
        // wrong label here would still mislead anyone reading the audit
        // trail by eye.
        source: args.teamId === null ? "adaptive_personal_review" : "adaptive_team_review",
      });
    return { status: "recorded" };
  } catch (err: unknown) {
    const code = (err as { code?: number | string })?.code;
    const message = (err as Error)?.message ?? "";
    const alreadyExists = code === 6 || code === "ALREADY_EXISTS" || message.includes("ALREADY_EXISTS") || message.includes("already exists");
    if (alreadyExists) {
      return { status: "already_exists" };
    }
    console.error("[governance/audit] Failed to write adaptive admin audit event:", { runId: args.runId, decisionId: args.decisionId });
    return { status: "failed" };
  }
}

/**
 * Part E3 — Single-Reviewer Assignment for Adaptive Human Review. A
 * deterministic-ID admin audit writer for assignment mutations, mirroring
 * `writeAdaptiveAdminAuditEvent()` exactly (same collection, same
 * `.doc(id).create()` idempotency mechanism). Deterministic ID:
 * `` `adaptive-review-assignment:${runId}:${assignmentRevision}` `` — the
 * assignment document's own `revision` is already a strictly-incrementing,
 * per-run counter (guaranteed unique per mutation by the transaction's own
 * optimistic-concurrency check), so no separate hash is needed.
 *
 * Never includes reviewer email, display name, comments, prompt content,
 * evidence, model output, decision content, or a full user profile — only
 * the fixed metadata fields listed below.
 */
export type AdaptiveAssignmentAdminAuditAction =
  | "adaptive_human_review_reviewer_assigned"
  | "adaptive_human_review_reviewer_reassigned"
  | "adaptive_human_review_reviewer_unassigned";

export async function writeAdaptiveAssignmentAdminAuditEvent(args: {
  action: AdaptiveAssignmentAdminAuditAction;
  actorUid: string;
  teamId: string | null;
  runId: string;
  previousReviewerUserId: string | null;
  newReviewerUserId: string | null;
  assignmentRevision: number;
  at: string;
}): Promise<AdaptiveAdminAuditWriteResult> {
  if (!adminDb) {
    return { status: "failed" };
  }

  const docId = `adaptive-review-assignment:${args.runId}:${args.assignmentRevision}`;
  try {
    await adminDb
      .collection("admin_audit_logs")
      .doc(docId)
      .create({
        action: args.action,
        byUid: args.actorUid,
        at: args.at,
        teamId: args.teamId,
        runId: args.runId,
        collection: "runs",
        previousReviewerUserId: args.previousReviewerUserId,
        newReviewerUserId: args.newReviewerUserId,
        assignmentRevision: args.assignmentRevision,
      });
    return { status: "recorded" };
  } catch (err: unknown) {
    const code = (err as { code?: number | string })?.code;
    const message = (err as Error)?.message ?? "";
    const alreadyExists = code === 6 || code === "ALREADY_EXISTS" || message.includes("ALREADY_EXISTS") || message.includes("already exists");
    if (alreadyExists) {
      return { status: "already_exists" };
    }
    console.error("[governance/audit] Failed to write adaptive assignment admin audit event:", { runId: args.runId, assignmentRevision: args.assignmentRevision });
    return { status: "failed" };
  }
}

/**
 * Transactional Multi-Reviewer Finalization, Part E (§E14) — deterministic,
 * idempotent admin audit event for panel finalization. Deterministic ID
 * reuses the SAME `finalDecisionId` every other finalization artifact
 * shares (§E3). Never includes comments, conditions, vote text, reviewer
 * emails, the raw request, or a raw Firestore error.
 */
export async function writeAdaptivePanelFinalizationAdminAuditEvent(args: {
  actorUid: string;
  /** Phase 9B.5.2 — `null` for a Workspace-bound panel finalization. */
  teamId: string | null;
  runId: string;
  priorHumanReviewStatus: string;
  finalStatus: string;
  panelRevision: number;
  finalDecisionId: string;
  aggregationPolicyVersion: number;
  finalizedAt: string;
}): Promise<AdaptiveAdminAuditWriteResult> {
  if (!adminDb) {
    return { status: "failed" };
  }

  const docId = `adaptive-review-panel-finalization:${args.finalDecisionId}`;
  try {
    await adminDb
      .collection("admin_audit_logs")
      .doc(docId)
      .create({
        action: "adaptive_review_panel_finalized",
        byUid: args.actorUid,
        at: args.finalizedAt,
        teamId: args.teamId,
        runId: args.runId,
        collection: "runs",
        prevStatus: args.priorHumanReviewStatus,
        nextStatus: args.finalStatus,
        decisionId: args.finalDecisionId,
        panelRevision: args.panelRevision,
        aggregationPolicyVersion: args.aggregationPolicyVersion,
        outcome: "success",
        source: "multi_reviewer_panel",
      });
    return { status: "recorded" };
  } catch (err: unknown) {
    const code = (err as { code?: number | string })?.code;
    const message = (err as Error)?.message ?? "";
    const alreadyExists = code === 6 || code === "ALREADY_EXISTS" || message.includes("ALREADY_EXISTS") || message.includes("already exists");
    if (alreadyExists) {
      return { status: "already_exists" };
    }
    console.error("[governance/audit] Failed to write adaptive panel finalization admin audit event:", { runId: args.runId, finalDecisionId: args.finalDecisionId });
    return { status: "failed" };
  }
}

/**
 * Multi-Reviewer Owner Override, Part F (§F8) — deterministic, idempotent
 * admin audit event for an owner override finalization. Mirrors
 * `writeAdaptivePanelFinalizationAdminAuditEvent`'s exact shape and
 * discipline, but with a distinct `action`/`docId` prefix and
 * `source: "multi_reviewer_owner_override"` — never confusable with an
 * aggregation finalization in the audit log. Never includes the full
 * justification text, conditions text, vote text, or reviewer emails —
 * only `justificationPresent`/`conditionsCount` counts.
 */
export async function writeAdaptivePanelOverrideAdminAuditEvent(args: {
  actorUid: string;
  /** Phase 9B.5.2 — `null` for a Workspace-bound panel override. */
  teamId: string | null;
  runId: string;
  priorHumanReviewStatus: string;
  finalStatus: string;
  panelRevision: number;
  finalDecisionId: string;
  conditionsCount: number;
  finalizedAt: string;
}): Promise<AdaptiveAdminAuditWriteResult> {
  if (!adminDb) {
    return { status: "failed" };
  }

  const docId = `adaptive-review-panel-override:${args.finalDecisionId}`;
  try {
    await adminDb
      .collection("admin_audit_logs")
      .doc(docId)
      .create({
        action: "adaptive_review_panel_owner_overridden",
        byUid: args.actorUid,
        at: args.finalizedAt,
        teamId: args.teamId,
        runId: args.runId,
        collection: "runs",
        prevStatus: args.priorHumanReviewStatus,
        nextStatus: args.finalStatus,
        decisionId: args.finalDecisionId,
        panelRevision: args.panelRevision,
        justificationPresent: true,
        conditionsCount: args.conditionsCount,
        outcome: "success",
        source: "multi_reviewer_owner_override",
      });
    return { status: "recorded" };
  } catch (err: unknown) {
    const code = (err as { code?: number | string })?.code;
    const message = (err as Error)?.message ?? "";
    const alreadyExists = code === 6 || code === "ALREADY_EXISTS" || message.includes("ALREADY_EXISTS") || message.includes("already exists");
    if (alreadyExists) {
      return { status: "already_exists" };
    }
    console.error("[governance/audit] Failed to write adaptive panel override admin audit event:", { runId: args.runId, finalDecisionId: args.finalDecisionId });
    return { status: "failed" };
  }
}

/**
 * Adaptive Research Export (docs/adaptive-research-export-design.md §5.5)
 * — deterministic, idempotent admin audit event for an export generation
 * or regeneration attempt.
 *
 * `adaptive_export_generated`/`adaptive_export_generation_failed` (Phase 1)
 * keep the original deterministic ID `adaptive-export:${exportId}:${action}`
 * per the design doc's own §5.5 spec, so a retried write after a transient
 * failure can never create a duplicate entry for the SAME creation attempt.
 *
 * `adaptive_export_regenerated` (Phase 2) is deliberately different: each
 * regeneration of the same historical export is its own genuine access
 * event worth its own audit row (that's the entire point of an audit trail
 * for historical retrieval) — deduping by exportId+action the same way
 * would silently collapse every regeneration after the first into
 * `already_exists` and lose that history. Its ID includes a fresh
 * `randomUUID()` component instead, so idempotency here only protects
 * against a single request's own internal retry (the caller would reuse
 * the same generated id within one request), never across genuinely
 * separate regenerations.
 *
 * Booleans only for classification/format — never report content, never
 * private reviewer comments, never secrets (Part 14). `outcome` distinguishes
 * a successful generation/regeneration from a failed one (Part 14's "failed
 * attempts should be distinguishable from successful exports").
 *
 * Phase 5 (Part 17) — `durationMs` (render wall-clock time) and `byteSize`
 * (generated artifact size, success only — a failed render produced no
 * bytes) are optional, purely numeric operational metadata, never the
 * report body itself. They let an admin answer "is export generation
 * getting slower or larger over time" from `admin_audit_logs` alone,
 * without needing a separate metrics pipeline.
 */
export type AdaptiveExportAuditAction = "adaptive_export_generated" | "adaptive_export_generation_failed" | "adaptive_export_regenerated";

const ADAPTIVE_EXPORT_SUCCESS_ACTIONS: ReadonlySet<AdaptiveExportAuditAction> = new Set(["adaptive_export_generated", "adaptive_export_regenerated"]);

export async function writeAdaptiveExportAdminAuditEvent(args: {
  exportId: string;
  action: AdaptiveExportAuditAction;
  actorUid: string;
  runId: string;
  schemaId: string;
  schemaFamily: "milestone2" | "legacy";
  classification: string;
  format: string;
  reportVersion: number;
  governanceStatusAtExport: string;
  at: string;
  failureReason?: string;
  durationMs?: number;
  byteSize?: number;
}): Promise<AdaptiveAdminAuditWriteResult> {
  if (!adminDb) {
    return { status: "failed" };
  }

  const docId =
    args.action === "adaptive_export_regenerated"
      ? `adaptive-export-regenerate:${args.exportId}:${randomUUID()}`
      : `adaptive-export:${args.exportId}:${args.action}`;
  try {
    await adminDb
      .collection("admin_audit_logs")
      .doc(docId)
      .create({
        action: args.action,
        byUid: args.actorUid,
        at: args.at,
        runId: args.runId,
        collection: "runs",
        exportId: args.exportId,
        schemaId: args.schemaId,
        schemaFamily: args.schemaFamily,
        classification: args.classification,
        formatRequested: args.format,
        reportVersion: args.reportVersion,
        governanceStatusAtExport: args.governanceStatusAtExport,
        outcome: ADAPTIVE_EXPORT_SUCCESS_ACTIONS.has(args.action) ? "success" : "failure",
        ...(args.failureReason ? { failureReason: args.failureReason } : {}),
        ...(args.durationMs !== undefined ? { durationMs: args.durationMs } : {}),
        ...(args.byteSize !== undefined ? { byteSize: args.byteSize } : {}),
        source: "adaptive_research_export",
      });
    return { status: "recorded" };
  } catch (err: unknown) {
    const code = (err as { code?: number | string })?.code;
    const message = (err as Error)?.message ?? "";
    const alreadyExists = code === 6 || code === "ALREADY_EXISTS" || message.includes("ALREADY_EXISTS") || message.includes("already exists");
    if (alreadyExists) {
      return { status: "already_exists" };
    }
    console.error("[governance/audit] Failed to write adaptive export admin audit event:", { runId: args.runId, exportId: args.exportId });
    return { status: "failed" };
  }
}
