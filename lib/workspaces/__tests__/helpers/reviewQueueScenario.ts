/**
 * Order B, Stage B2 — combined Approval Queue scenarios, written once and run against BOTH the transactional fake
 * (CI) and the real Firestore emulator (reportReviewQueue.emulator.spec.ts) for real query/cursor semantics.
 *
 * The dataset deliberately includes: governed and report-review runs in every status; identical sort values (ties
 * resolved by document id); rows the scan must DROP after fetching (malformed governed record, a run carrying both
 * records, a malformed report review); another Workspace's runs; and a report review assigned to its own submitter.
 *
 * `expected…` functions are an independent reference implementation (plain filtering and sorting of the seed), never
 * the code under test.
 */
import { Timestamp } from "firebase-admin/firestore";
import { computeMembershipId } from "@/lib/workspaces/membershipId";
import { buildReportReviewRecord } from "@/lib/governance/reportReview";

export const W = "wsQueue";
export const W2 = "wsQueueOther";
export const OWNER = "q-owner";
export const REVIEWER = "q-reviewer";
export const SUBMITTER = "q-submitter";
export const CREATOR = "q-creator";

export interface MinimalDb {
  collection(name: string): { doc(id: string): { set(data: Record<string, unknown>): Promise<unknown>; update(data: Record<string, unknown>): Promise<unknown>; collection(n: string): { doc(id: string): { set(data: Record<string, unknown>): Promise<unknown> } } } };
}

type Kind = "gov" | "rr";
export interface SeedRun {
  id: string;
  kind: Kind;
  status: string;
  createdAt: Timestamp;
  reviewedAt: string | null;
  workspaceId: string;
  eligible: boolean; // false for rows the scan must drop
  assignedTo: string | null;
}

const STATUSES = ["unreviewed", "pending", "changes_requested", "approved", "approved_with_conditions", "rejected"];
const DECIDED = new Set(["changes_requested", "approved", "approved_with_conditions", "rejected"]);

