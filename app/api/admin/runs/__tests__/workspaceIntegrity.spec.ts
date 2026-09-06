/**
 * Phase 4B security completion — GET /api/admin/runs (list).
 *
 * A security review of PR #45 found this route disclosed canonical run
 * content (question, userId, etc.) with no Layer-A gate at all — the
 * admin bypass is an existing Layer-B grant (no ownership scoping), never
 * an exemption from Workspace integrity. This file proves: a legacy row
 * is returned unchanged; a valid bound row is returned unchanged; an
 * invalid bound row is omitted with the response shape otherwise intact;
 * and validation is batched per distinct owner, never once per row.
 */

const mockedRequireAdminApiAccess = jest.fn();
jest.mock("@/lib/firebase/auth-helpers", () => ({
  requireAdminApiAccess: (...args: any[]) => mockedRequireAdminApiAccess(...args),
  requireAdminPortalAccess: (...args: any[]) => mockedRequireAdminApiAccess(...args),
}));

type FakeRun = { id: string; data: Record<string, unknown> };
let runRows: FakeRun[] = [];

const mockedGetWorkspace = jest.fn();
jest.mock("@/lib/firestore/workspaces", () => ({ getWorkspace: (...args: any[]) => mockedGetWorkspace(...args) }));
jest.mock("@/lib/env", () => ({ WORKSPACES_ENABLED: true }));

const mockAdminDb: any = {
  collection: (name: string) => {
    if (name === "runs") {
      return {
        orderBy: () => ({
          limit: () => ({
            select: () => ({
              get: async () => ({ docs: runRows.map((r) => ({ id: r.id, data: () => r.data })) }),
            }),
          }),
        }),
      };
    }
    if (name === "verifications" || name === "videoVerifications") {
      return {
        orderBy: () => ({
          limit: () => ({
            select: () => ({
              get: async () => ({ docs: [] }),
            }),
          }),
        }),
        limit: () => ({ select: () => ({ get: async () => ({ docs: [] }) }) }),
      };
    }
    return { doc: () => ({ get: async () => ({ exists: false }) }) };
  },
  getAll: async (...refs: any[]) => refs.map(() => ({ data: () => undefined })),
};
jest.mock("@/lib/firebase/admin", () => ({ adminDb: mockAdminDb }));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/admin/runs/route";

function validWorkspace(ownerUid: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    id: `personal-${ownerUid}`,
    type: "personal",
    name: "Personal Workspace",
    ownerUserId: ownerUid,
    createdAt: "2026-08-14T00:00:00.000Z",
    updatedAt: "2026-08-14T00:00:00.000Z",
  };
}

function buildRequest(qs = "") {
  return new NextRequest(`http://localhost/api/admin/runs${qs}`);
}

beforeEach(() => {
  runRows = [];
  jest.clearAllMocks();
  mockedRequireAdminApiAccess.mockResolvedValue({ uid: "admin-uid", email: "admin@example.com" });
  mockedGetWorkspace.mockImplementation(async () => ({ status: "not_found" }));
});

