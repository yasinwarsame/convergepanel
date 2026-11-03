/**
 * Order B, Stage B3 — browser client for the Team research page's Report Review panel.
 *
 * Every call goes to the report-review routes, which re-authorize everything server-side; nothing here is a decision of
 * authority. The context response is parsed strictly: an unexpected shape is treated as an error, never rendered.
 */
import type { User } from "firebase/auth";
import { authedFetch } from "./authedFetch";

export type ReportReviewViewerDenial = string | null;

export interface ReportReviewClientRecord {
  cycle: number;
  purpose: { code: string; note: string | null };
  scope: { schemaId: string | null; unifiedAnswer: "present" | "absent"; synthesis: "present" | "absent"; consensus: "present" | "absent"; respondedModels: number; requestedModels: number };
  humanReview: { status: string; reviewerId?: string; reviewedAt?: string; comment?: string; conditions?: string[] };
  submittedAt: string;
  submittedByUserId: string;
  updatedAt: string;
}

export interface ReportReviewClientAssignmentInfo {
  assignedReviewerUserId: string;
  assignedReviewerDisplayName: string;
  revision: number;
  assignedAt: string | null;
  updatedAt: string;
  dueAt: string | null;
  state: "actionable" | "stale";
}

export interface ReportReviewClientHistoryItem {
  type: "report_review_submitted" | "report_review_resubmitted" | "report_review_assignment_changed" | "report_review_decided";
  at: string;
  actorDisplayName: string;
  cycle: number;
  status?: string;
  purposeCode?: string;
  previousReviewerDisplayName?: string | null;
  reviewerDisplayName?: string | null;
  closedReason?: "decided" | "content_changed" | "content_unverifiable";
}

export interface ReportReviewClientCycle {
  cycle: number;
  status: string;
  reviewerId: string | null;
  reviewedAt: string | null;
  purposeCode: string;
  assignedReviewerUserId: string | null;
}

export type ReportReviewContext =
  | {
      state: "submitted";
      record: ReportReviewClientRecord;
      previousCycles: ReportReviewClientCycle[];
      assignment: { revision: number; info: ReportReviewClientAssignmentInfo | null };
      viewer: { canDecide: boolean; denial: ReportReviewViewerDenial; canResubmit: boolean; canManageAssignment: boolean };
      names: Record<string, string>;
      history: ReportReviewClientHistoryItem[];
      content: { absentNow: string[]; changedSinceSubmission: string[] };
      historyIncomplete: boolean;
      contentIntegrity: { status: "matches" | "changed" | "unverifiable" };
      disclaimer: string;
    }
  | { state: "not_submitted"; eligibility: { eligible: true } | { eligible: false; reason: string }; viewer: { canSubmit: boolean }; disclaimer: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v);

/** Strict structural parse of `GET …/report-review`. Returns null on any mismatch (callers show the error state). */
export function parseReportReviewContextResponse(json: unknown): ReportReviewContext | null {
  if (!isObj(json) || json.ok !== true || !isStr(json.disclaimer)) return null;
  const viewer = json.viewer;
  if (!isObj(viewer)) return null;
  if (json.state === "not_submitted") {
    const e = json.eligibility;
    if (!isObj(e) || typeof e.eligible !== "boolean") return null;
    if (e.eligible === false && !isStr(e.reason)) return null;
    if (typeof viewer.canSubmit !== "boolean") return null;
    return { state: "not_submitted", eligibility: e.eligible ? { eligible: true } : { eligible: false, reason: e.reason as string }, viewer: { canSubmit: viewer.canSubmit }, disclaimer: json.disclaimer };
  }
  const r = json.record;
  if (!isObj(r) || !isInt(r.cycle) || !isObj(r.purpose) || !isStr(r.purpose.code) || !isObj(r.scope) || !isObj(r.humanReview) || !isStr(r.humanReview.status)) return null;
  if (!isStr(r.submittedAt) || !isStr(r.submittedByUserId) || !isStr(r.updatedAt)) return null;
  if (!Array.isArray(json.previousCycles) || !Array.isArray(json.history) || !isObj(json.names) || !isObj(json.assignment)) return null;
  if (typeof viewer.canDecide !== "boolean" || typeof viewer.canResubmit !== "boolean" || typeof viewer.canManageAssignment !== "boolean") return null;
  const a = json.assignment;
  if (!isInt(a.revision)) return null;
  const info = a.info;
  if (info !== null && !(isObj(info) && isStr(info.assignedReviewerUserId) && isStr(info.assignedReviewerDisplayName) && isInt(info.revision) && isStr(info.updatedAt) && (info.state === "actionable" || info.state === "stale"))) return null;
  for (const h of json.history) if (!isObj(h) || !isStr(h.type) || !isStr(h.at) || !isStr(h.actorDisplayName) || !isInt(h.cycle)) return null;
  for (const c of json.previousCycles) if (!isObj(c) || !isInt(c.cycle) || !isStr(c.status) || !isStr(c.purposeCode)) return null;
  for (const v of Object.values(json.names)) if (!isStr(v)) return null;
  const content = json.content;
  const strArr = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);
  if (!isObj(content) || !strArr(content.absentNow) || !strArr(content.changedSinceSubmission) || typeof json.historyIncomplete !== "boolean") return null;
  const integrity = json.contentIntegrity;
  if (!isObj(integrity) || !(integrity.status === "matches" || integrity.status === "changed" || integrity.status === "unverifiable")) return null;
  return {
    state: "submitted",
    record: r as unknown as ReportReviewClientRecord,
    previousCycles: json.previousCycles as ReportReviewClientCycle[],
    assignment: { revision: a.revision, info: info as ReportReviewClientAssignmentInfo | null },
    viewer: { canDecide: viewer.canDecide, denial: isStr(viewer.denial) ? viewer.denial : null, canResubmit: viewer.canResubmit, canManageAssignment: viewer.canManageAssignment },
    names: json.names as Record<string, string>,
    history: json.history as ReportReviewClientHistoryItem[],
    content: { absentNow: content.absentNow as string[], changedSinceSubmission: content.changedSinceSubmission as string[] },
    historyIncomplete: json.historyIncomplete,
    contentIntegrity: { status: integrity.status },
    disclaimer: json.disclaimer,
  };
}

