/**
 * Phase 4B security completion — GET /api/governance/queue.
 * See app/api/governance/audit/__tests__/workspaceIntegrityDrilldown.spec.ts
 * for the shared rationale. This route stages rows from `runs` (plus
 * verifications/video, unaffected) and previously disclosed truncated
 * question content with no Layer-A gate.
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

type FakeRunRow = { id: string; data: Record<string, unknown> };
let runRows: FakeRunRow[] = [];
const workspaceDocs = new Map<string, Record<string, unknown>>();

const mockAdminDb: any = {
  collection: (name: string) => {
    if (name === "runs") {
      const snap = { docs: runRows.map((r) => ({ id: r.id, data: () => r.data })) };
      return {
        where: () => ({ orderBy: () => ({ limit: () => ({ select: () => ({ get: async () => snap }) }) }) }),
        orderBy: () => ({ limit: () => ({ select: () => ({ get: async () => snap }) }) }),
        limit: () => ({ select: () => ({ get: async () => snap }) }),
      };
    }
    if (name === "verifications" || name === "videoVerifications") {
      const empty = { docs: [] };
      return {
        where: () => ({ select: () => ({ limit: () => ({ get: async () => empty }) }) }),
        orderBy: () => ({ limit: () => ({ select: () => ({ get: async () => empty }) }) }),
        limit: () => ({ select: () => ({ get: async () => empty }) }),
      };
    }
    if (name === "users") {
      return { doc: () => ({ get: async () => ({ exists: false }) }) };
    }
    return { doc: () => ({ get: async () => ({ exists: false }) }) };
  },
  getAll: async (...refs: any[]) => refs.map(() => ({ exists: false, data: () => undefined })),
};
jest.mock("@/lib/firebase/admin", () => ({ adminDb: mockAdminDb }));

const mockedGetWorkspace = jest.fn();
jest.mock("@/lib/firestore/workspaces", () => ({ getWorkspace: (...args: any[]) => mockedGetWorkspace(...args) }));
jest.mock("@/lib/env", () => ({ WORKSPACES_ENABLED: true, ADMIN_EMAILS: "" }));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/governance/queue/route";

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

function buildRequest(qs = ""): NextRequest {
  return new NextRequest(`http://localhost/api/governance/queue${qs}`);
}

function recentRow(userId: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    userId,
    question: "some governance-queued question",
    governanceStatus: "needs_review",
    createdAt: new Date(),
    ...extra,
  };
}

beforeEach(() => {
  runRows = [];
  workspaceDocs.clear();
  jest.clearAllMocks();
  mockedResolveGovernanceRequestUser.mockResolvedValue({ ok: true, uid: "reviewer-uid", email: "reviewer@test.com" });
  mockedResolveVisibleUserIds.mockResolvedValue({ ok: true, visibleUserIds: null, isSupportAdmin: true, queueScope: "admin_global" });
  mockedGetWorkspace.mockImplementation(async () => ({ status: "not_found" }));
});

describe("GET /api/governance/queue — Workspace integrity on staged research rows", () => {
  it("legacy row (workspaceId absent) -> included, no Workspace lookup", async () => {
    runRows = [{ id: "run-1", data: recentRow("owner-a") }];
    const res = await GET(buildRequest());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.runs.map((i: any) => i.runId)).toContain("run-1");
    expect(mockedGetWorkspace).not.toHaveBeenCalled();
  });

  it("valid bound row -> included", async () => {
    mockedGetWorkspace.mockImplementation(async (id: string) => ({ status: "found", workspace: validWorkspace("owner-b") }));
    runRows = [{ id: "run-2", data: recentRow("owner-b", { workspaceId: "personal-owner-b" }) }];
    const res = await GET(buildRequest());
    const json = await res.json();
    expect(json.runs.map((i: any) => i.runId)).toContain("run-2");
  });

  it("invalid bound row (missing Workspace) -> omitted, response otherwise unaffected", async () => {
    runRows = [
      { id: "run-legacy", data: recentRow("owner-a") },
      { id: "run-invalid", data: recentRow("owner-c", { workspaceId: "personal-owner-c" }) },
    ];
    const res = await GET(buildRequest());
    expect(res.status).toBe(200);
    const json = await res.json();
    const ids = json.runs.map((i: any) => i.runId);
    expect(ids).toContain("run-legacy");
    expect(ids).not.toContain("run-invalid");
  });

  it("batching: 3 rows from the same owner -> exactly one Workspace lookup", async () => {
    mockedGetWorkspace.mockImplementation(async () => ({ status: "found", workspace: validWorkspace("owner-d") }));
    runRows = [
      { id: "run-3a", data: recentRow("owner-d", { workspaceId: "personal-owner-d" }) },
      { id: "run-3b", data: recentRow("owner-d", { workspaceId: "personal-owner-d" }) },
      { id: "run-3c", data: recentRow("owner-d", { workspaceId: "personal-owner-d" }) },
    ];
    await GET(buildRequest());
    expect(mockedGetWorkspace).toHaveBeenCalledTimes(1);
  });
});
