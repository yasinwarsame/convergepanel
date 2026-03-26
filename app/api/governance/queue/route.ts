/**
 * Governance review queue: list runs / verifications by governance status.
 *
 * Scoped by resolveGovernanceVisibleUserIds: assigners-only, empty (no assigners), or null (admin global).
 * Queries use userId + orderBy for scoped users; admin uses recent global reads with in-memory filters.
 * (existing indexes); governance status and a 7-day lookback are filtered in memory
 * (avoids extra composite indexes for range + in + orderBy).
 */

import { NextRequest, NextResponse } from "next/server";
import type { Query, QueryDocumentSnapshot } from "firebase-admin/firestore";
import { adminDb } from "@/lib/firebase/admin";
import {
  governanceInputFromResearchRun,
  governanceInputFromVerificationDoc,
  researchConsensusScoreFromRunDoc,
} from "@/lib/governance/governanceInputFromDocs";
import { getModelDisplayName } from "@/lib/modelInfo";
import { buildAgreementDisagreementDigest } from "@/lib/verification/agreementDigest";
import { governanceAdminEmailsForLog, isAdminEmail } from "@/lib/admin/config";
import {
  governanceQueuePlanForbiddenResponse,
  resolveGovernanceVisibleUserIdsCached,
} from "@/lib/governance/governanceVisibleUserIds";
import { resolveGovernanceRequestUser } from "@/lib/governance/authCheck";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Only runs / verifications newer than this are included in the merged queue. */
const QUEUE_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/** Field projection for queue reads (avoids pulling full panel payloads). */
const RUN_QUEUE_FIELDS = [
  "userId",
  "createdAt",
  "userEmail",
  "question",
  "query",
  "consensusSummary",
  "governanceStatus",
  "governanceReasons",
  "governanceReviewedBy",
  "governanceReviewedAt",
  "governanceReviewComment",
  "consensusScore",
  "synthesisConsensusSummary",
  "policyConsensusSummary",
  "sourceBacked",
  "missingSourcesCount",
  "runDocument.perModel",
  "resultsCompact.perModel",
  "governanceMeta",
  "synthesizedStructuredReport",
  "synthesizedReportV2",
  "structuredSynthesis",
  "synthesis",
] as const;

const VER_QUEUE_FIELDS = [
  "userId",
  "uid",
  "type",
  "userEmail",
  "claim",
  "question",
  "timestamp",
  "createdAt",
  "verifiedAt",
  "governanceStatus",
  "governanceReasons",
  "governanceReviewedBy",
  "governanceReviewedAt",
  "governanceReviewComment",
  "consensusScore",
  "evidenceQuality",
  "verdict",
  "sourceBacked",
  "missingSourcesCount",
  "governanceMeta",
  "modelResults",
] as const;

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
  /** Short excerpt from the model’s written rationale (capped server-side). */
  summary?: string;
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
  /** Claim verification: high-level agreement lines derived from verdict counts. */
  agreementPoints?: string[];
  /** Claim verification: minority-verdict lines; research: synthesis disagreement bullets. */
  disagreementPoints?: string[];
  /** Claim verification: merged correct-part snippets across models. */
  correctParts?: string[];
  /** Claim verification: merged incorrect-part snippets across models. */
  incorrectParts?: string[];
  /** Research: short key finding lines from stored synthesis when available. */
  keyFindings?: string[];
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
function resolveQueueOwnerContextSync(
  rowUid: string,
  docUserEmail: string | undefined,
  viewerUid: string,
  cache: Map<string, OwnerProfileCacheEntry>
): { email: string; ownerAssignedReviewerAt?: string } {
  const profile = cache.get(rowUid);
  const fromDoc = typeof docUserEmail === "string" ? docUserEmail.trim() : "";
  if (!profile) {
    return { email: fromDoc || rowUid };
  }
  const email = fromDoc || profile.email || rowUid;
  let ownerAssignedReviewerAt: string | undefined;
  if (profile.governanceReviewerUid === viewerUid && profile.governanceReviewerAssignedAt) {
    ownerAssignedReviewerAt = profile.governanceReviewerAssignedAt;
  }
  return { email, ownerAssignedReviewerAt };
}

