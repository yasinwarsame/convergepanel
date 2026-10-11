/**
 * Order 4 — the acceptance boundary for Source Publisher Class v1.
 *
 * Input is an untrusted, model-authored source string. The URL contract is
 * the SAME as the durable Evidence Workspace contract
 * (`lib/verification/evidenceSourceExtraction.ts`): string → trim → non-empty
 * → ≤ 2048 chars BEFORE parsing → WHATWG URL → http/https only → no userinfo
 * → non-empty hostname. It is never weaker (pinned by parity tests).
 *
 * On top of that it applies classification-only host hygiene. WHATWG has
 * already lowercased the host and converted any IDN to its ASCII (punycode)
 * form — a visually deceptive host therefore becomes a DIFFERENT `xn--` host
 * and can only match an entry written in exactly that ASCII form. This module
 * then strips one trailing dot and rejects hosts that are not a public DNS
 * name: localhost, single-label names, IPv4/IPv6 literals (WHATWG has already
 * canonicalized forms like `2130706433` / `0x7f.0.0.1` / `127.1` to dotted
 * IPv4) and reserved/internal suffixes. Nothing is resolved, fetched or looked
 * up — pure string logic.
 */
import type { SourcePublisherReasonCode } from "./types";

/** Same bound as the durable Evidence Workspace contract (`evidenceSourceExtraction.ts`), checked before parsing. */
export const MAX_AUTHORITY_SOURCE_URL_LENGTH = 2048;

/** Reserved / internal-only suffixes (RFC 6761, RFC 6762, RFC 8375, and the `.internal` reservation). Never a public publisher. */
export const NON_PUBLIC_HOST_SUFFIXES = ["localhost", "local", "internal", "test", "example", "invalid", "home.arpa"] as const;

const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const HOST_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

export type AuthorityHostResult = { ok: true; host: string } | { ok: false; reasonCode: Exclude<SourcePublisherReasonCode, "matched_restricted_namespace" | "matched_registry_entry" | "no_rule_matched"> };

const labelBoundaryMatch = (host: string, domain: string) => host === domain || host.endsWith(`.${domain}`);

export function normalizeAuthorityHost(raw: unknown): AuthorityHostResult {
  if (typeof raw !== "string") return { ok: false, reasonCode: "not_a_url" };
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, reasonCode: "not_a_url" };
  if (trimmed.length > MAX_AUTHORITY_SOURCE_URL_LENGTH) return { ok: false, reasonCode: "over_length" };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, reasonCode: "not_a_url" }; // a plain label ("NIST glossary") is never turned into a domain
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { ok: false, reasonCode: "unsupported_protocol" };
  if (parsed.username !== "" || parsed.password !== "") return { ok: false, reasonCode: "credential_bearing_url" };
  if (parsed.hostname === "") return { ok: false, reasonCode: "not_a_url" };

  // WHATWG output is already lowercase ASCII; lowercasing again is a no-op guard.
  let host = parsed.hostname.toLowerCase();
  if (host.startsWith("[")) return { ok: false, reasonCode: "non_public_host" }; // IPv6 literal
  if (host.endsWith(".")) host = host.slice(0, -1); // exactly one trailing dot
  const labels = host.split(".");
  if (host.length === 0 || labels.length < 2 || labels.some((l) => !HOST_LABEL.test(l))) return { ok: false, reasonCode: "non_public_host" };
  if (IPV4_LITERAL.test(host)) return { ok: false, reasonCode: "non_public_host" };
  if (NON_PUBLIC_HOST_SUFFIXES.some((suffix) => labelBoundaryMatch(host, suffix))) return { ok: false, reasonCode: "non_public_host" };
  return { ok: true, host };
}

export { labelBoundaryMatch };
