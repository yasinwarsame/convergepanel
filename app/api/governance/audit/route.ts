/**
 * Governance audit: global append-only log plus per-run drilldown.
 */

import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import {
  governanceQueuePlanForbiddenResponse,
  resolveGovernanceVisibleUserIdsCached,
  runOwnerVisibleInGovernance,
} from "@/lib/governance/governanceVisibleUserIds";
import { resolveGovernanceRequestUser } from "@/lib/governance/authCheck";
import { validateRunWorkspaceAssociation } from "@/lib/workspaces/runWorkspaceIntegrity";
import { logger } from "@/lib/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type AuditAction =
  | "evaluated"
  | "approved"
  | "blocked"
  | "changes_requested"
  | "policy_updated"
  | "adaptive_human_review_decided"
  | "adaptive_human_review_reviewer_assigned"
  | "adaptive_human_review_reviewer_reassigned"
  | "adaptive_human_review_reviewer_unassigned"
  | "adaptive_review_panel_finalized"
  | "adaptive_review_panel_owner_overridden"
  | "adaptive_export_generated"
  | "adaptive_export_generation_failed"
  | "adaptive_export_regenerated";

type AuditEvent = {
  id: string;
  action: AuditAction;
  byUid: string;
  byEmail: string;
  at: string;
  comment?: string;
  prevStatus?: string;
  nextStatus?: string;
  reasons?: string[];
  policyVersion?: number;
  changes?: string[];
  runId?: string;
  collection?: string;
  runType?: string;
  runOwnerUid?: string;
  runOwnerEmail?: string;
  question?: string;
  consensusScore?: number | null;
};

const GOVERNANCE_ACTIONS = new Set<string>([
  "evaluated",
  "approved",
  "blocked",
  "changes_requested",
  "policy_updated",
  // Immutable Adaptive Review History and Admin Audit Integration —
  // additive. Written by writeAdaptiveAdminAuditEvent()
  // (lib/governance/auditLog.ts) for adaptive human-review decisions.
  "adaptive_human_review_decided",
  // Part E3 — Single-Reviewer Assignment for Adaptive Human Review —
  // additive. Written by writeAdaptiveAssignmentAdminAuditEvent()
  // (lib/governance/auditLog.ts) for assignment mutations.
  "adaptive_human_review_reviewer_assigned",
  "adaptive_human_review_reviewer_reassigned",
  "adaptive_human_review_reviewer_unassigned",
  // Transactional Multi-Reviewer Finalization, Part E — additive. Written
  // by writeAdaptivePanelFinalizationAdminAuditEvent() (lib/governance/auditLog.ts)
  // for panel finalization.
  "adaptive_review_panel_finalized",
  // Multi-Reviewer Owner Override, Part F — additive. Written by
  // writeAdaptivePanelOverrideAdminAuditEvent() (lib/governance/auditLog.ts)
  // for owner override finalization.
  "adaptive_review_panel_owner_overridden",
  // Adaptive Research Export, Phase 1 — additive. Written by
  // writeAdaptiveExportAdminAuditEvent() (lib/governance/auditLog.ts) for
  // export generation attempts (success and failure).
  "adaptive_export_generated",
  "adaptive_export_generation_failed",
  // Adaptive Research Export, Phase 2 — additive. Written by the same
  // helper for historical PDF regeneration attempts.
  "adaptive_export_regenerated",
]);

/** Shown in the governance Audit Log tab (human decisions + policy; no system evaluations). */
const AUDIT_LOG_DISPLAY_ACTIONS = new Set<string>([
  "approved",
  "blocked",
  "changes_requested",
  "policy_updated",
  "adaptive_human_review_decided",
  "adaptive_human_review_reviewer_assigned",
  "adaptive_human_review_reviewer_reassigned",
  "adaptive_human_review_reviewer_unassigned",
  "adaptive_review_panel_finalized",
  "adaptive_review_panel_owner_overridden",
  "adaptive_export_generated",
  "adaptive_export_generation_failed",
  "adaptive_export_regenerated",
]);

function isGovernanceAuditDoc(raw: Record<string, unknown>): boolean {
  const a = raw.action;
  return typeof a === "string" && GOVERNANCE_ACTIONS.has(a);
}

