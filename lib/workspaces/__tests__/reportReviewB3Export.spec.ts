/**
 * Order B, Stage B3 — the Report Review record export (owner B3 §3): authorization, exact saved content, no fabricated
 * analysis, withheld reviewer identity/comment, HTML escaping, historical-cycle integrity, and backward compatibility
 * (the frozen governed exports are untouched — pinned separately by the Order 6 boundary suites, which still pass).
 * Also: the queue route's controlled missing-index failure.
 */
import { Timestamp } from "firebase-admin/firestore";
import { FakeTransactionalFirestore } from "./helpers/fakeTransactionalFirestore";

const db = new FakeTransactionalFirestore();
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return db;
  },
}));
const flags = { REPORT_REVIEW_ENABLED: true };
jest.mock("@/lib/workspaces/reportReviewRollout", () => ({
  get REPORT_REVIEW_ENABLED() {
    return flags.REPORT_REVIEW_ENABLED;
  },
}));
jest.mock("@/lib/env", () => ({ ...jest.requireActual("@/lib/env"), TEAM_WORKSPACES_ENABLED: true, TEAM_WORKSPACES_CANARY_UIDS: undefined, TEAM_WORKSPACES_CANARY_WORKSPACE_IDS: undefined, APPROVAL_WORKFLOW_ENABLED: true }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const identity = { uid: "" };
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({ resolveRequestIdentity: async () => (identity.uid ? { status: "authenticated", uid: identity.uid, source: "session_cookie" } : { status: "unauthenticated", reason: "missing_credentials" }) }));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));
jest.mock("@/lib/workspaces/approvalWorkflowRollout", () => ({ resolveApprovalWorkflowAdmission: () => ({ admitted: true }) }));
const queueResult: { value: unknown } = { value: null };
jest.mock("@/lib/workspaces/reviewQueue", () => ({ ...jest.requireActual("@/lib/workspaces/reviewQueue"), getReviewQueue: async () => queueResult.value }));

import { NextRequest } from "next/server";
import { GET as exportGet } from "@/app/api/workspaces/[workspaceId]/runs/[runId]/report-review/export/route";
import { GET as queueGet } from "@/app/api/workspaces/[workspaceId]/review-queue/route";
import { submitReportReview, resubmitReportReview } from "@/lib/workspaces/reportReviewMutations";
import { decideReportReview } from "@/lib/workspaces/reportReviewDecisionMutation";
import { putWorkspaceReviewAssignment } from "@/lib/workspaces/workspaceReviewMutations";
import { computeMembershipId } from "@/lib/workspaces/membershipId";
import { buildReportReviewExport, checkArchivedCycles, escapeHtml, renderReportReviewExportHtml, type ReportReviewExportV1 } from "@/lib/workspaces/reportReviewExport";
import { REPORT_REVIEW_DISCLAIMER } from "@/lib/governance/reportReviewCopy";
import type { ReportReviewRecordV1 } from "@/lib/governance/reportReview";

const W = "wsB3e";
const W2 = "wsB3other";
const OWNER = "uid-owner";
const ADMIN = "uid-admin";
const MEMBER = "uid-member";
const REVIEWER = "uid-reviewer";
const VIEWER = "uid-viewer";
const CREATOR = "uid-creator";
const NOW = Timestamp.fromDate(new Date("2026-11-02T10:00:00Z"));
const RUN = "runB3e";
const LEGACY = { version: 1, schemaId: "generic", classification: { queryType: "generic" }, generatedAt: "2026-11-02T09:59:00.000Z", results: [], alignedClaims: [] };
const XSS = `<script>alert("x")</script>&'`;
const RESPONSE_TEXT = `Line one\n<img src=x onerror=alert(1)> & "quoted"`;

function membership(ws: string, uid: string, role: string) {
  const id = computeMembershipId(ws, uid);
  db.seed(`workspaceMemberships/${id}`, { schemaVersion: 1, id, workspaceId: ws, uid, role, status: "active", createdAt: NOW, updatedAt: NOW, invitedByUserId: null, removedAt: null, removedByUserId: null });
}

