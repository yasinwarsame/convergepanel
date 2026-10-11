/**
 * Order 4 Slice 2a — strict current-state parser, fail-closed resolver and the
 * allow-listed presentation projection. Pure: no Firestore.
 */
import { Timestamp } from "firebase-admin/firestore";
import { sourceIdentityV1, type SourceIdentityV1 } from "@/lib/sourceStanding/sourceIdentity";
import { isReasonAllowed, isSourceStandingOperation, isSourceStandingStatus, MAX_SUCCESSOR_CHAIN_DEPTH, parseSourceStandingCurrent, statusForOperation} from "@/lib/sourceStanding/standingTypes";
import { resolveSourceStanding, toStandingPresentation, walkSuccessorChain, type StandingLookup } from "@/lib/sourceStanding/resolveStanding";

const WS = "ws-1";
const AT = Timestamp.fromMillis(Date.UTC(2026, 9, 1, 12));
const ident = (path: string) => sourceIdentityV1(`https://docs.example.com/${path}`) as SourceIdentityV1;
const A = ident("a");
const B = ident("b");

function record(identity: SourceIdentityV1, fields: Record<string, unknown> = {}) {
  return { schemaVersion: 1, workspaceId: WS, identity: { ...identity }, status: "ACCEPTED", reasonCode: "primary_document", revision: 1, updatedAt: AT, updatedByUid: "admin-1", ...fields };
}
const parse = (raw: unknown, docId = A.idHash) => parseSourceStandingCurrent(raw, { expectedWorkspaceId: WS, docId });
const fromMap = (m: Record<string, unknown>): StandingLookup => (id) => (Object.prototype.hasOwnProperty.call(m, id) ? { state: "present", data: m[id] } : { state: "absent" });

describe("vocabulary", () => {
  it("statuses are exactly ACCEPTED / DISPUTED / SUPERSEDED (WITHDRAWN is never an active status)", () => {
    for (const s of ["ACCEPTED", "DISPUTED", "SUPERSEDED"]) expect(isSourceStandingStatus(s)).toBe(true);
    for (const s of ["WITHDRAWN", "PROVISIONAL", "CONFIRMED", "CONTESTED", "TRUSTED", "UNTRUSTED", "VERIFIED", "HIGH_AUTHORITY", "LOW_AUTHORITY", "UNRESOLVED", "accepted", "toString", "__proto__", "constructor", "", null]) {
      expect(isSourceStandingStatus(s)).toBe(false);
    }
  });

  it("operations map to exactly one status each; prototype names are not operations", () => {
    expect(["accept", "dispute", "supersede", "withdraw"].map((o) => (isSourceStandingOperation(o) ? statusForOperation(o) : null))).toEqual(["ACCEPTED", "DISPUTED", "SUPERSEDED", "WITHDRAWN"]);
    for (const o of ["toString", "__proto__", "hasOwnProperty", "ACCEPT", "verify", "restore", ""]) expect(isSourceStandingOperation(o)).toBe(false);
  });

  it.each([
    ["ACCEPTED", "primary_document", true],
    ["ACCEPTED", "designated_reference", true],
    ["ACCEPTED", "inaccurate_or_unreliable_for_workspace", false],
    ["ACCEPTED", "withdrawn", false],
    ["DISPUTED", "inaccurate_or_unreliable_for_workspace", true],
    ["DISPUTED", "primary_document", false],
    ["SUPERSEDED", "replaced_by_successor", true],
    ["SUPERSEDED", "designated_reference", false],
    ["WITHDRAWN", "withdrawn", true],
    ["WITHDRAWN", "primary_document", false],
    ["ACCEPTED", "toString", false],
    ["ACCEPTED", "length", false],
  ] as const)("%s + %s → %s", (status, reason, ok) => {
    expect(isReasonAllowed(status, reason)).toBe(ok);
  });

});