function normalizeAuditEvent(id: string, raw: Record<string, unknown>): AuditEvent {
  const action = (typeof raw.action === "string" ? raw.action : "evaluated") as AuditAction;
  const consensusRaw = raw.consensusScore;
  const consensusScore =
    typeof consensusRaw === "number"
      ? consensusRaw
      : consensusRaw === null
        ? null
        : undefined;
  return {
    id,
    action,
    byUid: typeof raw.byUid === "string" ? raw.byUid : "",
    byEmail: typeof raw.byEmail === "string" ? raw.byEmail : "",
    at: typeof raw.at === "string" ? raw.at : "",
    ...(typeof raw.comment === "string" ? { comment: raw.comment } : {}),
    ...(typeof raw.prevStatus === "string" ? { prevStatus: raw.prevStatus } : {}),
    ...(typeof raw.nextStatus === "string" ? { nextStatus: raw.nextStatus } : {}),
    ...(Array.isArray(raw.reasons) ? { reasons: raw.reasons as string[] } : {}),
    ...(typeof raw.policyVersion === "number" ? { policyVersion: raw.policyVersion } : {}),
    ...(Array.isArray(raw.changes) ? { changes: raw.changes as string[] } : {}),
    ...(typeof raw.runId === "string" ? { runId: raw.runId } : {}),
    ...(typeof raw.collection === "string" ? { collection: raw.collection } : {}),
    ...(typeof raw.runType === "string" ? { runType: raw.runType } : {}),
    ...(typeof raw.runOwnerUid === "string" ? { runOwnerUid: raw.runOwnerUid } : {}),
    ...(typeof raw.runOwnerEmail === "string" ? { runOwnerEmail: raw.runOwnerEmail } : {}),
    ...(typeof raw.question === "string" ? { question: raw.question } : {}),
    ...(consensusScore !== undefined ? { consensusScore } : {}),
  };
}

function sortEventsByAtDesc(events: AuditEvent[]): void {
  events.sort((a, b) => {
    if (!a.at && !b.at) return 0;
    if (!a.at) return 1;
    if (!b.at) return -1;
    return b.at.localeCompare(a.at);
  });
}

function filterAuditLogDisplayEvents(events: AuditEvent[]): AuditEvent[] {
  return events.filter((e) => AUDIT_LOG_DISPLAY_ACTIONS.has(e.action));
}

/** Audit tab = this reviewer's own decisions only (not other reviewers on shared runs). */
function filterEventsToViewerActions(events: AuditEvent[], viewerUid: string): AuditEvent[] {
  if (!viewerUid) return [];
  return events.filter((e) => e.byUid === viewerUid);
}

/**
 * Drop duplicate global rows (e.g. double POST). Keeps the newest occurrence per key.
 * Policy updates are not deduped (same actor may publish multiple versions).
 */
