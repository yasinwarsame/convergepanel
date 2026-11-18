/**
 * The END-TO-END deadline on Firebase credential verification, and the
 * per-instance cap on verifications ABANDONED at that deadline. Shared by
 * `resolveRequestIdentity()` (every request-identity route) and the session
 * mint (`POST /api/auth/session`).
 *
 * Why a deadline: with `checkRevoked`, firebase-admin 12.7.0 makes a live
 * Identity Toolkit `getUser` read (and the session mint then makes a second
 * call, `createSessionCookie`). If that service accepts the connection and
 * never answers, the SDK makes 5 attempts (defaultRetryConfig: 4 retries on
 * ETIMEDOUT/ECONNRESET/503) at its fixed 25 s request timeout — about 132 s —
 * and a 503 carrying `Retry-After` can stretch each wait to 60 s. The SDK
 * exposes no per-call AbortSignal and no Auth retry/timeout option
 * (AuthHttpClient is built with defaultRetryConfig and the hard-coded
 * FIREBASE_AUTH_TIMEOUT; `httpAgent` cannot change either), so each
 * verification is RACED against this deadline. A call still pending when it
 * fires is ABANDONED: its result is never read — the decision is final when the
 * deadline fires.
 *
 * Why 10 s: the production function budget is, per the owner, Vercel Pro +
 * Fluid with the 300 s default (no vercel.json override; the research routes
 * set maxDuration 300), and 15 s would be the non-Fluid Pro default — 10 s is
 * inside both. A healthy check is one sub-second round trip; the SDK's own
 * retry sequence for a fast-failing 503 or reset is 0 + 1 + 2 + 4 s ≈ 7 s,
 * which still completes inside 10 s and so keeps the SDK's own error code.
 *
 * Why a HARD cap on IN-FLIGHT verifications: an abandoned SDK call keeps its
 * socket until the SDK gives up (~133–140 s measured), and the SDK's 25 s
 * timeout is an IDLE timeout, so an upstream that drips bytes can hold one
 * indefinitely. Without a bound, a hung upstream accumulates sockets at the
 * request rate (review R4o: ≈ 3.9 req/s per instance reaches EMFILE at 1,024
 * descriptors), which would break every other outbound call on the instance
 * (Firestore, Stripe, model providers) — not just auth. So EVERY upstream
 * verification call is counted from the moment it starts until its promise
 * settles (in time, or later after being abandoned) — released exactly once.
 * At MAX_INFLIGHT_AUTH_VERIFICATIONS calls in flight, a new verification that
 * would go upstream fails fast (`capped` → the caller's existing
 * auth_unavailable / 503 path) WITHOUT starting a call. (R5 review: counting
 * only calls already abandoned at the deadline was not a bound — every call
 * started inside a 10 s window went through, so the real ceiling was
 * cap + hung-rate × 10 s.) True bound: auth verification never has more than
 * MAX_INFLIGHT_AUTH_VERIFICATIONS upstream calls — and so, at one socket per
 * call (the SDK retries sequentially; measured: 1 open socket per hung call at
 * the stub), never more than that many sockets — whatever the hung rate.
 *
 * Why 256:
 *   - Descriptors: ≤ 256 of 1,024 (25 %) for auth, leaving ~768 for
 *     everything else on the instance even during a total Auth hang.
 *   - Healthy throughput (Little's law, in flight = rate × latency): a healthy
 *     check is one round trip, so 256 slots admit ≈ 8,500 verifications/s per
 *     instance at 30 ms, ≈ 850/s at 300 ms and 256/s even at 1 s. A request
 *     uses one slot per presented credential (two for cookie + bearer), so
 *     the cap is only reached by > 128 cookie + bearer requests verifying on
 *     one instance AT THE SAME INSTANT — far beyond healthy per-instance
 *     concurrency.
 *   - Partial hang (some calls hang ~135 s, the rest answer): in steady state
 *     the admitted rate A satisfies A × (h × 135 s + (1 − h) × latency) ≈ 256.
 *     Example (review NIT-1): 20 req/s cookie + bearer = 40 verifications/s,
 *     5 % hang (2/s). Uncapped that would hold ~270 sockets; capped, A ≈ 37/s,
 *     so ≈ 7 % of verifications (≤ ~13 % of cookie + bearer requests) are
 *     refused by the cap after ~2 minutes, on top of the 5 % that hang and fail
 *     at the deadline anyway. With the earlier value 100, the same incident
 *     would refuse ≈ 63 % of verifications. Below ~1.9 hung verifications/s
 *     per instance (256 / 135 s), the cap refuses nothing.
 *   - Full hang: every request fails (auth_unavailable) anyway; the cap makes
 *     the excess fail at once instead of after 10 s.
 *
 * Why not an `httpAgent` with `maxSockets`: the agent is an app-wide option, so
 * it would also throttle every non-auth firebase-admin HTTP call (and the
 * credential's access-token fetch); and a request beyond `maxSockets` QUEUES
 * inside the agent — unbounded, holding a promise and its request in memory —
 * behind the hung sockets, so healthy verifications would wait out the full
 * deadline instead of failing fast, and the queued calls themselves become
 * abandoned work. A counter refuses before any work is created, touches only
 * auth verification, and needs no change to Firebase app initialization.
 *
 * Known limit: an upstream that never lets an abandoned call settle (endless
 * drip) keeps the instance at the cap, so auth on that instance fails fast with
 * 503 until those calls settle or the instance is recycled. That fails closed,
 * and is preferable to descriptor exhaustion, which fails everything.
 */

