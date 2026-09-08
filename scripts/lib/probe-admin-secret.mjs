/**
 * Phase FIRST-ADMIN-C13 — BOUND TWO-PHASE CONTAINMENT PROOF.
 *
 * `/api/admin/set-admin` mints full SYSTEM_ADMIN on any uid from possession of
 * `ADMIN_SECRET`, with no audit record and no success log. An operator rotating
 * that secret must be able to prove the old value is dead.
 *
 * WHAT WENT WRONG BEFORE. C12 treated "HTTP 401 + a route marker" as proof.
 * Review showed that proves only "the origin you contacted rejected the string
 * you supplied" — and BOTH halves fail open with no attacker involved:
 *
 *   - Wrong origin: the route returns 401 + `credential-rejected` whenever the
 *     secret does not match, INCLUDING when `ADMIN_SECRET` is unset. So a
 *     preview deploy, a staging project, a colleague's localhost or a mistyped
 *     host running this same code emits the GENUINE marker and reports
 *     "containment proven".
 *   - Wrong secret: a high-entropy value containing `$`, a backtick, a space,
 *     `!` or `*` is mangled by the shell before Node sees it. The LIVE
 *     production route rejects the mangled string, and the operator reads that
 *     as a successful rotation.
 *
 * WHAT PROOF ACTUALLY REQUIRES. Not a response — a STATE TRANSITION, bound to
 * one origin and one credential inside one process:
 *
 *     PRE  (before rotation): this exact secret is ACCEPTED here.
 *     POST (after rotation + deploy): that same secret is REJECTED here.
 *
 * The pre-check is the load-bearing half. It proves the operator reached an
 * instance that currently holds the expected secret, and that the exact bytes
 * survived the shell. A wrong host or a mangled secret cannot get past it, so
 * neither can reach the post-check that produces the proof.
 *
 * NO NONCE. A nonce defends against replay and third-party forgery — the least
 * likely failure here, and it addresses neither case above. The marker stays a
 * ROUTE MARKER: evidence that the expected route response contract was observed
 * at the contacted origin. It is not attestation, not proof of Production
 * identity, and not proof of containment on its own.
 */

export const PROBE_MARKER_HEADER = "x-convergepanel-admin-secret-probe";
export const MARKER_REJECTED = "credential-rejected";
export const MARKER_ACCEPTED = "credential-accepted";

export const ENDPOINT_PATH = "/api/admin/set-admin";

/** The only origin at which a PRODUCTION containment proof may be established. */
export const CANONICAL_PRODUCTION_ORIGIN = "https://convergepanel.com";

/** Structured refusal codes. Tests assert these, never prose. */
export const REASONS = {
  NOT_A_URL: "ERR_TARGET_NOT_A_URL",
  UNSUPPORTED_SCHEME: "ERR_UNSUPPORTED_SCHEME",
  NON_HTTPS: "ERR_NON_HTTPS_PRODUCTION_ORIGIN",
  USERINFO: "ERR_USERINFO_NOT_ALLOWED",
  QUERY: "ERR_QUERY_NOT_ALLOWED",
  FRAGMENT: "ERR_FRAGMENT_NOT_ALLOWED",
  PATH: "ERR_PATH_NOT_ALLOWED",
  NOT_CANONICAL: "ERR_NOT_CANONICAL_PRODUCTION_ORIGIN",
  NO_SECRET: "ERR_NO_OLD_SECRET",
};

export const OBSERVATIONS = {
  ACCEPTED: "CREDENTIAL_ACCEPTED",
  REJECTED: "CREDENTIAL_REJECTED",
  INCONCLUSIVE: "INCONCLUSIVE",
};

/** Explicit states. There is no edge from INITIAL straight to PROVEN. */
export const STATES = {
  INITIAL: "INITIAL",
  PRECHECK_ACCEPTED: "PRECHECK_ACCEPTED",
  /**
   * ARMED. Phase FIRST-ADMIN-C14 (R10 P0-2): the PRE evidence lives here and is
   * NOT destroyed by a post-check that fails to prove containment. C13 aborted
   * on any non-REJECTED observation, so a 429 — which says nothing about the
   * credential — permanently voided the proof: `postcheck` runs only from the
   * armed state, and a restart cannot rebuild PRE once the rotation has
   * deployed. One rate-limited request made the mandated artifact unobtainable.
   * Only a REJECTED observation leaves this state.
   */
  POST_PENDING: "POST_PENDING",
  PROVEN: "PRODUCTION_CONTAINMENT_PROVEN",
  ABORTED: "ABORTED",
};

