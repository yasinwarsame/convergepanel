/**
 * ZCA baseline ratchet (see cookieOnlyOracle.ts). At L-1 (6ac28575) the oracle OBSERVED 127 surfaces where
 * the cookie alone established identity and 17 SYSTEM_ADMIN surfaces that refused it with a different
 * reason (evidence: 15-zca/l1/survey.*.json). L-2..L-6 added 6 resolver-based GET surfaces to the list.
 *
 * ZCA L-8 made every surface bearer-only, so both lists are EMPTY and every (route, method) runs the
 * zero-cookie-authority assertion as an ordinary test. Adding an entry here is re-admitting a
 * cookie-authority surface and is a security review event.
 */
export const COOKIE_AUTHORITY_AT_BASELINE: readonly string[] = [];
export const COOKIE_DISTINGUISHABLE_ONLY_AT_BASELINE: readonly string[] = [];
export const BASELINE_COOKIE_AUTHORITY: ReadonlySet<string> = new Set<string>([...COOKIE_AUTHORITY_AT_BASELINE, ...COOKIE_DISTINGUISHABLE_ONLY_AT_BASELINE]);
