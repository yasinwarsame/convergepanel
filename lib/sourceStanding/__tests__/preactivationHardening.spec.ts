/**
 * Order 4 Slice 2a.1 — pre-activation hardening of Source Standing.
 *
 *   P2  a source that is currently another standing's successor may not be
 *       WITHDRAWN or newly SUPERSEDED (same-Workspace inbound-reference query,
 *       inside the transaction, before any write);
 *   P3  the management read derives every head field from ONE head snapshot;
 *   +   leaving SUPERSEDED removes the stored `successorIdHash`.
 *
 * Runs against the strict in-memory Firestore (reads-before-writes, OCC,
 * create-if-absent) with the REAL Team authorizer.
 */
import { Timestamp } from "firebase-admin/firestore";
import { FakeDb } from "./fakeStandingFirestore";

let mockDb: FakeDb;
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return mockDb;
  },
}));
jest.mock("server-only", () => ({}));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { computeMembershipId } from "@/lib/workspaces/membershipId";
import { sourceIdentityV1, type SourceIdentityV1 } from "@/lib/sourceStanding/sourceIdentity";
import { applySourceStandingOperation, loadStandingPresentations, readStandingForManagement, type ApplyStandingArgs } from "@/lib/sourceStanding/standingFirestore";

const WS = "ws-team-1";
const WS2 = "ws-team-2";
const OWNER = "owner-1";
const ADMIN = "admin-1";
const ts = (s: number) => new Timestamp(s, 0);
const ident = (p: string) => sourceIdentityV1(`https://docs.example.com/${p}`) as SourceIdentityV1;
const A = ident("a");
const B = ident("b");
const C = ident("c");
const D = ident("d");
const cur = (ws: string, id: SourceIdentityV1) => `workspaces/${ws}/sourceAuthority/${id.idHash}`;
const events = (ws: string, id: SourceIdentityV1) => mockDb.children(`workspaces/${ws}/sourceAuthority/${id.idHash}/events`);
const audits = () => mockDb.children("workspaceMembershipEvents");
const snapshot = () => JSON.stringify([...mockDb.store.entries()].map(([k, v]) => [k, v.data]));

function seedWorkspace(ws: string) {
  mockDb.put(`workspaces/${ws}`, { schemaVersion: 1, id: ws, type: "team", name: "Acme", ownerUserId: OWNER, createdByUserId: OWNER, createdAt: ts(1000), updatedAt: ts(1000) });
  for (const [uid, role] of [[OWNER, "owner"], [ADMIN, "admin"]]) {
    const id = computeMembershipId(ws, uid);
    mockDb.put(`workspaceMemberships/${id}`, { schemaVersion: 1, id, workspaceId: ws, uid, role, status: "active", createdAt: ts(1000), updatedAt: ts(1000), invitedByUserId: null, removedAt: null, removedByUserId: null });
  }
}
function seedCurrent(ws: string, id: SourceIdentityV1, fields: Record<string, unknown> = {}) {
  mockDb.put(cur(ws, id), { schemaVersion: 1, workspaceId: ws, identity: { ...id }, status: "ACCEPTED", reasonCode: "primary_document", revision: 1, updatedAt: ts(2000), updatedByUid: ADMIN, ...fields });
}
const supersededBy = (succ: SourceIdentityV1, extra: Record<string, unknown> = {}) => ({ status: "SUPERSEDED", reasonCode: "replaced_by_successor", successorIdHash: succ.idHash, ...extra });
const op = (over: Partial<ApplyStandingArgs> = {}): ApplyStandingArgs => ({ workspaceId: WS, uid: ADMIN, operation: "accept", reasonCode: "primary_document", identity: B, successorIdentity: null, expectedRevision: 1, ...over });
const presentationOf = async (id: SourceIdentityV1) => (await loadStandingPresentations(WS, [id]))[0];

beforeEach(() => {
  mockDb = new FakeDb();
  seedWorkspace(WS);
  seedWorkspace(WS2);
  mockDb.reads = [];
});