function govRecord(status: string, reviewedAt: string | null) {
  return {
    version: 1,
    schemaId: "decision_support",
    answerShape: "decision_support_view",
    adaptiveOutputVersion: 1,
    humanReview: { status, ...(reviewedAt ? { reviewedAt, reviewerId: REVIEWER } : {}), ...(status === "approved_with_conditions" ? { conditions: ["c"] } : {}) },
    decisionReceipt: { conclusion: "x", basis: [], assumptions: [], uncertainties: [], limitations: [], sources: [], sourceBacked: true, humanReviewNeeded: false },
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}
function rrRecord(status: string, reviewedAt: string | null) {
  const base = buildReportReviewRecord({
    cycle: 1,
    scope: { schemaId: "generic", unifiedAnswer: "absent", synthesis: "absent", consensus: "absent", respondedModels: 2, requestedModels: 3 },
    purpose: { code: "internal_review", note: null },
    actorUid: SUBMITTER,
    now: "2026-11-02T09:00:00.000Z",
  });
  return { ...base, humanReview: { status, ...(reviewedAt ? { reviewedAt, reviewerId: REVIEWER } : {}), ...(status === "approved_with_conditions" ? { conditions: ["c"] } : {}) } };
}

/** Deterministic seed. Sort values repeat on purpose (every third createdAt / reviewedAt is shared). */
export function buildSeed(): SeedRun[] {
  const runs: SeedRun[] = [];
  let n = 0;
  for (const kind of ["gov", "rr"] as Kind[]) {
    for (let rep = 0; rep < 3; rep++) {
      for (const status of STATUSES) {
        n++;
        const tick = Math.floor(n / 3); // ties
        runs.push({
          id: `${kind}-${String(n).padStart(3, "0")}`,
          kind,
          status,
          createdAt: Timestamp.fromMillis(Date.UTC(2026, 9, 1) + tick * 60_000),
          reviewedAt: DECIDED.has(status) ? new Date(Date.UTC(2026, 9, 10) + tick * 60_000).toISOString() : null,
          workspaceId: W,
          eligible: true,
          assignedTo: rep === 0 ? REVIEWER : rep === 1 && kind === "rr" ? SUBMITTER : null,
        });
      }
    }
  }
  // Rows the scan must drop after fetching.
  runs.push({ id: "bad-gov", kind: "gov", status: "unreviewed", createdAt: Timestamp.fromMillis(Date.UTC(2026, 9, 1) + 5 * 60_000), reviewedAt: null, workspaceId: W, eligible: false, assignedTo: REVIEWER });
  runs.push({ id: "bad-both", kind: "rr", status: "unreviewed", createdAt: Timestamp.fromMillis(Date.UTC(2026, 9, 1) + 6 * 60_000), reviewedAt: null, workspaceId: W, eligible: false, assignedTo: REVIEWER });
  runs.push({ id: "bad-rr", kind: "rr", status: "pending", createdAt: Timestamp.fromMillis(Date.UTC(2026, 9, 1) + 7 * 60_000), reviewedAt: null, workspaceId: W, eligible: false, assignedTo: REVIEWER });
  // Another Workspace: never listed.
  for (const status of STATUSES) runs.push({ id: `other-${status}`, kind: "rr", status, createdAt: Timestamp.fromMillis(Date.UTC(2026, 9, 1)), reviewedAt: DECIDED.has(status) ? "2026-10-10T00:00:00.000Z" : null, workspaceId: W2, eligible: false, assignedTo: REVIEWER });
  return runs;
}

export async function seedDb(db: MinimalDb, runs: SeedRun[]): Promise<void> {
  const NOW = Timestamp.fromMillis(Date.UTC(2026, 9, 1));
  for (const ws of [W, W2]) await db.collection("workspaces").doc(ws).set({ schemaVersion: 1, id: ws, type: "team", name: "Q", ownerUserId: OWNER, createdByUserId: OWNER, createdAt: NOW, updatedAt: NOW });
  for (const [ws, uid, role] of [
    [W, OWNER, "owner"],
    [W, REVIEWER, "reviewer"],
    [W, SUBMITTER, "member"],
    [W, CREATOR, "member"],
    [W2, OWNER, "owner"],
    [W2, REVIEWER, "reviewer"],
  ] as const) {
    const id = computeMembershipId(ws, uid);
    await db.collection("workspaceMemberships").doc(id).set({ schemaVersion: 1, id, workspaceId: ws, uid, role, status: "active", createdAt: NOW, updatedAt: NOW, invitedByUserId: null, removedAt: null, removedByUserId: null });
  }
  for (const r of runs) {
    const doc: Record<string, unknown> = { userId: CREATOR, workspaceId: r.workspaceId, projectId: null, question: `Q ${r.id}`, status: "complete", createdAt: r.createdAt };
    if (r.id === "bad-gov") doc.governanceRecord = { version: 1, humanReview: { status: "unreviewed" } }; // malformed governed record
    else if (r.id === "bad-both") {
      doc.reportReview = rrRecord("unreviewed", null);
      doc.governanceRecord = govRecord("unreviewed", null);
    } else if (r.id === "bad-rr") doc.reportReview = { version: 1, kind: "report_review", humanReview: { status: "pending" } }; // malformed
    else if (r.kind === "gov") doc.governanceRecord = govRecord(r.status, r.reviewedAt);
    else doc.reportReview = rrRecord(r.status, r.reviewedAt);
    await db.collection("runs").doc(r.id).set(doc);
    if (r.assignedTo) {
      await db
        .collection("runs")
        .doc(r.id)
        .collection("humanReviewAssignment")
        .doc("current")
        .set({ schemaVersion: 1, teamId: null, runId: r.id, assignedReviewerUserId: r.assignedTo, assignedAt: `2026-10-0${1 + (r.createdAt.seconds % 8)}T00:00:00.000Z`, assignedByUserId: OWNER, updatedAt: "x", updatedByUserId: OWNER, revision: 1, workspaceId: r.workspaceId, projectId: null, dueAt: null });
    }
  }
}

const VIEW_STATUSES: Record<string, string[]> = { needs_review: ["unreviewed", "pending"], changes_requested: ["changes_requested"], recently_approved: ["approved", "approved_with_conditions"] };

function cmpBytes(a: string, b: string) {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

/** Reference: eligible rows of a status view in queue order (sort value desc, then id desc). */
export function expectedStatusView(runs: SeedRun[], view: "needs_review" | "changes_requested" | "recently_approved"): string[] {
  const rows = runs.filter((r) => r.eligible && r.workspaceId === W && VIEW_STATUSES[view].includes(r.status));
  rows.sort((a, b) => {
    const c = view === "needs_review" ? b.createdAt.seconds - a.createdAt.seconds || b.createdAt.nanoseconds - a.createdAt.nanoseconds : cmpBytes(b.reviewedAt!, a.reviewedAt!);
    return c !== 0 ? c : cmpBytes(b.id, a.id);
  });
  return rows.map((r) => r.id);
}

/** Reference: the reviewer's actionable assigned items (reviewable status; the submitter never). */
export function expectedAssignedToMe(runs: SeedRun[], uid: string): string[] {
  return runs
    .filter((r) => r.eligible && r.workspaceId === W && r.assignedTo === uid && ["unreviewed", "pending"].includes(r.status) && !(r.kind === "rr" && uid === SUBMITTER))
    .map((r) => r.id)
    .sort();
}

export type QueueFn = (args: { view: string; uid: string; role: string; limit: number; cursor: string | null }) => Promise<{ items: { runId: string; recordKind?: string; isAssignedToMe: boolean; assignment: { state: string } }[]; hasMore: boolean; nextCursor?: string }>;

/** Pages a view to the end. Throws on any duplicate. */
export async function pageAll(queue: QueueFn, view: string, uid: string, role: string, limit: number, between?: (page: number) => Promise<void>) {
  const seen: string[] = [];
  const rows: { runId: string; recordKind?: string; isAssignedToMe: boolean; assignment: { state: string } }[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 500; page++) {
    const r = await queue({ view, uid, role, limit, cursor });
    for (const it of r.items) {
      if (seen.includes(it.runId)) throw new Error(`duplicate ${it.runId} on page ${page} (limit ${limit}, view ${view})`);
      seen.push(it.runId);
      rows.push(it);
    }
    if (!r.hasMore) return { ids: seen, rows };
    if (!r.nextCursor) throw new Error("hasMore without a cursor");
    cursor = r.nextCursor;
    if (between) await between(page);
  }
  throw new Error("pager did not terminate");
}
