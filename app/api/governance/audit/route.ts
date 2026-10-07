/**
 * Governance audit: global append-only log plus per-run drilldown.
 */

import { NextRequest, NextResponse } from "next/server";
import { adminDb } from "@/lib/firebase/admin";
import { isPersonalVerificationArtifact, isWorkspaceBoundVerificationArtifact } from "@/lib/verification/verificationArtifactScope";
import {
  governanceQueuePlanForbiddenResponse,
  resolveGovernanceVisibleUserIdsCached,
  runOwnerVisibleInGovernance,
} from "@/lib/governance/governanceVisibleUserIds";
import { resolveGovernanceRequestUser } from "@/lib/governance/authCheck";
import { validateRunWorkspaceAssociation } from "@/lib/workspaces/runWorkspaceIntegrity";
import { createRunWorkspaceIntegrityBatch } from "@/lib/workspaces/runWorkspaceIntegrityBatch";
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

/**
 * Roadmap 4.1 (C2 + C3) — the run-owner identity an Audit Log viewer may see.
 *
 * What leaves this route is the ONLY run-owner identity the client has:
 * - `runOwnerIsViewer: true` when the run belongs to the viewer, or
 * - `runOwnerEmail` holding a real address (it contains "@"), or
 * - neither, which the client renders as "Not available".
 * `runOwnerUid` never leaves the route, and neither `runOwnerEmail` nor
 * `byEmail` is ever sent holding anything but a real address. "Never recorded" and "not visible to this viewer" both
 * produce the same "neither" shape, so the response cannot tell them apart.
 *
 * Owner source:
 * - Rows that persisted `runOwnerUid` at write time (governance review,
 *   evaluation, backfill) keep the owner they recorded, as before.
 * - Rows with no recorded owner (the adaptive writers store `byUid` only)
 *   are classified from their parent `runs/{runId}` document. The owner is
 *   released only when it is the viewer, or the run carries no `workspaceId`
 *   field AND the owner passes the governance visibility rule
 *   (`runOwnerVisibleInGovernance`, the rule the drilldown already enforces).
 *   A workspace-bound, missing, malformed or unreadable parent, a parent with
 *   no owner, or an owner outside the visible set releases nothing.
 *
 * Reads: one batched getAll() retrieval per chunk of distinct parents (field
 * mask `userId`, `workspaceId`) and one per chunk of distinct owner profiles —
 * bounded by the events already in hand, never one round trip per event.
 * Neither read throws out of this function: a failure releases nothing.
 */
const AUDIT_OWNER_PROFILE_CHUNK = 10;

type AuditResponseEvent = Omit<AuditEvent, "byEmail" | "runOwnerUid" | "runOwnerEmail"> & {
  byEmail?: string;
  runOwnerEmail?: string;
  runOwnerIsViewer?: true;
};

/**
 * Run parents already read (field mask `userId`, `workspaceId`) by the list's
 * containment pass, keyed by runId; `null` = no usable parent. Lets owner
 * classification reuse that batch instead of reading the same documents again.
 */
type PreloadedRunParents = ReadonlyMap<string, Record<string, unknown> | null>;

