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
const fresh = (uid: string) => ({ uid, authTimeSeconds: NOW - 60 });
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
    expect(await authorizeOrgManagement(H, { uid: "", authTimeSeconds: NOW }, ORG, "usage.view", deps({}))).toEqual({ ok: false, code: "session_required" });
    expect(await authorizeOrgManagement(H, { uid: "u", authTimeSeconds: NaN }, ORG, "usage.view", deps({}))).toEqual({ ok: false, code: "session_required" });
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
    const stale = { uid: "u1", authTimeSeconds: NOW - 15 * 60 - 1 };
    expect(await authorizeOrgManagement(H, stale, ORG, "keys.live.create", deps(member("u1", "owner")))).toEqual({ ok: false, code: "fresh_session_required" });
    expect(await authorizeOrgManagement(H, { uid: "u1", authTimeSeconds: NOW - 15 * 60 }, ORG, "keys.live.create", deps(member("u1", "owner"))).then((r) => r.ok)).toBe(true);
    expect((await authorizeOrgManagement(H, stale, ORG, "usage.view", deps(member("u1", "owner")))).ok).toBe(true);
  });

  it("a membership record for another uid is not_found (uid bound, not just the hashed id)", async () => {
    const forged = { [computeApiOrgMembershipId(ORG, "u1")]: { orgId: ORG, uid: "u2", role: "owner", status: "active" } };
    expect(await authorizeOrgManagement(H, fresh("u1"), ORG, "usage.view", deps(forged))).toEqual({ ok: false, code: "not_found" });
  });

  it.each([NOW * 1000, NOW + 301, 1.5])("auth_time %p (milliseconds, future or non-integer) → session_required", async (t) => {
    expect(await authorizeOrgManagement(H, { uid: "u1", authTimeSeconds: t }, ORG, "keys.live.create", deps(member("u1", "owner")))).toEqual({ ok: false, code: "session_required" });
  });

  it("membership read failure → api_unavailable", async () => {
    const d: ManagementDeps = { getMembership: async () => { throw new Error("down"); }, nowSeconds: () => NOW };
    expect(await authorizeOrgManagement(H, fresh("u1"), ORG, "usage.view", d)).toEqual({ ok: false, code: "api_unavailable" });
  });
});
