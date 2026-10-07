/**
 * Roadmap 4.3b (D3) — `GET /api/teams/runs?version=1` never advertises an
 * adaptive review item the caller's role cannot open.
 *
 * Every adaptive detail route (`/api/teams/adaptive-runs/{runId}` and its
 * history / review-panel / assignment / votes reads) answers
 * `403 insufficient_role` to a non-admin Team member. The list and the detail
 * route are driven here through the REAL handlers, for each role, so parity is
 * asserted on their actual outcomes, not on a restated rule:
 *
 *   an adaptive item is listed for a caller  ⇔  that caller's detail request
 *   is not refused for role.
 *
 * Legacy items and the unversioned response are unchanged.
 */

const teamRunDocs = new Map<string, Record<string, any>>();
const pathStore = new Map<string, Record<string, any>>();

function makeDocRef(path: string): any {
  return {
    __path: path,
    path,
    id: path.split("/").pop(),
    get: async () => ({ exists: pathStore.has(path), data: () => pathStore.get(path) }),
    collection: (name: string) => ({ doc: (id: string) => makeDocRef(`${path}/${name}/${id}`) }),
  };
}

const mockAdminDb = {
  collection: (name: string) => {
    if (name === "teamRuns") {
      return {
        where: (field: string, _op: string, value: unknown) => ({
          get: async () => {
            const matches = [...teamRunDocs.entries()].filter(([, data]) => data[field] === value);
            return { docs: matches.map(([id, data]) => ({ id, data: () => data })) };
          },
        }),
        doc: (id: string) => makeDocRef(`teamRuns/${id}`),
      };
    }
    return { doc: (id: string) => makeDocRef(`${name}/${id}`) };
  },
  getAll: async (...refs: Array<{ __path: string }>) =>
    refs.map((ref) => ({ id: ref.__path.split("/").pop(), ref: { path: ref.__path }, exists: pathStore.has(ref.__path), data: () => pathStore.get(ref.__path) })),
};
jest.mock("@/lib/firebase/admin", () => ({ adminDb: mockAdminDb }));
jest.mock("@/lib/governance/reviewerIdentity", () => ({
  resolveReviewerDisplayNames: async (uids: string[]) => new Map(uids.map((u) => [u, `Name-${u}`])),
  UNKNOWN_REVIEWER_LABEL: "Unknown reviewer",
}));
jest.mock("@/lib/firestore/teamRuns", () => {
  const actual = jest.requireActual("@/lib/firestore/teamRuns");
  return {
    ...actual,
    // The detail route's deterministic projection lookup, served from the same rows the list reads.
    getAdaptiveTeamRunProjection: async (teamId: string, runId: string) => {
      const hit = [...teamRunDocs.values()].find((d) => d.teamId === teamId && d.runId === runId && d.adaptive === true);
      return hit ? { status: "found", projection: hit } : { status: "not_found" };
    },
  };
});

let callerUid = "member-uid";
let callerRole = "member";
jest.mock("@/lib/teams/teamApiAuth", () => ({
  getRequestUid: async () => callerUid,
  loadUserAndTeam: async () => ({ user: { email: `${callerUid}@test.com` }, team: { id: TEAM_ID, members: [] } }),
  memberRole: () => callerRole,
  // The real role rule, so list and detail are judged by the same predicate.
  isTeamAdmin: jest.requireActual("@/lib/teams/teamApiAuth").isTeamAdmin,
}));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { NextRequest } from "next/server";
import { GET as listGET } from "@/app/api/teams/runs/route";
import { GET as detailGET } from "@/app/api/teams/adaptive-runs/[runId]/route";

const TEAM_ID = "team-1";

