/**
 * Billing incident BILLING-ANNUAL, Phase WEBHOOK-B1-C2 — the vocabulary that
 * keeps three very different situations from collapsing into one value.
 *
 * The exact-head review of PR #145 proved the cost of conflating them. Every
 * lookup in the webhook wrapped its dependency in `try { … } catch { x = null }`,
 * so "Firestore could not be read" arrived at the authority check looking
 * exactly like "this user has no stored subscription". A single transient read
 * error therefore downgraded a paying customer to free and deleted their
 * subscription reference — the identity guard defeated by the one failure mode
 * it was supposed to make impossible.
 *
 * The governing rule for this module and its callers:
 *
 *     ABSENCE MUST BE PROVEN; FAILURE MUST PROPAGATE.
 *
 * A missing value may authorise a state transition only when the system
 * actually established that it is missing — never when it failed to determine
 * whether it exists.
 *
 * So there are three outcomes, and only the first two may drive a decision:
 *
 *   - `found`             the value exists and is known.
 *   - `absent`            proven not to exist.
 *   - throw `TransientDependencyError`  unknown; the caller must not decide.
 *
 * A transient failure is represented as a thrown error rather than a fourth
 * variant on purpose: it must reach the webhook route's top-level handler and
 * become a retryable 5xx, and an exception cannot be silently ignored the way
 * an unhandled union member can.
 */

import "server-only";

/**
 * A dependency (Stripe, Firestore) could not answer. NOT a domain outcome:
 * nothing may be concluded about the underlying state, and no billing write
 * may proceed. Callers let this propagate so Stripe retries the delivery.
 */
export class TransientDependencyError extends Error {
  readonly dependency: "stripe" | "firestore";
  readonly operation: string;

  constructor(dependency: "stripe" | "firestore", operation: string, cause?: unknown) {
    super(`Transient ${dependency} failure during ${operation}`);
    this.name = "TransientDependencyError";
    this.dependency = dependency;
    this.operation = operation;
    // Preserved for logging only; never surfaced in an HTTP response body.
    (this as { cause?: unknown }).cause = cause;
  }
}

export function isTransientDependencyError(err: unknown): err is TransientDependencyError {
  return err instanceof TransientDependencyError;
}

/** A value that is either known to exist, or proven not to. There is no third member — see the module note. */
export type Lookup<T> = { kind: "found"; value: T } | { kind: "absent" };

export const found = <T>(value: T): Lookup<T> => ({ kind: "found", value });
export const absent = <T>(): Lookup<T> => ({ kind: "absent" });

/**
 * Stripe signals a definitively missing resource with `resource_missing` (HTTP
 * 404). That is a PROVEN absence and a legitimate domain answer. Everything
 * else — timeouts, connection errors, rate limits, 5xx — is unknown and must
 * be treated as a dependency failure.
 *
 * Deliberately conservative: an unrecognised error shape is treated as
 * transient, because retrying a delivery is harmless while wrongly concluding
 * "absent" is what caused the P0.
 */
export function isDefinitiveStripeMissing(err: unknown): boolean {
  const e = err as { code?: string; statusCode?: number; type?: string } | null | undefined;
  if (!e) return false;
  if (e.code === "resource_missing") return true;
  return e.statusCode === 404 && e.type !== "StripeConnectionError";
}

/**
 * Runs a Stripe read and classifies the result into the three outcomes:
 * `found`, `absent` (only for a definitively missing resource), or a thrown
 * `TransientDependencyError` for anything else.
 */
export async function stripeLookup<T>(operation: string, run: () => Promise<T>): Promise<Lookup<T>> {
  try {
    return found(await run());
  } catch (err) {
    if (isDefinitiveStripeMissing(err)) return absent<T>();
    throw new TransientDependencyError("stripe", operation, err);
  }
}

/**
 * Runs a Firestore read. There is NO absent-on-error branch: a Firestore read
 * either answers (and the caller inspects the snapshot) or fails, and failure
 * is always unknown state. This is the exact site of the P0.
 */
export async function firestoreRead<T>(operation: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    throw new TransientDependencyError("firestore", operation, err);
  }
}
