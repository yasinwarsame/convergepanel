/**
 * Privacy remediation (round 2, review B1) — the /verify pending input:
 * bounded, expiring, one-time, tab-scoped, identity-bound. Synthetic data only.
 */
import {
  LEGACY_VERIFY_PREFILL_STORAGE_KEY,
  MAX_PENDING_CHARS,
  PENDING_TTL_MS,
  VERIFY_PENDING_STORAGE_KEY,
  capturePendingVerifyInput,
  clearPendingVerifyInputOnSignOut,
  consumePendingVerifyInput,
  readVisiblePendingVerifyInput,
  reconcilePendingVerifyInputForIdentity,
  sweepTabHandoffs,
  updatePendingVerifyInput,
  verifyReturnPath,
} from "@/lib/client/verifyPrefill";
import { FakeStorage } from "./helpers/fakeStorage";

const CLAIM = "SYNTHETIC_CLAIM_R2: drinking seawater cures thirst & more?";
const T0 = 1_800_000_000_000;

function env(search: string, hash = "", currentUid: string | null = null, storage = new FakeStorage()) {
  const state = { __NA: true, tree: "synthetic" };
  const replaceState = jest.fn();
  return { location: { pathname: "/verify", search, hash }, history: { state, replaceState }, storage, replaceState, state, currentUid, now: T0 };
}
function stored(s: FakeStorage) {
  const raw = s.getItem(VERIFY_PENDING_STORAGE_KEY);
  return raw === null ? null : JSON.parse(raw);
}

describe("capture", () => {
  // R4 (review MINOR-2): the rewrite keeps custom history state but drops Next's `__NA` marker, so Next's patched
  // replaceState syncs its router to the clean URL (it re-adds `__NA` and the tree itself).
  it("extension link (anonymous): returns the text, stores an UNBOUND record with expiry, strips ONLY text, keeps custom history state", () => {
    const e = env(`?source=extension&text=${encodeURIComponent(CLAIM)}`);
    expect(capturePendingVerifyInput(e)).toBe(CLAIM);
    expect(stored(e.storage)).toEqual({ v: 2, text: CLAIM, boundUid: null, expiresAt: T0 + PENDING_TTL_MS });
    expect(e.replaceState).toHaveBeenCalledWith({ tree: "synthetic" }, "", "/verify?source=extension");
    expect(JSON.stringify(e.replaceState.mock.calls)).not.toContain("seawater");
  });

  it("extension link (signed in): the record is bound to the current account", () => {
    const e = env(`?text=${encodeURIComponent(CLAIM)}`, "", "uid-a");
    capturePendingVerifyInput(e);
    expect(stored(e.storage).boundUid).toBe("uid-a");
  });

  it("accepts a #text= fragment and strips the fragment", () => {
    const e = env("?source=extension", `#text=${encodeURIComponent(CLAIM)}`);
    expect(capturePendingVerifyInput(e)).toBe(CLAIM);
    expect(e.replaceState).toHaveBeenCalledWith({ tree: "synthetic" }, "", "/verify?source=extension");
  });

  it("caps the stored and returned text at MAX_PENDING_CHARS", () => {
    const long = "A".repeat(MAX_PENDING_CHARS + 500);
    const e = env(`?text=${long}`);
    expect(capturePendingVerifyInput(e).length).toBe(MAX_PENDING_CHARS);
    expect(stored(e.storage).text.length).toBe(MAX_PENDING_CHARS);
  });

  it("back from the detour (no text in URL): restores the live record without touching history", () => {
    const s = new FakeStorage();
    capturePendingVerifyInput(env(`?text=${encodeURIComponent(CLAIM)}`, "", null, s));
    const back = env("?source=extension", "", null, s);
    expect(capturePendingVerifyInput({ ...back, now: T0 + PENDING_TTL_MS - 1 })).toBeNull(); // nothing arrived
    expect(back.replaceState).not.toHaveBeenCalled();
    expect(readVisiblePendingVerifyInput(s, null, T0 + PENDING_TTL_MS - 1)).toBe(CLAIM); // R3: display is derived
  });

  it("EXPIRY: a record past its TTL is never returned and is removed", () => {
    const s = new FakeStorage();
    capturePendingVerifyInput(env(`?text=${encodeURIComponent(CLAIM)}`, "", null, s));
    expect(readVisiblePendingVerifyInput(s, null, T0 + PENDING_TTL_MS)).toBe("");
    sweepTabHandoffs(s, T0 + PENDING_TTL_MS);
    expect(s.length).toBe(0);
  });

  it("a record with a forged far-future expiry, malformed JSON, wrong version or oversize text is removed, never returned", () => {
    for (const raw of [
      JSON.stringify({ v: 2, text: CLAIM, boundUid: null, expiresAt: T0 + PENDING_TTL_MS * 10 }),
      "{not json",
      JSON.stringify({ v: 1, text: CLAIM, boundUid: null, expiresAt: T0 + 1000 }),
      JSON.stringify({ v: 2, text: "A".repeat(MAX_PENDING_CHARS + 1), boundUid: null, expiresAt: T0 + 1000 }),
      JSON.stringify({ v: 2, text: CLAIM, boundUid: 7, expiresAt: T0 + 1000 }),
    ]) {
      const s = new FakeStorage();
      s.setItem(VERIFY_PENDING_STORAGE_KEY, raw);
      expect(readVisiblePendingVerifyInput(s, null, T0)).toBe("");
      sweepTabHandoffs(s, T0);
      expect(s.length).toBe(0);
    }
  });

  it("the round-1 legacy raw key is removed on sight and never read", () => {
    const s = new FakeStorage();
    s.setItem(LEGACY_VERIFY_PREFILL_STORAGE_KEY, CLAIM);
    expect(readVisiblePendingVerifyInput(s, null)).toBe("");
    sweepTabHandoffs(s);
    expect(s.length).toBe(0);
  });

  it("a record bound to account A is removed, not shown, when account B is signed in", () => {
    const s = new FakeStorage();
    capturePendingVerifyInput(env(`?text=${encodeURIComponent(CLAIM)}`, "", "uid-a", s));
    expect(readVisiblePendingVerifyInput(s, "uid-b", T0)).toBe(""); // never displayed to B
    expect(readVisiblePendingVerifyInput(s, null, T0)).toBe(""); // nor to an anonymous viewer
    expect(readVisiblePendingVerifyInput(s, undefined, T0)).toBe(""); // nor while identity is unknown
    expect(readVisiblePendingVerifyInput(s, "uid-a", T0)).toBe(CLAIM); // control
    reconcilePendingVerifyInputForIdentity(s, "uid-b", T0);
    expect(s.length).toBe(0);
  });

  it("control: a plain /verify visit returns '' and changes nothing; an empty ?text= is stripped", () => {
    const e = env("");
    expect(capturePendingVerifyInput(e)).toBeNull();
    expect(e.replaceState).not.toHaveBeenCalled();
    const e2 = env("?text=");
    expect(capturePendingVerifyInput(e2)).toBe("");
    expect(e2.replaceState).toHaveBeenCalledWith({ tree: "synthetic" }, "", "/verify");
    expect(e2.storage.length).toBe(0);
  });

  it("never throws when storage / history are unavailable — the text still prefills", () => {
    const throwing = { getItem: () => { throw new Error("x"); }, setItem: () => { throw new Error("x"); }, removeItem: () => { throw new Error("x"); } };
    expect(
      capturePendingVerifyInput({
        location: { pathname: "/verify", search: `?text=${encodeURIComponent(CLAIM)}`, hash: "" },
        history: { state: null, replaceState: () => { throw new Error("x"); } },
        storage: throwing,
        currentUid: null,
      })
    ).toBe(CLAIM);
    expect(capturePendingVerifyInput({ location: { pathname: "/verify", search: "", hash: "" }, history: null, storage: throwing, currentUid: null })).toBeNull();
    expect(() => consumePendingVerifyInput(throwing)).not.toThrow();
    expect(() => updatePendingVerifyInput(throwing, "x", null)).not.toThrow();
    expect(() => reconcilePendingVerifyInputForIdentity(throwing, "u")).not.toThrow();
  });
});

