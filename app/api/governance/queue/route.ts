/**
 * Governance review queue: list runs / verifications by governance status.
 *
 * Scoped by resolveGovernanceVisibleUserIds (assigners only, never the viewer's own uid). Queries use userId + orderBy
 * (existing indexes); governance status and a 7-day lookback are filtered in memory
 * (avoids extra composite indexes for range + in + orderBy).
 */

import { NextRequest, NextResponse } from "next/server";
import type { Query, QueryDocumentSnapshot } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import {
  governanceInputFromResearchRun,
  governanceInputFromVerificationDoc,
} from "@/lib/governance/governanceInputFromDocs";
import { getModelDisplayName } from "@/lib/modelInfo";
import { buildAgreementDisagreementDigest } from "@/lib/verification/agreementDigest";
import { isAdminEmail } from "@/lib/admin/config";
import {
  governanceQueueNotReviewerResponse,
  governanceQueuePlanForbiddenResponse,
  resolveGovernanceVisibleUserIds,
} from "@/lib/governance/governanceVisibleUserIds";
import { resolveGovernanceRequestUser } from "@/lib/governance/authCheck";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Only runs / verifications newer than this are included in the merged queue. */
const QUEUE_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

function firestoreMillis(value: unknown): number {
  if (value && typeof value === "object" && "toMillis" in value && typeof (value as { toMillis: () => number }).toMillis === "function") {
    return (value as { toMillis: () => number }).toMillis();
  }
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const t = Date.parse(value);
    return Number.isNaN(t) ? 0 : t;
  }
  if (typeof value === "number" && !Number.isNaN(value)) return value;
  return 0;
}

function truncate(s: string, max: number): string {
  const t = s.trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

type GovernanceStatus = "approved" | "needs_review" | "blocked";

type QueueModelVerdictRow = {
  modelId: string;
  verdict: string;
  confidence: string;
};

type RunSummary = {
  runId: string;
  collection: "runs" | "verifications";
  runType: "research" | "verification";
  question: string;
  consensusScore: number | null;
  evidenceQuality: string | null;
  governanceStatus: GovernanceStatus;
  governanceReasons: string[];
  modelHealth: { ok: number; substituted: number; failed: number };
  verificationVerdict?: string;
  /** Per-model claim verification outcomes (lightweight). */
  modelVerdicts?: QueueModelVerdictRow[];
  agreementSummary?: string;
  dissentSummary?: string;
  /** Key disagreement bullets (research synthesis and/or claim digest). */
  disagreements?: string[];
  /** Short rationale line for claim verdict (first model summary). */
  claimVerdictSummary?: string;
  createdAt: string;
  userId: string;
  userEmail: string;
  /** When the run owner assigned the current viewer as reviewer (from owner user doc). */
  ownerAssignedReviewerAt?: string;
  governanceReviewedBy?: string;
  governanceReviewedAt?: string;
  governanceReviewComment?: string;
};

function logFirestoreError(context: string, err: unknown): void {
  const e = err as { message?: string; code?: number | string; details?: string };
  console.error(`[governance/queue] Firestore query failed (${context}):`, e?.message ?? err);
  console.error("[governance/queue] Error code:", e?.code ?? "none");
  console.error("[governance/queue] Error details:", e?.details ?? "none");
}

function isFirestoreIndexError(err: unknown): boolean {
  if (err && typeof err === "object") {
    const o = err as { code?: number | string; message?: string };
    if (o.code === 9 || o.code === "FAILED_PRECONDITION") return true;
    const c = typeof o.code === "string" ? o.code.toLowerCase() : "";
    if (c.includes("failed_precondition") || c.includes("failed-precondition")) return true;
    const m = typeof o.message === "string" ? o.message.toLowerCase() : "";
    if (m.includes("index") || m.includes("requires an index")) return true;
  }
  return false;
}

function indexRequiredResponse(): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      error: {
        code: "index_required",
        message: "Firestore composite index required. Check server logs for the creation link.",
      },
    },
    { status: 500 }
  );
}

