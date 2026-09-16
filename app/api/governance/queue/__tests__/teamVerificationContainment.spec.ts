/**
 * TEAM-VERIFICATION-PARITY-R1 — GET /api/governance/queue must never stage a
 * Workspace-bound Claim or Video artifact, in either the owner-scoped
 * (legacy reviewer / owner-visibility) loaders or the global governance-admin
 * loaders. The fake Firestore HONOURS `select()` projections, so a loader that
 * forgets to project `workspaceId` would see Team rows as Personal and fail
 * these tests.
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
jest.mock("@/lib/workspaces/runWorkspaceIntegrityBatch", () => ({
  createRunWorkspaceIntegrityBatch: () => async () => ({ classification: "legacy" }),
}));
jest.mock("@/lib/env", () => ({ WORKSPACES_ENABLED: true, ADMIN_EMAILS: "" }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

type Row = { id: string; data: Record<string, unknown> };
let claimRows: Row[] = [];
let videoRows: Row[] = [];
const usersRead: string[] = [];

function project(data: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) if (Object.prototype.hasOwnProperty.call(data, f)) out[f] = data[f];
  return out;
}
function snapFor(rows: Row[], fields: string[], ownerFilter?: string) {
  const selected = ownerFilter === undefined ? rows : rows.filter((r) => r.data.userId === ownerFilter);
  return { size: selected.length, docs: selected.map((r) => ({ id: r.id, data: () => project(r.data, fields) })) };
}

const mockAdminDb: any = {
  collection: (name: string) => {
    if (name === "verifications" || name === "videoVerifications") {
      const rows = () => (name === "verifications" ? claimRows : videoRows);
      return {
        // owner-scoped: where(userId==).select(...).limit().get()
        where: (_f: string, _op: string, owner: string) => ({
          select: (...fields: string[]) => ({ limit: () => ({ get: async () => snapFor(rows(), fields, owner) }) }),
        }),
        // global: orderBy().limit().select(...).get()
        orderBy: () => ({ limit: () => ({ select: (...fields: string[]) => ({ get: async () => snapFor(rows(), fields) }) }) }),
        limit: () => ({ select: (...fields: string[]) => ({ get: async () => snapFor(rows(), fields) }) }),
      };
    }
    if (name === "runs") {
      const empty = { size: 0, docs: [] };
      return {
        where: () => ({ orderBy: () => ({ limit: () => ({ select: () => ({ get: async () => empty }) }) }) }),
        orderBy: () => ({ limit: () => ({ select: () => ({ get: async () => empty }) }) }),
        limit: () => ({ select: () => ({ get: async () => empty }) }),
      };
    }
    if (name === "users") {
      return { doc: (id: string) => ({ get: async () => { usersRead.push(id); return { exists: false, data: () => undefined }; } }) };
    }
    return { doc: () => ({ get: async () => ({ exists: false, data: () => undefined }) }) };
  },
  getAll: async (...refs: any[]) => refs.map(() => ({ exists: false, data: () => undefined })),
};
jest.mock("@/lib/firebase/admin", () => ({ adminDb: mockAdminDb }));

import { Timestamp } from "firebase-admin/firestore";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/governance/queue/route";

const TEAM_CREATOR = "team-creator";
const PERSONAL_OWNER = "personal-owner";
const recent = () => Timestamp.fromMillis(Date.now() - 60_000);

function claim(id: string, owner: string, extra: Record<string, unknown> = {}): Row {
  return { id, data: { userId: owner, type: "claim_verification", claim: `Claim text ${id}`, governanceStatus: "needs_review", verdict: "accurate", timestamp: recent(), ...extra } };
}
function video(id: string, owner: string, extra: Record<string, unknown> = {}): Row {
  return { id, data: { userId: owner, type: "video_verification", fileName: `${id}.mp4`, governanceStatus: "needs_review", verdict: "authentic_captured", metadata: { duration: 5 }, timestamp: recent(), ...extra } };
}
const TEAM = { workspaceId: "ws-team-1", projectId: null };

type View = { label: string; viewerUid: string; visibleUserIds: string[] | null; queueScope: string };
const VIEWS: View[] = [
  { label: "owner-visibility view (viewer whose scope includes the creator)", viewerUid: "org-owner", visibleUserIds: [TEAM_CREATOR, PERSONAL_OWNER], queueScope: "owner" },
  { label: "assigned legacy reviewer", viewerUid: "legacy-reviewer", visibleUserIds: [TEAM_CREATOR, PERSONAL_OWNER], queueScope: "reviewer" },
  { label: "global governance admin", viewerUid: "gov-admin", visibleUserIds: null, queueScope: "admin_global" },
];

async function queue(view: View, qs = "?status=all") {
  mockedResolveGovernanceRequestUser.mockResolvedValueOnce({ ok: true, uid: view.viewerUid, email: `${view.viewerUid}@example.com` });
  mockedResolveVisibleUserIds.mockResolvedValueOnce({ ok: true, visibleUserIds: view.visibleUserIds, queueScope: view.queueScope, isSupportAdmin: view.visibleUserIds === null });
  const res = await GET(new NextRequest(`http://localhost/api/governance/queue${qs}`));
  return { status: res.status, body: await res.json() };
}
const runIds = (body: { runs: Array<{ runId: string }> }) => body.runs.map((r) => r.runId).sort();

beforeEach(() => {
  jest.clearAllMocks();
  claimRows = [];
  videoRows = [];
  usersRead.length = 0;
});

describe.each(VIEWS.map((v) => [v.label, v] as const))("%s", (_label, view) => {
  it("Team Claims are absent; Personal Claims remain", async () => {
    claimRows = [claim("vcl-team", TEAM_CREATOR, TEAM), claim("vcl-team-proj", TEAM_CREATOR, { workspaceId: "ws-team-1", projectId: "proj-1" }), claim("vcl-personal", PERSONAL_OWNER)];
    const { status, body } = await queue(view, "?status=all&runType=verification");
    expect(status).toBe(200);
    expect(runIds(body)).toEqual(["vcl-personal"]);
    expect(JSON.stringify(body)).not.toContain("Claim text vcl-team");
  });

  it("Team Videos are absent; Personal Videos remain", async () => {
    videoRows = [video("vid-team", TEAM_CREATOR, TEAM), video("vid-personal", PERSONAL_OWNER)];
    const { body } = await queue(view, "?status=all&runType=video");
    expect(runIds(body)).toEqual(["vid-personal"]);
    expect(JSON.stringify(body)).not.toContain("vid-team.mp4");
  });

  it("runType=all: both Team kinds absent, Personal kinds remain, and no owner-profile read happens for a Team-only creator", async () => {
    claimRows = [claim("vcl-team", TEAM_CREATOR, TEAM), claim("vcl-personal", PERSONAL_OWNER)];
    videoRows = [video("vid-team", TEAM_CREATOR, TEAM), video("vid-personal", PERSONAL_OWNER)];
    const { body } = await queue(view, "?status=all&runType=all");
    expect(runIds(body)).toEqual(["vcl-personal", "vid-personal"]);
    expect(body.total).toBe(2);
    expect(usersRead).not.toContain(TEAM_CREATOR);
  });

  it.each([["null", null], ["empty string", ""], ["malformed object", { id: "x" }]])(
    "malformed Workspace-bound rows (workspaceId %s) still fail closed out of the queue",
    async (_l, value) => {
      claimRows = [claim("vcl-malformed", TEAM_CREATOR, { workspaceId: value })];
      videoRows = [video("vid-malformed", TEAM_CREATOR, { workspaceId: value })];
      const { body } = await queue(view, "?status=all&runType=all");
      expect(body.runs).toEqual([]);
    }
  );

  it("status filter needs_review (default) also excludes unevaluated Team rows", async () => {
    claimRows = [claim("vcl-team-unevaluated", TEAM_CREATOR, { ...TEAM, governanceStatus: undefined }), claim("vcl-personal-unevaluated", PERSONAL_OWNER, { governanceStatus: undefined })];
    const { body } = await queue(view, "?runType=verification");
    expect(runIds(body)).toEqual(["vcl-personal-unevaluated"]);
  });
});
