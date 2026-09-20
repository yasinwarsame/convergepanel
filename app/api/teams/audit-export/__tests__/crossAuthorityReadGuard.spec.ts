/**
 * PHASE 1 REVIEW STACK CROSS-AUTHORITY READ GUARD — legacy audit export.
 *
 * An export is the highest-leverage read on `teamRuns`: bulk, durable, and it
 * leaves the product as a file. So it gets the same authority boundary as the
 * queue rather than a weaker one — a Workspace-bound run is outside the legacy
 * Team domain here too.
 *
 * The existing `auditExportAdaptiveExclusion.spec.ts` covers the separate,
 * pre-existing exclusion of ADAPTIVE rows. This file covers the CLASSIC rows
 * that export survives on, whose `query`/`verdict`/`consensusScore`/
 * `humanDecision` are equally outside a legacy caller's domain once the
 * underlying run belongs to a Workspace.
 */

const teamRunDocs = new Map<string, Record<string, any>>();
const runDocs = new Map<string, Record<string, any>>();
/** Canonical paths the guard actually classified — proves the window runs first. */
const classifiedPaths: string[] = [];
let getAllShouldThrow = false;
/** Fails only the chunk containing this canonical path, leaving others healthy. */
let failChunkContaining: string | null = null;

function makeDocRef(path: string): any {
  return { __path: path, get: async () => ({ exists: runDocs.has(path), data: () => runDocs.get(path) }) };
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
    return { doc: (id: string) => makeDocRef(`${name}/${id}`) };
  },
  getAll: async (...refs: Array<{ __path: string }>) => {
    refs.forEach((r) => classifiedPaths.push(r.__path));
    if (getAllShouldThrow) throw new Error("batch read boom");
    if (failChunkContaining && refs.some((r) => r.__path === failChunkContaining)) throw new Error("transient chunk failure");
    // A real DocumentSnapshot always carries `id`; the read guard associates
    // results by identity rather than array position, so the fake must too.
    return refs.map((ref) => ({ id: ref.__path.split("/").pop(), exists: runDocs.has(ref.__path), data: () => runDocs.get(ref.__path) }));
  },
};

jest.mock("@/lib/firebase/admin", () => ({ adminDb: mockAdminDb }));

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
import { GET } from "@/app/api/teams/audit-export/route";

const TEAM_ID = "team-1";

function fakeTimestamp(iso: string) {
  return { toMillis: () => new Date(iso).getTime() };
}

function classicRow(runId: string | null, overrides: Record<string, unknown> = {}) {
  return {
    teamId: TEAM_ID,
    userEmail: "owner@test.com",
    type: "research",
    query: `Query for ${runId ?? "no-run"}`,
    verdict: "Confirmed",
    consensusScore: 80,
    policyFlags: [],
    humanDecision: { action: "approved", decidedBy: "legacy-admin", decidedAt: "2026-08-01T00:00:00.000Z", notes: "n" },
    timestamp: fakeTimestamp("2026-08-01T00:00:00.000Z"),
    runId,
    ...overrides,
  };
}

function setRun(runId: string, binding: Record<string, unknown> = {}) {
  runDocs.set(`runs/${runId}`, { userId: "owner-uid", ...binding });
}

/** A canonical Claim verification artifact — only the Team writer persists `workspaceId`. */
function setVerification(verificationId: string, binding: Record<string, unknown> = {}) {
  runDocs.set(`verifications/${verificationId}`, { claimText: "c", ...binding });
}

beforeEach(() => {
  teamRunDocs.clear();
  runDocs.clear();
  classifiedPaths.length = 0;
  failChunkContaining = null;
  getAllShouldThrow = false;
  [mockedGetRequestUid, mockedLoadUserAndTeam, mockedMemberRole, mockedIsTeamAdmin].forEach((m) => m.mockReset());
  mockedGetRequestUid.mockResolvedValue("caller-uid");
  mockedLoadUserAndTeam.mockResolvedValue({ user: { email: "caller@test.com" }, team: { id: TEAM_ID, members: [] } });
  mockedMemberRole.mockReturnValue("admin");
  mockedIsTeamAdmin.mockReturnValue(true);
});

