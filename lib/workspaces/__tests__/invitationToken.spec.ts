import { generateWorkspaceInvitationToken, hashWorkspaceInvitationToken, verifyWorkspaceInvitationToken, isWellFormedInvitationTokenHash } from "../invitationToken";

describe("generateWorkspaceInvitationToken", () => {
  it("produces a non-empty token", () => {
    const token = generateWorkspaceInvitationToken();
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);
  });

  it("produces a URL-safe token (base64url alphabet only, no padding)", () => {
    const token = generateWorkspaceInvitationToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("produces distinct values on successive calls", () => {
    const a = generateWorkspaceInvitationToken();
    const b = generateWorkspaceInvitationToken();
    expect(a).not.toBe(b);
  });

  it("32 raw bytes base64url-encode to 43 characters (no padding)", () => {
    const token = generateWorkspaceInvitationToken();
    expect(token.length).toBe(43);
  });
});

describe("hashWorkspaceInvitationToken", () => {
  it("is deterministic for the same input", () => {
    const token = generateWorkspaceInvitationToken();
    expect(hashWorkspaceInvitationToken(token)).toBe(hashWorkspaceInvitationToken(token));
  });

  it("produces the exact SHA-256 hex shape", () => {
    const token = generateWorkspaceInvitationToken();
    const hash = hashWorkspaceInvitationToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the raw token never equals its own stored hash", () => {
    const token = generateWorkspaceInvitationToken();
    const hash = hashWorkspaceInvitationToken(token);
    expect(hash).not.toBe(token);
  });
});

describe("verifyWorkspaceInvitationToken", () => {
  it("the correct raw token verifies against its own hash", () => {
    const token = generateWorkspaceInvitationToken();
    const hash = hashWorkspaceInvitationToken(token);
    expect(verifyWorkspaceInvitationToken({ rawToken: token, storedTokenHash: hash })).toBe(true);
  });

  it("a wrong raw token fails verification", () => {
    const token = generateWorkspaceInvitationToken();
    const hash = hashWorkspaceInvitationToken(token);
    const wrongToken = generateWorkspaceInvitationToken();
    expect(verifyWorkspaceInvitationToken({ rawToken: wrongToken, storedTokenHash: hash })).toBe(false);
  });

  it("a malformed stored hash (wrong shape) fails closed rather than throwing", () => {
    const token = generateWorkspaceInvitationToken();
    expect(() => verifyWorkspaceInvitationToken({ rawToken: token, storedTokenHash: "not-a-hash" })).not.toThrow();
    expect(verifyWorkspaceInvitationToken({ rawToken: token, storedTokenHash: "not-a-hash" })).toBe(false);
  });

  it("a wrong-length stored hash fails closed rather than throwing", () => {
    const token = generateWorkspaceInvitationToken();
    const shortHash = hashWorkspaceInvitationToken(token).slice(0, 32);
    expect(() => verifyWorkspaceInvitationToken({ rawToken: token, storedTokenHash: shortHash })).not.toThrow();
    expect(verifyWorkspaceInvitationToken({ rawToken: token, storedTokenHash: shortHash })).toBe(false);
  });

  it("an uppercase-hex stored hash (malformed shape per the lowercase-only contract) fails closed", () => {
    const token = generateWorkspaceInvitationToken();
    const hash = hashWorkspaceInvitationToken(token).toUpperCase();
    expect(verifyWorkspaceInvitationToken({ rawToken: token, storedTokenHash: hash })).toBe(false);
  });

  it("exercises the timing-safe comparison path for two same-length, non-equal digests without throwing", () => {
    const tokenA = generateWorkspaceInvitationToken();
    const tokenB = generateWorkspaceInvitationToken();
    const hashA = hashWorkspaceInvitationToken(tokenA);
    // Verifying tokenB against hashA: both hashes are well-formed 64-char
    // hex (same byte length), so this path reaches the actual
    // timingSafeEqual() call rather than short-circuiting on shape/length.
    expect(verifyWorkspaceInvitationToken({ rawToken: tokenB, storedTokenHash: hashA })).toBe(false);
  });
});

describe("isWellFormedInvitationTokenHash", () => {
  it("accepts a genuine SHA-256 hex digest", () => {
    const token = generateWorkspaceInvitationToken();
    expect(isWellFormedInvitationTokenHash(hashWorkspaceInvitationToken(token))).toBe(true);
  });

  it("rejects non-string input", () => {
    expect(isWellFormedInvitationTokenHash(42)).toBe(false);
    expect(isWellFormedInvitationTokenHash(null)).toBe(false);
  });

  it("rejects wrong length", () => {
    expect(isWellFormedInvitationTokenHash("abc123")).toBe(false);
  });
});
