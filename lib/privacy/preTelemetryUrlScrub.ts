/**
 * PR #329 R4 (review MAJOR-1, owner ruling) — the URL must be clean BEFORE any
 * telemetry SDK initializes.
 *
 * PostHog records `location.href` and `document.referrer` at `posthog.init`
 * (`$initial_person_info`, cookie/localStorage-persisted) and sends them with
 * the `/flags` request — paths that bypass `before_send`. Sentry reads the URL
 * at `Sentry.init` (pageload span, Replay meta event). So user-authored text
 * must already be gone from the address bar at that moment, and nothing may
 * depend on React effect order (R3 relied on a layout effect inside a Suspense
 * boundary, which on a full page load can hydrate after PostHog's effect).
 *
 * `scrubUrlBeforeTelemetry()` is called synchronously:
 *   1. first thing in `instrumentation-client.ts` — Sentry's webpack plugin
 *      prepends that file to the `main-app` entry in production builds, so it
 *      runs before React hydrates and before `Sentry.init`;
 *   2. immediately before `posthog.init` in `PostHogProvider` (idempotent:
 *      independent of whether step 1 ran first, e.g. in `next dev`, where the
 *      plugin appends instead of prepends).
 *
 * It (a) applies the R5 scrub contract (lib/privacy/urlContentScrub.ts, rules
 * shared with the telemetry sanitizer in lib/privacy/urlParamRules.ts): text in
 * `#text=` / `?text=` / `?claim=` / `?q=` — also nested, recursively and within
 * explicit bounds, in `redirect=` / `next=` targets — is moved into the tab
 * hand-offs (memory hold when sessionStorage is unusable) and the nested
 * target rewritten to its clean form; every other content-bearing parameter
 * or fragment is dropped; allowlisted and routing parameters are kept
 * byte-for-byte; and (b) replaces a
 * `document.referrer` that would carry content with its sanitized form
 * (fragment dropped, non-allowlisted query values redacted) so `$initial_referrer`
 * cannot carry text from a full-page navigation that left a claim URL before
 * scripts ran. Dependency-light (no React, no Firebase). Never throws, never logs.
 */
import { migrateContentFromUrl } from "@/lib/client/verifyPrefill";
import {
  captureInvitationCredentialFromLocation,
  installInvitationFragmentNavigationGuard,
  purgeStaleInvitationAcceptance,
} from "@/lib/client/invitationAcceptance";
import { sanitizeUrl } from "@/lib/privacy/sanitizeUrl";

type ScrubWindow = {
  location: Pick<Location, "pathname" | "search" | "hash">;
  history?: Pick<History, "replaceState" | "state"> | null;
  document?: { referrer?: string } | null;
  sessionStorage?: Storage | null;
};

function storageOf(win: ScrubWindow): Pick<Storage, "getItem" | "setItem" | "removeItem"> | null {
  try {
    return win.sessionStorage ?? null; // the getter throws when site data is blocked
  } catch {
    return null;
  }
}

function sanitizeReferrer(doc: { referrer?: string }): void {
  let referrer: string;
  try {
    referrer = String(doc.referrer ?? "");
  } catch {
    return;
  }
  if (!referrer) return;
  const clean = sanitizeUrl(referrer);
  if (clean === referrer) return;
  try {
    // `document.referrer` is a prototype getter; an own property shadows it for every later reader.
    Object.defineProperty(doc, "referrer", { configurable: true, enumerable: true, get: () => clean });
  } catch {
    /* non-configurable in this environment */
  }
}

export function scrubUrlBeforeTelemetry(win: ScrubWindow | undefined = typeof window !== "undefined" ? window : undefined): void {
  if (!win || !win.location) return;
  // GHSA-655j-5f43-92pw: hand the invitation acceptance credential to the page in memory FIRST; the scrub below then
  // drops that fragment like every other key=value fragment (no routing-fragment exception remains).
  captureInvitationCredentialFromLocation(win.location);
  // Correction round: a stale envelope is removed before the per-document telemetry decision, and a credential that
  // later arrives by a same-document fragment navigation is moved to a fresh, telemetry-free document. The guard is
  // registered here, before Sentry.init installs its history handlers, so it runs first.
  purgeStaleInvitationAcceptance(storageOf(win), Date.now());
  installInvitationFragmentNavigationGuard(win as unknown as Parameters<typeof installInvitationFragmentNavigationGuard>[0]);
  try {
    migrateContentFromUrl({ location: win.location, history: win.history ?? null, storage: storageOf(win), currentUid: null });
  } catch {
    /* never throws */
  }
  try {
    if (win.document) sanitizeReferrer(win.document);
  } catch {
    /* never throws */
  }
}
