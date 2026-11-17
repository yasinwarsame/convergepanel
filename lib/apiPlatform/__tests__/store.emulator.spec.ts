/**
 * API-1a store + principal + management against REAL Firestore semantics (firebase-admin → emulator),
 * through the FirestoreLike port (helpers/adminFirestoreAdapter.ts). Skipped unless FIRESTORE_EMULATOR_HOST
 * is set; the project id is a `demo-` id, which the emulator never forwards anywhere.
 *
 *   java -jar ~/.cache/firebase/emulators/cloud-firestore-emulator-v1.19.8.jar --host=127.0.0.1 --port=8291 &
 *   FIRESTORE_EMULATOR_HOST=127.0.0.1:8291 GCLOUD_PROJECT=demo-api1a npx jest --runTestsByPath lib/apiPlatform/__tests__/store.emulator.spec.ts
 *
 * Proves under real transactions (contention, retries): cross-org isolation and forged bindings; org/app/key
 * lifecycle; parallel create / rotate / revoke races with exactly-once transactional audit; malformed
 * documents; revocation and rotation; the principal and management guard end to end against stored records.
 */
import { randomBytes } from "node:crypto";
import type { Firestore } from "firebase-admin/firestore";
import { adaptAdminFirestore } from "@/lib/apiPlatform/__tests__/helpers/adminFirestoreAdapter";
import { createApiKey, createApplication, createOrganization, revokeApiKey, rotateApiKey, type StoreContext } from "@/lib/apiPlatform/store";
import { requireApiPrincipal, type PrincipalDeps } from "@/lib/apiPlatform/principal";
import { authorizeOrgManagement } from "@/lib/apiPlatform/management";
import { computeApiOrgMembershipId } from "@/lib/apiPlatform/tenantPaths";
import type { PepperSet } from "@/lib/apiPlatform/keys";
import type { FirestoreLike } from "@/lib/apiPlatform/firestorePort";

jest.mock("@/lib/apiPlatform/apiPlans", () => ({ isApprovedApiPlanId: (id: unknown) => id === "beta_capped_v1", API_PLANS: [] }));

const EMULATOR = process.env.FIRESTORE_EMULATOR_HOST;
const PROJECT = "demo-api1a";
const maybe = EMULATOR ? describe : describe.skip;
const peppers: PepperSet = { status: "available", current: randomBytes(32), previous: null };
const NOW = 1_800_000_000_000;
const SESSION_NOW = Math.floor(NOW / 1000);

let admin: Firestore;
let db: FirestoreLike;

const ctx = (uid = "uid_owner"): StoreContext => ({ db, actorUid: uid, requestId: "req_emu", now: NOW });
const read = async (p: string) => {
  const s = await admin.doc(p).get();
  return s.exists ? (s.data() as Record<string, unknown>) : null;
};
const deps = (now = NOW): PrincipalDeps => ({
  peppers: () => peppers,
  getKey: (id) => read(`apiKeys/${id}`),
  getOrg: (id) => read(`apiOrganizations/${id}`),
  getApp: (id) => read(`apiApplications/${id}`),
  now: () => now,
});
const auth = (secret: string) => new Headers({ authorization: `Bearer ${secret}` });
async function audits(eventType?: string) {
  const snap = await admin.collection("apiAuditEvents").get();
  return snap.docs.map((d) => d.data()).filter((r) => !eventType || r.eventType === eventType);
}
async function orgWithApp(uid = "uid_owner") {
  const o = await createOrganization(ctx(uid), { name: "Acme" });
  if (!o.ok) throw new Error("org");
  const a = await createApplication(ctx(uid), { orgId: o.value.orgId, name: "App" });
  if (!a.ok) throw new Error("app");
  return { orgId: o.value.orgId, appId: a.value.appId };
}
async function testKey(orgId: string, appId: string, uid = "uid_owner", over: Record<string, unknown> = {}) {
  const k = await createApiKey(ctx(uid), { actorRole: "owner", orgId, appId, mode: "test", ...over } as never, peppers);
  if (!k.ok) throw new Error(JSON.stringify(k));
  return k.value;
}

