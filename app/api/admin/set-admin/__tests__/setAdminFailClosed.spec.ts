/**
 * Phase FIRST-ADMIN-C9 — THE BOOTSTRAP ROUTE'S FAIL-CLOSED GUARANTEE.
 *
 * `/api/admin/set-admin` mints `admin: true` — full SYSTEM_ADMIN — on ANY uid,
 * authenticated by possession of `ADMIN_SECRET` and nothing else. It writes no
 * audit record and logs nothing on success.
 *
 * The C8-R5 review found this route had ZERO test coverage while C8's own
 * documentation had just made its fail-closed behaviour load-bearing in two
 * places: the SYSTEM_ADMIN containment procedure calls removing the secret "a
 * valid containment state", and the preferred enrollment option states the
 * secret "never needs to hold a live value".
 *
 * Both rest on ONE conjunct:
 *
 *     adminSecret.length > 0 &&
 *     provided.length === adminSecret.length &&
 *     timingSafeEqual(...)
 *
 * `timingSafeEqual(Buffer.from(""), Buffer.from(""))` returns TRUE. Delete that
 * first conjunct and, with `ADMIN_SECRET` unset, `{"uid":"victim","secret":""}`
 * from an unauthenticated caller mints SYSTEM_ADMIN — silently. The reviewer
 * removed it and the entire repository suite stayed green.
 */

const setCustomUserClaims = jest.fn(async () => {});
const firestoreSet = jest.fn(async () => {});
let rateLimitAllowed = true;

jest.mock("@/lib/firebase/admin", () => ({
  adminAuth: { setCustomUserClaims: (...a: unknown[]) => setCustomUserClaims(...(a as [])) },
  adminDb: { collection: () => ({ doc: () => ({ set: (...a: unknown[]) => firestoreSet(...(a as [])) }) }) },
}));
jest.mock("@/lib/security/rateLimit", () => ({
  checkRateLimit: async () => ({ allowed: rateLimitAllowed, remaining: 0, resetAt: 0 }),
}));

import { NextRequest } from "next/server";
import { readFileSync } from "node:fs";

const VALID_UID = "a-real-looking-firebase-uid-000000000001";
const REAL_SECRET = "correct-horse-battery-staple-0123456789";

const post = async (body: Record<string, unknown>) => {
  const { POST } = await import("@/app/api/admin/set-admin/route");
  return POST(new NextRequest("http://localhost/api/admin/set-admin", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" },
    body: JSON.stringify(body),
  }));
};

/** Every privileged side effect this route can perform. */
const privilegedMutations = () => setCustomUserClaims.mock.calls.length + firestoreSet.mock.calls.length;

const SNAPSHOT = process.env.ADMIN_SECRET;
afterAll(() => {
  if (SNAPSHOT === undefined) delete process.env.ADMIN_SECRET;
  else process.env.ADMIN_SECRET = SNAPSHOT;
});

beforeEach(() => {
  setCustomUserClaims.mockClear();
  firestoreSet.mockClear();
  rateLimitAllowed = true;
  delete process.env.ADMIN_SECRET;
});

describe("THE POSITIVE ANCHOR — this fixture really can reach the claim-minting path", () => {
  /**
   * Without this, every denial below could be caused by a malformed uid, a
   * rejected body, or a mock that never wires up — and the security tests would
   * pass while proving nothing. This is the control that makes them mean
   * something: the SAME uid and the SAME request shape, with a correct secret,
   * mints the claim.
   */
  it("a correct secret with a valid uid mints the admin claim", async () => {
    process.env.ADMIN_SECRET = REAL_SECRET;
    const res = await post({ uid: VALID_UID, secret: REAL_SECRET });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(setCustomUserClaims).toHaveBeenCalledWith(VALID_UID, { admin: true });
    expect(firestoreSet).toHaveBeenCalled();
  });
});

