import { computeMembershipId } from "@/lib/workspaces/membershipId";
import { authorizeOrgManagement, type ManagementDeps } from "@/lib/apiPlatform/management";
import { computeApiOrgMembershipId } from "@/lib/apiPlatform/tenantPaths";
import { newOrgId } from "@/lib/apiPlatform/ids";
import type { OrgCapability } from "@/lib/apiPlatform/orgCapabilities";

const NOW = 2_000_000_000;
const ORG = newOrgId();

function deps(memberships: Record<string, Record<string, unknown>>): ManagementDeps {
  return { getMembership: async (id) => memberships[id] ?? null, nowSeconds: () => NOW };
}
const member = (uid: string, role: string, status = "active") => ({
  [computeApiOrgMembershipId(ORG, uid)]: { orgId: ORG, uid, role, status },
});
const OK_ACCOUNT = { emailVerified: true, disabled: false } as const;
const fresh = (uid: string) => ({ uid, authTimeSeconds: NOW - 60, ...OK_ACCOUNT });
const H = new Headers();

describe("membership ids", () => {
  it("use their own domain separator, distinct from workspace membership ids, and are pinned", () => {
    const org = "org_AAAAAAAAAAAAAAAAAAAA";
    const id = computeApiOrgMembershipId(org, "uid_1");
    expect(id).toMatch(/^am_[0-9a-f]{64}$/);
    expect(id.slice(3)).not.toBe(computeMembershipId(org, "uid_1").slice(3));
    const { createHash } = jest.requireActual("node:crypto") as typeof import("node:crypto");
    const lp = (v: string) => { const b = Buffer.from(v, "utf8"); const p = Buffer.alloc(4); p.writeUInt32BE(b.length, 0); return Buffer.concat([p, b]); };
    const expected = createHash("sha256").update(Buffer.concat([Buffer.from("convergepanel.api-org-membership.v1", "utf8"), lp(org), lp("uid_1")])).digest("hex");
    expect(id).toBe(`am_${expected}`);
    expect(computeApiOrgMembershipId(org, "uid_12")).not.toBe(computeApiOrgMembershipId(org, "uid_1"));
  });
});

