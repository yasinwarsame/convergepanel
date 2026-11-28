/**
 * ZCA P3 R2 (R1 M2) — SPEC DISPOSITION GATE. The cookie retirement removed:
 *   - exports: the two session-cookie verifiers of lib/firebase/auth-helpers.ts, the client's session-clearing
 *     function (lib/client/sessionSync.ts), the logout outcome helper and its `serverCleared` field;
 *   - an SDK call: session-cookie minting;
 *   - reasons / sources: the cookie mismatch reason, the invalid-session-cookie reason, the matching-cookie source;
 *   - client state: the pending-clears wait; the login page's session-clear-failed flag; the clear-failed telemetry op.
 * A spec that still mocks or references any of them would be VACUOUS (it would mock something no code calls, or
 * assert a branch that no longer exists). This gate fails if any spec or test helper under app/, lib/,
 * components/, hooks/, docs/ or the root __tests__/ names one — except the pinned files below, each of which names
 * them only to BAN them (static oracles, this gate) or to pin historical documentation text. Every disposition is
 * recorded in the evidence file R2-spec-disposition.md.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(__dirname, "..", "..");
export const REMOVED_NAMES = [
  "verifySessionCookie", // also covers verifySessionCookieValue
  "createSessionCookie",
  "credential_mismatch",
  "invalid_session_cookie",
  "matching_cookie_and_bearer",
  "clearServerSession",
  "pendingClears",
  "sessionClearFailed",
  "loginHrefAfterLogout",
  "serverCleared",
  "logout_clear_failed",
];
/** A word-boundary match for the reason names (so e.g. `…_app_credential_mismatch` in an unrelated message is not one). */
const pattern = new RegExp(REMOVED_NAMES.map((n) => (n.includes("_") ? `(?<![A-Za-z0-9_])${n}(?![A-Za-z0-9_])` : n)).join("|"), "g");

function walk(dir: string, inTests: boolean, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, inTests || name === "__tests__", out);
    else if (/\.(ts|tsx|js|jsx|mjs)$/.test(name) && (inTests || /\.(spec|test)\.(ts|tsx|js|jsx)$/.test(name))) out.push(p);
  }
  return out;
}
const SPEC_FILES = [...["app", "lib", "components", "hooks", "docs", "extension"].flatMap((d) => walk(join(ROOT, d), false)), ...walk(join(ROOT, "__tests__"), true)]
  .map((p) => relative(ROOT, p).split("\\").join("/"))
  .sort();

/** File → exact number of mentions, each a ban or a pinned historical sentence (never a mock, never an expectation of behaviour). */
const PINNED: Record<string, { count: number; why: string }> = {
  "__tests__/authSurface/removedExportsSpecGate.spec.ts": { count: 13, why: "this gate's own list, its header and its non-vacuity fixture" },
  "__tests__/authSurface/authSurfaceStatic.spec.ts": { count: 6, why: "L-8.1 bans: no verifier call, no minting call (zero-site pins) and their test names" },
  "__tests__/authSurface/cookieRetirementStatic.spec.ts": { count: 9, why: "R1 M3 static oracle: the banned-identifier list, its regex backstop and the evasion fixtures" },
  "docs/__tests__/bootstrapProbeInvariant.spec.ts": { count: 2, why: "a negative ban regex on the set-role route (no legacy helper, no cookie path)" },
  "docs/__tests__/systemAdminRevocationLanguage.spec.ts": { count: 1, why: "a historical overstated sentence used as a scanner CONTROL fixture (FIXED_ELSEWHERE), not an expectation of behaviour" },
};

describe("R1 M2 — no spec or test helper references a removed export, reason or client state", () => {
  it("scans every spec and test helper (closed world)", () => {
    expect(SPEC_FILES.length).toBeGreaterThan(900);
    for (const f of ["__tests__/authSurface/routeHarness.ts", "lib/admin/__tests__/privilegedRouteHarness.ts", "app/api/auth/session/__tests__/handshakeHarness.ts", "components/__tests__/AuthProvider.spec.ts", "docs/__tests__/bootstrapProbeInvariant.spec.ts"]) {
      expect({ f, scanned: SPEC_FILES.includes(f) }).toEqual({ f, scanned: true });
    }
  });

  it("outside the pinned ban / history files, NO file names a removed name — mocks, factories, mockResolvedValue, expectations or comments alike", () => {
    const offenders = SPEC_FILES.filter((f) => !(f in PINNED))
      .map((f) => ({ f, hits: [...new Set(readFileSync(join(ROOT, f), "utf8").match(pattern) ?? [])] }))
      .filter((x) => x.hits.length > 0);
    expect(offenders).toEqual([]);
  });

  it("each pinned file names them exactly as often as recorded (a new mention there is a review event)", () => {
    const actual = Object.fromEntries(Object.keys(PINNED).map((f) => [f, (readFileSync(join(ROOT, f), "utf8").match(pattern) ?? []).length]));
    expect(actual).toEqual(Object.fromEntries(Object.entries(PINNED).map(([f, v]) => [f, v.count])));
  });

  it("non-vacuity: the pattern finds each removed name in a synthetic jest.mock factory", () => {
    for (const n of REMOVED_NAMES) {
      const src = n.includes("_") ? `expect(r.reason).toBe("${n}")` : `jest.mock("@/x", () => ({ ${n}: jest.fn().mockResolvedValue(null) }));`;
      expect({ n, found: (src.match(pattern) ?? []).length > 0 }).toEqual({ n, found: true });
    }
    expect("development_adc_existing_app_credential_mismatch".match(pattern)).toBeNull();
  });
});
