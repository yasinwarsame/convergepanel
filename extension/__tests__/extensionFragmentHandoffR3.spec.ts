/**
 * Privacy remediation R3 (owner D4 / A3) — the browser extension hands the
 * selected text to /verify in the URL FRAGMENT (`#text=`), which browsers
 * never send to the server, instead of the query (`?text=`), which lands in
 * request logs. Loads the REAL extension scripts against a fake `chrome` /
 * `document`. Synthetic selection text only.
 */
import { readFileSync } from "fs";
import { join } from "path";

const SELECTION = "SENTINEL_EXT_SELECTION the tides are caused by wind farms & more?";

function run(file: string, globals: Record<string, unknown>) {
  const src = readFileSync(join(__dirname, "..", file), "utf8");
  // eslint-disable-next-line no-new-func
  new Function(...Object.keys(globals), src)(...Object.values(globals));
}

function fakeChrome(stored: Record<string, unknown> = {}) {
  const created: string[] = [];
  const listeners: Record<string, (arg: any) => unknown> = {};
  const chrome = {
    runtime: { onInstalled: { addListener: (fn: any) => (listeners.installed = fn) } },
    contextMenus: { create: () => undefined, onClicked: { addListener: (fn: any) => (listeners.clicked = fn) } },
    storage: { local: { set: async (v: Record<string, unknown>) => Object.assign(stored, v), get: async () => ({ ...stored }) } },
    tabs: { create: ({ url }: { url: string }) => created.push(url) },
  };
  return { chrome, created, listeners, stored };
}

function assertFragmentUrl(url: string) {
  const u = new URL(url);
  expect(u.origin + u.pathname).toBe("https://convergepanel.com/verify");
  expect(u.searchParams.get("source")).toBe("extension");
  expect(u.searchParams.has("text")).toBe(false); // nothing content-bearing in what the server sees
  expect(u.search).not.toContain("SENTINEL_EXT");
  expect(new URLSearchParams(u.hash.slice(1)).get("text")).toBe(SELECTION); // exact round trip
}

describe("extension → /verify uses the fragment", () => {
  it("background.js context-menu click opens /verify?source=extension#text=<selection>", async () => {
    const f = fakeChrome();
    run("background.js", { chrome: f.chrome });
    await f.listeners.clicked({ menuItemId: "verify-with-convergepanel", selectionText: SELECTION });
    expect(f.created).toHaveLength(1);
    assertFragmentUrl(f.created[0]);
  });

  it("popup.js 'Verify' opens /verify?source=extension#text=<selection>", async () => {
    const f = fakeChrome({ selectedText: SELECTION });
    const handlers: Record<string, () => unknown> = {};
    const el = (id: string) => ({ id, textContent: "", disabled: true, classList: { remove: () => undefined }, addEventListener: (_e: string, fn: () => unknown) => (handlers[id] = fn) });
    const els: Record<string, any> = { "preview-text": el("preview-text"), "btn-verify": el("btn-verify"), "btn-open": el("btn-open") };
    let ready: (() => Promise<void>) | undefined;
    const document = { getElementById: (id: string) => els[id], addEventListener: (_e: string, fn: () => Promise<void>) => (ready = fn) };
    run("popup.js", { chrome: f.chrome, document });
    await ready!();
    await handlers["btn-verify"]();
    expect(f.created).toHaveLength(1);
    assertFragmentUrl(f.created[0]);
  });
});
