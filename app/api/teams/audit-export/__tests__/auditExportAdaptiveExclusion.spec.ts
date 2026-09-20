/**
 * Query-Routing Redesign, Phase 2A, Step 7, Part E1 — legacy audit-export
 * tests, focused on the new explicit adaptive-row exclusion
 * (docs/governance-decision-receipts-design.md §25.25). The rest of the
 * route's existing behavior had no prior test coverage (§24.5) and is
 * otherwise unchanged by this step.
 */

const teamRunDocs = new Map<string, Record<string, any>>();
/**
 * Phase 1 Cross-Authority READ Guard — the export now classifies each row's
 * canonical artifact before rendering it, so the fake must serve `runs/{id}`
 * lookups too. Snapshots carry `id`, as real ones do: association is by
 * identity, never by position.
 */
const canonicalDocs = new Map<string, Record<string, any>>();

const mockAdminDb: any = {
  collection: (name: string) => ({
    where: (field: string, _op: string, value: unknown) => ({
      get: async () => {
        const matches = [...teamRunDocs.entries()].filter(([, data]) => data[field] === value);
        return { docs: matches.map(([id, data]) => ({ id, data: () => data })) };
      },
    }),
    doc: (id: string) => ({ __path: `${name}/${id}`, __id: id, path: `${name}/${id}` }),
  }),
  getAll: async (...refs: Array<{ __path: string; __id: string }>) =>
    refs.map((ref) => ({ id: ref.__id, ref: { path: ref.__path }, exists: canonicalDocs.has(ref.__path), data: () => canonicalDocs.get(ref.__path) })),
};

jest.mock("@/lib/firebase/admin", () => ({
  adminDb: mockAdminDb,
}));

const mockedGetRequestUid = jest.fn();
const mockedLoadUserAndTeam = jest.fn();
const mockedMemberRole = jest.fn();
const mockedIsTeamAdmin = jest.fn();
jest.mock("@/lib/teams/teamApiAuth", () => ({
  getRequestUid: (...args: any[]) => mockedGetRequestUid(...args),
  loadUserAndTeam: (...args: any[]) => mockedLoadUserAndTeam(...args),
  memberRole: (...args: any[]) => mockedMemberRole(...args),
  isTeamAdmin: (...args: any[]) => mockedIsTeamAdmin(...args),
}));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/teams/audit-export/route";

const TEAM_ID = "team-1";

function fakeTimestamp(iso: string) {
  return { toMillis: () => new Date(iso).getTime() };
}

let legacyRunSeq = 0;
function legacyDoc(overrides: Record<string, unknown> = {}) {
  // A classic row always names exactly one canonical artifact; seed its run.
  const runId = typeof overrides.runId === "string" ? overrides.runId : `legacy-run-${++legacyRunSeq}`;
  if (!canonicalDocs.has(`runs/${runId}`)) canonicalDocs.set(`runs/${runId}`, { userId: "owner-uid" });
  return {
    runId,
    teamId: TEAM_ID,
    userEmail: "owner@test.com",
    type: "research",
    query: "A legacy query",
    verdict: "Confirmed",
    consensusScore: 80,
    policyFlags: [],
    humanDecision: null,
    timestamp: fakeTimestamp("2026-07-27T00:00:00.000Z"),
    ...overrides,
  };
}

function adaptiveDoc(overrides: Record<string, unknown> = {}) {
  return {
    teamId: TEAM_ID,
    adaptive: true,
    projectionVersion: 1,
    runId: "run-1",
    schemaId: "decision_support",
    answerShape: "decision_support_view",
    receiptConclusion: "Sensitive adaptive conclusion that must never be exported.",
    sourceBacked: true,
    humanReviewNeeded: false,
    humanReviewStatus: "unreviewed",
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
    ...overrides,
  };
}

function buildRequest(qs = ""): NextRequest {
  return new NextRequest(`http://localhost/api/teams/audit-export${qs}`);
}

beforeEach(() => {
  teamRunDocs.clear();
  canonicalDocs.clear();
  legacyRunSeq = 0;
  mockedGetRequestUid.mockReset();
  mockedLoadUserAndTeam.mockReset();
  mockedMemberRole.mockReset();
  mockedIsTeamAdmin.mockReset();

  mockedGetRequestUid.mockResolvedValue("caller-uid");
  mockedLoadUserAndTeam.mockResolvedValue({ user: {}, team: { id: TEAM_ID } });
  mockedMemberRole.mockReturnValue("admin");
  mockedIsTeamAdmin.mockReturnValue(true);
});

describe("GET /api/teams/audit-export — adaptive exclusion", () => {
  it("still exports valid legacy rows (JSON)", async () => {
    teamRunDocs.set("l1", legacyDoc());
    const res = await GET(buildRequest());
    const body = JSON.parse(await res.text());
    expect(body).toHaveLength(1);
    expect(body[0].runId).toBe("l1");
  });

  it("intentionally excludes adaptive rows from the export", async () => {
    teamRunDocs.set("l1", legacyDoc());
    teamRunDocs.set("a1", adaptiveDoc());
    const res = await GET(buildRequest());
    const body = JSON.parse(await res.text());
    expect(body).toHaveLength(1);
    expect(body[0].runId).toBe("l1");
  });

  it("never includes adaptive receipt content anywhere in the export, even if present in the collection", async () => {
    teamRunDocs.set("a1", adaptiveDoc());
    const res = await GET(buildRequest());
    const text = await res.text();
    expect(text).not.toContain("Sensitive adaptive conclusion");
  });

  it("a malformed adaptive-shaped row does not break the export", async () => {
    teamRunDocs.set("a1", adaptiveDoc({ schemaId: "garbage" }));
    teamRunDocs.set("l1", legacyDoc());
    const res = await GET(buildRequest());
    expect(res.status).toBe(200);
    const body = JSON.parse(await res.text());
    expect(body).toHaveLength(1);
  });

  it("preserves the existing legacy CSV column contract unchanged", async () => {
    teamRunDocs.set("l1", legacyDoc());
    const res = await GET(buildRequest("?format=csv"));
    const text = await res.text();
    const header = text.split("\n")[0];
    expect(header).toBe(
      "runId,timestamp,userEmail,type,queryTruncated,verdict,consensusScore,policyFlags,humanDecisionAction,humanDecisionNotes"
    );
  });

  it("excludes adaptive rows from the CSV export too", async () => {
    teamRunDocs.set("l1", legacyDoc());
    teamRunDocs.set("a1", adaptiveDoc());
    const res = await GET(buildRequest("?format=csv"));
    const text = await res.text();
    const lines = text.trim().split("\n");
    expect(lines).toHaveLength(2); // header + 1 legacy row
  });
});
