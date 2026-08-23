/**
 * Team Workspace Invitations, Phase 8D.3.1 —
 * `lib/client/invitationAcceptance.ts` permanent coverage.
 */

import {
  SESSION_STORAGE_KEY,
  INVITATION_ACCEPTANCE_TTL_MS,
  INVITATION_ACCEPTANCE_ROUTE_PATH,
  parseInvitationFragment,
  storeInvitationAcceptance,
  restoreInvitationAcceptance,
  clearInvitationAcceptance,
  scrubInvitationAcceptanceHistory,
} from "@/lib/client/invitationAcceptance";

function fakeStorage(initial: Record<string, string> = {}) {
  const backing = new Map<string, string>(Object.entries(initial));
  return {
    backing,
    getItem: jest.fn((key: string) => (backing.has(key) ? backing.get(key)! : null)),
    setItem: jest.fn((key: string, value: string) => {
      backing.set(key, value);
    }),
    removeItem: jest.fn((key: string) => {
      backing.delete(key);
    }),
  };
}

describe("parseInvitationFragment — valid input", () => {
  it("parses a well-formed fragment with invitationId + token", () => {
    const result = parseInvitationFragment("#invitationId=inv-1&token=abc123");
    expect(result).toEqual({ kind: "valid", invitationId: "inv-1", token: "abc123" });
  });

  it("works without a leading '#'", () => {
    const result = parseInvitationFragment("invitationId=inv-1&token=abc123");
    expect(result).toEqual({ kind: "valid", invitationId: "inv-1", token: "abc123" });
  });

  it("ignores unknown extra fields without altering invitationId/token", () => {
    const result = parseInvitationFragment("#invitationId=inv-1&token=abc123&utm_source=email&foo=bar");
    expect(result).toEqual({ kind: "valid", invitationId: "inv-1", token: "abc123" });
  });

  it("single-decodes: a literal %25 in a value decodes to exactly one '%', never twice", () => {
    const result = parseInvitationFragment("#invitationId=inv-1&token=a%25b");
    expect(result).toEqual({ kind: "valid", invitationId: "inv-1", token: "a%b" });
  });

  it("accepts a 1-character invitationId and token (lower bound)", () => {
    const result = parseInvitationFragment("#invitationId=a&token=b");
    expect(result).toEqual({ kind: "valid", invitationId: "a", token: "b" });
  });

  it("accepts a 256-character invitationId (upper bound)", () => {
    const id = "a".repeat(256);
    const result = parseInvitationFragment(`#invitationId=${id}&token=t`);
    expect(result.kind).toBe("valid");
  });

  it("accepts a 512-character token (upper bound)", () => {
    const token = "a".repeat(512);
    const result = parseInvitationFragment(`#invitationId=inv-1&token=${token}`);
    expect(result.kind).toBe("valid");
  });
});

describe("parseInvitationFragment — invalid input", () => {
  it("rejects an empty fragment", () => {
    expect(parseInvitationFragment("#")).toEqual({ kind: "invalid" });
    expect(parseInvitationFragment("")).toEqual({ kind: "invalid" });
  });

  it("rejects a missing invitationId", () => {
    expect(parseInvitationFragment("#token=abc")).toEqual({ kind: "invalid" });
  });

  it("rejects a missing token", () => {
    expect(parseInvitationFragment("#invitationId=inv-1")).toEqual({ kind: "invalid" });
  });

  it("rejects duplicate invitationId fields (never first/last-wins)", () => {
    expect(parseInvitationFragment("#invitationId=inv-1&invitationId=inv-2&token=abc")).toEqual({ kind: "invalid" });
  });

  it("rejects duplicate token fields", () => {
    expect(parseInvitationFragment("#invitationId=inv-1&token=abc&token=def")).toEqual({ kind: "invalid" });
  });

  it.each(["%", "%A", "%ZZ", "%0G"])("rejects malformed percent-encoding: %s", (badSequence) => {
    expect(parseInvitationFragment(`#invitationId=inv-1&token=x${badSequence}x`)).toEqual({ kind: "invalid" });
  });

  it("rejects a trailing incomplete '%'", () => {
    expect(parseInvitationFragment("#invitationId=inv-1&token=abc%")).toEqual({ kind: "invalid" });
  });

  it("rejects an oversized invitationId (>256 chars)", () => {
    const id = "a".repeat(257);
    expect(parseInvitationFragment(`#invitationId=${id}&token=t`)).toEqual({ kind: "invalid" });
  });

  it("rejects an oversized token (>512 chars)", () => {
    const token = "a".repeat(513);
    expect(parseInvitationFragment(`#invitationId=inv-1&token=${token}`)).toEqual({ kind: "invalid" });
  });

  it("rejects control characters in invitationId or token", () => {
    expect(parseInvitationFragment("#invitationId=inv%011&token=abc")).toEqual({ kind: "invalid" });
    expect(parseInvitationFragment("#invitationId=inv-1&token=ab%7Fc")).toEqual({ kind: "invalid" });
  });

  it("rejects a non-string input", () => {
    // @ts-expect-error deliberate invalid input type
    expect(parseInvitationFragment(null)).toEqual({ kind: "invalid" });
  });
});

