/**
 * Phase 4B security completion — POST /api/governance/review.
 * See app/api/governance/audit/__tests__/workspaceIntegrityDrilldown.spec.ts
 * for the shared rationale. This mutation route echoes truncated question
 * content into its audit event / response and previously had no Layer-A
 * gate for the `runs` collection case.
 */

const mockedResolveGovernanceRequestUser = jest.fn();
jest.mock("@/lib/governance/authCheck", () => ({
  resolveGovernanceRequestUser: (...args: any[]) => mockedResolveGovernanceRequestUser(...args),
}));
const mockedResolveVisibleUserIds = jest.fn();
jest.mock("@/lib/governance/governanceVisibleUserIds", () => ({
  resolveGovernanceVisibleUserIds: (...args: any[]) => mockedResolveVisibleUserIds(...args),
  runOwnerVisibleInGovernance: (visibleUserIds: string[] | null, ownerUid: string) =>
    visibleUserIds === null || visibleUserIds.includes(ownerUid),
  governanceQueuePlanForbiddenResponse: () => new Response(null, { status: 403 }),
}));
jest.mock("@/lib/governance/auditLog", () => ({ writeAuditEvent: jest.fn().mockResolvedValue(undefined) }));
jest.mock("@/lib/firestore/sanitizeForFirestore", () => ({ sanitizeForFirestore: (v: unknown) => v }));

const runDocs = new Map<string, Record<string, unknown>>();
const mockAdminDb: any = {
  collection: (name: string) => ({
    doc: (id: string) => ({
      get: async () => {
        const data = runDocs.get(id);
        return { exists: !!data, data: () => data };
      },
      update: jest.fn().mockImplementation(async (fields: Record<string, unknown>) => {
        runDocs.set(id, { ...(runDocs.get(id) || {}), ...fields });
      }),
      set: jest.fn().mockImplementation(async (fields: Record<string, unknown>, opts?: { merge?: boolean }) => {
        const existing = opts?.merge ? runDocs.get(id) || {} : {};
        runDocs.set(id, { ...existing, ...fields });
      }),
      collection: () => ({ add: jest.fn().mockResolvedValue({ id: "event-id" }) }),
    }),
  }),
};
jest.mock("@/lib/firebase/admin", () => ({ adminDb: mockAdminDb }));

const mockedGetWorkspace = jest.fn();
jest.mock("@/lib/firestore/workspaces", () => ({ getWorkspace: (...args: any[]) => mockedGetWorkspace(...args) }));
jest.mock("@/lib/env", () => ({ WORKSPACES_ENABLED: true }));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/governance/review/route";

function validWorkspace(ownerUid: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: `personal-${ownerUid}`,
    type: "personal",
    name: "Personal Workspace",
    ownerUserId: ownerUid,
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
    ...overrides,
  };
}

function buildRequest(runId: string, collection = "runs", action = "approved") {
  return new NextRequest("http://localhost/api/governance/review", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ runId, collection, action }),
  });
}

beforeEach(() => {
  runDocs.clear();
  jest.clearAllMocks();
  mockedResolveGovernanceRequestUser.mockResolvedValue({ ok: true, uid: "reviewer-uid", email: "reviewer@test.com" });
  mockedResolveVisibleUserIds.mockResolvedValue({ ok: true, visibleUserIds: null });
  mockedGetWorkspace.mockImplementation(async () => ({ status: "not_found" }));
});

describe("POST /api/governance/review — Workspace integrity", () => {
  it("legacy run (workspaceId absent) -> proceeds, no Workspace lookup", async () => {
    runDocs.set("run-1", { userId: "owner-a", question: "q", governanceStatus: "needs_review" });
    const res = await POST(buildRequest("run-1"));
    expect(res.status).toBe(200);
    expect(mockedGetWorkspace).not.toHaveBeenCalled();
  });

  it("valid bound run -> proceeds", async () => {
    mockedGetWorkspace.mockResolvedValue({ status: "found", workspace: validWorkspace("owner-b") });
    runDocs.set("run-2", { userId: "owner-b", workspaceId: "personal-owner-b", question: "q", governanceStatus: "needs_review" });
    const res = await POST(buildRequest("run-2"));
    expect(res.status).toBe(200);
  });

  it("invalid bound run -> 404, denied, no mutation performed", async () => {
    runDocs.set("run-3", { userId: "owner-c", workspaceId: "personal-owner-c", question: "q", governanceStatus: "needs_review" });
    const res = await POST(buildRequest("run-3"));
    expect(res.status).toBe(404);
    expect(runDocs.get("run-3")?.governanceStatus).toBe("needs_review"); // unchanged
  });

  it("verifications collection is unaffected (no Workspace lookup)", async () => {
    runDocs.set("ver-1", { userId: "owner-a", claim: "q", governanceStatus: "needs_review" });
    await POST(buildRequest("ver-1", "verifications"));
    expect(mockedGetWorkspace).not.toHaveBeenCalled();
  });
});
