/**
 * Real-browser harness for the telemetry URL invariant (PR #329 R4, owner A3).
 *
 * Bundles `__tests__/helpers/telemetryBrowserEntry.tsx` (the REAL
 * `instrumentation-client.ts`, the REAL `PostHogProvider`, the REAL `posthog-js`
 * and `@sentry/nextjs` browser SDKs) with esbuild, loads it in real Chromium
 * (Playwright) and records EVERY outgoing request at two layers:
 *   - network: `context.on("request")` (every resource type: document, script,
 *     fetch, xhr, ping/beacon, image, ...) with URL, all headers (incl. Cookie)
 *     and the body, decoded (raw, gzip/zlib/deflate at any offset, base64,
 *     form `data=`), plus `page.on("websocket")`;
 *   - in page: wrappers on `fetch`, `XMLHttpRequest.open/send`,
 *     `navigator.sendBeacon`, `HTMLImageElement.src` / `setAttribute("src")`
 *     installed before any page script.
 * Nothing leaves the machine: every request is answered by `context.route`.
 * The origin is a synthetic `https://app.convergepanel.test`.
 */
import { build } from "esbuild";
import { chromium, type Browser, type BrowserContext, type Page, type Request } from "playwright";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { gunzipSync, inflateRawSync, inflateSync } from "zlib";

export const ORIGIN = "https://app.convergepanel.test";
const ROOT = resolve(__dirname, "..", "..");

export type StorageMode = "normal" | "session-getter-throws" | "session-null" | "session-setitem-throws" | "all-site-data-blocked";

export type RecordedRequest = {
  layer: "network" | "page";
  kind: string;
  url: string;
  headers: Record<string, string>;
  bodies: string[];
};

