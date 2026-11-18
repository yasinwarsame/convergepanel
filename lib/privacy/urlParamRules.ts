/**
 * PR #329 R5 (R4 review MAJOR-1, owner ruling) — the ONE rule source for URL
 * parameters, shared by the telemetry sanitizer (`lib/privacy/sanitizeUrl.ts`)
 * and the pre-telemetry address-bar scrub (`lib/privacy/urlContentScrub.ts`).
 *
 * Derived from the PRODUCTION URL PRODUCERS and the page-level parameter
 * READERS (source inventory of origin/main cabbdbb and this branch — see the PR
 * body), not from either consumer's implementation:
 *
 *   SAFE_QUERY_PARAM_SHAPES   value may be TRANSMITTED to telemetry (when its
 *                             decoded value matches the shape). Unchanged from R3.
 *   ROUTING_PARAM_SHAPES      every other parameter a page READS to route
 *                             (identifiers, enums, flags). The value stays in the
 *                             address bar so the page keeps working; the
 *                             sanitizer still REDACTS it in telemetry (it is not
 *                             in SAFE_QUERY_PARAM_SHAPES).
 *   NESTED_TARGET_PARAMS      `redirect` / `next`: a URL inside a parameter (the
 *                             signup / login / onboarding detours). Cleaned
 *                             recursively with these same rules.
 *   CONTENT_PARAMS            user-authored text. Never kept in a URL; moved to
 *                             a hand-off only where CONTENT_HANDOFFS says so.
 *
 * ANY OTHER PARAMETER is treated as content-bearing: the sanitizer redacts its
 * value and the pre-telemetry scrub drops it (fail closed). Adding a routing
 * parameter is a privacy decision: its values must never be able to carry
 * user-authored text (shapes are checked on the DECODED value).
 */

// R3 (review MINOR): campaign values are human-readable ("Black Friday", "Spring Sale: 20% off"). The value is
// checked DECODED ("+" and %-escapes already turned into characters): printable letters / digits / spaces and
// common punctuation, at most 100 characters, no control characters. utm_* names are marketer-controlled.
const UTM_VALUE = /^[\p{L}\p{N} _.,:;!?'&()+%\/|#@-]{1,100}$/u;
const LOWER_IDENTIFIER = /^[a-z][a-z0-9_]{0,31}$/;
const SMALL_INTEGER = /^\d{1,6}$/;
const FLAG = /^(?:|0|1|true|false|yes|no)$/i;
/** A record / workspace / project / Stripe-session id as the app's producers encode it (no spaces, no punctuation). */
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Query parameters whose values may be transmitted to telemetry verbatim —
 * and only when the DECODED value matches the parameter's shape (round 2,
 * review MINOR-4: a bare name allowlist let `?tab=<claim text>` through).
 */
export const SAFE_QUERY_PARAM_SHAPES: ReadonlyMap<string, RegExp> = new Map([
  ["utm_source", UTM_VALUE],
  ["utm_medium", UTM_VALUE],
  ["utm_campaign", UTM_VALUE],
  ["utm_term", UTM_VALUE],
  ["utm_content", UTM_VALUE],
  // Every tab value the app routes on (main app + admin + governance). Enumerated, not a pattern.
  ["tab", /^(?:verify|research|video|users|runs|policies|queue|audit)$/],
  ["source", LOWER_IDENTIFIER],
  ["view", LOWER_IDENTIFIER],
  ["scope", LOWER_IDENTIFIER],
  ["plan", LOWER_IDENTIFIER],
  ["interval", LOWER_IDENTIFIER],
  ["cycle", LOWER_IDENTIFIER],
  ["page", SMALL_INTEGER],
  ["limit", SMALL_INTEGER],
  ["offset", SMALL_INTEGER],
  ["signedOut", FLAG],
  ["sessionClearFailed", FLAG],
  ["success", FLAG],
  ["canceled", FLAG],
  ["upgraded", FLAG],
]);

/**
 * Routing parameters READ by pages (inventory section C) that are not
 * telemetry-safe. Kept in the address bar (decoded value must match), redacted
 * in telemetry.
 */
