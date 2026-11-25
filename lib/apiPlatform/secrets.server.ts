import "server-only";

/**
 * API platform secret boundary (docs/product/api-0/secret-boundary.md; owner Addendum 1 D3 / OQ-1).
 *
 * The ONLY module in the repository that reads an API-platform secret from the environment.
 * - `server-only`: importing this from client code is a build error.
 * - Lazy: values are read when a function is called, never at module load (no build-time literal).
 * - Fail closed: a missing or invalid value is a typed `unavailable` result. There is no default,
 *   development fallback or empty-key HMAC. Callers (the API principal guard) answer 503.
 * - Never logs, throws or returns the raw value; only decoded Buffers leave this module.
 *
 * Scope: API-platform secrets ONLY. Provider keys and flags stay in lib/env.ts (unchanged; Order 6).
 * Importers are an explicit allow-list pinned by lib/apiPlatform/__tests__/secretBoundary.spec.ts.
 */
import { createHmac, hkdfSync } from "node:crypto";

/** Every API-platform secret name, implemented or reserved. Only this module may name them in code. */
export const API_SECRET_NAMES = Object.freeze({
  keyPepper: "API_KEY_PEPPER",
  keyPepperPrevious: "API_KEY_PEPPER_PREVIOUS",
} as const);

/**
 * Reserved for later stages; NOT read by this module until a separately approved change adds a reader
 * (Redis vendor names are fixed once the D5 vendor is approved).
 */
export const RESERVED_API_SECRET_NAMES = Object.freeze([
  "API_QUEUE_SHARED_SECRET",
  "API_STRIPE_WEBHOOK_SECRET",
  "API_WEBHOOK_ENCRYPTION_KEY",
] as const);

export const MIN_PEPPER_BYTES = 32;

export type SecretUnavailableReason =
  | "missing"
  | "not_base64url"
  | "too_short"
  | "previous_equals_current";

export type SecretResult =
  | { readonly status: "available"; readonly value: Buffer }
  | { readonly status: "unavailable"; readonly reason: SecretUnavailableReason };

export type PepperSet =
  | {
      readonly status: "available";
      readonly current: Buffer;
      /** Present only during a rotation window; never equal to `current`. */
      readonly previous: Buffer | null;
    }
  | { readonly status: "unavailable"; readonly reason: SecretUnavailableReason };

const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;

function decodeSecret(raw: string | undefined): SecretResult {
  if (typeof raw !== "string" || raw.trim() === "") return { status: "unavailable", reason: "missing" };
  const trimmed = raw.trim();
  if (!BASE64URL.test(trimmed)) return { status: "unavailable", reason: "not_base64url" };
  const value = Buffer.from(trimmed, "base64url");
  if (value.length < MIN_PEPPER_BYTES) return { status: "unavailable", reason: "too_short" };
  return { status: "available", value };
}

/** Reads the key pepper (and the optional previous pepper) at call time. */
export function readApiKeyPeppers(env: NodeJS.ProcessEnv = process.env): PepperSet {
  const current = decodeSecret(env[API_SECRET_NAMES.keyPepper]);
  if (current.status === "unavailable") return current;
  const rawPrevious = env[API_SECRET_NAMES.keyPepperPrevious];
  if (rawPrevious === undefined || rawPrevious.trim() === "") {
    return { status: "available", current: current.value, previous: null };
  }
  const previous = decodeSecret(rawPrevious);
  if (previous.status === "unavailable") return previous;
  if (previous.value.equals(current.value)) return { status: "unavailable", reason: "previous_equals_current" };
  return { status: "available", current: current.value, previous: previous.value };
}

/** Fixed HKDF purpose labels. Adding one is a reviewed change (secret-boundary.md §3). */
export const SUBKEY_LABELS = Object.freeze({
  keyVerifier: "cp-api/key-verifier/v1",
  listCursor: "cp-api/list-cursor/v1",
} as const);

export type SubkeyLabel = (typeof SUBKEY_LABELS)[keyof typeof SUBKEY_LABELS];

const KNOWN_LABELS: ReadonlySet<string> = new Set(Object.values(SUBKEY_LABELS));

/** HKDF-SHA256(pepper, label) → 32 bytes. Throws only on a programming error (unknown label). */
export function deriveSubkey(pepper: Buffer, label: SubkeyLabel): Buffer {
  if (!KNOWN_LABELS.has(label)) throw new Error("deriveSubkey: unknown label");
  if (!Buffer.isBuffer(pepper) || pepper.length < MIN_PEPPER_BYTES) throw new Error("deriveSubkey: invalid pepper");
  return Buffer.from(hkdfSync("sha256", pepper, Buffer.alloc(0), Buffer.from(label, "utf8"), 32));
}

/** Convenience used by tests and the verifier: HMAC-SHA256(subkey, data). */
export function hmacWith(subkey: Buffer, data: Buffer | string): Buffer {
  return createHmac("sha256", subkey).update(data).digest();
}
