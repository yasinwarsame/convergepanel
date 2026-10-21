/**
 * X (Twitter) weighted text length — Order 5, Contract P, H-1.
 *
 * A port of twitter-text 3.1.0 `parseTweet` (configuration v3) and `extractUrlsWithIndices`, over the compiled
 * pattern sources in `xTextRules.generated.ts` (twitter-text 3.1.0, Apache-2.0; twemoji-parser 11.0.2, MIT). The
 * library itself is not a dependency: its published build loads core-js 2 polyfills, which patch built-ins.
 *
 * Rules, as in twitter-text v3:
 * - the text is NFC-normalized first;
 * - every URL twitter-text recognizes counts as `transformedURLLength` (23), whatever its length;
 * - every emoji twemoji-parser recognizes counts as `defaultWeight` (2), whatever its code points;
 * - any other code point weighs 1 inside the configured ranges and 2 outside them (CJK, astral, …);
 * - U+FFFE, U+FEFF and U+FFFF make a post invalid.
 *
 * Domain labels are checked as twitter-text does, by their punycode length (1–63; punycode 1.4.1's `toASCII`, ported
 * for its length only). One deliberate difference, always upwards: where punycode would throw (an overflow, which
 * no real label reaches), the URL counts as the larger of 23 and its own weight — at least X's count whether X keeps
 * or rejects it.
 */
import {
  EMOJI,
  EXTRACT_URL,
  INVALID_CHARS,
  INVALID_URL_WITHOUT_PROTOCOL_PRECEDING_CHARS,
  VALID_ASCII_DOMAIN,
  VALID_TCO_URL,
  X_TEXT_CONFIG,
} from "./xTextRules.generated";

const DEFAULT_PROTOCOL = "https://";
const MAX_URL_LENGTH = 4096;
const MAX_TCO_SLUG_LENGTH = 40;
const MAX_DOMAIN_LABEL_LENGTH = 63;
const PUNYCODE_PREFIX = "xn--";

const rx = (r: { source: string; flags: string }) => new RegExp(r.source, r.flags);

/** A URL twitter-text recognizes, by UTF-16 offsets into the NFC text. `exact` is false when its punycode length was not computed. */
export interface XUrlSpan {
  start: number;
  end: number;
  url: string;
  exact: boolean;
}

// punycode 1.4.1 (MIT), as twitter-text 3.1.0 calls it: only the length of `toASCII(label)` is needed.
const PUNY = { base: 36, tMin: 1, tMax: 26, skew: 38, damp: 700, initialBias: 72, initialN: 128, maxInt: 2147483647 };

function punyAdapt(delta: number, numPoints: number, firstTime: boolean): number {
  let k = 0;
  delta = firstTime ? Math.floor(delta / PUNY.damp) : delta >> 1;
  delta += Math.floor(delta / numPoints);
  for (; delta > ((PUNY.base - PUNY.tMin) * PUNY.tMax) >> 1; k += PUNY.base) delta = Math.floor(delta / (PUNY.base - PUNY.tMin));
  return Math.floor(k + ((PUNY.base - PUNY.tMin + 1) * delta) / (delta + PUNY.skew));
}

/** punycode `ucs2decode`: code points, with an unpaired surrogate kept as its own code unit. */
function ucs2decode(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const v = text.charCodeAt(i);
    if (v >= 0xd800 && v <= 0xdbff && i + 1 < text.length) {
      const x = text.charCodeAt(i + 1);
      if ((x & 0xfc00) === 0xdc00) {
        out.push(((v & 0x3ff) << 10) + (x & 0x3ff) + 0x10000);
        i++;
        continue;
      }
    }
    out.push(v);
  }
  return out;
}

