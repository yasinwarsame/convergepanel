/**
 * Privacy remediation (2026-11-17) — /verify keeps the extension's `?text=`
 * contract working while removing the text from the address bar and from the
 * signup/login `redirect=`. Synthetic data only.
 */
import { VERIFY_PREFILL_STORAGE_KEY } from "@/lib/client/localPrivateData";
import { consumeVerifyPrefill, takeVerifyPrefill, verifyReturnPath } from "@/lib/client/verifyPrefill";
import { FakeStorage } from "./helpers/fakeStorage";

const CLAIM = "SYNTHETIC_CLAIM: drinking seawater cures thirst & more?";

function env(search: string, hash = "", pathname = "/verify") {
  const storage = new FakeStorage();
  const state = { __NA: true, tree: "synthetic" };
  const replaceState = jest.fn();
  return { location: { pathname, search, hash }, history: { state, replaceState }, storage, replaceState, state };
}

describe("takeVerifyPrefill", () => {
  it("extension link: returns the text, stores it for this tab, strips ONLY text from the address bar, preserving Next's history state", () => {
    const e = env(`?source=extension&text=${encodeURIComponent(CLAIM)}`);
    expect(takeVerifyPrefill(e)).toBe(CLAIM);
    expect(e.storage.getItem(VERIFY_PREFILL_STORAGE_KEY)).toBe(CLAIM);
    expect(e.replaceState).toHaveBeenCalledTimes(1);
    expect(e.replaceState).toHaveBeenCalledWith(e.state, "", "/verify?source=extension");
    expect(JSON.stringify(e.replaceState.mock.calls)).not.toContain("seawater");
  });

  it("accepts a #text= fragment (future extension format) and strips the fragment", () => {
    const e = env("?source=extension", `#text=${encodeURIComponent(CLAIM)}`);
    expect(takeVerifyPrefill(e)).toBe(CLAIM);
    expect(e.replaceState).toHaveBeenCalledWith(e.state, "", "/verify?source=extension");
  });

  it("back from the signup/login detour (no text in URL): restores from sessionStorage and does not touch history", () => {
    const e = env("?source=extension");
    e.storage.setItem(VERIFY_PREFILL_STORAGE_KEY, CLAIM);
    expect(takeVerifyPrefill(e)).toBe(CLAIM);
    expect(e.replaceState).not.toHaveBeenCalled();
  });

  it("control: a plain /verify visit returns '' and changes nothing", () => {
    const e = env("");
    expect(takeVerifyPrefill(e)).toBe("");
    expect(e.replaceState).not.toHaveBeenCalled();
    expect(e.storage.length).toBe(0);
  });

  it("an empty ?text= is stripped without storing anything", () => {
    const e = env("?text=");
    expect(takeVerifyPrefill(e)).toBe("");
    expect(e.replaceState).toHaveBeenCalledWith(e.state, "", "/verify");
    expect(e.storage.length).toBe(0);
  });

  it("never throws when storage / history are unavailable — the text still prefills", () => {
    const throwing = { getItem: () => { throw new Error("x"); }, setItem: () => { throw new Error("x"); }, removeItem: () => { throw new Error("x"); } };
    const r = takeVerifyPrefill({
      location: { pathname: "/verify", search: `?text=${encodeURIComponent(CLAIM)}`, hash: "" },
      history: { state: null, replaceState: () => { throw new Error("x"); } },
      storage: throwing,
    });
    expect(r).toBe(CLAIM);
    expect(takeVerifyPrefill({ location: { pathname: "/verify", search: "", hash: "" }, history: null, storage: throwing })).toBe("");
    expect(() => consumeVerifyPrefill(throwing)).not.toThrow();
  });
});

describe("consumeVerifyPrefill / verifyReturnPath", () => {
  it("consume removes the stored text", () => {
    const s = new FakeStorage();
    s.setItem(VERIFY_PREFILL_STORAGE_KEY, CLAIM);
    consumeVerifyPrefill(s);
    expect(s.length).toBe(0);
  });

  it("the signup/login return path carries source only — never the text", () => {
    expect(verifyReturnPath("extension")).toBe("/verify?source=extension");
    expect(verifyReturnPath("")).toBe("/verify");
  });

  it("app/verify/page.tsx builds signup/login hrefs from verifyReturnPath, not window.location.search", () => {
    const src = require("fs").readFileSync(require("path").join(__dirname, "..", "..", "..", "app", "verify", "page.tsx"), "utf8");
    expect(src).not.toMatch(/location\??\.search/);
    expect(src).toMatch(/const returnPath = verifyReturnPath\(source\)/);
    expect(src).toMatch(/takeVerifyPrefill\(\{ location: window\.location, history: window\.history/);
  });
});
