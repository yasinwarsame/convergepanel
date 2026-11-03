/**
 * Order B, Stage B3 — the Report Review panel (owner B3 §1): explicit submission with the four purposes and a 280-character
 * note, status / reviewer / decision / cycle history, the unavailable explanation, and the fixed disclaimer wherever
 * approval is requested, recorded or viewed. Controls follow the server's verdicts; the server re-authorizes every action.
 * Also the Audit Log row, the queue row link, and the strict client parser.
 */
import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";

jest.mock("next/link", () => ({
  __esModule: true,
  default: ({ href, children, className }: Record<string, unknown>) => require("react").createElement("a", { href, className }, children as never),
}));
jest.mock("@/components/AuthProvider", () => ({ useAuth: () => ({ user: { uid: "uid-a" }, authReady: true }) }));
const mockedAuthedFetch = jest.fn();
jest.mock("@/lib/client/authedFetch", () => ({ authedFetch: (...a: unknown[]) => mockedAuthedFetch(...a) }));
const cardProps: Record<string, unknown>[] = [];
jest.mock("@/components/workspace/ReviewAssignmentCard", () => ({
  __esModule: true,
  default: (props: Record<string, unknown>) => {
    cardProps.push(props);
    return require("react").createElement("div", { "data-testid": "assignment-card" });
  },
}));

import ReportReviewPanel from "@/components/workspace/projects/ReportReviewPanel";
import ReportReviewAuditEntry from "@/components/workspace/ReportReviewAuditEntry";
import ReviewQueueRow from "@/components/workspace/ReviewQueueRow";
import { parseReportReviewContextResponse } from "@/lib/client/reportReviewClient";
import { REPORT_REVIEW_DISCLAIMER, REPORT_REVIEW_INELIGIBLE_EXPLANATIONS } from "@/lib/governance/reportReviewCopy";
import { APPROVAL_NOT_AVAILABLE_MESSAGE } from "@/lib/workspaces/approvalAssignmentCopy";

const WS = "ws-1";
const RUN = "run-1";
const BASE = `/api/workspaces/${WS}/runs/${RUN}/report-review`;
const response = (status: number, json: unknown) => ({ ok: status >= 200 && status < 300, status, json: async () => json, headers: { get: () => null } });

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}
async function mount(canCreateExport = true) {
  let r!: TestRenderer.ReactTestRenderer;
  await act(async () => {
    r = TestRenderer.create(createElement(ReportReviewPanel, { workspaceId: WS, runId: RUN, canCreateExport }));
  });
  await flush();
  return r;
}
const text = (r: TestRenderer.ReactTestRenderer) =>
  r.root
    .findAll((n) => typeof n.type === "string")
    .flatMap((n) => n.children.filter((c): c is string => typeof c === "string"))
    .join(" ")
    .replace(/\s+/g, " ");
const byTestId = (r: TestRenderer.ReactTestRenderer, id: string) => r.root.findAll((n) => n.props["data-testid"] === id && typeof n.type === "string");
const buttons = (r: TestRenderer.ReactTestRenderer) => r.root.findAll((n) => n.type === "button");
const buttonText = (b: TestRenderer.ReactTestInstance) => b.children.filter((c) => typeof c === "string").join("");

