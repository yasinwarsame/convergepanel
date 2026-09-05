/**
 * Phase BILLING-WEBHOOK-B1-C2 — the three-state contract itself.
 *
 * These are the primitives the whole correction rests on: a dependency failure
 * must be a thrown `TransientDependencyError`, never a value that a caller
 * could mistake for "absent" or "not entitled". Asserting it here, rather than
 * only through HTTP status at the route, means a mutation that returns a bare
 * `undefined` on failure is caught for the right reason instead of passing
 * because a later crash happens to produce the same status code.
 */

import {
  TransientDependencyError,
  absent,
  firestoreRead,
  found,
  isDefinitiveStripeMissing,
  isTransientDependencyError,
  stripeLookup,
} from "../reconciliationOutcome";

const stripeMissing = () => Object.assign(new Error("No such subscription"), { code: "resource_missing", statusCode: 404 });
const stripeTimeout = () => Object.assign(new Error("ETIMEDOUT"), { type: "StripeConnectionError" });
const stripeRateLimited = () => Object.assign(new Error("Too many requests"), { statusCode: 429, type: "StripeRateLimitError" });
const stripeServerError = () => Object.assign(new Error("Internal"), { statusCode: 500, type: "StripeAPIError" });

describe("stripeLookup", () => {
  it("returns found for a successful read", async () => {
    await expect(stripeLookup("op", async () => ({ id: "sub_1" }))).resolves.toEqual(found({ id: "sub_1" }));
  });

  it("returns PROVEN absent only for a definitively missing resource", async () => {
    await expect(stripeLookup("op", async () => { throw stripeMissing(); })).resolves.toEqual(absent());
  });

  it("REGRESSION: a timeout is a dependency failure, never absence", async () => {
    await expect(stripeLookup("op", async () => { throw stripeTimeout(); })).rejects.toBeInstanceOf(TransientDependencyError);
  });

  it("REGRESSION: rate limiting and 5xx are dependency failures, never absence", async () => {
    await expect(stripeLookup("op", async () => { throw stripeRateLimited(); })).rejects.toBeInstanceOf(TransientDependencyError);
    await expect(stripeLookup("op", async () => { throw stripeServerError(); })).rejects.toBeInstanceOf(TransientDependencyError);
  });

  it("an unrecognised error shape is treated as transient, not absent", async () => {
    await expect(stripeLookup("op", async () => { throw new Error("who knows"); })).rejects.toBeInstanceOf(TransientDependencyError);
  });
});

describe("firestoreRead", () => {
  it("returns the value on success", async () => {
    await expect(firestoreRead("users.get", async () => ({ exists: true }))).resolves.toEqual({ exists: true });
  });

  it("REGRESSION: a read failure THROWS a TransientDependencyError — it never resolves to a value a caller could read as absent", async () => {
    const promise = firestoreRead("users.get", async () => { throw new Error("DEADLINE_EXCEEDED"); });
    await expect(promise).rejects.toBeInstanceOf(TransientDependencyError);
    await expect(promise).rejects.toMatchObject({ dependency: "firestore", operation: "users.get" });
  });

  it("never resolves to undefined or null on failure", async () => {
    let resolved: unknown = "NOT_SET";
    try {
      resolved = await firestoreRead("users.get", async () => { throw new Error("UNAVAILABLE"); });
    } catch {
      // expected
    }
    expect(resolved).toBe("NOT_SET");
  });
});

describe("error classification", () => {
  it("only resource_missing and a non-connection 404 count as definitive absence", () => {
    expect(isDefinitiveStripeMissing(stripeMissing())).toBe(true);
    expect(isDefinitiveStripeMissing({ statusCode: 404 })).toBe(true);
    expect(isDefinitiveStripeMissing(stripeTimeout())).toBe(false);
    expect(isDefinitiveStripeMissing(stripeRateLimited())).toBe(false);
    expect(isDefinitiveStripeMissing(stripeServerError())).toBe(false);
    expect(isDefinitiveStripeMissing(null)).toBe(false);
    expect(isDefinitiveStripeMissing(new Error("plain"))).toBe(false);
  });

  it("identifies its own error type", () => {
    expect(isTransientDependencyError(new TransientDependencyError("stripe", "op"))).toBe(true);
    expect(isTransientDependencyError(new Error("other"))).toBe(false);
  });

  it("carries no secret or payload detail in its message", () => {
    const err = new TransientDependencyError("firestore", "users.get", new Error("sk_live_should_not_appear"));
    expect(err.message).toBe("Transient firestore failure during users.get");
    expect(err.message).not.toContain("sk_live");
  });
});
