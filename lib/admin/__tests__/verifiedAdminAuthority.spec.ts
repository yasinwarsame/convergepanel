/**
 * Phase FIRESTORE-AUTHZ-P0.2 — verified administrator identity.
 *
 * Exercises the REAL predicate, the REAL live-identity module and the REAL
 * `requireAdminApiAccess` guard. Nothing here re-implements the boolean under
 * test; only Firebase Admin is doubled.
 *
 * The vulnerability closed here: an email allowlist granted administrator
 * authority to any identity whose address matched, with no proof of mailbox
 * ownership — and anyone can register any unclaimed address.
 */

process.env.ADMIN_EMAILS = "admin@test-invented.example";
process.env.GOVERNANCE_ADMIN_EMAILS = "gov@test-invented.example";

const ADMIN = "admin@test-invented.example";
const GOV = "gov@test-invented.example";
const OUTSIDER = "nobody@test-invented.example";

let authRecord: Record<string, unknown> | null = {};
let getUserThrows = false;
const getUser = jest.fn(async () => {
  if (getUserThrows) throw new Error("auth unavailable");
  return authRecord;
});
let decoded: Record<string, unknown> = {};
const verifyIdToken = jest.fn(async () => decoded);
const verifySessionCookie = jest.fn(async () => decoded);

jest.mock("@/lib/firebase/admin", () => ({
  adminAuth: {
    getUser: (...a: unknown[]) => getUser(...(a as [])),
    verifyIdToken: (...a: unknown[]) => verifyIdToken(...(a as [])),
    verifySessionCookie: (...a: unknown[]) => verifySessionCookie(...(a as [])),
  },
  adminDb: {},
}));

import { isAdminEmail, isVerifiedAdminEmail } from "@/lib/admin/config";
import {
  hasVerifiedAllowlistAdminAuthority,
  resolveLiveAuthIdentity,
} from "@/lib/admin/verifiedAdminIdentity";
import { requireAdminApiAccess } from "@/lib/firebase/auth-helpers";

const req = (header: string | null = "Bearer t") =>
  ({
    headers: { get: (k: string) => (k.toLowerCase() === "authorization" ? header : null) },
    cookies: { get: () => undefined },
  }) as never;

beforeEach(() => {
  authRecord = {};
  getUserThrows = false;
  decoded = {};
  getUser.mockClear();
});