/** What the most recent post-check observation means for the operator. */
export const POST_OUTCOMES = {
  PROVEN: "PROVEN",
  /** The old credential is STILL LIVE. Conclusive, but retryable: the rotation may not have propagated. */
  NOT_YET_CONTAINED: "NOT_YET_CONTAINED",
  /** No verdict at all (429 / 5xx / transport / redirect refusal / unattributed 401). */
  INCONCLUSIVE: "INCONCLUSIVE",
};

/** The only body this tool can construct. Deliberately not parameterised. */
export function buildProbeBody(secret) {
  return { secret };
}

/** Status + marker together. Neither alone is a verdict. */
export function classify(status, marker) {
  if (status === 401 && marker === MARKER_REJECTED) return OBSERVATIONS.REJECTED;
  if (status === 400 && marker === MARKER_ACCEPTED) return OBSERVATIONS.ACCEPTED;
  return OBSERVATIONS.INCONCLUSIVE;
}

/**
 * The operator names an ORIGIN; this builds the endpoint. Every refusal returns
 * a structured code, and refusal happens BEFORE any request is issued.
 */
export function resolveEndpoint(rawBaseUrl, { requireCanonical = true, allowInsecureLoopback = false } = {}) {
  let u;
  try {
    u = new URL(rawBaseUrl);
  } catch {
    return { ok: false, reason: REASONS.NOT_A_URL };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return { ok: false, reason: REASONS.UNSUPPORTED_SCHEME };
  if (u.username || u.password) return { ok: false, reason: REASONS.USERINFO };
  if (u.search) return { ok: false, reason: REASONS.QUERY };
  if (u.hash) return { ok: false, reason: REASONS.FRAGMENT };
  if (u.pathname !== "/" && u.pathname !== "") return { ok: false, reason: REASONS.PATH };

  const isLoopback = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
  if (u.protocol === "http:" && !(allowInsecureLoopback && isLoopback)) {
    return { ok: false, reason: REASONS.NON_HTTPS };
  }
  if (requireCanonical && u.origin !== CANONICAL_PRODUCTION_ORIGIN && !(allowInsecureLoopback && isLoopback)) {
    return { ok: false, reason: REASONS.NOT_CANONICAL };
  }
  return { ok: true, url: `${u.origin}${ENDPOINT_PATH}`, origin: u.origin };
}

/** One request. Returns an OBSERVATION — never a containment verdict. */
async function observeOnce({ url, secret, fetchImpl }) {
  let res;
  try {
    res = await fetchImpl(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildProbeBody(secret)),
      // A redirect would carry this credential to an origin the operator did
      // not name, and its response would then be read as evidence.
      redirect: "error",
      // A cached rejection is not a present-tense observation.
      cache: "no-store",
    });
  } catch (err) {
    return {
      observation: OBSERVATIONS.INCONCLUSIVE,
      status: null,
      detail: `request failed: ${err instanceof Error ? err.name : "network error"}`,
    };
  }
  const marker = typeof res.headers?.get === "function" ? res.headers.get(PROBE_MARKER_HEADER) : null;
  // Surfaced only so the operator can wait the limiter out rather than retry
  // blindly. It is never used to bypass the limit, and never affects the verdict.
  const retryAfter = typeof res.headers?.get === "function" ? res.headers.get("retry-after") : null;
  const base = marker ? `HTTP ${res.status}` : `HTTP ${res.status}, no route marker`;
  return {
    observation: classify(res.status, marker),
    status: res.status,
    retryAfter: retryAfter ?? null,
    detail: res.status === 429 && retryAfter ? `${base}, retry-after ${retryAfter}s` : base,
  };
}

/**
 * Binds ONE origin and ONE secret for the life of the proof. Both are captured
 * here and never re-read: changing `process.env` between phases cannot retarget
 * the second observation, which is the whole point of binding them.
 */
