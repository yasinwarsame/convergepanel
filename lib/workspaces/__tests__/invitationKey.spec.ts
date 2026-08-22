import { computeWorkspaceInvitationKey, isWellFormedInvitationKey } from "../invitationKey";
import { computeMembershipId } from "../membershipId";

describe("computeWorkspaceInvitationKey", () => {
  it("is deterministic — same tuple produces the same key", () => {
    const a = computeWorkspaceInvitationKey("ws-1", "user@example.com");
    const b = computeWorkspaceInvitationKey("ws-1", "user@example.com");
    expect(a).toBe(b);
  });

  it("different workspaceId produces a different key", () => {
    const a = computeWorkspaceInvitationKey("ws-1", "user@example.com");
    const b = computeWorkspaceInvitationKey("ws-2", "user@example.com");
    expect(a).not.toBe(b);
  });

  it("different normalizedEmail produces a different key", () => {
    const a = computeWorkspaceInvitationKey("ws-1", "user@example.com");
    const b = computeWorkspaceInvitationKey("ws-1", "other@example.com");
    expect(a).not.toBe(b);
  });

  it("ambiguous delimiter-like strings produce different keys (length-prefixed encoding is injective)", () => {
    // Without length-prefixing, ("ab", "c") and ("a", "bc") could collide
    // under naive concatenation. Length-prefixing prevents this.
    const a = computeWorkspaceInvitationKey("ab", "c@example.com");
    const b = computeWorkspaceInvitationKey("a", "bc@example.com");
    expect(a).not.toBe(b);
  });

  it("output has the wik_ prefix and 64 lowercase hex characters", () => {
    const key = computeWorkspaceInvitationKey("ws-1", "user@example.com");
    expect(key).toMatch(/^wik_[0-9a-f]{64}$/);
    expect(key.length).toBe(68);
  });

  it("throws on empty workspaceId", () => {
    expect(() => computeWorkspaceInvitationKey("", "user@example.com")).toThrow();
  });

  it("throws on empty normalizedEmail", () => {
    expect(() => computeWorkspaceInvitationKey("ws-1", "")).toThrow();
  });

  it("domain separation means the key output never equals computeMembershipId's output for analogous textual values", () => {
    const invitationKey = computeWorkspaceInvitationKey("tuple-1", "tuple-2");
    const membershipId = computeMembershipId("tuple-1", "tuple-2");
    // Different prefixes alone would already distinguish them, but the
    // underlying hex digest (after the prefix) must also differ, proving
    // domain separation operates on the HASHED bytes, not merely the
    // display prefix.
    expect(invitationKey.slice(4)).not.toBe(membershipId.slice(3));
  });
});

describe("isWellFormedInvitationKey", () => {
  it("accepts a well-formed key", () => {
    const key = computeWorkspaceInvitationKey("ws-1", "user@example.com");
    expect(isWellFormedInvitationKey(key)).toBe(true);
  });

  it("rejects wrong prefix", () => {
    const key = computeWorkspaceInvitationKey("ws-1", "user@example.com");
    expect(isWellFormedInvitationKey(key.replace("wik_", "wm_"))).toBe(false);
  });

  it("rejects wrong hex length", () => {
    expect(isWellFormedInvitationKey("wik_abc123")).toBe(false);
  });

  it("rejects uppercase hex", () => {
    const key = computeWorkspaceInvitationKey("ws-1", "user@example.com");
    expect(isWellFormedInvitationKey(key.toUpperCase())).toBe(false);
  });

  it("rejects non-string input", () => {
    expect(isWellFormedInvitationKey(42)).toBe(false);
    expect(isWellFormedInvitationKey(null)).toBe(false);
  });
});
