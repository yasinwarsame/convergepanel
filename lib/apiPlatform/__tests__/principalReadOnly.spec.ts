/**
 * Owner ruling R-7 (approved credential rotation policy): API-key AUTHENTICATION IS READ-ONLY.
 * - no write of any kind on the principal / verify path (no lazy rehash, no lastUsedAt, no counters);
 * - a key hashed under the previous pepper verifies only while that pepper is configured, and is never rewritten;
 * - a missing or malformed pepper makes authentication unavailable (503), never a bypass.
 *
 * Each guarantee is falsifiable: the deps object is a Proxy that records every member touched (a mutant calling
 * any writer hook is caught), every stored record is deep-frozen (a mutant mutating a record throws and the
 * authentication fails), the full store is compared before/after, and the import/source scan has positive controls.
 * See docs/product/api-0/api-key-pepper-rotation.md.
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { mintApiKey, type PepperSet } from "@/lib/apiPlatform/keys";
import { requireApiPrincipal, type PrincipalDeps } from "@/lib/apiPlatform/principal";
import { MIN_PEPPER_BYTES, readApiKeyPeppers } from "@/lib/apiPlatform/secrets.server";
import { createApiKey, createApplication, createOrganization, revokeApiKey, rotateApiKey, type StoreContext } from "@/lib/apiPlatform/store";
import { FakeFirestore } from "@/lib/apiPlatform/__tests__/helpers/fakeFirestore";
import { newAppId, newOrgId } from "@/lib/apiPlatform/ids";

jest.mock("@/lib/apiPlatform/apiPlans", () => ({ isApprovedApiPlanId: (id: unknown) => id === "beta_capped_v1", API_PLANS: [] }));

const NOW = 1_800_000_000_000;
const ROOT = path.resolve(__dirname, "../../..");
const b64 = (n: number) => randomBytes(n).toString("base64url");

function deepFreeze<T>(o: T): T {
  if (typeof o === "object" && o !== null && !Object.isFrozen(o)) {
    Object.freeze(o);
    for (const v of Object.values(o as Record<string, unknown>)) deepFreeze(v);
  }
  return o;
}

const ALLOWED_DEPS = ["getApp", "getKey", "getOrg", "now", "peppers"];

/** Wraps deps so that EVERY member access is recorded; also refuses defineProperty/set/delete on the object. */
function recording(deps: PrincipalDeps) {
  const touched = new Set<string>();
  const mutations: string[] = [];
  const proxy = new Proxy(deps as unknown as Record<string | symbol, unknown>, {
    get(t, p, r) {
      touched.add(String(p));
      return Reflect.get(t, p, r);
    },
    has(t, p) {
      touched.add(String(p));
      return Reflect.has(t, p);
    },
    set(_t, p) { mutations.push(`set:${String(p)}`); return true; },
    deleteProperty(_t, p) { mutations.push(`delete:${String(p)}`); return true; },
    defineProperty(_t, p) { mutations.push(`define:${String(p)}`); return true; },
  }) as unknown as PrincipalDeps;
  return { proxy, touched, mutations };
}

function world(peppers: PepperSet, mode: "live" | "test" = "live", over: { key?: object; org?: object; app?: object } = {}) {
  const minted = mintApiKey(mode, peppers);
  if (!minted.ok) throw new Error("mint");
  const orgId = newOrgId();
  const appId = newAppId();
  const key = deepFreeze({
    keyId: minted.key.keyId, orgId, appId, mode, scopes: ["verifications:read", "models:read"], appScoped: true,
    hash: minted.key.hash, hashVersion: 1, prefix: minted.key.prefix, expiresAt: null, revokedAt: null, ...over.key,
  });
  const org = deepFreeze({ orgId, status: "active", plan: { planId: "beta_capped_v1", status: "active" }, ...over.org });
  const app = deepFreeze({ appId, orgId, status: "active", ...over.app });
  const reads: string[] = [];
  const base = (p: PepperSet = peppers): PrincipalDeps => ({
    peppers: () => p,
    getKey: async (id) => (reads.push(`key:${id}`), id === key.keyId ? key : null),
    getOrg: async (id) => (reads.push(`org:${id}`), id === orgId ? org : null),
    getApp: async (id) => (reads.push(`app:${id}`), id === appId ? app : null),
    now: () => NOW,
  });
  const headers = (secret = minted.key.displaySecret) => new Headers({ authorization: `Bearer ${secret}` });
  return { minted, key, org, app, base, headers, reads };
}

