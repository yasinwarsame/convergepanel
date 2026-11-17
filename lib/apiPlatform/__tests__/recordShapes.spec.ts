/**
 * D-1: stored-record field names are pinned, so doc/code drift fails a test.
 * Names follow tenancy-and-auth.md §6 (audit) and §7 (collections); intentional extras and differences are
 * listed in docs/product/api-0/api-1a-contract-reconciliation.md. Changing a field here is a reviewed change
 * to that file AND the doc.
 */
import { randomBytes } from "node:crypto";
import { FakeFirestore } from "@/lib/apiPlatform/__tests__/helpers/fakeFirestore";
import { createApiKey, createApplication, createOrganization, revokeApiKey, rotateApiKey, type StoreContext } from "@/lib/apiPlatform/store";
import type { PepperSet } from "@/lib/apiPlatform/keys";

const peppers: PepperSet = { status: "available", current: randomBytes(32), previous: null };
const NOW = 1_800_000_000_000;

const PINNED_FIELDS = Object.freeze({
  organization: ["createdAt", "createdBy", "name", "orgId", "plan", "status"],
  membership: ["addedAt", "addedBy", "inviteId", "membershipId", "orgId", "role", "status", "uid"],
  application: ["appId", "createdAt", "createdBy", "name", "orgId", "status"],
  key: ["appId", "appScoped", "createdAt", "createdBy", "expiresAt", "hash", "hashVersion", "keyId", "mode", "orgId", "prefix", "revokedAt", "revokedBy", "rotatedTo", "scopes"],
  audit: ["actor", "auditId", "createdAt", "eventType", "orgId", "requestId", "target"],
});
const LEGACY = ["verifier", "apiPlan", "subject", "type", "at"];

async function populate() {
  const db = new FakeFirestore();
  const ctx: StoreContext = { db, actorUid: "uid_owner", requestId: "req_shape", now: NOW };
  const o = await createOrganization(ctx, { name: "Acme" });
  if (!o.ok) throw new Error();
  const a = await createApplication(ctx, { orgId: o.value.orgId, name: "App" });
  if (!a.ok) throw new Error();
  const k1 = await createApiKey(ctx, { actorRole: "owner", orgId: o.value.orgId, appId: a.value.appId, mode: "test" }, peppers);
  const k2 = await createApiKey(ctx, { actorRole: "owner", orgId: o.value.orgId, appId: a.value.appId, mode: "test" }, peppers);
  if (!k1.ok || !k2.ok) throw new Error();
  if (!(await revokeApiKey(ctx, { actorRole: "owner", orgId: o.value.orgId, keyId: k1.value.keyId })).ok) throw new Error();
  if (!(await rotateApiKey(ctx, { actorRole: "owner", orgId: o.value.orgId, keyId: k2.value.keyId, overlapSeconds: 60 }, peppers)).ok) throw new Error();
  const of = (prefix: string) => db.byPrefix(prefix).map(([, v]) => v);
  return {
    orgId: o.value.orgId,
    organization: of("apiOrganizations/"),
    membership: of("apiOrgMemberships/"),
    application: of("apiApplications/"),
    key: of("apiKeys/"),
    audit: of("apiAuditEvents/"),
  };
}

describe("stored field names (D-1 pin)", () => {
  it.each(Object.keys(PINNED_FIELDS) as (keyof typeof PINNED_FIELDS)[])("%s documents have exactly the pinned fields", async (kind) => {
    const r = await populate();
    expect(r[kind].length).toBeGreaterThan(0);
    for (const doc of r[kind]) expect(Object.keys(doc).sort()).toEqual([...PINNED_FIELDS[kind]].sort());
  });

  it("no legacy (pre-reconciliation) field name is written anywhere", async () => {
    const r = await populate();
    for (const kind of Object.keys(PINNED_FIELDS) as (keyof typeof PINNED_FIELDS)[]) {
      for (const doc of r[kind]) for (const legacy of LEGACY) expect([kind, legacy, legacy in doc]).toEqual([kind, legacy, false]);
    }
  });

  it("audit rows: §6 actor shape, identifier-only targets, every lifecycle event", async () => {
    const r = await populate();
    expect(r.audit.map((a) => a.eventType).sort()).toEqual(["api_key.created", "api_key.created", "api_key.revoked", "api_key.rotated", "app.created", "member.added", "org.created"]);
    const TARGET_KEYS = new Set(["appId", "credentialPrefix", "replacedCredentialPrefix", "membershipRole"]);
    for (const a of r.audit) {
      expect(a.actor).toEqual({ kind: "user", uid: "uid_owner" });
      expect(a).toMatchObject({ orgId: r.orgId, requestId: "req_shape", createdAt: NOW });
      for (const k of Object.keys(a.target as object)) expect(TARGET_KEYS.has(k)).toBe(true);
      for (const v of Object.values(a.target as object)) expect(typeof v).toBe("string");
    }
  });

  it("organization `plan` is null at creation; key hash is 64-hex with hashVersion 1; membership founding owner", async () => {
    const r = await populate();
    expect(r.organization[0]).toMatchObject({ plan: null, status: "active" });
    for (const k of r.key) expect(k).toMatchObject({ hash: expect.stringMatching(/^[0-9a-f]{64}$/), hashVersion: 1 });
    expect(r.membership[0]).toMatchObject({ role: "owner", status: "active", addedBy: "uid_owner", addedAt: NOW, inviteId: null });
  });
});