function base(workspaceId: string, runId: string): string {
  return `/api/workspaces/${encodeURIComponent(workspaceId)}/runs/${encodeURIComponent(runId)}/report-review`;
}

export type FetchReportReviewContextResult = { status: "ok"; context: ReportReviewContext } | { status: "not_found" } | { status: "error" };

export async function fetchReportReviewContext(args: { workspaceId: string; runId: string; user: User | null; authReady: boolean; signal?: AbortSignal }): Promise<FetchReportReviewContextResult> {
  try {
    const res = await authedFetch(base(args.workspaceId, args.runId), { user: args.user, authReady: args.authReady, method: "GET", cache: "no-store", signal: args.signal });
    if (res.status === 401 || res.status === 403 || res.status === 404) return { status: "not_found" };
    if (!res.ok) return { status: "error" };
    const parsed = parseReportReviewContextResponse(await res.json().catch(() => null));
    return parsed ? { status: "ok", context: parsed } : { status: "error" };
  } catch {
    return { status: "error" };
  }
}

/** Outcome of a report-review mutation. `message` is the server's own user-facing sentence when it sent one. */
export type ReportReviewMutationResult = { status: "ok" } | { status: "conflict"; message: string | null } | { status: "rejected"; message: string | null } | { status: "not_found" } | { status: "error" };

async function post(url: string, args: { user: User | null; authReady: boolean; body: unknown }): Promise<ReportReviewMutationResult> {
  try {
    const res = await authedFetch(url, { user: args.user, authReady: args.authReady, method: "POST", body: JSON.stringify(args.body), cache: "no-store" });
    if (res.ok) return { status: "ok" };
    if (res.status === 401 || res.status === 404) return { status: "not_found" };
    const json = await res.json().catch(() => null);
    const message = isObj(json) && isStr(json.message) ? json.message : null;
    if (res.status === 409) return { status: "conflict", message };
    if (res.status === 400 || res.status === 403) return { status: "rejected", message };
    return { status: "error" };
  } catch {
    return { status: "error" };
  }
}

export function submitReportReviewRequest(args: { workspaceId: string; runId: string; user: User | null; authReady: boolean; purpose: { code: string; note?: string } }) {
  return post(base(args.workspaceId, args.runId), { user: args.user, authReady: args.authReady, body: { purpose: args.purpose } });
}

export function resubmitReportReviewRequest(args: { workspaceId: string; runId: string; user: User | null; authReady: boolean; purpose: { code: string; note?: string }; expectedCycle: number }) {
  return post(`${base(args.workspaceId, args.runId)}/resubmit`, { user: args.user, authReady: args.authReady, body: { purpose: args.purpose, expectedCycle: args.expectedCycle } });
}

export function decideReportReviewRequest(args: {
  workspaceId: string;
  runId: string;
  user: User | null;
  authReady: boolean;
  decision: { status: string; comment?: string; conditions?: string[] };
  expectedCycle: number;
  expectedUpdatedAt: string;
}) {
  return post(`${base(args.workspaceId, args.runId)}/decision`, { user: args.user, authReady: args.authReady, body: { decision: args.decision, expectedCycle: args.expectedCycle, expectedUpdatedAt: args.expectedUpdatedAt } });
}

export type ReportReviewExportFormat = "json" | "html";

/** Downloads the report-review record export (the server authorizes and builds it; the browser only saves the bytes). */
export async function downloadReportReviewExport(args: { workspaceId: string; runId: string; user: User | null; authReady: boolean; format: ReportReviewExportFormat }): Promise<{ status: "ok"; blob: Blob; filename: string } | { status: "not_found" } | { status: "error" }> {
  try {
    const res = await authedFetch(`${base(args.workspaceId, args.runId)}/export?format=${args.format}`, { user: args.user, authReady: args.authReady, method: "GET", cache: "no-store" });
    if (res.status === 401 || res.status === 403 || res.status === 404) return { status: "not_found" };
    if (!res.ok) return { status: "error" };
    const disposition = res.headers.get("content-disposition") ?? "";
    const match = /filename="([^"]+)"/.exec(disposition);
    return { status: "ok", blob: await res.blob(), filename: match ? match[1] : `report-review.${args.format}` };
  } catch {
    return { status: "error" };
  }
}
