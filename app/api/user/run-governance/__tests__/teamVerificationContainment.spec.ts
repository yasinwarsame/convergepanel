/**
 * TEAM-VERIFICATION-PARITY-R1 — GET /api/user/run-governance is a Personal
 * route. A Workspace-bound Claim/Video artifact is concealed exactly like a
 * missing document for EVERY caller (creator, non-creator, removed member),
 * before the owner comparison and before any reviewer enrichment.
 */

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({
  resolveRequestIdentity: (...args: unknown[]) => mockedResolveRequestIdentity(...args),
}));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
const mockedValidateRunWorkspaceAssociation = jest.fn();
jest.mock("@/lib/workspaces/runWorkspaceIntegrity", () => ({
  validateRunWorkspaceAssociation: (...args: unknown[]) => mockedValidateRunWorkspaceAssociation(...args),
}));

const docs = new Map<string, Record<string, unknown>>();
const collectionsRead: string[] = [];
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return {
      collection: (name: string) => ({
        doc: (id: string) => ({
          get: async () => {
            collectionsRead.push(name);
            const data = docs.get(`${name}/${id}`);
            return { exists: !!data, data: () => data };
          },
        }),
      }),
    };
  },
}));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/user/run-governance/route";

const CREATOR = "creator-uid";
const OTHER = "other-uid";
const CONCEALED = { status: 404, body: { ok: false, errorCode: "not_found", message: "Document not found." } };

const governed = {
  governanceStatus: "needs_review",
  governanceReasons: ["Low consensus"],
  governanceReviewedBy: "reviewer-uid",
  governanceReviewedAt: "2026-09-10T00:00:00.000Z",
  governanceReviewComment: "secret reviewer comment",
};

async function read(uid: string, id: string, collection: string) {
  mockedResolveRequestIdentity.mockResolvedValueOnce({ status: "authenticated", uid, source: "session_cookie" });
  const res = await GET(new NextRequest(`http://localhost/api/user/run-governance?runId=${id}&collection=${collection}`));
  return { status: res.status, body: await res.json() };
}

beforeEach(() => {
  jest.clearAllMocks();
  docs.clear();
  collectionsRead.length = 0;
  docs.set("users/reviewer-uid", { email: "reviewer@example.com" });
  mockedValidateRunWorkspaceAssociation.mockResolvedValue({ classification: "legacy" });
});

describe.each(["verifications", "videoVerifications"])("%s — Workspace-bound artifact", (collection) => {
  it("Team creator -> concealed 404, no governance fields, no reviewer enrichment", async () => {
    docs.set(`${collection}/art-1`, { userId: CREATOR, workspaceId: "ws-1", projectId: null, ...governed });
    const r = await read(CREATOR, "art-1", collection);
    expect(r).toEqual(CONCEALED);
    expect(JSON.stringify(r.body)).not.toContain("secret reviewer comment");
    expect(collectionsRead).toEqual([collection]);
  });

  it("non-creator receives the SAME concealed 404 (no forbidden/not-found oracle)", async () => {
    docs.set(`${collection}/art-1`, { userId: CREATOR, workspaceId: "ws-1", projectId: "proj-1", ...governed });
    expect(await read(OTHER, "art-1", collection)).toEqual(CONCEALED);
    expect(await read(OTHER, "missing", collection)).toEqual(CONCEALED);
  });

  it("a creator who was removed from the Workspace still gets the concealed 404 (no membership lookup exists here)", async () => {
    docs.set(`${collection}/art-1`, { userId: CREATOR, workspaceId: "ws-removed", projectId: null, ...governed });
    expect(await read(CREATOR, "art-1", collection)).toEqual(CONCEALED);
    expect(collectionsRead.every((c) => c === collection)).toBe(true);
  });

  it.each([["null", null], ["empty string", ""], ["number", 3]])("workspaceId %s -> concealed", async (_l, value) => {
    docs.set(`${collection}/art-1`, { userId: CREATOR, workspaceId: value, ...governed });
    expect(await read(CREATOR, "art-1", collection)).toEqual(CONCEALED);
  });

  it("Personal owner still gets the normal governance result", async () => {
    docs.set(`${collection}/art-2`, { userId: CREATOR, ...governed });
    const r = await read(CREATOR, "art-2", collection);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      ok: true,
      governanceStatus: "needs_review",
      governanceReasons: ["Low consensus"],
      governanceReviewedBy: "reviewer-uid",
      governanceReviewerEmail: "reviewer@example.com",
      governanceReviewedAt: "2026-09-10T00:00:00.000Z",
      governanceReviewComment: "secret reviewer comment",
    });
  });

  it("Personal projectId-only (origin-linked) row is still Personal", async () => {
    docs.set(`${collection}/art-3`, { userId: CREATOR, projectId: "proj-personal", governanceStatus: "approved" });
    const r = await read(CREATOR, "art-3", collection);
    expect(r.status).toBe(200);
    expect(r.body.governanceStatus).toBe("approved");
  });

  it("Personal non-owner behaviour is unchanged (403 forbidden)", async () => {
    docs.set(`${collection}/art-2`, { userId: CREATOR, ...governed });
    expect(await read(OTHER, "art-2", collection)).toEqual({ status: 403, body: { ok: false, errorCode: "forbidden", message: "Access denied." } });
  });
});

describe("runs collection is untouched by the verification scope rule", () => {
  it("a Workspace-bound run still goes through the existing Phase 4B integrity path", async () => {
    docs.set("runs/run-1", { userId: CREATOR, workspaceId: "personal-creator-uid", governanceStatus: "approved" });
    const r = await read(CREATOR, "run-1", "runs");
    expect(r.status).toBe(200);
    expect(mockedValidateRunWorkspaceAssociation).toHaveBeenCalledTimes(1);
  });
});

describe("auth unchanged", () => {
  it("missing credentials -> 401 unauthorized; invalid bearer -> 401 auth_error", async () => {
    mockedResolveRequestIdentity.mockResolvedValueOnce({ status: "unauthenticated", reason: "missing_credentials" });
    let res = await GET(new NextRequest("http://localhost/api/user/run-governance?runId=a&collection=verifications"));
    expect(res.status).toBe(401);
    expect((await res.json()).errorCode).toBe("unauthorized");
    mockedResolveRequestIdentity.mockResolvedValueOnce({ status: "unauthenticated", reason: "invalid_bearer_token" });
    res = await GET(new NextRequest("http://localhost/api/user/run-governance?runId=a&collection=verifications"));
    expect(res.status).toBe(401);
    expect((await res.json()).errorCode).toBe("auth_error");
  });
});
