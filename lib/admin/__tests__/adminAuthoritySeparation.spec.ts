/**
 * Phase FIRST-ADMIN-C1 — scope separation and the privileged ASCII boundary.
 *
 * Two defects are closed here, both found in the pre-enrollment audit:
 *
 *  1. `ADMIN_EMAILS` and `GOVERNANCE_ADMIN_EMAILS` fed ONE predicate, so either
 *     list granted application-admin APIs AND governance-global scope AND policy
 *     write. Least privilege was unachievable by configuration.
 *  2. Matching applied NFKC and stripped zero-width characters on both sides, so
 *     a non-ASCII identity could canonicalize onto an ASCII allowlist entry. The
 *     live-record rule does not help: that holder verified a DIFFERENT mailbox.
 *
 * The invariant under test is stated positively, and needs no claim about any
 * particular registrable domain:
 *
 *   EMAIL-DERIVED PRIVILEGED AUTHORITY IS AVAILABLE ONLY TO ASCII IDENTITIES.
 *
 * NOTE: every non-ASCII character below is written as a \u escape on purpose. A
 * literal zero-width or BOM in a test file is invisible to a reviewer, which is
 * the same weakness these tests exist to close.
 */

/**
 * Phase FIRST-ADMIN-C2 test hygiene: jest workers reuse a single `process.env`
 * across the test FILES they run, so a suite that sets a privileged allowlist
 * and never restores it leaks that value into every later file in the same
 * worker. Snapshot BEFORE this file's own assignments; restore afterwards.
 */
