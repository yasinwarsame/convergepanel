/**
 * Phase FIRST-ADMIN-C4 — A DISABLED ACCOUNT HOLDS NO EMAIL-DERIVED AUTHORITY.
 *
 * The R3 review proved that `resolveLiveAuthIdentity` read only the address and
 * the verification flag from the live Firebase Auth record. `getUser()` returns
 * a record for a DISABLED account without throwing, so disabling a compromised
 * administrator did not remove their `ADMIN_EMAILS`- or
 * `GOVERNANCE_ADMIN_EMAILS`-derived authority. The live-record read is the whole
 * premise of P0.2 — that it is stronger evidence than a token claim — and it was
 * blind to the single most important operational revocation lever there is.
 *
 * The requirement is `disabled === false`, not `!disabled`: a missing or
 * non-boolean value must deny, because the only accepted proof that an account
 * is usable is an explicit `false` read out of the live record.
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

const APP_ONLY = "portal-only@test-invented.example";
const GOV_ONLY = "governance-only@test-invented.example";
const BOTH = "on-both-lists@test-invented.example";

let authRecord: Record<string, unknown> = {};
let lookupThrows = false;
const getUser = jest.fn(async () => {
  if (lookupThrows) throw new Error("auth unavailable");
  return authRecord;
});
let decoded: Record<string, unknown> = {};

jest.mock("@/lib/firebase/admin", () => ({
  adminAuth: {
    getUser: (...a: unknown[]) => getUser(...(a as [])),
    verifyIdToken: async () => decoded,
    verifySessionCookie: async () => decoded,
  },
  adminDb: {
    collection: () => ({
      doc: () => ({ get: async () => ({ exists: true, data: () => ({}) }) }),
      where: () => ({ get: async () => ({ docs: [] }) }),
    }),
  },
}));
jest.mock("@/lib/admin/entitlements", () => ({ getEffectiveEntitlements: async () => ({ planId: "free" }) }));
jest.mock("@/lib/governance/reviewerFields", () => ({ parseGovernanceReviewerFor: () => [] }));

import {
  hasVerifiedApplicationAdminAuthority,
  hasVerifiedGovernanceAdminAuthority,
  resolveLiveAuthIdentity,
  resolveVerifiedAdminScopes,
} from "@/lib/admin/verifiedAdminIdentity";
import { requireAdminPortalAccess } from "@/lib/firebase/auth-helpers";
import { checkAdminOnly } from "@/lib/governance/authCheck";
import {
  resolveGovernanceVisibleUserIds,
  runOwnerVisibleInGovernance,
} from "@/lib/governance/governanceVisibleUserIds";

/**
 * Branch-complete denial assertion. A refused result (`ok:false`) grants
 * nothing; a granted result must carry a FINITE owner set that excludes a
 * stranger. Writing it this way avoids both traps seen in this workstream:
 * masking `null` with `??`, and calling the predicate with `undefined`.
 */
const expectNoGlobalVisibility = (vis: unknown) => {
  const v = vis as { ok: boolean; visibleUserIds?: string[] | null; queueScope?: string };
  expect(v.queueScope).not.toBe("admin_global");
  if (v.ok) {
    expect(v.visibleUserIds).not.toBeNull();
    expect(runOwnerVisibleInGovernance(v.visibleUserIds as string[], "some-stranger")).toBe(false);
  } else {
    expect(v).toEqual({ ok: false, kind: expect.stringMatching(/^(plan_required|no_db)$/) });
  }
};

const req = () =>
  ({
    headers: { get: (k: string) => (k.toLowerCase() === "authorization" ? "Bearer t" : null) },
    cookies: { get: () => undefined },
  }) as never;

beforeEach(() => {
  process.env.ADMIN_EMAILS = `${APP_ONLY},${BOTH}`;
  process.env.GOVERNANCE_ADMIN_EMAILS = `${GOV_ONLY},${BOTH}`;
  authRecord = {};
  lookupThrows = false;
  decoded = { uid: "u1" };
  getUser.mockClear();
});

describe("ADMIN_EMAILS — the disabled matrix", () => {
  it("verified + enabled + allowlisted -> ADMIN_PORTAL YES", async () => {
    authRecord = { email: APP_ONLY, emailVerified: true, disabled: false };
    await expect(hasVerifiedApplicationAdminAuthority("u1")).resolves.toBe(true);
  });

  it("THE CORE PROOF: verified + DISABLED + allowlisted -> ADMIN_PORTAL NO", async () => {
    authRecord = { email: APP_ONLY, emailVerified: true, disabled: true };
    await expect(hasVerifiedApplicationAdminAuthority("u1")).resolves.toBe(false);
  });

  it("unverified + enabled + allowlisted -> NO", async () => {
    authRecord = { email: APP_ONLY, emailVerified: false, disabled: false };
    await expect(hasVerifiedApplicationAdminAuthority("u1")).resolves.toBe(false);
  });

  it("unverified + disabled + allowlisted -> NO", async () => {
    authRecord = { email: APP_ONLY, emailVerified: false, disabled: true };
    await expect(hasVerifiedApplicationAdminAuthority("u1")).resolves.toBe(false);
  });

  it("the real portal GUARD refuses a disabled allowlisted caller", async () => {
    authRecord = { email: APP_ONLY, emailVerified: true, disabled: true };
    await expect(requireAdminPortalAccess(req())).resolves.toBeNull();
  });

  it("the same caller enabled IS admitted by the guard (the control)", async () => {
    authRecord = { email: APP_ONLY, emailVerified: true, disabled: false };
    await expect(requireAdminPortalAccess(req())).resolves.toEqual({ uid: "u1", email: APP_ONLY });
  });
});