function adaptiveRow(runId: string, owner: string) {
  pathStore.set(`runs/${runId}`, { userId: owner });
  return {
    teamId: TEAM_ID,
    userId: owner,
    projectionVersion: 1,
    adaptive: true,
    runId,
    schemaId: "decision_support",
    answerShape: "decision_support_view",
    receiptConclusion: "c",
    sourceBacked: true,
    humanReviewNeeded: true,
    automatedGovernanceStatus: "flagged",
    humanReviewStatus: "unreviewed",
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
  };
}
function legacyRow(runId: string, owner: string) {
  pathStore.set(`runs/${runId}`, { userId: owner });
  return {
    runId,
    teamId: TEAM_ID,
    userId: owner,
    userEmail: `${owner}@test.com`,
    type: "research",
    query: "q",
    consensusScore: 40,
    policyFlags: ["weak_evidence"],
    timestamp: { toMillis: () => Date.parse("2026-07-27T00:00:00.000Z") },
  };
}

async function listV1(): Promise<{ items: Array<{ kind: string; teamRunId: string; runId?: string }>; pagination: { total: number } }> {
  const res = await listGET(new NextRequest("http://localhost/api/teams/runs?version=1"));
  expect(res.status).toBe(200);
  return res.json();
}
async function detailCode(runId: string): Promise<{ status: number; code: string | undefined }> {
  const res = await detailGET(new NextRequest(`http://localhost/api/teams/adaptive-runs/${runId}`), { params: { runId } });
  const body = await res.json();
  return { status: res.status, code: body?.error?.code };
}

beforeEach(() => {
  teamRunDocs.clear();
  pathStore.clear();
  // The member's OWN adaptive and legacy rows, plus another member's adaptive row.
  teamRunDocs.set("a-mine", adaptiveRow("run-a-mine", "member-uid"));
  teamRunDocs.set("a-theirs", adaptiveRow("run-a-theirs", "other-uid"));
  teamRunDocs.set("l-mine", legacyRow("run-l-mine", "member-uid"));
});

const ROLES: Array<[string, string, string, boolean]> = [
  ["owner", "owner-uid", "owner", true],
  ["admin", "admin-uid", "admin", true],
  ["member", "member-uid", "member", false],
];

describe.each(ROLES)("%s", (_label, uid, role, isAdmin) => {
  beforeEach(() => {
    callerUid = uid;
    callerRole = role;
  });

  it("every adaptive item it is listed can be opened (not refused for role)", async () => {
    const body = await listV1();
    const adaptive = body.items.filter((i) => i.kind === "adaptive");
    expect(adaptive.length > 0).toBe(isAdmin);
    for (const item of adaptive) {
      const runId = item.runId ?? teamRunDocs.get(item.teamRunId)?.runId;
      const d = await detailCode(runId);
      expect(d.code).not.toBe("insufficient_role");
    }
  });

  it("for each adaptive run in its scope: listed ⇔ detail not refused for role", async () => {
    const listed = new Set((await listV1()).items.filter((i) => i.kind === "adaptive").map((i) => i.teamRunId));
    const inScope = isAdmin ? ["a-mine", "a-theirs"] : ["a-mine"];
    for (const id of inScope) {
      const d = await detailCode(teamRunDocs.get(id)!.runId);
      expect(listed.has(id)).toBe(d.code !== "insufficient_role");
    }
  });
});

describe("member", () => {
  beforeEach(() => {
    callerUid = "member-uid";
    callerRole = "member";
  });

  it("their own adaptive run is refused by the detail route — and is no longer listed", async () => {
    expect(await detailCode("run-a-mine")).toEqual({ status: 403, code: "insufficient_role" });
    const body = await listV1();
    expect(body.items.map((i) => i.teamRunId)).toEqual(["l-mine"]);
  });

  it("hidden adaptive items do not count toward pagination.total", async () => {
    const body = await listV1();
    expect(body.pagination.total).toBe(1);
  });

  it("their own legacy items are still listed", async () => {
    const body = await listV1();
    expect(body.items).toEqual([expect.objectContaining({ kind: "legacy", teamRunId: "l-mine" })]);
  });

  it("the unversioned response is unchanged (still returns the member's own rows of both kinds)", async () => {
    const res = await listGET(new NextRequest("http://localhost/api/teams/runs"));
    const body = await res.json();
    const ids = (body.runs as Array<{ id: string }>).map((r) => r.id).sort();
    expect(ids).toEqual(["a-mine", "l-mine"]);
  });
});
