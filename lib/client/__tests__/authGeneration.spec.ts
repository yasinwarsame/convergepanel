import { createGenerationGuard } from "@/lib/client/authGeneration";

describe("createGenerationGuard", () => {
  it("starts at generation 0 and increments on each next()", () => {
    const guard = createGenerationGuard();
    expect(guard.current()).toBe(0);
    expect(guard.next()).toBe(1);
    expect(guard.next()).toBe(2);
    expect(guard.next()).toBe(3);
    expect(guard.current()).toBe(3);
  });

  it("isCurrent is true only for the most recently issued generation", () => {
    const guard = createGenerationGuard();
    const first = guard.next();
    expect(guard.isCurrent(first)).toBe(true);
    const second = guard.next();
    expect(guard.isCurrent(first)).toBe(false);
    expect(guard.isCurrent(second)).toBe(true);
  });

  it("simulates the exact race this exists to prevent: an old login response arriving after a newer one — the old generation is discarded", () => {
    const guard = createGenerationGuard();
    const loginA = guard.next(); // login attempt A starts
    const loginB = guard.next(); // login attempt B starts before A's response arrives
    // B resolves first
    expect(guard.isCurrent(loginB)).toBe(true);
    // A's stale response now arrives — must be discarded
    expect(guard.isCurrent(loginA)).toBe(false);
  });

  it("simulates a refresh resolving after logout — the refresh's generation is stale", () => {
    const guard = createGenerationGuard();
    const refresh = guard.next();
    const logout = guard.next();
    expect(guard.isCurrent(refresh)).toBe(false);
    expect(guard.isCurrent(logout)).toBe(true);
  });

  it("two independent guards never share state", () => {
    const guardA = createGenerationGuard();
    const guardB = createGenerationGuard();
    const genA = guardA.next();
    expect(guardB.isCurrent(genA)).toBe(false);
    expect(guardB.current()).toBe(0);
  });

  it("calling next() without ever using its return value (invalidate-only) still makes a previously-issued token stale", () => {
    // Phase 11A.6.1 — app/page.tsx's handleRunPanel()/exitHistoryResearchView()
    // call .next() purely to strip authority from any in-flight research
    // reload; they never capture or check the returned token themselves.
    const guard = createGenerationGuard();
    const reload = guard.next();
    expect(guard.isCurrent(reload)).toBe(true);
    guard.next(); // invalidate-only: a new intent begins, its token is discarded
    expect(guard.isCurrent(reload)).toBe(false);
  });
});

/**
 * Phase 11A.6.1 — usage-pattern tests for how app/page.tsx's
 * loadResearchRunIntoState() uses this exact guard to arbitrate between
 * overlapping Personal research-navigation loads (durable "View source
 * research" vs. ordinary history reopening). app/page.tsx itself has no
 * practical interaction-test harness (no jsdom, no @testing-library/react
 * in this repo — see components/adaptive/__tests__/DeepResearchView.spec.tsx
 * for the established alternative convention), so these tests exercise the
 * REAL createGenerationGuard() against a small local harness that mirrors
 * loadResearchRunIntoState's actual shape byte-for-byte in spirit — claim a
 * generation synchronously before any `await`, run the async work, then
 * check `isCurrent` immediately before the one synchronous commit block,
 * with the identical check repeated in the catch path — using deferred
 * promises and a commit spy to prove the exact required semantics, not
 * merely test names. This does not replace direct coverage of
 * app/page.tsx's own wiring, which remains verified by code inspection and
 * mutation-testing (see the 11A.6.1 implementation report).
 */
