/**
 * Store: transactional mutations with same-transaction audit rows, org binding (cross-tenant → not_found),
 * revocation/rotation semantics, and end-to-end with the principal guard.
 */
import { randomBytes } from "node:crypto";
import { FakeFirestore } from "@/lib/apiPlatform/__tests__/helpers/fakeFirestore";
import { createApiKey, createApplication, createOrganization, revokeApiKey, rotateApiKey, type StoreContext } from "@/lib/apiPlatform/store";
import { requireApiPrincipal, type PrincipalDeps } from "@/lib/apiPlatform/principal";

jest.mock("@/lib/apiPlatform/apiPlans", () => ({ isApprovedApiPlanId: (id: unknown) => id === "beta_capped_v1", API_PLANS: [] }));
import type { PepperSet } from "@/lib/apiPlatform/keys";
import { computeApiOrgMembershipId } from "@/lib/apiPlatform/tenantPaths";

const peppers: PepperSet = { status: "available", current: randomBytes(32), previous: null };
let now = 1_800_000_000_000;

function setup() {
  const db = new FakeFirestore();
  const ctx = (uid = "uid_owner"): StoreContext => ({ db, actorUid: uid, requestId: "req_test", now });
  const deps: PrincipalDeps = {
    peppers: () => peppers,
    getKey: async (id) => db.get(`apiKeys/${id}`) ?? null,
    getOrg: async (id) => db.get(`apiOrganizations/${id}`) ?? null,
    getApp: async (id) => db.get(`apiApplications/${id}`) ?? null,
    now: () => now,
  };
  return { db, ctx, deps };
}

async function orgWithApp(s: ReturnType<typeof setup>, uid = "uid_owner") {
  const o = await createOrganization(s.ctx(uid), { name: "Acme" });
  if (!o.ok) throw new Error();
  const a = await createApplication(s.ctx(uid), { orgId: o.value.orgId, name: "CMS prod" });
  if (!a.ok) throw new Error();
  return { orgId: o.value.orgId, appId: a.value.appId };
}

const auth = (secret: string) => new Headers({ authorization: `Bearer ${secret}` });
const audits = (db: FakeFirestore) => db.byPrefix("apiAuditEvents/").map(([, v]) => v);

