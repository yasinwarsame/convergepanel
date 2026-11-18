/**
 * PR #329 R4 (review MAJOR-1 + MINOR-2/3, owner ruling): claim text NEVER stays
 * in the URL, whatever sessionStorage does.
 *
 *  - sessionStorage blocked (getter throws / null) or throwing (setItem throws):
 *    the `#text=` fragment and the legacy `?text=` / `?claim=` / `?q=` are still
 *    removed from the address bar at once (fail closed); the text is held only in
 *    this document's memory (bounded, identity-bound, one-time) — never in a URL.
 *  - `appHandoffHref` never falls back to a claim-bearing URL.
 *  - Non-content parameters (UTM etc.) are kept byte-for-byte.
 *  - The address-bar rewrite hands Next's patched `history.replaceState` a state
 *    WITHOUT `__NA`, so the app router adopts the clean URL as its canonicalUrl
 *    (R3 passed `history.state`, whose `__NA` made Next skip the sync: a later
 *    router update could restore the claim URL).
 *  - The pre-telemetry scrub also sanitizes a same-origin `document.referrer`.
 *  - Nothing in the failure path logs.
 * Synthetic sentinels only.
 */
import * as prefill from "@/lib/client/verifyPrefill";
import { FakeStorage } from "./helpers/fakeStorage";

const SENTINEL = "ZQX7UNITSENTINEL";
const CLAIM = `drinking seawater ${SENTINEL} cures thirst & more?`;
const T0 = 1_800_000_000_000;
const UTM = "utm_source=newsletter&utm_campaign=Spring%20Sale";

const P = prefill as any;

/** sessionStorage whose every operation throws (Safari private mode / blocked site data). */
const throwingStorage = () => ({
  getItem: () => {
    throw new Error("SecurityError");
  },
  setItem: () => {
    throw new Error("QuotaExceededError");
  },
  removeItem: () => {
    throw new Error("SecurityError");
  },
});
/** sessionStorage that reads fine but refuses writes. */
const readOnlyStorage = () => {
  const s = new FakeStorage();
  (s as any).setItem = () => {
    throw new Error("QuotaExceededError");
  };
  return s;
};

const BLOCKED: Array<[string, () => any]> = [
  ["unavailable (null)", () => null],
  ["every call throws", throwingStorage],
  ["setItem throws", readOnlyStorage],
];

/** A history double that behaves like Next 14.2's patched replaceState (app-router.js:447-456). */
function nextPatchedHistory(initialState: any) {
  const synced: string[] = [];
  const urls: string[] = [];
  const history = {
    state: initialState,
    replaceState(data: any, _t: string, url?: string) {
      // Next: `if (data?.__NA || data?._N) return originalReplaceState(...)` — no router sync.
      if (!(data && (data.__NA || data._N)) && url) synced.push(url);
      urls.push(String(url));
      history.state = data;
    },
  };
  return { history, synced, urls };
}

function loc(pathname: string, search: string, hash = "") {
  return { pathname, search, hash };
}

beforeEach(() => {
  P.__resetTabHandoffMemoryForTests?.();
  jest.spyOn(console, "log");
  jest.spyOn(console, "warn");
  jest.spyOn(console, "error");
  jest.spyOn(console, "info");
  jest.spyOn(console, "debug");
});
afterEach(() => {
  for (const m of ["log", "warn", "error", "info", "debug"] as const) {
    expect(JSON.stringify((console[m] as jest.Mock).mock.calls)).not.toContain(SENTINEL);
  }
  jest.restoreAllMocks();
});

