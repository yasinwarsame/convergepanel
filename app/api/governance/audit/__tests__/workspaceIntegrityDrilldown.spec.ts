/**
 * Phase 4B security completion — GET /api/governance/audit drilldown mode
 * (?runId=&collection=runs). A security re-review found this route (and
 * governance/queue, governance/review) disclose canonical run content
 * (question text, audit events referencing it) gated only by this route's
 * own reviewer-visibility model — an existing Layer-B grant, never an
 * exemption from Workspace integrity Layer A.
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

const runDocs = new Map<string, Record<string, unknown>>();
const workspaceDocs = new Map<string, Record<string, unknown>>();
const mockAdminDb: any = {
  collection: (name: string) => {
    if (name === "runs" || name === "verifications" || name === "videoVerifications") {
      return {
        doc: (id: string) => ({
          get: async () => {
            const data = runDocs.get(id);
            return { exists: !!data, data: () => data };
          },
          collection: () => ({
            orderBy: () => ({ limit: () => ({ get: async () => ({ docs: [] }) }) }),
            get: async () => ({ docs: [] }),
          }),
        }),
      };
    }
    if (name === "admin_audit_logs") {
      return {
        where: () => ({ limit: () => ({ select: () => ({ get: async () => ({ docs: [] }) }) }) }),
      };
    }
    return { doc: () => ({ get: async () => ({ exists: false }) }) };
  },
};
jest.mock("@/lib/firebase/admin", () => ({ adminDb: mockAdminDb }));

const mockedGetWorkspace = jest.fn();
jest.mock("@/lib/firestore/workspaces", () => ({ getWorkspace: (...args: any[]) => mockedGetWorkspace(...args) }));
jest.mock("@/lib/env", () => ({ WORKSPACES_ENABLED: true }));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/governance/audit/route";

const VIEWER_UID = "reviewer-uid";

function buildRequest(runId: string, collection = "runs"): NextRequest {
  return new NextRequest(`http://localhost/api/governance/audit?runId=${runId}&collection=${collection}`);
}

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

beforeEach(() => {
  runDocs.clear();
  workspaceDocs.clear();
  jest.clearAllMocks();
  mockedResolveGovernanceRequestUser.mockResolvedValue({ ok: true, uid: VIEWER_UID, email: "reviewer@test.com" });
  mockedResolveVisibleUserIds.mockResolvedValue({ ok: true, visibleUserIds: null, isSupportAdmin: true, queueScope: "admin_global" });
  mockedGetWorkspace.mockImplementation(async () => ({ status: "not_found" }));
});

describe("GET /api/governance/audit — drilldown Workspace integrity", () => {
  it("legacy run (workspaceId absent) -> allowed, no Workspace lookup", async () => {
    runDocs.set("run-1", { userId: "owner-a", question: "q" });
    const res = await GET(buildRequest("run-1"));
    expect(res.status).toBe(200);
    expect(mockedGetWorkspace).not.toHaveBeenCalled();
  });

  it("valid bound run -> allowed", async () => {
    workspaceDocs.set("personal-owner-a", validWorkspace("owner-a"));
    mockedGetWorkspace.mockImplementation(async (id: string) =>
      workspaceDocs.has(id) ? { status: "found", workspace: workspaceDocs.get(id) } : { status: "not_found" }
    );
    runDocs.set("run-2", { userId: "owner-a", workspaceId: "personal-owner-a", question: "q" });
    const res = await GET(buildRequest("run-2"));
    expect(res.status).toBe(200);
  });

  it("invalid bound run -> 404, denied even though reviewer visibility would otherwise allow it", async () => {
    runDocs.set("run-3", { userId: "owner-a", workspaceId: "personal-owner-a", question: "q" });
    // No workspace seeded -> not_found -> invalid
    const res = await GET(buildRequest("run-3"));
    expect(res.status).toBe(404);
  });

  it("verifications/videoVerifications collection never triggers a Workspace lookup", async () => {
    runDocs.set("ver-1", { userId: "owner-a", claim: "q" });
    await GET(buildRequest("ver-1", "verifications"));
    expect(mockedGetWorkspace).not.toHaveBeenCalled();
  });
});
