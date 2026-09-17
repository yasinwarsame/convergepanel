/**
 * TEAM-VERIFICATION-PARITY-R1 — POST /api/governance/review must NEVER mutate
 * a Workspace-bound Claim/Video artifact. Every caller (creator, legacy
 * reviewer, global governance admin) receives the SAME concealed not-found,
 * and nothing is written: no document patch, no global audit row, no
 * governanceEvents append, no owner-email enrichment.
 */

const mockedResolveGovernanceRequestUser = jest.fn();
jest.mock("@/lib/governance/authCheck", () => ({
  resolveGovernanceRequestUser: (...args: any[]) => mockedResolveGovernanceRequestUser(...args),
}));
const mockedResolveVisibleUserIds = jest.fn();
const mockedRunOwnerVisible = jest.fn((visibleUserIds: string[] | null, ownerUid: string) => visibleUserIds === null || visibleUserIds.includes(ownerUid));
jest.mock("@/lib/governance/governanceVisibleUserIds", () => ({
  resolveGovernanceVisibleUserIds: (...args: any[]) => mockedResolveVisibleUserIds(...args),
  runOwnerVisibleInGovernance: (v: string[] | null, o: string) => mockedRunOwnerVisible(v, o),
  governanceQueuePlanForbiddenResponse: () => new Response(null, { status: 403 }),
}));
const mockedWriteAuditEvent = jest.fn().mockResolvedValue(undefined);
jest.mock("@/lib/governance/auditLog", () => ({ writeAuditEvent: (...a: any[]) => mockedWriteAuditEvent(...a) }));
jest.mock("@/lib/firestore/sanitizeForFirestore", () => ({ sanitizeForFirestore: (v: unknown) => v }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock("@/lib/workspaces/runWorkspaceIntegrity", () => ({ validateRunWorkspaceAssociation: jest.fn() }));

const docs = new Map<string, Record<string, unknown>>();
const mockedSet = jest.fn();
const mockedEventAdd = jest.fn();
const usersRead: string[] = [];
const mockAdminDb: any = {
  collection: (name: string) => ({
    doc: (id: string) => ({
      get: async () => {
        if (name === "users") usersRead.push(id);
        const data = docs.get(`${name}/${id}`);
        return { exists: !!data, data: () => data };
      },
      set: async (fields: Record<string, unknown>, opts?: { merge?: boolean }) => {
        mockedSet(name, id, fields, opts);
        docs.set(`${name}/${id}`, { ...(docs.get(`${name}/${id}`) ?? {}), ...fields });
      },
      collection: (sub: string) => ({ add: async (v: unknown) => mockedEventAdd(name, id, sub, v) }),
    }),
  }),
};
jest.mock("@/lib/firebase/admin", () => ({ adminDb: mockAdminDb }));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/governance/review/route";

const CREATOR = "creator-uid";
const CONCEALED = { status: 404, body: { ok: false, error: { code: "not_found", message: "Run not found" } } };

type Caller = { label: string; uid: string; visibleUserIds: string[] | null };
const CALLERS: Caller[] = [
  { label: "the artifact creator", uid: CREATOR, visibleUserIds: [CREATOR] },
  { label: "an assigned legacy reviewer", uid: "legacy-reviewer", visibleUserIds: [CREATOR] },
  { label: "a global governance admin", uid: "gov-admin", visibleUserIds: null },
];

function artifact(collection: string, extra: Record<string, unknown>) {
  return collection === "videoVerifications"
    ? { userId: CREATOR, type: "video_verification", fileName: "team.mp4", metadata: { duration: 9 }, governanceStatus: "needs_review", ...extra }
    : { userId: CREATOR, type: "claim_verification", claim: "Team claim text", governanceStatus: "needs_review", ...extra };
}

async function review(caller: Caller, id: string, collection: string, action = "approved", comment?: string) {
  mockedResolveGovernanceRequestUser.mockResolvedValueOnce({ ok: true, uid: caller.uid, email: `${caller.uid}@example.com` });
  mockedResolveVisibleUserIds.mockResolvedValueOnce({ ok: true, visibleUserIds: caller.visibleUserIds });
  const res = await POST(
    new NextRequest("http://localhost/api/governance/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ runId: id, collection, action, ...(comment ? { comment } : {}) }),
    })
  );
  return { status: res.status, body: await res.json() };
}

function expectZeroWrites() {
  expect(mockedSet).not.toHaveBeenCalled();
  expect(mockedWriteAuditEvent).not.toHaveBeenCalled();
  expect(mockedEventAdd).not.toHaveBeenCalled();
  expect(usersRead).toEqual([]);
  expect(mockedRunOwnerVisible).not.toHaveBeenCalled();
}

beforeEach(() => {
  jest.clearAllMocks();
  docs.clear();
  usersRead.length = 0;
});

describe.each(["verifications", "videoVerifications"])("%s — Workspace-bound artifact is never reviewed", (collection) => {
  it.each(CALLERS.map((c) => [c.label, c] as const))("%s -> concealed 404 and ZERO mutation", async (_l, caller) => {
    docs.set(`${collection}/team-1`, artifact(collection, { workspaceId: "ws-1", projectId: null }));
    for (const [action, comment] of [["approved", undefined], ["blocked", "no"], ["changes_requested", "fix"]] as const) {
      expect(await review(caller, "team-1", collection, action, comment)).toEqual(CONCEALED);
    }
    expectZeroWrites();
    expect(docs.get(`${collection}/team-1`)?.governanceStatus).toBe("needs_review");
  });

  it("the concealed response is identical to a missing artifact", async () => {
    docs.set(`${collection}/team-1`, artifact(collection, { workspaceId: "ws-1", projectId: "proj-1" }));
    expect(await review(CALLERS[1], "team-1", collection)).toEqual(await review(CALLERS[1], "does-not-exist", collection));
  });

  it("a caller who could NOT see the owner still gets 404, not the legacy 403", async () => {
    docs.set(`${collection}/team-1`, artifact(collection, { workspaceId: "ws-1", projectId: null }));
    expect(await review({ label: "stranger", uid: "stranger", visibleUserIds: ["someone-else"] }, "team-1", collection)).toEqual(CONCEALED);
    expectZeroWrites();
  });

  it.each([["null", null], ["empty string", ""], ["object", { id: "ws" }]])("workspaceId %s -> concealed, zero mutation", async (_l, value) => {
    docs.set(`${collection}/team-1`, artifact(collection, { workspaceId: value }));
    expect(await review(CALLERS[2], "team-1", collection)).toEqual(CONCEALED);
    expectZeroWrites();
  });

  it("Personal artifact review is unchanged: 200, patch, audit row and event append", async () => {
    docs.set(`${collection}/personal-1`, artifact(collection, { projectId: "proj-personal" }));
    const r = await review(CALLERS[1], "personal-1", collection);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, runId: "personal-1", action: "approved", prevStatus: "needs_review", newStatus: "approved" });
    expect(mockedSet).toHaveBeenCalledTimes(1);
    expect(mockedWriteAuditEvent).toHaveBeenCalledTimes(1);
    expect(mockedWriteAuditEvent.mock.calls[0][0]).toMatchObject({ runId: "personal-1", collection, action: "approved" });
    expect(mockedEventAdd).toHaveBeenCalledTimes(1);
  });

  it("Personal legacy visibility is unchanged: a non-visible reviewer still gets 403 forbidden", async () => {
    docs.set(`${collection}/personal-1`, artifact(collection, {}));
    const r = await review({ label: "stranger", uid: "stranger", visibleUserIds: ["someone-else"] }, "personal-1", collection);
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe("forbidden");
    expect(mockedSet).not.toHaveBeenCalled();
  });
});

describe("auth unchanged", () => {
  it("unauthenticated -> 401 before any document read", async () => {
    mockedResolveGovernanceRequestUser.mockResolvedValueOnce({ ok: false });
    const res = await POST(new NextRequest("http://localhost/api/governance/review", { method: "POST", body: JSON.stringify({ runId: "x", collection: "verifications", action: "approved" }) }));
    expect(res.status).toBe(401);
    expectZeroWrites();
  });
});
