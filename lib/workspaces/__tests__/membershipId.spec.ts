import { computeMembershipId, isWellFormedMembershipId } from "@/lib/workspaces/membershipId";

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
