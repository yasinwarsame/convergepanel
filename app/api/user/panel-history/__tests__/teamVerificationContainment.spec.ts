/**
 * TEAM-VERIFICATION-PARITY-R1 — GET /api/user/panel-history must never
 * surface a Workspace-bound Claim or Video artifact, even to its own creator.
 * Team artifacts share `verifications` / `videoVerifications` with Personal
 * ones and are distinguished ONLY by the presence of a `workspaceId` field.
 */

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({
  resolveRequestIdentity: (...args: unknown[]) => mockedResolveRequestIdentity(...args),
}));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock("@/lib/workspaces/runWorkspaceIntegrityBatch", () => ({
  createRunWorkspaceIntegrityBatch: () => async () => ({ classification: "legacy" }),
}));

type Row = { id: string; data: Record<string, unknown> };
let claimRows: Row[] = [];
let videoRows: Row[] = [];

jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return {
      collection: (name: string) => ({
        where: () => ({
          orderBy: () => ({
            limit: () => ({
              get: async () => {
                const rows = name === "verifications" ? claimRows : name === "videoVerifications" ? videoRows : [];
                return { docs: rows.map((r) => ({ id: r.id, data: () => r.data })) };
              },
            }),
          }),
        }),
      }),
    };
  },
}));

import { Timestamp } from "firebase-admin/firestore";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/user/panel-history/route";

const UID = "creator-uid";
const T0 = Date.parse("2026-09-10T12:00:00.000Z");
const ts = (offsetMinutes: number) => Timestamp.fromMillis(T0 + offsetMinutes * 60_000);

function claim(id: string, minute: number, extra: Record<string, unknown> = {}): Row {
  return {
    id,
    data: { userId: UID, type: "claim_verification", claim: `Claim ${id}`, verdict: "accurate", consensusScore: 80, governanceStatus: "approved", timestamp: ts(minute), ...extra },
  };
}
function video(id: string, minute: number, extra: Record<string, unknown> = {}): Row {
  return {
    id,
    data: { userId: UID, type: "video_verification", fileName: `${id}.mp4`, verdict: "authentic_captured", consensusScore: 70, metadata: { duration: 12 }, timestamp: ts(minute), ...extra },
  };
}
const team = { workspaceId: "ws-team-1", projectId: null };

async function history(query = "") {
  const res = await GET(new NextRequest(`http://localhost/api/user/panel-history${query}`));
  return { status: res.status, body: await res.json() };
}
const ids = (body: { items: Array<{ id: string }> }) => body.items.map((i) => i.id);

beforeEach(() => {
  jest.clearAllMocks();
  claimRows = [];
  videoRows = [];
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: UID, source: "session_cookie" });
});

describe("Claim history containment", () => {
  it("a Personal Claim appears with its exact Personal DTO", async () => {
    claimRows = [claim("vcl-personal", 1)];
    const { status, body } = await history();
    expect(status).toBe(200);
    expect(body.items).toEqual([
      { type: "verification", id: "vcl-personal", at: new Date(T0 + 60_000).toISOString(), claim: "Claim vcl-personal", verdict: "accurate", consensusScore: 80, governanceStatus: "approved" },
    ]);
  });

  it("a Team Claim by the SAME creator never appears", async () => {
    claimRows = [claim("vcl-team", 1, team)];
    const { body } = await history();
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
    expect(JSON.stringify(body)).not.toContain("Claim vcl-team");
  });

  it("mixed Personal + Team Claims -> only Personal, total excludes Team", async () => {
    claimRows = [claim("vcl-team-a", 5, team), claim("vcl-personal-a", 4), claim("vcl-team-b", 3, { workspaceId: "ws-team-2", projectId: "proj-9" }), claim("vcl-personal-b", 2)];
    const { body } = await history();
    expect(ids(body)).toEqual(["vcl-personal-a", "vcl-personal-b"]);
    expect(body.total).toBe(2);
  });

  it("workspaceId: null is Workspace-bound and excluded", async () => {
    claimRows = [claim("vcl-null-ws", 1, { workspaceId: null, projectId: null }), claim("vcl-personal", 0)];
    const { body } = await history();
    expect(ids(body)).toEqual(["vcl-personal"]);
  });

  it.each([["empty string", ""], ["number", 7], ["object", { id: "ws" }]])("malformed workspaceId (%s) is excluded", async (_l, value) => {
    claimRows = [claim("vcl-malformed", 1, { workspaceId: value })];
    const { body } = await history();
    expect(body.items).toEqual([]);
  });

  it("a projectId-only Personal Claim (origin-linked) stays Personal", async () => {
    claimRows = [claim("vcl-origin-personal", 1, { projectId: "proj-personal", origin: { type: "deep_research_claim", runId: "run-1", claimId: "c" } })];
    const { body } = await history();
    expect(ids(body)).toEqual(["vcl-origin-personal"]);
  });
});

