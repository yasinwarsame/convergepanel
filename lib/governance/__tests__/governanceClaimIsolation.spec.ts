/**
 * Phase FIRST-ADMIN-C2 — governance authority does NOT follow the `admin`
 * custom claim.
 *
 * `lib/governance/authCheck.ts` has always documented this ("Governance has
 * never honoured the `admin` custom claim... widening it here would silently
 * hand every application-admin the global governance queue"), but the C2
 * mutation set proved the claim was documentation only: adding a
 * `customClaims.admin === true` shortcut to `checkAdminOnly()` survived the
 * entire suite.
 *
 * `checkAdminOnly()` gates governance POLICY WRITES and audit backfill, and its
 * sibling returns global scope over every user's runs. SYSTEM_ADMIN is the tier
 * for credentials, role minting and purge — it is deliberately NOT the tier for
 * reading every customer's research.
 */

const APP_ONLY = "portal-only@test-invented.example";
const GOV_ONLY = "governance-only@test-invented.example";
const OUTSIDER = "nobody@test-invented.example";

let authRecord: Record<string, unknown> = {};
const getUser = jest.fn(async () => authRecord);
jest.mock("@/lib/firebase/admin", () => ({
  adminAuth: { getUser: (...a: unknown[]) => getUser(...(a as [])) },
  adminDb: {
    collection: () => ({
      doc: () => ({ get: async () => ({ exists: true, data: () => ({}) }) }),
      where: () => ({ get: async () => ({ docs: [] }) }),
    }),
  },
}));
jest.mock("@/lib/admin/entitlements", () => ({
  getEffectiveEntitlements: async () => ({ planId: "free" }),
}));
jest.mock("@/lib/governance/reviewerFields", () => ({ parseGovernanceReviewerFor: () => [] }));

import { checkAdminOnly } from "@/lib/governance/authCheck";
import { resolveGovernanceVisibleUserIds } from "@/lib/governance/governanceVisibleUserIds";

beforeEach(() => {
  process.env.ADMIN_EMAILS = APP_ONLY;
  process.env.GOVERNANCE_ADMIN_EMAILS = GOV_ONLY;
  authRecord = {};
  getUser.mockClear();
});

describe("checkAdminOnly — the custom claim confers no governance authority", () => {
  it("THE CORE PROOF: a verified SYSTEM_ADMIN claim holder off the governance list is denied", async () => {
    authRecord = { email: OUTSIDER, emailVerified: true, customClaims: { admin: true } };
    await expect(checkAdminOnly("sys")).resolves.toBe(false);
  });

  it("the claim does not rescue an ADMIN_EMAILS member either", async () => {
    authRecord = { email: APP_ONLY, emailVerified: true, customClaims: { admin: true } };
    await expect(checkAdminOnly("app")).resolves.toBe(false);
  });

  it("a verified GOVERNANCE_ADMIN_EMAILS member is granted, with no claim at all", async () => {
    authRecord = { email: GOV_ONLY, emailVerified: true, customClaims: {} };
    await expect(checkAdminOnly("gov")).resolves.toBe(true);
  });

  it("an unverified governance-list address is denied even holding the claim", async () => {
    authRecord = { email: GOV_ONLY, emailVerified: false, customClaims: { admin: true } };
    await expect(checkAdminOnly("gov")).resolves.toBe(false);
  });
});

describe("global governance scope — the custom claim never confers it", () => {
  // Same idiom as governanceScopeSeparation.spec.ts: the granted branch is
  // `queueScope: "admin_global"` WITH `visibleUserIds: null` (no owner filter).
  // Asserting only `!== "admin_global"` would pass vacuously on the `ok: false`
  // branch, where the field is absent — so the denial is asserted positively as
  // "did not receive the null, unfiltered owner set".
  const scope = (v: unknown) =>
    v as { ok: boolean; visibleUserIds?: string[] | null; queueScope?: string };

  it("THE CORE PROOF: a SYSTEM_ADMIN claim holder off the governance list gets no global scope", async () => {
    authRecord = { email: OUTSIDER, emailVerified: true, customClaims: { admin: true } };
    const vis = scope(await resolveGovernanceVisibleUserIds("sys"));
    expect(vis.queueScope).not.toBe("admin_global");
    expect(vis.visibleUserIds ?? undefined).not.toBeNull();
  });

  it("an ADMIN_EMAILS member holding the claim also gets no global scope", async () => {
    authRecord = { email: APP_ONLY, emailVerified: true, customClaims: { admin: true } };
    const vis = scope(await resolveGovernanceVisibleUserIds("app"));
    expect(vis.queueScope).not.toBe("admin_global");
    expect(vis.visibleUserIds ?? undefined).not.toBeNull();
  });

  it("a verified GOVERNANCE_ADMIN_EMAILS member does get global scope", async () => {
    authRecord = { email: GOV_ONLY, emailVerified: true, customClaims: {} };
    const vis = scope(await resolveGovernanceVisibleUserIds("gov"));
    expect(vis.ok).toBe(true);
    expect(vis.queueScope).toBe("admin_global");
    expect(vis.visibleUserIds).toBeNull();
  });
});
