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
 *                             address bar so the page keeps working. It is NOT
 *                             telemetry-safe: the sanitizer redacts it wherever a
 *                             payload passes through it (PostHog `before_send`,
 *                             Sentry hooks, Replay `beforeAddRecordingEvent`), but
 *                             SDK paths that read `location.href` without such a
 *                             hook (Replay's meta `href`, PostHog `/flags` and the
 *                             persisted `$initial_person_info`) see it RAW. That is
 *                             why a routing value must never be able to carry
 *                             user-authored text.
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

import { isDeepResearchClaimIdShape } from "../verification/deepResearchClaimIdGrammar";

/** A decoded-value check: a RegExp, or an exact-shape validator taken from the value's real generator. */
export type ParamValueShape = { test(value: string): boolean };

// R3 (review MINOR): campaign values are human-readable ("Black Friday", "Spring Sale: 20% off"). The value is
// checked DECODED ("+" and %-escapes already turned into characters): printable letters / digits / spaces and
// common punctuation, at most 100 characters, no control characters. utm_* names are marketer-controlled.
const UTM_VALUE = /^[\p{L}\p{N} _.,:;!?'&()+%\/|#@-]{1,100}$/u;
const LOWER_IDENTIFIER = /^[a-z][a-z0-9_]{0,31}$/;
const SMALL_INTEGER = /^\d{1,6}$/;
const FLAG = /^(?:|0|1|true|false|yes|no)$/i;
/**
 * A record / workspace / project / Stripe-session id as the app's generators produce it (letters, digits, `_`, `-`;
 * no spaces, no punctuation): `run-<uuid>` / `vcl-<uuid>` / `vid-<uuid>` and their pre-2026-05 `<uid>-<ms>-…` forms,
 * `personal-<uid>`, Firestore auto-ids, Stripe `cs_…` ids. See the PR's routing-parameter generator table.
 */
const OPAQUE_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** Exactly the ids `buildDeepResearchClaimId` issues (`v1:<section>:<index>:<43 base64url>`), from the shared grammar. */
const DEEP_RESEARCH_CLAIM_ID: ParamValueShape = { test: isDeepResearchClaimIdShape };

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
  ["success", FLAG],
  ["canceled", FLAG],
  ["upgraded", FLAG],
]);

/**
 * Routing parameters READ by pages (inventory section C) that are not
 * telemetry-safe. Kept in the address bar when the decoded value matches the
 * grammar of its REAL generator (not just the name its producer uses); redacted
 * only on the sanitized telemetry paths (see the header).
 */
export const ROUTING_PARAM_SHAPES: ReadonlyMap<string, ParamValueShape> = new Map<string, ParamValueShape>([
  // app/page.tsx deep links (governance / history) and origin-linked claim mode.
  ["openResearchRun", OPAQUE_ID],
  ["openVerification", OPAQUE_ID],
  ["openVideoVerification", OPAQUE_ID],
  ["originRunId", OPAQUE_ID],
  ["originClaimId", DEEP_RESEARCH_CLAIM_ID],
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

// GHSA-655j-5f43-92pw: no key=value fragment is kept on any path. The former routing-fragment exception (the workspace
// invitation acceptance credential `#invitationId=…&token=…`) is gone: that credential is captured into memory by
// scrubUrlBeforeTelemetry() (lib/client/invitationAcceptance.ts) and then dropped from the address bar before any SDK
// initializes.
/** A plain in-page anchor (`#faq`): kept. */
export const PLAIN_ANCHOR = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

// Bounds for nested targets (owner ruling: explicit; beyond them the parameter is dropped entirely).
export const MAX_NEST_DEPTH = 3;
/**
 * Measured on the once-decoded nested target, where its content is still percent-encoded. Deliberately NOT aligned with
 * verifyPrefill's MAX_PENDING_CHARS (5000): a legacy nested claim link whose target exceeds this bound loses the text,
 * and the post-auth redirect falls back to "/" (fail closed). In a `/verify?source=extension&text=` target that is about
 * 1400 characters of typical English, about 220 of CJK text, about 170 emoji. Disclosed in the PR body.
 */
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