describe("Video history containment", () => {
  it("a Personal Video appears with its exact Personal DTO", async () => {
    videoRows = [video("vid-personal", 1, { governanceStatus: "needs_review" })];
    const { body } = await history();
    expect(body.items).toEqual([
      { type: "video_verification", id: "vid-personal", at: new Date(T0 + 60_000).toISOString(), fileName: "vid-personal.mp4", durationSeconds: 12, verdict: "authentic_captured", consensusScore: 70, governanceStatus: "needs_review" },
    ]);
  });

  it("a Team Video by the SAME creator never appears", async () => {
    videoRows = [video("vid-team", 1, team)];
    const { body } = await history();
    expect(body.items).toEqual([]);
    expect(JSON.stringify(body)).not.toContain("vid-team.mp4");
  });

  it("mixed Personal + Team Videos -> only Personal", async () => {
    videoRows = [video("vid-team", 3, team), video("vid-personal", 2), video("vid-null", 1, { workspaceId: null })];
    const { body } = await history();
    expect(ids(body)).toEqual(["vid-personal"]);
    expect(body.total).toBe(1);
  });
});

describe("paging is computed from the filtered Personal set", () => {
  it("total and hasMore ignore Team rows across both collections", async () => {
    claimRows = [claim("vcl-team-1", 10, team), claim("vcl-p1", 9), claim("vcl-team-2", 8, team), claim("vcl-p2", 7)];
    videoRows = [video("vid-team-1", 6, team), video("vid-p1", 5)];
    const page1 = await history("?page=1&limit=2");
    expect(ids(page1.body)).toEqual(["vcl-p1", "vcl-p2"]);
    expect(page1.body.total).toBe(3);
    expect(page1.body.hasMore).toBe(true);
    const page2 = await history("?page=2&limit=2");
    expect(ids(page2.body)).toEqual(["vid-p1"]);
    expect(page2.body.total).toBe(3);
    expect(page2.body.hasMore).toBe(false);
  });

  it("a page made only of Team rows reports an empty Personal history", async () => {
    claimRows = [claim("vcl-team-1", 2, team), claim("vcl-team-2", 1, team)];
    videoRows = [video("vid-team-1", 0, team)];
    const { body } = await history("?page=1&limit=2");
    expect(body.items).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.hasMore).toBe(false);
  });
});

describe("auth unchanged", () => {
  it("missing credentials -> 401 unauthorized; invalid bearer -> 401 auth_error", async () => {
    mockedResolveRequestIdentity.mockResolvedValueOnce({ status: "unauthenticated", reason: "missing_credentials" });
    expect((await history()).body.errorCode).toBe("unauthorized");
    mockedResolveRequestIdentity.mockResolvedValueOnce({ status: "unauthenticated", reason: "invalid_bearer_token" });
    const r = await history();
    expect(r.status).toBe(401);
    expect(r.body.errorCode).toBe("auth_error");
  });
});