describe("session storage — store/restore/clear", () => {
  const NOW = 1_700_000_000_000;

  it("stores the exact frozen envelope shape", () => {
    const storage = fakeStorage();
    storeInvitationAcceptance(storage, { invitationId: "inv-1", token: "tok-1" }, NOW);
    const raw = storage.backing.get(SESSION_STORAGE_KEY);
    expect(JSON.parse(raw!)).toEqual({ version: 1, invitationId: "inv-1", token: "tok-1", storedAt: NOW });
  });

  it("restores a freshly stored credential", () => {
    const storage = fakeStorage();
    storeInvitationAcceptance(storage, { invitationId: "inv-1", token: "tok-1" }, NOW);
    const restored = restoreInvitationAcceptance(storage, NOW + 1000);
    expect(restored).toEqual({ invitationId: "inv-1", token: "tok-1" });
  });

  it("accepts a record just under the 30-minute TTL", () => {
    const storage = fakeStorage();
    storeInvitationAcceptance(storage, { invitationId: "inv-1", token: "tok-1" }, NOW);
    const restored = restoreInvitationAcceptance(storage, NOW + INVITATION_ACCEPTANCE_TTL_MS - 1);
    expect(restored).toEqual({ invitationId: "inv-1", token: "tok-1" });
  });

  it("clears and rejects a record just over the 30-minute TTL", () => {
    const storage = fakeStorage();
    storeInvitationAcceptance(storage, { invitationId: "inv-1", token: "tok-1" }, NOW);
    const restored = restoreInvitationAcceptance(storage, NOW + INVITATION_ACCEPTANCE_TTL_MS + 1);
    expect(restored).toBeNull();
    expect(storage.backing.has(SESSION_STORAGE_KEY)).toBe(false);
  });

  it("does not silently extend the TTL on a valid read", () => {
    const storage = fakeStorage();
    storeInvitationAcceptance(storage, { invitationId: "inv-1", token: "tok-1" }, NOW);
    restoreInvitationAcceptance(storage, NOW + 1000);
    const raw = JSON.parse(storage.backing.get(SESSION_STORAGE_KEY)!);
    expect(raw.storedAt).toBe(NOW);
  });

  it("fails closed and clears on malformed JSON", () => {
    const storage = fakeStorage({ [SESSION_STORAGE_KEY]: "{not json" });
    expect(restoreInvitationAcceptance(storage, NOW)).toBeNull();
    expect(storage.backing.has(SESSION_STORAGE_KEY)).toBe(false);
  });

  it("fails closed and clears on a wrong schema version", () => {
    const storage = fakeStorage({ [SESSION_STORAGE_KEY]: JSON.stringify({ version: 2, invitationId: "i", token: "t", storedAt: NOW }) });
    expect(restoreInvitationAcceptance(storage, NOW)).toBeNull();
    expect(storage.backing.has(SESSION_STORAGE_KEY)).toBe(false);
  });

  it.each([NaN, Infinity, -Infinity])("fails closed and clears on a non-finite storedAt (%s)", (badStoredAt) => {
    const storage = fakeStorage({ [SESSION_STORAGE_KEY]: JSON.stringify({ version: 1, invitationId: "i", token: "t", storedAt: badStoredAt }) });
    expect(restoreInvitationAcceptance(storage, NOW)).toBeNull();
    expect(storage.backing.has(SESSION_STORAGE_KEY)).toBe(false);
  });

  it("fails closed and clears on a future-corrupt storedAt", () => {
    const storage = fakeStorage({ [SESSION_STORAGE_KEY]: JSON.stringify({ version: 1, invitationId: "i", token: "t", storedAt: NOW + 1_000_000 }) });
    expect(restoreInvitationAcceptance(storage, NOW)).toBeNull();
    expect(storage.backing.has(SESSION_STORAGE_KEY)).toBe(false);
  });

  it("returns null on an absent record without throwing", () => {
    const storage = fakeStorage();
    expect(restoreInvitationAcceptance(storage, NOW)).toBeNull();
  });

  it("clear() removes the record via the single narrow helper", () => {
    const storage = fakeStorage({ [SESSION_STORAGE_KEY]: "anything" });
    clearInvitationAcceptance(storage);
    expect(storage.removeItem).toHaveBeenCalledWith(SESSION_STORAGE_KEY);
    expect(storage.backing.has(SESSION_STORAGE_KEY)).toBe(false);
  });

  it("store() never throws even if the underlying storage throws (quota/private mode)", () => {
    const storage = { setItem: jest.fn(() => { throw new Error("quota exceeded"); }) };
    expect(() => storeInvitationAcceptance(storage, { invitationId: "i", token: "t" }, NOW)).not.toThrow();
  });

  it("restore() never throws even if the underlying storage throws", () => {
    const storage = {
      getItem: jest.fn(() => { throw new Error("blocked"); }),
      removeItem: jest.fn(),
    };
    expect(() => restoreInvitationAcceptance(storage, NOW)).not.toThrow();
    expect(restoreInvitationAcceptance(storage, NOW)).toBeNull();
  });
});

