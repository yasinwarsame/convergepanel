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