const P = (): PepperSet => ({ status: "available", current: randomBytes(32), previous: null });

describe("R-7: the principal touches only its five reader deps and never mutates anything", () => {
  const PATHS: [string, (w: ReturnType<typeof world>) => { h: Headers; deps?: PrincipalDeps }, string][] = [
    ["success", (w) => ({ h: w.headers() }), "ok"],
    ["wrong secret", (w) => ({ h: w.headers(`${w.minted.key.prefix}_${"A".repeat(43)}`) }), "invalid_api_key"],
    ["unknown key", () => ({ h: new Headers({ authorization: `Bearer cpk_live_ZZZZZZZZZZZZ_${"A".repeat(43)}` }) }), "invalid_api_key"],
    ["no header", () => ({ h: new Headers() }), "invalid_api_key"],
  ];
  it.each(PATHS)("%s: only reader members touched, no set/define/delete on deps", async (_n, build, want) => {
    const w = world(P());
    const { h } = build(w);
    const rec = recording(w.base());
    const d = await requireApiPrincipal(h, "verifications:read", rec.proxy);
    expect(d.ok ? "ok" : d.code).toBe(want);
    expect([...rec.touched].filter((k) => !ALLOWED_DEPS.includes(k))).toEqual([]);
    expect(rec.mutations).toEqual([]);
  });

  it.each([
    ["revoked", { key: { revokedAt: NOW - 1 } }, "invalid_api_key"],
    ["expired", { key: { expiresAt: NOW } }, "invalid_api_key"],
    ["suspended org", { org: { status: "suspended" } }, "org_suspended"],
    ["live key without plan", { org: { plan: null } }, "live_key_requires_plan"],
    ["missing scope", { key: { scopes: ["models:read"] } }, "insufficient_scope"],
  ] as const)("record path %s → %s, still read-only", async (_n, over, want) => {
    const w = world(P(), "live", over);
    const rec = recording(w.base());
    expect(await requireApiPrincipal(w.headers(), "verifications:read", rec.proxy)).toEqual({ ok: false, code: want });
    expect([...rec.touched].filter((k) => !ALLOWED_DEPS.includes(k))).toEqual([]);
    expect(rec.mutations).toEqual([]);
  });

  it("positive control: the recorder DOES see a member outside the allow-list", async () => {
    const w = world(P());
    const rec = recording(w.base());
    void (rec.proxy as unknown as Record<string, unknown>).recordUse;
    (rec.proxy as unknown as Record<string, unknown>).lastUsedAt = 1;
    expect([...rec.touched]).toContain("recordUse");
    expect(rec.mutations).toEqual(["set:lastUsedAt"]);
  });

  it("deep-frozen stored records still authenticate (the principal never writes to a record it read)", async () => {
    const w = world(P());
    expect(Object.isFrozen(w.key) && Object.isFrozen(w.org) && Object.isFrozen((w.org as { plan: object }).plan)).toBe(true);
    const d = await requireApiPrincipal(w.headers(), "verifications:read", w.base());
    expect(d.ok).toBe(true);
    // positive control: writing to a frozen record throws in this (strict-mode) module
    expect(() => { "use strict"; (w.key as Record<string, unknown>).lastUsedAt = NOW; }).toThrow(TypeError);
  });
});

