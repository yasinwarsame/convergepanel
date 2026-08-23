/**
 * Team Workspace Invitations, Phase 8D.3.1 —
 * `components/PostHogProvider.tsx` `before_send` URL-fragment redaction.
 * Captures the ACTUAL config object passed to `posthog.init()` and invokes
 * its `before_send` callback directly — not a standalone helper — to prove
 * the wiring itself is correct.
 */

import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";

const SENTINEL = "SUPER_SECRET_INVITATION_TOKEN_987654";
const FRAGMENT_URL = `https://convergepanel.com/workspace-invitations/accept#invitationId=inv-1&token=${SENTINEL}`;
const SCRUBBED_URL = "https://convergepanel.com/workspace-invitations/accept";

let capturedInitConfig: any;
const mockedPosthogInit = jest.fn((_key: string, config: any) => {
  capturedInitConfig = config;
});

jest.mock("posthog-js", () => ({
  __esModule: true,
  default: {
    init: (key: string, config: any) => mockedPosthogInit(key, config),
    capture: jest.fn(),
  },
}));

jest.mock("posthog-js/react", () => ({
  PostHogProvider: ({ children }: { children: React.ReactNode }) => children,
}));

jest.mock("next/navigation", () => ({
  usePathname: () => "/workspace-invitations/accept",
  useSearchParams: () => new URLSearchParams(),
}));

import { PostHogProvider } from "@/components/PostHogProvider";

const ORIGINAL_ENV = process.env.NEXT_PUBLIC_POSTHOG_KEY;

beforeEach(() => {
  jest.clearAllMocks();
  capturedInitConfig = undefined;
  process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_test_key";
});

afterAll(() => {
  process.env.NEXT_PUBLIC_POSTHOG_KEY = ORIGINAL_ENV;
});

function render() {
  let renderer!: TestRenderer.ReactTestRenderer;
  act(() => {
    renderer = TestRenderer.create(createElement(PostHogProvider, null, createElement("div", null, "child")));
  });
  return renderer;
}

describe("PostHogProvider — before_send wiring", () => {
  it("passes a before_send function to posthog.init", () => {
    render();
    expect(mockedPosthogInit).toHaveBeenCalledTimes(1);
    expect(typeof capturedInitConfig.before_send).toBe("function");
  });

  it("strips the fragment from $current_url on a $pageview-shaped event", () => {
    render();
    const result = capturedInitConfig.before_send({
      event: "$pageview",
      properties: { $current_url: FRAGMENT_URL },
    });
    expect(result.properties.$current_url).toBe(SCRUBBED_URL);
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it("strips the fragment from $current_url on a $exception-shaped event", () => {
    render();
    const result = capturedInitConfig.before_send({
      event: "$exception",
      properties: { $current_url: FRAGMENT_URL, $exception_message: "boom" },
    });
    expect(result.properties.$current_url).toBe(SCRUBBED_URL);
    expect(result.properties.$exception_message).toBe("boom");
  });

  it("strips the fragment from $current_url on an autocapture-shaped event", () => {
    render();
    const result = capturedInitConfig.before_send({
      event: "$autocapture",
      properties: { $current_url: FRAGMENT_URL, $event_type: "click" },
    });
    expect(result.properties.$current_url).toBe(SCRUBBED_URL);
    expect(result.properties.$event_type).toBe("click");
  });

  it("leaves a non-fragment $current_url intact", () => {
    render();
    const result = capturedInitConfig.before_send({
      event: "$pageview",
      properties: { $current_url: "https://convergepanel.com/dashboard" },
    });
    expect(result.properties.$current_url).toBe("https://convergepanel.com/dashboard");
  });

  it("passes through an event with no $current_url unchanged", () => {
    render();
    const input = { event: "custom_event", properties: { foo: "bar" } };
    const result = capturedInitConfig.before_send(input);
    expect(result).toEqual(input);
  });

  it("passes through a null event without throwing", () => {
    render();
    expect(capturedInitConfig.before_send(null)).toBeNull();
  });
});

describe("PostHogProvider — pageview construction still excludes the hash", () => {
  it("manual pageview capture never reads location.hash", () => {
    const source = require("fs").readFileSync(require("path").join(__dirname, "..", "PostHogProvider.tsx"), "utf8");
    const trackerMatch = source.match(/function PageviewTracker\(\)[\s\S]*?\n\}/);
    expect(trackerMatch).not.toBeNull();
    expect(trackerMatch![0]).not.toMatch(/location\.hash/);
  });
});
