/**
 * requireApiPrincipal: full denial matrix, tenant derivation from the key record only, uniform
 * invalid_api_key, fail closed, no admin/Firebase involvement.
 */
import { randomBytes } from "node:crypto";
import { mintApiKey, type PepperSet } from "@/lib/apiPlatform/keys";
import { requireApiPrincipal, type PrincipalDeps } from "@/lib/apiPlatform/principal";
import { newAppId, newOrgId } from "@/lib/apiPlatform/ids";
import * as secrets from "@/lib/apiPlatform/secrets.server";

jest.mock("@/lib/apiPlatform/apiPlans", () => ({ isApprovedApiPlanId: (id: unknown) => id === "beta_capped_v1", API_PLANS: [] }));

const NOW = 1_800_000_000_000;
const peppers: PepperSet = { status: "available", current: randomBytes(32), previous: null };

function fixture(over: { key?: Record<string, unknown>; org?: Record<string, unknown>; app?: Record<string, unknown>; mode?: "live" | "test" } = {}) {
  const mode = over.mode ?? "live";
  const m = mintApiKey(mode, peppers);
  if (!m.ok) throw new Error();
  const orgId = newOrgId();
  const appId = newAppId();
  const key: Record<string, unknown> = {
    keyId: m.key.keyId, orgId, appId, mode, scopes: ["verifications:read", "verifications:write", "models:read"],
    appScoped: true, verifier: m.key.verifier, hashVersion: 1, prefix: m.key.prefix,
    expiresAt: null, revokedAt: null, ...over.key,
  };
  const org: Record<string, unknown> = { orgId, status: "active", apiPlan: { planId: "beta_capped_v1", status: "active" }, ...over.org };
  const app: Record<string, unknown> = { appId, orgId, status: "active", ...over.app };
  const calls: string[] = [];
  const deps: PrincipalDeps = {
    peppers: () => peppers,
    getKey: async (id) => (calls.push(`key:${id}`), id === key.keyId ? key : null),
    getOrg: async (id) => (calls.push(`org:${id}`), id === orgId ? org : null),
    getApp: async (id) => (calls.push(`app:${id}`), id === appId ? app : null),
    now: () => NOW,
  };
  const headers = (extra: Record<string, string> = {}) => new Headers({ authorization: `Bearer ${m.key.displaySecret}`, ...extra });
  return { m, orgId, appId, key, org, app, deps, headers, calls };
}

