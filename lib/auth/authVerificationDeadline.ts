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
 * Why a cap on ABANDONED verifications: an abandoned SDK call keeps its socket
 * until the SDK gives up (~133–140 s measured), and the SDK's 25 s timeout is
 * an IDLE timeout, so an upstream that drips bytes can hold one indefinitely.
 * Without a bound, a hung upstream accumulates sockets at the request rate
 * (review R4o: ≈ 3.9 req/s per instance reaches EMFILE at 1,024 descriptors),
 * which would break every other outbound call on the instance (Firestore,
 * Stripe, model providers) — not just auth. So at MAX_ABANDONED_AUTH_VERIFICATIONS
 * still-unsettled abandoned calls, a new verification that would go upstream
 * fails fast (`capped` → the caller's existing auth_unavailable / 503 path)
 * without starting a new call. Each abandoned call is released from the count
 * when its promise settles, fulfilled or rejected.
 *
 * Why 100: one abandoned verification holds one socket at a time (the SDK
 * retries sequentially; measured locally, see the session-mint SDK HTTP spec),
 * so the cap bounds auth's abandoned descriptors at ~100 of 1,024 (< 10 %),
 * leaving the rest for everything else. Cookie + bearer requests use two, so
 * the cap is reached after ~50–100 hung requests on an instance — at the 10 s
 * deadline that is 5–10 hung req/s for a single 10 s window. A healthy upstream
 * abandons nothing, so the cap is never approached. During a FULL hang every
 * request fails (auth_unavailable) anyway, and the cap only makes it fail at
 * once instead of after 10 s. During a PARTIAL hang (some calls hang, others
 * answer) the cap can refuse a request that would have succeeded — the
 * accepted trade-off for keeping the instance's descriptors.
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

/** Per-instance bound on abandoned (cut off at the deadline, still unsettled) verifications. See above. */
export const MAX_ABANDONED_AUTH_VERIFICATIONS = 100;

/** Where a verification runs — a log label only (no credential, token or uid is ever logged here). */
export type VerificationSite = "request_identity" | "session_mint";

export type VerificationOutcome<T> =
  | { readonly kind: "fulfilled"; readonly value: T }
  | { readonly kind: "rejected"; readonly error: unknown }
  /** Still pending at the deadline (or started after it): the late result is never returned. */
  | { readonly kind: "deadline" }
  /** Refused at the abandoned-verification cap: the upstream call was never started. */
  | { readonly kind: "capped" };

const DEADLINE_OUTCOME: { readonly kind: "deadline" } = Object.freeze({ kind: "deadline" as const });
const CAPPED_OUTCOME: { readonly kind: "capped" } = Object.freeze({ kind: "capped" as const });

/** Module state, per server instance: abandoned verifications whose promise has not settled yet. */
let abandonedInFlight = 0;

export function abandonedAuthVerificationsInFlight(): number {
  return abandonedInFlight;
}

export interface VerificationDeadline {
  /**
   * Runs `start()` against this deadline. Never rejects. `upstream: false`
   * marks work that cannot make a network call (e.g. no credential was
   * presented): it is still bounded by the deadline, but is neither refused at
   * the cap nor counted toward it.
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
      });
    }
    fire();
  }, AUTH_VERIFICATION_DEADLINE_MS);

  return {
    run<T>(start: () => Promise<T>, opts?: { upstream?: boolean }): Promise<VerificationOutcome<T>> {
      const upstream = opts?.upstream ?? true;
      if (expired) return Promise.resolve(DEADLINE_OUTCOME);
      if (upstream && abandonedInFlight >= MAX_ABANDONED_AUTH_VERIFICATIONS) {
        logger.warn("[auth-verification] abandoned_cap_refused", {
          site,
          abandonedInFlight,
          cap: MAX_ABANDONED_AUTH_VERIFICATIONS,
        });
        return Promise.resolve(CAPPED_OUTCOME);
      }
      let call: Promise<T>;
      try {
        call = Promise.resolve(start());
      } catch (error) {
        call = Promise.reject(error);
      }
      const task: Task = { abandoned: false };
      if (upstream) pending.add(task);
      const settle = () => {
        pending.delete(task);
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