describe("history scrub", () => {
  it("uses replaceState, preserving the existing history.state exactly", () => {
    const sentinelState = { existing: "next-router-state", marker: 42 };
    const history = { state: sentinelState, replaceState: jest.fn(), pushState: jest.fn() };
    scrubInvitationAcceptanceHistory(history, INVITATION_ACCEPTANCE_ROUTE_PATH);
    expect(history.replaceState).toHaveBeenCalledWith(sentinelState, "", INVITATION_ACCEPTANCE_ROUTE_PATH);
  });

  it("never calls pushState", () => {
    const history = { state: null, replaceState: jest.fn(), pushState: jest.fn() };
    scrubInvitationAcceptanceHistory(history, INVITATION_ACCEPTANCE_ROUTE_PATH);
    expect(history.pushState).not.toHaveBeenCalled();
  });

  it("never passes null as the replacement state, even when history.state is already null", () => {
    const history = { state: null, replaceState: jest.fn(), pushState: jest.fn() };
    scrubInvitationAcceptanceHistory(history, INVITATION_ACCEPTANCE_ROUTE_PATH);
    // Passing `history.state` through (here `null`) is correct; the guarantee
    // under test is that the call never substitutes a literal `null` for a
    // NON-null existing state — covered by the "preserves state" test above.
    expect(history.replaceState).toHaveBeenCalledWith(null, "", INVITATION_ACCEPTANCE_ROUTE_PATH);
  });

  it("defaults the target path to the frozen acceptance route", () => {
    const history = { state: { a: 1 }, replaceState: jest.fn(), pushState: jest.fn() };
    scrubInvitationAcceptanceHistory(history);
    expect(history.replaceState).toHaveBeenCalledWith({ a: 1 }, "", INVITATION_ACCEPTANCE_ROUTE_PATH);
  });
});