// ---------------------------------------------------------------------------
describe("pure predicate — fail closed on every non-`true` verification value", () => {
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["false", false],
    ['string "true"', "true"],
    ['string "false"', "false"],
    ["number 0", 0],
    ["number 1", 1],
    ["empty string", ""],
    ["object", {}],
  ])("emailVerified %s -> denied", (_label, value) => {
    expect(isVerifiedAdminEmail({ email: ADMIN, emailVerified: value as never })).toBe(false);
  });

  it("emailVerified exactly true + allowlisted -> granted", () => {
    expect(isVerifiedAdminEmail({ email: ADMIN, emailVerified: true })).toBe(true);
    expect(isVerifiedAdminEmail({ email: GOV, emailVerified: true })).toBe(true);
  });

  it("verified but NOT allowlisted -> denied", () => {
    expect(isVerifiedAdminEmail({ email: OUTSIDER, emailVerified: true })).toBe(false);
  });

  it.each([["missing", undefined], ["null", null], ["empty", ""]])(
    "email %s -> denied even when verified",
    (_l, email) => {
      expect(isVerifiedAdminEmail({ email: email as never, emailVerified: true })).toBe(false);
    }
  );

  it("canonical normalization is reused, not reimplemented", () => {
    for (const variant of [
      "  ADMIN@test-invented.example  ",
      "Admin@Test-Invented.Example",
      "​admin@test-invented.example﻿",
      "admin@test-invented.example‍",
    ]) {
      expect(isAdminEmail(variant)).toBe(true);
      expect(isVerifiedAdminEmail({ email: variant, emailVerified: true })).toBe(true);
      // The same variant still grants nothing while unverified.
      expect(isVerifiedAdminEmail({ email: variant, emailVerified: false })).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
describe("live Auth evidence", () => {
  it("returns email and verification from ONE record read", async () => {
    authRecord = { email: ADMIN, emailVerified: true };
    const live = await resolveLiveAuthIdentity("u1");
    expect(live).toEqual({ status: "resolved", email: ADMIN, emailVerified: true });
    expect(getUser).toHaveBeenCalledTimes(1);
  });

  it("coerces a non-boolean record flag to false rather than trusting it", async () => {
    authRecord = { email: ADMIN, emailVerified: "true" };
    const live = await resolveLiveAuthIdentity("u1");
    expect(live).toEqual({ status: "resolved", email: ADMIN, emailVerified: false });
  });

  it("FAIL CLOSED: lookup throws -> lookup_failed -> no authority", async () => {
    getUserThrows = true;
    await expect(resolveLiveAuthIdentity("u1")).resolves.toEqual({ status: "lookup_failed" });
    await expect(hasVerifiedAllowlistAdminAuthority("u1")).resolves.toBe(false);
  });

  it("FAIL CLOSED: empty uid never reaches Auth", async () => {
    await expect(resolveLiveAuthIdentity("")).resolves.toEqual({ status: "lookup_failed" });
    expect(getUser).not.toHaveBeenCalled();
  });

  it("verified allowlisted -> authority; unverified allowlisted -> none", async () => {
    authRecord = { email: ADMIN, emailVerified: true };
    await expect(hasVerifiedAllowlistAdminAuthority("u1")).resolves.toBe(true);
    authRecord = { email: ADMIN, emailVerified: false };
    await expect(hasVerifiedAllowlistAdminAuthority("u1")).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe("requireAdminApiAccess — allowlist path", () => {
  it("THE FIX: unverified allowlisted identity is DENIED", async () => {
    decoded = { uid: "attacker", email: ADMIN, email_verified: false };
    authRecord = { email: ADMIN, emailVerified: false };
    await expect(requireAdminApiAccess(req())).resolves.toBeNull();
  });

  it("verified allowlisted identity is granted", async () => {
    decoded = { uid: "real", email: ADMIN };
    authRecord = { email: ADMIN, emailVerified: true };
    await expect(requireAdminApiAccess(req())).resolves.toEqual({ uid: "real", email: ADMIN });
  });

  it("verified but not allowlisted is denied", async () => {
    decoded = { uid: "u", email: OUTSIDER };
    authRecord = { email: OUTSIDER, emailVerified: true };
    await expect(requireAdminApiAccess(req())).resolves.toBeNull();
  });

  it("record with no email is denied", async () => {
    decoded = { uid: "u" };
    authRecord = { emailVerified: true };
    await expect(requireAdminApiAccess(req())).resolves.toBeNull();
  });

  it("FAIL CLOSED: Auth lookup failure denies (never falls back to the token email)", async () => {
    decoded = { uid: "attacker", email: ADMIN, email_verified: true };
    getUserThrows = true;
    await expect(requireAdminApiAccess(req())).resolves.toBeNull();
  });

  it("no credential at all is denied without touching Auth", async () => {
    await expect(requireAdminApiAccess(req(null))).resolves.toBeNull();
    expect(getUser).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
describe("requireAdminApiAccess — IDENTITY-SOURCE PAIRING (the core invariant)", () => {
  it("stale token claims verified+allowlisted, live record is unverified -> DENIED", async () => {
    decoded = { uid: "attacker", email: ADMIN, email_verified: true };
    authRecord = { email: ADMIN, emailVerified: false };
    await expect(requireAdminApiAccess(req())).resolves.toBeNull();
  });

  it("token carries NO email, live record verified+allowlisted -> GRANTED", async () => {
    decoded = { uid: "real" };
    authRecord = { email: ADMIN, emailVerified: true };
    await expect(requireAdminApiAccess(req())).resolves.toEqual({ uid: "real", email: ADMIN });
  });

  it("token email differs from record email: authority follows the RECORD only", async () => {
    // Token asserts an allowlisted address; the real account is not allowlisted.
    decoded = { uid: "attacker", email: ADMIN, email_verified: true };
    authRecord = { email: OUTSIDER, emailVerified: true };
    await expect(requireAdminApiAccess(req())).resolves.toBeNull();

    // And the reverse: token asserts an outsider, record is the verified admin.
    decoded = { uid: "real", email: OUTSIDER, email_verified: false };
    authRecord = { email: ADMIN, emailVerified: true };
    await expect(requireAdminApiAccess(req())).resolves.toEqual({ uid: "real", email: ADMIN });
  });

  it("a granted allowlist decision always consumed a live lookup", async () => {
    decoded = { uid: "real", email: ADMIN, email_verified: true };
    authRecord = { email: ADMIN, emailVerified: true };
    await requireAdminApiAccess(req());
    expect(getUser).toHaveBeenCalledWith("real");
  });
});

// ---------------------------------------------------------------------------
describe("requireAdminApiAccess — custom claim stays independent", () => {
  it("admin:true + unverified + NOT allowlisted -> still granted", async () => {
    decoded = { uid: "claimadmin", email: OUTSIDER, email_verified: false, admin: true };
    authRecord = { email: OUTSIDER, emailVerified: false };
    await expect(requireAdminApiAccess(req())).resolves.toEqual({
      uid: "claimadmin",
      email: OUTSIDER,
    });
  });

  it("admin:true with no token email still resolves a display email from the record", async () => {
    decoded = { uid: "claimadmin", admin: true };
    authRecord = { email: OUTSIDER, emailVerified: false };
    await expect(requireAdminApiAccess(req())).resolves.toEqual({
      uid: "claimadmin",
      email: OUTSIDER,
    });
  });

  it("admin:false / absent claim confers nothing on its own", async () => {
    decoded = { uid: "u", email: OUTSIDER, admin: false };
    authRecord = { email: OUTSIDER, emailVerified: true };
    await expect(requireAdminApiAccess(req())).resolves.toBeNull();
  });

  it("a non-boolean admin claim is not accepted", async () => {
    decoded = { uid: "u", email: OUTSIDER, admin: "true" };
    authRecord = { email: OUTSIDER, emailVerified: true };
    await expect(requireAdminApiAccess(req())).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe("session/token freshness — the five-day cookie problem", () => {
  it("cookie says UNVERIFIED but the account has since verified -> authority is immediate", async () => {
    // Stale session cookie minted before verification.
    decoded = { uid: "real", email: ADMIN, email_verified: false };
    // Live record: the user has since clicked the verification link.
    authRecord = { email: ADMIN, emailVerified: true };
    await expect(requireAdminApiAccess(req())).resolves.toEqual({ uid: "real", email: ADMIN });
  });

  it("security inverse: cookie says VERIFIED but the live record does not -> denied", async () => {
    decoded = { uid: "attacker", email: ADMIN, email_verified: true };
    authRecord = { email: ADMIN, emailVerified: false };
    await expect(requireAdminApiAccess(req())).resolves.toBeNull();
  });
});