describe("GET /api/teams/audit-export — Workspace-bound exclusion", () => {
  it("exports the legacy run and omits the Workspace-bound one from a mixed export", async () => {
    setRun("run-legacy");
    setRun("run-ws", { workspaceId: "ws-team-1" });
    teamRunDocs.set("p-legacy", classicRow("run-legacy"));
    teamRunDocs.set("p-ws", classicRow("run-ws"));

    const res = await GET(new NextRequest("http://localhost/api/teams/audit-export"));
    // The JSON export is a bare array of rows, not an envelope.
    const rows = await res.json();

    expect(res.status).toBe(200);
    expect(rows.map((r: any) => r.queryTruncated)).toEqual(["Query for run-legacy"]);
    // The Workspace-bound run contributes no content of any kind.
    expect(JSON.stringify(rows)).not.toContain("run-ws");
  });

  it("omits the Workspace-bound run from the CSV rendering too", async () => {
    setRun("run-ws", { workspaceId: "ws-team-1" });
    teamRunDocs.set("p-ws", classicRow("run-ws"));

    const res = await GET(new NextRequest("http://localhost/api/teams/audit-export?format=csv"));
    const text = await res.text();

    expect(text).not.toContain("Query for run-ws");
    // ...and the legacy `humanDecision` stamp travels with it.
    expect(text).not.toContain("approved");
  });

  it.each([
    ["a Personal Workspace binding", { workspaceId: "personal-owner-uid" }],
    ["a malformed binding", { workspaceId: 12345 }],
  ])("omits a run carrying %s", async (_label, binding) => {
    setRun("run-x", binding as Record<string, unknown>);
    teamRunDocs.set("p-x", classicRow("run-x"));
    const rows = await (await GET(new NextRequest("http://localhost/api/teams/audit-export"))).json();
    expect(rows).toEqual([]);
  });

  it("refuses the export when the canonical binding read fails", async () => {
    // Fail-closed AND visibly: an empty artifact would be indistinguishable
    // from "no activity". See the failure-signalling block below.
    setRun("run-legacy");
    teamRunDocs.set("p-legacy", classicRow("run-legacy"));
    getAllShouldThrow = true;
    const res = await GET(new NextRequest("http://localhost/api/teams/audit-export"));
    expect(res.status).toBe(503);
    expect((await res.json()).error.code).toBe("firestore_unavailable");
  });

  it("CONTROL — a legitimate legacy export is unchanged", async () => {
    setRun("run-legacy");
    teamRunDocs.set("p-legacy", classicRow("run-legacy"));
    const rows = await (await GET(new NextRequest("http://localhost/api/teams/audit-export"))).json();
    expect(rows).toHaveLength(1);
    expect(rows[0].queryTruncated).toBe("Query for run-legacy");
    expect(rows[0].humanDecision).not.toBeNull();
  });

  it("omits a Workspace-bound CLAIM VERIFICATION row from JSON", async () => {
    setVerification("ver-ws", { workspaceId: "ws-team-1" });
    teamRunDocs.set("p-v", classicRow(null, { type: "verification", verificationId: "ver-ws", query: "CONFIDENTIAL CLAIM" }));
    const rows = await (await GET(new NextRequest("http://localhost/api/teams/audit-export"))).json();
    expect(rows).toEqual([]);
  });

  it("omits a Workspace-bound CLAIM VERIFICATION row from CSV", async () => {
    setVerification("ver-ws", { workspaceId: "ws-team-1" });
    teamRunDocs.set("p-v", classicRow(null, { type: "verification", verificationId: "ver-ws", query: "CONFIDENTIAL CLAIM" }));
    const text = await (await GET(new NextRequest("http://localhost/api/teams/audit-export?format=csv"))).text();
    expect(text).not.toContain("CONFIDENTIAL CLAIM");
    expect(text).not.toContain("approved");
  });

  it("fails closed when the verification artifact is absent", async () => {
    teamRunDocs.set("p-v", classicRow(null, { type: "verification", verificationId: "ver-missing" }));
    const rows = await (await GET(new NextRequest("http://localhost/api/teams/audit-export"))).json();
    expect(rows).toEqual([]);
  });

  it("CONTROL — a genuinely legacy/Personal verification row is still exported", async () => {
    setVerification("ver-legacy");
    teamRunDocs.set("p-v", classicRow(null, { type: "verification", verificationId: "ver-legacy" }));
    const rows = await (await GET(new NextRequest("http://localhost/api/teams/audit-export"))).json();
    expect(rows).toHaveLength(1);
  });

  it("omits a classic row naming neither a run nor a verification", async () => {
    // No writer produces this shape, so it cannot be proven legacy-eligible.
    teamRunDocs.set("p-n", classicRow(null));
    const rows = await (await GET(new NextRequest("http://localhost/api/teams/audit-export"))).json();
    expect(rows).toEqual([]);
  });

  // ---- Date window ordering (cheap local filter before canonical reads) ----
  describe("from/to window", () => {
    const WINDOW = "?from=2026-08-01T00:00:00.000Z&to=2026-08-31T00:00:00.000Z";
    const inWindow = fakeTimestamp("2026-08-15T00:00:00.000Z");
    const outWindow = fakeTimestamp("2026-01-01T00:00:00.000Z");

    it("does not classify rows outside the requested window", async () => {
      setRun("run-in");
      setRun("run-out");
      teamRunDocs.set("p-in", classicRow("run-in", { timestamp: inWindow, query: "IN" }));
      teamRunDocs.set("p-out", classicRow("run-out", { timestamp: outWindow, query: "OUT" }));

      const rows = await (await GET(new NextRequest(`http://localhost/api/teams/audit-export${WINDOW}`))).json();

      expect(rows.map((r: any) => r.queryTruncated)).toEqual(["IN"]);
      // The out-of-window row cost no canonical read at all.
      expect(classifiedPaths).toEqual(["runs/run-in"]);
    });

    it("still excludes a Workspace-bound run INSIDE the window", async () => {
      setRun("run-ws", { workspaceId: "ws-team-1" });
      teamRunDocs.set("p-ws", classicRow("run-ws", { timestamp: inWindow, query: "SECRET" }));
      const rows = await (await GET(new NextRequest(`http://localhost/api/teams/audit-export${WINDOW}`))).json();
      expect(rows).toEqual([]);
    });

    it("still excludes a Workspace-bound CLAIM VERIFICATION inside the window, in JSON and CSV", async () => {
      setVerification("ver-ws", { workspaceId: "ws-team-1" });
      teamRunDocs.set("p-v", classicRow(null, { type: "verification", verificationId: "ver-ws", timestamp: inWindow, query: "SECRET CLAIM" }));
      const rows = await (await GET(new NextRequest(`http://localhost/api/teams/audit-export${WINDOW}`))).json();
      expect(rows).toEqual([]);
      const csv = await (await GET(new NextRequest(`http://localhost/api/teams/audit-export${WINDOW}&format=csv`))).text();
      expect(csv).not.toContain("SECRET CLAIM");
    });

    it("CONTROL — a legitimate legacy verification inside the window is exported in JSON and CSV", async () => {
      setVerification("ver-ok");
      teamRunDocs.set("p-v", classicRow(null, { type: "verification", verificationId: "ver-ok", timestamp: inWindow, query: "KEEP ME" }));
      const rows = await (await GET(new NextRequest(`http://localhost/api/teams/audit-export${WINDOW}`))).json();
      expect(rows).toHaveLength(1);
      const csv = await (await GET(new NextRequest(`http://localhost/api/teams/audit-export${WINDOW}&format=csv`))).text();
      expect(csv).toContain("KEEP ME");
    });
  });

  // ---- Failure signalling: "could not determine" is not "nothing to report" ----
  describe("classification failure is never presented as an empty export", () => {
    const W = "?from=2026-08-01T00:00:00.000Z&to=2026-08-31T00:00:00.000Z";
    const inWindow = fakeTimestamp("2026-08-15T00:00:00.000Z");
    const outWindow = fakeTimestamp("2026-01-01T00:00:00.000Z");
    const url = (extra = "") => new NextRequest(`http://localhost/api/teams/audit-export${W}${extra}`);

    /** The one response a downloadable artifact must never be confused with. */
    async function expectVisibleFailure(res: Response) {
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({
        ok: false,
        error: { code: "firestore_unavailable", message: "Could not generate the audit export. Please try again." },
      });
      // Nothing a client could save as a compliance record.
      expect(res.headers.get("content-disposition")).toBeNull();
    }

    it("E-M7: a genuinely empty window is still a SUCCESSFUL empty export (JSON and CSV)", async () => {
      setRun("run-out");
      teamRunDocs.set("p-out", classicRow("run-out", { timestamp: outWindow }));
      const json = await GET(url());
      expect(json.status).toBe(200);
      expect(await json.json()).toEqual([]);
      const csv = await GET(url("&format=csv"));
      expect(csv.status).toBe(200);
      expect((await csv.text()).trim().split("\n")).toHaveLength(1); // header only
    });

    it("fails visibly in JSON when an in-window candidate cannot be classified", async () => {
      setRun("run-in");
      teamRunDocs.set("p-in", classicRow("run-in", { timestamp: inWindow }));
      failChunkContaining = "runs/run-in";
      await expectVisibleFailure(await GET(url()));
    });

    it("fails visibly in CSV too — no format retains the silent-empty behaviour", async () => {
      setRun("run-in");
      teamRunDocs.set("p-in", classicRow("run-in", { timestamp: inWindow }));
      failChunkContaining = "runs/run-in";
      await expectVisibleFailure(await GET(url("&format=csv")));
    });

    it("fails visibly when a VERIFICATION artifact cannot be classified", async () => {
      setVerification("ver-in");
      teamRunDocs.set("p-v", classicRow(null, { type: "verification", verificationId: "ver-in", timestamp: inWindow }));
      failChunkContaining = "verifications/ver-in";
      await expectVisibleFailure(await GET(url()));
    });

    it("E-M4: is ATOMIC — healthy rows are not exported alongside an unclassifiable one", async () => {
      // CHUNK_SIZE is 10, so 11 rows span TWO chunks. Failing only the second
      // leaves the first fully classified and 10 rows genuinely eligible — the
      // exact shape a "partial export" would happily emit. Putting every row in
      // one chunk would make this assertion vacuous, because then nothing is
      // eligible and even a partial-export implementation would refuse.
      for (let i = 0; i < 11; i++) {
        const id = `run-${String(i).padStart(2, "0")}`;
        setRun(id);
        teamRunDocs.set(`p-${i}`, classicRow(id, { timestamp: inWindow, query: `ROW-${i}` }));
      }
      failChunkContaining = "runs/run-10"; // alone in the second chunk
      const res = await GET(url());
      await expectVisibleFailure(res);
      // And no partial file leaked on the way to that refusal.
      expect(res.headers.get("content-type")).toBe("application/json");
    });

    it("E-M5: a successfully classified Workspace row is an EXCLUSION, not a failure", async () => {
      setRun("run-ws", { workspaceId: "ws-team-1" });
      setRun("run-ok");
      teamRunDocs.set("p-ws", classicRow("run-ws", { timestamp: inWindow, query: "SECRET" }));
      teamRunDocs.set("p-ok", classicRow("run-ok", { timestamp: inWindow, query: "KEEP" }));
      const res = await GET(url());
      expect(res.status).toBe(200);
      const rows = await res.json();
      expect(rows.map((r: any) => r.queryTruncated)).toEqual(["KEEP"]);
    });

    it("E-M6: an out-of-window unclassifiable row does not fail the export", async () => {
      setRun("run-in");
      setRun("run-out");
      teamRunDocs.set("p-in", classicRow("run-in", { timestamp: inWindow, query: "KEEP" }));
      teamRunDocs.set("p-out", classicRow("run-out", { timestamp: outWindow }));
      // The out-of-window row is filtered before classification, so this never fires.
      failChunkContaining = "runs/run-out";
      const res = await GET(url());
      expect(res.status).toBe(200);
      expect((await res.json()).map((r: any) => r.queryTruncated)).toEqual(["KEEP"]);
      expect(classifiedPaths).toEqual(["runs/run-in"]);
    });

    it("does not disclose WHICH authority domain failed", async () => {
      // A legacy-looking candidate and a Workspace-bound one must produce the
      // byte-identical refusal, or the failure becomes an existence oracle.
      setRun("run-legacy");
      teamRunDocs.set("p-l", classicRow("run-legacy", { timestamp: inWindow }));
      failChunkContaining = "runs/run-legacy";
      const a = await GET(url());
      const aBody = await a.json();

      teamRunDocs.clear();
      runDocs.clear();
      classifiedPaths.length = 0;
      setRun("run-ws", { workspaceId: "ws-team-1" });
      teamRunDocs.set("p-w", classicRow("run-ws", { timestamp: inWindow }));
      failChunkContaining = "runs/run-ws";
      const b = await GET(url());
      const bBody = await b.json();

      expect({ status: a.status, body: aBody }).toEqual({ status: b.status, body: bBody });
      expect(JSON.stringify(aBody)).not.toMatch(/workspace|ws-team-1|run-/i);
    });
  });
});
