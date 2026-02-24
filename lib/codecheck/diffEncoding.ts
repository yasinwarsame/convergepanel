/**
 * Diff Encoding Utilities
 *
 * Handles base64-encoded unified diffs for CodeCheck implementer output.
 * Supports both chunked (diff_b64_chunks) and single-string (diff_b64) formats.
 */

const BASE64_RE = /^[A-Za-z0-9+/=]+$/;
/** Max chunk size for prompt guidance (server auto-splits larger ones). */
const MAX_CHUNK_LEN = 200;
/** Target size when auto-splitting oversized chunks. */
const SPLIT_SIZE = 76;

/** Structured error message when decoded payload is not a unified diff. */
export const NOT_UNIFIED_DIFF_ERROR =
  "Decoded payload is not a unified diff. You must encode a unified diff (--- a/ +++ b/ @@). Do not encode raw file contents.";

export interface DiffDecodeResult {
  ok: boolean;
  diff?: string;
  error?: string;
}

export function isUnifiedDiff(diff: string): boolean {
  const hasMinus = /(^|\n)---\s+\S+/.test(diff);
  const hasPlus = /(^|\n)\+\+\+\s+\S+/.test(diff);
  const hasHunk = /(^|\n)@@\s+-\d+(?:,\d+)?\s+\+\d+(?:,\d+)?\s+@@/.test(diff);
  return hasMinus && hasPlus && hasHunk;
}

/**
 * Validate and join base64 chunks into a single base64 string.
 * Oversized chunks (>200 chars) are auto-split into 76-char pieces
 * so models that return one big chunk don't cause hard failures.
 */
export function joinBase64Chunks(chunks: unknown): DiffDecodeResult {
  if (!Array.isArray(chunks) || chunks.length === 0) {
    return { ok: false, error: "diff_b64_chunks must be a non-empty array" };
  }

  const parts: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (typeof chunk !== "string") {
      return { ok: false, error: `Chunk ${i} is not a string` };
    }
    const trimmed = chunk.trim();
    if (trimmed.length === 0) {
      return { ok: false, error: `Chunk ${i} is empty` };
    }
    if (!BASE64_RE.test(trimmed)) {
      return { ok: false, error: `Chunk ${i} contains invalid base64 characters` };
    }
    // Auto-split oversized chunks instead of rejecting
    if (trimmed.length > MAX_CHUNK_LEN) {
      for (let j = 0; j < trimmed.length; j += SPLIT_SIZE) {
        parts.push(trimmed.slice(j, j + SPLIT_SIZE));
      }
    } else {
      parts.push(trimmed);
    }
  }

  const joined = parts.join("");
  return decodeBase64Diff(joined);
}

/**
 * Decode a single base64 string (legacy format).
 * Strips any embedded whitespace before decoding.
 */
export function decodeBase64Diff(diffB64: string): DiffDecodeResult {
  try {
    const cleaned = diffB64.replace(/\s+/g, "");
    if (cleaned.length > 0 && !BASE64_RE.test(cleaned)) {
      return { ok: false, error: "Base64 string contains invalid characters" };
    }
    const decoded = Buffer.from(cleaned, "base64").toString("utf8");
    if (decoded.includes("\u0000")) {
      return { ok: false, error: "Decoded diff contains NUL bytes" };
    }
    return { ok: true, diff: decoded };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Failed to decode base64 diff",
    };
  }
}