async function classifyRunOwnersFromParents(
  runIds: string[],
  viewerUid: string,
  visibleUserIds: string[] | null,
  preloaded?: PreloadedRunParents
): Promise<Map<string, string>> {
  const released = new Map<string, string>();
  const db = adminDb;
  if (!db || runIds.length === 0) return released;
  const release = (runId: string, data: Record<string, unknown> | null | undefined) => {
    if (typeof data !== "object" || data === null) return;
    const ownerUid = typeof data.userId === "string" ? data.userId.trim() : "";
    if (!ownerUid) return;
    if (ownerUid === viewerUid) {
      released.set(runId, ownerUid);
      return;
    }
    if (Object.prototype.hasOwnProperty.call(data, "workspaceId")) return;
    if (!runOwnerVisibleInGovernance(visibleUserIds, ownerUid)) return;
    released.set(runId, ownerUid);
  };
  const toRead: string[] = [];
  for (const runId of runIds) {
    if (preloaded?.has(runId)) release(runId, preloaded.get(runId));
    else toRead.push(runId);
  }
  for (let i = 0; i < toRead.length; i += AUDIT_PARENT_CLASSIFY_CHUNK) {
    const chunk = toRead.slice(i, i + AUDIT_PARENT_CLASSIFY_CHUNK);
    try {
      const refs = chunk.map((runId) => db.collection("runs").doc(runId));
      const snaps = await db.getAll(...refs, { fieldMask: ["userId", "workspaceId"] });
      chunk.forEach((runId, j) => {
        const snap = snaps[j];
        if (!snap || snap.exists !== true) return;
        release(runId, snap.data());
      });
    } catch (err) {
      logger.warn("[governance/audit] run_owner_parent_read_failed", {
        errorName: err instanceof Error ? err.name : typeof err,
      });
    }
  }
  return released;
}

async function readOwnerProfileEmails(uids: string[]): Promise<Map<string, string>> {
  const emails = new Map<string, string>();
  const db = adminDb;
  if (!db || uids.length === 0) return emails;
  for (let i = 0; i < uids.length; i += AUDIT_OWNER_PROFILE_CHUNK) {
    const chunk = uids.slice(i, i + AUDIT_OWNER_PROFILE_CHUNK);
    try {
      const snaps = await db.getAll(...chunk.map((uid) => db.collection("users").doc(uid)));
      chunk.forEach((uid, j) => {
        const d = snaps[j]?.data() as Record<string, unknown> | undefined;
        const mail = typeof d?.email === "string" ? d.email.trim() : "";
        if (auditOwnerEmailLooksValid(mail)) emails.set(uid, mail);
      });
    } catch (err) {
      logger.warn("[governance/audit] run_owner_profile_read_failed", {
        errorName: err instanceof Error ? err.name : typeof err,
      });
    }
  }
  return emails;
}

async function presentAuditEventsForViewer(
  events: AuditEvent[],
  viewerUid: string,
  visibleUserIds: string[] | null,
  preloaded?: PreloadedRunParents
): Promise<AuditResponseEvent[]> {
  const parentRunIds = new Set<string>();
  for (const e of events) {
    const runId = (e.runId ?? "").trim();
    if (!(e.runOwnerUid ?? "").trim() && e.collection === "runs" && runId && runId !== "policy") {
      parentRunIds.add(runId);
    }
  }
  const ownerByRunId = await classifyRunOwnersFromParents([...parentRunIds], viewerUid, visibleUserIds, preloaded);

  const ownerUidFor = (e: AuditEvent): string => {
    const recorded = (e.runOwnerUid ?? "").trim();
    if (recorded) return recorded;
    if (e.collection !== "runs") return "";
    return ownerByRunId.get((e.runId ?? "").trim()) ?? "";
  };

  const profileLookups = new Set<string>();
  for (const e of events) {
    const ownerUid = ownerUidFor(e);
    if (ownerUid && ownerUid !== viewerUid && !auditOwnerEmailLooksValid((e.runOwnerEmail ?? "").trim())) {
      profileLookups.add(ownerUid);
    }
  }
  const emailByUid = await readOwnerProfileEmails([...profileLookups]);

  return events.map((e) => {
    const { runOwnerUid: _runOwnerUid, runOwnerEmail: recordedEmail, byEmail, ...base } = e;
    const rest: AuditResponseEvent = auditOwnerEmailLooksValid(byEmail.trim()) ? { ...base, byEmail } : base;
    const ownerUid = ownerUidFor(e);
    if (!ownerUid) return rest;
    if (ownerUid === viewerUid) return { ...rest, runOwnerIsViewer: true };
    const recorded = (recordedEmail ?? "").trim();
    const email = auditOwnerEmailLooksValid(recorded) ? recorded : emailByUid.get(ownerUid);
    return email ? { ...rest, runOwnerEmail: email } : rest;
  });
}