describe("authorizeOrgManagement", () => {
  it("allows an owner", async () => {
    expect(await authorizeOrgManagement(H, fresh("u1"), ORG, "keys.live.create", deps(member("u1", "owner")))).toEqual({ ok: true, uid: "u1", orgId: ORG, role: "owner" });
  });

  it.each(["Bearer cpk_live_AAAAAAAAAAAA_x", "bearer cpk_test_x", "Bearer   cpk_", "BEARER cpk_live_x"])("rejects an API-key bearer %j even with a valid session", async (a) => {
    expect(await authorizeOrgManagement(new Headers({ authorization: a }), fresh("u1"), ORG, "usage.view", deps(member("u1", "owner")))).toEqual({ ok: false, code: "api_key_not_accepted" });
  });

  it("requires a session identity", async () => {
    expect(await authorizeOrgManagement(H, null, ORG, "usage.view", deps({}))).toEqual({ ok: false, code: "session_required" });
    expect(await authorizeOrgManagement(H, { uid: "", authTimeSeconds: NOW, ...OK_ACCOUNT }, ORG, "usage.view", deps({}))).toEqual({ ok: false, code: "session_required" });
    expect(await authorizeOrgManagement(H, { uid: "u", authTimeSeconds: NaN, ...OK_ACCOUNT }, ORG, "usage.view", deps({}))).toEqual({ ok: false, code: "session_required" });
  });

  it("non-member, removed member, wrong-org record and malformed org id are all not_found", async () => {
    expect(await authorizeOrgManagement(H, fresh("u2"), ORG, "usage.view", deps(member("u1", "owner")))).toEqual({ ok: false, code: "not_found" });
    expect(await authorizeOrgManagement(H, fresh("u1"), ORG, "usage.view", deps(member("u1", "owner", "removed")))).toEqual({ ok: false, code: "not_found" });
    const forged = { [computeApiOrgMembershipId(ORG, "u1")]: { orgId: newOrgId(), uid: "u1", role: "owner", status: "active" } };
    expect(await authorizeOrgManagement(H, fresh("u1"), ORG, "usage.view", deps(forged))).toEqual({ ok: false, code: "not_found" });
    expect(await authorizeOrgManagement(H, fresh("u1"), "org_bad", "usage.view", deps(member("u1", "owner")))).toEqual({ ok: false, code: "not_found" });
  });

  const MATRIX: [string, OrgCapability, boolean][] = [
    ["admin", "keys.live.create", true],
    ["admin", "org.manage", false],
    ["developer", "keys.test.create", true],
    ["developer", "keys.live.create", false],
    ["developer", "keys.revoke", false],
    ["developer", "apps.manage", false],
    ["billing", "keys.test.create", false],
    ["viewer", "usage.view", true],
    ["viewer", "audit.view", false],
    ["superuser", "usage.view", false],
    ["toString", "usage.view", false],
  ];
  it.each(MATRIX)("%s / %s → %s", async (role, cap, allowed) => {
    const r = await authorizeOrgManagement(H, fresh("u1"), ORG, cap, deps(member("u1", role)));
    expect(r.ok).toBe(allowed);
    if (!allowed) expect(r).toEqual({ ok: false, code: "insufficient_role" });
  });

  it("sensitive capabilities need a session ≤ 15 minutes old; others do not", async () => {
    const stale = { uid: "u1", authTimeSeconds: NOW - 15 * 60 - 1, ...OK_ACCOUNT };
    expect(await authorizeOrgManagement(H, stale, ORG, "keys.live.create", deps(member("u1", "owner")))).toEqual({ ok: false, code: "fresh_session_required" });
    expect(await authorizeOrgManagement(H, { uid: "u1", authTimeSeconds: NOW - 15 * 60, ...OK_ACCOUNT }, ORG, "keys.live.create", deps(member("u1", "owner"))).then((r) => r.ok)).toBe(true);
    expect((await authorizeOrgManagement(H, stale, ORG, "usage.view", deps(member("u1", "owner")))).ok).toBe(true);
  });

  it("a membership record for another uid is not_found (uid bound, not just the hashed id)", async () => {
    const forged = { [computeApiOrgMembershipId(ORG, "u1")]: { orgId: ORG, uid: "u2", role: "owner", status: "active" } };
    expect(await authorizeOrgManagement(H, fresh("u1"), ORG, "usage.view", deps(forged))).toEqual({ ok: false, code: "not_found" });
  });

  it.each([NOW * 1000, NOW + 301, 1.5])("auth_time %p (milliseconds, future or non-integer) → session_required", async (t) => {
    expect(await authorizeOrgManagement(H, { uid: "u1", authTimeSeconds: t, ...OK_ACCOUNT }, ORG, "keys.live.create", deps(member("u1", "owner")))).toEqual({ ok: false, code: "session_required" });
  });

  it("membership read failure → api_unavailable", async () => {
    const d: ManagementDeps = { getMembership: async () => { throw new Error("down"); }, nowSeconds: () => NOW };
    expect(await authorizeOrgManagement(H, fresh("u1"), ORG, "usage.view", d)).toEqual({ ok: false, code: "api_unavailable" });
  });
});