const submitted = (over: Record<string, unknown> = {}, viewer: Record<string, unknown> = {}) => ({
  ok: true,
  state: "submitted",
  record: {
    version: 1,
    kind: "report_review",
    cycle: 2,
    scope: { schemaId: "generic", unifiedAnswer: "absent", synthesis: "absent", consensus: "absent", respondedModels: 2, requestedModels: 3 },
    purpose: { code: "client_delivery", note: "Board <pack>" },
    humanReview: { status: "approved_with_conditions", reviewerId: "uid-r", reviewedAt: "2026-11-02T12:00:00.000Z", conditions: ["Cite sources"], comment: "Looks fine" },
    submittedAt: "2026-11-02T11:00:00.000Z",
    submittedByUserId: "uid-m",
    createdAt: "2026-11-02T11:00:00.000Z",
    updatedAt: "2026-11-02T12:00:00.000Z",
    ...over,
  },
  previousCycles: [{ cycle: 1, status: "changes_requested", reviewerId: "uid-r", reviewedAt: "2026-11-01T12:00:00.000Z", purposeCode: "internal_review", assignedReviewerUserId: "uid-r" }],
  assignment: { assignedReviewerUserId: "uid-r", revision: 3, info: { assignedReviewerUserId: "uid-r", assignedReviewerDisplayName: "Rae", revision: 3, assignedAt: null, updatedAt: "2026-11-02T11:05:00.000Z", dueAt: null, state: "actionable" } },
  viewer: { canDecide: false, denial: "not_open", canResubmit: false, canManageAssignment: false, ...viewer },
  names: { "uid-r": "Rae", "uid-m": "Mo" },
  history: [
    { type: "report_review_submitted", at: "2026-11-02T11:00:00.000Z", actorDisplayName: "Mo", cycle: 2, purposeCode: "client_delivery" },
    { type: "report_review_decided", at: "2026-11-02T12:00:00.000Z", actorDisplayName: "Rae", cycle: 2, status: "approved_with_conditions" },
  ],
  content: { absentNow: ["unifiedAnswer", "synthesis", "consensus"], addedSinceSubmission: [] as string[] },
  historyIncomplete: false,
  disclaimer: REPORT_REVIEW_DISCLAIMER,
});

beforeEach(() => {
  mockedAuthedFetch.mockReset();
  cardProps.length = 0;
});

describe("not yet submitted", () => {
  it("eligible + allowed: four purposes, note limit, disclaimer, and an explicit Submit for approval", async () => {
    mockedAuthedFetch.mockResolvedValueOnce(response(200, { ok: true, state: "not_submitted", eligibility: { eligible: true }, viewer: { canSubmit: true }, disclaimer: REPORT_REVIEW_DISCLAIMER }));
    const r = await mount();
    const radios = r.root.findAll((n) => n.type === "input" && n.props.name === "report-review-purpose").map((n) => n.props.value);
    expect(radios).toEqual(["internal_review", "client_delivery", "publication_review", "other"]);
    expect(byTestId(r, "report-review-disclaimer").map((n) => n.children.join(""))).toEqual([REPORT_REVIEW_DISCLAIMER]);
    const submit = buttons(r).find((b) => buttonText(b) === "Submit for approval")!;
    expect(submit.props.disabled).toBe(true); // nothing chosen yet
    expect(text(r)).toContain("0 / 280 characters");

    await act(async () => r.root.findAll((n) => n.type === "input" && n.props.value === "publication_review")[0].props.onChange());
    await act(async () => r.root.findByType("textarea").props.onChange({ target: { value: "x".repeat(281) } }));
    expect(buttons(r).find((b) => buttonText(b) === "Submit for approval")!.props.disabled).toBe(true); // over the limit
    await act(async () => r.root.findByType("textarea").props.onChange({ target: { value: "  For the launch  " } }));
    mockedAuthedFetch.mockResolvedValueOnce(response(201, { ok: true }));
    mockedAuthedFetch.mockResolvedValueOnce(response(200, submitted({ humanReview: { status: "unreviewed" } })));
    await act(async () => r.root.findByType("form").props.onSubmit({ preventDefault() {} }));
    await flush();
    const post = mockedAuthedFetch.mock.calls.find((c) => c[1]?.method === "POST")!;
    expect(post[0]).toBe(BASE);
    expect(JSON.parse(post[1].body)).toEqual({ purpose: { code: "publication_review", note: "For the launch" } });
  });

  it("ineligible: the exact reason, and no form or submit button", async () => {
    mockedAuthedFetch.mockResolvedValueOnce(response(200, { ok: true, state: "not_submitted", eligibility: { eligible: false, reason: "no_review_information" }, viewer: { canSubmit: false }, disclaimer: REPORT_REVIEW_DISCLAIMER }));
    const r = await mount();
    expect(byTestId(r, "report-review-unavailable-reason")[0].children.join("")).toBe(REPORT_REVIEW_INELIGIBLE_EXPLANATIONS.no_review_information);
    expect(r.root.findAllByType("form").length).toBe(0);
  });

  it("eligible but the viewer may not submit: explanation and disclaimer, no form", async () => {
    mockedAuthedFetch.mockResolvedValueOnce(response(200, { ok: true, state: "not_submitted", eligibility: { eligible: true }, viewer: { canSubmit: false }, disclaimer: REPORT_REVIEW_DISCLAIMER }));
    const r = await mount();
    expect(text(r)).toContain("Only members who can organize research can submit it.");
    expect(byTestId(r, "report-review-disclaimer")).toHaveLength(1);
    expect(r.root.findAllByType("form").length).toBe(0);
  });

  it("not authorized to read reviews (404): the unchanged Order A notice", async () => {
    mockedAuthedFetch.mockResolvedValueOnce(response(404, { ok: false }));
    const r = await mount();
    expect(byTestId(r, "approval-not-available-notice")).toHaveLength(1);
    expect(text(r)).toContain(APPROVAL_NOT_AVAILABLE_MESSAGE);
  });

  it("a malformed context is an error state, never rendered", async () => {
    mockedAuthedFetch.mockResolvedValueOnce(response(200, { ok: true, state: "submitted", record: { cycle: "2" } }));
    const r = await mount();
    expect(text(r)).toContain("We couldn't load the approval status.");
  });
});