type OwnerProfileCacheEntry = {
  email: string;
  governanceReviewerUid?: string;
  governanceReviewerAssignedAt?: string;
};

async function getOwnerProfile(uid: string, cache: Map<string, OwnerProfileCacheEntry>): Promise<OwnerProfileCacheEntry> {
  if (cache.has(uid)) return cache.get(uid)!;
  if (!adminDb) {
    const fallback = { email: uid };
    cache.set(uid, fallback);
    return fallback;
  }
  try {
    const snap = await adminDb.collection("users").doc(uid).get();
    const d = snap.data() as Record<string, unknown> | undefined;
    const email = typeof d?.email === "string" ? d.email.trim() : "";
    const governanceReviewerUid =
      typeof d?.governanceReviewerUid === "string" ? d.governanceReviewerUid.trim() : undefined;
    const governanceReviewerAssignedAt =
      typeof d?.governanceReviewerAssignedAt === "string" ? d.governanceReviewerAssignedAt.trim() : undefined;
    const entry: OwnerProfileCacheEntry = {
      email: email || uid,
      governanceReviewerUid,
      governanceReviewerAssignedAt,
    };
    cache.set(uid, entry);
    return entry;
  } catch {
    const entry = { email: uid };
    cache.set(uid, entry);
    return entry;
  }
}

/** Resolve display email (doc → profile → uid) and assigner metadata for the current viewer. */
async function resolveQueueOwnerContext(
  rowUid: string,
  docUserEmail: string | undefined,
  viewerUid: string,
  cache: Map<string, OwnerProfileCacheEntry>
): Promise<{ email: string; ownerAssignedReviewerAt?: string }> {
  const profile = await getOwnerProfile(rowUid, cache);
  const fromDoc = typeof docUserEmail === "string" ? docUserEmail.trim() : "";
  const email = fromDoc || profile.email || rowUid;
  let ownerAssignedReviewerAt: string | undefined;
  if (profile.governanceReviewerUid === viewerUid && profile.governanceReviewerAssignedAt) {
    ownerAssignedReviewerAt = profile.governanceReviewerAssignedAt;
  }
  return { email, ownerAssignedReviewerAt };
}

function normalizeGovernanceStatus(raw: string): GovernanceStatus {
  if (raw === "approved" || raw === "needs_review" || raw === "blocked") return raw;
  return "needs_review";
}

function ownerUidFromVerificationDoc(data: Record<string, unknown>): string {
  return String(data.userId ?? data.uid ?? "").trim();
}

function humanizePerModelVerdict(v: string): string {
  const k = v.toLowerCase().replace(/\s+/g, "_");
  const map: Record<string, string> = {
    accurate: "Accurate",
    partially_accurate: "Partially accurate",
    inaccurate: "Inaccurate",
    unverifiable: "Unverifiable",
  };
  return map[k] || v.replace(/_/g, " ");
}

function extractModelVerdictsFromVerification(data: Record<string, unknown>): QueueModelVerdictRow[] {
  const mr = data.modelResults;
  if (!Array.isArray(mr)) return [];
  const out: QueueModelVerdictRow[] = [];
  for (const row of mr) {
    if (!row || typeof row !== "object") continue;
    const m = row as Record<string, unknown>;
    const modelId = String(m.modelId ?? "");
    if (!modelId) continue;
    const status = String(m.status ?? "");
    if (status !== "ok") {
      const label = status === "failed" ? "Failed" : "Parse error";
      out.push({ modelId, verdict: label, confidence: "" });
      continue;
    }
    const confRaw = String(m.confidence ?? "").trim().toLowerCase();
    const confidence =
      confRaw === "high" || confRaw === "medium" || confRaw === "low" ? `${confRaw} confidence` : "";
    out.push({
      modelId,
      verdict: humanizePerModelVerdict(String(m.verdict ?? "")),
      confidence,
    });
  }
  return out;
}

