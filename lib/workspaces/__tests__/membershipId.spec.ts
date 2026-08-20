import { createHash } from "crypto";
import { computeMembershipId, isWellFormedMembershipId } from "@/lib/workspaces/membershipId";

/**
 * Phase 8B.2 — fixed known test vectors proving the domain separator
 * (`"convergepanel.workspace-membership.v1"`) is hashed as part of the
 * digest input, not merely displayed as the `wm_` output prefix. These
 * exact hex digests were computed independently (Node's `crypto` module,
 * outside this module) against the frozen algorithm and hardcoded here —
 * if `computeMembershipId()` ever silently drops, reorders, or changes
 * the separator, these exact strings stop matching, even though every
 * *relative* property test elsewhere in this file (determinism,
 * tuple-distinctness, Unicode safety) would still pass unchanged. A
 * relative-property suite alone cannot catch a domain-separator
 * regression — only a fixed vector can.
 */
describe("computeMembershipId — fixed known test vectors (domain separator)", () => {
  it("matches the frozen digest for (\"ws-1\", \"uid-1\")", () => {
    expect(computeMembershipId("ws-1", "uid-1")).toBe("wm_c556c38380a85910a9ab192e77fa819b163b557e4e800594a0abde47677a96e6");
  });

  it("matches the frozen digest for (\"\", \"\")", () => {
    expect(computeMembershipId("", "")).toBe("wm_455364171bbc8d716a2dedabdf673b55354aeb91ea7557cedd5c7ff2ae1a5f3d");
  });

  it("matches the frozen digest for (\"acme-workspace\", \"U1a2b3c\")", () => {
    expect(computeMembershipId("acme-workspace", "U1a2b3c")).toBe("wm_0bf6c53562aaf329e55075420e8e78567588a45e4f2039d20f4989e0010ac53d");
  });

  /**
   * The fixed vectors above all use ASCII inputs, where UTF-8 byte length
   * and JS `string.length` (UTF-16 code units) happen to be numerically
   * identical — so they cannot, by themselves, catch a regression that
   * swaps `Buffer.byteLength(value, "utf8")` for `value.length` in the
   * length-prefix computation. "ws-😀" is byte length 7 (UTF-8: 3 ASCII
   * bytes + a 4-byte emoji) but JS `string.length` 5 (3 ASCII + a 2-unit
   * surrogate pair) — a length-prefix bug would silently write the wrong
   * prefix and change the digest. This fixed vector pins the CORRECT
   * (byte-length) output; a char-length regression produces a different,
   * specifically-known-wrong digest instead (asserted as a negative).
   */
  it("matches the frozen digest for a multibyte workspaceId (\"ws-😀\", \"uid-1\") — proves UTF-8 byte length, not JS string.length, is used", () => {
    expect(computeMembershipId("ws-😀", "uid-1")).toBe("wm_f859c2ae1e99e8a453919ff0ab264bd674d478f8951703bc03ae7b3c18344529");
    expect(computeMembershipId("ws-😀", "uid-1")).not.toBe("wm_c60c7e1abd0639fa670c0a58144d78f96f80528ee8629296a8497d55e712415a"); // pinned — the value a JS-string-length-instead-of-byte-length mutation would actually produce
  });

  it("does NOT equal the digest computed WITHOUT the domain separator for the same tuple — removing/omitting the separator would silently change every id", () => {
    const withoutSeparatorPrefix = (workspaceId: string, uid: string) => {
      const lengthPrefixed = (value: string) => {
        const bytes = Buffer.from(value, "utf8");
        const prefix = Buffer.alloc(4);
        prefix.writeUInt32BE(bytes.byteLength, 0);
        return Buffer.concat([prefix, bytes]);
      };
      const canonicalBytes = Buffer.concat([lengthPrefixed(workspaceId), lengthPrefixed(uid)]);
      return "wm_" + createHash("sha256").update(canonicalBytes).digest("hex");
    };
    const real = computeMembershipId("ws-1", "uid-1");
    const withoutSeparator = withoutSeparatorPrefix("ws-1", "uid-1");
    expect(real).not.toBe(withoutSeparator);
    expect(withoutSeparator).toBe("wm_dfbd61eeb18da40a4bd43803afc8c9188052ec37020d70ad87beac1d784b0b3b"); // pinned — the value a domain-separator-omission mutation would actually produce
  });

  it("does NOT equal a digest computed with a DIFFERENT domain separator string for the same tuple", () => {
    const withDifferentSeparator = (separator: string, workspaceId: string, uid: string) => {
      const lengthPrefixed = (value: string) => {
        const bytes = Buffer.from(value, "utf8");
        const prefix = Buffer.alloc(4);
        prefix.writeUInt32BE(bytes.byteLength, 0);
        return Buffer.concat([prefix, bytes]);
      };
      const canonicalBytes = Buffer.concat([Buffer.from(separator, "utf8"), lengthPrefixed(workspaceId), lengthPrefixed(uid)]);
      return "wm_" + createHash("sha256").update(canonicalBytes).digest("hex");
    };
    const real = computeMembershipId("ws-1", "uid-1");
    const wrongVersion = withDifferentSeparator("convergepanel.workspace-membership.v2", "ws-1", "uid-1");
    const wrongDomain = withDifferentSeparator("convergepanel.something-else.v1", "ws-1", "uid-1");
    expect(real).not.toBe(wrongVersion);
    expect(real).not.toBe(wrongDomain);
  });
});