describe("parseSourceStandingCurrent — strict, fail closed", () => {
  it("accepts a well-formed record for each status", () => {
    expect(parse(record(A))).toMatchObject({ ok: true });
    expect(parse(record(A, { status: "DISPUTED", reasonCode: "inaccurate_or_unreliable_for_workspace" }))).toMatchObject({ ok: true });
    expect(parse(record(A, { status: "SUPERSEDED", reasonCode: "replaced_by_successor", successorIdHash: B.idHash }))).toMatchObject({ ok: true });
  });

  it.each([
    ["not an object", null, "not_an_object"],
    ["array", [], "not_an_object"],
    ["extra key", record(A, { trusted: true }), "unexpected_keys"],
    ["extra key: score", record(A, { score: 1 }), "unexpected_keys"],
    ["schemaVersion 2", record(A, { schemaVersion: 2 }), "unknown_schema_version"],
    ["schemaVersion missing", (({ schemaVersion: _s, ...r }) => r)(record(A)), "unknown_schema_version"],
    ["foreign workspace", record(A, { workspaceId: "ws-2" }), "workspace_mismatch"],
    ["identity missing", record(A, { identity: undefined }), "malformed_identity"],
    ["identity extra key", record(A, { identity: { ...A, extra: 1 } }), "malformed_identity"],
    ["identity version 2", record(A, { identity: { ...A, identityVersion: 2 } }), "unknown_identity_version"],
    ["idHash ≠ doc id", record(B), "doc_id_mismatch"],
    ["hash does not match URL", record(A, { identity: { ...A, canonicalUrl: B.canonicalUrl } }), "identity_hash_mismatch"],
    ["WITHDRAWN as current", record(A, { status: "WITHDRAWN", reasonCode: "withdrawn" }), "unknown_status"],
    ["status VERIFIED", record(A, { status: "VERIFIED" }), "unknown_status"],
    ["reason/status mismatch", record(A, { reasonCode: "replaced_by_successor" }), "reason_status_mismatch"],
    ["SUPERSEDED without successor", record(A, { status: "SUPERSEDED", reasonCode: "replaced_by_successor" }), "successor_shape"],
    ["SUPERSEDED self-successor", record(A, { status: "SUPERSEDED", reasonCode: "replaced_by_successor", successorIdHash: A.idHash }), "successor_shape"],
    ["SUPERSEDED bad successor hash", record(A, { status: "SUPERSEDED", reasonCode: "replaced_by_successor", successorIdHash: "B" }), "successor_shape"],
    ["ACCEPTED with successor", record(A, { successorIdHash: B.idHash }), "successor_shape"],
    ["revision 0", record(A, { revision: 0 }), "malformed_revision"],
    ["revision 1.5", record(A, { revision: 1.5 }), "malformed_revision"],
    ["revision string", record(A, { revision: "1" }), "malformed_revision"],
    ["updatedAt string", record(A, { updatedAt: "2026-10-01" }), "malformed_timestamp"],
    ["updatedAt invalid date", record(A, { updatedAt: { toDate: () => new Date(NaN) } }), "malformed_timestamp"],
    ["updatedByUid empty", record(A, { updatedByUid: "" }), "malformed_actor"],
  ])("%s → %s", (_name, raw, reason) => {
    const data = raw && typeof raw === "object" && !Array.isArray(raw) ? Object.fromEntries(Object.entries(raw).filter(([, v]) => v !== undefined)) : raw;
    expect(parse(data)).toEqual({ ok: false, reason });
  });

  it("a non-canonical stored URL is malformed even when its hash matches", () => {
    const url = "https://docs.example.com/a#frag";
    const { sourceIdHash } = jest.requireActual("@/lib/sourceStanding/sourceIdentity");
    const h = sourceIdHash(url);
    expect(parse(record(A, { identity: { identityVersion: 1, canonicalUrl: url, idHash: h } }), h)).toEqual({ ok: false, reason: "malformed_identity" });
  });
});