const VERIFICATION_AUDIT_COLLECTIONS = new Set(["verifications", "videoVerifications"]);
/** Parent reads per getAll() call when classifying global audit events. */
const AUDIT_PARENT_CLASSIFY_CHUNK = 100;

/**
 * Global Audit tab containment — an ALLOW-LIST decision on each event's parent.
 * The list must never advertise an event whose drilldown
 * (`?runId=&collection=`) is concealed, so every parent-backed event is
 * classified by the same rule its drilldown applies.
 *
 * TEAM-VERIFICATION-PARITY-R1 (C1) — Claim/Video events (`collection` is
 * `verifications` / `videoVerifications`). A legacy governance review of a
 * Workspace-bound Claim/Video wrote a DISPLAYABLE row, so:
 *
 *   parent exists, masked data is an object with NO `workspaceId` -> Personal, kept
 *   parent exists with a `workspaceId` field (any value)          -> suppressed
 *
 * Roadmap 4.3a (D1) — Research-run events. Any event with a real `runId`
 * (other than "policy") whose `collection` is `"runs"` OR ABSENT — the
 * dashboard trail drills into `runs` when `collection` is missing — is a
 * run-backed event. Team Workspace review, panel, assignment and export events
 * all write `collection: "runs"` against Team-bound runs, whose drilldown is
 * concealed (404) by `validateRunWorkspaceAssociation`. The SAME validator
 * classifies the parent here, through the shared batched integrity cache, so
 * list and drilldown cannot disagree:
 *
 *   legacy (no workspaceId) or valid Personal binding -> kept
 *   classified `invalid` (Team-bound / malformed)     -> suppressed
 *
 * Both kinds:
 *   parent does not exist / data unusable           -> unclassifiable, suppressed
 *   event has no usable runId                       -> unclassifiable, suppressed
 *   any other `collection` value                    -> unclassifiable, suppressed
 *   a classification read throws                    -> propagates, route answers 500
 *
 * `policy_updated` events have no parent and are always kept.
 *
 * Reads are batched `getAll()` calls over distinct parents, chunked at
 * AUDIT_PARENT_CLASSIFY_CHUNK, field-masked to what the rule needs
 * (`workspaceId` for Claims/Videos; `userId` + `workspaceId` for runs), and
 * bounded by the events already in hand — never N+1, no writes.
 */
type AuditParentKind = "verification" | "run";

function auditParentOf(e: AuditEvent): { kind: AuditParentKind; collection: string; runId: string } | "policy" | null {
  if (e.action === "policy_updated") return "policy";
  const runId = (e.runId ?? "").trim();
  const collection = (e.collection ?? "").trim();
  if (!runId || runId === "policy") return null;
  if (VERIFICATION_AUDIT_COLLECTIONS.has(collection)) return { kind: "verification", collection, runId };
  if (collection === "" || collection === "runs") return { kind: "run", collection: "runs", runId };
  return null;
}

