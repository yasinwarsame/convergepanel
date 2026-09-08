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
  WAITING_FOR_OPERATOR: "WAITING_FOR_OPERATOR",
  PROVEN: "PRODUCTION_CONTAINMENT_PROVEN",
  ABORTED: "ABORTED",
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
  return {
    observation: classify(res.status, marker),
    status: res.status,
    detail: marker ? `HTTP ${res.status}` : `HTTP ${res.status}, no route marker`,
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

  const abort = (detail) => { state = STATES.ABORTED; return { ok: false, state, detail }; };

  return {
    get state() { return state; },
    get lockedUrl() { return resolved.ok ? resolved.url : null; },

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
      state = STATES.WAITING_FOR_OPERATOR;
      return { ok: true, state };
    },

    async postcheck() {
      if (state !== STATES.WAITING_FOR_OPERATOR) return abort(`postcheck called from ${state}`);
      // Same locked URL, same locked secret. Nothing is re-read.
      const r = await observeOnce({ url: resolved.url, secret: lockedSecret, fetchImpl });
      if (r.observation !== OBSERVATIONS.REJECTED) {
        return abort(`POSTCHECK_FAILED (${r.observation}, ${r.detail}) — the old credential is still accepted, or the response was not attributable`);
      }
      state = STATES.PROVEN;
      return { ok: true, state, detail: `PRODUCTION_CONTAINMENT_PROVEN at ${resolved.origin}` };
    },
  };
}

/**
 * SINGLE-SHOT DIAGNOSTIC. Reports an observation only. It can never report
 * PRODUCTION_CONTAINMENT_PROVEN, because no state transition was observed.
 */
export async function observeOldSecret({ origin, secret, fetchImpl = fetch, requireCanonical = false, allowInsecureLoopback = false }) {
  if (typeof secret !== "string" || secret.length === 0) {
    return { observation: OBSERVATIONS.INCONCLUSIVE, detail: REASONS.NO_SECRET };
  }
  const resolved = resolveEndpoint(origin, { requireCanonical, allowInsecureLoopback });
  if (!resolved.ok) return { observation: OBSERVATIONS.INCONCLUSIVE, detail: `refused: ${resolved.reason}` };
  return observeOnce({ url: resolved.url, secret, fetchImpl });
}

export const EXIT = { PROVEN: 0, NOT_CONTAINED: 2, INCONCLUSIVE: 3 };
