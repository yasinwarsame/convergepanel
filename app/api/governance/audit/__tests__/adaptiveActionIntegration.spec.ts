/**
 * Immutable Adaptive Review History and Admin Audit Integration — a
 * focused test for the ONE change made to the pre-existing
 * `/api/governance/audit` route: the new `adaptive_human_review_decided`
 * action must now pass through the route's existing
 * action-allowlist/display filters instead of being silently dropped.
 * This route had NO pre-existing test coverage before this change
 * (confirmed in the Step 1.1 audit) — this file intentionally does not
 * attempt full coverage of the route's own extensive pre-existing
 * behavior, only the new, additive pass-through.
 */

const mockedResolveGovernanceRequestUser = jest.fn();
jest.mock("@/lib/governance/authCheck", () => ({
  resolveGovernanceRequestUser: (...args: any[]) => mockedResolveGovernanceRequestUser(...args),
}));

const mockedResolveVisibleUserIds = jest.fn();
jest.mock("@/lib/governance/governanceVisibleUserIds", () => ({
  resolveGovernanceVisibleUserIdsCached: (...args: any[]) => mockedResolveVisibleUserIds(...args),
  runOwnerVisibleInGovernance: (visibleUserIds: string[] | null, ownerUid: string) =>
    visibleUserIds === null || visibleUserIds.includes(ownerUid),
  governanceQueuePlanForbiddenResponse: () => new Response(null, { status: 403 }),
}));

const auditDocs: Array<{ id: string; data: Record<string, unknown> }> = [];
const mockAdminDb: any = {
  collection: (name: string) => {
    if (name !== "admin_audit_logs") throw new Error(`unexpected collection ${name}`);
    return {
      orderBy: () => ({
        limit: () => ({
          select: () => ({
            get: async () => ({ docs: auditDocs.map((d) => ({ id: d.id, data: () => d.data })) }),
          }),
        }),
      }),
      limit: () => ({
        select: () => ({
          get: async () => ({ docs: auditDocs.map((d) => ({ id: d.id, data: () => d.data })) }),
        }),
      }),
    };
  },
};
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return mockAdminDb;
  },
}));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/governance/audit/route";

const VIEWER_UID = "reviewer-uid";

function buildRequest(): NextRequest {
  return new NextRequest("http://localhost/api/governance/audit");
}

beforeEach(() => {
  auditDocs.length = 0;
  mockedResolveGovernanceRequestUser.mockReset();
  mockedResolveVisibleUserIds.mockReset();
  mockedResolveGovernanceRequestUser.mockResolvedValue({ ok: true, uid: VIEWER_UID, email: "reviewer@test.com" });
  mockedResolveVisibleUserIds.mockResolvedValue({ ok: true, visibleUserIds: null, isSupportAdmin: true, queueScope: "admin_global" });
});

describe("GET /api/governance/audit — adaptive_human_review_decided pass-through", () => {
  it("a stored adaptive_human_review_decided document is returned to the viewer who made the decision", async () => {
    auditDocs.push({
      id: "adaptive-review:dec_abc",
      data: {
        action: "adaptive_human_review_decided",
        byUid: VIEWER_UID,
        byEmail: "reviewer@test.com",
        at: "2026-07-30T00:00:00.000Z",
        runId: "run-1",
        prevStatus: "unreviewed",
        nextStatus: "approved",
      },
    });

    const res = await GET(buildRequest());
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.events).toHaveLength(1);
    expect(body.events[0].action).toBe("adaptive_human_review_decided");
    expect(body.events[0].nextStatus).toBe("approved");
  });

  it.each([
    "adaptive_human_review_reviewer_assigned",
    "adaptive_human_review_reviewer_reassigned",
    "adaptive_human_review_reviewer_unassigned",
  ])("Part E3 assignment action %s passes through to the viewer who performed it", async (action) => {
    auditDocs.push({
      id: `adaptive-review-assignment:run-1:1`,
      data: { action, byUid: VIEWER_UID, byEmail: "reviewer@test.com", at: "2026-07-30T00:00:00.000Z", runId: "run-1" },
    });
    const res = await GET(buildRequest());
    const body = await res.json();
    expect(body.events).toHaveLength(1);
    expect(body.events[0].action).toBe(action);
  });

  it("Transactional Multi-Reviewer Finalization, Part E action adaptive_review_panel_finalized passes through to the viewer who performed it", async () => {
    auditDocs.push({
      id: `adaptive-review-panel-finalization:panel_dec_abc123`,
      data: {
        action: "adaptive_review_panel_finalized",
        byUid: VIEWER_UID,
        byEmail: "reviewer@test.com",
        at: "2026-07-31T00:00:00.000Z",
        runId: "run-1",
      },
    });
    const res = await GET(buildRequest());
    const body = await res.json();
    expect(body.events).toHaveLength(1);
    expect(body.events[0].action).toBe("adaptive_review_panel_finalized");
  });

  it("legacy actions (approved) still pass through unaffected", async () => {
    auditDocs.push({
      id: "legacy-1",
      data: { action: "approved", byUid: VIEWER_UID, byEmail: "reviewer@test.com", at: "2026-07-30T00:00:00.000Z" },
    });
    const res = await GET(buildRequest());
    const body = await res.json();
    expect(body.events).toHaveLength(1);
    expect(body.events[0].action).toBe("approved");
  });

  it("a system-only action (evaluated) is still excluded from the display list", async () => {
    auditDocs.push({
      id: "sys-1",
      data: { action: "evaluated", byUid: VIEWER_UID, byEmail: "reviewer@test.com", at: "2026-07-30T00:00:00.000Z" },
    });
    const res = await GET(buildRequest());
    const body = await res.json();
    expect(body.events).toHaveLength(0);
  });

  it("a genuinely unknown action is still excluded, not silently displayed", async () => {
    auditDocs.push({
      id: "unknown-1",
      data: { action: "some_other_unrelated_action", byUid: VIEWER_UID, byEmail: "reviewer@test.com", at: "2026-07-30T00:00:00.000Z" },
    });
    const res = await GET(buildRequest());
    const body = await res.json();
    expect(body.events).toHaveLength(0);
  });

  it("never exposes comment/conditions for the adaptive action (not written to admin_audit_logs at all)", async () => {
    auditDocs.push({
      id: "adaptive-review:dec_abc",
      data: {
        action: "adaptive_human_review_decided",
        byUid: VIEWER_UID,
        byEmail: "reviewer@test.com",
        at: "2026-07-30T00:00:00.000Z",
        runId: "run-1",
        prevStatus: "unreviewed",
        nextStatus: "approved",
      },
    });
    const res = await GET(buildRequest());
    const body = await res.json();
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain("comment");
    expect(serialized).not.toContain("conditions");
  });
});
