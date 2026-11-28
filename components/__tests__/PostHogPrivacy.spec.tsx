/**
 * Privacy remediation (2026-11-17 audit) — PostHog never receives claim /
 * question text. Renders the REAL `PostHogProvider` against a mocked
 * `posthog-js`, so both the manual `$pageview` (mocked `posthog.capture`) and
 * the `before_send` hook actually passed to `posthog.init` are exercised.
 * Synthetic data only.
 */

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";
import { readFileSync } from "fs";
import { join } from "path";

const CLAIM = "SYNTHETIC_CLAIM_the election was decided by lizards";
const enc = encodeURIComponent(CLAIM);

let initConfig: any;
const mockCapture = jest.fn();
jest.mock("posthog-js", () => ({
  __esModule: true,
  default: {
    init: (_key: string, config: any) => {
      initConfig = config;
    },
    capture: (...args: any[]) => mockCapture(...args),
  },
}));
jest.mock("posthog-js/react", () => ({
  PostHogProvider: ({ children }: { children: React.ReactNode }) => children,
}));

let mockPathname = "/";
let mockSearch = "";
jest.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
  useSearchParams: () => new URLSearchParams(mockSearch),
}));

import { PostHogProvider } from "@/components/PostHogProvider";

const SAVED_KEY = process.env.NEXT_PUBLIC_POSTHOG_KEY;
const g = globalThis as any;
const SAVED_WINDOW = g.window;

beforeEach(() => {
  jest.clearAllMocks();
  initConfig = undefined;
  process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_synthetic";
  process.env.NEXT_PUBLIC_VERCEL_ENV = "production"; // ZCA R2 Phase B: analytics runs only in Vercel Production
  g.window = { location: { origin: "https://convergepanel.com" } };
});
afterAll(() => {
  process.env.NEXT_PUBLIC_POSTHOG_KEY = SAVED_KEY;
  delete process.env.NEXT_PUBLIC_VERCEL_ENV;
  g.window = SAVED_WINDOW;
});

function render() {
  act(() => {
    TestRenderer.create(createElement(PostHogProvider, null, createElement("div", null, "child")));
  });
}

function sentPayloads(): string {
  return JSON.stringify(mockCapture.mock.calls);
}

describe("manual $pageview (mocked posthog.capture)", () => {
  it.each([
    ["/", `tab=verify&claim=${enc}`, "https://convergepanel.com/?tab=verify&claim=[redacted]"],
    ["/", `tab=research&q=${enc}`, "https://convergepanel.com/?tab=research&q=[redacted]"],
    ["/verify", `source=extension&text=${enc}`, "https://convergepanel.com/verify?source=extension&text=[redacted]"],
    ["/signup", `redirect=${encodeURIComponent(`/verify?source=extension&text=${enc}`)}`, "https://convergepanel.com/signup?redirect=[redacted]"],
  ])("%s?%s is captured without the claim", (pathname, search, expected) => {
    mockPathname = pathname;
    mockSearch = search;
    render();
    expect(mockCapture).toHaveBeenCalledWith("$pageview", { $current_url: expected });
    expect(sentPayloads()).not.toContain("lizards");
  });

  it("control: a pageview with only safe params is captured verbatim", () => {
    mockPathname = "/billing";
    mockSearch = "success=true&utm_source=newsletter";
    render();
    expect(mockCapture).toHaveBeenCalledWith("$pageview", { $current_url: "https://convergepanel.com/billing?success=true&utm_source=newsletter" });
  });
});

describe("before_send (the hook actually passed to posthog.init)", () => {
  beforeEach(() => {
    mockPathname = "/";
    mockSearch = "";
  });

  it("scrubs $current_url / $referrer / $initial_* / $session_entry_url and $set / $set_once on any event type", () => {
    render();
    const out = initConfig.before_send({
      event: "$pageleave",
      properties: {
        $current_url: `https://convergepanel.com/?claim=${enc}`,
        $referrer: `https://convergepanel.com/verify?text=${enc}`,
        $session_entry_url: `https://convergepanel.com/verify?text=${enc}`,
        $pathname: "/",
        distinct_id: "uid-synthetic",
      },
      $set: { $current_url: `https://convergepanel.com/?q=${enc}` },
      $set_once: { $initial_current_url: `https://convergepanel.com/?q=${enc}`, $initial_referrer: `https://x.example/?q=${enc}` },
    });
    expect(JSON.stringify(out)).not.toContain("lizards");
    expect(out.properties.$current_url).toBe("https://convergepanel.com/?claim=[redacted]");
    // controls
    expect(out.properties.$pathname).toBe("/");
    expect(out.properties.distinct_id).toBe("uid-synthetic");
    expect(out.event).toBe("$pageleave");
  });

  it("scrubs autocapture $elements href, $elements_chain and heatmap URL keys", () => {
    render();
    const out = initConfig.before_send({
      event: "$autocapture",
      properties: {
        $event_type: "click",
        $current_url: `https://convergepanel.com/verify?text=${enc}`,
        $elements: [{ tag_name: "a", attr__href: `/signup?redirect=${enc}`, nth_child: 1 }],
        $elements_chain: `a.cta:attr__href="/signup?redirect=${enc}"nth-child="1"`,
        $heatmap_data: { [`https://convergepanel.com/?claim=${enc}`]: [{ x: 1, y: 2 }] },
      },
    });
    expect(JSON.stringify(out)).not.toContain("lizards");
    expect(out.properties.$event_type).toBe("click");
    expect(out.properties.$elements[0].tag_name).toBe("a");
    expect(out.properties.$heatmap_data["https://convergepanel.com/?claim=[redacted]"]).toEqual([{ x: 1, y: 2 }]);
  });

  it("control: a custom product event with metadata only is untouched", () => {
    render();
    const ev = { event: "claim_verification", properties: { models: ["a", "b"], plan: "pro", $current_url: "https://convergepanel.com/" } };
    expect(initConfig.before_send(JSON.parse(JSON.stringify(ev)))).toEqual(ev);
    expect(initConfig.before_send(null)).toBeNull();
  });
});