describe("Phase 11A.6.1 — research-load arbitration usage pattern", () => {
  function createDeferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  /** Mirrors loadResearchRunIntoState's exact arbitration shape. */
  async function arbitratedLoad<T>(
    guard: ReturnType<typeof createGenerationGuard>,
    work: Promise<T>,
    commit: (value: T) => void,
    onFailedCommit: (err: unknown) => void
  ): Promise<{ status: "committed" } | { status: "superseded" } | { status: "failed" }> {
    const token = guard.next();
    try {
      const value = await work;
      if (!guard.isCurrent(token)) {
        return { status: "superseded" };
      }
      commit(value);
      return { status: "committed" };
    } catch (e) {
      if (!guard.isCurrent(token)) {
        return { status: "superseded" };
      }
      onFailedCommit(e);
      return { status: "failed" };
    }
  }

  it("CASE 1 — B resolves before A: only B commits", async () => {
    const guard = createGenerationGuard();
    const commits: string[] = [];
    const a = createDeferred<string>();
    const b = createDeferred<string>();

    const resultA = arbitratedLoad(guard, a.promise, (v) => commits.push(v), () => {});
    const resultB = arbitratedLoad(guard, b.promise, (v) => commits.push(v), () => {});

    b.resolve("B");
    await Promise.resolve();
    a.resolve("A");

    expect(await resultB).toEqual({ status: "committed" });
    expect(await resultA).toEqual({ status: "superseded" });
    expect(commits).toEqual(["B"]);
  });

  it("CASE 2 — A resolves before B (but B already began): A commits nothing, B commits", async () => {
    const guard = createGenerationGuard();
    const commits: string[] = [];
    const a = createDeferred<string>();
    const b = createDeferred<string>();

    const resultA = arbitratedLoad(guard, a.promise, (v) => commits.push(v), () => {});
    const resultB = arbitratedLoad(guard, b.promise, (v) => commits.push(v), () => {});

    a.resolve("A"); // A's network response completes FIRST...
    await Promise.resolve();
    b.resolve("B"); // ...but B is the newer intent and must still win.

    expect(await resultA).toEqual({ status: "superseded" });
    expect(await resultB).toEqual({ status: "committed" });
    expect(commits).toEqual(["B"]);
  });

  it("CASE 3 — newer B fails, then stale A resolves successfully: A must still not commit (latest intent wins, not latest success)", async () => {
    const guard = createGenerationGuard();
    const commits: string[] = [];
    const failures: unknown[] = [];
    const a = createDeferred<string>();
    const b = createDeferred<string>();

    const resultA = arbitratedLoad(guard, a.promise, (v) => commits.push(v), (e) => failures.push(e));
    const resultB = arbitratedLoad(guard, b.promise, (v) => commits.push(v), (e) => failures.push(e));

    b.reject(new Error("B failed"));
    await Promise.resolve();
    a.resolve("A");

    expect(await resultB).toEqual({ status: "failed" });
    expect(await resultA).toEqual({ status: "superseded" });
    // A must NOT be resurrected merely because the newer B failed.
    expect(commits).toEqual([]);
    expect(failures).toEqual([expect.any(Error)]);
  });

  it("CASE 4 — a single load with no competing navigation commits normally", async () => {
    const guard = createGenerationGuard();
    const commits: string[] = [];
    const a = createDeferred<string>();

    const resultA = arbitratedLoad(guard, a.promise, (v) => commits.push(v), () => {});
    a.resolve("A");

    expect(await resultA).toEqual({ status: "committed" });
    expect(commits).toEqual(["A"]);
  });

  it("CASE 5 — a bare invalidation (no replacement load) still makes A's later completion stale", async () => {
    // Mirrors handleRunPanel()/exitHistoryResearchView() calling guard.next()
    // directly, with no corresponding arbitratedLoad() of their own.
    const guard = createGenerationGuard();
    const commits: string[] = [];
    const a = createDeferred<string>();

    const resultA = arbitratedLoad(guard, a.promise, (v) => commits.push(v), () => {});
    guard.next(); // e.g. the user started a brand-new panel run
    a.resolve("A");

    expect(await resultA).toEqual({ status: "superseded" });
    expect(commits).toEqual([]);
  });

  it("stale A failing after B has begun must not report a shared failure either", async () => {
    const guard = createGenerationGuard();
    const commits: string[] = [];
    const failures: unknown[] = [];
    const a = createDeferred<string>();
    const b = createDeferred<string>();

    const resultA = arbitratedLoad(guard, a.promise, (v) => commits.push(v), (e) => failures.push(e));
    const resultB = arbitratedLoad(guard, b.promise, (v) => commits.push(v), (e) => failures.push(e));

    a.reject(new Error("stale A failure"));
    await Promise.resolve();
    b.resolve("B");

    expect(await resultA).toEqual({ status: "superseded" });
    expect(await resultB).toEqual({ status: "committed" });
    expect(failures).toEqual([]);
    expect(commits).toEqual(["B"]);
  });
});
