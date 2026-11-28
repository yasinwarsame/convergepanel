/**
 * ZCA Round 2, Phase B (owner decision 2): the browser PostHog client initializes ONLY on the Vercel Production
 * deployment. A configured key never routes Preview / development / unknown-environment traffic to PostHog.
 */
import { createElement } from "react";
import TestRenderer, { act } from "react-test-renderer";

const mockedPosthogInit = jest.fn();
jest.mock("posthog-js", () => ({
  __esModule: true,
  default: { init: (...a: unknown[]) => mockedPosthogInit(...a), capture: jest.fn() },
}));
jest.mock("posthog-js/react", () => ({
  PostHogProvider: ({ children }: { children: React.ReactNode }) => children,
}));
jest.mock("next/navigation", () => ({
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

import { PostHogProvider } from "@/components/PostHogProvider";
import { clientAnalyticsEnabled } from "@/lib/telemetry/analyticsEnablement";

const SAVED = { key: process.env.NEXT_PUBLIC_POSTHOG_KEY, env: process.env.NEXT_PUBLIC_VERCEL_ENV };
beforeEach(() => {
  mockedPosthogInit.mockReset();
  process.env.NEXT_PUBLIC_POSTHOG_KEY = "phc_synthetic";
});
afterAll(() => {
  if (SAVED.key === undefined) delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
  else process.env.NEXT_PUBLIC_POSTHOG_KEY = SAVED.key;
  if (SAVED.env === undefined) delete process.env.NEXT_PUBLIC_VERCEL_ENV;
  else process.env.NEXT_PUBLIC_VERCEL_ENV = SAVED.env;
});

function mount() {
  act(() => {
    TestRenderer.create(createElement(PostHogProvider, null, createElement("div", null, "child")));
  });
}

describe("browser analytics are Production-only (fail closed)", () => {
  it.each([["preview"], ["development"], [""], ["Production"], ["production "], ["prod"]])(
    "NEXT_PUBLIC_VERCEL_ENV=%p with a configured key → posthog.init is never called",
    (value) => {
      process.env.NEXT_PUBLIC_VERCEL_ENV = value;
      mount();
      expect(mockedPosthogInit).not.toHaveBeenCalled();
    }
  );

  it("NEXT_PUBLIC_VERCEL_ENV unset (missing signal) → never initialized", () => {
    delete process.env.NEXT_PUBLIC_VERCEL_ENV;
    mount();
    expect(mockedPosthogInit).not.toHaveBeenCalled();
  });

  it("control: Production with a key initializes through the /ingest proxy", () => {
    process.env.NEXT_PUBLIC_VERCEL_ENV = "production";
    mount();
    expect(mockedPosthogInit).toHaveBeenCalledTimes(1);
    expect(mockedPosthogInit.mock.calls[0][1]).toMatchObject({ api_host: "/ingest" });
  });

  it("control: Production with NO key still never initializes", () => {
    process.env.NEXT_PUBLIC_VERCEL_ENV = "production";
    delete process.env.NEXT_PUBLIC_POSTHOG_KEY;
    mount();
    expect(mockedPosthogInit).not.toHaveBeenCalled();
  });

  it("the helper accepts exactly the string \"production\"", () => {
    expect(clientAnalyticsEnabled("production")).toBe(true);
    for (const v of ["", "preview", "development", "PRODUCTION", " production"]) expect(clientAnalyticsEnabled(v)).toBe(false);
  });
});