describe("FAIL CLOSED when ADMIN_SECRET is unset or empty", () => {
  it.each([
    ["unset (the containment state the runbook prescribes)", undefined],
    ["set to the empty string", ""],
  ])("ADMIN_SECRET %s: an empty request secret is rejected and mutates nothing", async (_label, envValue) => {
    if (envValue === undefined) delete process.env.ADMIN_SECRET;
    else process.env.ADMIN_SECRET = envValue;

    const res = await post({ uid: VALID_UID, secret: "" });

    expect(res.status).toBe(401);
    expect(setCustomUserClaims).not.toHaveBeenCalled();
    expect(firestoreSet).not.toHaveBeenCalled();
    expect(privilegedMutations()).toBe(0);
  });

  it("ADMIN_SECRET unset and the request omits `secret` entirely: rejected, mutates nothing", async () => {
    const res = await post({ uid: VALID_UID });
    expect(res.status).toBe(401);
    expect(privilegedMutations()).toBe(0);
  });

  it("ADMIN_SECRET unset: even a non-string secret cannot authenticate", async () => {
    // `provided` coerces a non-string to "", which would match an empty env
    // value on length. Same bypass, different input type.
    for (const secret of [null, 0, false, [], {}]) {
      setCustomUserClaims.mockClear();
      const res = await post({ uid: VALID_UID, secret });
      expect(res.status).toBe(401);
      expect(privilegedMutations()).toBe(0);
    }
  });
});

describe("LENGTH-MISMATCH SAFETY — every invalid secret is a 401, never a 500", () => {
  /**
   * Phase FIRST-ADMIN-C10. The previous version of this block was titled "never
   * throws or admits" while every fixture was ASCII, so the property was never
   * exercised. `"aaa"` and `"ééé"` have equal `.length` and unequal byte length,
   * which made `timingSafeEqual` throw and surface as 500 — an unauthenticated
   * length oracle, and an INCONCLUSIVE result for the containment probe.
   */
  it.each([
    ["shorter", REAL_SECRET.slice(0, 5)],
    ["longer", REAL_SECRET + "extra"],
    ["empty against a configured secret", ""],
    ["same length but wrong", "X".repeat(REAL_SECRET.length)],
    ["equal characters but more bytes (2-byte)", "é".repeat(REAL_SECRET.length)],
    ["equal characters but more bytes (3-byte)", "あ".repeat(REAL_SECRET.length)],
    ["a 4-byte-per-glyph emoji secret", "😀".repeat(REAL_SECRET.length)],
    ["non-ASCII of a different character length", "ünïcödé"],
  ])("a %s secret is rejected with 401, not an exception", async (_label, provided) => {
    process.env.ADMIN_SECRET = REAL_SECRET;
    const res = await post({ uid: VALID_UID, secret: provided });
    // A throw surfaces as 500 from the catch — that still denies, but it denies
    // by accident, it leaks the secret's length, and it makes the containment
    // probe inconclusive. 401 is the only acceptable answer.
    expect(res.status).toBe(401);
    expect(privilegedMutations()).toBe(0);
  });

  it("SELF-VALIDATION: the equal-character fixtures really do differ in byte length", () => {
    /**
     * Without this the new rows could silently become ordinary ASCII
     * mismatches, and the regression would be untested. Restricted to single
     * UTF-16 unit characters: `😀` is a surrogate pair, so `.length` is 2 per
     * glyph and it cannot express "equal character length" — it is covered as
     * a plain non-ASCII rejection instead.
     */
    for (const ch of ["é", "あ"]) {
      expect(ch.length).toBe(1);
      const probe = ch.repeat(REAL_SECRET.length);
      expect(probe.length).toBe(REAL_SECRET.length);            // equal characters
      expect(Buffer.byteLength(probe, "utf8")).toBeGreaterThan( // unequal bytes
        Buffer.byteLength(REAL_SECRET, "utf8")
      );
    }
    // And the pre-fix defect is real: this pair is exactly what used to throw.
    expect("aaa".length).toBe("ééé".length);
    expect(Buffer.byteLength("aaa")).not.toBe(Buffer.byteLength("ééé"));
  });
});

describe("SOURCE CONTRACT — the comparison is timing-safe and byte-length guarded", () => {
  /**
   * Constant-time behaviour cannot be demonstrated from jest, so this does not
   * pretend to. It pins the MECHANISM: buffers built first, byte lengths
   * compared, then `timingSafeEqual`. A silent downgrade to `===` or to a
   * character-length guard is what this catches. Labelled as the source check
   * it is.
   */
  const SRC = readFileSync("app/api/admin/set-admin/route.ts", "utf8");

  it("ANCHOR: the guard region was located", () => {
    expect(SRC).toContain("const secretValid =");
    expect(SRC).toContain("timingSafeEqual");
  });

  it("uses timingSafeEqual, not string equality", () => {
    expect(SRC).toMatch(/timingSafeEqual\(\s*providedBuf\s*,\s*adminSecretBuf\s*\)/);
    // The downgrade that survived C9's suite.
    expect(SRC).not.toMatch(/provided\s*===\s*adminSecret\b/);
  });

  it("compares BUFFER lengths, never string lengths, before calling it", () => {
    expect(SRC).toContain("providedBuf.length === adminSecretBuf.length");
    expect(SRC).not.toMatch(/provided\.length\s*===\s*adminSecret\.length/);
  });

  it("still fails closed on an empty configured secret, by buffer length", () => {
    expect(SRC).toContain("adminSecretBuf.length > 0");
  });
});