describe("requireApiPrincipal", () => {
  it("authenticates a valid key and derives org/app/mode from the KEY RECORD", async () => {
    const f = fixture();
    const d = await requireApiPrincipal(f.headers(), "verifications:read", f.deps);
    expect(d).toEqual({
      ok: true,
      principal: {
        kind: "api_key", orgId: f.orgId, appId: f.appId, keyId: f.m.key.keyId, credentialPrefix: f.m.key.prefix,
        mode: "live", scopes: ["verifications:read", "verifications:write", "models:read"], appScoped: true,
      },
    });
    expect(Object.isFrozen((d as { principal: object }).principal)).toBe(true);
  });

  it("ignores client-supplied tenant headers and cookies", async () => {
    const f = fixture();
    const d = await requireApiPrincipal(
      f.headers({ "x-org-id": newOrgId(), "x-app-id": newAppId(), cookie: "__session=forged" }),
      "verifications:read",
      f.deps,
    );
    expect(d.ok && d.principal.orgId === f.orgId && d.principal.appId === f.appId).toBe(true);
    expect(f.calls).toEqual([`key:${f.m.key.keyId}`, `org:${f.orgId}`, `app:${f.appId}`]);
  });

  it("a cookie alone authenticates nothing", async () => {
    const f = fixture();
    expect(await requireApiPrincipal(new Headers({ cookie: "__session=abc" }), "verifications:read", f.deps)).toEqual({ ok: false, code: "invalid_api_key" });
  });

  const INVALID: [string, (f: ReturnType<typeof fixture>) => Headers | void][] = [
    ["no header", () => new Headers()],
    ["Basic scheme", (f) => new Headers({ authorization: `Basic ${f.m.key.displaySecret}` })],
    ["lowercase bearer", (f) => new Headers({ authorization: `bearer ${f.m.key.displaySecret}` })],
    ["trailing junk", (f) => new Headers({ authorization: `Bearer ${f.m.key.displaySecret} x` })],
    ["Firebase-looking JWT", () => new Headers({ authorization: "Bearer eyJhbGciOiJSUzI1NiJ9.e30.sig" })],
    ["wrong secret", (f) => new Headers({ authorization: `Bearer ${f.m.key.prefix}_${"A".repeat(43)}` })],
    ["unknown keyId", (f) => new Headers({ authorization: `Bearer cpk_live_ZZZZZZZZZZZZ_${f.m.key.displaySecret.slice(-43)}` })],
    ["mode flipped in presented key", (f) => new Headers({ authorization: `Bearer ${f.m.key.displaySecret.replace("cpk_live_", "cpk_test_")}` })],
  ];
  it.each(INVALID)("%s → invalid_api_key", async (_n, h) => {
    const f = fixture();
    expect(await requireApiPrincipal(h(f) as Headers, "verifications:read", f.deps)).toEqual({ ok: false, code: "invalid_api_key" });
  });

  const RECORD_DENIALS: [string, Parameters<typeof fixture>[0], string][] = [
    ["revoked", { key: { revokedAt: NOW - 1 } }, "invalid_api_key"],
    ["revokedAt missing (malformed)", { key: { revokedAt: undefined } }, "invalid_api_key"],
    ["expired", { key: { expiresAt: NOW } }, "invalid_api_key"],
    ["expiresAt malformed", { key: { expiresAt: "2099" } }, "invalid_api_key"],
    ["record mode differs", { key: { mode: "test" } }, "invalid_api_key"],
    ["record keyId differs", { key: { keyId: "AAAAAAAAAAAA" } }, "invalid_api_key"],
    ["scopes malformed", { key: { scopes: "verifications:read" } }, "invalid_api_key"],
    ["appScoped malformed", { key: { appScoped: "yes" } }, "invalid_api_key"],
    ["org canceled", { org: { status: "canceled" } }, "invalid_api_key"],
    ["org unknown status", { org: { status: "trial" } }, "invalid_api_key"],
    ["org record of another org", { org: { orgId: "org_AAAAAAAAAAAAAAAAAAAA" } }, "invalid_api_key"],
    ["app disabled", { app: { status: "disabled" } }, "invalid_api_key"],
    ["app belongs to another org", { app: { orgId: "org_AAAAAAAAAAAAAAAAAAAA" } }, "invalid_api_key"],
    ["org suspended", { org: { status: "suspended" } }, "org_suspended"],
    ["live key, no plan", { org: { apiPlan: null } }, "live_key_requires_plan"],
    ["live key, approved plan id but inactive", { org: { apiPlan: { planId: "beta_capped_v1", status: "inactive" } } }, "live_key_requires_plan"],
    ["live key, plan without id", { org: { apiPlan: { planId: "", status: "active" } } }, "live_key_requires_plan"],
    ["live key, plan not in the compile-time list", { org: { apiPlan: { planId: "enterprise_unlimited", status: "active" } } }, "live_key_requires_plan"],
    ["disabled app in a suspended org (401 before any 403)", { app: { status: "disabled" }, org: { status: "suspended" } }, "invalid_api_key"],
  ];
  it.each(RECORD_DENIALS)("%s → %s", async (_n, over, code) => {
    const f = fixture(over);
    expect(await requireApiPrincipal(f.headers(), "verifications:read", f.deps)).toEqual({ ok: false, code });
  });

  it("test key does not need a plan; suspension still applies", async () => {
    const f = fixture({ mode: "test", org: { apiPlan: null } });
    expect((await requireApiPrincipal(f.headers(), "verifications:read", f.deps)).ok).toBe(true);
    const g = fixture({ mode: "test", org: { apiPlan: null, status: "suspended" } });
    expect(await requireApiPrincipal(g.headers(), "verifications:read", g.deps)).toEqual({ ok: false, code: "org_suspended" });
  });

  it("revoked key never reveals org state (suspended org + revoked key → invalid_api_key)", async () => {
    const f = fixture({ key: { revokedAt: 1 }, org: { status: "suspended" } });
    expect(await requireApiPrincipal(f.headers(), "verifications:read", f.deps)).toEqual({ ok: false, code: "invalid_api_key" });
  });

  it("scope: missing scope → insufficient_scope; unknown stored scopes ignored", async () => {
    const f = fixture({ key: { scopes: ["models:read", "admin:all"] } });
    expect(await requireApiPrincipal(f.headers(), "verifications:write", f.deps)).toEqual({ ok: false, code: "insufficient_scope" });
    const ok = await requireApiPrincipal(f.headers(), "models:read", f.deps);
    expect(ok.ok && ok.principal.scopes).toEqual(["models:read"]);
  });

  it("an unknown required scope fails closed", async () => {
    const f = fixture();
    expect(await requireApiPrincipal(f.headers(), "admin:all" as never, f.deps)).toEqual({ ok: false, code: "api_unavailable" });
  });

  it("peppers unavailable → api_unavailable before any lookup", async () => {
    const f = fixture();
    const deps = { ...f.deps, peppers: (): PepperSet => ({ status: "unavailable", reason: "missing" }) };
    expect(await requireApiPrincipal(f.headers(), "verifications:read", deps)).toEqual({ ok: false, code: "api_unavailable" });
    expect(f.calls).toEqual([]);
  });

  it.each(["getKey", "getOrg", "getApp"] as const)("%s throwing → api_unavailable (fail closed)", async (which) => {
    const f = fixture();
    const deps = { ...f.deps, [which]: async () => { throw new Error("firestore down"); } };
    expect(await requireApiPrincipal(f.headers(), "verifications:read", deps)).toEqual({ ok: false, code: "api_unavailable" });
  });

  it("a stored record whose keyId differs from the presented key is refused even if its verifier matches", async () => {
    const f = fixture();
    const deps = { ...f.deps, getKey: async () => ({ ...f.key, keyId: "AAAAAAAAAAAA" }) };
    expect(await requireApiPrincipal(f.headers(), "verifications:read", deps)).toEqual({ ok: false, code: "invalid_api_key" });
  });

  describe("equal work on every rejection path (timing)", () => {
    afterEach(() => jest.restoreAllMocks());
    async function hmacs(headers: Headers, deps: PrincipalDeps): Promise<number> {
      const spy = jest.spyOn(secrets, "hmacWith");
      await requireApiPrincipal(headers, "verifications:read", deps);
      const n = spy.mock.calls.length;
      spy.mockRestore();
      return n;
    }
    it("unknown key, wrong secret and valid key cost the same number of HMACs (1 pepper)", async () => {
      const f = fixture();
      const ok = await hmacs(f.headers(), f.deps);
      const wrong = await hmacs(new Headers({ authorization: `Bearer ${f.m.key.prefix}_${"A".repeat(43)}` }), f.deps);
      const missing = await hmacs(new Headers({ authorization: `Bearer cpk_live_ZZZZZZZZZZZZ_${"A".repeat(43)}` }), f.deps);
      expect(ok).toBe(1);
      expect([wrong, missing]).toEqual([1, 1]);
    });
    it("with a previous pepper, both peppers are always computed (2 HMACs on every path)", async () => {
      const f = fixture();
      const rot: PepperSet = { status: "available", current: (peppers as { current: Buffer }).current, previous: randomBytes(32) };
      const deps = { ...f.deps, peppers: () => rot };
      expect(await hmacs(f.headers(), deps)).toBe(2);
      expect(await hmacs(new Headers({ authorization: `Bearer cpk_live_ZZZZZZZZZZZZ_${"A".repeat(43)}` }), deps)).toBe(2);
      expect(await hmacs(new Headers({ authorization: `Bearer ${f.m.key.prefix}_${"A".repeat(43)}` }), deps)).toBe(2);
    });
  });

  it("revocation takes effect on the very next call (no cache)", async () => {
    const f = fixture();
    expect((await requireApiPrincipal(f.headers(), "verifications:read", f.deps)).ok).toBe(true);
    f.key.revokedAt = NOW;
    expect(await requireApiPrincipal(f.headers(), "verifications:read", f.deps)).toEqual({ ok: false, code: "invalid_api_key" });
  });
});
