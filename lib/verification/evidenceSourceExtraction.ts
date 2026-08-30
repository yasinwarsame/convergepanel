/**
 * Evidence Workspace, Phase 11A.2a — the canonical, pure normalization
 * helper that turns a Deep Research finding's raw, untrusted `sources`
 * field into a bounded, safe `EvidenceSourceReference[]` snapshot. No
 * Firestore I/O, no network I/O, no mutation — deterministic given its
 * input.
 *
 * DELIBERATELY STRICTER THAN THE DECISION RECEIPT PRESENTATION HELPER
 * (`lib/adaptiveSchema/sourceUrlNormalization.ts`, Phase 10D.1): that
 * helper is a display-layer concern for an already-shipped surface and
 * accepts a credential-bearing `http(s)://user:pass@host/path` URL (only
 * ever rendering its hostname as visible text). This module is defining a
 * NEW durable, persistable Evidence Workspace source-reference contract
 * from scratch, so there is no backward-compatibility reason to carry that
 * same leniency forward — a URL with non-empty userinfo is dropped here,
 * not merely display-neutralized. The two helpers are intentionally not
 * shared or unified; PR #112's own `TECH_DEBT_DECISION_RECEIPT_SOURCE_URL_USERINFO`
 * is untouched by this file.
 *
 * SOURCE REFERENCES, NOT EVIDENCE CONTENT: a surviving entry proves only
 * that a model cited this exact URL for this exact finding — never what
 * the page actually said, and never that the page still says it. Do not
 * rename this concept in a way that implies page-content archival; a
 * future re-verification/change-detection phase needs that distinction to
 * stay honest.
 */

/** Hard bound checked BEFORE `new URL()` ever runs — an untrusted, attacker/model-controlled string must never reach the URL parser unbounded. 2048 is a conservative, widely-used practical URL-length ceiling (the old IE/many reverse-proxy limit); a genuine source citation is never anywhere close to it. */
const MAX_SOURCE_URL_LENGTH = 2048;

/** Per-finding cap, applied after validation/normalization/dedup — first-seen valid unique references win. Mirrors the same order-of-magnitude reasoning as the Decision Receipt helper's own cap (a handful of contributing models, each citing at most a handful of sources), kept as an independent constant rather than an import so the two contracts can diverge without coupling. */
const MAX_EVIDENCE_SOURCES = 10;

export interface EvidenceSourceReference {
  url: string;
  hostname: string;
}

/**
 * `sources` is untrusted persisted Firestore data — never assumed to
 * genuinely be a `string[]` just because the TypeScript type says so.
 * Any individual malformed entry is dropped silently; a non-array,
 * missing, or entirely-malformed input degrades to `[]` rather than
 * throwing — source-reference availability is subordinate metadata and
 * must never turn an otherwise-valid, identifiable finding into an
 * unusable claim origin.
 */
export function normalizeEvidenceSourceReferences(sources: unknown): EvidenceSourceReference[] {
  if (!Array.isArray(sources)) return [];

  const seen = new Set<string>();
  const result: EvidenceSourceReference[] = [];

  for (const raw of sources) {
    if (result.length >= MAX_EVIDENCE_SOURCES) break;
    if (typeof raw !== "string") continue;

    const trimmed = raw.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.length > MAX_SOURCE_URL_LENGTH) continue;

    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      continue; // not a URL at all — a plain label like "NIST glossary", dropped rather than fabricated into a link
    }

    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue; // rejects javascript:, data:, file:, ftp:, vbscript:, etc.
    if (parsed.username !== "" || parsed.password !== "") continue; // credential-bearing URL — dropped, not display-neutralized (see file header)
    if (parsed.hostname === "") continue;

    const normalized = parsed.toString();
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push({ url: normalized, hostname: parsed.hostname });
  }

  return result;
}