export function createContainmentProof({ origin, secret, fetchImpl = fetch, requireCanonical = true, allowInsecureLoopback = false }) {
  const lockedSecret = secret;
  const resolved = resolveEndpoint(origin, { requireCanonical, allowInsecureLoopback });
  let state = STATES.INITIAL;
  /** The most recent post-check outcome. Drives the exit code, never the state. */
  let lastOutcome = null;
  let postAttempts = 0;

  const abort = (detail) => { state = STATES.ABORTED; return { ok: false, state, detail }; };

  return {
    get state() { return state; },
    get lockedUrl() { return resolved.ok ? resolved.url : null; },
    get lastOutcome() { return lastOutcome; },
    get postAttempts() { return postAttempts; },

    async precheck() {
      if (state !== STATES.INITIAL) return abort(`precheck called from ${state}`);
      if (typeof lockedSecret !== "string" || lockedSecret.length === 0) return abort(REASONS.NO_SECRET);
      if (!resolved.ok) return abort(resolved.reason);

      const r = await observeOnce({ url: resolved.url, secret: lockedSecret, fetchImpl });
      if (r.observation !== OBSERVATIONS.ACCEPTED) {
        // Wrong host, wrong/mangled secret, rate limit, outage — all abort here,
        // which is exactly why neither can reach the proof.
        return abort(`PRECHECK_FAILED (${r.observation}, ${r.detail}) — the old credential was not confirmed live at ${resolved.origin}`);
      }
      state = STATES.PRECHECK_ACCEPTED;
      return { ok: true, state, detail: `PRECHECK_OLD_CREDENTIAL_CONFIRMED_LIVE at ${resolved.origin}` };
    },

    armForRotation() {
      if (state !== STATES.PRECHECK_ACCEPTED) return abort(`cannot arm from ${state}`);
      state = STATES.POST_PENDING;
      return { ok: true, state };
    },

    /**
     * ONE post-check attempt. Same locked URL, same locked secret — nothing is
     * re-read, on this attempt or any later one.
     *
     * Phase FIRST-ADMIN-C14: only a REJECTED observation changes the state.
     * Everything else leaves the proof ARMED so the operator can retry in this
     * same process, which is what keeps the bound PRE evidence alive across a
     * rate limit, a cold start, a deploy that has not finished propagating, or
     * a dropped connection.
     */
    async postcheck() {
      if (state !== STATES.POST_PENDING) return abort(`postcheck called from ${state}`);
      postAttempts += 1;
      const r = await observeOnce({ url: resolved.url, secret: lockedSecret, fetchImpl });

      if (r.observation === OBSERVATIONS.REJECTED) {
        lastOutcome = POST_OUTCOMES.PROVEN;
        state = STATES.PROVEN;
        return { ok: true, state, outcome: lastOutcome, retryable: false, detail: `PRODUCTION_CONTAINMENT_PROVEN at ${resolved.origin}` };
      }

      // STATE DELIBERATELY UNCHANGED — still POST_PENDING, still armed.
      if (r.observation === OBSERVATIONS.ACCEPTED) {
        lastOutcome = POST_OUTCOMES.NOT_YET_CONTAINED;
        return {
          ok: false, state, outcome: lastOutcome, retryable: true,
          detail: `NOT_YET_CONTAINED (${r.detail}) — the old credential is STILL ACCEPTED at ${resolved.origin}. The rotation has not taken effect here yet; confirm the deployment finished, then retry.`,
        };
      }

      lastOutcome = POST_OUTCOMES.INCONCLUSIVE;
      return {
        ok: false, state, outcome: lastOutcome, retryable: true,
        detail: `INCONCLUSIVE (${r.detail}) — this response says NOTHING about the credential. The proof is still armed; retry.`,
      };
    },
  };
}

/**
 * SINGLE-SHOT DIAGNOSTIC. Reports an observation only. It can never report
 * PRODUCTION_CONTAINMENT_PROVEN, because no state transition was observed.
 */
export async function observeOldSecret({ origin, secret, fetchImpl = fetch, requireCanonical = true, allowInsecureLoopback = false }) {
  if (typeof secret !== "string" || secret.length === 0) {
    return { observation: OBSERVATIONS.INCONCLUSIVE, detail: REASONS.NO_SECRET };
  }
  const resolved = resolveEndpoint(origin, { requireCanonical, allowInsecureLoopback });
  if (!resolved.ok) return { observation: OBSERVATIONS.INCONCLUSIVE, detail: `refused: ${resolved.reason}` };
  return observeOnce({ url: resolved.url, secret, fetchImpl });
}