async function excludeOutOfDomainAuditEvents(
  events: AuditEvent[]
): Promise<{ events: AuditEvent[]; runParents: Map<string, Record<string, unknown> | null> }> {
  const db = adminDb;
  if (!db) throw new Error("no db");
  const parents = new Map<string, { kind: AuditParentKind; collection: string; runId: string }>();
  for (const e of events) {
    const parent = auditParentOf(e);
    if (parent && parent !== "policy") parents.set(`${parent.collection}/${parent.runId}`, parent);
  }

  const allowedParents = new Set<string>();
  const runParents = new Map<string, Record<string, unknown> | null>();
  const validateRun = createRunWorkspaceIntegrityBatch();
  for (const kind of ["verification", "run"] as const) {
    const entries = [...parents.entries()].filter(([, p]) => p.kind === kind);
    const fieldMask = kind === "run" ? ["userId", "workspaceId"] : ["workspaceId"];
    for (let i = 0; i < entries.length; i += AUDIT_PARENT_CLASSIFY_CHUNK) {
      const chunk = entries.slice(i, i + AUDIT_PARENT_CLASSIFY_CHUNK);
      const refs = chunk.map(([, p]) => db.collection(p.collection).doc(p.runId));
      const snaps = await db.getAll(...refs, { fieldMask });
      await Promise.all(
        chunk.map(async ([key, p], j) => {
          const snap = snaps[j];
          if (kind === "run") runParents.set(p.runId, null);
          // Firestore guarantees data() is an object for an existing document
          // (`{}` when the masked fields are absent); anything else is not
          // positively in the legacy-governance domain and stays excluded.
          if (!snap || snap.exists !== true) return;
          const data = snap.data();
          if (typeof data !== "object" || data === null) return;
          if (kind === "verification") {
            if (isPersonalVerificationArtifact(data)) allowedParents.add(key);
            return;
          }
          runParents.set(p.runId, data as Record<string, unknown>);
          const integrity = await validateRun(data as Record<string, unknown>);
          if (integrity.classification !== "invalid") allowedParents.add(key);
        })
      );
    }
  }

  const kept = events.filter((e) => {
    const parent = auditParentOf(e);
    if (parent === "policy") return true;
    if (parent === null) return false;
    return allowedParents.has(`${parent.collection}/${parent.runId}`);
  });
  return { events: kept, runParents };
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

      // TEAM-VERIFICATION-PARITY-R1 — a Workspace-bound Claim/Video has no
      // legacy governance audit drilldown for anyone. Concealed exactly like a
      // missing run, BEFORE legacy visibility, both event queries and email
      // enrichment.
      if (collection !== "runs" && isWorkspaceBoundVerificationArtifact(parentData)) {
        return NextResponse.json(
          { ok: false, error: { code: "not_found", message: "Run not found." } },
          { status: 404 }
        );
      }

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
      // Scoped to "runs" — Workspace-bound verifications/videoVerifications
      // were already concealed above (R1).
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
          const presented = await presentAuditEventsForViewer(trimmed, resolved.uid, vis.visibleUserIds);
          console.log(`[governance/audit] Email lookups: ${Date.now() - tEm0}ms`);
          console.log(`[governance/audit] Total: ${Date.now() - t0}ms`);
          return NextResponse.json({ ok: true, events: presented, runId, collection });
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
        const presented1 = await presentAuditEventsForViewer(out1, resolved.uid, vis.visibleUserIds);
        console.log(`[governance/audit] Email lookups: ${Date.now() - tEm1}ms`);
        console.log(`[governance/audit] Total: ${Date.now() - t0}ms`);
        return NextResponse.json({ ok: true, events: presented1, runId, collection });
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
        const presented2 = await presentAuditEventsForViewer(out2, resolved.uid, vis.visibleUserIds);
        console.log(`[governance/audit] Email lookups: ${Date.now() - tEm2}ms`);
        console.log(`[governance/audit] Total: ${Date.now() - t0}ms`);
        return NextResponse.json({
          ok: true,
          events: presented2,
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
    const contained = await excludeOutOfDomainAuditEvents(events);
    events = contained.events;
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
    const presented3 = await presentAuditEventsForViewer(events, resolved.uid, vis.visibleUserIds, contained.runParents);
    console.log(`[governance/audit] Email lookups: ${Date.now() - tEm3}ms`);
    console.log(`[governance/audit] Total: ${Date.now() - t0}ms`);
    return NextResponse.json({ ok: true, events: presented3 });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Audit query failed";
    return NextResponse.json(
      { ok: false, error: { code: "internal_error", message: msg } },
      { status: 500 }
    );
  }
}