const __PRIVILEGED_ENV_SNAPSHOT = {
  ADMIN_EMAILS: process.env.ADMIN_EMAILS,
  GOVERNANCE_ADMIN_EMAILS: process.env.GOVERNANCE_ADMIN_EMAILS,
};
afterAll(() => {
  for (const [key, value] of Object.entries(__PRIVILEGED_ENV_SNAPSHOT)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const APP = "app-admin@test-invented.example";
const GOV = "gov-admin@test-invented.example";
const BOTH = "both-admin@test-invented.example";
const OUTSIDER = "nobody@test-invented.example";

let authRecord: Record<string, unknown> = {};
let getUserThrows = false;
const getUser = jest.fn(async () => {
  if (getUserThrows) throw new Error("auth unavailable");
  return authRecord;
});
let decoded: Record<string, unknown> = {};
jest.mock("@/lib/firebase/admin", () => ({
  adminAuth: {
    getUser: (...a: unknown[]) => getUser(...(a as [])),
    verifyIdToken: async () => decoded,
    verifySessionCookie: async () => decoded,
  },
  adminDb: {},
}));

import {
  canonicalizePrivilegedEmail,
  invalidPrivilegedEntryCount,
  isApplicationAdminEmail,
  isGovernanceAdminEmail,
} from "../config";
import {
  hasVerifiedApplicationAdminAuthority,
  hasVerifiedGovernanceAdminAuthority,
} from "../verifiedAdminIdentity";

/**
 * Phase C2: the verified predicates are module-private now, so the scope tests
 * drive the REAL uid-only authority resolvers against a mocked live Auth
 * record. That is strictly stronger — it exercises the live-lookup path too.
 */
const asIdentity = async (email: string, emailVerified: unknown) => {
  authRecord = { email, emailVerified };
  return {
    application: await hasVerifiedApplicationAdminAuthority("probe"),
    governance: await hasVerifiedGovernanceAdminAuthority("probe"),
  };
};
import { requireAdminApiAccess } from "@/lib/firebase/auth-helpers";

const req = (h: string | null = "Bearer t") =>
  ({ headers: { get: (k: string) => (k.toLowerCase() === "authorization" ? h : null) },
     cookies: { get: () => undefined } }) as never;

beforeEach(() => {
  process.env.ADMIN_EMAILS = APP + "," + BOTH;
  process.env.GOVERNANCE_ADMIN_EMAILS = GOV + "," + BOTH;
  authRecord = {};
  decoded = {};
  getUserThrows = false;
  getUser.mockClear();
});

describe("scope separation — the lists no longer collapse into one predicate", () => {
  it("1. ADMIN_EMAILS only -> application YES, governance NO", async () => {
    expect(await asIdentity(APP, true)).toEqual({ application: true, governance: false });
  });

  it("2. GOVERNANCE_ADMIN_EMAILS only -> application NO, governance YES", async () => {
    expect(await asIdentity(GOV, true)).toEqual({ application: false, governance: true });
  });

  it("3. present in BOTH lists -> both scopes, independently satisfied", async () => {
    expect(await asIdentity(BOTH, true)).toEqual({ application: true, governance: true });
  });

  it("5. an ordinary verified account gets neither", async () => {
    expect(await asIdentity(OUTSIDER, true)).toEqual({ application: false, governance: false });
  });

  it("6. UNVERIFIED application-list member gets neither", async () => {
    expect(await asIdentity(APP, false)).toEqual({ application: false, governance: false });
  });

  it("7. UNVERIFIED governance-list member gets neither", async () => {
    expect(await asIdentity(GOV, false)).toEqual({ application: false, governance: false });
  });

  it.each([
    ["undefined", undefined], ["null", null], ['"true"', "true"], ["1", 1], ["0", 0],
  ])("non-boolean verification %s denies both scopes", async (_l, v) => {
    expect(await asIdentity(BOTH, v)).toEqual({ application: false, governance: false });
  });
});

describe("live resolvers — uid only, own evidence, fail closed", () => {
  it("application resolver honours ADMIN_EMAILS and not the governance list", async () => {
    authRecord = { email: APP, emailVerified: true };
    await expect(hasVerifiedApplicationAdminAuthority("u")).resolves.toBe(true);
    await expect(hasVerifiedGovernanceAdminAuthority("u")).resolves.toBe(false);
  });

  it("governance resolver honours GOVERNANCE_ADMIN_EMAILS and not the application list", async () => {
    authRecord = { email: GOV, emailVerified: true };
    await expect(hasVerifiedGovernanceAdminAuthority("u")).resolves.toBe(true);
    await expect(hasVerifiedApplicationAdminAuthority("u")).resolves.toBe(false);
  });

  it("8. Auth lookup failure denies BOTH scopes", async () => {
    getUserThrows = true;
    await expect(hasVerifiedApplicationAdminAuthority("u")).resolves.toBe(false);
    await expect(hasVerifiedGovernanceAdminAuthority("u")).resolves.toBe(false);
  });

  it("both resolvers take a uid only — no forgeable evidence parameter", () => {
    expect(hasVerifiedApplicationAdminAuthority.length).toBe(1);
    expect(hasVerifiedGovernanceAdminAuthority.length).toBe(1);
  });
});

describe("application-admin API guard reads ADMIN_EMAILS only", () => {
  it("verified ADMIN_EMAILS member is granted", async () => {
    decoded = { uid: "u", email: APP };
    authRecord = { email: APP, emailVerified: true };
    await expect(requireAdminApiAccess(req())).resolves.toEqual({ uid: "u", email: APP });
  });

  it("THE FIX: a verified GOVERNANCE-only member is DENIED the admin API surface", async () => {
    decoded = { uid: "g", email: GOV };
    authRecord = { email: GOV, emailVerified: true };
    await expect(requireAdminApiAccess(req())).resolves.toBeNull();
  });

  it("4. custom claim alone still grants application admin", async () => {
    decoded = { uid: "c", email: OUTSIDER, admin: true };
    authRecord = { email: OUTSIDER, emailVerified: false };
    await expect(requireAdminApiAccess(req())).resolves.toEqual({ uid: "c", email: OUTSIDER });
  });

  it("4. custom claim confers NO governance authority", async () => {
    authRecord = { email: OUTSIDER, emailVerified: false };
    await expect(hasVerifiedGovernanceAdminAuthority("c")).resolves.toBe(false);
  });
});

const FULLWIDTH_A = "\uFF41";      // FULLWIDTH LATIN SMALL LETTER A
const ZERO_WIDTH  = "\u200B";      // ZERO WIDTH SPACE
const BOM         = "\uFEFF";      // BYTE ORDER MARK
const CYRILLIC_A  = "\u0430";      // CYRILLIC SMALL LETTER A
const GREEK_EPS   = "\u03B5";      // GREEK SMALL LETTER EPSILON
const E_ACUTE     = "\u00E9";      // LATIN SMALL LETTER E WITH ACUTE

const NON_ASCII: [string, string][] = [
  ["fullwidth char in local part", FULLWIDTH_A + "pp-admin@test-invented.example"],
  ["fullwidth char in domain", "app-admin@test-invented.ex" + FULLWIDTH_A + "mple"],
  ["zero-width inside local part", "app" + ZERO_WIDTH + "-admin@test-invented.example"],
  ["BOM prefix", BOM + "app-admin@test-invented.example"],
  ["Cyrillic confusable", CYRILLIC_A + "pp-admin@test-invented.example"],
  ["Greek confusable", "app-admin@test-invented.exampl" + GREEK_EPS],
  ["arbitrary non-ASCII", "app-admin@test-invented.example" + E_ACUTE],
];

describe("PRIVILEGED ASCII BOUNDARY — non-ASCII identities are ineligible", () => {
  it.each(NON_ASCII)("%s is rejected by the canonicalizer", (_l, addr) => {
    expect(canonicalizePrivilegedEmail(addr)).toBeNull();
  });

  it.each(NON_ASCII)("%s receives NEITHER scope, even live and verified", async (_l, addr) => {
    authRecord = { email: addr, emailVerified: true };
    await expect(hasVerifiedApplicationAdminAuthority("x")).resolves.toBe(false);
    await expect(hasVerifiedGovernanceAdminAuthority("x")).resolves.toBe(false);
  });

  it("THE CORE PROOF: rejection precedes any folding that could produce a match", () => {
    // Reproduces the OLD matcher exactly.
    const oldFold = (s: string) =>
      s.normalize("NFKC").replace(/[\u200B-\u200D\uFEFF]/g, "").trim().toLowerCase();
    let dangerous = 0;
    for (const [, addr] of NON_ASCII) {
      const folded = oldFold(addr);
      if (folded === APP || folded === GOV || folded === BOTH) {
        dangerous += 1;
        expect(isApplicationAdminEmail(addr)).toBe(false);
        expect(isGovernanceAdminEmail(addr)).toBe(false);
      }
      expect(canonicalizePrivilegedEmail(addr)).toBeNull();
    }
    // The fixture must actually contain addresses the OLD matcher would have
    // authorized, or this test proves nothing.
    expect(dangerous).toBeGreaterThan(0);
  });

  it("ASCII case and outer whitespace still canonicalize normally", () => {
    expect(isApplicationAdminEmail(APP.toUpperCase())).toBe(true);
    expect(isApplicationAdminEmail("  " + APP + "  ")).toBe(true);
    expect(isGovernanceAdminEmail(GOV.toUpperCase())).toBe(true);
  });

  it("control characters are rejected", () => {
    expect(canonicalizePrivilegedEmail("app\u0007@x.example")).toBeNull();
    expect(canonicalizePrivilegedEmail("app\n@x.example")).toBeNull();
  });
});

describe("allowlist ENTRY hardening — a bad entry is dropped, never repaired", () => {
  it("a non-ASCII configured entry grants nothing, and is not folded into an ASCII identity", () => {
    process.env.ADMIN_EMAILS = FULLWIDTH_A + "dmin@test-invented.example";
    expect(isApplicationAdminEmail("admin@test-invented.example")).toBe(false);
    expect(isApplicationAdminEmail(FULLWIDTH_A + "dmin@test-invented.example")).toBe(false);
  });

  it("valid entries survive alongside invalid ones", () => {
    process.env.ADMIN_EMAILS = FULLWIDTH_A + "bad@x.example, " + APP + " ,,";
    expect(isApplicationAdminEmail(APP)).toBe(true);
    expect(invalidPrivilegedEntryCount(process.env.ADMIN_EMAILS)).toBe(1);
  });

  it("an empty or unset list grants nothing", () => {
    process.env.ADMIN_EMAILS = "";
    delete process.env.GOVERNANCE_ADMIN_EMAILS;
    expect(isApplicationAdminEmail(APP)).toBe(false);
    expect(isGovernanceAdminEmail(GOV)).toBe(false);
  });
});

describe("P0.2 provenance regressions still hold", () => {
  it("a token email matching a privileged address cannot substitute for the record", async () => {
    decoded = { uid: "attacker", email: APP, email_verified: true };
    authRecord = { email: OUTSIDER, emailVerified: true };
    await expect(requireAdminApiAccess(req())).resolves.toBeNull();
  });

  it("a stale token claiming verified cannot override an unverified live record", async () => {
    decoded = { uid: "attacker", email: APP, email_verified: true };
    authRecord = { email: APP, emailVerified: false };
    await expect(requireAdminApiAccess(req())).resolves.toBeNull();
  });

  it("no exported authority helper accepts caller-supplied identity evidence", async () => {
    const mod = await import("../verifiedAdminIdentity");
    for (const [name, v] of Object.entries(mod)) {
      if (typeof v !== "function") continue;
      if (!name.startsWith("hasVerified")) continue;
      expect(v.length).toBe(1);
    }
  });
});