maybe("REAL Firestore (emulator): API-1a store, principal and management", () => {
  beforeAll(() => {
    const { initializeApp, getApps } = jest.requireActual("firebase-admin/app");
    const { getFirestore } = jest.requireActual("firebase-admin/firestore");
    const app = getApps().find((a: { name: string }) => a.name === "api1a-emulator") ?? initializeApp({ projectId: PROJECT }, "api1a-emulator");
    admin = getFirestore(app);
    db = adaptAdminFirestore(admin);
  });

  beforeEach(async () => {
    await fetch(`http://${EMULATOR}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, { method: "DELETE" });
  }, 30_000);

  it("org/app/key lifecycle: create → authenticate → rotate → old expires → revoke successor", async () => {
    const { orgId, appId } = await orgWithApp();
    expect(await read(`apiOrgMemberships/${computeApiOrgMembershipId(orgId, "uid_owner")}`)).toMatchObject({ orgId, uid: "uid_owner", role: "owner", status: "active", addedBy: "uid_owner", inviteId: null });
    const k = await testKey(orgId, appId);
    const ok = await requireApiPrincipal(auth(k.displaySecret), "verifications:read", deps());
    expect(ok.ok && ok.principal.orgId === orgId && ok.principal.appId === appId).toBe(true);

    const rot = await rotateApiKey(ctx(), { actorRole: "owner", orgId, keyId: k.keyId, overlapSeconds: 60 }, peppers);
    if (!rot.ok) throw new Error();
    expect(await read(`apiKeys/${k.keyId}`)).toMatchObject({ rotatedTo: rot.value.keyId, expiresAt: NOW + 60_000, revokedAt: null });
    expect((await requireApiPrincipal(auth(k.displaySecret), "verifications:read", deps())).ok).toBe(true);
    expect(await requireApiPrincipal(auth(k.displaySecret), "verifications:read", deps(NOW + 60_000))).toEqual({ ok: false, code: "invalid_api_key" });
    expect((await requireApiPrincipal(auth(rot.value.displaySecret), "verifications:read", deps(NOW + 60_000))).ok).toBe(true);

    expect((await revokeApiKey(ctx(), { actorRole: "owner", orgId, keyId: rot.value.keyId })).ok).toBe(true);
    expect(await requireApiPrincipal(auth(rot.value.displaySecret), "verifications:read", deps())).toEqual({ ok: false, code: "invalid_api_key" });
    expect((await audits()).map((a) => a.eventType).sort()).toEqual(["api_key.created", "api_key.revoked", "api_key.rotated", "app.created", "member.added", "org.created"]);
  }, 60_000);

  it("rotation with overlap 0 revokes the old key immediately", async () => {
    const { orgId, appId } = await orgWithApp();
    const k = await testKey(orgId, appId);
    const rot = await rotateApiKey(ctx(), { actorRole: "owner", orgId, keyId: k.keyId, overlapSeconds: 0 }, peppers);
    if (!rot.ok) throw new Error();
    expect(await read(`apiKeys/${k.keyId}`)).toMatchObject({ revokedAt: NOW, revokedBy: "uid_owner", rotatedTo: rot.value.keyId });
    expect(await requireApiPrincipal(auth(k.displaySecret), "verifications:read", deps())).toEqual({ ok: false, code: "invalid_api_key" });
  }, 60_000);

  it("a live key is refused until the org has an active approved plan; then accepted", async () => {
    const { orgId, appId } = await orgWithApp();
    const k = await testKey(orgId, appId, "uid_owner", { mode: "live" });
    expect(await requireApiPrincipal(auth(k.displaySecret), "verifications:read", deps())).toEqual({ ok: false, code: "live_key_requires_plan" });
    await admin.doc(`apiOrganizations/${orgId}`).update({ plan: { planId: "beta_capped_v1", status: "active" } });
    expect((await requireApiPrincipal(auth(k.displaySecret), "verifications:read", deps())).ok).toBe(true);
  }, 60_000);

  describe("cross-org isolation", () => {
    it("org A cannot mint a key for org B's app, nor revoke/rotate B's key; nothing changes", async () => {
      const a = await orgWithApp("uid_a");
      const b = await orgWithApp("uid_b");
      const kb = await testKey(b.orgId, b.appId, "uid_b");
      const before = (await admin.collection("apiKeys").get()).size;
      expect(await createApiKey(ctx("uid_a"), { actorRole: "owner", orgId: a.orgId, appId: b.appId, mode: "test" }, peppers)).toEqual({ ok: false, reason: "not_found" });
      expect(await revokeApiKey(ctx("uid_a"), { actorRole: "owner", orgId: a.orgId, keyId: kb.keyId })).toEqual({ ok: false, reason: "not_found" });
      expect(await rotateApiKey(ctx("uid_a"), { actorRole: "owner", orgId: a.orgId, keyId: kb.keyId, overlapSeconds: 0 }, peppers)).toEqual({ ok: false, reason: "not_found" });
      expect((await admin.collection("apiKeys").get()).size).toBe(before);
      expect(await read(`apiKeys/${kb.keyId}`)).toMatchObject({ revokedAt: null, rotatedTo: null });
      expect((await requireApiPrincipal(auth(kb.displaySecret), "verifications:read", deps())).ok).toBe(true);
    }, 60_000);

    it("a key of org A cannot resolve org B's app; forged key bindings fail", async () => {
      const a = await orgWithApp("uid_a");
      const b = await orgWithApp("uid_b");
      const ka = await testKey(a.orgId, a.appId, "uid_a");
      await admin.doc(`apiKeys/${ka.keyId}`).update({ appId: b.appId });
      expect(await requireApiPrincipal(auth(ka.displaySecret), "verifications:read", deps())).toEqual({ ok: false, code: "invalid_api_key" });
      await admin.doc(`apiKeys/${ka.keyId}`).update({ appId: a.appId, orgId: b.orgId });
      expect(await requireApiPrincipal(auth(ka.displaySecret), "verifications:read", deps())).toEqual({ ok: false, code: "invalid_api_key" });
      // A forged app record claiming org B for A's app, with the key pointing at B: the org/app pair must agree.
      await admin.doc(`apiKeys/${ka.keyId}`).update({ appId: a.appId, orgId: a.orgId });
      await admin.doc(`apiApplications/${a.appId}`).update({ orgId: b.orgId });
      expect(await requireApiPrincipal(auth(ka.displaySecret), "verifications:read", deps())).toEqual({ ok: false, code: "invalid_api_key" });
    }, 60_000);

    it("a membership record of org A does not authorize org B; a forged uid binding fails", async () => {
      const a = await orgWithApp("uid_a");
      const b = await orgWithApp("uid_b");
      const ok = { uid: "uid_a", authTimeSeconds: SESSION_NOW - 60, emailVerified: true, disabled: false };
      const getMembership = (id: string) => read(`apiOrgMemberships/${id}`);
      const d = { getMembership, nowSeconds: () => SESSION_NOW };
      expect(await authorizeOrgManagement(new Headers(), ok, a.orgId, "keys.live.create", d)).toEqual({ ok: true, uid: "uid_a", orgId: a.orgId, role: "owner" });
      expect(await authorizeOrgManagement(new Headers(), ok, b.orgId, "usage.view", d)).toEqual({ ok: false, code: "not_found" });
      // Copy B's owner membership to the id A would compute for B: the stored uid/orgId binding still refuses it.
      const bOwner = await read(`apiOrgMemberships/${computeApiOrgMembershipId(b.orgId, "uid_b")}`);
      await admin.doc(`apiOrgMemberships/${computeApiOrgMembershipId(b.orgId, "uid_a")}`).set(bOwner!);
      expect(await authorizeOrgManagement(new Headers(), ok, b.orgId, "usage.view", d)).toEqual({ ok: false, code: "not_found" });
      // Removing A's membership removes A's authority on the next request (no cache).
      await admin.doc(`apiOrgMemberships/${computeApiOrgMembershipId(a.orgId, "uid_a")}`).update({ status: "removed" });
      expect(await authorizeOrgManagement(new Headers(), ok, a.orgId, "usage.view", d)).toEqual({ ok: false, code: "not_found" });
      // Unverified / disabled identities are refused before any stored record matters.
      expect(await authorizeOrgManagement(new Headers(), { ...ok, emailVerified: false }, b.orgId, "usage.view", d)).toEqual({ ok: false, code: "identity_not_verified" });
      expect(await authorizeOrgManagement(new Headers(), { ...ok, disabled: true }, b.orgId, "usage.view", d)).toEqual({ ok: false, code: "session_required" });
    }, 60_000);
  });

  describe("races with transactional exactly-once audit", () => {
    it("20 parallel rotations of one key → exactly one succeeds, one successor, ONE rotated audit row", async () => {
      const { orgId, appId } = await orgWithApp();
      const k = await testKey(orgId, appId);
      const settled = await Promise.allSettled(
        Array.from({ length: 20 }, () => rotateApiKey(ctx(), { actorRole: "owner", orgId, keyId: k.keyId, overlapSeconds: 3600 }, peppers)),
      );
      const ok = settled.filter((s) => s.status === "fulfilled" && s.value.ok);
      const refused = settled.filter((s) => s.status === "fulfilled" && !s.value.ok);
      for (const s of refused) expect((s as PromiseFulfilledResult<{ ok: false; reason: string }>).value.reason).toBe("already_rotated");
      expect(ok).toHaveLength(1);
      const winner = (ok[0] as PromiseFulfilledResult<{ ok: true; value: { keyId: string } }>).value.value.keyId;
      expect((await admin.collection("apiKeys").get()).size).toBe(2);
      expect(await read(`apiKeys/${k.keyId}`)).toMatchObject({ rotatedTo: winner });
      expect(await audits("api_key.rotated")).toHaveLength(1);
      expect((await audits("api_key.rotated"))[0].target).toMatchObject({ replacedCredentialPrefix: k.prefix });
    }, 120_000);

    it("20 parallel revocations → exactly one succeeds, ONE revoked audit row", async () => {
      const { orgId, appId } = await orgWithApp();
      const k = await testKey(orgId, appId);
      const settled = await Promise.allSettled(Array.from({ length: 20 }, () => revokeApiKey(ctx(), { actorRole: "owner", orgId, keyId: k.keyId })));
      const values = settled.filter((s) => s.status === "fulfilled").map((s) => (s as PromiseFulfilledResult<{ ok: boolean; reason?: string }>).value);
      expect(values.filter((v) => v.ok)).toHaveLength(1);
      for (const v of values.filter((x) => !x.ok)) expect(v.reason).toBe("already_revoked");
      expect(await audits("api_key.revoked")).toHaveLength(1);
    }, 120_000);

    it("rotate vs revoke race on one key: one outcome wins, audit rows match the committed state", async () => {
      const { orgId, appId } = await orgWithApp();
      const k = await testKey(orgId, appId);
      const ops = Array.from({ length: 10 }, (_, i) => (i % 2 === 0
        ? rotateApiKey(ctx(), { actorRole: "owner", orgId, keyId: k.keyId, overlapSeconds: 3600 }, peppers)
        : revokeApiKey(ctx(), { actorRole: "owner", orgId, keyId: k.keyId })));
      await Promise.allSettled(ops);
      const rec = (await read(`apiKeys/${k.keyId}`))!;
      const rotated = await audits("api_key.rotated");
      const revoked = await audits("api_key.revoked");
      expect(rotated.length).toBe(rec.rotatedTo === null ? 0 : 1);
      // overlap 3600: a rotation never sets revokedAt, so revokedAt is set iff exactly one revoke committed.
      expect(revoked.length).toBe(rec.revokedAt === null ? 0 : 1);
      expect(rotated.length + revoked.length).toBeGreaterThanOrEqual(1);
      expect((await admin.collection("apiKeys").get()).size).toBe(1 + rotated.length);
    }, 120_000);

    it("20 parallel key creations → 20 distinct keys and exactly 20 created audit rows", async () => {
      const { orgId, appId } = await orgWithApp();
      const rs = await Promise.all(Array.from({ length: 20 }, () => createApiKey(ctx(), { actorRole: "owner", orgId, appId, mode: "test" }, peppers)));
      expect(rs.every((r) => r.ok)).toBe(true);
      expect(new Set(rs.map((r) => (r.ok ? r.value.keyId : ""))).size).toBe(20);
      expect((await admin.collection("apiKeys").get()).size).toBe(20);
      expect(await audits("api_key.created")).toHaveLength(20);
    }, 120_000);

    it("a key created while the org is being suspended is either refused or created with its audit row, never half-written", async () => {
      const { orgId, appId } = await orgWithApp();
      const [r] = await Promise.all([
        createApiKey(ctx(), { actorRole: "owner", orgId, appId, mode: "test" }, peppers),
        admin.doc(`apiOrganizations/${orgId}`).update({ status: "suspended" }),
      ]);
      const keys = (await admin.collection("apiKeys").get()).size;
      expect(keys).toBe(r.ok ? 1 : 0);
      expect(await audits("api_key.created")).toHaveLength(keys);
      if (!r.ok) expect(r.reason).toBe("org_not_active");
    }, 60_000);
  });

  describe("malformed stored documents fail closed", () => {
    const CASES: [string, Record<string, unknown>][] = [
      ["scopes is a string", { scopes: "verifications:read" }],
      ["revokedAt deleted", { revokedAt: null, __delete: "revokedAt" }],
      ["expiresAt is a string", { expiresAt: "2099-01-01" }],
      ["hash deleted", { __delete: "hash" }],
      ["hashVersion 2", { hashVersion: 2 }],
      ["appScoped is a string", { appScoped: "yes" }],
      ["mode differs", { mode: "live" }],
      ["orgId is a number", { orgId: 5 }],
    ];
    it.each(CASES)("key with %s → invalid_api_key", async (_n, patch) => {
      const { orgId, appId } = await orgWithApp();
      const k = await testKey(orgId, appId);
      const { __delete, ...fields } = patch as Record<string, unknown> & { __delete?: string };
      const { FieldValue } = jest.requireActual("firebase-admin/firestore");
      await admin.doc(`apiKeys/${k.keyId}`).update({ ...fields, ...(__delete ? { [__delete]: FieldValue.delete() } : {}) });
      expect(await requireApiPrincipal(auth(k.displaySecret), "verifications:read", deps())).toEqual({ ok: false, code: "invalid_api_key" });
    }, 60_000);

    it("org without status, missing app, or org/app docs deleted → invalid_api_key", async () => {
      const { orgId, appId } = await orgWithApp();
      const k = await testKey(orgId, appId);
      const { FieldValue } = jest.requireActual("firebase-admin/firestore");
      await admin.doc(`apiOrganizations/${orgId}`).update({ status: FieldValue.delete() });
      expect(await requireApiPrincipal(auth(k.displaySecret), "verifications:read", deps())).toEqual({ ok: false, code: "invalid_api_key" });
      await admin.doc(`apiOrganizations/${orgId}`).update({ status: "active" });
      await admin.doc(`apiApplications/${appId}`).delete();
      expect(await requireApiPrincipal(auth(k.displaySecret), "verifications:read", deps())).toEqual({ ok: false, code: "invalid_api_key" });
    }, 60_000);

    it("rotating a key whose stored mode/scopes are malformed is invalid_input and writes nothing", async () => {
      const { orgId, appId } = await orgWithApp();
      const k = await testKey(orgId, appId);
      await admin.doc(`apiKeys/${k.keyId}`).update({ mode: "prod" });
      const auditsBefore = (await audits()).length;
      expect(await rotateApiKey(ctx(), { actorRole: "owner", orgId, keyId: k.keyId, overlapSeconds: 0 }, peppers)).toEqual({ ok: false, reason: "invalid_input" });
      expect((await admin.collection("apiKeys").get()).size).toBe(1);
      expect((await audits()).length).toBe(auditsBefore);
    }, 60_000);

    it("a malformed membership document (role unknown, status missing) authorizes nothing", async () => {
      const { orgId } = await orgWithApp();
      const id = computeApiOrgMembershipId(orgId, "uid_owner");
      const ident = { uid: "uid_owner", authTimeSeconds: SESSION_NOW - 60, emailVerified: true, disabled: false };
      const d = { getMembership: (m: string) => read(`apiOrgMemberships/${m}`), nowSeconds: () => SESSION_NOW };
      await admin.doc(`apiOrgMemberships/${id}`).update({ role: "superuser" });
      expect(await authorizeOrgManagement(new Headers(), ident, orgId, "usage.view", d)).toEqual({ ok: false, code: "insufficient_role" });
      const { FieldValue } = jest.requireActual("firebase-admin/firestore");
      await admin.doc(`apiOrgMemberships/${id}`).update({ role: "owner", status: FieldValue.delete() });
      expect(await authorizeOrgManagement(new Headers(), ident, orgId, "usage.view", d)).toEqual({ ok: false, code: "not_found" });
    }, 60_000);
  });
});