describe("identity binding", () => {
  function seeded(boundUid: string | null) {
    const s = new FakeStorage();
    capturePendingVerifyInput(env(`?text=${encodeURIComponent(CLAIM)}`, "", boundUid, s));
    return s;
  }

  it("an unbound (anonymous) record is claimed by the first account that signs in", () => {
    const s = seeded(null);
    reconcilePendingVerifyInputForIdentity(s, "uid-a", T0 + 1000);
    expect(stored(s).boundUid).toBe("uid-a");
    expect(stored(s).text).toBe(CLAIM);
  });

  it("a record bound to A survives A signing in again (reload / token refresh), and is removed for B", () => {
    const s = seeded("uid-a");
    reconcilePendingVerifyInputForIdentity(s, "uid-a", T0 + 1000);
    expect(stored(s).text).toBe(CLAIM);
    reconcilePendingVerifyInputForIdentity(s, "uid-b", T0 + 2000);
    expect(s.length).toBe(0);
  });

  it("reconcile removes an expired record", () => {
    const s = seeded(null);
    reconcilePendingVerifyInputForIdentity(s, "uid-a", T0 + PENDING_TTL_MS + 1);
    expect(s.length).toBe(0);
  });

  it("sign-out of a signed-in identity removes it", () => {
    const s = seeded("uid-a");
    clearPendingVerifyInputOnSignOut(s);
    expect(s.length).toBe(0);
  });
});

describe("update / consume / return path", () => {
  // R4 (review MINOR-3): an edit belongs to the CURRENT viewer. R3 kept the old binding, so an anonymous visitor
  // typing over a record bound to A saved their text under A's identity.
  it("edits update the text, bound to the current viewer, and an empty textarea removes it", () => {
    const s = new FakeStorage();
    capturePendingVerifyInput(env(`?text=${encodeURIComponent(CLAIM)}`, "", "uid-a", s));
    updatePendingVerifyInput(s, "edited SYNTHETIC text", "uid-a", T0 + 10);
    expect(stored(s)).toMatchObject({ text: "edited SYNTHETIC text", boundUid: "uid-a" });
    updatePendingVerifyInput(s, "anonymous SYNTHETIC text", null, T0 + 15);
    expect(stored(s)).toMatchObject({ text: "anonymous SYNTHETIC text", boundUid: null });
    updatePendingVerifyInput(s, "", "uid-a", T0 + 20);
    expect(s.length).toBe(0);
  });

  it("consume removes the record (one-time)", () => {
    const s = new FakeStorage();
    capturePendingVerifyInput(env(`?text=${encodeURIComponent(CLAIM)}`, "", null, s));
    consumePendingVerifyInput(s);
    expect(s.length).toBe(0);
    expect(readVisiblePendingVerifyInput(s, null)).toBe("");
  });

  it("the signup/login return path carries source only — never the text", () => {
    expect(verifyReturnPath("extension")).toBe("/verify?source=extension");
    expect(verifyReturnPath("")).toBe("/verify");
  });
});
