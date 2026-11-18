/**
 * Test-only stand-in for `next/navigation` in the real-SDK browser bundle
 * (`__tests__/telemetryRealSdkBrowserR4.spec.ts`). Outside Next's app router the
 * real hooks have no router context. These read the live `window.location`, which
 * is what the app router's hooks reflect after hydration. Nothing else is mocked:
 * the bundle runs the real `instrumentation-client.ts`, the real `PostHogProvider`,
 * the real `posthog-js` and the real `@sentry/nextjs` browser SDK.
 */
export function usePathname(): string {
  return window.location.pathname;
}
export function useSearchParams(): URLSearchParams {
  return new URLSearchParams(window.location.search);
}
export function useRouter() {
  return { push: () => undefined, replace: () => undefined, refresh: () => undefined, back: () => undefined, prefetch: () => undefined };
}