describe("P2 — a referenced source cannot be withdrawn or newly superseded", () => {
  beforeEach(() => {
    seedCurrent(WS, B); // B ACCEPTED r1
    seedCurrent(WS, A, supersededBy(B)); // A → B
    mockDb.reads = [];
  });

  it("withdraw B while A → B → source_is_referenced; B, history and audit untouched", async () => {
    const before = snapshot();
    expect(await applySourceStandingOperation(op({ operation: "withdraw", reasonCode: "withdrawn" }))).toEqual({ ok: false, reason: "source_is_referenced" });
    expect(snapshot()).toBe(before);
    expect(events(WS, B)).toHaveLength(0);
    expect(audits()).toHaveLength(0);
    expect(await presentationOf(A)).toMatchObject({ status: "SUPERSEDED", successorUrl: B.canonicalUrl });
  });

  it("supersede B → C (C valid) while A → B → source_is_referenced; zero partial writes", async () => {
    seedCurrent(WS, C);
    const before = snapshot();
    expect(await applySourceStandingOperation(op({ operation: "supersede", reasonCode: "replaced_by_successor", successorIdentity: C }))).toEqual({ ok: false, reason: "source_is_referenced" });
    expect(snapshot()).toBe(before);
  });

  it("the inbound query runs inside the transaction, is same-Workspace, equality on successorIdHash, limit 1 — and precedes any successor read", async () => {
    seedCurrent(WS, C);
    await applySourceStandingOperation(op({ operation: "supersede", reasonCode: "replaced_by_successor", successorIdentity: C }));
    const q = mockDb.reads.filter((r) => r.kind === "query");
    expect(q).toEqual([{ kind: "query", path: `workspaces/${WS}/sourceAuthority`, orderBy: null, dir: "asc", limit: 1, where: [{ field: "successorIdHash", value: B.idHash }], via: "tx" }]);
    expect(mockDb.reads.some((r) => r.kind === "doc" && r.path === cur(WS, C))).toBe(false); // rejected before the chain walk
  });

  it.each([
    ["ACCEPTED → DISPUTED", {}, "dispute", "inaccurate_or_unreliable_for_workspace", "DISPUTED"],
    ["DISPUTED → ACCEPTED", { status: "DISPUTED", reasonCode: "inaccurate_or_unreliable_for_workspace" }, "accept", "designated_reference", "ACCEPTED"],
    ["ACCEPTED → ACCEPTED (new reason)", {}, "accept", "designated_reference", "ACCEPTED"],
    ["DISPUTED → DISPUTED", { status: "DISPUTED", reasonCode: "inaccurate_or_unreliable_for_workspace" }, "dispute", "inaccurate_or_unreliable_for_workspace", "DISPUTED"],
  ] as const)("referenced B may still move %s; A stays resolvable", async (_n, seedFields, operation, reasonCode, status) => {
    seedCurrent(WS, B, seedFields);
    expect(await applySourceStandingOperation(op({ operation, reasonCode }))).toEqual({ ok: true, status, revision: 2 });
    expect(await presentationOf(A)).toMatchObject({ status: "SUPERSEDED", successorUrl: B.canonicalUrl });
    // These transitions never consult the inbound-reference query.
    expect(mockDb.reads.filter((r) => r.kind === "query")).toHaveLength(0);
  });

  it.each([
    ["SUPERSEDED → ACCEPTED", "accept", "primary_document", "ACCEPTED"],
    ["SUPERSEDED → DISPUTED", "dispute", "inaccurate_or_unreliable_for_workspace", "DISPUTED"],
  ] as const)("chain shortening: A → B → C, referenced B %s succeeds and A now resolves to B directly", async (_n, operation, reasonCode, status) => {
    seedCurrent(WS, C);
    seedCurrent(WS, B, supersededBy(C));
    expect(await applySourceStandingOperation(op({ operation, reasonCode }))).toEqual({ ok: true, status, revision: 2 });
    expect(await presentationOf(A)).toMatchObject({ status: "SUPERSEDED", successorUrl: B.canonicalUrl });
  });

  it("a MALFORMED predecessor still counts as an inbound reference (fail closed)", async () => {
    mockDb.put(cur(WS, A), { junk: true, successorIdHash: B.idHash });
    expect(await applySourceStandingOperation(op({ operation: "withdraw", reasonCode: "withdrawn" }))).toEqual({ ok: false, reason: "source_is_referenced" });
  });
});