describe("submitted", () => {
  it("decided: status, purpose and note, decision with conditions, disclaimer, absent analyses, previous cycles, history", async () => {
    mockedAuthedFetch.mockResolvedValueOnce(response(200, submitted()));
    const r = await mount();
    expect(byTestId(r, "report-review-status")[0].children.join("")).toBe("Approved with conditions");
    const t = text(r);
    expect(t).toContain("Client delivery");
    expect(t).toContain("Board <pack>"); // rendered as text by React (escaped), never as markup
    expect(t).toContain("Cite sources");
    expect(t).toContain("2 of 3 models responded");
    expect(byTestId(r, "report-review-scope-absent")[0].children.join("")).toBe("This report does not contain a Unified Answer, a consensus summary, a synthesis. Approval does not add or verify them.");
    expect(byTestId(r, "report-review-disclaimer").map((n) => n.children.join(""))).toEqual([REPORT_REVIEW_DISCLAIMER]);
    expect(byTestId(r, "report-review-previous-cycles")).toHaveLength(1);
    expect(byTestId(r, "report-review-history")).toHaveLength(1);
    expect(r.root.findAll((n) => n.props["data-testid"] === "report-review-decision-form").length).toBe(0);
    expect(cardProps).toEqual([]); // a decided cycle's assignment is not managed here
    expect(byTestId(r, "report-review-content-added").length).toBe(0);
    expect(byTestId(r, "report-review-history-incomplete").length).toBe(0);
  });

  it("review M-2 / n-1: content added after submission and an incomplete history are stated", async () => {
    mockedAuthedFetch.mockResolvedValueOnce(response(200, { ...submitted(), content: { absentNow: ["consensus"], addedSinceSubmission: ["unifiedAnswer", "synthesis"] }, historyIncomplete: true }));
    const r = await mount();
    expect(byTestId(r, "report-review-scope-absent")[0].children.join("")).toBe("This report does not contain a consensus summary. Approval does not add or verify them.");
    expect(byTestId(r, "report-review-content-added")[0].children.join("")).toBe("Added after this report was submitted for review, and not covered by its decision: a Unified Answer, a synthesis.");
    expect(byTestId(r, "report-review-history-incomplete")).toHaveLength(1);
  });

  it("assigned reviewer: the decision form (with the disclaimer) posts the cycle and updatedAt it was shown", async () => {
    mockedAuthedFetch.mockResolvedValueOnce(response(200, submitted({ humanReview: { status: "unreviewed" } }, { canDecide: true, denial: null, canManageAssignment: true })));
    const r = await mount();
    expect(cardProps[0]).toMatchObject({ workspaceId: WS, runId: RUN, assignmentRevision: 3, canManageAssignment: true });
    const form = r.root.findAll((n) => n.props["data-testid"] === "report-review-decision-form")[0];
    expect(form.findAll((n) => n.props["data-testid"] === "report-review-disclaimer" && typeof n.type === "string")).toHaveLength(1);
    await act(async () => form.findAll((n) => n.type === "input" && n.props.value === "rejected")[0].props.onChange());
    mockedAuthedFetch.mockResolvedValueOnce(response(200, { ok: true }));
    mockedAuthedFetch.mockResolvedValueOnce(response(200, submitted()));
    await act(async () => form.props.onSubmit({ preventDefault() {} }));
    await flush();
    const post = mockedAuthedFetch.mock.calls.find((c) => c[1]?.method === "POST")!;
    expect(post[0]).toBe(`${BASE}/decision`);
    expect(JSON.parse(post[1].body)).toEqual({ decision: { status: "rejected" }, expectedCycle: 2, expectedUpdatedAt: "2026-11-02T12:00:00.000Z" });
  });

  it("not allowed to decide: no form, and the reason (e.g. the submitter) is stated", async () => {
    mockedAuthedFetch.mockResolvedValueOnce(response(200, submitted({ humanReview: { status: "unreviewed" } }, { canDecide: false, denial: "submitter" })));
    const r = await mount();
    expect(r.root.findAll((n) => n.props["data-testid"] === "report-review-decision-form").length).toBe(0);
    expect(byTestId(r, "report-review-decision-unavailable")[0].children.join("")).toBe("You submitted this report for approval, so another reviewer must decide it.");
  });

  it("export buttons only with exports.create; a conflict refreshes and explains", async () => {
    mockedAuthedFetch.mockResolvedValueOnce(response(200, submitted({}, { canResubmit: true })));
    const noExport = await mount(false);
    expect(buttons(noExport).map(buttonText)).not.toContain("Data (JSON)");
    mockedAuthedFetch.mockResolvedValueOnce(response(200, submitted({}, { canResubmit: true })));
    const r = await mount(true);
    expect(buttons(r).map(buttonText)).toEqual(expect.arrayContaining(["Document (HTML)", "Data (JSON)", "Submit again"]));
    await act(async () => r.root.findAll((n) => n.type === "input" && n.props.value === "other")[0].props.onChange());
    mockedAuthedFetch.mockResolvedValueOnce(response(409, { ok: false, message: "This review changed since you last viewed it. Refresh and try again." }));
    mockedAuthedFetch.mockResolvedValueOnce(response(200, submitted()));
    await act(async () => r.root.findByType("form").props.onSubmit({ preventDefault() {} }));
    await flush();
    const post = mockedAuthedFetch.mock.calls.find((c) => c[1]?.method === "POST")!;
    expect([post[0], JSON.parse(post[1].body)]).toEqual([`${BASE}/resubmit`, { purpose: { code: "other" }, expectedCycle: 2 }]);
    expect(text(r)).toContain("This review changed since you last viewed it. Refresh and try again.");
  });
});

