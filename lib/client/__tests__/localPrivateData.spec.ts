/**
 * Privacy remediation (2026-11-17) — browser-side copies of user content are
 * removable. Synthetic data only.
 */
import {
  PANEL_HISTORY_STORAGE_PREFIX,
  VERIFY_PREFILL_STORAGE_KEY,
  clearPanelHistoryCache,
  clearVerifyPrefill,
  panelHistoryStorageKey,
} from "@/lib/client/localPrivateData";
import { FakeStorage } from "./helpers/fakeStorage";

const ITEM = JSON.stringify([{ claim: "SYNTHETIC_CLAIM", payload: { summary: "SYNTHETIC_MODEL_OUTPUT" } }]);

describe("panelHistoryStorageKey", () => {
  it("keeps the exact pre-existing key shape (app/page.tsx reads/writes the same key)", () => {
    expect(PANEL_HISTORY_STORAGE_PREFIX).toBe("convergePanelHistoryV1");
    expect(panelHistoryStorageKey("uid-a")).toBe("convergePanelHistoryV1:uid-a");
  });

  it("matches the key app/page.tsx actually writes (page.tsx is hash-frozen, so it keeps its own constant)", () => {
    const src = require("fs").readFileSync(require("path").join(__dirname, "..", "..", "..", "app", "page.tsx"), "utf8");
    expect(src).toContain(`const HISTORY_STORAGE_KEY = "${PANEL_HISTORY_STORAGE_PREFIX}";`);
    expect(src).toContain("return `${HISTORY_STORAGE_KEY}:${uid}`;");
  });
});

describe("clearPanelHistoryCache", () => {
  function seeded() {
    const s = new FakeStorage();
    s.setItem("convergePanelHistoryV1:uid-a", ITEM);
    s.setItem("unrelated-pref", "keep");
    s.setItem("convergePanelHistoryV1:uid-b", ITEM);
    s.setItem("convergePanelHistoryV1", ITEM); // legacy un-suffixed
    s.setItem("convergePanelHistoryV10:other", "not ours"); // prefix look-alike
    return s;
  }

  it("removes every history key for every account, keeping unrelated keys", () => {
    const s = seeded();
    expect(clearPanelHistoryCache(s)).toBe(3);
    expect(s.keys().sort()).toEqual(["convergePanelHistoryV10:other", "unrelated-pref"]);
    expect(JSON.stringify(s.keys().map((k) => s.getItem(k)))).not.toContain("SYNTHETIC_CLAIM");
  });

  it("keeps only the signing-in account's key when exceptUid is given", () => {
    const s = seeded();
    clearPanelHistoryCache(s, { exceptUid: "uid-b" });
    expect(s.getItem("convergePanelHistoryV1:uid-b")).toBe(ITEM);
    expect(s.getItem("convergePanelHistoryV1:uid-a")).toBeNull();
    expect(s.getItem("convergePanelHistoryV1")).toBeNull();
  });

  it("never throws when storage is missing or throws", () => {
    expect(clearPanelHistoryCache(null)).toBe(0);
    const broken = { get length(): number { throw new Error("SecurityError"); }, key: () => null, removeItem: () => undefined };
    expect(() => clearPanelHistoryCache(broken as any)).not.toThrow();
  });
});

describe("clearVerifyPrefill", () => {
  it("removes the /verify hand-off text only", () => {
    const s = new FakeStorage();
    s.setItem(VERIFY_PREFILL_STORAGE_KEY, "SYNTHETIC_CLAIM");
    s.setItem("other", "keep");
    clearVerifyPrefill(s);
    expect(s.keys()).toEqual(["other"]);
    expect(() => clearVerifyPrefill(null)).not.toThrow();
  });
});