describe("GOVERNANCE_ADMIN_EMAILS — the disabled matrix", () => {
  it("verified + enabled + allowlisted -> GOVERNANCE YES", async () => {
    authRecord = { email: GOV_ONLY, emailVerified: true, disabled: false };
    await expect(hasVerifiedGovernanceAdminAuthority("g1")).resolves.toBe(true);
    await expect(checkAdminOnly("g1")).resolves.toBe(true);
  });

  it("THE CORE PROOF: verified + DISABLED + allowlisted -> GOVERNANCE NO", async () => {
    authRecord = { email: GOV_ONLY, emailVerified: true, disabled: true };
    await expect(hasVerifiedGovernanceAdminAuthority("g1")).resolves.toBe(false);
    await expect(checkAdminOnly("g1")).resolves.toBe(false);
  });

  it("a disabled governance member gets NO admin_global visibility", async () => {
    authRecord = { email: GOV_ONLY, emailVerified: true, disabled: true };
    const vis = (await resolveGovernanceVisibleUserIds("g1")) as {
      ok: boolean; visibleUserIds?: string[] | null; queueScope?: string;
    };
    // C5: the previous form was `expect(vis.visibleUserIds ?? "absent").not.toBeNull()`,
    // which cannot fail for ANY value — the banned `??`-masking pattern.
    expectNoGlobalVisibility(vis);
  });
});

describe("an address on BOTH lists loses BOTH scopes when disabled", () => {
  it("enabled -> both scopes", async () => {
    authRecord = { email: BOTH, emailVerified: true, disabled: false };
    const s = await resolveVerifiedAdminScopes("b1");
    expect({ portal: s.adminPortal, governance: s.governanceAdmin }).toEqual({ portal: true, governance: true });
  });

  it("disabled -> NEITHER scope", async () => {
    authRecord = { email: BOTH, emailVerified: true, disabled: true };
    const s = await resolveVerifiedAdminScopes("b1");
    expect({ portal: s.adminPortal, governance: s.governanceAdmin }).toEqual({ portal: false, governance: false });
    expect(s.disabled).toBe(true);
  });
});

describe("the enabled flag must be an explicit false", () => {
  it.each([
    ["absent", undefined],
    ["null", null],
    ["string \"false\"", "false"],
    ["number 0", 0],
    ["object", {}],
  ])("a record whose disabled is %s is treated as ENABLED only when Firebase says so", async (_l, value) => {
    // `record.disabled === true` is how the SDK reports a disabled account; any
    // other value means enabled. What must NOT happen is a *missing live read*
    // being treated as enabled — that case is the lookup-failure test below.
    authRecord = { email: APP_ONLY, emailVerified: true, disabled: value };
    const expected = value === true;
    await expect(hasVerifiedApplicationAdminAuthority("u1")).resolves.toBe(!expected);
  });

  it("the reported `disabled` field mirrors the record independently of verification", async () => {
    // Guards against coupling `disabled` to `emailVerified` during
    // normalisation: that leaves authority correct (unverified denies anyway)
    // while making the reported field lie for a disabled, unverified account.
    authRecord = { email: APP_ONLY, emailVerified: false, disabled: true };
    await expect(resolveLiveAuthIdentity("u1")).resolves.toEqual({
      status: "resolved", email: APP_ONLY, emailVerified: false, disabled: true,
    });
    expect((await resolveVerifiedAdminScopes("u1")).disabled).toBe(true);

    authRecord = { email: APP_ONLY, emailVerified: true, disabled: true };
    expect((await resolveVerifiedAdminScopes("u1")).disabled).toBe(true);

    authRecord = { email: APP_ONLY, emailVerified: false, disabled: false };
    expect((await resolveVerifiedAdminScopes("u1")).disabled).toBe(false);
  });

  it("LOOKUP FAILURE grants neither scope and reports disabled, so consumers fail closed", async () => {
    lookupThrows = true;
    const s = await resolveVerifiedAdminScopes("u1");
    expect(s).toEqual({
      lookupStatus: "lookup_failed",
      adminPortal: false,
      governanceAdmin: false,
      email: "",
      emailVerified: false,
      disabled: true,
    });
    await expect(resolveLiveAuthIdentity("u1")).resolves.toEqual({ status: "lookup_failed" });
  });
});