describe("THE SAFE OLD-SECRET PROBE — proves a credential's status without minting anything", () => {
  /**
   * C8's containment runbook told the responder to POST `{uid, secret}` with the
   * OLD secret to prove it was dead. If the rotated configuration had not
   * actually deployed, that probe SUCCEEDS — re-minting `admin: true` on the
   * uid used, with no audit record and no log to notice it. The verification
   * step was itself a claim-minting operation.
   *
   * The route validates the secret BEFORE the uid, so omitting the uid
   * distinguishes the two states while mutating nothing on either branch:
   *
   *     400 -> the secret was ACCEPTED (execution reached uid validation)
   *     401 -> the secret was REJECTED  <- the only proof of containment
   */
  const OLD = "old-bootstrap-secret-aaaaaaaaaaaaaaaaaaaa";
  const NEW = "new-bootstrap-secret-bbbbbbbbbbbbbbbbbbbb";

  it("SELF-VALIDATION: the two secrets differ, and neither probe carries a uid", () => {
    expect(OLD).not.toBe(NEW);
    expect(OLD.length).toBe(NEW.length); // so a length check cannot be what distinguishes them
  });

  it("while the OLD secret is still live: uid-less probe returns 400 and mints nothing", async () => {
    process.env.ADMIN_SECRET = OLD;
    const res = await post({ secret: OLD });
    // 400 = "secret accepted, uid missing". Containment NOT yet proven.
    expect(res.status).toBe(400);
    expect(privilegedMutations()).toBe(0);
  });

  it("after rotation: the OLD secret's uid-less probe returns 401 and mints nothing", async () => {
    process.env.ADMIN_SECRET = NEW;
    const res = await post({ secret: OLD });
    // 401 = the old credential is dead. This is the ONLY conclusive result.
    expect(res.status).toBe(401);
    expect(privilegedMutations()).toBe(0);
  });

  it("after rotation: the NEW secret's uid-less probe returns 400 and mints nothing", async () => {
    // Proves 401-vs-400 tracks the CREDENTIAL, not the missing uid — without
    // this, 401 above could just mean "uid-less requests are always rejected".
    process.env.ADMIN_SECRET = NEW;
    const res = await post({ secret: NEW });
    expect(res.status).toBe(400);
    expect(privilegedMutations()).toBe(0);
  });

  it("the UNSAFE probe would have re-minted the claim — which is why the runbook must omit the uid", async () => {
    // Pins the hazard itself: same probe, uid included, old secret still live.
    process.env.ADMIN_SECRET = OLD;
    const res = await post({ uid: VALID_UID, secret: OLD });
    expect(res.status).toBe(200);
    expect(setCustomUserClaims).toHaveBeenCalledWith(VALID_UID, { admin: true });
  });
});

describe("RATE LIMITING RUNS BEFORE SECRET VALIDATION — so 429 proves nothing", () => {
  it("a correct secret is still refused with 429 when rate limited", async () => {
    process.env.ADMIN_SECRET = REAL_SECRET;
    rateLimitAllowed = false;
    const res = await post({ uid: VALID_UID, secret: REAL_SECRET });
    expect(res.status).toBe(429);
    expect(privilegedMutations()).toBe(0);
  });

  it("a WRONG secret is refused with the same 429, so the response cannot distinguish them", async () => {
    process.env.ADMIN_SECRET = REAL_SECRET;
    rateLimitAllowed = false;
    const res = await post({ uid: VALID_UID, secret: "definitely-wrong" });
    expect(res.status).toBe(429);
    // Identical status for a live and a dead credential: a responder who reads
    // 429 as "contained" has proven nothing. The runbook must say so.
  });
});

