/**
 * Regression for the recursive `afterTxReads` hook (research deletion integrity, 2026-11-03).
 *
 * Defect: the hook stands for other writers acting between a transaction's reads and its commit. Once governance
 * writers ran their own (deletion-barrier-guarded) transactions, a hook that invoked such a writer was re-invoked by the
 * writer's transaction. That attempt was again attempt 0, so it re-entered itself without bound. In
 * reportReviewExclusion.spec.ts this showed up as a worker at 100% CPU and growing memory.
 *
 * Contract after the fix:
 *   - the hook fires exactly once per attempt of a transaction NOT started by the hook;
 *   - transactions started inside the hook body are not intercepted (no re-entry), but still commit and still bump
 *     versions, so the outer transaction detects the conflict and retries;
 *   - a transaction running concurrently from outside the hook context IS still intercepted.
 */
import { FakeTransactionalFirestore } from "./helpers/fakeTransactionalFirestore";

const db = new FakeTransactionalFirestore();

async function guardedLikeWriter(path: string, value: number) {
  // The shape of every barrier-guarded writer: a transaction that reads, then writes.
  await db.runTransaction(async (tx) => {
    await tx.get(db.doc(path) as never);
    tx.set(db.doc(path) as never, { value }, { merge: true });
  });
}

beforeEach(() => {
  db.docs.clear();
  db.hooks = {};
  db.stats = { commits: 0, retries: 0, aborted: 0 };
});

describe("afterTxReads hook", () => {
  it("a hook that runs a transactional writer terminates, fires once per outer attempt, and forces the outer retry", async () => {
    db.seed("runs/r", { value: 0 });
    const calls: number[] = [];
    db.hooks.afterTxReads = async (attempt) => {
      calls.push(attempt);
      if (attempt === 0) await guardedLikeWriter("runs/r", 1); // the injected concurrent writer (its own transaction)
    };
    let outerAttempts = 0;
    await db.runTransaction(async (tx) => {
      outerAttempts++;
      const snap = await tx.get(db.doc("runs/r") as never);
      tx.set(db.doc("runs/r") as never, { outerSaw: (snap.data() as { value: number }).value }, { merge: true });
    });
    expect(calls).toEqual([0, 1]); // once for each outer attempt, never for the injected writer's own transaction
    expect(outerAttempts).toBe(2); // the injected commit invalidated attempt 0
    expect(db.stats.retries).toBe(1);
    expect(db.read("runs/r")).toEqual({ value: 1, outerSaw: 1 }); // the retry read the injected write
  });

  it("a hook that keeps injecting on every attempt still terminates: the outer transaction aborts after its retry budget", async () => {
    db.seed("runs/r", { value: 0 });
    let n = 0;
    db.hooks.afterTxReads = async () => guardedLikeWriter("runs/r", ++n);
    await expect(
      db.runTransaction(async (tx) => {
        await tx.get(db.doc("runs/r") as never);
        tx.set(db.doc("runs/r") as never, { outer: true }, { merge: true });
      })
    ).rejects.toMatchObject({ code: "ABORTED" });
    expect(n).toBe(5); // MAX_ATTEMPTS, not unbounded
  });

  it("a transaction running concurrently from OUTSIDE the hook context is still intercepted", async () => {
    db.seed("runs/a", { value: 0 });
    db.seed("runs/b", { value: 0 });
    const seen: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    db.hooks.afterTxReads = async () => {
      seen.push("hook");
      if (seen.length === 1) await gate; // hold the first interception open
    };
    const first = guardedLikeWriter("runs/a", 1);
    await new Promise((r) => setImmediate(r));
    const second = guardedLikeWriter("runs/b", 2); // concurrent, not started by the hook
    await new Promise((r) => setImmediate(r));
    expect(seen).toEqual(["hook", "hook"]); // intercepted although the first hook is still running
    release();
    await Promise.all([first, second]);
  });

  it("with no hook, transactions behave exactly as before", async () => {
    db.seed("runs/r", { value: 0 });
    await guardedLikeWriter("runs/r", 3);
    expect(db.read("runs/r")).toEqual({ value: 3 });
    expect(db.stats).toEqual({ commits: 1, retries: 0, aborted: 0 });
  });
});
