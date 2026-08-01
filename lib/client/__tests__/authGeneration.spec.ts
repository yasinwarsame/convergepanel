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
});