describe("posthog.init configuration is pinned", () => {
  it("autocapture keeps running but masks element text and attributes; session recording off with masking pinned", () => {
    render();
    expect(initConfig.autocapture).toBeUndefined(); // default ON — click analytics preserved
    expect(initConfig.mask_all_text).toBe(true);
    expect(initConfig.mask_all_element_attributes).toBe(true);
    expect(initConfig.disable_session_recording).toBe(true);
    expect(initConfig.session_recording).toMatchObject({ maskAllInputs: true, maskTextSelector: "*", recordHeaders: false, recordBody: false });
    expect(initConfig.capture_pageview).toBe(false);
    expect(typeof initConfig.before_send).toBe("function");
  });
});

describe("identify payloads (login / signup)", () => {
  it.each(["login", "signup"])("app/%s/page.tsx identifies by uid only — no email / name person properties", (page) => {
    const src = readFileSync(join(__dirname, "..", "..", "app", page, "page.tsx"), "utf8");
    const calls = src.match(/posthog\.identify\([^)]*\)/g) ?? [];
    expect(calls).toEqual(["posthog.identify(user.uid)"]);
  });
});

describe("round 2 — PostHog paths that bypass before_send, and exception events", () => {
  beforeEach(() => {
    mockPathname = "/";
    mockSearch = "";
  });

  it("pins PostHog's own personal-data masking with the content-bearing params", () => {
    render();
    expect(initConfig.mask_personal_data_properties).toBe(true);
    expect(initConfig.custom_personal_data_properties).toEqual(expect.arrayContaining(["text", "claim", "q", "question", "redirect", "next"]));
  });

  it("the REAL posthog-js getPersonInfo (feeds $initial_person_info, session props and /flags) masks the claim under our config", () => {
    render();
    const g2 = globalThis as any;
    const savedLocation = g2.location;
    jest.isolateModules(() => {
      g2.window = { location: { href: `https://convergepanel.com/verify?source=extension&text=${enc}` }, document: { referrer: "" } };
      g2.location = g2.window.location;
      g2.document = g2.window.document;
      const realUtils = jest.requireActual("posthog-js/lib/src/utils/event-utils");
      const info = realUtils.getPersonInfo(initConfig.mask_personal_data_properties, initConfig.custom_personal_data_properties);
      expect(JSON.stringify(info)).not.toContain("lizards");
      expect(info.u).toContain("source=extension"); // control: the URL itself is kept
      // control: without our config the real library would have stored the claim
      const unmasked = realUtils.getPersonInfo(false, []);
      expect(JSON.stringify(unmasked)).toContain("lizards");
    });
    g2.location = savedLocation;
    delete g2.document;
  });

  it("before_send scrubs $initial_person_info (u/r) in properties and $set_once", () => {
    render();
    const out = initConfig.before_send({
      event: "$pageview",
      properties: { $initial_person_info: { u: `https://convergepanel.com/?claim=${enc}`, r: `https://convergepanel.com/verify?text=${enc}` } },
      $set_once: { $initial_person_info: { u: `https://convergepanel.com/?q=${enc}`, r: "$direct" } },
    });
    expect(JSON.stringify(out)).not.toContain("lizards");
    expect(out.$set_once.$initial_person_info.r).toBe("$direct"); // control
  });

  it("before_send redacts $exception_list values / $exception_message (SyntaxError excerpts, URLs) but keeps types", () => {
    render();
    const out = initConfig.before_send({
      event: "$exception",
      properties: {
        $exception_type: "SyntaxError",
        $exception_message: `Unexpected token 'S', "${CLAIM.slice(0, 20)}"... is not valid JSON`,
        $exception_list: [
          { type: "SyntaxError", value: `JSON Parse error: Unexpected identifier "${CLAIM.slice(0, 24)}"`, stacktrace: { frames: [{ filename: `https://convergepanel.com/_next/p.js?claim=${enc}`, lineno: 1 }] } },
          { type: "Error", value: `fetch failed https://convergepanel.com/?q=${enc}` },
        ],
      },
    });
    expect(JSON.stringify(out)).not.toContain("SYNTHETIC_CLAIM");
    expect(JSON.stringify(out)).not.toContain("lizards");
    expect(out.properties.$exception_list[0].type).toBe("SyntaxError"); // control
    expect(out.properties.$exception_list[0].stacktrace.frames[0].lineno).toBe(1);
  });
});
