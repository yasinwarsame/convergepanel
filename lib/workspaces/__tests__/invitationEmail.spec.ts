import { normalizeInvitationEmail, isValidNormalizedInvitationEmail } from "../invitationEmail";

describe("normalizeInvitationEmail", () => {
  it("valid ordinary email passes through", () => {
    expect(normalizeInvitationEmail("user@example.com")).toEqual({ ok: true, normalizedEmail: "user@example.com" });
  });

  it("uppercase is lowercased", () => {
    expect(normalizeInvitationEmail("User@Example.COM")).toEqual({ ok: true, normalizedEmail: "user@example.com" });
  });

  it("surrounding whitespace is trimmed", () => {
    expect(normalizeInvitationEmail("  user@example.com  ")).toEqual({ ok: true, normalizedEmail: "user@example.com" });
  });

  it("empty string is invalid", () => {
    expect(normalizeInvitationEmail("")).toEqual({ ok: false });
  });

  it("whitespace-only is invalid", () => {
    expect(normalizeInvitationEmail("   ")).toEqual({ ok: false });
  });

  it("non-string input is invalid", () => {
    expect(normalizeInvitationEmail(42)).toEqual({ ok: false });
    expect(normalizeInvitationEmail(null)).toEqual({ ok: false });
    expect(normalizeInvitationEmail(undefined)).toEqual({ ok: false });
    expect(normalizeInvitationEmail({})).toEqual({ ok: false });
  });

  it("missing @ is invalid", () => {
    expect(normalizeInvitationEmail("userexample.com")).toEqual({ ok: false });
  });

  it("missing local part is invalid", () => {
    expect(normalizeInvitationEmail("@example.com")).toEqual({ ok: false });
  });

  it("missing domain is invalid", () => {
    expect(normalizeInvitationEmail("user@")).toEqual({ ok: false });
  });

  it("missing dot/domain suffix is invalid", () => {
    expect(normalizeInvitationEmail("user@example")).toEqual({ ok: false });
  });

  it("internal whitespace is invalid", () => {
    expect(normalizeInvitationEmail("us er@example.com")).toEqual({ ok: false });
    expect(normalizeInvitationEmail("user@ example.com")).toEqual({ ok: false });
  });

  it("plus addressing is preserved, never stripped", () => {
    expect(normalizeInvitationEmail("user+tag@example.com")).toEqual({ ok: true, normalizedEmail: "user+tag@example.com" });
  });

  it("dots in the local part are preserved, never stripped", () => {
    expect(normalizeInvitationEmail("first.last@example.com")).toEqual({ ok: true, normalizedEmail: "first.last@example.com" });
  });

  it("multiple @ characters — first is treated as the local/domain boundary by the shape regex, not rejected merely for a second @ inside the domain-looking segment (documented minimal-shape behavior)", () => {
    // The frozen minimal shape /^[^\s@]+@[^\s@]+\.[^\s@]+$/ requires
    // exactly one @ overall (each character class excludes @) — a second
    // @ anywhere makes the whole string fail the shape, since no
    // remaining segment can satisfy [^\s@]+ across it.
    expect(normalizeInvitationEmail("user@@example.com")).toEqual({ ok: false });
    expect(normalizeInvitationEmail("us@er@example.com")).toEqual({ ok: false });
  });
});

describe("isValidNormalizedInvitationEmail", () => {
  it("accepts an already-normalized value", () => {
    expect(isValidNormalizedInvitationEmail("user@example.com")).toBe(true);
  });

  it("rejects a non-normalized (uppercase) value", () => {
    expect(isValidNormalizedInvitationEmail("User@Example.com")).toBe(false);
  });

  it("rejects a non-trimmed value", () => {
    expect(isValidNormalizedInvitationEmail(" user@example.com")).toBe(false);
  });

  it("rejects a non-string value", () => {
    expect(isValidNormalizedInvitationEmail(42)).toBe(false);
    expect(isValidNormalizedInvitationEmail(null)).toBe(false);
  });

  it("rejects a shape-invalid value even if already lowercased/trimmed", () => {
    expect(isValidNormalizedInvitationEmail("not-an-email")).toBe(false);
  });
});