function buildAgreementDissentFromVerification(data: Record<string, unknown>): {
  agreementSummary?: string;
  dissentSummary?: string;
} {
  const mr = data.modelResults;
  if (!Array.isArray(mr)) return {};
  type Row = { verdict: string };
  const usable: Row[] = [];
  for (const row of mr) {
    if (!row || typeof row !== "object") continue;
    const m = row as Record<string, unknown>;
    if (String(m.status ?? "") !== "ok") continue;
    usable.push({ verdict: String(m.verdict ?? "").toLowerCase().replace(/\s+/g, "_") });
  }
  if (usable.length === 0) return {};
  const counts = new Map<string, number>();
  for (const u of usable) {
    counts.set(u.verdict, (counts.get(u.verdict) ?? 0) + 1);
  }
  let majority = "";
  let max = 0;
  for (const [v, c] of counts) {
    if (c > max) {
      max = c;
      majority = v;
    }
  }
  const n = usable.length;
  const agreementSummary = `${max}/${n} models say ${humanizePerModelVerdict(majority).toLowerCase()}`;
  const outliers = mr.filter((row) => {
    if (!row || typeof row !== "object") return false;
    const m = row as Record<string, unknown>;
    if (String(m.status ?? "") !== "ok") return false;
    return String(m.verdict ?? "").toLowerCase().replace(/\s+/g, "_") !== majority;
  }) as Record<string, unknown>[];
  if (outliers.length === 0) return { agreementSummary };
  const parts = outliers.map((o) => {
    const id = String(o.modelId ?? "");
    const v = humanizePerModelVerdict(String(o.verdict ?? ""));
    return `${getModelDisplayName(id)}: ${v}`;
  });
  return { agreementSummary, dissentSummary: `Dissent: ${parts.join("; ")}` };
}

function verificationDisagreementBullets(data: Record<string, unknown>): string[] {
  const mr = data.modelResults;
  if (!Array.isArray(mr)) return [];
  const lines = mr
    .filter((m) => m && typeof m === "object")
    .map((m) => {
      const o = m as Record<string, unknown>;
      return {
        modelId: String(o.modelId ?? ""),
        correctParts: Array.isArray(o.correctParts) ? (o.correctParts as string[]) : [],
        incorrectParts: Array.isArray(o.incorrectParts) ? (o.incorrectParts as string[]) : [],
      };
    })
    .filter((x) => x.modelId);
  if (lines.length === 0) return [];
  const { whereModelsDisagree } = buildAgreementDisagreementDigest(lines);
  return whereModelsDisagree.map((d) => d.point).slice(0, 3);
}

function firstVerificationModelSummary(data: Record<string, unknown>): string | undefined {
  const mr = data.modelResults;
  if (!Array.isArray(mr)) return undefined;
  for (const row of mr) {
    if (!row || typeof row !== "object") continue;
    const m = row as Record<string, unknown>;
    if (String(m.status ?? "") !== "ok") continue;
    const s = typeof m.summary === "string" ? m.summary.trim() : "";
    if (s) return truncate(s, 240);
  }
  return undefined;
}

function pushDisagreementLine(out: string[], line: string) {
  const t = line.trim();
  if (t && !out.includes(t)) out.push(t);
}