describe("R-7: the whole store is byte-identical after authentication (fake Firestore, production-shaped readers)", () => {
  async function seeded(peppers: PepperSet) {
    const db = new FakeFirestore();
    const ctx: StoreContext = { db, actorUid: "uid_owner", requestId: "req_ro", now: NOW };
    const o = await createOrganization(ctx, { name: "Acme" });
    if (!o.ok) throw new Error();
    const a = await createApplication(ctx, { orgId: o.value.orgId, name: "App" });
    if (!a.ok) throw new Error();
    const live = await createApiKey(ctx, { actorRole: "owner", orgId: o.value.orgId, appId: a.value.appId, mode: "test" }, peppers);
    const revoked = await createApiKey(ctx, { actorRole: "owner", orgId: o.value.orgId, appId: a.value.appId, mode: "test" }, peppers);
    const rotated = await createApiKey(ctx, { actorRole: "owner", orgId: o.value.orgId, appId: a.value.appId, mode: "test" }, peppers);
    if (!live.ok || !revoked.ok || !rotated.ok) throw new Error();
    await revokeApiKey(ctx, { actorRole: "owner", orgId: o.value.orgId, keyId: revoked.value.keyId });
    const succ = await rotateApiKey(ctx, { actorRole: "owner", orgId: o.value.orgId, keyId: rotated.value.keyId, overlapSeconds: 60 }, peppers);
    if (!succ.ok) throw new Error();
    const read = async (p: string) => { const s = await db.doc(p).get(); return s.exists ? (s.data() as Record<string, unknown>) : null; };
    let transactions = 0;
    const realTx = db.runTransaction.bind(db);
    db.runTransaction = ((fn: never) => { transactions++; return realTx(fn); }) as typeof db.runTransaction;
    const deps = (p: PepperSet = peppers, now = NOW): PrincipalDeps => ({
      peppers: () => p,
      getKey: (id) => read(`apiKeys/${id}`),
      getOrg: (id) => read(`apiOrganizations/${id}`),
      getApp: (id) => read(`apiApplications/${id}`),
      now: () => now,
    });
    const dump = () => JSON.stringify([...db.docs.entries()].sort(([x], [y]) => x.localeCompare(y)));
    return { db, deps, dump, txCount: () => transactions, keys: { live: live.value, revoked: revoked.value, rotated: rotated.value, succ: succ.value } };
  }

  it("success, revoked, rotated-in-overlap, rotated-after-overlap, wrong secret and outage: zero transactions, store unchanged", async () => {
    const peppers = P();
    const s = await seeded(peppers);
    const before = s.dump();
    const h = (secret: string) => new Headers({ authorization: `Bearer ${secret}` });
    const outcomes = [
      await requireApiPrincipal(h(s.keys.live.displaySecret), "verifications:read", s.deps()),
      await requireApiPrincipal(h(s.keys.revoked.displaySecret), "verifications:read", s.deps()),
      await requireApiPrincipal(h(s.keys.rotated.displaySecret), "verifications:read", s.deps()),
      await requireApiPrincipal(h(s.keys.rotated.displaySecret), "verifications:read", s.deps(peppers, NOW + 60_000)),
      await requireApiPrincipal(h(s.keys.succ.displaySecret), "verifications:read", s.deps()),
      await requireApiPrincipal(h(`${s.keys.live.prefix}_${"A".repeat(43)}`), "verifications:read", s.deps()),
      await requireApiPrincipal(h(s.keys.live.displaySecret), "verifications:read", s.deps({ status: "unavailable", reason: "missing" })),
    ].map((d) => (d.ok ? "ok" : d.code));
    expect(outcomes).toEqual(["ok", "invalid_api_key", "ok", "invalid_api_key", "ok", "invalid_api_key", "api_unavailable"]);
    expect(s.txCount()).toBe(0);
    expect(s.dump()).toBe(before);
  });

  it("previous-pepper window: verifies while configured, is NOT rehashed, and fails once the previous pepper is removed", async () => {
    const old = P() as Extract<PepperSet, { status: "available" }>;
    const s = await seeded(old);
    const before = s.dump();
    const storedHash = (s.db.get(`apiKeys/${s.keys.live.keyId}`) as { hash: string }).hash;
    const h = new Headers({ authorization: `Bearer ${s.keys.live.displaySecret}` });
    const next = randomBytes(32);
    const window: PepperSet = { status: "available", current: next, previous: old.current };
    for (let i = 0; i < 3; i++) expect((await requireApiPrincipal(h, "verifications:read", s.deps(window))).ok).toBe(true);
    expect((s.db.get(`apiKeys/${s.keys.live.keyId}`) as { hash: string }).hash).toBe(storedHash); // no lazy rehash
    expect(s.dump()).toBe(before);
    // Window closed: the previous pepper is removed → the old-pepper key is refused (never silently upgraded).
    expect(await requireApiPrincipal(h, "verifications:read", s.deps({ status: "available", current: next, previous: null }))).toEqual({ ok: false, code: "invalid_api_key" });
    // A different "previous" pepper does not help either.
    expect(await requireApiPrincipal(h, "verifications:read", s.deps({ status: "available", current: next, previous: randomBytes(32) }))).toEqual({ ok: false, code: "invalid_api_key" });
    expect(s.txCount()).toBe(0);
    expect(s.dump()).toBe(before);
  });

  it("positive control: the dump comparison detects a single write", async () => {
    const s = await seeded(P());
    const before = s.dump();
    await s.db.runTransaction(async (tx) => { tx.update(s.db.doc(`apiKeys/${s.keys.live.keyId}`), { lastUsedAt: NOW }); });
    expect(s.dump()).not.toBe(before);
    expect(s.txCount()).toBe(1);
  });
});