beforeEach(() => {
  db.docs.clear();
  db.hooks = {};
  flags.REPORT_REVIEW_ENABLED = true;
  identity.uid = OWNER;
  for (const ws of [W, W2]) db.seed(`workspaces/${ws}`, { schemaVersion: 1, id: ws, type: "team", name: "T", ownerUserId: OWNER, createdByUserId: OWNER, createdAt: NOW, updatedAt: NOW });
  membership(W, OWNER, "owner");
  membership(W, ADMIN, "admin");
  membership(W, MEMBER, "member");
  membership(W, REVIEWER, "reviewer");
  membership(W, VIEWER, "viewer");
  membership(W, CREATOR, "member");
  membership(W2, "uid-other", "owner");
  db.seed(`runs/${RUN}`, {
    userId: CREATOR,
    workspaceId: W,
    projectId: null,
    question: `Supply plan ${XSS}`,
    selectedModels: ["chatgpt", "claude"],
    status: "complete",
    createdAt: NOW,
    runDocument: { perModel: [{ modelId: "chatgpt", status: "ok", rawTextTruncated: RESPONSE_TEXT, wasTruncated: false }, { modelId: "claude", status: "error", rawTextTruncated: "", wasTruncated: false }] },
    legacyAdaptiveOutput: LEGACY,
  });
});

const rr = () => db.read(`runs/${RUN}`)!.reportReview as ReportReviewRecordV1;
async function lifecycle() {
  await submitReportReview({ uid: MEMBER, workspaceId: W, runId: RUN, purpose: { code: "client_delivery", note: `For ${XSS}` }, now: "2026-11-02T11:00:00.000Z" });
  await putWorkspaceReviewAssignment({ uid: ADMIN, workspaceId: W, runId: RUN, assignedReviewerUserId: REVIEWER, expectedRevision: 0, dueAt: null, now: "2026-11-02T11:01:00.000Z" });
  await decideReportReview({ uid: REVIEWER, workspaceId: W, runId: RUN, decision: { status: "changes_requested", comment: "PRIVATE-REVIEWER-COMMENT" }, expectedCycle: 1, expectedUpdatedAt: rr().updatedAt, now: "2026-11-02T12:00:00.000Z" });
  await resubmitReportReview({ uid: MEMBER, workspaceId: W, runId: RUN, purpose: { code: "publication_review" }, expectedCycle: 1, now: "2026-11-02T13:00:00.000Z" });
  await putWorkspaceReviewAssignment({ uid: ADMIN, workspaceId: W, runId: RUN, assignedReviewerUserId: REVIEWER, expectedRevision: 2, dueAt: null, now: "2026-11-02T13:01:00.000Z" });
  await decideReportReview({ uid: REVIEWER, workspaceId: W, runId: RUN, decision: { status: "approved_with_conditions", conditions: [`Cite ${XSS}`], comment: "PRIVATE-2" }, expectedCycle: 2, expectedUpdatedAt: rr().updatedAt, now: "2026-11-02T14:00:00.000Z" });
}
const get = (format: string, runId = RUN, ws = W) => exportGet(new NextRequest(`http://localhost/api/workspaces/${ws}/runs/${runId}/report-review/export?format=${format}`), { params: { workspaceId: ws, runId } });

