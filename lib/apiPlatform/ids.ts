/**
 * API platform identifiers (PRD §7.1; tenancy-and-auth.md). Identifiers are NOT secrets.
 * Generated from crypto.randomBytes with rejection sampling (uniform base62, no modulo bias).
 */
import { randomBytes } from "node:crypto";

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

/** Uniform random base62 string of exactly `length` characters. */
export function randomBase62(length: number): string {
  if (!Number.isInteger(length) || length <= 0 || length > 256) throw new Error("randomBase62: invalid length");
  let out = "";
  while (out.length < length) {
    const buf = randomBytes(length * 2);
    for (const byte of buf) {
      if (byte < 248) out += BASE62[byte % 62]; // 248 = 62 * 4: unbiased
      if (out.length === length) break;
    }
  }
  return out;
}

export const ID_PATTERNS = Object.freeze({
  org: /^org_[0-9A-Za-z]{20}$/,
  app: /^app_[0-9A-Za-z]{20}$/,
  keyId: /^[0-9A-Za-z]{12}$/,
  audit: /^aud_[0-9A-Za-z]{24}$/,
  request: /^req_[0-9A-Za-z]{24}$/,
});

export const newOrgId = () => `org_${randomBase62(20)}`;
export const newAppId = () => `app_${randomBase62(20)}`;
export const newKeyId = () => randomBase62(12);
export const newAuditId = () => `aud_${randomBase62(24)}`;

export const isOrgId = (v: unknown): v is string => typeof v === "string" && ID_PATTERNS.org.test(v);
export const isAppId = (v: unknown): v is string => typeof v === "string" && ID_PATTERNS.app.test(v);
export const isKeyId = (v: unknown): v is string => typeof v === "string" && ID_PATTERNS.keyId.test(v);