export const EXIT = { PROVEN: 0, NOT_CONTAINED: 2, INCONCLUSIVE: 3 };

/**
 * THE PRODUCTION ENTRY POINT — Phase FIRST-ADMIN-C14 (R10 P0, item 25).
 *
 * It takes NO origin, and no canonical/loopback switches. There is nothing here
 * for an environment variable, a CLI flag or a config file to override, because
 * the origin is not a parameter of this function at all.
 *
 * WHY THIS SHAPE. C13 built the origin in the CLI as
 * `PROBE_ORIGIN_OVERRIDE ?? CANONICAL_PRODUCTION_ORIGIN` and passed
 * `requireCanonical: !insecure`, so `PROBE_ALLOW_INSECURE_LOOPBACK=1` — a flag
 * whose name promises a loopback seam, and which `resolveEndpoint` does not
 * need in order to reach loopback — turned the canonical binding off for EVERY
 * https origin. Review reproduced a full `PRODUCTION_CONTAINMENT_PROVEN`, exit
 * 0, against a foreign host, with the live old `ADMIN_SECRET` transmitted
 * there. That is an exfiltration primitive as well as a false proof.
 *
 * Tests still need loopback servers. They get them by calling
 * `createContainmentProof()` directly with an injected `fetchImpl` — a
 * dependency-injection seam reachable from a test module, NOT from the process
 * environment of the shipped CLI.
 *
 * @param prompt - async ({ attempt, lastOutcome }) => boolean. Called before
 *   every post-check attempt. Returning false ends the run without a proof.
 *   There is no automatic retry: this tool never hammers the endpoint.
 */
export async function runProductionTwoPhase({ secret, fetchImpl = fetch, prompt, log = () => {} }) {
  const proof = createContainmentProof({
    origin: CANONICAL_PRODUCTION_ORIGIN,
    secret,
    fetchImpl,
    requireCanonical: true,
    allowInsecureLoopback: false,
  });

  const pre = await proof.precheck();
  log(`[PRE] ${pre.ok ? "OK" : "ABORT"} ${pre.detail ?? ""}`.trim());
  if (!pre.ok) {
    log(`[RESULT] NOT PROVEN at ${CANONICAL_PRODUCTION_ORIGIN} — the pre-check did not confirm the old credential is live. Do not rotate on the strength of this run, and do not treat any later rejection as proof.`);
    return { exit: EXIT.INCONCLUSIVE, proven: false, state: proof.state, origin: CANONICAL_PRODUCTION_ORIGIN, postAttempts: 0 };
  }

  proof.armForRotation();

  for (;;) {
    const proceed = await prompt({ attempt: proof.postAttempts + 1, lastOutcome: proof.lastOutcome });
    if (!proceed) break;

    const post = await proof.postcheck();
    log(`[POST] ${post.ok ? "OK" : post.outcome} ${post.detail ?? ""}`.trim());
    if (post.ok) {
      log(`[RESULT] PRODUCTION_CONTAINMENT_PROVEN at ${CANONICAL_PRODUCTION_ORIGIN} — this exact origin accepted this exact old credential before the rotation and rejected it after the deployment.`);
      return { exit: EXIT.PROVEN, proven: true, state: proof.state, origin: CANONICAL_PRODUCTION_ORIGIN, postAttempts: proof.postAttempts };
    }
    // Still armed. The loop is operator-driven; `prompt` decides whether to retry.
  }

  const exit = proof.lastOutcome === POST_OUTCOMES.NOT_YET_CONTAINED ? EXIT.NOT_CONTAINED : EXIT.INCONCLUSIVE;
  log(`[RESULT] NOT PROVEN at ${CANONICAL_PRODUCTION_ORIGIN} — containment is NOT established (last outcome: ${proof.lastOutcome ?? "no post-check attempted"}).`);
  return { exit, proven: false, state: proof.state, origin: CANONICAL_PRODUCTION_ORIGIN, postAttempts: proof.postAttempts };
}