function extractResearchDisagreementBullets(data: Record<string, unknown>): string[] {
  const out: string[] = [];
  const candidates = [
    data.synthesizedStructuredReport,
    data.synthesizedReportV2,
    data.structuredSynthesis,
    (data.synthesis as Record<string, unknown> | undefined)?.structured,
  ];
  for (const rep of candidates) {
    if (!rep || typeof rep !== "object") continue;
    const r = rep as Record<string, unknown>;
    const d1 = r.disagreements;
    if (Array.isArray(d1)) {
      for (const item of d1) {
        if (typeof item === "string") pushDisagreementLine(out, item);
        else if (item && typeof item === "object") {
          const o = item as Record<string, unknown>;
          const topic = String(o.topic ?? "");
          const why = String(o.whyTheyDiffer ?? o.description ?? o.summary ?? "");
          const point = topic && why ? `${topic}: ${why}` : topic || why;
          pushDisagreementLine(out, truncate(point, 280));
        }
        if (out.length >= 3) return out.slice(0, 3);
      }
    }
    const kd = r.keyDisagreements;
    if (Array.isArray(kd)) {
      for (const item of kd) {
        if (typeof item === "string") pushDisagreementLine(out, item);
        else if (item && typeof item === "object") {
          const o = item as Record<string, unknown>;
          const topic = String(o.topic ?? "");
          const summary = String(o.summary ?? "");
          const point = topic && summary ? `${topic}: ${summary}` : topic || summary;
          pushDisagreementLine(out, truncate(point, 280));
        }
        if (out.length >= 3) return out.slice(0, 3);
      }
    }
    if (out.length >= 3) break;
  }
  return out.slice(0, 3);
}

function summarizeResearch(id: string, data: Record<string, unknown>, email: string): RunSummary {
  const gi = governanceInputFromResearchRun(data);
  const disagreements = extractResearchDisagreementBullets(data);
  return {
    runId: id,
    collection: "runs",
    runType: "research",
    question: truncate(String(data.question ?? ""), 200),
    consensusScore: gi.consensusScore,
    evidenceQuality: gi.evidenceQuality,
    governanceStatus: normalizeGovernanceStatus(String(data.governanceStatus ?? "needs_review")),
    governanceReasons: Array.isArray(data.governanceReasons) ? (data.governanceReasons as string[]) : [],
    modelHealth: gi.modelHealth,
    ...(disagreements.length > 0 ? { disagreements } : {}),
    createdAt: new Date(firestoreMillis(data.createdAt) || Date.now()).toISOString(),
    userId: String(data.userId ?? ""),
    userEmail: email,
    governanceReviewedBy: typeof data.governanceReviewedBy === "string" ? data.governanceReviewedBy : undefined,
    governanceReviewedAt: typeof data.governanceReviewedAt === "string" ? data.governanceReviewedAt : undefined,
    governanceReviewComment:
      typeof data.governanceReviewComment === "string" ? data.governanceReviewComment : undefined,
  };
}

function summarizeVerification(id: string, data: Record<string, unknown>, email: string): RunSummary {
  const gi = governanceInputFromVerificationDoc(data);
  const createdMs =
    firestoreMillis(data.timestamp) ||
    firestoreMillis(data.createdAt) ||
    firestoreMillis(data.verifiedAt) ||
    Date.now();
  const ownerUid = ownerUidFromVerificationDoc(data);
  const modelVerdicts = extractModelVerdictsFromVerification(data);
  const { agreementSummary, dissentSummary } = buildAgreementDissentFromVerification(data);
  const digestDisagreements = verificationDisagreementBullets(data);
  const claimVerdictSummary = firstVerificationModelSummary(data);
  return {
    runId: id,
    collection: "verifications",
    runType: "verification",
    question: truncate(String(data.claim ?? ""), 200),
    consensusScore: gi.consensusScore,
    evidenceQuality: gi.evidenceQuality,
    governanceStatus: normalizeGovernanceStatus(String(data.governanceStatus ?? "needs_review")),
    governanceReasons: Array.isArray(data.governanceReasons) ? (data.governanceReasons as string[]) : [],
    modelHealth: gi.modelHealth,
    verificationVerdict: data.verdict != null ? String(data.verdict) : undefined,
    ...(modelVerdicts.length > 0 ? { modelVerdicts } : {}),
    ...(agreementSummary ? { agreementSummary } : {}),
    ...(dissentSummary ? { dissentSummary } : {}),
    ...(digestDisagreements.length > 0 ? { disagreements: digestDisagreements } : {}),
    ...(claimVerdictSummary ? { claimVerdictSummary } : {}),
    createdAt: new Date(createdMs).toISOString(),
    userId: ownerUid || String(data.userId ?? ""),
    userEmail: email,
    governanceReviewedBy: typeof data.governanceReviewedBy === "string" ? data.governanceReviewedBy : undefined,
    governanceReviewedAt: typeof data.governanceReviewedAt === "string" ? data.governanceReviewedAt : undefined,
    governanceReviewComment:
      typeof data.governanceReviewComment === "string" ? data.governanceReviewComment : undefined,
  };
}