describe("R-7: missing or malformed peppers make authentication unavailable, never a bypass", () => {
  const goodPepper = b64(32);
  const ENVS: [string, Record<string, string>][] = [
    ["unset", {}],
    ["empty", { API_KEY_PEPPER: "" }],
    ["whitespace", { API_KEY_PEPPER: "  \t " }],
    ["too short (31 bytes)", { API_KEY_PEPPER: b64(MIN_PEPPER_BYTES - 1) }],
    ["one byte", { API_KEY_PEPPER: "AA" }],
    ["not base64url (punctuation)", { API_KEY_PEPPER: "not base64url!!" }],
    ["standard base64 alphabet (+ and /)", { API_KEY_PEPPER: `${"+/".repeat(22)}` }],
    ["embedded whitespace", { API_KEY_PEPPER: `${goodPepper.slice(0, 20)} ${goodPepper.slice(20)}` }],
    ["JSON instead of a key", { API_KEY_PEPPER: '{"k":"v"}' }],
    ["previous malformed", { API_KEY_PEPPER: goodPepper, API_KEY_PEPPER_PREVIOUS: "%%%" }],
    ["previous too short", { API_KEY_PEPPER: goodPepper, API_KEY_PEPPER_PREVIOUS: b64(8) }],
    ["previous equals current", { API_KEY_PEPPER: goodPepper, API_KEY_PEPPER_PREVIOUS: goodPepper }],
  ];

  it.each(ENVS)("pepper %s → api_unavailable, before ANY lookup, for a valid, a wrong and a missing key", async (_n, env) => {
    const w = world({ status: "available", current: Buffer.from(goodPepper, "base64url"), previous: null }, "test");
    const deps: PrincipalDeps = { ...w.base(), peppers: () => readApiKeyPeppers(env as NodeJS.ProcessEnv) };
    for (const h of [w.headers(), w.headers(`${w.minted.key.prefix}_${"A".repeat(43)}`), new Headers({ authorization: `Bearer cpk_test_ZZZZZZZZZZZZ_${"A".repeat(43)}` })]) {
      expect(await requireApiPrincipal(h, "verifications:read", deps)).toEqual({ ok: false, code: "api_unavailable" });
    }
    expect(w.reads).toEqual([]);
  });

  it("control: the same key with the valid env authenticates (the matrix above is not vacuous)", async () => {
    const w = world({ status: "available", current: Buffer.from(goodPepper, "base64url"), previous: null }, "test");
    const deps: PrincipalDeps = { ...w.base(), peppers: () => readApiKeyPeppers({ API_KEY_PEPPER: goodPepper } as NodeJS.ProcessEnv) };
    expect((await requireApiPrincipal(w.headers(), "verifications:read", deps)).ok).toBe(true);
  });

  it.each([
    ["peppers() throws", () => { throw new Error("boom"); }],
    ["available with a short current Buffer (bypassing the reader)", () => ({ status: "available", current: Buffer.alloc(8), previous: null })],
    ["available with current missing", () => ({ status: "available" })],
    ["available with a string current", () => ({ status: "available", current: "x".repeat(64), previous: null })],
    ["available with a short previous Buffer", () => ({ status: "available", current: randomBytes(32), previous: Buffer.alloc(4) })],
    ["unknown status", () => ({ status: "degraded", current: randomBytes(32), previous: null })],
    ["null", () => null],
  ])("%s → api_unavailable (fail closed), never ok", async (_n, peppers) => {
    const w = world(P(), "test");
    const deps: PrincipalDeps = { ...w.base(), peppers: peppers as never };
    expect(await requireApiPrincipal(w.headers(), "verifications:read", deps)).toEqual({ ok: false, code: "api_unavailable" });
  });

  it("minting is refused without a valid pepper (no key can be created that a bypass could later accept)", () => {
    for (const [, env] of ENVS) expect(mintApiKey("test", readApiKeyPeppers(env as NodeJS.ProcessEnv))).toEqual({ ok: false, reason: "peppers_unavailable" });
  });
});

