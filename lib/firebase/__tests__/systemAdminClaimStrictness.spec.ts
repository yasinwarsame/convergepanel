/**
 * Phase FIRST-ADMIN-C3 — SYSTEM_ADMIN is `admin === true`, never truthiness.
 *
 * R2 found the apex tier unpinned. Replacing `=== true` with `!!` in
 * `requireSystemAdminBearer`, `verifyAdminToken` or `checkIsAdminFromToken`
 * survived the entire suite — while the equivalent assertion DID exist for the
 * weaker ADMIN_PORTAL tier and for `/api/admin/access`. The tier that gates
 * provider credentials, admin-claim minting, bulk purge and destructive
 * account/billing mutation was the one left untested.
 *
 * A truthy read is not academic: Firebase custom claims are arbitrary JSON, so
 * `admin: "false"`, `admin: {}` and `admin: []` are all storable and all truthy.
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

let decoded: Record<string, unknown> = {};
let authRecord: Record<string, unknown> = {};
const verifyIdToken = jest.fn(async () => decoded);
const verifySessionCookie = jest.fn(async () => decoded);

jest.mock("@/lib/firebase/admin", () => ({
  adminAuth: {
    verifyIdToken: (...a: unknown[]) => verifyIdToken(...(a as [])),
    verifySessionCookie: (...a: unknown[]) => verifySessionCookie(...(a as [])),
    getUser: async () => authRecord,
  },
  adminDb: {},
}));

import { requireSystemAdminBearer } from "@/lib/firebase/adminAuth";
import {
  checkIsAdminFromToken,
  requireSystemAdminAccess,
  verifyAdminToken,
  verifySessionCookieValue,
} from "@/lib/firebase/auth-helpers";

/** Every non-`true` claim value that a truthy read would wrongly accept. */
const TRUTHY_BUT_NOT_TRUE: Array<[string, unknown]> = [
  ['string "true"', "true"],
  ['string "false"', "false"],
  ["number 1", 1],
  ["empty object", {}],
  ["empty array", []],
];
const FALSY: Array<[string, unknown]> = [
  ["false", false],
  ["absent", undefined],
  ["null", null],
  ["number 0", 0],
  ["empty string", ""],
];
const DENIED = [...TRUTHY_BUT_NOT_TRUE, ...FALSY];

const bearer = () =>
  ({
    headers: { get: (k: string) => (k.toLowerCase() === "authorization" ? "Bearer t" : null) },
    cookies: { get: () => undefined },
  }) as never;

beforeEach(() => {
  process.env.ADMIN_EMAILS = "";
  process.env.GOVERNANCE_ADMIN_EMAILS = "";
  decoded = {};
  authRecord = {};
  verifyIdToken.mockClear();
  verifySessionCookie.mockClear();
});

describe("requireSystemAdminBearer — keys + set-role", () => {
  it("admin === true is admitted", async () => {
    decoded = { uid: "u", admin: true };
    await expect(requireSystemAdminBearer(bearer())).resolves.toEqual({ uid: "u" });
  });

  it.each(DENIED)("admin %s is DENIED", async (_label, value) => {
    decoded = value === undefined ? { uid: "u" } : { uid: "u", admin: value };
    await expect(requireSystemAdminBearer(bearer())).resolves.toBeNull();
  });
});

describe("verifyAdminToken / requireSystemAdminAccess — purge, destructive user + billing", () => {
  it("admin === true is admitted", async () => {
    decoded = { uid: "u", admin: true };
    await expect(verifyAdminToken(bearer())).resolves.toMatchObject({ uid: "u", isAdmin: true });
    await expect(requireSystemAdminAccess(bearer())).resolves.toMatchObject({ uid: "u", isAdmin: true });
  });

  it.each(DENIED)("admin %s yields isAdmin false and is DENIED", async (_label, value) => {
    decoded = value === undefined ? { uid: "u" } : { uid: "u", admin: value };
    await expect(verifyAdminToken(bearer())).resolves.toMatchObject({ isAdmin: false });
    await expect(requireSystemAdminAccess(bearer())).resolves.toBeNull();
  });
});

describe("checkIsAdminFromToken", () => {
  it("admin === true -> true", async () => {
    decoded = { uid: "u", admin: true };
    await expect(checkIsAdminFromToken("t")).resolves.toBe(true);
  });

  it.each(DENIED)("admin %s -> false", async (_label, value) => {
    decoded = value === undefined ? { uid: "u" } : { uid: "u", admin: value };
    await expect(checkIsAdminFromToken("t")).resolves.toBe(false);
  });
});

describe("verifySessionCookieValue — the isAdmin field must honour the same contract", () => {
  /**
   * No production route authorizes on this field today (every consumer reads
   * only `.uid`), but it is named `isAdmin` and was computed with `!!`, so it
   * returned true for `"false"`, `{}` and `[]`. C3 makes it strict so a future
   * caller inherits the contract the rest of the tier model uses.
   */
  it("admin === true -> isAdmin true", async () => {
    decoded = { uid: "u", admin: true };
    await expect(verifySessionCookieValue("c")).resolves.toEqual({ uid: "u", isAdmin: true });
  });

  it.each(DENIED)("admin %s -> isAdmin false", async (_label, value) => {
    decoded = value === undefined ? { uid: "u" } : { uid: "u", admin: value };
    await expect(verifySessionCookieValue("c")).resolves.toEqual({ uid: "u", isAdmin: false });
  });
});