describe("resolveSourceStanding / walkSuccessorChain", () => {
  it("absent is absent — never ACCEPTED", () => {
    expect(resolveSourceStanding(WS, A.idHash, fromMap({}))).toEqual({ kind: "absent" });
    expect(toStandingPresentation({ kind: "absent" })).toBeNull();
  });

  it("not loaded → needs exactly that id (the Firestore layer batches it)", () => {
    expect(resolveSourceStanding(WS, A.idHash, () => ({ state: "not_loaded" }))).toEqual({ kind: "needs", idHash: A.idHash });
    const lookup: StandingLookup = (id) => (id === A.idHash ? { state: "present", data: record(A, { status: "SUPERSEDED", reasonCode: "replaced_by_successor", successorIdHash: B.idHash }) } : { state: "not_loaded" });
    expect(resolveSourceStanding(WS, A.idHash, lookup)).toEqual({ kind: "needs", idHash: B.idHash });
  });

  it("SUPERSEDED resolves to the IMMEDIATE successor's URL after validating the whole chain", () => {
    const C = ident("c");
    const m = {
      [A.idHash]: record(A, { status: "SUPERSEDED", reasonCode: "replaced_by_successor", successorIdHash: B.idHash }),
      [B.idHash]: record(B, { status: "SUPERSEDED", reasonCode: "replaced_by_successor", successorIdHash: C.idHash }),
      [C.idHash]: record(C),
    };
    const r = resolveSourceStanding(WS, A.idHash, fromMap(m));
    expect(r.kind).toBe("resolved");
    expect(toStandingPresentation(r as never)).toEqual({ status: "SUPERSEDED", asOf: "2026-10-01T12:00:00.000Z", successorUrl: B.canonicalUrl });
  });

  it.each([
    ["missing successor", {}, "successor_missing"],
    ["malformed successor", { b: { bogus: true } }, "successor_malformed"],
    ["successor from another Workspace", { b: "foreign" }, "successor_malformed"],
  ])("%s → UNRESOLVED (%s)", (_n, extra, reason) => {
    const m: Record<string, unknown> = { [A.idHash]: record(A, { status: "SUPERSEDED", reasonCode: "replaced_by_successor", successorIdHash: B.idHash }) };
    if ("b" in extra) m[B.idHash] = extra.b === "foreign" ? record(B, { workspaceId: "ws-2" }) : extra.b;
    expect(resolveSourceStanding(WS, A.idHash, fromMap(m))).toEqual({ kind: "unresolved", reason });
  });

  it("a cycle back to the source → UNRESOLVED (cycle)", () => {
    const m = {
      [A.idHash]: record(A, { status: "SUPERSEDED", reasonCode: "replaced_by_successor", successorIdHash: B.idHash }),
      [B.idHash]: record(B, { status: "SUPERSEDED", reasonCode: "replaced_by_successor", successorIdHash: A.idHash }),
    };
    expect(resolveSourceStanding(WS, A.idHash, fromMap(m))).toEqual({ kind: "unresolved", reason: "cycle" });
  });

  it("a cycle not including the source (A→B→C→B) → cycle", () => {
    const C = ident("c");
    const m = {
      [A.idHash]: record(A, { status: "SUPERSEDED", reasonCode: "replaced_by_successor", successorIdHash: B.idHash }),
      [B.idHash]: record(B, { status: "SUPERSEDED", reasonCode: "replaced_by_successor", successorIdHash: C.idHash }),
      [C.idHash]: record(C, { status: "SUPERSEDED", reasonCode: "replaced_by_successor", successorIdHash: B.idHash }),
    };
    expect(resolveSourceStanding(WS, A.idHash, fromMap(m))).toEqual({ kind: "unresolved", reason: "cycle" });
  });

  function chain(edges: number) {
    const ids = Array.from({ length: edges + 1 }, (_, i) => ident(`n${i}`));
    const m: Record<string, unknown> = {};
    ids.forEach((id, i) => {
      m[id.idHash] = i < edges ? record(id, { status: "SUPERSEDED", reasonCode: "replaced_by_successor", successorIdHash: ids[i + 1].idHash }) : record(id);
    });
    return { ids, m };
  }

  it(`exactly ${MAX_SUCCESSOR_CHAIN_DEPTH} edges resolves; ${MAX_SUCCESSOR_CHAIN_DEPTH + 1} → chain_too_deep`, () => {
    expect(MAX_SUCCESSOR_CHAIN_DEPTH).toBe(8);
    const ok = chain(8);
    expect(resolveSourceStanding(WS, ok.ids[0].idHash, fromMap(ok.m)).kind).toBe("resolved");
    const deep = chain(9);
    expect(resolveSourceStanding(WS, deep.ids[0].idHash, fromMap(deep.m))).toEqual({ kind: "unresolved", reason: "chain_too_deep" });
  });

  it("the walk never looks up more than MAX_SUCCESSOR_CHAIN_DEPTH successors", () => {
    const deep = chain(20);
    const seen: string[] = [];
    walkSuccessorChain(WS, deep.ids[0].idHash, deep.ids[1].idHash, (id) => {
      seen.push(id);
      return fromMap(deep.m)(id);
    });
    expect(seen.length).toBe(MAX_SUCCESSOR_CHAIN_DEPTH);
  });
});

describe("toStandingPresentation — allow-listed projection", () => {
  it("UNRESOLVED carries ONLY the status: no fabricated asOf, actor, reason or revision", () => {
    expect(toStandingPresentation({ kind: "unresolved", reason: "workspace_mismatch" })).toEqual({ status: "UNRESOLVED" });
  });

  it("resolved ACCEPTED/DISPUTED carry status + asOf only (no actor, reason, revision, identity, history)", () => {
    const parsed = parse(record(A, { status: "DISPUTED", reasonCode: "inaccurate_or_unreliable_for_workspace", revision: 7 }));
    if (!parsed.ok) throw new Error("fixture");
    const p = toStandingPresentation({ kind: "resolved", current: parsed.current });
    expect(p).toEqual({ status: "DISPUTED", asOf: "2026-10-01T12:00:00.000Z" });
    expect(Object.keys(p as object).sort()).toEqual(["asOf", "status"]);
  });
});
