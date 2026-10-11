/**
 * Order 4, Slice 2a — SourceIdentityV1: the ONE canonical identity of a cited
 * document, used by every Source Standing writer and reader. There is no
 * second implementation.
 *
 * Built on the two existing strict primitives rather than a new URL policy:
 *   1. `normalizeEvidenceSourceReferences` — the durable Evidence Workspace
 *      URL contract (string, trim, ≤ 2048 chars before parsing, WHATWG URL,
 *      http/https only, no userinfo, non-empty hostname);
 *   2. `normalizeAuthorityHost` — the source-authority host hygiene (WHATWG
 *      ASCII/punycode host, exactly one trailing dot stripped, localhost /
 *      single-label / IP literals / reserved suffixes rejected).
 * Both must accept the input, and they must agree on the host.
 *
 * The canonical URL is the strict normalized URL with that hygienic host and
 * the fragment removed (a fragment never reaches the server and does not
 * change the document); path and query are kept exactly as WHATWG
 * canonicalizes them. Known, accepted v1 limits: different query strings are
 * different identities, and redirects are not followed — both fail toward
 * "no standing", never toward borrowed standing.
 *
 * idHash = lowercase hex sha256("v1:" + canonicalUrl) — the Firestore document
 * id, so the URL itself is never a document id.
 */
import { createHash } from "crypto";
import { normalizeEvidenceSourceReferences } from "@/lib/verification/evidenceSourceExtraction";
import { normalizeAuthorityHost } from "@/lib/sourceAuthority/normalizeAuthorityHost";

export const SOURCE_IDENTITY_VERSION = 1 as const;

export type SourceIdentityV1 = {
  identityVersion: typeof SOURCE_IDENTITY_VERSION;
  canonicalUrl: string;
  idHash: string;
};

const ID_HASH = /^[0-9a-f]{64}$/;

export function isSourceIdHash(value: unknown): value is string {
  return typeof value === "string" && ID_HASH.test(value);
}

export function sourceIdHash(canonicalUrl: string): string {
  return createHash("sha256").update(`v1:${canonicalUrl}`, "utf8").digest("hex");
}

/** The canonical identity of `raw`, or null when it is not an acceptable public document URL (labels, userinfo, reserved hosts, malformed values …). */
export function sourceIdentityV1(raw: unknown): SourceIdentityV1 | null {
  if (typeof raw !== "string") return null;
  const strict = normalizeEvidenceSourceReferences([raw]);
  if (strict.length !== 1) return null;
  const host = normalizeAuthorityHost(raw);
  if (!host.ok) return null;

  let url: URL;
  try {
    url = new URL(strict[0].url);
  } catch {
    return null;
  }
  // The strict reference keeps a trailing dot; hygiene strips exactly one. Anything else is a disagreement → no identity.
  if (url.hostname !== host.host && url.hostname !== `${host.host}.`) return null;
  url.hostname = host.host;
  url.hash = "";
  if (url.hostname !== host.host || url.username !== "" || url.password !== "") return null;
  const canonicalUrl = url.toString();
  return { identityVersion: SOURCE_IDENTITY_VERSION, canonicalUrl, idHash: sourceIdHash(canonicalUrl) };
}
