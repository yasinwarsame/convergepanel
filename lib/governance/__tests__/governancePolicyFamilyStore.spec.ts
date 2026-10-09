/**
 * Step 6 D5.2A — governance policy store: score-type map read / set / clear,
 * and the per-version before/after audit snapshot.
 *
 * The fake models the two Firestore semantics this depends on:
 * - `set(..., { merge: true })` merges NESTED maps field by field (it does not
 *   replace a nested map, and it never deletes a key it was not given);
 * - `FieldValue.delete()` inside a merge write removes exactly that key.
 * plus the optimistic transaction (read versions, buffered writes, retry on
 * conflict) used by the Step 6.0a atomicity spec, including its concurrency gate.
 */

jest.mock("firebase-admin/firestore", () => {
  class FieldValue {
    constructor(readonly kind: string) {}
    static serverTimestamp() {
      return new FieldValue("serverTimestamp");
    }
    static delete() {
      return new FieldValue("delete");
    }
  }
  class Timestamp {}
  return { FieldValue, Timestamp };
});
const warn = jest.fn();
jest.mock("@/lib/logger", () => ({ logger: { warn: (...a: unknown[]) => warn(...a), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

type Doc = { data: Record<string, unknown>; version: number };
const store = new Map<string, Doc>();
let autoId = 0;
let gate: { size: number; arrived: number; release: () => void; wait: Promise<void> } | null = null;
function openGate(size: number) {
  let release!: () => void;
  const wait = new Promise<void>((r) => { release = r; });
  gate = { size, arrived: 0, release, wait };
}

const isDelete = (v: unknown) => typeof v === "object" && v !== null && (v as { kind?: string }).kind === "delete";
const isPlain = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && (v as { kind?: string }).kind === undefined;
/** Firestore merge semantics: nested plain maps merge recursively; delete sentinels remove keys. */
function deepMerge(target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...target };
  for (const [k, v] of Object.entries(patch)) {
    if (isDelete(v)) delete out[k];
    else if (isPlain(v)) out[k] = deepMerge(isPlain(out[k]) ? (out[k] as Record<string, unknown>) : {}, v);
    else out[k] = v;
  }
  return out;
}
function write(path: string, fields: Record<string, unknown>, merge: boolean) {
  const prev = store.get(path);
  if (!merge && Object.values(fields).some(isDelete)) throw new Error("FieldValue.delete() requires merge");
  store.set(path, { data: merge && prev ? deepMerge(prev.data, fields) : deepMerge({}, fields), version: (prev?.version ?? 0) + 1 });
}
const snap = (path: string) => ({ exists: store.has(path), data: () => (store.has(path) ? structuredClone(store.get(path)!.data) : undefined) });

function docRef(path: string): any {
  return {
    __path: path,
    get: async () => snap(path),
    set: async (fields: Record<string, unknown>, opts?: { merge?: boolean }) => write(path, fields, opts?.merge === true),
    collection: (sub: string) => ({ doc: (id?: string) => docRef(`${path}/${sub}/${id ?? `auto-${++autoId}`}`) }),
  };
}
const mockDb = {
  collection: (name: string) => ({ doc: (id: string) => docRef(`${name}/${id}`) }),
  runTransaction: async <T,>(fn: (txn: unknown) => Promise<T>): Promise<T> => {
    for (let attempt = 0; attempt < 10; attempt++) {
      const reads = new Map<string, number>();
      const writes: Array<{ path: string; fields: Record<string, unknown>; merge: boolean }> = [];
      const result = await fn({
        get: async (ref: { __path: string }) => {
          reads.set(ref.__path, store.get(ref.__path)?.version ?? 0);
          return snap(ref.__path);
        },
        set: (ref: { __path: string }, fields: Record<string, unknown>, opts?: { merge?: boolean }) => {
          writes.push({ path: ref.__path, fields, merge: opts?.merge === true });
        },
      });
      if (attempt === 0 && gate) {
        const g = gate;
        g.arrived += 1;
        if (g.arrived >= g.size) g.release();
        await g.wait;
      }
      if ([...reads].some(([p, v]) => (store.get(p)?.version ?? 0) !== v)) continue;
      for (const w of writes) write(w.path, w.fields, w.merge);
      return result;
    }
    throw new Error("ABORTED");
  },
};
jest.mock("@/lib/firebase/admin", () => ({ get adminDb() { return mockDb; } }));

import { pickPolicyFields, saveGovernancePolicyMerge, loadGovernancePolicy, type GovernancePolicyMutation } from "@/lib/governance/governancePolicyStore";
import { GOVERNANCE_POLICY_DOC_PATH } from "@/lib/governance/governanceFirestore";
import { getDefaultGovernancePolicy } from "@/lib/governance/evaluateGovernance";
import { familyReviewThresholdChangeNames } from "@/lib/governance/familyReviewThresholds";

const POLICY_PATH = `${GOVERNANCE_POLICY_DOC_PATH.collection}/${GOVERNANCE_POLICY_DOC_PATH.docId}`;
const doc = () => store.get(POLICY_PATH)!.data;
const auditEvents = () =>
  [...store.entries()]
    .filter(([p]) => p.startsWith(`${POLICY_PATH}/auditEvents/`))
    .map(([, d]) => d.data)
    .sort((a, b) => (a.policyVersion as number) - (b.policyVersion as number));

const save = (mutation: GovernancePolicyMutation, names?: string[]) =>
  saveGovernancePolicyMerge(
    mutation,
    "gov-admin",
    "gov-admin@test-invented.example",
    "change",
    names ??
      Object.keys(mutation).flatMap((k) =>
        k === "scoreFamilyReviewThresholds" ? familyReviewThresholdChangeNames(mutation.scoreFamilyReviewThresholds!) : [k]
      )
  );

beforeEach(() => {
  store.clear();
  autoId = 0;
  gate = null;
  warn.mockClear();
  // The Production document as read in D5.2 (defaults, v1), plus its bookkeeping fields.
  write(POLICY_PATH, { ...getDefaultGovernancePolicy(), updatedAt: "2026-03-24T18:00:56.766Z", updatedBy: "system" }, false);
});

describe("pickPolicyFields — read path", () => {
  it("the legacy Production-shaped document reads as the defaults, with no family map key at all", () => {
    const p = pickPolicyFields(doc());
    expect(p).toEqual(getDefaultGovernancePolicy());
    expect("scoreFamilyReviewThresholds" in p).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });
  it("valid overrides are kept", () => {
    expect(pickPolicyFields({ ...doc(), scoreFamilyReviewThresholds: { video_agreement_v1: 75, research_synthesis_v1: 0 } }).scoreFamilyReviewThresholds).toEqual({
      video_agreement_v1: 75,
      research_synthesis_v1: 0,
    });
  });
  it("malformed entries are discarded, warned by NAME only, and the document is not touched", () => {
    const before = structuredClone(doc());
    const raw = { ...doc(), scoreFamilyReviewThresholds: { video_agreement_v1: "SECRET-77", research_synthesis_v1: 80, claim_verification_v1: 91 } };
    const p = pickPolicyFields(raw);
    expect(p.scoreFamilyReviewThresholds).toEqual({ research_synthesis_v1: 80 });
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(warn.mock.calls[0]);
    expect(logged).toContain("scoreFamilyReviewThresholds.video_agreement_v1");
    expect(logged).toContain("scoreFamilyReviewThresholds.claim_verification_v1");
    expect(logged).not.toContain("SECRET-77");
    expect(logged).not.toContain("91");
    expect(doc()).toEqual(before);
  });
  it("a fully malformed map reads exactly like no map", () => {
    expect(pickPolicyFields({ ...doc(), scoreFamilyReviewThresholds: [70] })).toEqual(getDefaultGovernancePolicy());
  });
  it("loadGovernancePolicy performs no write on an existing document", async () => {
    const version = store.get(POLICY_PATH)!.version;
    await loadGovernancePolicy();
    expect(store.get(POLICY_PATH)!.version).toBe(version);
  });
});

describe("saveGovernancePolicyMerge — score-type set / clear", () => {
  it("set video → only video persisted; version +1; legacy fields unchanged", async () => {
    const out = await save({ scoreFamilyReviewThresholds: { video_agreement_v1: 75 } });
    expect(out.policyVersion).toBe(2);
    expect(out.scoreFamilyReviewThresholds).toEqual({ video_agreement_v1: 75 });
    expect(doc().scoreFamilyReviewThresholds).toEqual({ video_agreement_v1: 75 });
    expect(doc().minConsensusToAvoidReview).toBe(70);
    expect(doc().minConsensusToApprove).toBe(80);
  });

  it("video 75 + research 80 → update video 72 → research intact → clear video → research intact, no null left", async () => {
    await save({ scoreFamilyReviewThresholds: { video_agreement_v1: 75, research_synthesis_v1: 80 } });
    await save({ scoreFamilyReviewThresholds: { video_agreement_v1: 72 } });
    expect(doc().scoreFamilyReviewThresholds).toEqual({ video_agreement_v1: 72, research_synthesis_v1: 80 });
    await save({ scoreFamilyReviewThresholds: { video_agreement_v1: null } });
    expect(doc().scoreFamilyReviewThresholds).toEqual({ research_synthesis_v1: 80 });
    expect(Object.prototype.hasOwnProperty.call(doc().scoreFamilyReviewThresholds, "video_agreement_v1")).toBe(false);
    expect(doc().policyVersion).toBe(4);
  });

  it("the write is a DELTA: a video change sends only the video key (the other family is never rewritten)", async () => {
    write(POLICY_PATH, { scoreFamilyReviewThresholds: { research_synthesis_v1: 80 } }, true);
    const sets: Record<string, unknown>[] = [];
    const real = mockDb.runTransaction;
    mockDb.runTransaction = (fn: any) =>
      real((txn: any) => fn({ ...txn, set: (ref: any, fields: any, opts: any) => { if (ref.__path === POLICY_PATH) sets.push(fields); return txn.set(ref, fields, opts); } }));
    try {
      await save({ scoreFamilyReviewThresholds: { video_agreement_v1: 61 } });
    } finally {
      mockDb.runTransaction = real;
    }
    expect(sets).toHaveLength(1);
    expect(sets[0].scoreFamilyReviewThresholds).toEqual({ video_agreement_v1: 61 });
  });

  it("a legacy-only save neither writes nor drops the family map", async () => {
    await save({ scoreFamilyReviewThresholds: { research_synthesis_v1: 80 } });
    await save({ minConsensusToAvoidReview: 68 });
    expect(doc().scoreFamilyReviewThresholds).toEqual({ research_synthesis_v1: 80 });
    expect(doc().minConsensusToAvoidReview).toBe(68);
  });

  it("clearing the only override removes it entirely; the document then reads as legacy", async () => {
    await save({ scoreFamilyReviewThresholds: { video_agreement_v1: 75 } });
    await save({ scoreFamilyReviewThresholds: { video_agreement_v1: null } });
    expect(doc().scoreFamilyReviewThresholds).toEqual({});
    expect("scoreFamilyReviewThresholds" in pickPolicyFields(doc())).toBe(false);
  });

  it("a legacy save does not heal or drop a malformed stored entry it did not touch", async () => {
    write(POLICY_PATH, { scoreFamilyReviewThresholds: { video_agreement_v1: "bad" } }, true);
    await save({ reviewIfAnyModelFailed: false });
    expect(doc().scoreFamilyReviewThresholds).toEqual({ video_agreement_v1: "bad" });
  });
});

describe("per-version audit snapshot (same transaction)", () => {
  it("records before/after of exactly the changed fields; absent override = null", async () => {
    await save({ scoreFamilyReviewThresholds: { video_agreement_v1: 75 } });
    const [ev] = auditEvents();
    expect(ev).toEqual(
      expect.objectContaining({
        action: "policy_updated",
        policyVersion: 2,
        changes: ["scoreFamilyReviewThresholds.video_agreement_v1"],
        before: { "scoreFamilyReviewThresholds.video_agreement_v1": null },
        after: { "scoreFamilyReviewThresholds.video_agreement_v1": 75 },
      })
    );
  });
  it("a clear records the old number → null", async () => {
    await save({ scoreFamilyReviewThresholds: { research_synthesis_v1: 80 } });
    await save({ scoreFamilyReviewThresholds: { research_synthesis_v1: null } });
    const ev = auditEvents()[1];
    expect(ev.before).toEqual({ "scoreFamilyReviewThresholds.research_synthesis_v1": 80 });
    expect(ev.after).toEqual({ "scoreFamilyReviewThresholds.research_synthesis_v1": null });
  });
  it("legacy field changes get values too, and only the changed fields appear", async () => {
    await save({ minConsensusToAvoidReview: 66, reviewIfVerificationVerdictIn: ["Disputed"] });
    const [ev] = auditEvents();
    expect(ev.changes).toEqual(["minConsensusToAvoidReview", "reviewIfVerificationVerdictIn"]);
    expect(ev.before).toEqual({ minConsensusToAvoidReview: 70, reviewIfVerificationVerdictIn: ["Disputed", "Unverifiable", "Partially True"] });
    expect(ev.after).toEqual({ minConsensusToAvoidReview: 66, reviewIfVerificationVerdictIn: ["Disputed"] });
  });
  it("concurrent saves: distinct consecutive versions, and each snapshot's 'before' is the state its own version replaced", async () => {
    openGate(3);
    await Promise.all([
      save({ scoreFamilyReviewThresholds: { video_agreement_v1: 71 } }),
      save({ scoreFamilyReviewThresholds: { video_agreement_v1: 72 } }),
      save({ scoreFamilyReviewThresholds: { video_agreement_v1: 73 } }),
    ]);
    expect(gate?.arrived).toBe(3);
    const evs = auditEvents();
    expect(evs.map((e) => e.policyVersion)).toEqual([2, 3, 4]);
    // chain: each version's before is the previous version's after
    expect((evs[0].before as Record<string, unknown>)["scoreFamilyReviewThresholds.video_agreement_v1"]).toBeNull();
    for (let i = 1; i < evs.length; i++) {
      expect((evs[i].before as Record<string, unknown>)["scoreFamilyReviewThresholds.video_agreement_v1"]).toBe(
        (evs[i - 1].after as Record<string, unknown>)["scoreFamilyReviewThresholds.video_agreement_v1"]
      );
    }
    expect((doc().scoreFamilyReviewThresholds as Record<string, unknown>).video_agreement_v1).toBe(
      (evs[2].after as Record<string, unknown>)["scoreFamilyReviewThresholds.video_agreement_v1"]
    );
  });
});