describe("export content", () => {
  it("JSON: exact saved content, review, full decision history, disclaimer; reviewer identity and comments withheld", async () => {
    await lifecycle();
    const res = await get("json");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toBe(`attachment; filename="report-review-${RUN}-cycle-2.json"`);
    const text = await res.text();
    const doc = JSON.parse(text) as ReportReviewExportV1;
    expect(doc.disclaimer).toBe(REPORT_REVIEW_DISCLAIMER);
    expect(doc.research.question).toBe(`Supply plan ${XSS}`);
    expect(doc.research.responses.map((r) => [(r as Record<string, unknown>).modelId, (r as Record<string, unknown>).rawText])).toEqual([
      ["chatgpt", RESPONSE_TEXT],
      ["claude", ""],
    ]);
    expect(doc.research.synthesis).toBeNull(); // none saved → none exported, never generated
    expect(doc.analysisPresence).toMatchObject({ unifiedAnswer: "absent", synthesis: "absent", consensus: "absent", respondedModels: 1, requestedModels: 2, addedSinceSubmission: [] });
    expect(doc.decisionHistory.every((c) => c.scopeAtSubmission.synthesis === "absent")).toBe(true);
    expect(doc.research.structuredResult).toMatchObject({ schemaId: "generic" });
    expect(doc.review).toEqual({
      kind: "report_review",
      currentCycle: 2,
      status: "approved_with_conditions",
      statusLabel: "Approved with conditions",
      purpose: { code: "publication_review", label: "Publication review", note: null },
      submittedAt: "2026-11-02T13:00:00.000Z",
      decidedAt: "2026-11-02T14:00:00.000Z",
      conditions: [`Cite ${XSS}`],
      reviewer: "withheld",
    });
    expect(doc.decisionHistory.map((c) => [c.cycle, c.status, c.purposeCode, c.decidedAt, c.current])).toEqual([
      [1, "changes_requested", "client_delivery", "2026-11-02T12:00:00.000Z", false],
      [2, "approved_with_conditions", "publication_review", "2026-11-02T14:00:00.000Z", true],
    ]);
    for (const secret of [REVIEWER, ADMIN, MEMBER, "PRIVATE-REVIEWER-COMMENT", "PRIVATE-2"]) expect(text).not.toContain(secret);
  });

  it("HTML: every saved value is escaped; no script and no remote resource; disclaimer present; strict CSP", async () => {
    await lifecycle();
    const res = await get("html");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; style-src 'unsafe-inline'");
    const html = await res.text();
    expect(html).toContain(REPORT_REVIEW_DISCLAIMER);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/<[a-z][^>]*\s(src|href|on[a-z]+)=/i); // no real tag loads or runs anything
    expect(html).toContain(escapeHtml(XSS));
    expect(html).toContain(escapeHtml(RESPONSE_TEXT));
    expect(html).toContain("This report does not contain a Unified Answer, a consensus summary, a synthesis; none was generated or verified.");
    expect(html).toContain("<h2>Saved structured result</h2>"); // review M-1: the saved structured report is in the printable record
    expect(html).toContain(escapeHtml(JSON.stringify(LEGACY, null, 2)));
    expect(html).not.toContain("not covered by the decision");
    expect(html).toContain("Withheld from exports");
    for (const secret of [REVIEWER, "PRIVATE-REVIEWER-COMMENT"]) expect(html).not.toContain(secret);
  });

  it("escapeHtml escapes all five significant characters", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;");
  });
});

describe("review M-2: content saved after submission is disclosed, never presented as reviewed", () => {
  it("a synthesis added after approval is flagged in JSON and HTML, and no longer described as absent", async () => {
    await lifecycle();
    db.seed(`runs/${RUN}`, { ...db.read(`runs/${RUN}`)!, synthesizedStructuredReport: { summary: "Generated later" }, schemaVersion: 1, synthesizedBy: "chatgpt" });
    const doc = (await (await get("json")).json()) as ReportReviewExportV1;
    expect(doc.analysisPresence).toMatchObject({ unifiedAnswer: "present", synthesis: "present", consensus: "absent", addedSinceSubmission: ["unifiedAnswer", "synthesis"] });
    expect(doc.analysisPresence.atSubmission).toMatchObject({ unifiedAnswer: "absent", synthesis: "absent" });
    const html = await (await get("html")).text();
    expect(html).toContain("Added after this report was submitted for review, and not covered by the decision: a Unified Answer, a synthesis.");
    expect(html).toContain("This report does not contain a consensus summary; none was generated or verified.");
    expect(html).toContain(escapeHtml(JSON.stringify({ summary: "Generated later" }, null, 2)));
    expect(html).toContain("Saved synthesis <strong>(added after this report was submitted for review — not covered by the decision)</strong>");
  });
});

describe("historical-cycle integrity", () => {
  const rec = (cycle: number) => ({ cycle, humanReview: { status: "rejected" } }) as unknown as ReportReviewRecordV1;
  it.each([
    ["contiguous", 3, [1, 2], true],
    ["gap", 3, [1], false],
    ["duplicate", 3, [1, 1], false],
    ["out-of-range", 2, [2], false],
    ["extra", 2, [1, 2], false],
  ])("%s", (_l, current, archived, ok) => {
    expect(checkArchivedCycles(rec(current), archived.map((c) => ({ cycle: c, record: rec(c) }))).ok).toBe(ok);
  });
  it("a malformed archive, or one stored under the wrong id, fails the export closed (500), never a partial history", async () => {
    await lifecycle();
    db.seed(`runs/${RUN}/reportReviewCycles/1`, { ...db.read(`runs/${RUN}/reportReviewCycles/1`)!, record: { broken: true } });
    expect((await get("json")).status).toBe(500);
  });
  it("an archive whose own cycle disagrees with its document id fails closed", async () => {
    await lifecycle();
    const a = db.read(`runs/${RUN}/reportReviewCycles/1`)!;
    db.docs.delete(`runs/${RUN}/reportReviewCycles/1`);
    db.seed(`runs/${RUN}/reportReviewCycles/7`, a);
    expect((await get("json")).status).toBe(500);
  });
});