describe("P2 — Workspace isolation and unchanged behaviour without references", () => {
  it("a predecessor in ANOTHER Workspace pointing at the same id never blocks this Workspace", async () => {
    seedCurrent(WS, B);
    seedCurrent(WS2, B);
    seedCurrent(WS2, A, supersededBy(B));
    expect(await applySourceStandingOperation(op({ operation: "withdraw", reasonCode: "withdrawn" }))).toEqual({ ok: true, status: "WITHDRAWN", revision: 1 });
    // ...while the same operation in WS2 is blocked.
    expect(await applySourceStandingOperation(op({ workspaceId: WS2, operation: "withdraw", reasonCode: "withdrawn" }))).toEqual({ ok: false, reason: "source_is_referenced" });
  });

  it("no inbound reference: withdraw and supersede behave exactly as before", async () => {
    seedCurrent(WS, B);
    seedCurrent(WS, C);
    expect(await applySourceStandingOperation(op({ operation: "supersede", reasonCode: "replaced_by_successor", successorIdentity: C }))).toEqual({ ok: true, status: "SUPERSEDED", revision: 2 });
    // C is now referenced by B; D is unreferenced and can be withdrawn.
    seedCurrent(WS, D);
    expect(await applySourceStandingOperation(op({ identity: D, operation: "withdraw", reasonCode: "withdrawn" }))).toEqual({ ok: true, status: "WITHDRAWN", revision: 1 });
    expect(await applySourceStandingOperation(op({ identity: C, operation: "withdraw", reasonCode: "withdrawn" }))).toEqual({ ok: false, reason: "source_is_referenced" });
  });

  it("a predecessor that commits concurrently (between our reads and commit) forces a retry that then refuses", async () => {
    seedCurrent(WS, B);
    mockDb.beforeCommit = (attempt) => {
      if (attempt === 1) seedCurrent(WS, A, supersededBy(B));
    };
    expect(await applySourceStandingOperation(op({ operation: "withdraw", reasonCode: "withdrawn" }))).toEqual({ ok: false, reason: "source_is_referenced" });
    expect(mockDb.attempts).toBe(2);
    expect(mockDb.read(cur(WS, B))).toMatchObject({ status: "ACCEPTED", revision: 1 });
    expect(events(WS, B)).toHaveLength(0);
    expect(audits()).toHaveLength(0);
  });
});

describe("Leaving SUPERSEDED removes the stored successorIdHash (persistence, not DTO)", () => {
  it.each([
    ["ACCEPTED", "accept", "primary_document"],
    ["DISPUTED", "dispute", "inaccurate_or_unreliable_for_workspace"],
  ] as const)("SUPERSEDED → %s rewrites the document without successorIdHash", async (status, operation, reasonCode) => {
    seedCurrent(WS, C);
    seedCurrent(WS, B, supersededBy(C));
    expect((await applySourceStandingOperation(op({ operation, reasonCode }))).ok).toBe(true);
    const stored = mockDb.read(cur(WS, B)) as Record<string, unknown>;
    expect(stored.status).toBe(status);
    expect(Object.prototype.hasOwnProperty.call(stored, "successorIdHash")).toBe(false);
    expect(Object.keys(stored).sort()).toEqual(["identity", "reasonCode", "revision", "schemaVersion", "status", "updatedAt", "updatedByUid", "workspaceId"]);
  });
});

