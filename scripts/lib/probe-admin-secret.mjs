/**
 * Phase FIRST-ADMIN-C12 — THE CANONICAL BOOTSTRAP-SECRET LIVENESS PROBE.
 *
 * `/api/admin/set-admin` mints `admin: true` on any uid from possession of
 * `ADMIN_SECRET` alone, with no audit record and no success log. It validates
 * the secret BEFORE the uid, which is what makes a uid-less probe safe.
 *
 * C11 shipped this as one file with three ways to lie, all found by review:
 *   - a `import.meta.url === \`file://${process.argv[1]}\`` entry guard that
 *     silently failed to match on any path needing percent-encoding or
 *     traversing a symlink — the CLI body never ran and Node exited 0, which
 *     the runbook reads as "containment proven";
 *   - no redirect policy, so a 307/308 forwarded the live secret to another
 *     origin and the probe then accepted THAT origin's 401 as proof;
 *   - a verdict derived from a bare HTTP status, so a WAF, an SSO gate, a
 *     preview-deployment wall or a typo'd host all read as proof.
 *
 * The corrections, in order:
 *   - the implementation lives here and the entrypoint calls it
 *     UNCONDITIONALLY; there is no branch that can decline to run;
 *   - `redirect: "error"` — a redirect is a refusal, never a result;
 *   - the route emits an attestation header, and only a 401 carrying it counts.
 *
 * Exit 0 is emitted on exactly one condition. Everything else is non-zero.
 */

/** Emitted ONLY by app/api/admin/set-admin/route.ts. */
export const PROBE_MARKER_HEADER = "x-convergepanel-admin-secret-probe";
export const MARKER_REJECTED = "credential-rejected";
export const MARKER_ACCEPTED = "credential-accepted";

export const ENDPOINT_PATH = "/api/admin/set-admin";

export const VERDICTS = {
  REJECTED: { token: "CREDENTIAL_REJECTED", exit: 0, proof: true },
  ACCEPTED: { token: "CREDENTIAL_ACCEPTED", exit: 2, proof: false },
  INCONCLUSIVE: { token: "INCONCLUSIVE", exit: 3, proof: false },
};

/** The only body this tool can construct. Deliberately not parameterised. */
export function buildProbeBody(secret) {
  return { secret };
}

/**
 * A verdict needs BOTH the status and the application's own attestation. A
 * bare 401 proves only that something, somewhere, refused something.
 */
export function classify(status, marker) {
  if (status === 401 && marker === MARKER_REJECTED) return VERDICTS.REJECTED;
  if (status === 400 && marker === MARKER_ACCEPTED) return VERDICTS.ACCEPTED;
  return VERDICTS.INCONCLUSIVE;
}

/**
 * The operator names an ORIGIN; this builds the endpoint. An arbitrary path,
 * query or fragment is refused rather than silently posting the credential
 * somewhere unintended.
 */
export function resolveEndpoint(rawBaseUrl, { allowInsecure = false } = {}) {
  let u;
  try {
    u = new URL(rawBaseUrl);
  } catch {
    return { ok: false, reason: "target is not a valid URL" };
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    return { ok: false, reason: `unsupported scheme ${u.protocol}` };
  }
  const isLoopback = u.hostname === "127.0.0.1" || u.hostname === "localhost" || u.hostname === "[::1]";
  if (u.protocol === "http:" && !(allowInsecure && isLoopback)) {
    return { ok: false, reason: "refusing to send the credential over plain http" };
  }
  if (u.username || u.password) return { ok: false, reason: "target must not contain credentials" };
  if (u.search) return { ok: false, reason: "target must not contain a query string" };
  if (u.hash) return { ok: false, reason: "target must not contain a fragment" };
  if (u.pathname !== "/" && u.pathname !== "") {
    return { ok: false, reason: "target must be an origin, not a path" };
  }
  return { ok: true, url: `${u.origin}${ENDPOINT_PATH}` };
}

export async function probeAdminSecret({ baseUrl, secret, fetchImpl = fetch, allowInsecure = false }) {
  if (typeof secret !== "string" || secret.length === 0) {
    return { verdict: VERDICTS.INCONCLUSIVE, status: null, message: "OLD_ADMIN_SECRET is not set" };
  }
  const target = resolveEndpoint(baseUrl, { allowInsecure });
  if (!target.ok) {
    return { verdict: VERDICTS.INCONCLUSIVE, status: null, message: `refused: ${target.reason}` };
  }

  let res;
  try {
    res = await fetchImpl(target.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // No uid. No path from caller input to this object.
      body: JSON.stringify(buildProbeBody(secret)),
      // A redirect would carry this credential to an origin the operator did
      // not name, and its response would then be read as a verdict. Refuse.
      redirect: "error",
    });
  } catch (err) {
    return {
      verdict: VERDICTS.INCONCLUSIVE,
      status: null,
      // Never the secret, never the body, never the message.
      message: `request failed: ${err instanceof Error ? err.name : "network error"}`,
    };
  }

  const marker = typeof res.headers?.get === "function" ? res.headers.get(PROBE_MARKER_HEADER) : null;
  const verdict = classify(res.status, marker);
  const message =
    verdict === VERDICTS.REJECTED
      ? "OLD SECRET REJECTED — containment proven."
      : verdict === VERDICTS.ACCEPTED
        ? "OLD SECRET STILL ACCEPTED — CONTAINMENT FAILED. The rotation has not taken effect."
        : marker
          ? `INCONCLUSIVE (HTTP ${res.status}). Not proof of containment.`
          : `INCONCLUSIVE (HTTP ${res.status}, no application attestation — the response did not come from the bootstrap route). Not proof of containment.`;
  return { verdict, status: res.status, message };
}

/** Always returns a line and an exit code. There is no silent path. */
export async function runCli(argv, env, fetchImpl = fetch) {
  const baseUrl = argv[0];
  if (!baseUrl) {
    return {
      exitCode: VERDICTS.INCONCLUSIVE.exit,
      line: `[${VERDICTS.INCONCLUSIVE.token}] usage: OLD_ADMIN_SECRET=… node scripts/probe-admin-secret.mjs <origin>`,
    };
  }
  const { verdict, message } = await probeAdminSecret({
    baseUrl,
    secret: env.OLD_ADMIN_SECRET,
    fetchImpl,
    allowInsecure: env.PROBE_ALLOW_INSECURE_LOOPBACK === "1",
  });
  return { exitCode: verdict.exit, line: `[${verdict.token}] ${message}` };
}