/** Length of punycode `encode(input)`; null where punycode would throw (overflow). */
function punyEncodedLength(input: string): number | null {
  const cps = ucs2decode(input);
  let n = PUNY.initialN;
  let delta = 0;
  let bias = PUNY.initialBias;
  const basic = cps.filter((c) => c < 0x80).length;
  let length = basic + (basic ? 1 : 0);
  let handled = basic;
  while (handled < cps.length) {
    let m = PUNY.maxInt;
    for (const c of cps) if (c >= n && c < m) m = c;
    if (m - n > Math.floor((PUNY.maxInt - delta) / (handled + 1))) return null;
    delta += (m - n) * (handled + 1);
    n = m;
    for (const c of cps) {
      if (c < n && ++delta > PUNY.maxInt) return null;
      if (c === n) {
        for (let q = delta, k = PUNY.base; ; k += PUNY.base) {
          const t = k <= bias ? PUNY.tMin : k >= bias + PUNY.tMax ? PUNY.tMax : k - bias;
          if (q < t) break;
          length += 1;
          q = Math.floor((q - t) / (PUNY.base - t));
        }
        length += 1;
        bias = punyAdapt(delta, handled + 1, handled === basic);
        delta = 0;
        handled += 1;
      }
    }
    delta += 1;
    n += 1;
  }
  return length;
}

/** Length of punycode 1.4.1 `toASCII(text)` (mapDomain: "@" split, RFC 3490 separators); null where it would throw. */
function punyToAsciiLength(text: string): number | null {
  const at = text.split("@");
  let prefix = 0;
  let rest = text;
  if (at.length > 1) {
    prefix = at[0].length + 1;
    rest = at[1];
  }
  const labels = rest.replace(/[\x2E\u3002\uFF0E\uFF61]/g, ".").split(".");
  let total = prefix + labels.length - 1;
  for (const label of labels) {
    if (!/[^\x20-\x7E]/.test(label)) {
      total += label.length;
      continue;
    }
    const len = punyEncodedLength(label);
    if (len === null) return null;
    total += 4 + len;
  }
  return total;
}

/** twitter-text lib/idna `toAscii`, decided by length: "valid", "invalid", or "unknown" where punycode would throw. */
function domainValidity(domain: string): { state: "valid" | "invalid" | "unknown"; asciiLength: number } {
  if (domain.substring(0, 4) === PUNYCODE_PREFIX && !domain.match(rx(VALID_ASCII_DOMAIN))) return { state: "invalid", asciiLength: 0 };
  let asciiLength = 0;
  const labels = domain.split(".");
  for (const label of labels) {
    const len = punyToAsciiLength(label);
    if (len === null) return { state: "unknown", asciiLength: 0 };
    if (len < 1 || len > MAX_DOMAIN_LABEL_LENGTH) return { state: "invalid", asciiLength: 0 };
    asciiLength += len;
  }
  return { state: "valid", asciiLength: asciiLength + labels.length - 1 };
}

/** twitter-text `extractUrlsWithIndices` (URLs without a protocol included), over `text` as given. */
export function xUrlSpans(text: string): XUrlSpan[] {
  if (!text || !/\./.test(text)) return [];
  const spans: XUrlSpan[] = [];
  const extract = rx(EXTRACT_URL);
  let m: RegExpExecArray | null;
  while ((m = extract.exec(text))) {
    const before = m[2] ?? "";
    let url = m[3] ?? "";
    const protocol = m[4] ?? "";
    const domain = m[5] ?? "";
    const path = m[7] ?? "";
    let endPosition = extract.lastIndex;
    const startPosition = endPosition - url.length;
    const validity = domainValidity(domain);
    if (validity.state === "invalid") continue;
    // isValidUrl's length check, with the domain in its punycode form.
    if (validity.state === "valid" && (protocol || DEFAULT_PROTOCOL).length + url.length + validity.asciiLength - domain.length > MAX_URL_LENGTH) continue;
    const exact = validity.state === "valid";
    if (!protocol) {
      if (before.match(rx(INVALID_URL_WITHOUT_PROTOCOL_PRECEDING_CHARS))) continue;
      let last: XUrlSpan | null = null;
      let asciiEnd = 0;
      for (const ascii of domain.match(rx(VALID_ASCII_DOMAIN)) ?? []) {
        const asciiStart = domain.indexOf(ascii, asciiEnd);
        asciiEnd = asciiStart + ascii.length;
        last = { start: startPosition + asciiStart, end: startPosition + asciiEnd, url: ascii, exact };
        spans.push(last);
      }
      if (!last) continue;
      if (path) {
        last.url = url.replace(domain, last.url);
        last.end = endPosition;
      }
    } else {
      const tco = url.match(rx(VALID_TCO_URL));
      if (tco) {
        if (tco[1] && tco[1].length > MAX_TCO_SLUG_LENGTH) continue;
        url = tco[0];
        endPosition = startPosition + url.length;
      }
      spans.push({ start: startPosition, end: endPosition, url, exact });
    }
  }
  return spans;
}