describe("R4 — blocked / throwing sessionStorage: fail closed, never leave the text in the URL", () => {
  for (const [label, make] of BLOCKED) {
    it(`/verify#text= (${label}): fragment removed, UTM kept byte-for-byte, text held in memory for this document`, () => {
      const storage = make();
      const h = nextPatchedHistory({ __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: ["", {}] });
      const text = prefill.capturePendingVerifyInput({
        location: loc("/verify", `?source=extension&${UTM}`, `#text=${encodeURIComponent(CLAIM)}`),
        history: h.history,
        storage,
        currentUid: null,
        now: T0,
      });
      expect(text).toBe(CLAIM);
      expect(h.urls).toEqual([`/verify?source=extension&${UTM}`]);
      expect(prefill.readVisiblePendingVerifyInput(storage, null, T0)).toBe(CLAIM); // same document: still usable
    });

    it(`legacy /verify?text= (${label}): stripped; other parameters kept in order`, () => {
      const h = nextPatchedHistory(null);
      prefill.capturePendingVerifyInput({
        location: loc("/verify", `?source=extension&text=${encodeURIComponent(CLAIM)}&${UTM}`),
        history: h.history,
        storage: make(),
        currentUid: null,
        now: T0,
      });
      expect(h.urls).toEqual([`/verify?source=extension&${UTM}`]);
    });

    for (const [tab, param] of [
      ["verify", "claim"],
      ["research", "q"],
    ] as const) {
      it(`legacy /?tab=${tab}&${param}= (${label}): stripped; the main app's one-time reader still gets it from memory`, () => {
        const storage = make();
        const h = nextPatchedHistory(null);
        const moved = prefill.migrateLegacyAppHandoffLink({
          location: loc("/", `?tab=${tab}&${param}=${encodeURIComponent(CLAIM)}&${UTM}`),
          history: h.history,
          storage,
          currentUid: null,
          now: T0,
        });
        expect(moved).toBe(true);
        expect(h.urls).toEqual([`/?tab=${tab}&${UTM}`]);
        expect(prefill.consumeAppHandoff(tab, "uid-a", storage, T0 + 1)).toBe(CLAIM);
        expect(prefill.consumeAppHandoff(tab, "uid-a", storage, T0 + 2)).toBeNull(); // one-time
      });
    }

    it(`appHandoffHref (${label}): never a claim-bearing URL; the memory hand-off honours the binding`, () => {
      const storage = make();
      const href = prefill.appHandoffHref("verify", CLAIM, "uid-a", storage);
      expect(href).toBe("/?tab=verify");
      expect(prefill.consumeAppHandoff("verify", "uid-b", storage)).toBeNull(); // another account never gets it
      const href2 = prefill.appHandoffHref("research", CLAIM, "uid-a", storage);
      expect(href2).toBe("/?tab=research");
      expect(prefill.consumeAppHandoff("research", "uid-a", storage)).toBe(CLAIM);
    });
  }

  it("the memory hold is bounded: it expires with the record TTL", () => {
    prefill.capturePendingVerifyInput({ location: loc("/verify", "", `#text=${encodeURIComponent(CLAIM)}`), history: null, storage: null, currentUid: null, now: T0 });
    expect(prefill.readVisiblePendingVerifyInput(null, null, T0 + prefill.PENDING_TTL_MS - 1)).toBe(CLAIM);
    expect(prefill.readVisiblePendingVerifyInput(null, null, T0 + prefill.PENDING_TTL_MS + 1)).toBe("");
    prefill.appHandoffHref("verify", CLAIM, "uid-a", null);
    expect(prefill.consumeAppHandoff("verify", "uid-a", null, Date.now() + prefill.APP_HANDOFF_TTL_MS + 1)).toBeNull();
  });

  it("the memory hold is identity-bound: sign-out and a different account remove it (pending input AND hand-off)", () => {
    prefill.capturePendingVerifyInput({ location: loc("/verify", "", `#text=${encodeURIComponent(CLAIM)}`), history: null, storage: null, currentUid: "uid-a", now: T0 });
    prefill.appHandoffHref("research", CLAIM, "uid-a", null);
    prefill.clearPendingVerifyInputOnSignOut(null);
    expect(prefill.readVisiblePendingVerifyInput(null, "uid-a", T0)).toBe("");
    expect(prefill.consumeAppHandoff("research", "uid-a", null)).toBeNull();

    prefill.capturePendingVerifyInput({ location: loc("/verify", "", `#text=${encodeURIComponent(CLAIM)}`), history: null, storage: null, currentUid: "uid-a", now: Date.now() });
    prefill.appHandoffHref("verify", CLAIM, "uid-a", null);
    prefill.reconcilePendingVerifyInputForIdentity(null, "uid-b");
    expect(prefill.readVisiblePendingVerifyInput(null, "uid-b")).toBe("");
    expect(prefill.readVisiblePendingVerifyInput(null, "uid-a")).toBe("");
    expect(prefill.consumeAppHandoff("verify", "uid-a", null)).toBeNull();
  });

  it("isTabStorageUsable reports blocked and throwing storage (drives the paste-manually notice)", () => {
    expect(P.isTabStorageUsable(new FakeStorage())).toBe(true);
    expect(P.isTabStorageUsable(null)).toBe(false);
    expect(P.isTabStorageUsable(throwingStorage())).toBe(false);
    expect(P.isTabStorageUsable(readOnlyStorage())).toBe(false);
  });

  it("control: with working storage the text goes to sessionStorage, not memory", () => {
    const s = new FakeStorage();
    prefill.capturePendingVerifyInput({ location: loc("/verify", "", `#text=${encodeURIComponent(CLAIM)}`), history: null, storage: s, currentUid: null, now: T0 });
    expect(s.getItem(prefill.VERIFY_PENDING_STORAGE_KEY)).toContain(SENTINEL);
    expect(prefill.readVisiblePendingVerifyInput(null, null, T0)).toBe(""); // nothing was held in memory
  });
});

