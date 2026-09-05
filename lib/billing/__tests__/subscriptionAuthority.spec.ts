/**
 * Phase BILLING-WEBHOOK-B1-C6 — the DELETION IDENTITY GUARD, tested directly.
 *
 * The C5-R1 exact-head review found a mutation that forces this guard to
 * always allow and still passes the entire suite: every scenario that reached
 * it was also caught by the customer-set resolver one stage later, so nothing
 * was actually asserting the guard's own contract. That is defence-in-depth
 * decaying into an accident — the resolver answers "what authority exists
 * now?", and this guard answers a different question, "may THIS cancellation
 * clear THIS reference?". One must not be allowed to silently stand in for
 * the other.
 */

import { mayDeletionDowngrade } from "../subscriptionAuthority";

describe("mayDeletionDowngrade — a cancellation may only clear the subscription it is about", () => {
  it("REGRESSION: a deletion for a DIFFERENT subscription may never clear the stored one", () => {
    expect(mayDeletionDowngrade({ deletedSubscriptionId: "sub_A", storedSubscriptionId: "sub_B" })).toBe(false);
  });

  it("a deletion for the stored subscription may clear it", () => {
    expect(mayDeletionDowngrade({ deletedSubscriptionId: "sub_B", storedSubscriptionId: "sub_B" })).toBe(true);
  });

  it("with no stored reference the downgrade is allowed, so a paid plan with no subscription is still repairable", () => {
    expect(mayDeletionDowngrade({ deletedSubscriptionId: "sub_A", storedSubscriptionId: null })).toBe(true);
    expect(mayDeletionDowngrade({ deletedSubscriptionId: "sub_A", storedSubscriptionId: undefined })).toBe(true);
    expect(mayDeletionDowngrade({ deletedSubscriptionId: "sub_A", storedSubscriptionId: "" })).toBe(true);
  });

  it("REGRESSION: it is an EXACT identity match, never a prefix or case-insensitive one", () => {
    expect(mayDeletionDowngrade({ deletedSubscriptionId: "sub_B", storedSubscriptionId: "sub_B2" })).toBe(false);
    expect(mayDeletionDowngrade({ deletedSubscriptionId: "sub_b", storedSubscriptionId: "sub_B" })).toBe(false);
    expect(mayDeletionDowngrade({ deletedSubscriptionId: "sub_B ", storedSubscriptionId: "sub_B" })).toBe(false);
  });

  it("REGRESSION: the guard is not a constant — it discriminates on identity", () => {
    const differing = mayDeletionDowngrade({ deletedSubscriptionId: "sub_A", storedSubscriptionId: "sub_B" });
    const matching = mayDeletionDowngrade({ deletedSubscriptionId: "sub_B", storedSubscriptionId: "sub_B" });
    expect(differing).not.toBe(matching);
  });
});