function hasEvaluatedGovernance(data: Record<string, unknown>): boolean {
  const s = data.governanceStatus;
  return s === "approved" || s === "needs_review" || s === "blocked";
}

function isClaimVerificationRow(data: Record<string, unknown>): boolean {
  const t = data.type;
  return t === "claim_verification" || t === undefined || t === null;
}

/**
 * Research runs: must have governanceStatus (evaluation wired on pipeline).
 * Claim verifications: include rows without governance when filter is needs_review/all
 * (older docs, or evaluateAndStore skipped/failed) so they still appear for review.
 */
function researchCreatedMs(data: Record<string, unknown>): number {
  return firestoreMillis(data.createdAt);
}

function verificationTimeMs(data: Record<string, unknown>): number {
  return (
    firestoreMillis(data.timestamp) ||
    firestoreMillis(data.createdAt) ||
    firestoreMillis(data.verifiedAt)
  );
}

function filterRowForQueue(
  data: Record<string, unknown>,
  statusFilter: string,
  source: "runs" | "verifications"
): boolean {
  const evaluated = hasEvaluatedGovernance(data);
  if (source === "verifications" && isClaimVerificationRow(data) && !evaluated) {
    return statusFilter === "needs_review" || statusFilter === "all";
  }
  if (!evaluated) return false;
  if (statusFilter === "all") return true;
  return String(data.governanceStatus ?? "") === statusFilter;
}

/** userId + orderBy only — uses existing composite (userId, createdAt desc). */
function runsQuerySimple(visibleUserIds: string[], fetchLimit: number): Query {
  if (!adminDb) throw new Error("no db");
  const col = adminDb.collection("runs");
  if (visibleUserIds.length === 1) {
    return col.where("userId", "==", visibleUserIds[0]).orderBy("createdAt", "desc").limit(fetchLimit);
  }
  return col.where("userId", "in", visibleUserIds).orderBy("createdAt", "desc").limit(fetchLimit);
}

/**
 * One equality query per owner (single-field index). Merge, dedupe, sort in memory.
 * Avoids `in` + orderBy edge cases and works when some docs omit `timestamp` (sort uses fallbacks).
 */
async function fetchVerificationDocsForOwners(
  visibleUserIds: string[],
  fetchLimit: number
): Promise<{ docs: QueryDocumentSnapshot[]; perOwnerLimit: number }> {
  if (!adminDb) throw new Error("no db");
  const col = adminDb.collection("verifications");
  const perOwnerLimit = Math.min(
    300,
    Math.max(60, Math.ceil(fetchLimit / Math.max(1, visibleUserIds.length)) + 40)
  );
  const snaps = await Promise.all(
    visibleUserIds.map((ownerId) => col.where("userId", "==", ownerId).limit(perOwnerLimit).get())
  );
  const byId = new Map<string, QueryDocumentSnapshot>();
  for (const s of snaps) {
    for (const d of s.docs) {
      byId.set(d.id, d);
    }
  }
  return { docs: [...byId.values()], perOwnerLimit };
}