describe("P3 — management read uses exactly one head snapshot", () => {
  const headReads = () => mockDb.reads.filter((r) => r.kind === "doc" && r.path === cur(WS, A));

  it.each([
    ["ACCEPTED", {}],
    ["DISPUTED", { status: "DISPUTED", reasonCode: "inaccurate_or_unreliable_for_workspace" }],
  ])("%s → exactly one read in total (the head)", async (_n, fields) => {
    seedCurrent(WS, A, fields);
    mockDb.reads = [];
    await readStandingForManagement(WS, A);
    expect(mockDb.reads).toHaveLength(1);
    expect(headReads()).toHaveLength(1);
  });

  it("malformed head → exactly one read, UNRESOLVED", async () => {
    mockDb.put(cur(WS, A), { junk: true });
    mockDb.reads = [];
    expect(await readStandingForManagement(WS, A)).toEqual({ kind: "unresolved" });
    expect(mockDb.reads).toHaveLength(1);
  });

  it("SUPERSEDED → one head read plus successor reads; the head path appears once in the trace", async () => {
    seedCurrent(WS, C);
    seedCurrent(WS, B, supersededBy(C));
    seedCurrent(WS, A, supersededBy(B));
    mockDb.reads = [];
    expect(await readStandingForManagement(WS, A)).toMatchObject({ kind: "current", status: "SUPERSEDED", successor: { resolved: true, url: B.canonicalUrl } });
    expect(headReads()).toHaveLength(1);
    expect(mockDb.reads.map((r) => r.path)).toEqual([cur(WS, A), cur(WS, B), cur(WS, C)]);
  });

  it.each([
    ["missing successor", () => undefined],
    ["malformed successor", () => mockDb.put(cur(WS, B), { junk: true })],
  ])("%s → successor unresolved, head metadata still reported", async (_n, seed) => {
    seedCurrent(WS, A, supersededBy(B, { revision: 3 }));
    seed();
    expect(await readStandingForManagement(WS, A)).toEqual({ kind: "current", status: "SUPERSEDED", reasonCode: "replaced_by_successor", revision: 3, asOf: "1970-01-01T00:33:20.000Z", successor: { resolved: false } });
  });

  function chainFrom(head: SourceIdentityV1, edges: number) {
    // head → n1 → … → n{edges}; the last node is ACCEPTED.
    const nodes = Array.from({ length: edges }, (_, i) => ident(`chain-n${i + 1}`));
    nodes.forEach((n, i) => seedCurrent(WS, n, i < edges - 1 ? supersededBy(nodes[i + 1]) : {}));
    seedCurrent(WS, head, supersededBy(nodes[0]));
    return nodes;
  }

  it("an 8-edge chain (the maximum) resolves to the IMMEDIATE successor: 1 head read + 8 successor reads", async () => {
    const nodes = chainFrom(A, 8);
    mockDb.reads = [];
    expect(await readStandingForManagement(WS, A)).toMatchObject({ kind: "current", status: "SUPERSEDED", successor: { resolved: true, url: nodes[0].canonicalUrl } });
    expect(mockDb.reads).toHaveLength(9);
    expect(headReads()).toHaveLength(1);
  });

  it("a 9-edge chain is unresolved after exactly 9 reads — a 10th document is never loaded", async () => {
    const nodes = chainFrom(A, 9);
    mockDb.reads = [];
    expect(await readStandingForManagement(WS, A)).toMatchObject({ kind: "current", status: "SUPERSEDED", successor: { resolved: false } });
    expect(mockDb.reads).toHaveLength(9);
    expect(mockDb.reads.some((r) => r.path === cur(WS, nodes[8]))).toBe(false);
  });

  it("a 3-edge chain resolves (guards an off-by-small loop bound)", async () => {
    const nodes = chainFrom(A, 3);
    expect(await readStandingForManagement(WS, A)).toMatchObject({ successor: { resolved: true, url: nodes[0].canonicalUrl } });
  });

  it("RACE: the head changes after the first read — the response keeps revision 4 / successor B and never resolves from the new successor C", async () => {
    seedCurrent(WS, B, { reasonCode: "designated_reference" });
    seedCurrent(WS, C);
    seedCurrent(WS, A, supersededBy(B, { revision: 4 }));
    const realGet = mockDb.doc(cur(WS, A)).constructor.prototype.get;
    let first = true;
    const spy = jest.spyOn(mockDb.doc(cur(WS, A)).constructor.prototype, "get").mockImplementation(async function (this: { path: string }) {
      const res = await realGet.call(this);
      if (first && this.path === cur(WS, A)) {
        first = false;
        seedCurrent(WS, A, supersededBy(C, { revision: 5 })); // concurrent writer commits right after our head read
      }
      return res;
    });
    try {
      const out = await readStandingForManagement(WS, A);
      expect(out).toMatchObject({ kind: "current", revision: 4, successor: { resolved: true, url: B.canonicalUrl } });
      expect(headReads()).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  });
});