describe("STRICT SECRET TYPE — coercion must never authenticate", () => {
  /**
   * Phase FIRST-ADMIN-C11 (R7 F-3). The existing "even a non-string secret
   * cannot authenticate" test lives under the `ADMIN_SECRET unset` describe,
   * where the non-empty-secret conjunct denies regardless of the type guard —
   * so removing the guard survived the whole suite. With a CONFIGURED secret
   * that looks numeric, `String(secret ?? "")` lets a JSON number authenticate
   * and mint the claim. These rows are the ones that can fail.
   */
  const NUMERIC_SECRET = "1234567890123456";

  it("ANCHOR: the string form of the numeric secret DOES authenticate", async () => {
    // Establishes that the fixture reaches the mint, so the denials below are
    // caused by the type guard and not by an unrelated rejection.
    process.env.ADMIN_SECRET = NUMERIC_SECRET;
    const res = await post({ uid: VALID_UID, secret: NUMERIC_SECRET });
    expect(res.status).toBe(200);
    expect(setCustomUserClaims).toHaveBeenCalledWith(VALID_UID, { admin: true });
  });

  it("SELF-VALIDATION: the numeric literal and the string are the same digits", () => {
    // If these diverged, the number below would be rejected on length and the
    // test would pass for the wrong reason.
    expect(String(1234567890123456)).toBe(NUMERIC_SECRET);
    expect(NUMERIC_SECRET.length).toBe(16);
  });

  it("a JSON NUMBER equal to the configured secret is rejected", async () => {
    process.env.ADMIN_SECRET = NUMERIC_SECRET;
    const res = await post({ uid: VALID_UID, secret: 1234567890123456 });
    expect(res.status).toBe(401);
    expect(privilegedMutations()).toBe(0);
  });

  it.each([
    ["a boolean", true],
    ["an array of the digits", ["1234567890123456"]],
    ["an object wrapping it", { toString: () => "1234567890123456" }],
    ["null", null],
  ])("%s cannot authenticate against a configured secret", async (_label, secret) => {
    process.env.ADMIN_SECRET = NUMERIC_SECRET;
    const res = await post({ uid: VALID_UID, secret });
    expect(res.status).toBe(401);
    expect(privilegedMutations()).toBe(0);
  });
});

describe("PROBE ATTESTATION — the route says which side of the check was reached", () => {
  /**
   * Phase FIRST-ADMIN-C12. The canonical containment probe used to treat any
   * 401 as proof a rotated secret was dead — so a WAF, an SSO gate, a
   * deployment-protection wall or a redirect target could close a rotation
   * incident while the old secret was still minting SYSTEM_ADMIN. The verdict
   * now requires this header, which only this route emits.
   */
  const MARKER = "x-convergepanel-admin-secret-probe";

  it("uid-less probe with the WRONG secret: 401 + credential-rejected", async () => {
    process.env.ADMIN_SECRET = REAL_SECRET;
    const res = await post({ secret: "X".repeat(REAL_SECRET.length) });
    expect(res.status).toBe(401);
    expect(res.headers.get(MARKER)).toBe("credential-rejected");
    expect(privilegedMutations()).toBe(0);
  });

  it("uid-less probe with the CORRECT secret: 400 + credential-accepted, and mints nothing", async () => {
    process.env.ADMIN_SECRET = REAL_SECRET;
    const res = await post({ secret: REAL_SECRET });
    expect(res.status).toBe(400);
    expect(res.headers.get(MARKER)).toBe("credential-accepted");
    expect(privilegedMutations()).toBe(0);
  });

  it("uid-less probe with ADMIN_SECRET unset: 401 + credential-rejected", async () => {
    delete process.env.ADMIN_SECRET;
    const res = await post({ secret: "" });
    expect(res.status).toBe(401);
    expect(res.headers.get(MARKER)).toBe("credential-rejected");
  });

  it("the marker carries no secret, uid, email or tenant data", async () => {
    process.env.ADMIN_SECRET = REAL_SECRET;
    const rejected = await post({ secret: "wrong-but-same-length-aaaaaaaaaaaaaaaaa" });
    const accepted = await post({ secret: REAL_SECRET });
    for (const res of [rejected, accepted]) {
      const v = res.headers.get(MARKER)!;
      expect(["credential-rejected", "credential-accepted"]).toContain(v);
      expect(v).not.toContain(REAL_SECRET);
      expect(v).not.toContain(VALID_UID);
      expect(v).not.toContain("@");
    }
  });

  it("ANCHOR: an ordinary MINT still behaves exactly as before", async () => {
    // The attestation must not have altered the bootstrap contract.
    process.env.ADMIN_SECRET = REAL_SECRET;
    const res = await post({ uid: VALID_UID, secret: REAL_SECRET });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(setCustomUserClaims).toHaveBeenCalledWith(VALID_UID, { admin: true });
  });
});
