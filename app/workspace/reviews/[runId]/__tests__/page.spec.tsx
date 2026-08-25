/**
 * Approval Workflow, Phase 9C.1-R1C — GET /workspace/reviews/[runId]
 * route gate + content tests. Same technique as
 * `app/workspace/reviews/__tests__/page.spec.tsx`: calls the Server
 * Component function directly and asserts real `next/navigation`
 * `notFound()` behavior (digest `"NEXT_NOT_FOUND"`).
 *
 * Phase 9C.4: the page no longer 404s merely because Approval Workflow
 * admission failed — `getWorkspaceRunDetail()` is now ALWAYS called (with
 * `approvalAdmitted` passed through) and makes the actual normal-vs-drain
 * admission decision itself, mirroring `getReviewContext()`'s own drain
 * rule. `getWorkspaceRunDetail` itself is mocked here, so its internal
 * drain logic is exercised by `lib/workspaces/__tests__/workspaceRunDetail.spec.ts`,
 * not here — this file only asserts the page correctly defers to it.
 */

const mockedResolveServerComponentIdentity = jest.fn();
jest.mock("@/lib/auth/resolveServerComponentIdentity", () => ({
  resolveServerComponentIdentity: (...args: any[]) => mockedResolveServerComponentIdentity(...args),
}));

let approvalGlobal = false;
let approvalCanary: string | undefined = undefined;
jest.mock("@/lib/env", () => ({
  get APPROVAL_WORKFLOW_ENABLED() {
    return approvalGlobal;
  },
  get APPROVAL_WORKFLOW_CANARY_UIDS() {
    return approvalCanary;
  },
}));

const mockedGetWorkspaceRunDetail = jest.fn();
jest.mock("@/lib/workspaces/workspaceRunDetail", () => ({
  getWorkspaceRunDetail: (...args: any[]) => mockedGetWorkspaceRunDetail(...args),
}));

import WorkspaceRunDetailPage from "@/app/workspace/reviews/[runId]/page";

function callPage(runId = "run-1") {
  return WorkspaceRunDetailPage({ params: { runId } });
}

async function expectRealNotFound(promise: Promise<unknown>): Promise<void> {
  let caught: unknown;
  try {
    await promise;
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeDefined();
  expect((caught as any)?.digest).toBe("NEXT_NOT_FOUND");
}

const VALID_DETAIL = {
  status: "ok" as const,
  detail: {
    runId: "run-1",
    workspaceId: "ws-1",
    workspaceName: "Acme Research",
    projectId: null,
    projectName: null,
    runLabel: "What are the top acquisition risks?",
    reviewStatus: "approved_with_conditions" as const,
    createdAt: "2026-08-01T00:00:00.000Z",
    reviewedAt: "2026-08-05T00:00:00.000Z",
  },
};

beforeEach(() => {
  approvalGlobal = false;
  approvalCanary = undefined;
  jest.clearAllMocks();
});

describe("GET /workspace/reviews/[runId] — route gate", () => {
  it("unauthenticated -> real notFound(), never calls getWorkspaceRunDetail", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue(null);
    approvalGlobal = true;
    await expectRealNotFound(callPage());
    expect(mockedGetWorkspaceRunDetail).not.toHaveBeenCalled();
  });

  it("Approval Workflow not admitted, getWorkspaceRunDetail reports not_found (no drain-eligible panel): real notFound(), but getWorkspaceRunDetail IS called with approvalAdmitted:false — Phase 9C.4, admission is no longer decided at the page layer", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "u1" });
    mockedGetWorkspaceRunDetail.mockResolvedValue({ status: "not_found" });
    await expectRealNotFound(callPage());
    expect(mockedGetWorkspaceRunDetail).toHaveBeenCalledWith({ runId: "run-1", uid: "u1", approvalAdmitted: false });
  });

  it("Phase 9C.4: Approval Workflow not admitted, but getWorkspaceRunDetail reports ok (drain-eligible existing panel): renders, no notFound()", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "u1" });
    mockedGetWorkspaceRunDetail.mockResolvedValue(VALID_DETAIL);
    const result = await callPage();
    expect(result).toBeTruthy();
    expect(mockedGetWorkspaceRunDetail).toHaveBeenCalledWith({ runId: "run-1", uid: "u1", approvalAdmitted: false });
  });

  it("SECURITY: canary present but uid does not match, and no drain-eligible panel -> real notFound()", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "u2" });
    approvalCanary = "u1";
    mockedGetWorkspaceRunDetail.mockResolvedValue({ status: "not_found" });
    await expectRealNotFound(callPage());
    expect(mockedGetWorkspaceRunDetail).toHaveBeenCalledWith({ runId: "run-1", uid: "u2", approvalAdmitted: false });
  });

  it("getWorkspaceRunDetail returns not_found -> real notFound(), no message reveals a run exists", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "u1" });
    approvalGlobal = true;
    mockedGetWorkspaceRunDetail.mockResolvedValue({ status: "not_found" });
    await expectRealNotFound(callPage());
  });

  it("getWorkspaceRunDetail returns read_failed -> real notFound(), same concealment as not_found", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "u1" });
    approvalGlobal = true;
    mockedGetWorkspaceRunDetail.mockResolvedValue({ status: "read_failed" });
    await expectRealNotFound(callPage());
  });

  it("passes approvalAdmitted:true only after the page's own gate has already confirmed it", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "u1" });
    approvalGlobal = true;
    mockedGetWorkspaceRunDetail.mockResolvedValue(VALID_DETAIL);
    await callPage();
    expect(mockedGetWorkspaceRunDetail).toHaveBeenCalledWith({ runId: "run-1", uid: "u1", approvalAdmitted: true });
  });

  it("fully eligible -> renders, no notFound() thrown", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "u1" });
    approvalGlobal = true;
    mockedGetWorkspaceRunDetail.mockResolvedValue(VALID_DETAIL);
    const result = await callPage();
    expect(result).toBeTruthy();
  });
});

