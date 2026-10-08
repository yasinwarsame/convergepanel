/**
 * Step 6.0a — governance policy version atomicity.
 *
 * Invariant (owner, fixed): two concurrent successful policy changes cannot
 * commit the same new policy version. Each successful mutation receives a
 * unique, monotonically increasing version derived atomically from the current
 * persisted version.
 *
 * The fake Firestore implements OPTIMISTIC transactions (reads record a version,
 * writes are buffered, commit is all-or-nothing and the whole function retries
 * when anything it read changed). A gate holds the first attempt of every
 * concurrent save after its read, so all saves genuinely read the same version
 * before any commits — without it the "race" would run sequentially and prove
 * nothing. A save outside a transaction bypasses the gate and the version check
 * entirely, which is exactly the defect.
 */

jest.mock("firebase-admin/firestore", () => {
  class FieldValue {
    static serverTimestamp() {
      return new FieldValue();
    }
  }
  class Timestamp {}
  return { FieldValue, Timestamp };
});

type Doc = { data: Record<string, unknown>; version: number };
const store = new Map<string, Doc>();
let autoId = 0;
let gate: { size: number; arrived: number; release: () => void; wait: Promise<void> } | null = null;
function openGate(size: number) {
  let release!: () => void;
  const wait = new Promise<void>((r) => { release = r; });
  gate = { size, arrived: 0, release, wait };
}

function write(path: string, fields: Record<string, unknown>, merge: boolean) {
  const prev = store.get(path);
  store.set(path, { data: merge && prev ? { ...prev.data, ...fields } : { ...fields }, version: (prev?.version ?? 0) + 1 });
}
const snap = (path: string) => ({ exists: store.has(path), data: () => (store.has(path) ? { ...store.get(path)!.data } : undefined) });

/**
 * Plain (non-transactional) document reads and writes take a network round
 * trip, as in production: the snapshot is taken and the write applied only
 * after a macrotask. So concurrent saves that bypass the transaction genuinely
 * interleave — all of them read before any of them writes — independently of
 * the transaction gate below. Without this, a non-transactional save would
 * happen to serialize in the fake and the version assertions could not fail.
 */
const tick = () => new Promise((r) => setTimeout(r, 0));
function docRef(path: string): any {
  return {
    __path: path,
    get: async () => {
      await tick();
      return snap(path);
    },
    set: async (fields: Record<string, unknown>, opts?: { merge?: boolean }) => {
      await tick();
      write(path, fields, opts?.merge === true);
    },
    collection: (sub: string) => ({
      doc: (id?: string) => docRef(`${path}/${sub}/${id ?? `auto-${++autoId}`}`),
      add: async (fields: Record<string, unknown>) => {
        await tick();
        write(`${path}/${sub}/auto-${++autoId}`, fields, false);
      },
    }),
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

import { saveGovernancePolicyMerge } from "@/lib/governance/governancePolicyStore";
import { GOVERNANCE_POLICY_DOC_PATH } from "@/lib/governance/governanceFirestore";
import { getDefaultGovernancePolicy } from "@/lib/governance/evaluateGovernance";

const POLICY_PATH = `${GOVERNANCE_POLICY_DOC_PATH.collection}/${GOVERNANCE_POLICY_DOC_PATH.docId}`;
const auditVersions = () =>
  [...store.entries()].filter(([p]) => p.startsWith(`${POLICY_PATH}/auditEvents/`)).map(([, d]) => d.data.policyVersion as number).sort((a, b) => a - b);

const save = (minConsensusToApprove: number, uid = "gov-admin") =>
  saveGovernancePolicyMerge({ minConsensusToApprove }, uid, `${uid}@test-invented.example`, "change", ["minConsensusToApprove"]);

beforeEach(() => {
  store.clear();
  autoId = 0;
  gate = null;
  write(POLICY_PATH, { ...getDefaultGovernancePolicy(), policyVersion: 7 }, false);
});

describe("Step 6.0a — concurrent policy saves", () => {
  it("control: a single save increments the persisted version by one and records one audit event", async () => {
    const out = await save(80);
    expect(out.policyVersion).toBe(8);
    expect(store.get(POLICY_PATH)?.data.policyVersion).toBe(8);
    expect(auditVersions()).toEqual([8]);
  });

  it.each([2, 3, 5])("%i concurrent saves commit that many distinct, consecutive versions", async (n) => {
    openGate(n);
    const results = await Promise.all(Array.from({ length: n }, (_, i) => save(60 + i, `admin-${i}`)));
    expect(gate?.arrived).toBe(n); // the race really happened: every save read before any commit
    const versions = results.map((r) => r.policyVersion).sort((a, b) => a - b);
    expect(new Set(versions).size).toBe(n);
    expect(versions).toEqual(Array.from({ length: n }, (_, i) => 8 + i));
    expect(store.get(POLICY_PATH)?.data.policyVersion).toBe(7 + n);
    // exactly one history entry per committed version — none for a retried read
    expect(auditVersions()).toEqual(versions);
  });

  it("the persisted policy carries the content of the save that holds the highest version", async () => {
    openGate(2);
    const [a, b] = await Promise.all([save(61, "admin-a"), save(62, "admin-b")]);
    const last = a.policyVersion > b.policyVersion ? a : b;
    expect(store.get(POLICY_PATH)?.data.minConsensusToApprove).toBe(last.minConsensusToApprove);
  });

  it("with no policy document yet, concurrent first saves still get distinct versions", async () => {
    store.clear();
    const base = getDefaultGovernancePolicy().policyVersion;
    openGate(2);
    const results = await Promise.all([save(61), save(62)]);
    expect(results.map((r) => r.policyVersion).sort((a, b) => a - b)).toEqual([base + 1, base + 2]);
  });
});