function dedupeGovernanceAuditEvents(events: AuditEvent[]): AuditEvent[] {
  const seen = new Set<string>();
  return events.filter((e) => {
    if (e.action === "policy_updated") return true;
    const key = `${e.runId ?? ""}-${e.action}-${e.byUid}-${e.prevStatus ?? ""}-${e.nextStatus ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function enrichRunScopedEvent(
  e: AuditEvent,
  runId: string,
  collection: "runs" | "verifications" | "videoVerifications"
): AuditEvent {
  return {
    ...e,
    runId: e.runId && e.runId.trim() ? e.runId : runId,
    collection: e.collection && e.collection.trim() ? e.collection : collection,
  };
}

function auditOwnerEmailLooksValid(s: string | undefined): boolean {
  return typeof s === "string" && s.includes("@");
}

const AUDIT_LOG_SELECT_FIELDS = [
  "action",
  "byUid",
  "byEmail",
  "at",
  "comment",
  "prevStatus",
  "nextStatus",
  "reasons",
  "policyVersion",
  "changes",
  "runId",
  "collection",
  "runType",
  "runOwnerUid",
  "runOwnerEmail",
  "question",
  "consensusScore",
] as const;

/** Replace UID-shaped runOwnerEmail / fill missing email from users/{uid} before JSON response. */
async function resolveRunOwnerEmailsForAuditEvents(events: AuditEvent[]): Promise<void> {
  const db = adminDb;
  if (!db || events.length === 0) return;
  const uidsToResolve = new Set<string>();
  for (const e of events) {
    const em = (e.runOwnerEmail ?? "").trim();
    if (em && !auditOwnerEmailLooksValid(em)) uidsToResolve.add(em);
    const uid = (e.runOwnerUid ?? "").trim();
    if (uid && (!em || !auditOwnerEmailLooksValid(em))) uidsToResolve.add(uid);
  }
  if (uidsToResolve.size === 0) return;

  const emailMap = new Map<string, string>();
  const unique = [...uidsToResolve].filter(Boolean);
  const chunkSize = 10;
  for (let i = 0; i < unique.length; i += chunkSize) {
    const chunk = unique.slice(i, i + chunkSize);
    const refs = chunk.map((uid) => db.collection("users").doc(uid));
    try {
      const snaps = await db.getAll(...refs);
      for (let j = 0; j < snaps.length; j++) {
        const uid = chunk[j];
        const docSnap = snaps[j];
        const d = docSnap.data() as Record<string, unknown> | undefined;
        const mail = typeof d?.email === "string" ? d.email.trim() : "";
        emailMap.set(uid, auditOwnerEmailLooksValid(mail) ? mail : uid);
      }
    } catch {
      for (const uid of chunk) {
        if (!emailMap.has(uid)) emailMap.set(uid, uid);
      }
    }
  }

  for (const e of events) {
    let em = (e.runOwnerEmail ?? "").trim();
    if (em && !auditOwnerEmailLooksValid(em)) {
      e.runOwnerEmail = emailMap.get(em) ?? em;
      em = (e.runOwnerEmail ?? "").trim();
    }
    if (!auditOwnerEmailLooksValid(em)) {
      const uid = (e.runOwnerUid ?? "").trim();
      if (uid) {
        const resolved = emailMap.get(uid) ?? uid;
        if (auditOwnerEmailLooksValid(resolved)) e.runOwnerEmail = resolved;
      }
    }
  }
}

/** Fetch recent docs; prefer orderBy("at"), fall back to plain limit if index/field issues. */
async function fetchRecentAuditDocs(maxDocs: number) {
  if (!adminDb) return [];
  try {
    const snapshot = await adminDb
      .collection("admin_audit_logs")
      .orderBy("at", "desc")
      .limit(maxDocs)
      .select(...AUDIT_LOG_SELECT_FIELDS)
      .get();
    return snapshot.docs;
  } catch (e) {
    console.warn("[governance/audit] orderBy(at) failed, using limit-only fetch:", e);
    const snapshot = await adminDb
      .collection("admin_audit_logs")
      .limit(maxDocs)
      .select(...AUDIT_LOG_SELECT_FIELDS)
      .get();
    return snapshot.docs;
  }
}

export async function GET(request: NextRequest) {
  if (!adminDb) {
    return NextResponse.json(
      { ok: false, error: { code: "internal_error", message: "Database unavailable" } },
      { status: 500 }
    );
  }

  const t0 = Date.now();

  const resolved = await resolveGovernanceRequestUser(request);
  if (!resolved.ok) {
    return NextResponse.json(
      { ok: false, error: { code: "unauthorized", message: "Authentication required" } },
      { status: 401 }
    );
  }

  const tVis0 = Date.now();
  const vis = await resolveGovernanceVisibleUserIdsCached(resolved.uid);
  console.log(`[governance/audit] visibleUserIds: ${Date.now() - tVis0}ms`);
  if (!vis.ok) {
    if (vis.kind === "plan_required") {
      return governanceQueuePlanForbiddenResponse();
    }
    return NextResponse.json(
      { ok: false, error: { code: "internal_error", message: "Database unavailable" } },
      { status: 500 }
    );
  }

  const { searchParams } = request.nextUrl;
  const runId = searchParams.get("runId");
  const collection = searchParams.get("collection") as "runs" | "verifications" | "videoVerifications" | null;
  const limitRaw = parseInt(searchParams.get("limit") ?? "20", 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(50, Math.max(1, limitRaw)) : 20;
  const fromParam = searchParams.get("from") ?? "";
  const toParam = searchParams.get("to") ?? "";
  const runTypeParam = searchParams.get("runType") ?? "all";

  try {
    if (runId) {
      if (collection !== "runs" && collection !== "verifications" && collection !== "videoVerifications") {
        return NextResponse.json(
          {
            ok: false,
            error: {
              code: "validation_error",
              message: "collection is required when runId is set",
              fields: {
                collection:
                  'Required when runId is set; must be "runs", "verifications", or "videoVerifications"',
              },
            },
          },
          { status: 400 }
        );
      }
      const parentSnap = await adminDb.collection(collection).doc(runId).get();
      if (!parentSnap.exists) {
        return NextResponse.json(
          { ok: false, error: { code: "not_found", message: "Run not found." } },
          { status: 404 }
        );
      }
      const parentData = parentSnap.data() as Record<string, unknown>;
      const ownerUid = String(parentData.userId ?? "");
      if (!runOwnerVisibleInGovernance(vis.visibleUserIds, ownerUid)) {
        return NextResponse.json(
          {
            ok: false,
            error: {
              code: "forbidden",
              message: "You don't have access to this run's audit events.",
            },
          },
          { status: 403 }
        );
      }

      // Phase 4B — Mandatory Workspace Integrity, requester-independent.
      // This route's own visibility model (governance reviewer assignment)
      // is an existing Layer-B grant, not an exemption from Layer A.
      // Scoped to "runs" only — verifications/videoVerifications never
      // carry a workspaceId.
      if (collection === "runs") {
        const integrity = await validateRunWorkspaceAssociation(parentData);
        if (integrity.classification === "invalid") {
          logger.warn("[governance/audit] workspace_run_integrity_failed", { runId, reason: integrity.reason });
          return NextResponse.json(
            { ok: false, error: { code: "not_found", message: "Run not found." } },
            { status: 404 }
          );
        }
      }

      try {
        const runSnap = await adminDb
          .collection("admin_audit_logs")
          .where("runId", "==", runId)
          .limit(200)
          .select(...AUDIT_LOG_SELECT_FIELDS)
          .get();
        const fromGlobal = runSnap.docs
          .filter((d) => isGovernanceAuditDoc(d.data() as Record<string, unknown>))
          .filter((d) => {
            const raw = d.data() as Record<string, unknown>;
            return typeof raw.collection !== "string" || raw.collection === collection;
          })
          .map((d) =>
            enrichRunScopedEvent(
              normalizeAuditEvent(d.id, d.data() as Record<string, unknown>),
              runId,
              collection
            )
          );
        let sorted = filterAuditLogDisplayEvents(fromGlobal.slice());
        sortEventsByAtDesc(sorted);
        sorted = dedupeGovernanceAuditEvents(sorted);
        sorted = filterEventsToViewerActions(sorted, resolved.uid);
        const trimmed = sorted.slice(0, limit);
        if (trimmed.length > 0) {
          const tEm0 = Date.now();
          await resolveRunOwnerEmailsForAuditEvents(trimmed);
          console.log(`[governance/audit] Email lookups: ${Date.now() - tEm0}ms`);
          console.log(`[governance/audit] Total: ${Date.now() - t0}ms`);
          return NextResponse.json({ ok: true, events: trimmed, runId, collection });
        }
      } catch {
        /* fall through */
      }

      try {
        const snap = await adminDb
          .collection(collection)
          .doc(runId)
          .collection("governanceEvents")
          .orderBy("at", "desc")
          .limit(limit)
          .get();
        let events = snap.docs.map((d) =>
          enrichRunScopedEvent(
            normalizeAuditEvent(d.id, d.data() as Record<string, unknown>),
            runId,
            collection
          )
        );
        events = filterAuditLogDisplayEvents(events);
        sortEventsByAtDesc(events);
        events = dedupeGovernanceAuditEvents(events);
        events = filterEventsToViewerActions(events, resolved.uid);
        const out1 = events.slice(0, limit);
        const tEm1 = Date.now();
        await resolveRunOwnerEmailsForAuditEvents(out1);
        console.log(`[governance/audit] Email lookups: ${Date.now() - tEm1}ms`);
        console.log(`[governance/audit] Total: ${Date.now() - t0}ms`);
        return NextResponse.json({ ok: true, events: out1, runId, collection });
      } catch {
        const snap = await adminDb.collection(collection).doc(runId).collection("governanceEvents").get();
        let events = snap.docs.map((d) =>
          enrichRunScopedEvent(
            normalizeAuditEvent(d.id, d.data() as Record<string, unknown>),
            runId,
            collection
          )
        );
        events = filterAuditLogDisplayEvents(events);
        sortEventsByAtDesc(events);
        events = dedupeGovernanceAuditEvents(events);
        events = filterEventsToViewerActions(events, resolved.uid);
        const out2 = events.slice(0, limit);
        const tEm2 = Date.now();
        await resolveRunOwnerEmailsForAuditEvents(out2);
        console.log(`[governance/audit] Email lookups: ${Date.now() - tEm2}ms`);
        console.log(`[governance/audit] Total: ${Date.now() - t0}ms`);
        return NextResponse.json({
          ok: true,
          events: out2,
          runId,
          collection,
        });
      }
    }

    const needsWideScan =
      Boolean(fromParam.trim()) ||
      Boolean(toParam.trim()) ||
      (Boolean(runTypeParam.trim()) && runTypeParam !== "all");
    const fetchCap = needsWideScan
      ? Math.min(1200, Math.max(limit * 25, 300))
      : Math.min(120, Math.max(limit * 4, limit));
    console.log("[governance/audit] Global list: fetching up to", fetchCap, "from admin_audit_logs");

    const tFs0 = Date.now();
    const rawDocs = await fetchRecentAuditDocs(fetchCap);
    console.log(`[governance/audit] Firestore queries: ${Date.now() - tFs0}ms`);
    if (process.env.NODE_ENV !== "production") {
      console.log("[governance/audit] DEBUG: Raw docs from collection:", rawDocs.length);
      if (rawDocs.length > 0) {
        const first = rawDocs[0];
        const data = first.data() as Record<string, unknown>;
        console.log("[governance/audit] DEBUG: First doc id:", first.id);
        console.log("[governance/audit] DEBUG: First doc keys:", Object.keys(data));
      }
    }

    const tProc0 = Date.now();
    let events = rawDocs
      .filter((d) => isGovernanceAuditDoc(d.data() as Record<string, unknown>))
      .map((d) => normalizeAuditEvent(d.id, d.data() as Record<string, unknown>));

    sortEventsByAtDesc(events);
    events = filterAuditLogDisplayEvents(events);
    events = filterEventsToViewerActions(events, resolved.uid);
    events = dedupeGovernanceAuditEvents(events);
    if (fromParam.trim()) {
      events = events.filter((e) => e.at >= fromParam);
    }
    if (toParam.trim()) {
      events = events.filter((e) => e.at <= toParam);
    }
    if (runTypeParam && runTypeParam !== "all") {
      const typeMap: Record<string, string> = { claim: "claim", research: "research", video: "video" };
      const want = typeMap[runTypeParam];
      if (want) {
        events = events.filter((e) => e.runType === want);
      }
    }
    events = events.slice(0, limit);
    console.log(`[governance/audit] Processing: ${Date.now() - tProc0}ms`);

    console.log(
      "[governance/audit] Global list: governance-shaped=",
      rawDocs.filter((d) => isGovernanceAuditDoc(d.data() as Record<string, unknown>)).length,
      "after viewer filter=",
      events.length
    );

    const tEm3 = Date.now();
    await resolveRunOwnerEmailsForAuditEvents(events);
    console.log(`[governance/audit] Email lookups: ${Date.now() - tEm3}ms`);
    console.log(`[governance/audit] Total: ${Date.now() - t0}ms`);
    return NextResponse.json({ ok: true, events });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Audit query failed";
    return NextResponse.json(
      { ok: false, error: { code: "internal_error", message: msg } },
      { status: 500 }
    );
  }
}