describe("authorization (backend-authoritative)", () => {
  it("OFF: concealed 404 before anything else; signed out: 401", async () => {
    await lifecycle();
    flags.REPORT_REVIEW_ENABLED = false;
    expect((await get("json")).status).toBe(404);
    flags.REPORT_REVIEW_ENABLED = true;
    identity.uid = "";
    expect((await get("json")).status).toBe(401);
  });

  it.each([
    ["owner", OWNER, 200],
    ["admin", ADMIN, 200],
    ["member", MEMBER, 200],
    ["reviewer (no exports.create)", REVIEWER, 403],
    ["viewer", VIEWER, 403],
    ["non-member", "uid-stranger", 404],
  ])("%s → %i", async (_l, uid, status) => {
    await lifecycle();
    identity.uid = uid;
    expect((await get("json")).status).toBe(status);
  });

  it("a run in another Workspace, a run without a report review, and an unknown format are refused", async () => {
    await lifecycle();
    identity.uid = "uid-other";
    expect((await get("json", RUN, W2)).status).toBe(404);
    identity.uid = OWNER;
    db.seed("runs/plain", { ...db.read(`runs/${RUN}`)!, reportReview: undefined });
    expect((await get("json", "plain")).status).toBe(404);
    expect((await get("pdf")).status).toBe(400);
  });

  it("a run holding both records is refused (500), never exported", async () => {
    await lifecycle();
    db.seed(`runs/${RUN}`, { ...db.read(`runs/${RUN}`)!, governanceRecord: { humanReview: { status: "approved" } } });
    expect((await get("json")).status).toBe(500);
  });

  it("a run filed in another Workspace's Project is concealed (E1-S7 parity)", async () => {
    await lifecycle();
    db.seed("projects/p-foreign", { schemaVersion: 1, id: "p-foreign", workspaceId: W2, name: "X", status: "active", createdAt: NOW, updatedAt: NOW, createdByUserId: OWNER });
    db.seed(`runs/${RUN}`, { ...db.read(`runs/${RUN}`)!, projectId: "p-foreign" });
    expect((await get("json")).status).toBe(404);
  });
});

describe("builder is pure and never fabricates analysis", () => {
  it("present synthesis is carried verbatim; absent stays null", () => {
    const record = { version: 1, kind: "report_review", cycle: 1, scope: { schemaId: "generic", unifiedAnswer: "present", synthesis: "present", consensus: "absent", respondedModels: 2, requestedModels: 2 }, purpose: { code: "other", note: null }, humanReview: { status: "unreviewed" }, submittedAt: "t", submittedByUserId: "u", createdAt: "t", updatedAt: "t" } as ReportReviewRecordV1;
    const payload = { question: "Q", selectedModels: [], results: [], synthesisCache: { report: { summary: "S" }, schemaVersion: 1, synthesizedBy: "m", consensusSummary: null }, legacyAdaptive: { status: "absent", output: null } } as never;
    const doc = buildReportReviewExport({ generatedAt: "g", runId: "r", payload, record, archivedCycles: [], drift: { current: record.scope, addedSinceSubmission: [] } });
    expect(doc.research.synthesis).toEqual({ summary: "S" });
    expect(doc.research.structuredResult).toBeNull();
    expect(renderReportReviewExportHtml(doc)).toContain("This report does not contain a consensus summary; none was generated or verified.");
    expect(doc.review.decidedAt).toBeNull();
  });
});

describe("queue: missing index is an identifiable, controlled failure", () => {
  const qreq = () => queueGet(new NextRequest(`http://localhost/api/workspaces/${W}/review-queue?view=needs_review`), { params: { workspaceId: W } });
  it("index_unavailable → 503 review_queue_index_unavailable (never a partial page)", async () => {
    queueResult.value = { status: "index_unavailable" };
    const res = await qreq();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, errorCode: "review_queue_index_unavailable", message: "The approval queue is temporarily unavailable while its database index is prepared. Try again later." });
  });
  it("query_failed keeps the existing generic internal error", async () => {
    queueResult.value = { status: "query_failed" };
    const res = await qreq();
    expect(res.status).toBe(500);
  });
});
