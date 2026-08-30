/**
 * Decision Receipt Presentation + Source Enrichment, Phase 10D.1 — the one
 * shared pure helper that turns a raw, already-deduplicated list of
 * per-model "source" strings (`AdaptiveDecisionReceipt.sources`) into the
 * safe, deterministic subset a UI may actually render as a clickable link.
 *
 * Every `sources` field across `schemaRegistry.ts`'s 9 dedicated schemas is
 * specified as a "plain label" (e.g. "NIST glossary", "peer-reviewed
 * source") — models are never required to cite a real URL, and often
 * don't. Those plain-text labels are NOT recoverable into a link and are
 * intentionally dropped here rather than rendered as a broken/fake link;
 * only a value that actually parses as an `http:`/`https:` URL survives.
 *
 * Pure and side-effect free: no network request, no metadata/title
 * scraping, no HTML fetch. A URL with no title is displayed by its own
 * hostname — nothing is invented.
 *
 * Cap rationale: each model may cite up to 5 source labels per response for
 * most schemas, or up to 8 for `deep_research` specifically
 * (schemaRegistry.ts's per-schema `sources` field spec — not a single
 * uniform limit across all 9), and a panel run today has at most a handful
 * of contributing models — the deduplicated union realistically lands in
 * the single digits even at the higher per-model ceiling. 10 is a generous
 * bound above that realistic range while still bounding a pathological
 * case (e.g. every model repeating the same handful of URLs with trivial
 * query-string variations that survive exact-string dedup upstream).
 */

const MAX_DISPLAYED_SOURCES = 10;

export interface NormalizedSourceLink {
  url: string;
  hostname: string;
}

/**
 * `rawSources` is already exact-string-deduplicated by the caller
 * (`decisionReceiptBuilder.ts`'s `dedupeExact`) but not yet URL-validated —
 * this function performs the URL-specific filtering, a second dedup pass
 * on the *normalized* URL string (two raw strings that differ only in,
 * say, trailing whitespace or URL-object-insignificant formatting should
 * not both survive), first-seen-order preservation, and the display cap.
 */
export function normalizeSourceUrls(rawSources: string[]): NormalizedSourceLink[] {
  const seen = new Set<string>();
  const result: NormalizedSourceLink[] = [];

  for (const raw of rawSources) {
    if (result.length >= MAX_DISPLAYED_SOURCES) break;

    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;

    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      continue; // not a URL at all — a plain label like "NIST glossary", dropped rather than shown as a broken link
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue; // rejects javascript:, data:, file:, etc.

    const normalized = parsed.toString();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push({ url: normalized, hostname: parsed.hostname });
  }

  return result;
}
