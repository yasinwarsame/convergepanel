/**
 * Security Gate S0 — CodeQL #1 (js/polynomial-redos): the invitation email shape guard.
 *
 * The former guard, /^[^\s@]+@[^\s@]+\.[^\s@]+$/, backtracked quadratically on long input that survives the
 * trim, e.g. "!@!." + "!.".repeat(n) + "@": about 1.4 s at 40k characters, reached from the body of
 * POST /api/workspaces/[workspaceId]/invitations before any workspace authorization and without a length cap.
 *
 * It is replaced by a linear check that accepts exactly the same strings, and request input longer than 254
 * characters (RFC 5321) is rejected before it is examined. The former regex is kept here only as the reference
 * oracle for equivalence.
 */
import { MAX_INVITATION_EMAIL_LENGTH, isValidNormalizedInvitationEmail, normalizeInvitationEmail } from "@/lib/workspaces/invitationEmail";

const FORMER_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** The former functions, verbatim apart from the regex reference — the oracle for inputs within the length cap. */
function formerNormalize(input: unknown) {
  if (typeof input !== "string") return { ok: false };
  const trimmed = input.trim();
  if (trimmed.length === 0) return { ok: false };
  const normalized = trimmed.toLowerCase();
  if (!FORMER_SHAPE.test(normalized)) return { ok: false };
  return { ok: true, normalizedEmail: normalized };
}
function formerIsValid(value: unknown) {
  if (typeof value !== "string") return false;
  if (value !== value.trim().toLowerCase()) return false;
  return FORMER_SHAPE.test(value);
}

const CORPUS: unknown[] = [
  "a@b.c", "A@B.C", "  a@b.c  ", "a.b+tag@example.co.uk", "a@b", "@b.c", "a@.c", "a@b.", "a@@b.c", "a b@c.d", "a@b c.d", "a@b.c d",
  "a@b..c", "a@.b.c", "a@b.c.", ".a@b.c", "a.@b.c", "a@b-c.d", "x@y.z\n", "\ta@b.c", "a@b\u00a0.c", "a@b.c\u2028", "ü@ñ.example",
  "a@1.2", "a@b.c@d.e", "", "   ", "a@b.cc", "a@bb.c", "aa@b.c", "a@b.c.d.e.f", "a@-.-", "a@..", "a@...c", "\u3000a@b.c", "a@b\u200b.c",
  "A@B.C ", "a@B.c", null, undefined, 42, {}, ["a@b.c"], "a@b.c\u0000", "a\u00a0b@c.d", "a@b.c\ufeff",
];

/**
 * Deterministic pseudo-random near-email strings (seeded LCG, high bits): a local part, an optional "@", and a
 * domain of dot-separated pieces, each piece and separator drawn so that both accepted and rejected shapes are
 * frequent, plus random single-character mutations.
 */
function* randomStrings(count: number): Generator<string> {
  const chars = ["a", "B", "1", "-", "+", "é", ".", "@", " ", "\t", "\u00a0", "\n"];
  let seed = 20261018;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed >>> 8;
  };
  const piece = () => Array.from({ length: next() % 4 }, () => chars[next() % 6]).join("");
  for (let i = 0; i < count; i++) {
    let s = piece();
    if (next() % 5 !== 0) s += "@";
    const pieces = 1 + (next() % 3);
    for (let p = 0; p < pieces; p++) s += (p > 0 ? "." : "") + piece();
    const mutations = next() % 3;
    for (let m = 0; m < mutations; m++) {
      const at = next() % (s.length + 1);
      s = s.slice(0, at) + chars[next() % chars.length] + s.slice(at);
    }
    yield s;
  }
}

describe("S0 #1: the invitation email shape guard is the former shape, in linear time", () => {
  it("accepts and rejects exactly what the former regex did, on a hand corpus", () => {
    for (const c of CORPUS) {
      expect({ c, r: normalizeInvitationEmail(c) }).toEqual({ c, r: formerNormalize(c) });
      expect({ c, r: isValidNormalizedInvitationEmail(c) }).toEqual({ c, r: formerIsValid(c) });
    }
  });

  it("…and on 20,000 seeded random strings over the shape-relevant alphabet", () => {
    let accepted = 0;
    for (const s of randomStrings(20000)) {
      const now = normalizeInvitationEmail(s);
      expect(now).toEqual(formerNormalize(s));
      expect(isValidNormalizedInvitationEmail(s)).toBe(formerIsValid(s));
      if (now.ok) accepted++;
    }
    expect(accepted).toBeGreaterThan(2000); // both branches are exercised heavily, not only rejections
  });

  it("request input is capped at 254 characters (RFC 5321): 254 accepted, 255 rejected, both previously accepted", () => {
    const at254 = `${"x".repeat(MAX_INVITATION_EMAIL_LENGTH - 6)}@b.com`;
    const at255 = `${"x".repeat(MAX_INVITATION_EMAIL_LENGTH - 5)}@b.com`;
    expect(at254).toHaveLength(254);
    expect(at255).toHaveLength(255);
    expect(normalizeInvitationEmail(at254)).toEqual({ ok: true, normalizedEmail: at254 });
    expect(normalizeInvitationEmail(at255)).toEqual({ ok: false });
    expect(formerNormalize(at255)).toEqual({ ok: true, normalizedEmail: at255 });
    // The cap applies to the trimmed input: surrounding whitespace does not count.
    expect(normalizeInvitationEmail(`  ${at254}  `)).toEqual({ ok: true, normalizedEmail: at254 });
  });

  it("stored-value validation keeps its former semantics (no cap): a stored 300-character address still validates", () => {
    const stored = `${"x".repeat(294)}@b.com`;
    expect(isValidNormalizedInvitationEmail(stored)).toBe(true);
    expect(formerIsValid(stored)).toBe(true);
  });

  it("60,000-character trim-surviving input is rejected in well under 100 ms (the former regex needs ~3 s here)", () => {
    const s = "!@!." + "!.".repeat(30000) + "@";
    const t0 = Date.now();
    expect(normalizeInvitationEmail(s)).toEqual({ ok: false });
    expect(isValidNormalizedInvitationEmail(s)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(100);
  });

  const SHAPES: [string, (n: number) => string][] = [
    ["CodeQL shape with a trailing '@'", (n) => "!@!." + "!.".repeat(n) + "@"],
    ["CodeQL shape with an inner space", (n) => "!@!." + "!.".repeat(n) + " x"],
    ["many '@' signs", (n) => "@".repeat(2 * n)],
    ["dots only after '@'", (n) => "a@" + ".".repeat(2 * n)],
  ];
  it.each(SHAPES)("%s: 1,000,000-character input is rejected promptly by both functions", (_n, make) => {
    const s = make(500000);
    const t0 = Date.now();
    expect(normalizeInvitationEmail(s)).toEqual({ ok: false });
    const t1 = Date.now();
    isValidNormalizedInvitationEmail(s);
    const t2 = Date.now();
    // The former regex needs ~1.4 s at 40k characters and grows quadratically (hours at 1M). Linear code finishes
    // well under this generous bound even on a slow CI machine.
    expect(t1 - t0).toBeLessThan(1000);
    expect(t2 - t1).toBeLessThan(1000);
  });
});