describe("createOrganization", () => {
  it("creates org (active, no plan) + owner membership + audit rows in one transaction", async () => {
    const s = setup();
    const r = await createOrganization(s.ctx(), { name: "Acme" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(s.db.get(`apiOrganizations/${r.value.orgId}`)).toMatchObject({ status: "active", plan: null, createdBy: "uid_owner" });
    const mid = computeApiOrgMembershipId(r.value.orgId, "uid_owner");
    expect(s.db.get(`apiOrgMemberships/${mid}`)).toMatchObject({ role: "owner", status: "active", uid: "uid_owner", orgId: r.value.orgId });
    expect(audits(s.db).map((a) => a.eventType).sort()).toEqual(["member.added", "org.created"]);
  });

  it("atomic: a failing audit write commits nothing", async () => {
    const s = setup();
    s.db.failOn = "apiAuditEvents/";
    await expect(createOrganization(s.ctx(), { name: "Acme" })).rejects.toThrow("injected commit failure");
    expect(s.db.docs.size).toBe(0);
  });

  it.each(["", "x".repeat(81), "<script>", "a\nb"])("rejects name %j", async (name) => {
    expect(await createOrganization(setup().ctx(), { name })).toEqual({ ok: false, reason: "invalid_input" });
  });
});

describe("createApiKey", () => {
  it("stores only the key hash; audit carries the prefix, never the secret or hash", async () => {
    const s = setup();
    const { orgId, appId } = await orgWithApp(s);
    const r = await createApiKey(s.ctx(), { actorRole: "owner", orgId, appId, mode: "test" }, peppers);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rec = s.db.get(`apiKeys/${r.value.keyId}`)!;
    expect(rec).toMatchObject({ orgId, appId, mode: "test", appScoped: true, hashVersion: 1, revokedAt: null });
    expect(rec.scopes).toEqual(["models:read", "verifications:read", "verifications:write"]);
    const secret = r.value.displaySecret.slice(-43);
    const everything = JSON.stringify([...s.db.docs.values()]);
    expect(everything).not.toContain(secret);
    const keyAudit = audits(s.db).find((a) => a.eventType === "api_key.created")!;
    expect(keyAudit.target).toEqual({ appId, credentialPrefix: r.value.prefix });
    expect(JSON.stringify(keyAudit)).not.toContain(String(rec.hash));
  });

  it("cross-org: another org's app is not_found and writes nothing", async () => {
    const s = setup();
    const a = await orgWithApp(s, "uid_a");
    const b = await orgWithApp(s, "uid_b");
    const before = s.db.docs.size;
    expect(await createApiKey(s.ctx("uid_a"), { actorRole: "owner", orgId: a.orgId, appId: b.appId, mode: "test" }, peppers)).toEqual({ ok: false, reason: "not_found" });
    expect(s.db.docs.size).toBe(before);
  });

  it.each([
    [{ scopes: [] }],
    [{ scopes: ["verifications:read", "admin"] }],
    [{ scopes: "verifications:read" }],
    [{ mode: "prod" }],
    [{ appScoped: "no" }],
    [{ expiresAt: 1 }],
    [{ expiresAt: 1.5e12 + 0.5 }],
  ])("rejects invalid input %j", async (over) => {
    const s = setup();
    const { orgId, appId } = await orgWithApp(s);
    expect(await createApiKey(s.ctx(), { actorRole: "owner", orgId, appId, mode: "test", ...(over as object) } as never, peppers)).toEqual({ ok: false, reason: "invalid_input" });
  });

  it("no peppers → peppers_unavailable, nothing written", async () => {
    const s = setup();
    const { orgId, appId } = await orgWithApp(s);
    const before = s.db.docs.size;
    expect(await createApiKey(s.ctx(), { actorRole: "owner", orgId, appId, mode: "test" }, { status: "unavailable", reason: "missing" })).toEqual({ ok: false, reason: "peppers_unavailable" });
    expect(s.db.docs.size).toBe(before);
  });

  it("refuses for a suspended org or a disabled app", async () => {
    const s = setup();
    const { orgId, appId } = await orgWithApp(s);
    s.db.docs.set(`apiApplications/${appId}`, { ...s.db.get(`apiApplications/${appId}`)!, status: "disabled" });
    expect(await createApiKey(s.ctx(), { actorRole: "owner", orgId, appId, mode: "test" }, peppers)).toEqual({ ok: false, reason: "app_not_active" });
    s.db.docs.set(`apiOrganizations/${orgId}`, { ...s.db.get(`apiOrganizations/${orgId}`)!, status: "suspended" });
    expect(await createApiKey(s.ctx(), { actorRole: "owner", orgId, appId, mode: "test" }, peppers)).toEqual({ ok: false, reason: "org_not_active" });
  });
});

describe("end to end with the principal guard", () => {
  it("a created test key authenticates; revocation denies on the next call; double revoke is refused", async () => {
    const s = setup();
    const { orgId, appId } = await orgWithApp(s);
    const k = await createApiKey(s.ctx(), { actorRole: "owner", orgId, appId, mode: "test" }, peppers);
    if (!k.ok) throw new Error();
    const ok = await requireApiPrincipal(auth(k.value.displaySecret), "verifications:read", s.deps);
    expect(ok.ok && ok.principal.orgId === orgId && ok.principal.appId === appId).toBe(true);
    expect(await revokeApiKey(s.ctx(), { actorRole: "owner", orgId, keyId: k.value.keyId })).toEqual({ ok: true, value: { prefix: k.value.prefix } });
    expect(await requireApiPrincipal(auth(k.value.displaySecret), "verifications:read", s.deps)).toEqual({ ok: false, code: "invalid_api_key" });
    expect(await revokeApiKey(s.ctx(), { actorRole: "owner", orgId, keyId: k.value.keyId })).toEqual({ ok: false, reason: "already_revoked" });
    expect(audits(s.db).filter((a) => a.eventType === "api_key.revoked")).toHaveLength(1);
  });

  it("a live key is refused until the org has an active API plan", async () => {
    const s = setup();
    const { orgId, appId } = await orgWithApp(s);
    const k = await createApiKey(s.ctx(), { actorRole: "owner", orgId, appId, mode: "live" }, peppers);
    if (!k.ok) throw new Error();
    expect(await requireApiPrincipal(auth(k.value.displaySecret), "verifications:read", s.deps)).toEqual({ ok: false, code: "live_key_requires_plan" });
  });

  it("cross-org revoke/rotate are not_found and change nothing", async () => {
    const s = setup();
    const a = await orgWithApp(s, "uid_a");
    const b = await orgWithApp(s, "uid_b");
    const kb = await createApiKey(s.ctx("uid_b"), { actorRole: "owner", orgId: b.orgId, appId: b.appId, mode: "test" }, peppers);
    if (!kb.ok) throw new Error();
    const snapshot = JSON.stringify([...s.db.docs.entries()]);
    expect(await revokeApiKey(s.ctx("uid_a"), { actorRole: "owner", orgId: a.orgId, keyId: kb.value.keyId })).toEqual({ ok: false, reason: "not_found" });
    expect(await rotateApiKey(s.ctx("uid_a"), { actorRole: "owner", orgId: a.orgId, keyId: kb.value.keyId, overlapSeconds: 0 }, peppers)).toEqual({ ok: false, reason: "not_found" });
    expect(JSON.stringify([...s.db.docs.entries()])).toBe(snapshot);
    expect((await requireApiPrincipal(auth(kb.value.displaySecret), "verifications:read", s.deps)).ok).toBe(true);
  });

  it("rotation with overlap: both work until the old one expires; then only the new one", async () => {
    const s = setup();
    const { orgId, appId } = await orgWithApp(s);
    const old = await createApiKey(s.ctx(), { actorRole: "owner", orgId, appId, mode: "test", scopes: ["verifications:read"], appScoped: false }, peppers);
    if (!old.ok) throw new Error();
    const rot = await rotateApiKey(s.ctx(), { actorRole: "owner", orgId, keyId: old.value.keyId, overlapSeconds: 3600 }, peppers);
    if (!rot.ok) throw new Error();
    expect(s.db.get(`apiKeys/${rot.value.keyId}`)).toMatchObject({ scopes: ["verifications:read"], appScoped: false, mode: "test", appId });
    expect(s.db.get(`apiKeys/${old.value.keyId}`)).toMatchObject({ rotatedTo: rot.value.keyId, expiresAt: now + 3600_000, revokedAt: null });
    expect((await requireApiPrincipal(auth(old.value.displaySecret), "verifications:read", s.deps)).ok).toBe(true);
    expect((await requireApiPrincipal(auth(rot.value.displaySecret), "verifications:read", s.deps)).ok).toBe(true);
    const saved = now;
    now += 3600_000;
    try {
      expect(await requireApiPrincipal(auth(old.value.displaySecret), "verifications:read", s.deps)).toEqual({ ok: false, code: "invalid_api_key" });
      expect((await requireApiPrincipal(auth(rot.value.displaySecret), "verifications:read", s.deps)).ok).toBe(true);
      expect(await rotateApiKey(s.ctx(), { actorRole: "owner", orgId, keyId: old.value.keyId, overlapSeconds: 0 }, peppers)).toEqual({ ok: false, reason: "already_revoked" });
    } finally {
      now = saved;
    }
    const rotAudit = audits(s.db).find((a) => a.eventType === "api_key.rotated")!;
    expect(rotAudit.target).toEqual({ appId, credentialPrefix: rot.value.prefix, replacedCredentialPrefix: old.value.prefix });
  });

  it("rotation with overlap 0 revokes the old key immediately", async () => {
    const s = setup();
    const { orgId, appId } = await orgWithApp(s);
    const old = await createApiKey(s.ctx(), { actorRole: "owner", orgId, appId, mode: "test" }, peppers);
    if (!old.ok) throw new Error();
    const rot = await rotateApiKey(s.ctx(), { actorRole: "owner", orgId, keyId: old.value.keyId, overlapSeconds: 0 }, peppers);
    if (!rot.ok) throw new Error();
    expect(s.db.get(`apiKeys/${old.value.keyId}`)).toMatchObject({ revokedAt: now, revokedBy: "uid_owner", rotatedTo: rot.value.keyId });
    expect(await requireApiPrincipal(auth(old.value.displaySecret), "verifications:read", s.deps)).toEqual({ ok: false, code: "invalid_api_key" });
  });

  it("rotate/revoke trust the KEY's orgId, not the app's (forged inconsistent record → not_found)", async () => {
    const s = setup();
    const a = await orgWithApp(s, "uid_a");
    const b = await orgWithApp(s, "uid_b");
    const kb = await createApiKey(s.ctx("uid_b"), { actorRole: "owner", orgId: b.orgId, appId: b.appId, mode: "test" }, peppers);
    if (!kb.ok) throw new Error();
    // A corrupted record points B's key at A's app; org A must still not be able to act on it.
    s.db.docs.set(`apiKeys/${kb.value.keyId}`, { ...s.db.get(`apiKeys/${kb.value.keyId}`)!, appId: a.appId });
    expect(await rotateApiKey(s.ctx("uid_a"), { actorRole: "owner", orgId: a.orgId, keyId: kb.value.keyId, overlapSeconds: 0 }, peppers)).toEqual({ ok: false, reason: "not_found" });
    expect(await revokeApiKey(s.ctx("uid_a"), { actorRole: "owner", orgId: a.orgId, keyId: kb.value.keyId })).toEqual({ ok: false, reason: "not_found" });
  });

  it.each([-1, 1.5, 30 * 24 * 3600 + 1])("rotation rejects overlap %p", async (overlapSeconds) => {
    const s = setup();
    const { orgId, appId } = await orgWithApp(s);
    const old = await createApiKey(s.ctx(), { actorRole: "owner", orgId, appId, mode: "test" }, peppers);
    if (!old.ok) throw new Error();
    expect(await rotateApiKey(s.ctx(), { actorRole: "owner", orgId, keyId: old.value.keyId, overlapSeconds }, peppers)).toEqual({ ok: false, reason: "invalid_input" });
  });

  it("rotation never extends an earlier expiry", async () => {
    const s = setup();
    const { orgId, appId } = await orgWithApp(s);
    const old = await createApiKey(s.ctx(), { actorRole: "owner", orgId, appId, mode: "test", expiresAt: now + 60_000 }, peppers);
    if (!old.ok) throw new Error();
    await rotateApiKey(s.ctx(), { actorRole: "owner", orgId, keyId: old.value.keyId, overlapSeconds: 3600 }, peppers);
    expect(s.db.get(`apiKeys/${old.value.keyId}`)!.expiresAt).toBe(now + 60_000);
  });
});

describe("review fixes: rotation invariants and store-side role enforcement", () => {
  async function withKey(over: Record<string, unknown> = {}) {
    const s = setup();
    const { orgId, appId } = await orgWithApp(s);
    const k = await createApiKey(s.ctx(), { actorRole: "owner", orgId, appId, mode: "test", ...over } as never, peppers);
    if (!k.ok) throw new Error(JSON.stringify(k));
    return { s, orgId, appId, k: k.value };
  }

  it("a key rotates once: a second rotation (double submit / tx retry) is already_rotated", async () => {
    const { s, orgId, k } = await withKey();
    expect((await rotateApiKey(s.ctx(), { actorRole: "owner", orgId, keyId: k.keyId, overlapSeconds: 3600 }, peppers)).ok).toBe(true);
    expect(await rotateApiKey(s.ctx(), { actorRole: "owner", orgId, keyId: k.keyId, overlapSeconds: 3600 }, peppers)).toEqual({ ok: false, reason: "already_rotated" });
    expect(s.db.byPrefix("apiKeys/")).toHaveLength(2);
  });

  it("the successor keeps the original expiry", async () => {
    const { s, orgId, k } = await withKey({ expiresAt: now + 7_200_000 });
    const r = await rotateApiKey(s.ctx(), { actorRole: "owner", orgId, keyId: k.keyId, overlapSeconds: 60 }, peppers);
    if (!r.ok) throw new Error();
    expect(s.db.get(`apiKeys/${r.value.keyId}`)!.expiresAt).toBe(now + 7_200_000);
  });

  it("rotate refuses a key whose app belongs to another org", async () => {
    const s = setup();
    const a = await orgWithApp(s, "uid_a");
    const b = await orgWithApp(s, "uid_b");
    const ka = await createApiKey(s.ctx("uid_a"), { actorRole: "owner", orgId: a.orgId, appId: a.appId, mode: "test" }, peppers);
    if (!ka.ok) throw new Error();
    s.db.docs.set(`apiKeys/${ka.value.keyId}`, { ...s.db.get(`apiKeys/${ka.value.keyId}`)!, appId: b.appId });
    expect(await rotateApiKey(s.ctx("uid_a"), { actorRole: "owner", orgId: a.orgId, keyId: ka.value.keyId, overlapSeconds: 0 }, peppers)).toEqual({ ok: false, reason: "not_found" });
  });

  it.each([
    ["developer", { mode: "live" }],
    ["developer", { appScoped: false }],
    ["billing", {}],
    ["viewer", {}],
    ["owner", { scopes: ["model_responses:read"] }],
    ["admin", { scopes: ["verifications:read", "model_responses:read"] }],
  ])("createApiKey: %s with %j → not_permitted, nothing written", async (role, over) => {
    const s = setup();
    const { orgId, appId } = await orgWithApp(s);
    const before = s.db.docs.size;
    expect(await createApiKey(s.ctx(), { actorRole: role, orgId, appId, mode: "test", ...over } as never, peppers)).toEqual({ ok: false, reason: "not_permitted" });
    expect(s.db.docs.size).toBe(before);
  });

  it("createApiKey: developer may create an app-scoped test key; admin may create org-wide and live", async () => {
    const s = setup();
    const { orgId, appId } = await orgWithApp(s);
    expect((await createApiKey(s.ctx(), { actorRole: "developer", orgId, appId, mode: "test" }, peppers)).ok).toBe(true);
    expect((await createApiKey(s.ctx(), { actorRole: "admin", orgId, appId, mode: "live", appScoped: false }, peppers)).ok).toBe(true);
  });

  it("revoke: developer revokes only keys they created; others' keys are not_found", async () => {
    const s = setup();
    const { orgId, appId } = await orgWithApp(s);
    const mine = await createApiKey(s.ctx("uid_dev"), { actorRole: "developer", orgId, appId, mode: "test" }, peppers);
    const theirs = await createApiKey(s.ctx("uid_owner"), { actorRole: "owner", orgId, appId, mode: "test" }, peppers);
    if (!mine.ok || !theirs.ok) throw new Error();
    expect(await revokeApiKey(s.ctx("uid_dev"), { actorRole: "developer", orgId, keyId: theirs.value.keyId })).toEqual({ ok: false, reason: "not_found" });
    expect((await revokeApiKey(s.ctx("uid_dev"), { actorRole: "developer", orgId, keyId: mine.value.keyId })).ok).toBe(true);
    expect(await revokeApiKey(s.ctx("uid_v"), { actorRole: "viewer", orgId, keyId: theirs.value.keyId })).toEqual({ ok: false, reason: "not_permitted" });
  });

  it("rotate requires revoke-any plus the create right for the key's mode", async () => {
    const { s, orgId, k } = await withKey();
    expect(await rotateApiKey(s.ctx(), { actorRole: "developer", orgId, keyId: k.keyId, overlapSeconds: 0 }, peppers)).toEqual({ ok: false, reason: "not_permitted" });
    expect((await rotateApiKey(s.ctx(), { actorRole: "admin", orgId, keyId: k.keyId, overlapSeconds: 0 }, peppers)).ok).toBe(true);
  });
});

describe("same-transaction audit for EVERY mutation (a failing audit write commits nothing)", () => {
  async function seeded() {
    const s = setup();
    const { orgId, appId } = await orgWithApp(s);
    const k = await createApiKey(s.ctx(), { actorRole: "owner", orgId, appId, mode: "test" }, peppers);
    if (!k.ok) throw new Error();
    return { s, orgId, appId, keyId: k.value.keyId };
  }
  const OPS: [string, (x: Awaited<ReturnType<typeof seeded>>) => Promise<unknown>][] = [
    ["createApplication", ({ s, orgId }) => createApplication(s.ctx(), { orgId, name: "Second" })],
    ["createApiKey", ({ s, orgId, appId }) => createApiKey(s.ctx(), { actorRole: "owner", orgId, appId, mode: "test" }, peppers)],
    ["revokeApiKey", ({ s, orgId, keyId }) => revokeApiKey(s.ctx(), { actorRole: "owner", orgId, keyId })],
    ["rotateApiKey (overlap)", ({ s, orgId, keyId }) => rotateApiKey(s.ctx(), { actorRole: "owner", orgId, keyId, overlapSeconds: 60 }, peppers)],
    ["rotateApiKey (overlap 0)", ({ s, orgId, keyId }) => rotateApiKey(s.ctx(), { actorRole: "owner", orgId, keyId, overlapSeconds: 0 }, peppers)],
  ];
  it.each(OPS)("%s: injected audit commit failure → rejects and every document is unchanged", async (_n, op) => {
    const x = await seeded();
    const before = JSON.stringify([...x.s.db.docs.entries()]);
    x.s.db.failOn = "apiAuditEvents/";
    await expect(op(x)).rejects.toThrow("injected commit failure");
    x.s.db.failOn = null;
    expect(JSON.stringify([...x.s.db.docs.entries()])).toBe(before);
  });
});
