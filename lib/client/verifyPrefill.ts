/**
 * Privacy remediation (2026-11-17 audit, finding B.6 "URL-borne claim text")
 * — `/verify` prefill hand-off.
 *
 * The browser extension opens `/verify?source=extension&text=<selected text>`.
 * That contract is kept (already-installed extensions keep working), but the
 * text no longer LIVES in the URL: on arrival `/verify` reads it, moves it to
 * this tab's sessionStorage, and rewrites the address bar without it
 * (`history.replaceState`, preserving Next.js's history state). The
 * signup/login detour then carries only `/verify?source=extension` in its
 * `redirect=` — the text is restored from sessionStorage when `/verify`
 * mounts again in the same tab.
 *
 * A `#text=` fragment is accepted too, so the extension can later switch to a
 * fragment (never sent to the server, so never in Vercel request logs) without
 * a coordinated web release — see PR body "owner decisions".
 *
 * This does NOT by itself keep the initial page load's URL out of telemetry:
 * the first `$pageview` and Sentry's pageload transaction can be captured
 * before this runs, and the server sees the full-page request. Telemetry is
 * protected by the boundary sanitizer (`lib/privacy/sanitizeUrl.ts`);
 * request logs are a documented residual.
 */

import { VERIFY_PREFILL_STORAGE_KEY } from "@/lib/client/localPrivateData";

export const VERIFY_TEXT_PARAM = "text";

type LocationLike = Pick<Location, "pathname" | "search" | "hash">;
type HistoryLike = Pick<History, "replaceState" | "state">;
type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function readHashText(hash: string): string | null {
  if (!hash || hash.length < 2) return null;
  try {
    return new URLSearchParams(hash.slice(1)).get(VERIFY_TEXT_PARAM);
  } catch {
    return null;
  }
}

/**
 * Reads the prefill text (query → fragment → this tab's sessionStorage),
 * persists a freshly arrived text to sessionStorage, and strips it from the
 * address bar. Returns the text ("" when none). Never throws.
 */
export function takeVerifyPrefill(env: {
  location: LocationLike;
  history: HistoryLike | null | undefined;
  storage: StorageLike | null | undefined;
}): string {
  const { location, history, storage } = env;
  let params: URLSearchParams;
  try {
    params = new URLSearchParams(location.search);
  } catch {
    params = new URLSearchParams();
  }
  const fromQuery = params.get(VERIFY_TEXT_PARAM);
  const fromHash = readHashText(location.hash);
  const arrived = fromQuery ?? fromHash;

  if (arrived !== null) {
    try {
      if (arrived) storage?.setItem(VERIFY_PREFILL_STORAGE_KEY, arrived);
    } catch {
      /* storage unavailable: the text still prefills this render via the return value */
    }
    params.delete(VERIFY_TEXT_PARAM);
    const rest = params.toString();
    const cleanUrl = `${location.pathname}${rest ? `?${rest}` : ""}`;
    try {
      history?.replaceState(history.state, "", cleanUrl);
    } catch {
      /* ignore */
    }
    return arrived;
  }

  try {
    return storage?.getItem(VERIFY_PREFILL_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

/** Called once the user acts on the text (or it is otherwise consumed). */
export function consumeVerifyPrefill(storage: StorageLike | null | undefined): void {
  try {
    storage?.removeItem(VERIFY_PREFILL_STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * The `redirect=` target for the signup/login detour: `/verify` plus the
 * non-content `source` marker only. The text itself is never put back into a
 * URL.
 */
export function verifyReturnPath(source: string): string {
  return source ? `/verify?source=${encodeURIComponent(source)}` : "/verify";
}
