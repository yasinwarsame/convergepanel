/**
 * PHASE 1 REVIEW STACK CROSS-AUTHORITY READ GUARD — `GET /api/teams/runs`.
 *
 * WHAT THIS CLOSES. PR #186 made Workspace authority exclusive over a
 * Workspace-bound run's review-panel MUTATION. Reads were untouched, and
 * `app/api/teams/**` had no Workspace awareness at all. Because
 * `lib/runPanelExecution.ts` writes a legacy `teamRuns` projection whenever the
 * run OWNER belongs to a legacy team with adaptive review enabled — with no
 * `workspaceId` condition — a Workspace-bound run routinely also has a legacy
 * projection. A legacy Team ADMIN holding no Workspace capability could then
 * read that run's canonical reviewer identities, per-reviewer vote decisions,
 * assignment metadata, panel status/quorum/counts, canonical human-review
 * status and answer-derived `receiptConclusion` straight out of this queue.
 *
 * THE FIXTURE'S SHAPE. Every row below is a real `teamRuns` projection for the
 * SAME legacy team, and the caller is the strongest legitimate legacy actor —
 * a Team admin. The ONLY thing that differs between a visible row and a hidden
 * one is the canonical run document's Workspace binding, so an exclusion can
 * only be attributable to that binding.
 *
 * Every hidden-row test also asserts the canonical review documents were never
 * READ, not merely that they were absent from the JSON: a guard that fetches
 * reviewer identities and votes and then omits them from the response has not
 * closed a disclosure, it has only stopped printing it.
 */

const teamRunDocs = new Map<string, Record<string, any>>();
const pathStore = new Map<string, Record<string, any>>();
/** Every canonical path this request actually read — the evidence for "never fetched", not just "never rendered". */
const readPaths: string[] = [];
let getAllShouldThrow = false;

function makeDocRef(path: string): any {
  return {
    __path: path,
    id: path.split("/").pop(),
    get: async () => {
      readPaths.push(path);
      return { exists: pathStore.has(path), data: () => pathStore.get(path) };
    },
    collection: (name: string) => makeCollectionRef(`${path}/${name}`),
  };
}

function makeCollectionRef(path: string): any {
  return { doc: (id: string) => makeDocRef(`${path}/${id}`) };
}

const mockAdminDb: any = {
  collection: (name: string) => {
    if (name === "teamRuns") {
      return {
        where: (field: string, _op: string, value: unknown) => ({
          get: async () => {
            const matches = [...teamRunDocs.entries()].filter(([, data]) => data[field] === value);
            return { docs: matches.map(([id, data]) => ({ id, data: () => data })) };
          },
        }),
      };
    }
    return makeCollectionRef(name);
  },
  getAll: async (...refs: Array<{ __path: string }>) => {
    if (getAllShouldThrow) throw new Error("batch read boom");
    refs.forEach((r) => readPaths.push(r.__path));
    // A real DocumentSnapshot always carries `id`; the read guard associates
    // results by identity rather than array position, so the fake must too.
    return refs.map((ref) => ({ id: ref.__path.split("/").pop(), exists: pathStore.has(ref.__path), data: () => pathStore.get(ref.__path) }));
  },
};

jest.mock("@/lib/firebase/admin", () => ({ adminDb: mockAdminDb }));