describe("R4 — Next.js router state adopts the clean URL (MINOR-2)", () => {
  it("the /verify rewrite passes a state without __NA, so Next's patched replaceState syncs canonicalUrl", () => {
    const h = nextPatchedHistory({ __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: ["", {}], keep: 1 });
    prefill.capturePendingVerifyInput({
      location: loc("/verify", "?source=extension", `#text=${encodeURIComponent(CLAIM)}`),
      history: h.history,
      storage: new FakeStorage(),
      currentUid: null,
      now: T0,
    });
    expect(h.synced).toEqual(["/verify?source=extension"]);
    expect(h.history.state).toEqual({ keep: 1 }); // custom state kept; Next re-adds its own __NA + tree
  });

  it("the legacy-link rewrite does the same", () => {
    const h = nextPatchedHistory({ __NA: true, __PRIVATE_NEXTJS_INTERNALS_TREE: ["", {}] });
    prefill.migrateLegacyAppHandoffLink({ location: loc("/", `?tab=verify&claim=${encodeURIComponent(CLAIM)}`), history: h.history, storage: new FakeStorage(), currentUid: null, now: T0 });
    expect(h.synced).toEqual(["/?tab=verify"]);
  });
});

describe("R4 — the pre-telemetry scrub (runs before Sentry.init and posthog.init)", () => {
  function fakeWindow(href: string, referrer: string, storage: any) {
    const u = new URL(href);
    const h = nextPatchedHistory(null);
    const location = {
      origin: u.origin,
      pathname: u.pathname,
      search: u.search,
      hash: u.hash,
      get href() {
        return `${u.origin}${location.pathname}${location.search}${location.hash}`;
      },
    };
    const doc: any = { referrer };
    const win: any = { location, history: h.history, document: doc };
    Object.defineProperty(win, "sessionStorage", { get: storage });
    h.history.replaceState = ((orig) =>
      function (this: any, data: any, t: string, url?: string) {
        orig.call(h.history, data, t, url);
        const n = new URL(String(url), u.origin);
        location.pathname = n.pathname;
        location.search = n.search;
        location.hash = n.hash;
      })(h.history.replaceState);
    return win;
  }
  function loadScrub(): (win?: any) => void {
    try {
      return require("@/lib/privacy/preTelemetryUrlScrub").scrubUrlBeforeTelemetry;
    } catch {
      return () => undefined; // pre-fix tree: no scrub exists
    }
  }

  for (const [label, storage] of [
    ["working", () => new FakeStorage()],
    ["getter throws", () => {
      throw new Error("SecurityError");
    }],
  ] as Array<[string, () => any]>) {
    it(`(${label}) #text=, ?claim= and a same-origin claim referrer are all gone afterwards; UTM kept`, () => {
      const scrub = loadScrub();
      const w1 = fakeWindow(`https://convergepanel.com/verify?source=extension&${UTM}#text=${encodeURIComponent(CLAIM)}`, "", storage);
      scrub(w1);
      expect(w1.location.href).toBe(`https://convergepanel.com/verify?source=extension&${UTM}`);

      const w2 = fakeWindow(`https://convergepanel.com/?tab=verify&claim=${encodeURIComponent(CLAIM)}&${UTM}`, "", storage);
      scrub(w2);
      expect(w2.location.href).toBe(`https://convergepanel.com/?tab=verify&${UTM}`);

      const w3 = fakeWindow(`https://convergepanel.com/verify?source=extension`, `https://convergepanel.com/?tab=verify&claim=${encodeURIComponent(CLAIM)}&${UTM}`, storage);
      scrub(w3);
      expect(String(w3.document.referrer)).not.toContain(SENTINEL);
      expect(String(w3.document.referrer)).toContain("utm_source=newsletter");
    });
  }

  it("control: a clean URL and a clean referrer are left exactly as they are", () => {
    const scrub = loadScrub();
    const w = fakeWindow(`https://convergepanel.com/pricing?${UTM}`, "https://www.google.com/", () => new FakeStorage());
    scrub(w);
    expect(w.location.href).toBe(`https://convergepanel.com/pricing?${UTM}`);
    expect(w.document.referrer).toBe("https://www.google.com/");
  });

  it("is a no-op without a window (SSR / Node)", () => {
    const scrub = loadScrub();
    expect(() => scrub(undefined)).not.toThrow();
  });
});