describe("Audit Log row and queue row", () => {
  const mountEl = (el: ReturnType<typeof createElement>) => TestRenderer.create(el);
  it("a decision row carries the disclaimer; other rows do not need it; a missing question is never invented", () => {
    const decided = mountEl(createElement(ReportReviewAuditEntry, { event: { eventType: "workspace_report_review_decided", occurredAt: "2026-11-02T12:00:00.000Z", actor: { displayName: "Rae" }, research: { question: null }, cycle: 1, status: "rejected", purpose: "other" } }));
    expect(text(decided)).toContain("Untitled research");
    expect(text(decided)).toContain("Review cycle 1 is closed.");
    expect(decided.root.findAll((n) => n.props["data-testid"] === "report-review-disclaimer" && typeof n.type === "string")[0].children.join("")).toBe(REPORT_REVIEW_DISCLAIMER);
    const removed = mountEl(createElement(ReportReviewAuditEntry, { event: { eventType: "workspace_report_review_reviewer_changed", occurredAt: "2026-11-02T12:00:00.000Z", actor: { displayName: "Ada" }, research: { question: "Q" }, cycle: 1, change: "removed", previousReviewer: { displayName: "Rae" }, reviewer: null } }));
    expect(text(removed)).toContain("Report reviewer removed");
    expect(removed.root.findAll((n) => n.props["data-testid"] === "report-review-disclaimer").length).toBe(0);
    const updated = mountEl(createElement(ReportReviewAuditEntry, { event: { eventType: "workspace_report_review_reviewer_changed", occurredAt: "2026-11-02T12:00:00.000Z", actor: { displayName: "Ada" }, research: { question: "Q" }, cycle: 1, change: "updated", previousReviewer: { displayName: "Rae" }, reviewer: { displayName: "Rae" } } }));
    expect(text(updated)).toContain("Report review assignment updated");
    expect(text(updated)).toContain("the reviewer is unchanged");
    // Review m-2: the disclaimer also appears where approval is REQUESTED (submission and resubmission rows).
    for (const ev of [
      { eventType: "workspace_report_review_submitted", occurredAt: "2026-11-02T12:00:00.000Z", actor: { displayName: "Mo" }, research: { question: "Q" }, cycle: 1, purpose: "other" },
      { eventType: "workspace_report_review_resubmitted", occurredAt: "2026-11-02T12:00:00.000Z", actor: { displayName: "Mo" }, research: { question: "Q" }, cycle: 2, fromCycle: 1, purpose: "other", clearedReviewer: null },
    ] as const) {
      const r = mountEl(createElement(ReportReviewAuditEntry, { event: ev }));
      expect(r.root.findAll((n) => n.props["data-testid"] === "report-review-disclaimer" && typeof n.type === "string")[0].children.join("")).toBe(REPORT_REVIEW_DISCLAIMER);
    }
  });

  const row = (recordKind?: "report_review") => ({
    runId: RUN,
    workspaceId: WS,
    projectId: "p1",
    runLabel: "Q",
    reviewStatus: "unreviewed",
    createdAt: "2026-11-02T11:00:00.000Z",
    reviewedAt: null,
    assignment: { assignedReviewerUserId: null, assignedReviewerDisplayName: null, dueAt: null, state: "unassigned" as const },
    isAssignedToMe: false,
    isOverdue: false,
    ...(recordKind ? { recordKind } : {}),
  });
  it("a report-review row opens the Team research page and is labelled; a governed row is unchanged", () => {
    const rr = mountEl(createElement(ReviewQueueRow, { row: row("report_review"), projectNameById: new Map(), canManageReviews: false }));
    expect(rr.root.findAllByType("a").map((a) => a.props.href)).toEqual([`/workspace/team/${WS}/projects/p1/research/${RUN}`, `/workspace/team/${WS}/projects/p1/research/${RUN}`]);
    expect(rr.root.findAll((n) => n.props["data-testid"] === "queue-report-review-tag" && typeof n.type === "string")).toHaveLength(2);
    const gov = mountEl(createElement(ReviewQueueRow, { row: row(), projectNameById: new Map(), canManageReviews: false }));
    expect(gov.root.findAllByType("a").map((a) => a.props.href)).toEqual([`/workspace/reviews/${RUN}`, `/workspace/reviews/${RUN}`]);
    expect(gov.root.findAll((n) => n.props["data-testid"] === "queue-report-review-tag").length).toBe(0);
  });
});

