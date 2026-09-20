/**
 * PHASE 1 CROSS-AUTHORITY READ GUARD — the module's ONE authority contract.
 *
 * The final adversarial review found the two canonical record types answering
 * the SAME malformed state differently: the run predicate denied an unreadable
 * document body while the verification predicate ADMITTED it, because
 * `isWorkspaceBoundVerificationArtifact()` returns false for any non-object and
 * the call site negated that into "allow". A module whose contract is "every
 * ambiguity collapses to one safe answer" cannot have two helpers disagreeing
 * about what ambiguity means.
 *
 * This file pins the contract as a TRUTH TABLE applied identically to both
 * record types, and pins the batch-association boundary: a returned snapshot
 * may contribute a classification only if its own id was in the requested
 * chunk.
 */

const docs = new Map<string, unknown>();
/** Lets a test replace what the batched read hands back, per requested id. */
let snapshotFactory: ((id: string, path: string) => unknown) | null = null;
const getAllCalls: string[][] = [];
let inFlight = 0;
let maxInFlight = 0;
let failChunksContaining: string | null = null;

const mockAdminDb: any = {
  collection: (name: string) => ({ doc: (id: string) => ({ __path: `${name}/${id}`, __id: id }) }),
  getAll: async (...refs: Array<{ __path: string; __id: string }>) => {
    getAllCalls.push(refs.map((r) => r.__id));
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      // Yield so overlapping waves are actually observable.
      await new Promise((r) => setTimeout(r, 5));
      if (failChunksContaining && refs.some((r) => r.__id === failChunksContaining)) throw new Error("chunk boom");
      if (snapshotFactory) return refs.map((r) => snapshotFactory!(r.__id, r.__path));
      return refs.map((r) => ({ id: r.__id, exists: docs.has(r.__path), data: () => docs.get(r.__path) }));
    } finally {
      inFlight -= 1;
    }
  },
};
jest.mock("@/lib/firebase/admin", () => ({ get adminDb() { return mockAdminDb; } }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { resolveLegacyReadDomain, teamRunRowIsInLegacyReadDomain } from "@/lib/governance/legacyReviewReadDomain";

const OWNER = "owner-uid";
const runRow = (runId: string) => ({ runId });
const verRow = (verificationId: string) => ({ runId: null, verificationId });

beforeEach(() => {
  docs.clear();
  getAllCalls.length = 0;
  snapshotFactory = null;
  failChunksContaining = null;
  inFlight = 0;
  maxInFlight = 0;
});

/**
 * Drives ONE row of the truth table for ONE record type. The caller sets
 * `snapshotFactory` first; this helper must NOT overwrite it, or every case
 * would collapse to the same snapshot and the comparison would be vacuous.
 */
async function admits(kind: "run" | "verification"): Promise<boolean> {
  const row = kind === "run" ? runRow("run-1") : verRow("ver-1");
  const domain = await resolveLegacyReadDomain([row]);
  return teamRunRowIsInLegacyReadDomain(row, domain);
}

/** A snapshot that reports the id it was asked for — what a real batched read does. */
function selfSnap(body: unknown, exists = true) {
  return (id: string) => ({ id, exists, data: () => body });
}

describe("ONE authority contract — identical fail-closed semantics for both canonical record types", () => {
  // Each case is applied to BOTH record types and must produce the SAME verdict.
  const SHARED: Array<[label: string, body: unknown, exists: boolean, admitted: boolean]> = [
    ["a valid legacy document (no workspaceId field)", { userId: OWNER }, true, true],
    ["a Workspace-bound document", { userId: OWNER, workspaceId: "ws-team-1" }, true, false],
    ["a missing document", undefined, false, false],
    ["an unreadable body (undefined)", undefined, true, false],
    ["an unreadable body (null)", null, true, false],
    ["an unreadable body (string)", "not-an-object", true, false],
    ["an unreadable body (number)", 42, true, false],
    ["a malformed binding (workspaceId: null)", { userId: OWNER, workspaceId: null }, true, false],
    ["a malformed binding (workspaceId: 12345)", { userId: OWNER, workspaceId: 12345 }, true, false],
    ["a malformed binding (workspaceId: '')", { userId: OWNER, workspaceId: "" }, true, false],
  ];

  it.each(SHARED)("run-backed: %s", async (_label, body, exists, admitted) => {
    snapshotFactory = selfSnap(body, exists);
    expect(await admits("run")).toBe(admitted);
  });

  it.each(SHARED)("verification-backed: %s", async (_label, body, exists, admitted) => {
    snapshotFactory = selfSnap(body, exists);
    expect(await admits("verification")).toBe(admitted);
  });

  it("the two record types never disagree on any shared state", async () => {
    const disagreements: string[] = [];
    for (const [label, body, exists] of SHARED) {
      snapshotFactory = selfSnap(body, exists);
      const r = await admits("run");
      snapshotFactory = selfSnap(body, exists);
      const v = await admits("verification");
      if (r !== v) disagreements.push(`${label}: run=${r} verification=${v}`);
    }
    expect(disagreements).toEqual([]);
  });

  it("a read failure excludes, for both record types", async () => {
    docs.set("runs/run-1", { userId: OWNER });
    docs.set("verifications/ver-1", { claimText: "c" });
    failChunksContaining = "run-1";
    expect(teamRunRowIsInLegacyReadDomain(runRow("run-1"), await resolveLegacyReadDomain([runRow("run-1")]))).toBe(false);
    failChunksContaining = "ver-1";
    expect(teamRunRowIsInLegacyReadDomain(verRow("ver-1"), await resolveLegacyReadDomain([verRow("ver-1")]))).toBe(false);
  });
});

describe("D3 — a row naming no canonical artifact is not readable", () => {
  it("excludes a row with neither a runId nor a verificationId", async () => {
    const row = { type: "research", query: "q" };
    expect(teamRunRowIsInLegacyReadDomain(row, await resolveLegacyReadDomain([row]))).toBe(false);
  });

  it("excludes a row whose ids are blank or non-string", async () => {
    for (const row of [{ runId: "   ", verificationId: "  " }, { runId: 7, verificationId: 9 }, { runId: null, verificationId: null }]) {
      expect(teamRunRowIsInLegacyReadDomain(row, await resolveLegacyReadDomain([row]))).toBe(false);
    }
  });

  it("CONTROL — a valid legacy run-backed row is still admitted", async () => {
    docs.set("runs/run-1", { userId: OWNER });
    expect(teamRunRowIsInLegacyReadDomain(runRow("run-1"), await resolveLegacyReadDomain([runRow("run-1")]))).toBe(true);
  });

  it("CONTROL — a valid legacy verification-backed row is still admitted", async () => {
    docs.set("verifications/ver-1", { claimText: "c" });
    expect(teamRunRowIsInLegacyReadDomain(verRow("ver-1"), await resolveLegacyReadDomain([verRow("ver-1")]))).toBe(true);
  });

  it("CONTROL — a Workspace verification row is still excluded", async () => {
    docs.set("verifications/ver-1", { workspaceId: "ws-1" });
    expect(teamRunRowIsInLegacyReadDomain(verRow("ver-1"), await resolveLegacyReadDomain([verRow("ver-1")]))).toBe(false);
  });
});

describe("conflicting identifiers", () => {
  it("excludes a row naming BOTH a run and a verification, even when both are legacy", async () => {
    // No writer emits this shape. It is therefore unclassifiable product state,
    // and preferring one canonical artifact over the other would be arbitrary.
    docs.set("runs/run-1", { userId: OWNER });
    docs.set("verifications/ver-1", { claimText: "c" });
    const row = { runId: "run-1", verificationId: "ver-1" };
    expect(teamRunRowIsInLegacyReadDomain(row, await resolveLegacyReadDomain([row]))).toBe(false);
  });
});

describe("D2 — batch association is by requested identity", () => {
  it("D2-M1: a foreign snapshot id contributes nothing", async () => {
    snapshotFactory = () => ({ id: "FOREIGN-ID", exists: true, data: () => ({ userId: OWNER }) });
    const domain = await resolveLegacyReadDomain([runRow("run-1")]);
    expect([...domain.legacyOnlyRunIds]).toEqual([]);
    expect(teamRunRowIsInLegacyReadDomain(runRow("FOREIGN-ID"), domain)).toBe(false);
  });

  it("D2-M2: an omitted snapshot leaves its row ineligible", async () => {
    snapshotFactory = (id) => (id === "run-1" ? { id, exists: true, data: () => ({ userId: OWNER }) } : undefined);
    const domain = await resolveLegacyReadDomain([runRow("run-1"), runRow("run-2")]);
    expect([...domain.legacyOnlyRunIds]).toEqual(["run-1"]);
    expect(teamRunRowIsInLegacyReadDomain(runRow("run-2"), domain)).toBe(false);
  });

  it("D2-M3: reversed snapshots keep their own classification", async () => {
    docs.set("runs/run-legacy", { userId: OWNER });
    docs.set("runs/run-ws", { userId: OWNER, workspaceId: "ws-1" });
    const base = mockAdminDb.getAll;
    mockAdminDb.getAll = async (...refs: any[]) => (await base(...refs)).reverse();
    try {
      const domain = await resolveLegacyReadDomain([runRow("run-legacy"), runRow("run-ws")]);
      expect([...domain.legacyOnlyRunIds]).toEqual(["run-legacy"]);
    } finally {
      mockAdminDb.getAll = base;
    }
  });

  it("D2-M4: expected results survive alongside an extra foreign snapshot", async () => {
    snapshotFactory = (id) => ({ id, exists: true, data: () => ({ userId: OWNER }) });
    const base = mockAdminDb.getAll;
    mockAdminDb.getAll = async (...refs: any[]) => [...(await base(...refs)), { id: "FOREIGN-ID", exists: true, data: () => ({ userId: OWNER }) }];
    try {
      const domain = await resolveLegacyReadDomain([runRow("run-1")]);
      expect([...domain.legacyOnlyRunIds]).toEqual(["run-1"]);
    } finally {
      mockAdminDb.getAll = base;
    }
  });

  it("D2-M5: a duplicated snapshot id cannot flip a decision open", async () => {
    // Same id returned twice: once Workspace-bound, once legacy. Neither
    // ordering may admit it.
    const bodies = [{ userId: OWNER, workspaceId: "ws-1" }, { userId: OWNER }];
    let n = 0;
    const base = mockAdminDb.getAll;
    mockAdminDb.getAll = async (...refs: any[]) => refs.flatMap((r: any) => bodies.map((b) => ({ id: r.__id, exists: true, data: () => (n++, b) })));
    try {
      const domain = await resolveLegacyReadDomain([runRow("run-1")]);
      expect([...domain.legacyOnlyRunIds]).toEqual([]);
    } finally {
      mockAdminDb.getAll = base;
    }
  });

  it("D2-M6 / batch-integrity attack: reversed + omitted + foreign + malformed, together", async () => {
    docs.set("runs/ok-1", { userId: OWNER });
    docs.set("runs/ok-2", { userId: OWNER });
    docs.set("runs/ws-1", { userId: OWNER, workspaceId: "ws-team-1" });
    const base = mockAdminDb.getAll;
    mockAdminDb.getAll = async (...refs: any[]) => {
      const real = await base(...refs);
      return [
        ...real.filter((s: any) => s.id !== "ok-2"),                       // omitted
        { id: "FOREIGN-ID", exists: true, data: () => ({ userId: OWNER }) }, // foreign
        { id: "malformed-1", exists: true, data: () => undefined },         // unreadable body
      ].reverse();                                                          // reordered
    };
    try {
      const rows = [runRow("ok-1"), runRow("ok-2"), runRow("ws-1"), runRow("malformed-1")];
      const domain = await resolveLegacyReadDomain(rows);
      expect([...domain.legacyOnlyRunIds].sort()).toEqual(["ok-1"]);
      expect(rows.map((r) => teamRunRowIsInLegacyReadDomain(r, domain))).toEqual([true, false, false, false]);
    } finally {
      mockAdminDb.getAll = base;
    }
  });
});

describe("bounded concurrency", () => {
  it("never exceeds the configured wave cap, and still executes every chunk", async () => {
    // 120 ids => 12 chunks of 10 => more than one wave at a cap of 5.
    const ids = Array.from({ length: 120 }, (_, i) => `run-${String(i).padStart(3, "0")}`);
    ids.forEach((id) => docs.set(`runs/${id}`, { userId: OWNER }));
    const domain = await resolveLegacyReadDomain(ids.map(runRow));
    expect(getAllCalls.length).toBe(12);
    expect(getAllCalls.flat().sort()).toEqual([...ids].sort()); // every chunk ran
    expect(domain.legacyOnlyRunIds.size).toBe(120);
    expect(maxInFlight).toBeLessThanOrEqual(5);
    expect(maxInFlight).toBeGreaterThan(1); // genuinely concurrent, not serial
  });

  it("a failing chunk cannot make another chunk's rows default-readable", async () => {
    const ids = Array.from({ length: 20 }, (_, i) => `run-${String(i).padStart(3, "0")}`);
    ids.forEach((id) => docs.set(`runs/${id}`, { userId: OWNER }));
    failChunksContaining = "run-000";
    const domain = await resolveLegacyReadDomain(ids.map(runRow));
    expect(domain.legacyOnlyRunIds.has("run-000")).toBe(false);
    expect(domain.legacyOnlyRunIds.size).toBe(10); // exactly the surviving chunk
  });
});