describe("GET /workspace/reviews/[runId] — content, no mutation controls", () => {
  it("renders the Workspace name and run label", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "u1" });
    approvalGlobal = true;
    mockedGetWorkspaceRunDetail.mockResolvedValue(VALID_DETAIL);
    const { renderToStaticMarkup } = await import("react-dom/server");
    const html = renderToStaticMarkup((await callPage()) as any);
    expect(html).toContain("Acme Research");
    expect(html).toContain("What are the top acquisition risks?");
  });

  it("approved_with_conditions renders distinctly from plain Approved", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "u1" });
    approvalGlobal = true;
    mockedGetWorkspaceRunDetail.mockResolvedValue(VALID_DETAIL);
    const { renderToStaticMarkup } = await import("react-dom/server");
    const html = renderToStaticMarkup((await callPage()) as any);
    expect(html).toContain("Approved with conditions");
  });

  it("never renders raw runId/workspaceId as visible text", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "u1" });
    approvalGlobal = true;
    mockedGetWorkspaceRunDetail.mockResolvedValue(VALID_DETAIL);
    const { renderToStaticMarkup } = await import("react-dom/server");
    const html = renderToStaticMarkup((await callPage()) as any);
    expect(html).not.toMatch(/>run-1</);
    expect(html).not.toMatch(/>ws-1</);
  });

  it("no due date / dueAt-shaped fields are ever rendered as 'Invalid Date'", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "u1" });
    approvalGlobal = true;
    mockedGetWorkspaceRunDetail.mockResolvedValue({ status: "ok", detail: { ...VALID_DETAIL.detail, createdAt: null, reviewedAt: null } });
    const { renderToStaticMarkup } = await import("react-dom/server");
    const html = renderToStaticMarkup((await callPage()) as any);
    expect(html).not.toContain("Invalid Date");
  });

  it("renders no mutation control text (Assign/Approve/Reject/Vote/Finalize/Override) — still read-only in this phase", async () => {
    mockedResolveServerComponentIdentity.mockResolvedValue({ uid: "u1" });
    approvalGlobal = true;
    mockedGetWorkspaceRunDetail.mockResolvedValue(VALID_DETAIL);
    const { renderToStaticMarkup } = await import("react-dom/server");
    const html = renderToStaticMarkup((await callPage()) as any);
    for (const word of ["Assign<", "Reassign<", "Approve<", "Reject<", "Request changes<", "Resubmit<", "Vote<", "Finalize<", "Override<"]) {
      expect(html).not.toContain(word);
    }
  });
});
