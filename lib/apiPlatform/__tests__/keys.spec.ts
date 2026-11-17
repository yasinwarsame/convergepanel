import { randomBytes } from "node:crypto";
import {
  KEY_SECRET_LENGTH,
  computeVerifier,
  mintApiKey,
  parseApiKey,
  verifierMatches,
  type PepperSet,
} from "@/lib/apiPlatform/keys";
import { randomBase62 } from "@/lib/apiPlatform/ids";

const pep = (prev = false): PepperSet => ({ status: "available", current: randomBytes(32), previous: prev ? randomBytes(32) : null });

describe("key format", () => {
  it("mints cpk_{mode}_{12}_{43} with a matching prefix and a 64-hex verifier", () => {
    for (const mode of ["live", "test"] as const) {
      const r = mintApiKey(mode, pep());
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.key.displaySecret).toMatch(/^cpk_(live|test)_[0-9A-Za-z]{12}_[0-9A-Za-z]{43}$/);
      expect(r.key.displaySecret.startsWith(`${r.key.prefix}_`)).toBe(true);
      expect(r.key.prefix).toBe(`cpk_${mode}_${r.key.keyId}`);
      expect(r.key.verifier).toMatch(/^[0-9a-f]{64}$/);
      expect(r.key.verifier).not.toContain(r.key.displaySecret.slice(-KEY_SECRET_LENGTH));
    }
  });

  it("refuses to mint without peppers", () => {
    expect(mintApiKey("live", { status: "unavailable", reason: "missing" })).toEqual({ ok: false, reason: "peppers_unavailable" });
  });

  it("produces distinct keys", () => {
    const p = pep();
    const set = new Set(Array.from({ length: 200 }, () => (mintApiKey("test", p) as { ok: true; key: { displaySecret: string } }).key.displaySecret));
    expect(set.size).toBe(200);
  });

  it.each([
    "",
    "cpk_live_abc",
    "cpk_prod_AAAAAAAAAAAA_" + "a".repeat(43),
    "cpk_live_AAAAAAAAAAAA_" + "a".repeat(42),
    "cpk_live_AAAAAAAAAAAA_" + "a".repeat(44),
    "cpk_live_AAAAAAAAAAA!_" + "a".repeat(43),
    " cpk_live_AAAAAAAAAAAA_" + "a".repeat(43),
    "cpk_live_AAAAAAAAAAAA_" + "a".repeat(42) + "\n",
    "CPK_live_AAAAAAAAAAAA_" + "a".repeat(43),
    "sk_live_AAAAAAAAAAAA_" + "a".repeat(43),
    "cpk_live_AAAAAAAAAAAA_" + "a".repeat(42) + "-",
    "cpk_live_AAAAAAAAAAAA_" + "!".repeat(43),
    "cpk_live_AAAAAAAAAAAA_" + "a".repeat(21) + " " + "a".repeat(21),
  ])("parse rejects %j", (s) => expect(parseApiKey(s)).toBeNull());

  it("parse accepts a minted key and returns its parts", () => {
    const r = mintApiKey("live", pep());
    if (!r.ok) throw new Error();
    expect(parseApiKey(r.key.displaySecret)).toEqual({ mode: "live", keyId: r.key.keyId, secret: r.key.displaySecret.slice(-43) });
    expect(parseApiKey(12345)).toBeNull();
  });
});

describe("verifier", () => {
  it("matches only the exact (mode, keyId, secret) under the stored pepper", () => {
    const p = pep();
    const r = mintApiKey("live", p);
    if (!r.ok || p.status !== "available") throw new Error();
    const parsed = parseApiKey(r.key.displaySecret)!;
    expect(verifierMatches(parsed, r.key.verifier, p)).toBe(true);
    expect(verifierMatches({ ...parsed, secret: randomBase62(43) }, r.key.verifier, p)).toBe(false);
    expect(verifierMatches({ ...parsed, mode: "test" }, r.key.verifier, p)).toBe(false);
    expect(verifierMatches({ ...parsed, keyId: randomBase62(12) }, r.key.verifier, p)).toBe(false);
    expect(verifierMatches(parsed, r.key.verifier, pep())).toBe(false); // other pepper
    expect(verifierMatches(parsed, r.key.verifier.toUpperCase(), p)).toBe(false);
    expect(verifierMatches(parsed, r.key.verifier.slice(2), p)).toBe(false);
    expect(verifierMatches(parsed, undefined, p)).toBe(false);
    expect(verifierMatches(parsed, r.key.verifier, { status: "unavailable", reason: "missing" })).toBe(false);
  });

  it("rotation window: a key minted under the previous pepper verifies while previous is configured", () => {
    const old = randomBytes(32);
    const r = mintApiKey("test", { status: "available", current: old, previous: null });
    if (!r.ok) throw new Error();
    const parsed = parseApiKey(r.key.displaySecret)!;
    const rotated: PepperSet = { status: "available", current: randomBytes(32), previous: old };
    expect(verifierMatches(parsed, r.key.verifier, rotated)).toBe(true);
    expect(verifierMatches(parsed, r.key.verifier, { ...rotated, previous: null })).toBe(false);
  });

  it("verifier is bound to mode and keyId (no cross-key replay)", () => {
    const p = randomBytes(32);
    const s = randomBase62(43);
    const a = computeVerifier(p, "live", "AAAAAAAAAAAA", s);
    expect(computeVerifier(p, "test", "AAAAAAAAAAAA", s)).not.toBe(a);
    expect(computeVerifier(p, "live", "AAAAAAAAAAAB", s)).not.toBe(a);
  });
});
