/**
 * Structural hardening (private advisory GHSA-655j-5f43-92pw follow-up): the browser Sentry TRANSMISSION boundary.
 *
 * Every hook (`beforeSend`, `beforeSendTransaction`, `beforeSendSpan`, `beforeBreadcrumb`, event processors,
 * Replay `beforeAddRecordingEvent`) runs on part of what the SDK sends. One payload reaches the network without
 * passing through any of them: the Session Replay recording. Its rrweb meta event stores `location.href` verbatim
 * (path ids included) and its DOM snapshots store element attributes. This module runs on the whole envelope
 * immediately before the fetch transport serializes it:
 *   - the envelope header's dynamic sampling context (`trace.transaction`) is URL-sanitized (`dsn` is untouched);
 *   - every JSON item (event, transaction, span, replay_event, log, metric, client report, ...) passes through the
 *     shared sanitizer again (idempotent; a field no hook covered cannot carry a raw path, query or fragment);
 *   - a `replay_recording` item is parsed and its meta-event `href` and every URL-bearing DOM attribute sanitized.
 *     The recording must be uncompressed for this (`useCompression: false` in instrumentation-client.ts); a
 *     recording that cannot be parsed is DROPPED (fail closed), never sent unsanitized.
 * Dependency-free (no `@sentry/*` import), never throws.
 */
import { sanitizeUrl, scrubUrlFields } from "./sanitizeUrl";

type AnyRecord = Record<string, unknown>;
type EnvelopeItem = [AnyRecord, unknown];
type Envelope = [AnyRecord, EnvelopeItem[]];

/** DOM attributes whose value is a URL (rrweb snapshots and attribute mutations). */
const URL_ATTRIBUTES = new Set(["href", "src", "srcset", "action", "formaction", "xlink:href", "poster", "data", "cite", "background", "ping"]);

// rrweb event types (stable public enum): 2 FullSnapshot, 3 IncrementalSnapshot, 4 Meta, 5 Custom.
const FULL_SNAPSHOT = 2;
const INCREMENTAL_SNAPSHOT = 3;
const META = 4;
const CUSTOM = 5;

function scrubAttributes(attributes: unknown): void {
  if (!attributes || typeof attributes !== "object") return;
  const rec = attributes as AnyRecord;
  for (const name of Object.keys(rec)) {
    if (URL_ATTRIBUTES.has(name.toLowerCase()) && typeof rec[name] === "string") rec[name] = sanitizeUrl(rec[name] as string);
  }
}

/** Iterative walk over an rrweb serialized node tree (no recursion limit to hit, no depth truncation of the DOM). */
function scrubNodeTree(root: unknown): void {
  const stack: unknown[] = [root];
  let visited = 0;
  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (++visited > 1_000_000) throw new Error("replay snapshot too large to scrub");
    const n = node as AnyRecord;
    scrubAttributes(n.attributes);
    if (Array.isArray(n.childNodes)) for (const child of n.childNodes) stack.push(child);
  }
}

function scrubRecordingEvent(event: unknown): void {
  if (!event || typeof event !== "object") return;
  const e = event as AnyRecord;
  const data = e.data && typeof e.data === "object" ? (e.data as AnyRecord) : undefined;
  if (!data) return;
  switch (e.type) {
    case META:
      if (typeof data.href === "string") data.href = sanitizeUrl(data.href);
      break;
    case FULL_SNAPSHOT:
      scrubNodeTree(data.node);
      break;
    case INCREMENTAL_SNAPSHOT:
      if (Array.isArray(data.adds)) for (const add of data.adds) if (add && typeof add === "object") scrubNodeTree((add as AnyRecord).node);
      if (Array.isArray(data.attributes)) for (const m of data.attributes) if (m && typeof m === "object") scrubAttributes((m as AnyRecord).attributes);
      break;
    case CUSTOM:
      // Breadcrumb / performance-span payloads (already scrubbed by beforeAddRecordingEvent; idempotent).
      scrubUrlFields(data, { maxDepth: 64 });
      break;
    default:
      break;
  }
}

function utf8Length(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Returns the sanitized recording payload (`<headers JSON>\n<events JSON>`), or null when it cannot be parsed
 * (compressed bytes, malformed JSON, oversize): the caller drops the item.
 */
export function scrubReplayRecordingPayload(payload: unknown): string | null {
  try {
    let text: string;
    if (typeof payload === "string") text = payload;
    else if (payload instanceof Uint8Array) text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
    else return null;
    const nl = text.indexOf("\n");
    if (nl === -1) return null;
    const header = text.slice(0, nl + 1);
    JSON.parse(header); // the segment header must itself be JSON
    const events: unknown = JSON.parse(text.slice(nl + 1));
    if (!Array.isArray(events)) return null;
    for (const event of events) scrubRecordingEvent(event);
    return header + JSON.stringify(events);
  } catch {
    return null;
  }
}

/** Mutates and returns the envelope. Items that cannot be sanitized are removed. Never throws. */
export function scrubSentryEnvelope<E>(envelope: E): E {
  try {
    const env = envelope as unknown as Envelope;
    if (!Array.isArray(env) || !Array.isArray(env[1])) return envelope;
    // Only the dynamic sampling context carries page data (`trace.transaction`). The `dsn` header is left exactly as
    // the SDK wrote it: the `/monitoring` tunnel reads it to forward the envelope.
    const trace = env[0] && typeof env[0] === "object" ? (env[0] as AnyRecord).trace : undefined;
    if (trace && typeof trace === "object") scrubUrlFields(trace, { maxDepth: 4 });
    const kept: EnvelopeItem[] = [];
    for (const item of env[1]) {
      if (!Array.isArray(item) || item.length < 2) continue;
      const [headers, payload] = item;
      const type = headers && typeof headers === "object" ? (headers as AnyRecord).type : undefined;
      if (type === "replay_recording") {
        const clean = scrubReplayRecordingPayload(payload);
        if (clean === null) continue; // fail closed: an unscrubbable recording is not sent
        (headers as AnyRecord).length = utf8Length(clean);
        kept.push([headers, clean]);
      } else if (payload && typeof payload === "object" && !(payload instanceof Uint8Array)) {
        scrubUrlFields(payload);
        kept.push(item as EnvelopeItem);
      } else if (typeof payload === "string" || payload instanceof Uint8Array) {
        // Raw items (attachments, profiles) are not produced by this app's configuration; never sent unsanitized.
        continue;
      } else {
        kept.push(item as EnvelopeItem);
      }
    }
    env[1] = kept;
    return envelope;
  } catch {
    // Fail closed: an envelope that could not be inspected is replaced by an empty one.
    const env = envelope as unknown as Envelope;
    try {
      env[1] = [];
    } catch {
      /* frozen */
    }
    return envelope;
  }
}