describe("C-2: account state is re-checked here (defence in depth; the resolver already enforces it)", () => {
  const reading = (m: Record<string, Record<string, unknown>>) => {
    const reads: string[] = [];
    return { reads, d: { getMembership: async (id: string) => (reads.push(id), m[id] ?? null), nowSeconds: () => NOW } as ManagementDeps };
  };

  it.each([true, undefined, null, "false", 0])("disabled = %p → session_required (account existence not revealed), no membership read", async (disabled) => {
    const { reads, d } = reading(member("u1", "owner"));
    const id = { uid: "u1", authTimeSeconds: NOW - 60, emailVerified: true, disabled } as never;
    expect(await authorizeOrgManagement(H, id, ORG, "usage.view", d)).toEqual({ ok: false, code: "session_required" });
    expect(reads).toEqual([]);
  });

  it.each([false, undefined, null, "true", 1])("emailVerified = %p → identity_not_verified (403), no membership read", async (emailVerified) => {
    const { reads, d } = reading(member("u1", "owner"));
    const id = { uid: "u1", authTimeSeconds: NOW - 60, emailVerified, disabled: false } as never;
    expect(await authorizeOrgManagement(H, id, ORG, "usage.view", d)).toEqual({ ok: false, code: "identity_not_verified" });
    expect(reads).toEqual([]);
  });

  it("disabled and unverified → session_required (disabled is checked first)", async () => {
    const id = { uid: "u1", authTimeSeconds: NOW - 60, emailVerified: false, disabled: true };
    expect(await authorizeOrgManagement(H, id, ORG, "usage.view", deps(member("u1", "owner")))).toEqual({ ok: false, code: "session_required" });
  });

  it("unverified owner cannot use ANY capability, including non-fresh ones", async () => {
    const id = { uid: "u1", authTimeSeconds: NOW - 60, emailVerified: false, disabled: false };
    for (const cap of ["usage.view", "keys.test.create", "keys.live.create", "org.manage", "audit.view"] as OrgCapability[]) {
      expect(await authorizeOrgManagement(H, id, ORG, cap, deps(member("u1", "owner")))).toEqual({ ok: false, code: "identity_not_verified" });
    }
  });

  it("identity_not_verified is a 403 permission_error with a fixed message", () => {
    const { API_ERRORS } = jest.requireActual("@/lib/apiPlatform/errors") as typeof import("@/lib/apiPlatform/errors");
    expect(API_ERRORS.identity_not_verified).toEqual({ status: 403, type: "permission_error", message: "Verify your email address to perform this action." });
  });
});

describe("own fields only (identity and membership)", () => {
  const proto = <T extends object>(inherited: Record<string, unknown>, own: T) => Object.assign(Object.create(inherited), own);

  it.each([
    ["disabled inherited", proto({ disabled: false }, { uid: "u1", authTimeSeconds: NOW - 60, emailVerified: true }), "session_required"],
    ["uid inherited", proto({ uid: "u1" }, { authTimeSeconds: NOW - 60, emailVerified: true, disabled: false }), "session_required"],
    ["authTimeSeconds inherited", proto({ authTimeSeconds: NOW - 60 }, { uid: "u1", emailVerified: true, disabled: false }), "session_required"],
    ["emailVerified inherited", proto({ emailVerified: true }, { uid: "u1", authTimeSeconds: NOW - 60, disabled: false }), "identity_not_verified"],
  ])("identity with %s → %s", async (_n, id, code) => {
    expect(await authorizeOrgManagement(H, id as never, ORG, "usage.view", deps(member("u1", "owner")))).toEqual({ ok: false, code });
  });

  it.each([
    ["status", "not_found"],
    ["orgId", "not_found"],
    ["uid", "not_found"],
    ["role", "insufficient_role"],
  ])("membership with %s inherited → %s", async (field, code) => {
    const full: Record<string, unknown> = { orgId: ORG, uid: "u1", role: "owner", status: "active" };
    const { [field]: v, ...own } = full;
    const rec = proto({ [field]: v }, own);
    const d: ManagementDeps = { getMembership: async () => rec, nowSeconds: () => NOW };
    expect(await authorizeOrgManagement(H, fresh("u1"), ORG, "usage.view", d)).toEqual({ ok: false, code });
  });

  it("control: null-prototype identity and membership with own fields are allowed", async () => {
    const id = Object.assign(Object.create(null), fresh("u1"));
    const rec = Object.assign(Object.create(null), { orgId: ORG, uid: "u1", role: "owner", status: "active" });
    const d: ManagementDeps = { getMembership: async () => rec, nowSeconds: () => NOW };
    expect(await authorizeOrgManagement(H, id, ORG, "usage.view", d)).toEqual({ ok: true, uid: "u1", orgId: ORG, role: "owner" });
  });
});