export const ROUTING_PARAM_SHAPES: ReadonlyMap<string, RegExp> = new Map([
  // app/page.tsx deep links (governance / history) and origin-linked claim mode.
  ["openResearchRun", OPAQUE_ID],
  ["openVerification", OPAQUE_ID],
  ["openVideoVerification", OPAQUE_ID],
  ["originRunId", OPAQUE_ID],
  ["originClaimId", OPAQUE_ID],
  // /billing: Stripe Checkout success_url `session_id={CHECKOUT_SESSION_ID}`.
  ["session_id", OPAQUE_ID],
  // /workspace/reviews (WorkspaceReviewQueueShell, server page): workspace id, project filter (id | all | unfiled).
  ["workspace", OPAQUE_ID],
  ["project", OPAQUE_ID],
  // /team/reviews (TeamReviewQueue): enum filters.
  ["kind", LOWER_IDENTIFIER],
  ["flagged", LOWER_IDENTIFIER],
  ["reviewable", LOWER_IDENTIFIER],
]);

/** Parameters whose value is a URL (signup / login / onboarding detours, admin middleware). */
export const NESTED_TARGET_PARAMS: readonly string[] = ["redirect", "next"];

/** Known user-authored-content parameter names (producers P1–P7; PostHog's mask list is derived from these). */
export const CONTENT_PARAMS: readonly string[] = ["text", "claim", "q", "question", "selectedText"];

/** Where content found in a URL is moved instead of being dropped (the existing tab-scoped hand-offs). */
export type ContentHandoffKind = "pending" | "verify" | "research";
export type ContentHandoffRule = {
  /** Path the content arrives on (a trailing slash is ignored). */
  path: string;
  /** The content parameter (query) or fragment key. */
  param: string;
  /** Also accepted in the fragment (`#text=`). */
  fragment: boolean;
  /** Only when `tab` has this value (the main app's legacy `/?tab=verify&claim=` / `/?tab=research&q=`). */
  tab?: string;
  kind: ContentHandoffKind;
};
export const CONTENT_HANDOFFS: readonly ContentHandoffRule[] = [
  { path: "/verify", param: "text", fragment: true, kind: "pending" },
  { path: "/", param: "claim", fragment: false, tab: "verify", kind: "verify" },
  { path: "/", param: "q", fragment: false, tab: "research", kind: "research" },
];

/** Fragments a page legitimately routes on (kept byte-for-byte), keyed by path. Every other key=value fragment is dropped. */
export const ROUTING_FRAGMENT_KEYS: ReadonlyMap<string, readonly string[]> = new Map([
  // Pre-existing bearer invitation link (lib/client/invitationAcceptance.ts strips it itself; reviewer's out-of-scope item).
  ["/workspace-invitations/accept", ["invitationId", "token"]],
]);
/** A plain in-page anchor (`#faq`): kept. */
export const PLAIN_ANCHOR = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

// Bounds for nested targets (owner ruling: explicit; beyond them the parameter is dropped entirely).
export const MAX_NEST_DEPTH = 3;
export const MAX_NESTED_TARGET_CHARS = 2048;
export const MAX_EXTRA_DECODE_PASSES = 3;
export const MAX_QUERY_PAIRS = 64;
/** Path segments of a nested target must be plain tokens (no producer puts content in a path). */
export const NESTED_PATH_SEGMENT = /^[A-Za-z0-9._~-]*$/;

/** True when `key` is telemetry-safe AND its decoded `value` has the allowed shape. */
export function isSafeParamValue(key: string, value: string): boolean {
  const shape = SAFE_QUERY_PARAM_SHAPES.get(key);
  return shape !== undefined && shape.test(value);
}

/** True when `key` is a registered routing parameter AND its decoded `value` has the allowed shape. */
export function isRoutingParamValue(key: string, value: string): boolean {
  const shape = ROUTING_PARAM_SHAPES.get(key);
  return shape !== undefined && shape.test(value);
}

export function isNestedTargetParam(key: string): boolean {
  return NESTED_TARGET_PARAMS.includes(key);
}