export function chromiumAvailable(): boolean {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

let bundleCache: string | null = null;
export async function buildEntryBundle(): Promise<string> {
  if (bundleCache) return bundleCache;
  const out = mkdtempSync(join(tmpdir(), "cp-telemetry-bundle-"));
  try {
    await build({
      entryPoints: [join(ROOT, "__tests__/helpers/telemetryBrowserEntry.tsx")],
      bundle: true,
      outfile: join(out, "bundle.js"),
      platform: "browser",
      format: "iife",
      conditions: ["browser"],
      jsx: "automatic",
      target: "es2020",
      logLevel: "silent",
      tsconfig: join(ROOT, "tsconfig.json"),
      define: {
        "process.env.NODE_ENV": '"production"',
        "process.env.NEXT_PUBLIC_POSTHOG_KEY": '"phc_synthetic_r4_harness"',
        "process.env.NEXT_PUBLIC_POSTHOG_HOST": '"https://us.i.posthog.com"',
        "process.env.NEXT_PUBLIC_SENTRY_DSN": '"https://0123456789abcdef0123456789abcdef@o1.ingest.sentry.io/1"',
        "process.env": "{}",
      },
      plugins: [
        {
          name: "next-navigation-shim",
          setup(b) {
            b.onResolve({ filter: /^next\/navigation$/ }, () => ({ path: join(ROOT, "__tests__/helpers/nextNavigationShim.ts") }));
            // Next's own webpack config resolves Node built-ins to empty modules in browser bundles (`fallback: false`).
            b.onResolve({ filter: /^(fs|stream|zlib|path|os|crypto)$/ }, (args) => ({ path: args.path, namespace: "empty-builtin" }));
            b.onLoad({ filter: /.*/, namespace: "empty-builtin" }, () => ({ contents: "module.exports = {};", loader: "js" }));
          },
        },
      ],
    });
    bundleCache = readFileSync(join(out, "bundle.js"), "utf8");
    return bundleCache;
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
}

/** Installed before any page script. */
export function initScript(mode: StorageMode): string {
  return `(() => {
  const mode = ${JSON.stringify(mode)};
  // posthog-js treats automation (navigator.webdriver) as a bot and sends no events: present an ordinary browser.
  Object.defineProperty(Navigator.prototype, "webdriver", { configurable: true, get() { return false; } });
  Object.defineProperty(Navigator.prototype, "userAgentData", { configurable: true, get() { return undefined; } }); // brands list "HeadlessChrome"
  const blockErr = () => new DOMException("The operation is insecure.", "SecurityError");
  if (mode === "session-getter-throws" || mode === "all-site-data-blocked") {
    Object.defineProperty(window, "sessionStorage", { configurable: true, get() { throw blockErr(); } });
  }
  if (mode === "all-site-data-blocked") {
    Object.defineProperty(window, "localStorage", { configurable: true, get() { throw blockErr(); } });
    Object.defineProperty(Document.prototype, "cookie", { configurable: true, get() { return ""; }, set() { /* blocked */ } });
  }
  if (mode === "session-null") {
    Object.defineProperty(window, "sessionStorage", { configurable: true, get() { return null; } });
  }
  if (mode === "session-setitem-throws") {
    const real = Storage.prototype.setItem;
    const ss = window.sessionStorage;
    Storage.prototype.setItem = function (k, v) {
      if (this === ss) throw new DOMException("QuotaExceededError", "QuotaExceededError");
      return real.call(this, k, v);
    };
  }
  const rec = (window.__cpRequests = []);
  const asText = (b) => {
    try {
      if (b == null) return "";
      if (typeof b === "string") return b;
      if (b instanceof URLSearchParams) return b.toString();
      if (b instanceof FormData) return Array.from(b.entries()).map(([k, v]) => k + "=" + (typeof v === "string" ? v : "[blob]")).join("&");
      return "[binary:" + (b.size ?? b.byteLength ?? "?") + "]";
    } catch (e) { return "[unreadable]"; }
  };
  const realFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      rec.push({ kind: "fetch", url: String(url), body: asText(init && init.body) });
    } catch (e) {}
    return realFetch.apply(this, arguments);
  };
  const realOpen = XMLHttpRequest.prototype.open;
  const realSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (m, url) { this.__cpUrl = String(url); return realOpen.apply(this, arguments); };
  XMLHttpRequest.prototype.send = function (body) { rec.push({ kind: "xhr", url: this.__cpUrl, body: asText(body) }); return realSend.apply(this, arguments); };
  if (navigator.sendBeacon) {
    const realBeacon = navigator.sendBeacon.bind(navigator);
    navigator.sendBeacon = function (url, data) { rec.push({ kind: "beacon", url: String(url), body: asText(data) }); return realBeacon(url, data); };
  }
  const srcDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, "src");
  Object.defineProperty(HTMLImageElement.prototype, "src", {
    configurable: true,
    get() { return srcDesc.get.call(this); },
    set(v) { rec.push({ kind: "image", url: String(v), body: "" }); return srcDesc.set.call(this, v); },
  });
  const realSetAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (n, v) {
    if (this instanceof HTMLImageElement && String(n).toLowerCase() === "src") rec.push({ kind: "image", url: String(v), body: "" });
    return realSetAttr.call(this, n, v);
  };
})();`;
}

/** Every plausible decoding of a request body, so a compressed / encoded sentinel is still found. */
export function decodeBodies(buf: Buffer | null): string[] {
  if (!buf || buf.length === 0) return [];
  const out = new Set<string>();
  const add = (s: string) => {
    if (s) out.add(s);
  };
  const tryInflate = (b: Buffer) => {
    for (const fn of [gunzipSync, inflateSync, inflateRawSync]) {
      try {
        add(fn(b).toString("utf8"));
      } catch {
        /* not this format */
      }
    }
  };
  add(buf.toString("utf8"));
  add(buf.toString("latin1"));
  tryInflate(buf);
  // Compressed segments inside envelopes / multipart bodies.
  for (let i = 0; i < buf.length - 1; i++) {
    const a = buf[i];
    const b = buf[i + 1];
    if ((a === 0x1f && b === 0x8b) || (a === 0x78 && (b === 0x01 || b === 0x5e || b === 0x9c || b === 0xda))) tryInflate(buf.subarray(i));
  }
  for (const s of Array.from(out)) {
    // form-encoded `data=<base64>` (posthog) and bare base64 bodies
    try {
      const params = new URLSearchParams(s);
      params.forEach((v) => {
        add(v);
        try {
          add(Buffer.from(v, "base64").toString("utf8"));
        } catch {
          /* not base64 */
        }
      });
    } catch {
      /* not form */
    }
    if (/^[A-Za-z0-9+/=\s]+$/.test(s.trim())) {
      try {
        add(Buffer.from(s.trim(), "base64").toString("utf8"));
      } catch {
        /* not base64 */
      }
    }
    try {
      add(decodeURIComponent(s));
    } catch {
      /* not uri-encoded */
    }
  }
  return Array.from(out);
}

/** The first 50 `Math.random()` calls return 0.001 (below every sample rate), then the real generator. */
export const FORCE_REPLAY_SAMPLING =
  "(() => { const real = Math.random; let n = 0; Math.random = function () { n += 1; return n <= 50 ? 0.001 : real(); }; })();";

const HTML = (withBundle: boolean) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>harness</title></head><body>${withBundle ? '<script src="/__cp_bundle.js"></script>' : "<p>elsewhere</p>"}</body></html>`;

export type HarnessRun = {
  page: Page;
  context: BrowserContext;
  network: RecordedRequest[];
  websockets: string[];
  pageRecords: () => Promise<RecordedRequest[]>;
  /** Saves the current document's in-page records (call before navigating away: a new document starts empty). */
  savePageRecords: () => Promise<void>;
  /** Every recorded request, both layers. */
  all: () => Promise<RecordedRequest[]>;
  close: () => Promise<void>;
};

let browser: Browser | null = null;
export async function launch(): Promise<Browser> {
  if (!browser) browser = await chromium.launch({ headless: true });
  return browser;
}
export async function shutdown(): Promise<void> {
  if (browser) await browser.close();
  browser = null;
}

export async function openPage(path: string, opts: { mode: StorageMode; referer?: string; forceReplaySampling?: boolean }): Promise<HarnessRun> {
  const bundle = await buildEntryBundle();
  const b = await launch();
  // posthog-js drops events from bot user agents ("HeadlessChrome"): present the ordinary desktop Chrome UA.
  const context = await b.newContext({
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
  });
  const network: RecordedRequest[] = [];
  const websockets: string[] = [];
  const pending: Promise<void>[] = [];

  context.on("request", (req: Request) => {
    pending.push(
      (async () => {
        let headers: Record<string, string> = {};
        try {
          headers = await req.allHeaders();
        } catch {
          headers = req.headers();
        }
        network.push({ layer: "network", kind: req.resourceType(), url: req.url(), headers, bodies: decodeBodies(req.postDataBuffer()) });
      })()
    );
  });

  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin === ORIGIN) {
      if (url.pathname === "/__cp_bundle.js") return route.fulfill({ status: 200, contentType: "application/javascript", body: bundle });
      if (url.pathname.startsWith("/ingest/static/")) {
        const file = join(ROOT, "node_modules/posthog-js/dist", url.pathname.slice("/ingest/static/".length));
        if (existsSync(file)) return route.fulfill({ status: 200, contentType: "application/javascript", body: readFileSync(file, "utf8") });
        return route.fulfill({ status: 404, body: "" });
      }
      if (url.pathname.startsWith("/ingest/flags") || url.pathname.startsWith("/ingest/decide")) {
        return route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ featureFlags: {}, featureFlagPayloads: {}, errorsWhileComputingFlags: false, flags: {} }),
        });
      }
      if (url.pathname.startsWith("/ingest/")) return route.fulfill({ status: 200, contentType: "application/json", body: '{"status":1}' });
      if (route.request().resourceType() === "document") {
        return route.fulfill({ status: 200, contentType: "text/html", body: HTML(url.pathname !== "/elsewhere") });
      }
      return route.fulfill({ status: 204, body: "" });
    }
    if (url.hostname.endsWith(".sentry.io")) return route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
    return route.abort();
  });

  await context.addInitScript(initScript(opts.mode));
  // R5: force Sentry Replay's session sampling (replaysSessionSampleRate 0.05) so the rrweb meta event — whose `href`
  // is read at Replay start, i.e. at Sentry.init — is actually sent and checked (positive control in the spec).
  if (opts.forceReplaySampling) await context.addInitScript(FORCE_REPLAY_SAMPLING);
  const page = await context.newPage();
  page.on("websocket", (ws) => websockets.push(ws.url()));
  await page.goto(ORIGIN + path, { waitUntil: "load", ...(opts.referer ? { referer: opts.referer } : {}) });

  const pageRecords = async (): Promise<RecordedRequest[]> => {
    try {
      const recs: Array<{ kind: string; url: string; body: string }> = await page.evaluate(() => (window as any).__cpRequests ?? []);
      return recs.map((r) => ({ layer: "page" as const, kind: r.kind, url: r.url, headers: {}, bodies: r.body ? [r.body] : [] }));
    } catch {
      return [];
    }
  };
  const saved: RecordedRequest[] = [];
  return {
    page,
    context,
    network,
    websockets,
    pageRecords,
    savePageRecords: async () => {
      saved.push(...(await pageRecords()));
    },
    all: async () => {
      await Promise.all(pending);
      return [...network, ...saved, ...(await pageRecords())];
    },
    close: async () => {
      await Promise.all(pending);
      await context.close();
    },
  };
}

/** True for a request to Sentry's ingest (by hostname, not substring). */
export function isSentryRequest(r: RecordedRequest): boolean {
  try {
    return new URL(r.url).hostname.endsWith(".sentry.io");
  } catch {
    return false;
  }
}

/** Every request (URL decoded, headers, decoded bodies) that contains `needle`. */
export function requestsContaining(reqs: RecordedRequest[], needle: string): RecordedRequest[] {
  return reqs.filter((r) => {
    let url = r.url;
    try {
      url = decodeURIComponent(r.url);
    } catch {
      /* keep raw */
    }
    if (url.includes(needle) || r.url.includes(needle)) return true;
    if (Object.values(r.headers).some((h) => h.includes(needle) || safeDecode(h).includes(needle))) return true;
    return r.bodies.some((b) => b.includes(needle));
  });
}
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