describe("strict client parser", () => {
  it.each([
    ["not ok", { ok: false }],
    ["no disclaimer", { ...submitted(), disclaimer: undefined }],
    ["cycle not an integer", { ...submitted(), record: { ...submitted().record, cycle: 1.5 } }],
    ["viewer flag missing", { ...submitted(), viewer: { canDecide: true } }],
    ["bad assignment state", { ...submitted(), assignment: { revision: 1, info: { ...submitted().assignment.info, state: "maybe" } } }],
    ["history item without actor", { ...submitted(), history: [{ type: "report_review_submitted", at: "x", cycle: 1 }] }],
    ["non-string name", { ...submitted(), names: { a: 1 } }],
    ["content missing", { ...submitted(), content: undefined }],
    ["historyIncomplete missing", { ...submitted(), historyIncomplete: undefined }],
    ["not_submitted without reason", { ok: true, state: "not_submitted", eligibility: { eligible: false }, viewer: { canSubmit: false }, disclaimer: "D" }],
  ])("rejects %s", (_l, json) => {
    expect(parseReportReviewContextResponse(json)).toBeNull();
  });
  it("accepts a well-formed response", () => {
    expect(parseReportReviewContextResponse(submitted())).not.toBeNull();
  });
});

describe("Audit Log client accepts report-review rows (one unrecognised row would fail the whole page)", () => {
  const { fetchWorkspaceAuditEvents } = jest.requireActual("@/lib/client/workspaceTeamClient") as typeof import("@/lib/client/workspaceTeamClient");
  const rows = [
    { eventType: "workspace_report_review_submitted", occurredAt: "2026-11-02T11:00:00.000Z", actor: { displayName: "Mo" }, research: { question: "Q" }, cycle: 1, purpose: "other" },
    { eventType: "workspace_report_review_resubmitted", occurredAt: "2026-11-02T11:00:00.000Z", actor: { displayName: "Mo" }, research: { question: null }, cycle: 2, fromCycle: 1, purpose: "other", clearedReviewer: null },
    { eventType: "workspace_report_review_reviewer_changed", occurredAt: "2026-11-02T11:00:00.000Z", actor: { displayName: "Ada" }, research: { question: "Q" }, cycle: 1, change: "assigned", previousReviewer: null, reviewer: { displayName: "Rae" } },
    { eventType: "workspace_report_review_decided", occurredAt: "2026-11-02T11:00:00.000Z", actor: { displayName: "Rae" }, research: { question: "Q" }, cycle: 1, status: "approved", purpose: "other" },
    { eventType: "workspace_member_removed", occurredAt: "2026-11-02T11:00:00.000Z", actor: { displayName: "Ada" }, target: { displayName: "Bo" }, previousRole: "member" },
  ];
  it("a mixed page parses", async () => {
    mockedAuthedFetch.mockResolvedValueOnce(response(200, { ok: true, events: rows, hasMore: false }));
    const res = await fetchWorkspaceAuditEvents({ user: null, authReady: true, workspaceId: WS });
    expect(res.status === "ok" && res.events.length).toBe(5);
  });
  it.each([
    ["cycle missing", { ...rows[0], cycle: undefined }],
    ["empty question", { ...rows[0], research: { question: "" } }],
    ["reviewer not a name ref", { ...rows[2], reviewer: "Rae" }],
    ["unknown change kind", { ...rows[2], change: "moved" }],
    ["decided without status", { ...rows[3], status: undefined }],
  ])("a malformed report-review row is rejected (%s)", async (_l, row) => {
    mockedAuthedFetch.mockResolvedValueOnce(response(200, { ok: true, events: [row], hasMore: false }));
    expect((await fetchWorkspaceAuditEvents({ user: null, authReady: true, workspaceId: WS })).status).toBe("error");
  });
});