import "server-only";
import { logger } from "@/lib/logger";

export const AUTH_VERIFICATION_DEADLINE_MS = 10_000;

/** Per-instance HARD bound on upstream verification calls in flight (started, not yet settled). See above. */
export const MAX_INFLIGHT_AUTH_VERIFICATIONS = 256;

/** Where a verification runs — a log label only (no credential, token or uid is ever logged here). */
export type VerificationSite = "request_identity" | "session_mint";

export type VerificationOutcome<T> =
  | { readonly kind: "fulfilled"; readonly value: T }
  | { readonly kind: "rejected"; readonly error: unknown }
  /** Still pending at the deadline (or started after it): the late result is never returned. */
  | { readonly kind: "deadline" }
  /** Refused at the in-flight cap: the upstream call was never started. */
  | { readonly kind: "capped" };

const DEADLINE_OUTCOME: { readonly kind: "deadline" } = Object.freeze({ kind: "deadline" as const });
const CAPPED_OUTCOME: { readonly kind: "capped" } = Object.freeze({ kind: "capped" as const });

/** Module state, per server instance: upstream verification calls started and not yet settled (the capped quantity). */
let inFlight = 0;
/** The subset of `inFlight` that was cut off at its deadline (reported in logs; not the cap). */
let abandonedInFlight = 0;

export function authVerificationsInFlight(): number {
  return inFlight;
}

export function abandonedAuthVerificationsInFlight(): number {
  return abandonedInFlight;
}

export interface VerificationDeadline {
  /**
   * Runs `start()` against this deadline. Never rejects. `upstream: false`
   * marks work that cannot make a network call (e.g. no credential was
   * presented): it is still bounded by the deadline, but is neither refused at
   * the in-flight cap nor counted toward it.
   */
  run<T>(start: () => Promise<T>, opts?: { upstream?: boolean }): Promise<VerificationOutcome<T>>;
  /** Clears the timer. Call once every `run` has been awaited. */
  dispose(): void;
}

type Task = { abandoned: boolean };

/** Starts ONE deadline (AUTH_VERIFICATION_DEADLINE_MS from now) shared by every `run` on it. */
export function startVerificationDeadline(site: VerificationSite): VerificationDeadline {
  const pending = new Set<Task>();
  let expired = false;
  let fire!: () => void;
  const fired = new Promise<void>((resolve) => {
    fire = resolve;
  });
  const timer = setTimeout(() => {
    expired = true;
    // Mark synchronously, before any waiter is released: every upstream task
    // still pending now is abandoned and holds its socket until it settles.
    let abandoned = 0;
    for (const task of pending) {
      task.abandoned = true;
      abandonedInFlight += 1;
      abandoned += 1;
    }
    pending.clear();
    if (abandoned > 0) {
      logger.warn("[auth-verification] deadline_exceeded", {
        site,
        deadlineMs: AUTH_VERIFICATION_DEADLINE_MS,
        abandoned,
        abandonedInFlight,
        inFlight,
      });
    }
    fire();
  }, AUTH_VERIFICATION_DEADLINE_MS);

  return {
    run<T>(start: () => Promise<T>, opts?: { upstream?: boolean }): Promise<VerificationOutcome<T>> {
      const upstream = opts?.upstream ?? true;
      if (expired) return Promise.resolve(DEADLINE_OUTCOME);
      if (upstream && inFlight >= MAX_INFLIGHT_AUTH_VERIFICATIONS) {
        logger.warn("[auth-verification] in_flight_cap_refused", {
          site,
          inFlight,
          abandonedInFlight,
          cap: MAX_INFLIGHT_AUTH_VERIFICATIONS,
        });
        return Promise.resolve(CAPPED_OUTCOME);
      }
      const task: Task = { abandoned: false };
      // Counted BEFORE the call starts (so a synchronous re-entry cannot overshoot),
      // released exactly once in `settle`.
      if (upstream) {
        inFlight += 1;
        pending.add(task);
      }
      let call: Promise<T>;
      try {
        call = Promise.resolve(start());
      } catch (error) {
        call = Promise.reject(error);
      }
      let released = false;
      const settle = () => {
        if (released) return;
        released = true;
        pending.delete(task);
        if (!upstream) return;
        inFlight -= 1;
        if (task.abandoned) {
          task.abandoned = false;
          abandonedInFlight -= 1;
        }
      };
      const result = call.then(
        (value): VerificationOutcome<T> => {
          settle();
          return { kind: "fulfilled", value };
        },
        (error: unknown): VerificationOutcome<T> => {
          settle();
          return { kind: "rejected", error };
        }
      );
      return Promise.race([result, fired.then(() => DEADLINE_OUTCOME)]);
    },
    dispose() {
      clearTimeout(timer);
    },
  };
}