export async function GET(request: NextRequest) {
  if (!adminDb) {
    return NextResponse.json(
      { ok: false, error: { code: "internal_error", message: "Database unavailable" } },
      { status: 500 }
    );
  }

  const resolved = await resolveGovernanceRequestUser(request);
  if (!resolved.ok) {
    return NextResponse.json(
      { ok: false, error: { code: "unauthorized", message: "Authentication required" } },
      { status: 401 }
    );
  }

  console.log(
    `[governance/queue] Checking admin for email: "${resolved.email}", isAdmin: ${isAdminEmail(resolved.email)}`
  );

  const { searchParams } = request.nextUrl;
  const limitRawEarly = parseInt(searchParams.get("limit") ?? "50", 10);
  const limitEarly = Number.isFinite(limitRawEarly) ? Math.min(100, Math.max(1, limitRawEarly)) : 50;
  const offsetRawEarly = parseInt(searchParams.get("offset") ?? "0", 10);
  const offsetEarly = Number.isFinite(offsetRawEarly) && offsetRawEarly >= 0 ? offsetRawEarly : 0;

  const vis = await resolveGovernanceVisibleUserIds(resolved.uid, resolved.email);
  if (!vis.ok) {
    if (vis.kind === "plan_required") {
      return governanceQueuePlanForbiddenResponse();
    }
    if (vis.kind === "not_reviewer") {
      return governanceQueueNotReviewerResponse();
    }
    return NextResponse.json(
      { ok: false, error: { code: "internal_error", message: "Database unavailable" } },
      { status: 500 }
    );
  }

  const { visibleUserIds } = vis;

  if (visibleUserIds.length === 0) {
    return NextResponse.json({
      ok: true,
      runs: [],
      total: 0,
      offset: offsetEarly,
      limit: limitEarly,
      ...(vis.isSupportAdmin
        ? {
            queueNotice:
              "Admin global review is coming soon. Runs from other users appear here when they assign you as their reviewer.",
          }
        : {}),
    });
  }

  console.log(
    `[governance/queue] Querying for userIds: ${visibleUserIds.join(", ")} (${visibleUserIds.length} users)`
  );

  const statusFilter = searchParams.get("status") ?? "needs_review";
  if (!["needs_review", "blocked", "approved", "all"].includes(statusFilter)) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "validation_error",
          message: "Invalid status",
          fields: { status: 'Must be "needs_review", "blocked", "approved", or "all"' },
        },
      },
      { status: 400 }
    );
  }

  const runType = searchParams.get("runType") ?? "all";
  if (!["research", "verification", "all"].includes(runType)) {
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "validation_error",
          message: "Invalid runType",
          fields: { runType: 'Must be "research", "verification", or "all"' },
        },
      },
      { status: 400 }
    );
  }

  const limit = limitEarly;
  const offset = offsetEarly;

  const fetchLimit = Math.min(500, Math.max(200, offset + limit * 4));

  const ownerProfileCache = new Map<string, OwnerProfileCacheEntry>();
  const merged: Array<{ sortKey: number; summary: RunSummary }> = [];
  const queueCutoffMs = Date.now() - QUEUE_LOOKBACK_MS;

  try {
    let runsSnapSize = 0;
    let verSnapSize = 0;

    if (runType === "research" || runType === "all") {
      try {
        const runsSnap = await runsQuerySimple(visibleUserIds, fetchLimit).get();
        runsSnapSize = runsSnap.size;
        for (const doc of runsSnap.docs) {
          const data = doc.data() as Record<string, unknown>;
          if (!visibleUserIds.includes(String(data.userId ?? ""))) continue;
          const createdMs = researchCreatedMs(data);
          if (!createdMs || createdMs < queueCutoffMs) continue;
          if (!filterRowForQueue(data, statusFilter, "runs")) continue;
          const rowUid = String(data.userId ?? "");
          const docEmail =
            typeof data.userEmail === "string" ? data.userEmail : undefined;
          const { email, ownerAssignedReviewerAt } = await resolveQueueOwnerContext(
            rowUid,
            docEmail,
            resolved.uid,
            ownerProfileCache
          );
          const summary = summarizeResearch(doc.id, data, email);
          if (ownerAssignedReviewerAt) summary.ownerAssignedReviewerAt = ownerAssignedReviewerAt;
          merged.push({
            sortKey: firestoreMillis(data.createdAt),
            summary,
          });
        }
      } catch (err: unknown) {
        logFirestoreError("runs", err);
        if (isFirestoreIndexError(err)) {
          return indexRequiredResponse();
        }
        return NextResponse.json(
          { ok: false, error: { code: "query_failed", message: "Failed to load governance queue." } },
          { status: 500 }
        );
      }
    }

    if (runType === "verification" || runType === "all") {
      try {
        const { docs: verDocs, perOwnerLimit } = await fetchVerificationDocsForOwners(
          visibleUserIds,
          fetchLimit
        );
        verSnapSize = verDocs.length;

        console.log(`[governance/queue] Verifications query:`, {
          collection: "verifications",
          userIdField: "userId",
          queryMode: "per_owner_equality_limit",
          visibleUserIds,
          perOwnerLimit,
          docsFound: verDocs.length,
        });

        if (verDocs.length > 0) {
          const firstDoc = verDocs[0];
          const sample = firstDoc.data() as Record<string, unknown>;
          console.log(`[governance/queue] Sample verification doc fields:`, Object.keys(sample));
          console.log(`[governance/queue] Sample verification doc userId:`, sample.userId);
          console.log(`[governance/queue] Sample verification doc governanceStatus:`, sample.governanceStatus);
          console.log(
            `[governance/queue] Sample verification doc timestamp field:`,
            sample.timestamp || sample.createdAt || sample.verifiedAt || "NONE FOUND"
          );
        }

        for (const doc of verDocs) {
          const data = doc.data() as Record<string, unknown>;
          if (!isClaimVerificationRow(data)) continue;
          const rowUid = ownerUidFromVerificationDoc(data);
          if (!rowUid || !visibleUserIds.includes(rowUid)) continue;
          const vMs = verificationTimeMs(data);
          if (!vMs || vMs < queueCutoffMs) continue;
          if (!filterRowForQueue(data, statusFilter, "verifications")) continue;
          const docEmail =
            typeof data.userEmail === "string" ? data.userEmail : undefined;
          const { email, ownerAssignedReviewerAt } = await resolveQueueOwnerContext(
            rowUid,
            docEmail,
            resolved.uid,
            ownerProfileCache
          );
          const sortKey =
            firestoreMillis(data.timestamp) || firestoreMillis(data.createdAt) || firestoreMillis(data.verifiedAt);
          const summary = summarizeVerification(doc.id, data, email);
          if (ownerAssignedReviewerAt) summary.ownerAssignedReviewerAt = ownerAssignedReviewerAt;
          merged.push({ sortKey, summary });
        }
      } catch (err: unknown) {
        logFirestoreError("verifications", err);
        if (isFirestoreIndexError(err)) {
          return indexRequiredResponse();
        }
        return NextResponse.json(
          { ok: false, error: { code: "query_failed", message: "Failed to load governance queue." } },
          { status: 500 }
        );
      }
    }

    merged.sort((a, b) => b.sortKey - a.sortKey);
    const total = merged.length;
    const runs = merged.slice(offset, offset + limit).map((m) => m.summary);

    console.log(
      `[governance/queue] Firestore: ${runsSnapSize} research docs, ${verSnapSize} verification docs read; ` +
        `${merged.length} rows after 7d + status filters for userIds: ${visibleUserIds.join(", ")} ` +
        `(cutoff ${new Date(queueCutoffMs).toISOString()})`
    );

    return NextResponse.json({
      ok: true,
      runs,
      total,
      offset,
      limit,
    });
  } catch (e: unknown) {
    logFirestoreError("queue outer", e);
    const msg = e instanceof Error ? e.message : "Queue query failed";
    return NextResponse.json(
      { ok: false, error: { code: "internal_error", message: msg } },
      { status: 500 }
    );
  }
}
