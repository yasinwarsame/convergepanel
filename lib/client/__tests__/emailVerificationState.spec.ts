/**
 * Phase P0.2-VEMAIL-C2 — the shared, UID-scoped state contract.
 *
 * The review found the old key was global and its literal duplicated four times
 * across two files, with nothing binding the signup writer to the notice
 * reader. These exercise the REAL helper both halves now import.
 */

const installStorage = (initial: Record<string, string> = {}) => {
  const data = { ...initial };
  const store = {
    getItem: jest.fn((k: string) => (k in data ? data[k] : null)),
    setItem: jest.fn((k: string, v: string) => { data[k] = v; }),
    removeItem: jest.fn((k: string) => { delete data[k]; }),
    _data: data,
  };
  Object.defineProperty(globalThis, "sessionStorage", { value: store, configurable: true, writable: true });
  return store;
};
const removeStorage = () => {
  Object.defineProperty(globalThis, "sessionStorage", {
    get() { throw new Error("SecurityError"); },
    configurable: true,
  });
};

import {
  clearEmailVerificationSendState,
  emailVerificationStateKey,
  readEmailVerificationSendState,
  writeEmailVerificationSendState,
} from "../emailVerificationState";

beforeEach(() => { installStorage(); });

describe("UID scoping — one account's state is never another's", () => {
  it("THE FIX: state written for A is not readable as B's", () => {
    writeEmailVerificationSendState("uid-A", "send_failed");
    expect(readEmailVerificationSendState("uid-A")).toBe("send_failed");
    expect(readEmailVerificationSendState("uid-B")).toBeNull();
  });

  it("the key embeds the uid", () => {
    expect(emailVerificationStateKey("uid-A")).toContain("uid-A");
    expect(emailVerificationStateKey("uid-A")).not.toBe(emailVerificationStateKey("uid-B"));
  });

  it("two accounts hold independent state simultaneously", () => {
    writeEmailVerificationSendState("uid-A", "send_failed");
    writeEmailVerificationSendState("uid-B", "send_accepted");
    expect(readEmailVerificationSendState("uid-A")).toBe("send_failed");
    expect(readEmailVerificationSendState("uid-B")).toBe("send_accepted");
  });

  it("clearing one account does not clear another", () => {
    writeEmailVerificationSendState("uid-A", "send_failed");
    writeEmailVerificationSendState("uid-B", "send_failed");
    clearEmailVerificationSendState("uid-A");
    expect(readEmailVerificationSendState("uid-A")).toBeNull();
    expect(readEmailVerificationSendState("uid-B")).toBe("send_failed");
  });
});

describe("robustness", () => {
  it("an empty uid neither reads nor writes", () => {
    const s = installStorage();
    writeEmailVerificationSendState("", "send_failed");
    expect(s.setItem).not.toHaveBeenCalled();
    expect(readEmailVerificationSendState("")).toBeNull();
  });

  it("unrecognised stored values are ignored rather than trusted", () => {
    installStorage({ [emailVerificationStateKey("uid-A")]: "verified" });
    expect(readEmailVerificationSendState("uid-A")).toBeNull();
  });

  it("unavailable storage never throws, in any direction", () => {
    removeStorage();
    expect(() => writeEmailVerificationSendState("uid-A", "send_failed")).not.toThrow();
    expect(readEmailVerificationSendState("uid-A")).toBeNull();
    expect(() => clearEmailVerificationSendState("uid-A")).not.toThrow();
  });

  it("stores only a discriminant — no address, token, link or code", () => {
    const s = installStorage();
    writeEmailVerificationSendState("uid-A", "send_failed");
    const written = JSON.stringify(s._data);
    expect(written).toContain("send_failed");
    expect(written).not.toMatch(/@|oobCode|token|https?:|password/i);
  });
});
