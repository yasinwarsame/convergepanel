/**
 * Privacy remediation (2026-11-17 audit) — Sentry boundary scrubbers shared
 * by `instrumentation-client.ts`, `sentry.server.config.ts` and
 * `sentry.edge.config.ts`. Dependency-free (no `@sentry/*` import) so the
 * same code runs in every runtime and is directly unit-testable.
 *
 * Every hook funnels through {@link scrubUrlFields} (the one shared URL
 * sanitizer, `lib/privacy/sanitizeUrl.ts`), then removes request content
 * that has no operational value but can carry claim / question text or
 * credentials: request bodies, cookies, auth headers, IP and email.
 */

import { scrubUrlFields } from "./sanitizeUrl";
import { redactExceptionValue } from "./exceptionText";

type AnyRecord = Record<string, unknown>;

const DROPPED_HEADERS = new Set(["cookie", "set-cookie", "authorization", "x-forwarded-for", "x-real-ip"]);

function scrubRequest(request: unknown): void {
  if (!request || typeof request !== "object") return;
  const req = request as AnyRecord;
  // Request bodies (claim / question JSON) and cookies (`__session`) never leave the app.
  delete req.data;
  delete req.cookies;
  const headers = req.headers;
  if (headers && typeof headers === "object") {
    for (const name of Object.keys(headers as AnyRecord)) {
      if (DROPPED_HEADERS.has(name.toLowerCase())) delete (headers as AnyRecord)[name];
    }
  }
}

function scrubUser(user: unknown): void {
  if (!user || typeof user !== "object") return;
  const u = user as AnyRecord;
  delete u.ip_address;
  delete u.email;
  delete u.username;
}

export const CONSOLE_MESSAGE_REDACTED = "[console message redacted]";

/**
 * Round 2 (review M1): a `console` breadcrumb carries the console call's
 * message and its raw `data.arguments` — which, on this app, have included
 * model output and API responses. Replay inherits these breadcrumbs. Keep the
 * operational signal (category, level, timestamp, logger) and drop the content.
 */
function stripConsoleBreadcrumb(crumb: AnyRecord): void {
  if (crumb.category !== "console") return;
  crumb.message = CONSOLE_MESSAGE_REDACTED;
  const data = crumb.data && typeof crumb.data === "object" ? (crumb.data as AnyRecord) : undefined;
  crumb.data = data && typeof data.logger === "string" ? { logger: data.logger } : undefined;
  if (crumb.data === undefined) delete crumb.data;
}

function scrubExceptions(exception: unknown): void {
  const values = exception && typeof exception === "object" ? (exception as AnyRecord).values : undefined;
  if (!Array.isArray(values)) return;
  for (const v of values) {
    if (v && typeof v === "object" && typeof (v as AnyRecord).value === "string") {
      (v as AnyRecord).value = redactExceptionValue(String((v as AnyRecord).type ?? ""), (v as AnyRecord).value as string);
    }
  }
}

/** `beforeSend` / `beforeSendTransaction` / event processor body. Mutates and returns the event. */
export function scrubSentryEvent<E>(event: E): E {
  if (!event || typeof event !== "object") return event;
  const e = event as unknown as AnyRecord;
  scrubRequest(e.request);
  scrubUser(e.user);
  scrubExceptions(e.exception);
  if (Array.isArray(e.breadcrumbs)) {
    for (const crumb of e.breadcrumbs) if (crumb && typeof crumb === "object") stripConsoleBreadcrumb(crumb as AnyRecord);
  }
  scrubUrlFields(e);
  return event;
}

/** `beforeBreadcrumb` body: console content dropped; navigation `from`/`to`, fetch/xhr `url`, any nested URL field scrubbed. */
export function scrubSentryBreadcrumb<B>(breadcrumb: B): B {
  if (!breadcrumb || typeof breadcrumb !== "object") return breadcrumb;
  stripConsoleBreadcrumb(breadcrumb as unknown as AnyRecord);
  scrubUrlFields(breadcrumb);
  return breadcrumb;
}

/**
 * Replay `beforeAddRecordingEvent` body. Recording events (rrweb meta
 * `href`, full/incremental DOM snapshot `href` attributes, performance-span
 * and breadcrumb custom events) never pass through `beforeSend` or event
 * processors, so URLs in them must be scrubbed here. DOM snapshots are deep,
 * hence the larger depth bound.
 */
export function scrubReplayRecordingEvent<R>(recordingEvent: R): R {
  if (!recordingEvent || typeof recordingEvent !== "object") return recordingEvent;
  // Breadcrumb custom events (`{type: 5, data: {tag: "breadcrumb", payload}}`) include console breadcrumbs
  // with their arguments; strip them exactly as `beforeBreadcrumb` does.
  const data = (recordingEvent as unknown as AnyRecord).data;
  const payload = data && typeof data === "object" ? (data as AnyRecord).payload : undefined;
  if (payload && typeof payload === "object") stripConsoleBreadcrumb(payload as AnyRecord);
  scrubUrlFields(recordingEvent, { maxDepth: 256 });
  return recordingEvent;
}