describe("R-7: the authentication modules contain no writer (source + import scan, with positive controls)", () => {
  const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  const WRITER = /(?<!\bObject)\.(?:set|update|create|delete|add)\s*\(|\brunTransaction\b|\bbatch\s*\(|\bFieldValue\b|\bincrement\s*\(|lastUsedAt/;
  const SPEC_RE = /\b(?:from\s*|import\s*\(\s*|require\s*\(\s*|import\s+)["'`]([^"'`]+)["'`]/g;
  const specifiers = (src: string) => [...src.matchAll(SPEC_RE)].map((m) => m[1]).sort();

  it("positive control: the writer pattern catches every write form", () => {
    for (const w of ["tx.update(ref, {})", "ref.set({})", "db.runTransaction(fn)", "FieldValue.increment(1)", "x.create(r, d)", "ref.delete()", "col.add({})", "db.batch()", "lastUsedAt: now"]) {
      expect([w, WRITER.test(w)]).toEqual([w, true]);
    }
    expect(WRITER.test("await deps.getKey(id); Object.freeze(x); Object.create(null); new Set(); a.includes(b)")).toBe(false);
  });

  it("principal.ts has no writer and imports exactly keys, types, errors and apiPlans", () => {
    const src = readFileSync(path.join(ROOT, "lib/apiPlatform/principal.ts"), "utf8");
    expect(WRITER.test(strip(src))).toBe(false);
    expect(specifiers(src)).toEqual(["@/lib/apiPlatform/apiPlans", "@/lib/apiPlatform/errors", "@/lib/apiPlatform/keys", "@/lib/apiPlatform/types"]);
  });

  it("keys.ts has no writer and imports exactly node:crypto, ids and secrets.server", () => {
    const src = readFileSync(path.join(ROOT, "lib/apiPlatform/keys.ts"), "utf8");
    expect(WRITER.test(strip(src))).toBe(false);
    expect(specifiers(src)).toEqual(["@/lib/apiPlatform/ids", "@/lib/apiPlatform/secrets.server", "node:crypto"]);
  });

  it("secrets.server.ts: the only `.update(` is the HMAC digest; no Firestore writer", () => {
    const src = strip(readFileSync(path.join(ROOT, "lib/apiPlatform/secrets.server.ts"), "utf8"));
    const hits = src.split("\n").filter((l) => WRITER.test(l)).map((l) => l.trim());
    expect(hits).toEqual(['return createHmac("sha256", subkey).update(data).digest();']);
  });
});