describe("explicit capability matrix (every role × every capability) and fresh-session rule", () => {
  // ✅ = allowed. Changing this table is a reviewed change to orgCapabilities.ts AND tenancy-and-auth.md §2 (R-5).
  const CAPS = [
    "org.manage", "members.manage", "apps.manage", "keys.test.create", "keys.live.create", "keys.orgWide.create",
    "keys.revoke", "keys.revoke.own", "usage.view", "audit.view", "settings.pipelineProcessing",
  ] as const;
  const TABLE: Record<string, string> = {
    //          org mem app kTe kLi kOW kRv kRO use aud pip
    owner:     "1   1   1   1   1   1   1   1   1   1   1",
    admin:     "0   1   1   1   1   1   1   1   1   1   1",
    developer: "0   0   0   1   0   0   0   1   1   0   0",
    billing:   "0   0   0   0   0   0   0   0   1   0   0",
    viewer:    "0   0   0   0   0   0   0   0   1   0   0",
  };
  const FRESH = new Set(["keys.live.create", "members.manage", "org.manage", "settings.pipelineProcessing"]);
  const cells = Object.entries(TABLE).flatMap(([role, row]) => row.split(/\s+/).map((v, i) => [role, CAPS[i], v === "1"] as const));

  it("the table covers 5 roles × 11 capabilities", () => {
    expect(cells).toHaveLength(55);
  });

  it.each(cells)("%s / %s → allowed=%s (fresh session)", async (role, cap, allowed) => {
    const r = await authorizeOrgManagement(H, fresh("u1"), ORG, cap, deps(member("u1", role)));
    expect(r).toEqual(allowed ? { ok: true, uid: "u1", orgId: ORG, role } : { ok: false, code: "insufficient_role" });
  });

  it.each(cells)("%s / %s with a 15 min + 1 s session → role first, then freshness", async (role, cap, allowed) => {
    const stale = { uid: "u1", authTimeSeconds: NOW - 15 * 60 - 1, emailVerified: true, disabled: false };
    const r = await authorizeOrgManagement(H, stale, ORG, cap, deps(member("u1", role)));
    const want = !allowed ? { ok: false, code: "insufficient_role" } : FRESH.has(cap) ? { ok: false, code: "fresh_session_required" } : { ok: true, uid: "u1", orgId: ORG, role };
    expect(r).toEqual(want);
  });

  it("the fresh-session set and window are pinned (15 minutes, exactly these four)", () => {
    const oc = jest.requireActual("@/lib/apiPlatform/orgCapabilities") as typeof import("@/lib/apiPlatform/orgCapabilities");
    expect([...oc.FRESH_SESSION_CAPABILITIES].sort()).toEqual([...FRESH].sort());
    expect(oc.FRESH_SESSION_SECONDS).toBe(900);
  });

  it.each([...FRESH])("%s: exactly 900 s old is allowed, 901 s is fresh_session_required", async (cap) => {
    const at = (age: number) => ({ uid: "u1", authTimeSeconds: NOW - age, emailVerified: true, disabled: false });
    expect((await authorizeOrgManagement(H, at(900), ORG, cap as OrgCapability, deps(member("u1", "owner")))).ok).toBe(true);
    expect(await authorizeOrgManagement(H, at(901), ORG, cap as OrgCapability, deps(member("u1", "owner")))).toEqual({ ok: false, code: "fresh_session_required" });
  });
});
