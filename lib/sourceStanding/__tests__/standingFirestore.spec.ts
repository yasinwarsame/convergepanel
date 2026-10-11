/**
 * Order 4 Slice 2a — the transactional writer and the batched readers, run
 * against a strict in-memory Firestore (reads-before-writes enforced, OCC
 * version checks, create-if-absent) with the REAL Team authorizer.
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
const cur = (ws: string, id: SourceIdentityV1) => `workspaces/${ws}/sourceAuthority/${id.idHash}`;
const events = (ws: string, id: SourceIdentityV1) => mockDb.children(`workspaces/${ws}/sourceAuthority/${id.idHash}/events`);
const audits = () => mockDb.children("workspaceMembershipEvents");

function seedWorkspace(ws: string, members: Record<string, string>, type = "team") {
  mockDb.put(`workspaces/${ws}`, { schemaVersion: 1, id: ws, type, name: "Acme", ownerUserId: OWNER, createdByUserId: OWNER, createdAt: ts(1000), updatedAt: ts(1000) });
  for (const [uid, role] of Object.entries(members)) {
    const id = computeMembershipId(ws, uid);
    mockDb.put(`workspaceMemberships/${id}`, { schemaVersion: 1, id, workspaceId: ws, uid, role, status: "active", createdAt: ts(1000), updatedAt: ts(1000), invitedByUserId: null, removedAt: null, removedByUserId: null });
  }
}
function seedCurrent(ws: string, id: SourceIdentityV1, fields: Record<string, unknown> = {}) {
  mockDb.put(cur(ws, id), { schemaVersion: 1, workspaceId: ws, identity: { ...id }, status: "ACCEPTED", reasonCode: "primary_document", revision: 1, updatedAt: ts(2000), updatedByUid: ADMIN, ...fields });
}
const op = (over: Partial<ApplyStandingArgs> = {}): ApplyStandingArgs => ({ workspaceId: WS, uid: ADMIN, operation: "accept", reasonCode: "primary_document", identity: A, successorIdentity: null, expectedRevision: null, ...over });
const standingReads = () => mockDb.reads.filter((r) => r.path.includes("/sourceAuthority/"));

beforeEach(() => {
  mockDb = new FakeDb();
  seedWorkspace(WS, { [OWNER]: "owner", [ADMIN]: "admin", "member-1": "member", "reviewer-1": "reviewer", "viewer-1": "viewer" });
  seedWorkspace(WS2, { [OWNER]: "owner", [ADMIN]: "admin" });
  mockDb.reads = [];
});

describe("create / transition / withdraw — exact documents", () => {
  it("accept from absent writes the exact current doc, one event and one hashes-only audit event", async () => {
    const r = await applySourceStandingOperation(op());
    expect(r).toEqual({ ok: true, status: "ACCEPTED", revision: 1 });
    const doc = mockDb.read(cur(WS, A)) as Record<string, unknown>;
    expect(Object.keys(doc).sort()).toEqual(["identity", "reasonCode", "revision", "schemaVersion", "status", "updatedAt", "updatedByUid", "workspaceId"]);
    expect(doc).toMatchObject({ schemaVersion: 1, workspaceId: WS, identity: { identityVersion: 1, canonicalUrl: A.canonicalUrl, idHash: A.idHash }, status: "ACCEPTED", reasonCode: "primary_document", revision: 1, updatedByUid: ADMIN });
    expect(doc.updatedAt).toBeInstanceOf(Timestamp);

    const ev = events(WS, A);
    expect(ev).toHaveLength(1);
    expect(Object.keys(ev[0].data).sort()).toEqual(["actorRole", "actorUid", "at", "fromStatus", "reasonCode", "revision", "schemaVersion", "toStatus"]);
    expect(ev[0].data).toMatchObject({ schemaVersion: 1, fromStatus: null, toStatus: "ACCEPTED", reasonCode: "primary_document", revision: 1, actorUid: ADMIN, actorRole: "admin" });

    const au = audits();
    expect(au).toHaveLength(1);
    expect(au[0].data).toEqual({ eventType: "workspace_source_standing_changed", actorUid: ADMIN, workspaceId: WS, sourceIdHash: A.idHash, previousStatus: null, newStatus: "ACCEPTED", reasonCode: "primary_document", revision: 1, successorIdHash: null, at: doc.updatedAt });
    // Hashes only: the cited URL never reaches the audit trail or the history.
    expect(JSON.stringify(au)).not.toContain("docs.example.com");
    expect(JSON.stringify(ev)).not.toContain("docs.example.com");
    // One timestamp for the whole change.
    expect(ev[0].data.at).toBe(doc.updatedAt);
  });

  it("dispute at the current revision increments it and records the transition", async () => {
    seedCurrent(WS, A, { revision: 3 });
    expect(await applySourceStandingOperation(op({ operation: "dispute", reasonCode: "inaccurate_or_unreliable_for_workspace", expectedRevision: 3, uid: OWNER }))).toEqual({ ok: true, status: "DISPUTED", revision: 4 });
    expect(mockDb.read(cur(WS, A))).toMatchObject({ status: "DISPUTED", revision: 4, updatedByUid: OWNER });
    expect(events(WS, A)[0].data).toMatchObject({ fromStatus: "ACCEPTED", toStatus: "DISPUTED", revision: 4, actorRole: "owner" });
  });

  it("withdraw deletes the current doc and appends a WITHDRAWN event + audit naming the withdrawn revision", async () => {
    seedCurrent(WS, A, { revision: 2 });
    expect(await applySourceStandingOperation(op({ operation: "withdraw", reasonCode: "withdrawn", expectedRevision: 2 }))).toEqual({ ok: true, status: "WITHDRAWN", revision: 2 });
    expect(mockDb.read(cur(WS, A))).toBeUndefined();
    expect(events(WS, A)[0].data).toMatchObject({ fromStatus: "ACCEPTED", toStatus: "WITHDRAWN", reasonCode: "withdrawn", revision: 2 });
    expect(audits()[0].data).toMatchObject({ previousStatus: "ACCEPTED", newStatus: "WITHDRAWN", revision: 2, successorIdHash: null });
  });

  it("ABA: revisions stay monotonic across withdraw → re-attest, so a stale client's revision never matches the new record", async () => {
    expect((await applySourceStandingOperation(op())).ok).toBe(true); // r1
    expect((await applySourceStandingOperation(op({ operation: "withdraw", reasonCode: "withdrawn", expectedRevision: 1 }))).ok).toBe(true);
    expect(await applySourceStandingOperation(op({ operation: "dispute", reasonCode: "inaccurate_or_unreliable_for_workspace" }))).toEqual({ ok: true, status: "DISPUTED", revision: 2 });
    // A client still holding revision 1 from before the withdrawal:
    expect(await applySourceStandingOperation(op({ operation: "accept", reasonCode: "designated_reference", expectedRevision: 1 }))).toEqual({ ok: false, reason: "revision_conflict" });
    expect(mockDb.read(cur(WS, A))).toMatchObject({ status: "DISPUTED", revision: 2 });
    expect(events(WS, A).map((e) => e.data.revision).sort()).toEqual([1, 1, 2]);
  });

  it("a malformed history revision blocks re-creation (history_unresolved), with no writes", async () => {
    mockDb.put(`${cur(WS, A)}/events/e1`, { revision: "7" });
    expect(await applySourceStandingOperation(op())).toEqual({ ok: false, reason: "history_unresolved" });
    expect(mockDb.read(cur(WS, A))).toBeUndefined();
    expect(audits()).toHaveLength(0);
  });
});

describe("optimistic concurrency — expectedRevision is exact and required", () => {
  it.each([
    ["null while a record exists", () => seedCurrent(WS, A), null],
    ["an integer while absent", () => undefined, 1],
    ["a stale integer", () => seedCurrent(WS, A, { revision: 5 }), 4],
    ["a future integer", () => seedCurrent(WS, A, { revision: 5 }), 6],
  ] as const)("%s → revision_conflict, nothing written", async (_n, seed, expectedRevision) => {
    seed();
    const before = JSON.stringify([...mockDb.store.entries()]);
    expect(await applySourceStandingOperation(op({ operation: "dispute", reasonCode: "inaccurate_or_unreliable_for_workspace", expectedRevision }))).toEqual({ ok: false, reason: "revision_conflict" });
    expect(JSON.stringify([...mockDb.store.entries()])).toBe(before);
  });

  it("two writers holding the same revision: exactly one wins; the loser gets 409-class conflict (no app-level retry)", async () => {
    seedCurrent(WS, A, { revision: 1 });
    const [x, y] = await Promise.all([
      applySourceStandingOperation(op({ operation: "dispute", reasonCode: "inaccurate_or_unreliable_for_workspace", expectedRevision: 1 })),
      applySourceStandingOperation(op({ operation: "accept", reasonCode: "designated_reference", expectedRevision: 1 })),
    ]);
    expect([x, y].filter((r) => r.ok)).toHaveLength(1);
    expect([x, y].filter((r) => !r.ok)).toEqual([{ ok: false, reason: "revision_conflict" }]);
    expect(events(WS, A)).toHaveLength(1);
    expect(audits()).toHaveLength(1);
  });

  it("a concurrent commit between our reads and our commit forces a Firestore retry, which then sees the conflict", async () => {
    seedCurrent(WS, A, { revision: 1 });
    mockDb.beforeCommit = (attempt) => {
      if (attempt === 1) seedCurrent(WS, A, { revision: 2, status: "DISPUTED", reasonCode: "inaccurate_or_unreliable_for_workspace" });
    };
    expect(await applySourceStandingOperation(op({ operation: "accept", reasonCode: "designated_reference", expectedRevision: 1 }))).toEqual({ ok: false, reason: "revision_conflict" });
    expect(mockDb.attempts).toBe(2);
    expect(mockDb.read(cur(WS, A))).toMatchObject({ revision: 2, status: "DISPUTED" });
    expect(events(WS, A)).toHaveLength(0);
  });

  it("a concurrent creation of the same source between our reads and commit → retry → revision_conflict (no duplicate revision 1)", async () => {
    mockDb.beforeCommit = (attempt) => {
      if (attempt === 1) {
        seedCurrent(WS, A, { revision: 1 });
        mockDb.put(`${cur(WS, A)}/events/other`, { schemaVersion: 1, revision: 1 });
      }
    };
    expect(await applySourceStandingOperation(op())).toEqual({ ok: false, reason: "revision_conflict" });
  });

  it("retry idempotency: event and audit ids are allocated once — an aborted attempt never duplicates them", async () => {
    mockDb.beforeCommit = (attempt) => (attempt === 1 ? "abort" : undefined);
    expect(await applySourceStandingOperation(op())).toEqual({ ok: true, status: "ACCEPTED", revision: 1 });
    expect(mockDb.attempts).toBe(2);
    expect(events(WS, A)).toHaveLength(1);
    expect(audits()).toHaveLength(1);
    expect(mockDb.autoId).toBe(2); // one event id + one audit id, total, across both attempts
  });
});

describe("SUPERSEDED — successor validation inside the transaction", () => {
  const sup = (successor: SourceIdentityV1, expectedRevision: number | null = null) => op({ operation: "supersede", reasonCode: "replaced_by_successor", successorIdentity: successor, expectedRevision });

  it("a valid successor with a current record → stored successorIdHash; event + audit carry the hash", async () => {
    seedCurrent(WS, B);
    expect(await applySourceStandingOperation(sup(B))).toEqual({ ok: true, status: "SUPERSEDED", revision: 1 });
    expect(mockDb.read(cur(WS, A))).toMatchObject({ status: "SUPERSEDED", successorIdHash: B.idHash });
    expect(events(WS, A)[0].data.successorIdHash).toBe(B.idHash);
    expect(audits()[0].data.successorIdHash).toBe(B.idHash);
  });

  it("the successor must be distinct (rejected before any read)", async () => {
    expect(await applySourceStandingOperation(sup(A))).toEqual({ ok: false, reason: "successor_invalid", detail: "same_as_source" });
    expect(mockDb.reads).toEqual([]);
  });

  it.each([
    ["missing successor record", () => undefined, "successor_missing"],
    ["successor only in ANOTHER Workspace", () => seedCurrent(WS2, B), "successor_missing"],
    ["malformed successor record", () => mockDb.put(cur(WS, B), { junk: true }), "successor_malformed"],
    [
      "successor chain has a missing link",
      () => seedCurrent(WS, B, { status: "SUPERSEDED", reasonCode: "replaced_by_successor", successorIdHash: C.idHash }),
      "successor_missing",
    ],
  ])("%s → successor_invalid (%s), nothing written", async (_n, seed, detail) => {
    seed();
    expect(await applySourceStandingOperation(sup(B))).toEqual({ ok: false, reason: "successor_invalid", detail });
    expect(mockDb.read(cur(WS, A))).toBeUndefined();
    expect(audits()).toHaveLength(0);
  });

  it("a would-be cycle back to the source is refused before the walk: the source is already referenced (P2)", async () => {
    seedCurrent(WS, A);
    seedCurrent(WS, B, { status: "SUPERSEDED", reasonCode: "replaced_by_successor", successorIdHash: A.idHash });
    expect(await applySourceStandingOperation(sup(B, 1))).toEqual({ ok: false, reason: "source_is_referenced" });
    expect(mockDb.read(cur(WS, A))).toMatchObject({ status: "ACCEPTED", revision: 1 });
    expect(audits()).toHaveLength(0);
  });

  it("chain depth: 8 edges from the new record is accepted; 9 is chain_too_deep — reads bounded (≤ 12 documents + ≤ 2 limit-1 queries)", async () => {
    const ids = Array.from({ length: 10 }, (_, i) => ident(`s${i}`));
    // ids[1] → ids[2] → … → ids[k] (ACCEPTED). Superseding A by ids[1] adds the A→ids[1] edge.
    const build = (lastIndex: number) => {
      for (let i = 1; i <= lastIndex; i += 1) seedCurrent(WS, ids[i], i < lastIndex ? { status: "SUPERSEDED", reasonCode: "replaced_by_successor", successorIdHash: ids[i + 1].idHash } : {});
    };
    build(8); // A→1→…→8 = 8 edges
    mockDb.reads = [];
    expect((await applySourceStandingOperation(sup(ids[1]))).ok).toBe(true);
    expect(mockDb.reads.filter((r) => r.kind === "doc").length).toBeLessThanOrEqual(12);
    const queries = mockDb.reads.filter((r) => r.kind === "query");
    expect(queries).toHaveLength(2); // history revision (create) + inbound reference (supersede)
    expect(queries.every((q) => q.kind === "query" && q.limit === 1 && q.via === "tx")).toBe(true);

    mockDb = new FakeDb();
    seedWorkspace(WS, { [OWNER]: "owner", [ADMIN]: "admin" });
    build(9); // A→1→…→9 = 9 edges
    mockDb.reads = [];
    expect(await applySourceStandingOperation(sup(ids[1]))).toEqual({ ok: false, reason: "successor_invalid", detail: "chain_too_deep" });
    // workspace + caller + owner membership + current + 8 successor documents — never a 9th — plus the 2 queries.
    expect(standingReads().filter((r) => r.kind === "doc" && !r.path.endsWith(A.idHash)).length).toBe(8);
    expect(mockDb.reads.filter((r) => r.kind === "doc").length).toBe(12);
    expect(mockDb.reads.filter((r) => r.kind === "query")).toHaveLength(2);
  });
});

describe("authorization — sources.attest, re-checked inside the transaction", () => {
  it.each(["member-1", "reviewer-1", "viewer-1"])("%s is denied (insufficient_capability) and never reads Source Standing", async (uid) => {
    const before = JSON.stringify([...mockDb.store.entries()]);
    expect(await applySourceStandingOperation(op({ uid }))).toEqual({ ok: false, reason: "denied", denial: "insufficient_capability" });
    expect(standingReads()).toEqual([]);
    expect(JSON.stringify([...mockDb.store.entries()])).toBe(before);
  });

  it("a non-member (or a member of a different Workspace) is denied", async () => {
    expect(await applySourceStandingOperation(op({ uid: "stranger" }))).toEqual({ ok: false, reason: "denied", denial: "membership_not_found" });
  });

  it("a removed Admin is denied", async () => {
    const id = computeMembershipId(WS, ADMIN);
    mockDb.put(`workspaceMemberships/${id}`, { ...(mockDb.read(`workspaceMemberships/${id}`) as object), status: "removed", removedAt: ts(3000), removedByUserId: OWNER });
    expect(await applySourceStandingOperation(op())).toEqual({ ok: false, reason: "denied", denial: "membership_removed" });
  });

  it("a Personal Workspace is denied (Team Workspaces only)", async () => {
    mockDb.put(`workspaces/${WS}`, { ...(mockDb.read(`workspaces/${WS}`) as object), type: "personal" });
    const r = await applySourceStandingOperation(op());
    expect(r.ok).toBe(false);
    expect(standingReads()).toEqual([]);
  });

  it("revocation race: the Admin is demoted between the route precheck and the commit → retried transaction denies", async () => {
    const id = computeMembershipId(WS, ADMIN);
    mockDb.beforeCommit = (attempt) => {
      if (attempt === 1) mockDb.put(`workspaceMemberships/${id}`, { ...(mockDb.read(`workspaceMemberships/${id}`) as object), role: "member" });
    };
    expect(await applySourceStandingOperation(op())).toEqual({ ok: false, reason: "denied", denial: "insufficient_capability" });
    expect(mockDb.read(cur(WS, A))).toBeUndefined();
  });
});

describe("input contract enforced before any read", () => {
  it.each([
    ["reason not allowed for the status", op({ reasonCode: "inaccurate_or_unreliable_for_workspace" })],
    ["supersede without successor", op({ operation: "supersede", reasonCode: "replaced_by_successor" })],
    ["successor on a non-supersede", op({ successorIdentity: B })],
  ])("%s → invalid_operation", async (_n, args) => {
    expect(await applySourceStandingOperation(args)).toEqual({ ok: false, reason: "invalid_operation" });
    expect(mockDb.reads).toEqual([]);
  });

  it("withdraw with expectedRevision null → nothing_to_withdraw", async () => {
    expect(await applySourceStandingOperation(op({ operation: "withdraw", reasonCode: "withdrawn" }))).toEqual({ ok: false, reason: "nothing_to_withdraw" });
    expect(mockDb.reads).toEqual([]);
  });

  it("a malformed current record is never repaired or overwritten (current_unresolved)", async () => {
    mockDb.put(cur(WS, A), { schemaVersion: 99 });
    expect(await applySourceStandingOperation(op({ expectedRevision: 1 }))).toEqual({ ok: false, reason: "current_unresolved" });
    expect(mockDb.read(cur(WS, A))).toEqual({ schemaVersion: 99 });
  });
});

describe("readers — exact-document, batched, bounded", () => {
  it("loadStandingPresentations: null identities are never read; absent → null; one getAll per chain level", async () => {
    seedCurrent(WS, A, { status: "SUPERSEDED", reasonCode: "replaced_by_successor", successorIdHash: B.idHash });
    seedCurrent(WS, B);
    const out = await loadStandingPresentations(WS, [A, null, C]);
    expect(out).toEqual([{ status: "SUPERSEDED", asOf: "1970-01-01T00:33:20.000Z", successorUrl: B.canonicalUrl }, null, null]);
    expect(mockDb.reads.every((r) => r.kind === "doc" && r.via === "getAll")).toBe(true);
    expect(mockDb.reads.map((r) => r.path)).toEqual([cur(WS, A), cur(WS, C), cur(WS, B)]);
  });

  it("loadStandingPresentations: no identities → zero reads", async () => {
    expect(await loadStandingPresentations(WS, [null, null])).toEqual([null, null]);
    expect(mockDb.reads).toEqual([]);
  });

  it("loadStandingPresentations: 10 links each with an 8-edge chain stay within 9 getAll rounds and ≤ 90 document reads", async () => {
    const heads: SourceIdentityV1[] = [];
    for (let h = 0; h < 10; h += 1) {
      const ids = Array.from({ length: 9 }, (_, i) => ident(`h${h}n${i}`));
      ids.forEach((id, i) => seedCurrent(WS, id, i < 8 ? { status: "SUPERSEDED", reasonCode: "replaced_by_successor", successorIdHash: ids[i + 1].idHash } : {}));
      heads.push(ids[0]);
    }
    const getAllSpy = jest.spyOn(mockDb, "getAll");
    const out = await loadStandingPresentations(WS, heads);
    expect(out.every((p) => p?.status === "SUPERSEDED")).toBe(true);
    expect(getAllSpy.mock.calls.length).toBeLessThanOrEqual(9);
    expect(mockDb.reads.length).toBeLessThanOrEqual(90);
  });

  it("readStandingForManagement: absent / current (+revision) / malformed → UNRESOLVED; successor resolution reported", async () => {
    expect(await readStandingForManagement(WS, A)).toEqual({ kind: "absent" });
    seedCurrent(WS, A, { revision: 4, status: "SUPERSEDED", reasonCode: "replaced_by_successor", successorIdHash: B.idHash });
    expect(await readStandingForManagement(WS, A)).toEqual({ kind: "current", status: "SUPERSEDED", reasonCode: "replaced_by_successor", revision: 4, asOf: "1970-01-01T00:33:20.000Z", successor: { resolved: false } });
    seedCurrent(WS, B);
    expect(await readStandingForManagement(WS, A)).toMatchObject({ successor: { resolved: true, url: B.canonicalUrl } });
    mockDb.put(cur(WS, C), { bogus: 1 });
    expect(await readStandingForManagement(WS, C)).toEqual({ kind: "unresolved" });
  });

  it("readers never cross Workspaces", async () => {
    seedCurrent(WS2, A);
    expect(await readStandingForManagement(WS, A)).toEqual({ kind: "absent" });
    expect(await loadStandingPresentations(WS, [A])).toEqual([null]);
  });
});