async function prefetchOwnerProfilesForQueue(
  uids: Iterable<string>,
  cache: Map<string, OwnerProfileCacheEntry>
): Promise<void> {
  const unique = [...new Set([...uids].filter(Boolean))];
  await Promise.all(unique.map((uid) => getOwnerProfile(uid, cache)));
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

/** Rich claim-verification payload for the review queue expanded UI. */
function buildVerificationQueueReviewExtras(data: Record<string, unknown>): {
  modelVerdicts: QueueModelVerdictRow[];
  agreementPoints: string[];
  disagreementPoints: string[];
  correctParts: string[];
  incorrectParts: string[];
} {
  const mr = data.modelResults;
  if (!Array.isArray(mr)) {
    return { modelVerdicts: [], agreementPoints: [], disagreementPoints: [], correctParts: [], incorrectParts: [] };
  }

  const modelVerdicts: QueueModelVerdictRow[] = [];
  for (const row of mr) {
    if (!row || typeof row !== "object") continue;
    const m = row as Record<string, unknown>;
    const modelId = String(m.modelId ?? "");
    if (!modelId) continue;
    const status = String(m.status ?? "");
    if (status !== "ok") {
      const label = status === "failed" ? "Failed" : "Parse error";
      modelVerdicts.push({ modelId, verdict: label, confidence: "" });
      continue;
    }
    const verdictRaw = String(m.verdict ?? m.verdictLabel ?? "");
    const confRaw = String(m.confidence ?? "").trim().toLowerCase();
    const confidence =
      confRaw === "high" || confRaw === "medium" || confRaw === "low"
        ? `${confRaw} confidence`
        : String(m.confidence ?? "").trim();
    const summaryRaw = typeof m.summary === "string" ? m.summary.trim().substring(0, 200) : "";
    modelVerdicts.push({
      modelId,
      verdict: humanizePerModelVerdict(verdictRaw),
      confidence,
      ...(summaryRaw ? { summary: summaryRaw } : {}),
    });
  }

  const usable = mr.filter((row) => {
    if (!row || typeof row !== "object") return false;
    return String((row as Record<string, unknown>).status ?? "") === "ok";
  }) as Record<string, unknown>[];
  const total = Math.max(1, usable.length);

  const verdictCounts: Record<string, string[]> = {};
  for (const row of usable) {
    const m = row as Record<string, unknown>;
    const v = String(m.verdict ?? m.verdictLabel ?? "unknown").toLowerCase().replace(/\s+/g, "_");
    const id = String(m.modelId ?? "");
    if (!verdictCounts[v]) verdictCounts[v] = [];
    verdictCounts[v].push(id);
  }

  const agreementPoints: string[] = [];
  const disagreementPoints: string[] = [];
  for (const [verdict, models] of Object.entries(verdictCounts)) {
    const humanV = humanizePerModelVerdict(verdict);
    if (models.length >= 3) {
      agreementPoints.push(`${models.length}/${total} models rate this as ${humanV.toLowerCase()}`);
    }
    if (models.length === 1 || models.length === 2) {
      const names = models.map((id) => getModelDisplayName(id)).join(", ");
      disagreementPoints.push(`${names} rated as ${humanV.toLowerCase()} (others disagree)`);
    }
  }

  const correctParts: string[] = [];
  const incorrectParts: string[] = [];
  for (const row of usable) {
    const m = row as Record<string, unknown>;
    const cp = m.correctParts;
    const ip = m.incorrectParts;
    if (Array.isArray(cp)) {
      for (const part of cp.slice(0, 2)) {
        if (typeof part === "string" && part.trim() && !correctParts.includes(part.trim())) {
          correctParts.push(part.trim());
        }
      }
    }
    if (Array.isArray(ip)) {
      for (const part of ip.slice(0, 2)) {
        if (typeof part === "string" && part.trim() && !incorrectParts.includes(part.trim())) {
          incorrectParts.push(part.trim());
        }
      }
    }
  }

  return {
    modelVerdicts,
    agreementPoints,
    disagreementPoints,
    correctParts: correctParts.slice(0, 5),
    incorrectParts: incorrectParts.slice(0, 5),
  };
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

function extractResearchSynthesisQueueExtras(data: Record<string, unknown>): {
  keyFindings: string[];
  disagreementPoints: string[];
} {
  const keyFindings: string[] = [];
  const disagreementPoints: string[] = [];
  const seenK = new Set<string>();
  const seenD = new Set<string>();
  const pushFinding = (raw: string) => {
    const t = raw.trim();
    if (!t || seenK.has(t) || keyFindings.length >= 3) return;
    seenK.add(t);
    keyFindings.push(truncate(t, 280));
  };
  const pushDisagreementPoint = (raw: string) => {
    const t = raw.trim();
    if (!t || seenD.has(t) || disagreementPoints.length >= 3) return;
    seenD.add(t);
    disagreementPoints.push(truncate(t, 280));
  };

  const synthRoot = data.structuredSynthesis ?? data.synthesis;
  const candidates: unknown[] = [];
  if (synthRoot && typeof synthRoot === "object") {
    candidates.push(synthRoot);
    const nested = (synthRoot as Record<string, unknown>).structured;
    if (nested && typeof nested === "object") candidates.push(nested);
  }

  for (const rep of candidates) {
    if (!rep || typeof rep !== "object") continue;
    const r = rep as Record<string, unknown>;
    const kf = r.keyFindings;
    if (Array.isArray(kf)) {
      for (const f of kf) {
        if (keyFindings.length >= 3) break;
        if (typeof f === "string") pushFinding(f);
        else if (f && typeof f === "object") {
          const o = f as Record<string, unknown>;
          pushFinding(String(o.finding ?? o.claim ?? o.description ?? ""));
        }
      }
    }
    const dg = r.disagreements;
    if (Array.isArray(dg)) {
      for (const d of dg) {
        if (disagreementPoints.length >= 3) break;
        if (typeof d === "string") pushDisagreementPoint(d);
        else if (d && typeof d === "object") {
          const o = d as Record<string, unknown>;
          pushDisagreementPoint(String(o.point ?? o.description ?? o.topic ?? o.whyTheyDiffer ?? ""));
        }
      }
    }
    if (keyFindings.length >= 3 && disagreementPoints.length >= 3) break;
  }

  return { keyFindings, disagreementPoints };
}

function summarizeResearch(id: string, data: Record<string, unknown>, email: string): RunSummary {
  const reasons = Array.isArray(data.governanceReasons) ? (data.governanceReasons as string[]) : [];
  if (reasons.includes("Consensus score not available")) {
    const score = researchConsensusScoreFromRunDoc(data);
    if (score != null) {
      console.log(
        `[governance/queue] Run ${id} has score ${score} but was evaluated without it — needs re-evaluation`
      );
    }
  }

  const gi = governanceInputFromResearchRun(data);
  const disagreements = extractResearchDisagreementBullets(data);
  const { keyFindings, disagreementPoints } = extractResearchSynthesisQueueExtras(data);
  return {
    runId: id,
    collection: "runs",
    runType: "research",
    question: truncate(String(data.question ?? data.query ?? ""), 200),
    consensusScore: gi.consensusScore,
    evidenceQuality: gi.evidenceQuality,
    governanceStatus: normalizeGovernanceStatus(String(data.governanceStatus ?? "needs_review")),
    governanceReasons: Array.isArray(data.governanceReasons) ? (data.governanceReasons as string[]) : [],
    modelHealth: gi.modelHealth,
    ...(disagreements.length > 0 ? { disagreements } : {}),
    ...(keyFindings.length > 0 ? { keyFindings } : {}),
    ...(disagreementPoints.length > 0 ? { disagreementPoints } : {}),
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
  const reviewExtras = buildVerificationQueueReviewExtras(data);
  const { agreementSummary, dissentSummary } = buildAgreementDissentFromVerification(data);
  const digestDisagreements = verificationDisagreementBullets(data);
  const claimVerdictSummary = firstVerificationModelSummary(data);
  return {
    runId: id,
    collection: "verifications",
    runType: "verification",
    question: truncate(String(data.claim ?? data.question ?? ""), 200),
    consensusScore: gi.consensusScore,
    evidenceQuality: gi.evidenceQuality,
    governanceStatus: normalizeGovernanceStatus(String(data.governanceStatus ?? "needs_review")),
    governanceReasons: Array.isArray(data.governanceReasons) ? (data.governanceReasons as string[]) : [],
    modelHealth: gi.modelHealth,
    verificationVerdict: data.verdict != null ? String(data.verdict) : undefined,
    ...(reviewExtras.modelVerdicts.length > 0 ? { modelVerdicts: reviewExtras.modelVerdicts } : {}),
    ...(reviewExtras.agreementPoints.length > 0 ? { agreementPoints: reviewExtras.agreementPoints } : {}),
    ...(reviewExtras.disagreementPoints.length > 0 ? { disagreementPoints: reviewExtras.disagreementPoints } : {}),
    ...(reviewExtras.correctParts.length > 0 ? { correctParts: reviewExtras.correctParts } : {}),
    ...(reviewExtras.incorrectParts.length > 0 ? { incorrectParts: reviewExtras.incorrectParts } : {}),
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
  const capped = Math.min(25, Math.max(1, fetchLimit));
  const col = adminDb.collection("runs");
  const base =
    visibleUserIds.length === 1
      ? col.where("userId", "==", visibleUserIds[0]).orderBy("createdAt", "desc").limit(capped)
      : col.where("userId", "in", visibleUserIds).orderBy("createdAt", "desc").limit(capped);
  return base.select(...RUN_QUEUE_FIELDS);
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
    25,
    Math.max(12, Math.ceil(fetchLimit / Math.max(1, visibleUserIds.length)) + 4)
  );
  const snaps = await Promise.all(
    visibleUserIds.map((ownerId) =>
      col.where("userId", "==", ownerId).select(...VER_QUEUE_FIELDS).limit(perOwnerLimit).get()
    )
  );
  const byId = new Map<string, QueryDocumentSnapshot>();
  for (const s of snaps) {
    for (const d of s.docs) {
      byId.set(d.id, d);
    }
  }
  return { docs: [...byId.values()], perOwnerLimit };
}

type StagedQueueRow = {
  sortKey: number;
  kind: "research" | "verification";
  docId: string;
  data: Record<string, unknown>;
  rowUid: string;
  docEmail?: string;
};

async function loadRunsStagedForQueue(
  visibleUserIds: string[],
  visibleSet: Set<string>,
  fetchLimit: number,
  queueCutoffMs: number,
  statusFilter: string
): Promise<{ staged: StagedQueueRow[]; snapSize: number }> {
  const runsSnap = await runsQuerySimple(visibleUserIds, fetchLimit).get();
  const staged: StagedQueueRow[] = [];
  for (const doc of runsSnap.docs) {
    const data = doc.data() as Record<string, unknown>;
    {
      const cs = data.consensusSummary as { overallConsensusScore?: unknown } | undefined;
      console.log("[governance/queue] Run doc fields:", {
        runId: doc.id,
        consensusScore: data.consensusScore,
        "consensusSummary.overallConsensusScore": cs?.overallConsensusScore,
        governanceStatus: data.governanceStatus,
        governanceReasons: data.governanceReasons,
        allTopLevelKeys: Object.keys(data).filter((k) => k.includes("consensus") || k.includes("score")),
      });
    }
    if (!visibleSet.has(String(data.userId ?? ""))) continue;
    const createdMs = researchCreatedMs(data);
    if (!createdMs || createdMs < queueCutoffMs) continue;
    if (!filterRowForQueue(data, statusFilter, "runs")) continue;
    staged.push({
      sortKey: firestoreMillis(data.createdAt),
      kind: "research",
      docId: doc.id,
      data,
      rowUid: String(data.userId ?? ""),
      docEmail: typeof data.userEmail === "string" ? data.userEmail : undefined,
    });
  }
  return { staged, snapSize: runsSnap.size };
}

async function loadRunsStagedGlobalQueue(
  fetchLimit: number,
  queueCutoffMs: number,
  statusFilter: string
): Promise<{ staged: StagedQueueRow[]; snapSize: number }> {
  if (!adminDb) throw new Error("no db");
  const cap = Math.min(150, Math.max(fetchLimit * 4, 60));
  let runsSnap;
  try {
    runsSnap = await adminDb
      .collection("runs")
      .orderBy("createdAt", "desc")
      .limit(cap)
      .select(...RUN_QUEUE_FIELDS)
      .get();
  } catch (e) {
    console.warn("[governance/queue] global runs orderBy(createdAt) failed:", e);
    runsSnap = await adminDb.collection("runs").limit(cap).select(...RUN_QUEUE_FIELDS).get();
  }
  const staged: StagedQueueRow[] = [];
  for (const doc of runsSnap.docs) {
    const data = doc.data() as Record<string, unknown>;
    {
      const cs = data.consensusSummary as { overallConsensusScore?: unknown } | undefined;
      console.log("[governance/queue] Run doc fields:", {
        runId: doc.id,
        consensusScore: data.consensusScore,
        "consensusSummary.overallConsensusScore": cs?.overallConsensusScore,
        governanceStatus: data.governanceStatus,
        governanceReasons: data.governanceReasons,
        allTopLevelKeys: Object.keys(data).filter((k) => k.includes("consensus") || k.includes("score")),
      });
    }
    const createdMs = researchCreatedMs(data);
    if (!createdMs || createdMs < queueCutoffMs) continue;
    if (!filterRowForQueue(data, statusFilter, "runs")) continue;
    staged.push({
      sortKey: firestoreMillis(data.createdAt),
      kind: "research",
      docId: doc.id,
      data,
      rowUid: String(data.userId ?? ""),
      docEmail: typeof data.userEmail === "string" ? data.userEmail : undefined,
    });
  }
  return { staged, snapSize: runsSnap.size };
}

async function loadVerificationsStagedGlobalQueue(
  fetchLimit: number,
  queueCutoffMs: number,
  statusFilter: string
): Promise<{ staged: StagedQueueRow[]; docsRead: number; perOwnerLimit: number }> {
  if (!adminDb) throw new Error("no db");
  const cap = Math.min(150, Math.max(fetchLimit * 4, 60));
  let verSnap;
  try {
    verSnap = await adminDb
      .collection("verifications")
      .orderBy("timestamp", "desc")
      .limit(cap)
      .select(...VER_QUEUE_FIELDS)
      .get();
  } catch (e1) {
    try {
      console.warn("[governance/queue] global verifications orderBy(timestamp) failed, trying createdAt:", e1);
      verSnap = await adminDb
        .collection("verifications")
        .orderBy("createdAt", "desc")
        .limit(cap)
        .select(...VER_QUEUE_FIELDS)
        .get();
    } catch (e2) {
      console.warn("[governance/queue] global verifications orderBy(createdAt) failed:", e2);
      verSnap = await adminDb.collection("verifications").limit(cap).select(...VER_QUEUE_FIELDS).get();
    }
  }
  const staged: StagedQueueRow[] = [];
  for (const doc of verSnap.docs) {
    const data = doc.data() as Record<string, unknown>;
    if (!isClaimVerificationRow(data)) continue;
    const rowUid = ownerUidFromVerificationDoc(data);
    if (!rowUid) continue;
    const vMs = verificationTimeMs(data);
    if (!vMs || vMs < queueCutoffMs) continue;
    if (!filterRowForQueue(data, statusFilter, "verifications")) continue;
    const sortKey =
      firestoreMillis(data.timestamp) || firestoreMillis(data.createdAt) || firestoreMillis(data.verifiedAt);
    staged.push({
      sortKey,
      kind: "verification",
      docId: doc.id,
      data,
      rowUid,
      docEmail: typeof data.userEmail === "string" ? data.userEmail : undefined,
    });
  }
  return { staged, docsRead: verSnap.size, perOwnerLimit: cap };
}

async function loadVerificationsStagedForQueue(
  visibleUserIds: string[],
  visibleSet: Set<string>,
  fetchLimit: number,
  queueCutoffMs: number,
  statusFilter: string
): Promise<{ staged: StagedQueueRow[]; docsRead: number; perOwnerLimit: number }> {
  const { docs: verDocs, perOwnerLimit } = await fetchVerificationDocsForOwners(visibleUserIds, fetchLimit);
  const staged: StagedQueueRow[] = [];
  for (const doc of verDocs) {
    const data = doc.data() as Record<string, unknown>;
    if (!isClaimVerificationRow(data)) continue;
    const rowUid = ownerUidFromVerificationDoc(data);
    if (!rowUid || !visibleSet.has(rowUid)) continue;
    const vMs = verificationTimeMs(data);
    if (!vMs || vMs < queueCutoffMs) continue;
    if (!filterRowForQueue(data, statusFilter, "verifications")) continue;
    const sortKey =
      firestoreMillis(data.timestamp) || firestoreMillis(data.createdAt) || firestoreMillis(data.verifiedAt);
    staged.push({
      sortKey,
      kind: "verification",
      docId: doc.id,
      data,
      rowUid,
      docEmail: typeof data.userEmail === "string" ? data.userEmail : undefined,
    });
  }
  return { staged, docsRead: verDocs.length, perOwnerLimit };
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

  const email = resolved.email;
  console.log(
    `[governance] isAdminEmail check: email="${email ?? ""}", result=${isAdminEmail(email)}, adminList=${governanceAdminEmailsForLog()}`
  );

  const { searchParams } = request.nextUrl;
  const limitRawEarly = parseInt(searchParams.get("limit") ?? "15", 10);
  const limitEarly = Number.isFinite(limitRawEarly) ? Math.min(50, Math.max(1, limitRawEarly)) : 15;
  const offsetRawEarly = parseInt(searchParams.get("offset") ?? "0", 10);
  const offsetEarly = Number.isFinite(offsetRawEarly) && offsetRawEarly >= 0 ? offsetRawEarly : 0;

  const tVis0 = Date.now();
  const vis = await resolveGovernanceVisibleUserIdsCached(resolved.uid, resolved.email);
  console.log(`[governance/queue] Visibility: ${Date.now() - tVis0}ms`);
  if (!vis.ok) {
    if (vis.kind === "plan_required") {
      return governanceQueuePlanForbiddenResponse();
    }
    return NextResponse.json(
      { ok: false, error: { code: "internal_error", message: "Database unavailable" } },
      { status: 500 }
    );
  }

  let { visibleUserIds, queueScope } = vis;

  if (visibleUserIds !== null) {
    const self = resolved.uid.trim();
    visibleUserIds = [...new Set(visibleUserIds.map((id) => id.trim()).filter((id) => id && id !== self))];
    console.log(
      `[governance/queue] Reviewer ${resolved.uid}: showing runs from [${visibleUserIds.join(", ")}], excluding own runs`
    );
  }

  if (visibleUserIds !== null && visibleUserIds.length === 0) {
    return NextResponse.json({
      ok: true,
      runs: [],
      total: 0,
      offset: offsetEarly,
      limit: limitEarly,
      queueScope,
    });
  }

  if (visibleUserIds === null) {
    console.log("[governance/queue] Admin: global queue (recent runs + verifications)");
  } else {
    console.log(
      `[governance/queue] Querying for userIds: ${visibleUserIds.join(", ")} (${visibleUserIds.length} users)`
    );
  }

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

  const fetchLimit = Math.min(50, Math.max(25, offset + limit * 2));

  const ownerProfileCache = new Map<string, OwnerProfileCacheEntry>();
  const merged: Array<{ sortKey: number; summary: RunSummary }> = [];
  const queueCutoffMs = Date.now() - QUEUE_LOOKBACK_MS;
  const visibleSet = visibleUserIds === null ? new Set<string>() : new Set(visibleUserIds.filter(Boolean));

  try {
    let runsSnapSize = 0;
    let verSnapSize = 0;

    const tFs0 = Date.now();
    const staged: StagedQueueRow[] = [];

    try {
      if (visibleUserIds === null) {
        if (runType === "all") {
          const [rRes, vRes] = await Promise.all([
            loadRunsStagedGlobalQueue(fetchLimit, queueCutoffMs, statusFilter),
            loadVerificationsStagedGlobalQueue(fetchLimit, queueCutoffMs, statusFilter),
          ]);
          runsSnapSize = rRes.snapSize;
          verSnapSize = vRes.docsRead;
          staged.push(...rRes.staged, ...vRes.staged);
        } else if (runType === "research") {
          const rRes = await loadRunsStagedGlobalQueue(fetchLimit, queueCutoffMs, statusFilter);
          runsSnapSize = rRes.snapSize;
          staged.push(...rRes.staged);
        } else {
          const vRes = await loadVerificationsStagedGlobalQueue(fetchLimit, queueCutoffMs, statusFilter);
          verSnapSize = vRes.docsRead;
          staged.push(...vRes.staged);
        }
      } else if (runType === "all") {
        const [rRes, vRes] = await Promise.all([
          loadRunsStagedForQueue(visibleUserIds, visibleSet, fetchLimit, queueCutoffMs, statusFilter),
          loadVerificationsStagedForQueue(visibleUserIds, visibleSet, fetchLimit, queueCutoffMs, statusFilter),
        ]);
        runsSnapSize = rRes.snapSize;
        verSnapSize = vRes.docsRead;
        staged.push(...rRes.staged, ...vRes.staged);
        if (process.env.NODE_ENV !== "production") {
          console.log(`[governance/queue] Verifications perOwner cap used (parallel branch)`, {
            perOwnerLimit: vRes.perOwnerLimit,
            docsRead: vRes.docsRead,
          });
        }
      } else if (runType === "research") {
        const rRes = await loadRunsStagedForQueue(
          visibleUserIds,
          visibleSet,
          fetchLimit,
          queueCutoffMs,
          statusFilter
        );
        runsSnapSize = rRes.snapSize;
        staged.push(...rRes.staged);
      } else {
        const vRes = await loadVerificationsStagedForQueue(
          visibleUserIds,
          visibleSet,
          fetchLimit,
          queueCutoffMs,
          statusFilter
        );
        verSnapSize = vRes.docsRead;
        staged.push(...vRes.staged);
        if (process.env.NODE_ENV !== "production") {
          console.log(`[governance/queue] Verifications perOwner cap`, {
            perOwnerLimit: vRes.perOwnerLimit,
            docsRead: vRes.docsRead,
          });
        }
      }
    } catch (err: unknown) {
      logFirestoreError("runs_or_verifications", err);
      if (isFirestoreIndexError(err)) {
        return indexRequiredResponse();
      }
      return NextResponse.json(
        { ok: false, error: { code: "query_failed", message: "Failed to load governance queue." } },
        { status: 500 }
      );
    }
    console.log(`[governance/queue] Firestore: ${Date.now() - tFs0}ms`);

    const tProc0 = Date.now();
    await prefetchOwnerProfilesForQueue(
      staged.map((s) => s.rowUid),
      ownerProfileCache
    );
    for (const s of staged) {
      const { email: rowEmail, ownerAssignedReviewerAt } = resolveQueueOwnerContextSync(
        s.rowUid,
        s.docEmail,
        resolved.uid,
        ownerProfileCache
      );
      const summary =
        s.kind === "research"
          ? summarizeResearch(s.docId, s.data, rowEmail)
          : summarizeVerification(s.docId, s.data, rowEmail);
      if (ownerAssignedReviewerAt) summary.ownerAssignedReviewerAt = ownerAssignedReviewerAt;
      merged.push({ sortKey: s.sortKey, summary });
    }
    console.log(`[governance/queue] Processing: ${Date.now() - tProc0}ms`);

    merged.sort((a, b) => b.sortKey - a.sortKey);

    // Final safety: never return the current user's own runs in the review queue
    const filteredMerged = merged.filter((m) => m.summary.userId !== resolved.uid);

    const total = filteredMerged.length;
    const runs = filteredMerged.slice(offset, offset + limit).map((m) => m.summary);

    console.log(
      `[governance/queue] Firestore: ${runsSnapSize} research docs, ${verSnapSize} verification docs read; ` +
        `${filteredMerged.length} rows after 7d + status filters ` +
        (visibleUserIds === null
          ? "(global admin; viewer's own runs excluded)"
          : `for userIds: ${visibleUserIds.join(", ")}`) +
        ` (cutoff ${new Date(queueCutoffMs).toISOString()})`
    );
    console.log(`[governance/queue] Total: ${Date.now() - t0}ms`);

    return NextResponse.json({
      ok: true,
      runs,
      total,
      offset,
      limit,
      queueScope,
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