const mockedResolveReviewerDisplayNames = jest.fn();
jest.mock("@/lib/governance/reviewerIdentity", () => ({
  resolveReviewerDisplayNames: (...args: any[]) => mockedResolveReviewerDisplayNames(...args),
  UNKNOWN_REVIEWER_LABEL: "Unknown reviewer",
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

jest.mock("@/lib/logger", () => ({
  logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { NextRequest } from "next/server";
import { GET } from "@/app/api/teams/runs/route";

const TEAM_ID = "team-1";
const OWNER = "owner-uid";

function fakeTimestamp(iso: string) {
  return { toMillis: () => new Date(iso).getTime() };
}

function adaptiveRow(runId: string, overrides: Record<string, unknown> = {}) {
  return {
    teamId: TEAM_ID,
    userId: OWNER,
    projectionVersion: 1,
    adaptive: true,
    runId,
    schemaId: "decision_support",
    answerShape: "decision_support_view",
    receiptConclusion: `Conclusion for ${runId}.`,
    sourceBacked: true,
    humanReviewNeeded: false,
    automatedGovernanceStatus: "flagged",
    humanReviewStatus: "unreviewed",
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-29T00:00:00.000Z",
    ...overrides,
  };
}

function legacyRow(overrides: Record<string, unknown> = {}) {
  return {
    teamId: TEAM_ID,
    userId: OWNER,
    userEmail: "owner@test.com",
    type: "research",
    query: "What is the best CRM for a 20-person sales team?",
    consensusScore: 40,
    policyFlags: ["weak_evidence"],
    timestamp: fakeTimestamp("2026-07-27T00:00:00.000Z"),
    ...overrides,
  };
}

/** A canonical run document. `binding` is spread last so a test can express exactly one difference. */
function setRun(runId: string, binding: Record<string, unknown> = {}) {
  pathStore.set(`runs/${runId}`, {
    userId: OWNER,
    governanceRecord: {
      version: 1,
      schemaId: "decision_support",
      answerShape: "decision_support_view",
      adaptiveOutputVersion: 1,
      humanReview: { status: "unreviewed" },
      decisionReceipt: {
        conclusion: "c",
        basis: [],
        assumptions: [],
        uncertainties: [],
        limitations: [],
        sources: [],
        sourceBacked: false,
        humanReviewNeeded: false,
      },
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    },
    ...binding,
  });
}

/**
 * A canonical Claim verification artifact. Personal and Team Claims share the
 * `verifications` collection; ONLY the Team writer persists `workspaceId`, so
 * field presence is the scope discriminator (`verificationArtifactScope.ts`).
 */
function setVerification(verificationId: string, binding: Record<string, unknown> = {}) {
  pathStore.set(`verifications/${verificationId}`, { claimText: "c", ...binding });
}

/** Canonical Workspace-governed review state — what a legacy caller must never reach. */
function setWorkspaceReviewState(runId: string) {
  pathStore.set(`runs/${runId}/humanReviewPanel/current`, {
    schemaVersion: 1,
    kind: "adaptive_review_panel",
    teamId: TEAM_ID,
    runId,
    mode: "majority_quorum",
    reviewerUserIds: ["ws-reviewer-alice", "ws-reviewer-bob"],
    requiredReviewerCount: 2,
    quorum: 2,
    status: "open",
    revision: 1,
    createdAt: "2026-08-12T10:00:00.000Z",
    createdByUserId: "ws-owner",
    updatedAt: "2026-08-12T10:00:00.000Z",
    updatedByUserId: "ws-owner",
  });
  pathStore.set(`runs/${runId}/humanReviewAssignment/current`, {
    schemaVersion: 1,
    teamId: TEAM_ID,
    runId,
    assignedReviewerUserId: "ws-reviewer-alice",
    assignedAt: "2026-08-12T10:31:00.000Z",
    assignedByUserId: "ws-owner",
    updatedAt: "2026-08-12T10:31:00.000Z",
    updatedByUserId: "ws-owner",
    revision: 1,
  });
  pathStore.set(`runs/${runId}/humanReviewVotes/r1:ws-reviewer-alice`, {
    schemaVersion: 1,
    kind: "adaptive_human_review_vote",
    teamId: TEAM_ID,
    runId,
    panelRevision: 1,
    reviewerUserId: "ws-reviewer-alice",
    status: "approved",
    commentPresent: false,
    conditionsCount: 0,
    submittedAt: "2026-08-12T10:44:00.000Z",
  });
}

function buildRequest(qs = ""): NextRequest {
  return new NextRequest(`http://localhost/api/teams/runs?version=1${qs}`);
}
function buildUnversionedRequest(qs = ""): NextRequest {
  return new NextRequest(`http://localhost/api/teams/runs${qs ? `?${qs}` : ""}`);
}

/** Canonical review paths for a run — read of ANY of these is a disclosure. */
function reviewPathsFor(runId: string): string[] {
  return readPaths.filter(
    (p) =>
      p.startsWith(`runs/${runId}/humanReviewPanel`) ||
      p.startsWith(`runs/${runId}/humanReviewAssignment`) ||
      p.startsWith(`runs/${runId}/humanReviewVotes`)
  );
}

beforeEach(() => {
  teamRunDocs.clear();
  pathStore.clear();
  readPaths.length = 0;
  getAllShouldThrow = false;
  mockedGetRequestUid.mockReset();
  mockedLoadUserAndTeam.mockReset();
  mockedMemberRole.mockReset();
  mockedIsTeamAdmin.mockReset();
  mockedResolveReviewerDisplayNames.mockReset();

  // The strongest legitimate legacy actor: a Team ADMIN. No Workspace
  // membership is mocked anywhere, because the route performs no Workspace
  // lookup — "only admins can do it" is not the mitigation being tested.
  mockedGetRequestUid.mockResolvedValue("caller-uid");
  mockedLoadUserAndTeam.mockResolvedValue({ user: { email: "caller@test.com" }, team: { id: TEAM_ID, members: [] } });
  mockedMemberRole.mockReturnValue("admin");
  mockedIsTeamAdmin.mockReturnValue(true);
  mockedResolveReviewerDisplayNames.mockImplementation(async (uids: string[]) => new Map(uids.map((u) => [u, `Name-${u}`])));
});

describe("GET /api/teams/runs?version=1 — Workspace-bound exclusion", () => {
  it("returns legacy-only rows and hides the Workspace-bound row from a mixed page", async () => {
    setRun("run-A");
    setRun("run-C");
    setRun("run-B", { workspaceId: "ws-team-1" });
    setWorkspaceReviewState("run-B");
    teamRunDocs.set("p-A", adaptiveRow("run-A"));
    teamRunDocs.set("p-B", adaptiveRow("run-B"));
    teamRunDocs.set("p-C", adaptiveRow("run-C"));

    const res = await GET(buildRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.items.map((i: any) => i.runId).sort()).toEqual(["run-A", "run-C"]);
    // A hidden row must not survive as a count either.
    expect(body.pagination.total).toBe(2);
  });

  it("never READS the Workspace-bound run's canonical review documents", async () => {
    setRun("run-B", { workspaceId: "ws-team-1" });
    setWorkspaceReviewState("run-B");
    teamRunDocs.set("p-B", adaptiveRow("run-B"));

    await GET(buildRequest());

    // The whole point: not fetched, not merely not rendered.
    expect(reviewPathsFor("run-B")).toEqual([]);
  });

  it("never resolves reviewer identities for a Workspace-bound run", async () => {
    setRun("run-B", { workspaceId: "ws-team-1" });
    setWorkspaceReviewState("run-B");
    teamRunDocs.set("p-B", adaptiveRow("run-B"));

    await GET(buildRequest());

    const allUids = mockedResolveReviewerDisplayNames.mock.calls.flatMap((c) => c[0] as string[]);
    expect(allUids).not.toContain("ws-reviewer-alice");
    expect(allUids).not.toContain("ws-reviewer-bob");
    expect(allUids).not.toContain("ws-owner");
  });

  it("returns nothing at all when every projected run is Workspace-bound", async () => {
    setRun("run-B", { workspaceId: "ws-team-1" });
    setWorkspaceReviewState("run-B");
    teamRunDocs.set("p-B", adaptiveRow("run-B"));

    const res = await GET(buildRequest());
    const body = await res.json();

    expect(body.items).toEqual([]);
    expect(body.pagination.total).toBe(0);
    expect(reviewPathsFor("run-B")).toEqual([]);
  });

  it("CONTROL — a genuinely legacy run keeps its full canonical review enrichment", async () => {
    // Without this, a guard that hid everything would satisfy every test above.
    setRun("run-A");
    setWorkspaceReviewState("run-A");
    teamRunDocs.set("p-A", adaptiveRow("run-A"));

    const res = await GET(buildRequest());
    const body = await res.json();

    expect(body.items).toHaveLength(1);
    expect(body.items[0].panel).not.toBeNull();
    expect(body.items[0].panel.reviewers.map((r: any) => r.displayName)).toEqual([
      "Name-ws-reviewer-alice",
      "Name-ws-reviewer-bob",
    ]);
    expect(body.items[0].assignment.reviewerDisplayName).toBe("Name-ws-reviewer-alice");
  });

  it.each([
    ["a Team Workspace binding", { workspaceId: "ws-team-1" }],
    ["its owner's Personal Workspace binding", { workspaceId: `personal-${OWNER}` }],
    ["a malformed binding", { workspaceId: 12345 }],
  ])("hides a run carrying %s", async (_label, binding) => {
    setRun("run-X", binding as Record<string, unknown>);
    teamRunDocs.set("p-X", adaptiveRow("run-X"));

    const body = await (await GET(buildRequest())).json();
    expect(body.items).toEqual([]);
  });

  it("fails closed when the canonical run document is absent", async () => {
    // No setRun() at all — the binding cannot be proven, so the row is not shown.
    teamRunDocs.set("p-X", adaptiveRow("run-X"));
    const body = await (await GET(buildRequest())).json();
    expect(body.items).toEqual([]);
  });

  it("fails closed when the canonical binding read fails", async () => {
    setRun("run-A");
    teamRunDocs.set("p-A", adaptiveRow("run-A"));
    getAllShouldThrow = true;

    const body = await (await GET(buildRequest())).json();
    expect(body.items).toEqual([]);
  });

  // ---- Residual Finding B: rows backed by a VERIFICATION artifact ----
  // A Workspace Claim verification writes a CLASSIC `teamRuns` row with
  // `runId: null` (the Team Workspace route calls the legacy pipeline with no
  // run id). Treating `runId: null` as "cannot be Workspace-bound" left that
  // row — claim text, verdict, consensus, audit bundle — fully readable.
  it("hides a row whose verification artifact is Workspace-bound", async () => {
    setVerification("ver-ws", { workspaceId: "ws-team-1" });
    teamRunDocs.set("p-V", legacyRow({ type: "verification", runId: null, verificationId: "ver-ws", query: "CONFIDENTIAL CLAIM" }));
    const body = await (await GET(buildRequest())).json();
    expect(body.items).toEqual([]);
    expect(JSON.stringify(body)).not.toContain("CONFIDENTIAL CLAIM");
  });

  it("CONTROL — keeps a row whose verification artifact is genuinely legacy/Personal", async () => {
    // `/api/verify-claim` writes the artifact with NO `workspaceId`, and calls
    // the same legacy pipeline — this is the legitimate `runId: null` shape,
    // and hiding it would be a regression rather than a security gain.
    setVerification("ver-legacy");
    teamRunDocs.set("p-V", legacyRow({ type: "verification", runId: null, verificationId: "ver-legacy" }));
    const body = await (await GET(buildRequest())).json();
    expect(body.items).toHaveLength(1);
  });

  it("fails closed when the verification artifact is absent", async () => {
    teamRunDocs.set("p-V", legacyRow({ type: "verification", runId: null, verificationId: "ver-missing" }));
    expect((await (await GET(buildRequest())).json()).items).toEqual([]);
  });

  it("fails closed when the verification artifact read fails", async () => {
    setVerification("ver-legacy");
    teamRunDocs.set("p-V", legacyRow({ type: "verification", runId: null, verificationId: "ver-legacy" }));
    getAllShouldThrow = true;
    expect((await (await GET(buildRequest())).json()).items).toEqual([]);
  });

  it("excludes a row that names neither a run nor a verification", async () => {
    // Every writer names exactly one canonical artifact (`synthesize-panel`
    // 400s without a runId; both Claim routes always pass a verificationId), so
    // a row naming neither cannot be proven to belong to this authority domain.
    teamRunDocs.set("p-N", legacyRow({ runId: null }));
    const body = await (await GET(buildRequest())).json();
    expect(body.items).toEqual([]);
  });

  it("excludes a row naming BOTH a run and a verification", async () => {
    // Not a product shape; preferring one canonical artifact over the other
    // would let a legacy run id authorize Workspace-bound verification content.
    setRun("run-A");
    setVerification("ver-A");
    teamRunDocs.set("p-B", legacyRow({ runId: "run-A", verificationId: "ver-A" }));
    const body = await (await GET(buildRequest())).json();
    expect(body.items).toEqual([]);
  });

  it("excludes a Workspace-bound CLASSIC row too, not only adaptive rows", async () => {
    setRun("run-C", { workspaceId: "ws-team-1" });
    teamRunDocs.set("p-C", legacyRow({ runId: "run-C" }));
    const body = await (await GET(buildRequest())).json();
    expect(body.items).toEqual([]);
  });

  it("the legacy projection cannot confer read authority, with or without it", async () => {
    // Projection present: still hidden.
    setRun("run-B", { workspaceId: "ws-team-1" });
    teamRunDocs.set("p-B", adaptiveRow("run-B"));
    expect((await (await GET(buildRequest())).json()).items).toEqual([]);

    // Remove the projection: the canonical classification is unchanged, and the
    // row simply is not in the queue. The projection never decided authority.
    teamRunDocs.delete("p-B");
    readPaths.length = 0;
    expect((await (await GET(buildRequest())).json()).items).toEqual([]);
    expect(reviewPathsFor("run-B")).toEqual([]);
  });
});

describe("GET /api/teams/runs (unversioned) — same authority boundary", () => {
  it("hides the Workspace-bound row and keeps the legacy row", async () => {
    setRun("run-A");
    setRun("run-B", { workspaceId: "ws-team-1" });
    teamRunDocs.set("p-A", legacyRow({ runId: "run-A" }));
    teamRunDocs.set("p-B", legacyRow({ runId: "run-B" }));

    const res = await GET(buildUnversionedRequest());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.runs.map((r: any) => r.runId)).toEqual(["run-A"]);
    expect(body.total).toBe(1);
  });

  it("fails closed on an absent canonical run", async () => {
    teamRunDocs.set("p-A", legacyRow({ runId: "run-missing" }));
    const body = await (await GET(buildUnversionedRequest())).json();
    expect(body.runs).toEqual([]);
    expect(body.total).toBe(0);
  });

  it("CONTROL — genuinely legacy rows are returned unchanged", async () => {
    setRun("run-A");
    teamRunDocs.set("p-A", legacyRow({ runId: "run-A" }));
    const body = await (await GET(buildUnversionedRequest())).json();
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0].query).toBe("What is the best CRM for a 20-person sales team?");
  });

describe("pagination integrity across every row category", () => {
  it("returns only eligible rows, with correct totals, no duplicates and no skips", async () => {
    // Six categories interleaved: legacy run, Workspace run, legacy
    // verification, Workspace verification, malformed run, and a row naming no
    // canonical artifact at all.
    const expectedRuns: string[] = [];
    let expectedLegacyVerifications = 0;
    for (let i = 0; i < 18; i++) {
      const createdAt = `2026-07-${String(28 - i).padStart(2, "0")}T00:00:00.000Z`;
      const ts = fakeTimestamp(createdAt);
      switch (i % 6) {
        case 0: {
          const id = `run-ok-${i}`; setRun(id);
          teamRunDocs.set(`p${i}`, adaptiveRow(id, { createdAt }));
          expectedRuns.push(id); break;
        }
        case 1: {
          const id = `run-ws-${i}`; setRun(id, { workspaceId: "ws-team-1" }); setWorkspaceReviewState(id);
          teamRunDocs.set(`p${i}`, adaptiveRow(id, { createdAt })); break;
        }
        case 2: {
          setVerification(`ver-ok-${i}`);
          teamRunDocs.set(`p${i}`, legacyRow({ type: "verification", runId: null, verificationId: `ver-ok-${i}`, timestamp: ts }));
          expectedLegacyVerifications += 1; break;
        }
        case 3: {
          setVerification(`ver-ws-${i}`, { workspaceId: "ws-team-1" });
          teamRunDocs.set(`p${i}`, legacyRow({ type: "verification", runId: null, verificationId: `ver-ws-${i}`, query: "SECRET CLAIM", timestamp: ts })); break;
        }
        case 4: {
          // Canonical run exists but its binding is malformed -> ineligible.
          const id = `run-bad-${i}`; setRun(id, { workspaceId: 12345 });
          teamRunDocs.set(`p${i}`, adaptiveRow(id, { createdAt })); break;
        }
        default: {
          // Names no canonical artifact -> ineligible.
          teamRunDocs.set(`p${i}`, legacyRow({ runId: null, timestamp: ts })); break;
        }
      }
    }

    const seenRuns: string[] = [];
    let legacyRows = 0;
    let total = -1;
    const nextFlags: boolean[] = [];
    for (let page = 1; page <= 4; page++) {
      const body = await (await GET(buildRequest(`&page=${page}&limit=3`))).json();
      total = body.pagination.total;
      nextFlags.push(body.pagination.hasNextPage);
      for (const item of body.items) {
        if (item.kind === "adaptive") seenRuns.push(item.runId);
        else legacyRows += 1;
      }
      expect(JSON.stringify(body)).not.toContain("SECRET CLAIM");
      expect(JSON.stringify(body)).not.toContain("ws-reviewer");
    }

    expect(total).toBe(expectedRuns.length + expectedLegacyVerifications); // 3 + 3
    expect(seenRuns.length).toBe(new Set(seenRuns).size);                   // no duplicates
    expect([...seenRuns].sort()).toEqual([...expectedRuns].sort());         // none skipped
    expect(legacyRows).toBe(expectedLegacyVerifications);
    expect(nextFlags.slice(0, 2)).toEqual([true, false]);                   // 6 rows at 3/page
    // No excluded run was ever enriched.
    for (let i = 1; i < 18; i += 6) expect(reviewPathsFor(`run-ws-${i}`)).toEqual([]);
  });
});
});