function codeUnitWeight(unit: number): number {
  for (const r of X_TEXT_CONFIG.ranges) if (unit >= r.start && unit <= r.end) return r.weight;
  return X_TEXT_CONFIG.defaultWeight;
}

function isSurrogatePair(text: string, i: number): boolean {
  if (i >= text.length - 1) return false;
  const c = text.charCodeAt(i);
  const n = text.charCodeAt(i + 1);
  return c >= 0xd800 && c <= 0xdbff && n >= 0xdc00 && n <= 0xdfff;
}

/** Scaled weight of `text` with URLs (when given) and emoji collapsed — the parseTweet loop. */
function scaledWeight(text: string, urls: readonly XUrlSpan[]): { weight: number; valid: boolean } {
  const urlAt = new Map(urls.map((u) => [u.start, u]));
  const emojiAt = new Map<number, string>();
  if (X_TEXT_CONFIG.emojiParsingEnabled) {
    const e = rx(EMOJI);
    let m: RegExpExecArray | null;
    while ((m = e.exec(text))) {
      if (m[0] === "") {
        e.lastIndex += 1;
        continue;
      }
      emojiAt.set(m.index, m[0]);
    }
  }
  const invalid = rx(INVALID_CHARS);
  let weight = 0;
  let valid = true;
  for (let i = 0; i < text.length; i++) {
    const url = urlAt.get(i);
    const emoji = emojiAt.get(i);
    if (url) {
      weight += X_TEXT_CONFIG.transformedURLLength * X_TEXT_CONFIG.scale;
      if (!url.exact) {
        const own = scaledWeight(text.slice(url.start, url.start + url.url.length), []).weight;
        weight += Math.max(0, own - X_TEXT_CONFIG.transformedURLLength * X_TEXT_CONFIG.scale);
      }
      i += url.url.length - 1;
    } else if (emoji !== undefined) {
      weight += X_TEXT_CONFIG.defaultWeight;
      i += emoji.length - 1;
    } else {
      i += isSurrogatePair(text, i) ? 1 : 0;
      weight += codeUnitWeight(text.charCodeAt(i));
    }
    if (valid) valid = !invalid.test(text.substring(i, i + 1));
  }
  return { weight, valid };
}

/** X's weighted length of `text` and whether X accepts it (non-empty, no invalid characters, within 280). */
export function parseXText(text: string): { weightedLength: number; valid: boolean } {
  const normalized = text.normalize("NFC");
  const { weight, valid } = scaledWeight(normalized, xUrlSpans(normalized));
  const weightedLength = weight / X_TEXT_CONFIG.scale;
  return { weightedLength, valid: valid && weightedLength > 0 && weightedLength <= X_TEXT_CONFIG.maxWeightedTweetLength };
}

export const X_MAX_WEIGHTED_LENGTH: number = X_TEXT_CONFIG.maxWeightedTweetLength;

/** Characters that make an X post invalid (U+FFFE, U+FEFF, U+FFFF) and unpaired surrogates, removed. */
export function xPostableText(text: string): string {
  return text.replace(/[￾﻿￿]/g, "").replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}