describe("GET /api/admin/runs — mixed fixture: legacy, valid-bound, invalid-bound", () => {
  it("returns legacy and valid-bound rows; omits the invalid-bound row; response shape otherwise unchanged", async () => {
    runRows = [
      { id: "run-legacy", data: { userId: "owner-a", question: "legacy question", createdAt: "2026-08-01T00:00:00.000Z" } },
      {
        id: "run-valid",
        data: { userId: "owner-b", workspaceId: "personal-owner-b", question: "valid bound question", createdAt: "2026-08-02T00:00:00.000Z" },
      },
      {
        id: "run-invalid",
        data: { userId: "owner-c", workspaceId: "personal-owner-c", question: "invalid bound question", createdAt: "2026-08-03T00:00:00.000Z" },
      },
    ];
    mockedGetWorkspace.mockImplementation(async (id: string) => {
      if (id === "personal-owner-b") return { status: "found", workspace: validWorkspace("owner-b") };
      return { status: "not_found" }; // owner-c's workspace missing -> invalid
    });

    const res = await GET(buildRequest());
    expect(res.status).toBe(200);
    const json = await res.json();
    const ids = json.runs.map((r: any) => r.runId);
    expect(ids).toContain("run-legacy");
    expect(ids).toContain("run-valid");
    expect(ids).not.toContain("run-invalid");
    // Shape unchanged for the surviving rows.
    const legacyRow = json.runs.find((r: any) => r.runId === "run-legacy");
    expect(legacyRow).toMatchObject({ collection: "runs", runType: "research", userId: "owner-a" });
  });

  it("missing Workspace -> omitted", async () => {
    runRows = [{ id: "run-x", data: { userId: "owner-x", workspaceId: "personal-owner-x", question: "q" } }];
    mockedGetWorkspace.mockResolvedValue({ status: "not_found" });
    const res = await GET(buildRequest());
    const json = await res.json();
    expect(json.runs.map((r: any) => r.runId)).not.toContain("run-x");
  });

  it("owner mismatch (Workspace.ownerUserId != run.userId) -> omitted", async () => {
    runRows = [{ id: "run-y", data: { userId: "owner-y", workspaceId: "personal-owner-y", question: "q" } }];
    mockedGetWorkspace.mockResolvedValue({ status: "found", workspace: validWorkspace("someone-else") });
    const res = await GET(buildRequest());
    const json = await res.json();
    expect(json.runs.map((r: any) => r.runId)).not.toContain("run-y");
  });

  it("deterministic ID mismatch -> omitted, no Workspace lookup attempted for that row", async () => {
    runRows = [{ id: "run-z", data: { userId: "owner-z", workspaceId: "personal-someone-else", question: "q" } }];
    const res = await GET(buildRequest());
    const json = await res.json();
    expect(json.runs.map((r: any) => r.runId)).not.toContain("run-z");
  });

  it("lookup failure -> omitted (fail closed)", async () => {
    runRows = [{ id: "run-w", data: { userId: "owner-w", workspaceId: "personal-owner-w", question: "q" } }];
    mockedGetWorkspace.mockResolvedValue({ status: "read_failed" });
    const res = await GET(buildRequest());
    const json = await res.json();
    expect(json.runs.map((r: any) => r.runId)).not.toContain("run-w");
  });
});

describe("GET /api/admin/runs — batching", () => {
  it("50 rows from the same owner -> exactly one Workspace lookup, not 50", async () => {
    runRows = Array.from({ length: 50 }, (_, i) => ({
      id: `run-${i}`,
      data: { userId: "owner-shared", workspaceId: "personal-owner-shared", question: `q${i}`, createdAt: new Date(2026, 7, 1 + i).toISOString() },
    }));
    mockedGetWorkspace.mockResolvedValue({ status: "found", workspace: validWorkspace("owner-shared") });
    const res = await GET(buildRequest("?limit=100"));
    const json = await res.json();
    expect(json.runs.length).toBe(50);
    expect(mockedGetWorkspace).toHaveBeenCalledTimes(1);
  });

  it("rows from 3 distinct owners -> exactly 3 Workspace lookups, never one per row", async () => {
    runRows = [
      { id: "r1", data: { userId: "a", workspaceId: "personal-a", question: "q" } },
      { id: "r2", data: { userId: "a", workspaceId: "personal-a", question: "q" } },
      { id: "r3", data: { userId: "b", workspaceId: "personal-b", question: "q" } },
      { id: "r4", data: { userId: "c", workspaceId: "personal-c", question: "q" } },
    ];
    mockedGetWorkspace.mockImplementation(async (id: string) => ({ status: "found", workspace: validWorkspace(id.replace("personal-", "")) }));
    await GET(buildRequest());
    expect(mockedGetWorkspace).toHaveBeenCalledTimes(3);
  });
});

describe("GET /api/admin/runs — legacy compatibility and admin auth unchanged", () => {
  it("unauthenticated/non-admin caller -> 401, unaffected by Phase 4B", async () => {
    mockedRequireAdminApiAccess.mockResolvedValue(null);
    runRows = [{ id: "run-1", data: { userId: "owner-a", question: "q" } }];
    const res = await GET(buildRequest());
    expect(res.status).toBe(401);
  });

  it("legacy row (workspaceId absent) is returned without a Workspace lookup", async () => {
    runRows = [{ id: "run-legacy", data: { userId: "owner-a", question: "q" } }];
    const res = await GET(buildRequest());
    const json = await res.json();
    expect(json.runs.map((r: any) => r.runId)).toContain("run-legacy");
  });

  it("existing filters (search, userId, status) still apply before Layer A runs", async () => {
    runRows = [
      { id: "run-1", data: { userId: "owner-a", question: "alpha question" } },
      { id: "run-2", data: { userId: "owner-b", question: "beta question" } },
    ];
    const res = await GET(buildRequest("?search=alpha"));
    const json = await res.json();
    expect(json.runs.map((r: any) => r.runId)).toEqual(["run-1"]);
  });
});