describe("computeMembershipId", () => {
  it("is deterministic — same tuple => same id", () => {
    const a = computeMembershipId("ws-1", "uid-1");
    const b = computeMembershipId("ws-1", "uid-1");
    expect(a).toBe(b);
  });

  it("differs when workspaceId differs", () => {
    const a = computeMembershipId("ws-1", "uid-1");
    const b = computeMembershipId("ws-2", "uid-1");
    expect(a).not.toBe(b);
  });

  it("differs when uid differs", () => {
    const a = computeMembershipId("ws-1", "uid-1");
    const b = computeMembershipId("ws-1", "uid-2");
    expect(a).not.toBe(b);
  });

  it("has the expected prefix, length, and character set", () => {
    const id = computeMembershipId("ws-1", "uid-1");
    expect(id.startsWith("wm_")).toBe(true);
    expect(id).toHaveLength(67);
    expect(id).toMatch(/^wm_[0-9a-f]{64}$/);
  });

  it("does not alias across a naive delimiter-based scheme — length-prefixing prevents boundary confusion", () => {
    // Without length-prefixing, a naive `${workspaceId}:${uid}` join would
    // alias ("a:b", "c") and ("a", "b:c") to the same string. The
    // length-prefixed encoding must keep these distinct.
    const a = computeMembershipId("a:b", "c");
    const b = computeMembershipId("a", "b:c");
    expect(a).not.toBe(b);
  });

  it("does not alias when a value looks like it could shift byte boundaries", () => {
    const a = computeMembershipId("ab", "cd");
    const b = computeMembershipId("a", "bcd");
    const c = computeMembershipId("abc", "d");
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it("serializes multibyte/Unicode values using UTF-8 byte length, not JS string length", () => {
    // "😀" is 1 JS UTF-16 "character" position by naive indexing intuition
    // but is actually a surrogate pair (string.length === 2) and 4 UTF-8
    // bytes. Two different emoji-bearing tuples must still resolve to
    // distinct, stable ids.
    const a = computeMembershipId("ws-😀", "uid-1");
    const b = computeMembershipId("ws-😀", "uid-1");
    const c = computeMembershipId("ws-😀😀", "uid-1");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(isWellFormedMembershipId(a)).toBe(true);
  });

  it("handles a mix of multibyte CJK and Latin values without collision", () => {
    const a = computeMembershipId("工作区-1", "用户-1");
    const b = computeMembershipId("工作区-1", "用户-2");
    expect(a).not.toBe(b);
    expect(isWellFormedMembershipId(a)).toBe(true);
  });
});

describe("isWellFormedMembershipId", () => {
  it("accepts a genuinely computed id", () => {
    expect(isWellFormedMembershipId(computeMembershipId("ws-1", "uid-1"))).toBe(true);
  });

  it("rejects malformed shapes", () => {
    expect(isWellFormedMembershipId("not-an-id")).toBe(false);
    expect(isWellFormedMembershipId("wm_" + "a".repeat(63))).toBe(false); // too short
    expect(isWellFormedMembershipId("wm_" + "A".repeat(64))).toBe(false); // uppercase hex
    expect(isWellFormedMembershipId("wp_" + "a".repeat(64))).toBe(false); // wrong prefix
    expect(isWellFormedMembershipId(null)).toBe(false);
    expect(isWellFormedMembershipId(undefined)).toBe(false);
    expect(isWellFormedMembershipId(12345)).toBe(false);
  });
});
