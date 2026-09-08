/**
 * Phase FIRST-ADMIN-C12 — the attestation contract shared by the bootstrap
 * route and the canonical containment probe.
 *
 * The probe must be able to distinguish "this application's credential check
 * rejected the secret" from "something returned 401". These constants are the
 * only link between the two, and they are duplicated (not imported) by
 * `scripts/lib/probe-admin-secret.mjs`, which is plain ESM run by `node`
 * outside the Next build — a test asserts the two copies agree.
 */
export const PROBE_MARKER_HEADER = "x-convergepanel-admin-secret-probe";
export const MARKER_REJECTED = "credential-rejected";
export const MARKER_ACCEPTED = "credential-accepted";
