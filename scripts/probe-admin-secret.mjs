#!/usr/bin/env node
/**
 * Phase FIRST-ADMIN-C11 — THE CANONICAL BOOTSTRAP-SECRET LIVENESS PROBE.
 *
 * `/api/admin/set-admin` mints `admin: true` on any uid from possession of
 * `ADMIN_SECRET` alone, with no audit record and no success log. It validates
 * the secret BEFORE the uid.
 *
 * Every prior phase tried to keep operators safe by writing the right curl in
 * prose and guarding the prose with a regex. Three review rounds put a
 * uid-bearing "verification" back into the documentation anyway — by rewording
 * it, by placing it beside an existing marker, or by putting it in a file the
 * scanner did not read. A natural-language guard cannot carry this guarantee.
 *
 * So the probe is code. The request body is built from a single literal below.
 * There is no uid parameter, no argument that could become one, and no path by
 * which caller input reaches the body except the secret itself. If the old
 * secret is still live this probe CANNOT mint anything — the worst case is a
 * 400 telling you containment has failed.
 *
 *   OLD_ADMIN_SECRET=… node scripts/probe-admin-secret.mjs https://host
 *
 * Exit 0 ONLY on 401. Everything else is a non-zero, non-proof.
 */

/** The only body this tool can construct. Deliberately not parameterised. */
export function buildProbeBody(secret) {
  return { secret };
}

export const VERDICTS = {
  REJECTED: { token: "CREDENTIAL_REJECTED", exit: 0, proof: true },
  ACCEPTED: { token: "CREDENTIAL_ACCEPTED", exit: 2, proof: false },
  INCONCLUSIVE: { token: "INCONCLUSIVE", exit: 3, proof: false },
};

export function classify(status) {
  if (status === 401) return VERDICTS.REJECTED;
  if (status === 400) return VERDICTS.ACCEPTED;
  return VERDICTS.INCONCLUSIVE; // 429, 5xx, 2xx, anything else
}

/**
 * @returns {Promise<{verdict, status: number|null, message: string}>}
 */
export async function probeAdminSecret({ baseUrl, secret, fetchImpl = fetch }) {
  if (typeof secret !== "string" || secret.length === 0) {
    return { verdict: VERDICTS.INCONCLUSIVE, status: null, message: "OLD_ADMIN_SECRET is not set" };
  }
  let res;
  try {
    res = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/api/admin/set-admin`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // The body. No uid, by construction.
      body: JSON.stringify(buildProbeBody(secret)),
    });
  } catch (err) {
    return {
      verdict: VERDICTS.INCONCLUSIVE,
      status: null,
      // The secret is never echoed, and neither is the request body.
      message: `request failed: ${err instanceof Error ? err.name : "network error"}`,
    };
  }
  const verdict = classify(res.status);
  const message =
    verdict === VERDICTS.REJECTED
      ? "OLD SECRET REJECTED — containment proven."
      : verdict === VERDICTS.ACCEPTED
        ? "OLD SECRET STILL ACCEPTED — CONTAINMENT FAILED. The rotation has not taken effect."
        : `INCONCLUSIVE (HTTP ${res.status}). This is not proof of containment.`;
  return { verdict, status: res.status, message };
}

// CLI entry point. Skipped when imported by tests.
if (import.meta.url === `file://${process.argv[1]}`) {
  const baseUrl = process.argv[2];
  if (!baseUrl) {
    console.error("usage: OLD_ADMIN_SECRET=… node scripts/probe-admin-secret.mjs <base-url>");
    process.exit(3);
  }
  const { verdict, message } = await probeAdminSecret({
    baseUrl,
    secret: process.env.OLD_ADMIN_SECRET,
  });
  console.log(`[${verdict.token}] ${message}`);
  process.exit(verdict.exit);
}
