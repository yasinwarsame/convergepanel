/**
 * API key format, minting and verification (PRD §7.2; tenancy-and-auth.md §4).
 *
 * Format: `cpk_{live|test}_{keyId}_{secret}` — keyId is 12 base62 chars (public lookup handle, shown as
 * the prefix), secret is 43 base62 chars (~256 bits). Only a verifier is stored:
 *   verifier = hex(HMAC-SHA256(HKDF(pepper, "cp-api/key-verifier/v1"), "<mode>:<keyId>:<secret>"))
 * Binding mode and keyId into the MAC input means a verifier cannot be replayed across keys or modes.
 * Peppers are injected (a PepperSet); during a rotation window the previous pepper is also tried, and the
 * work done does not depend on which one matches.
 */
import { timingSafeEqual } from "node:crypto";
import { randomBase62, isKeyId } from "@/lib/apiPlatform/ids";
import {
  SUBKEY_LABELS,
  deriveSubkey,
  hmacWith,
  readApiKeyPeppers,
  type PepperSet,
} from "@/lib/apiPlatform/secrets.server";

export type KeyMode = "live" | "test";

export const KEY_SECRET_LENGTH = 43;
const KEY_RE = /^cpk_(live|test)_([0-9A-Za-z]{12})_([0-9A-Za-z]{43})$/;

export interface ParsedApiKey {
  readonly mode: KeyMode;
  readonly keyId: string;
  readonly secret: string;
}

export type { PepperSet };

/** Strict parse. Anything else (whitespace, other prefixes, wrong lengths) is null. */
export function parseApiKey(presented: unknown): ParsedApiKey | null {
  if (typeof presented !== "string") return null;
  const m = KEY_RE.exec(presented);
  if (!m) return null;
  return { mode: m[1] as KeyMode, keyId: m[2], secret: m[3] };
}

export const keyPrefix = (mode: KeyMode, keyId: string) => `cpk_${mode}_${keyId}`;

/** Verifier hex for (mode, keyId, secret) under one pepper. */
export function computeVerifier(pepper: Buffer, mode: KeyMode, keyId: string, secret: string): string {
  const subkey = deriveSubkey(pepper, SUBKEY_LABELS.keyVerifier);
  return hmacWith(subkey, `${mode}:${keyId}:${secret}`).toString("hex");
}

export interface MintedKey {
  /** Shown to the user ONCE; never stored or logged. */
  readonly displaySecret: string;
  readonly keyId: string;
  readonly mode: KeyMode;
  readonly prefix: string;
  readonly verifier: string;
}

export type MintResult = { ok: true; key: MintedKey } | { ok: false; reason: "peppers_unavailable" };

export function mintApiKey(mode: KeyMode, peppers: PepperSet = readApiKeyPeppers()): MintResult {
  if (peppers.status !== "available") return { ok: false, reason: "peppers_unavailable" };
  const keyId = randomBase62(12);
  const secret = randomBase62(KEY_SECRET_LENGTH);
  return {
    ok: true,
    key: {
      displaySecret: `${keyPrefix(mode, keyId)}_${secret}`,
      keyId,
      mode,
      prefix: keyPrefix(mode, keyId),
      verifier: computeVerifier(peppers.current, mode, keyId, secret),
    },
  };
}

const HEX64 = /^[0-9a-f]{64}$/;

function equalHex(a: string, b: string): boolean {
  if (!HEX64.test(a) || !HEX64.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

/**
 * True iff `parsed` matches `storedVerifier` under the current pepper or (rotation window) the previous one.
 * Both candidates are always computed when a previous pepper exists.
 */
export function verifierMatches(parsed: ParsedApiKey, storedVerifier: unknown, peppers: PepperSet): boolean {
  if (peppers.status !== "available" || typeof storedVerifier !== "string" || !isKeyId(parsed.keyId)) return false;
  const cur = equalHex(computeVerifier(peppers.current, parsed.mode, parsed.keyId, parsed.secret), storedVerifier);
  const prev = peppers.previous
    ? equalHex(computeVerifier(peppers.previous, parsed.mode, parsed.keyId, parsed.secret), storedVerifier)
    : false;
  return cur || prev;
}

/** Dummy verification for the "no such key" path, so a missing key costs the same work as a wrong secret. */
export function burnVerification(parsed: ParsedApiKey, peppers: PepperSet): void {
  if (peppers.status !== "available") return;
  computeVerifier(peppers.current, parsed.mode, parsed.keyId, parsed.secret);
  if (peppers.previous) computeVerifier(peppers.previous, parsed.mode, parsed.keyId, parsed.secret);
}
