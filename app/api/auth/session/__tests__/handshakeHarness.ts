/**
 * ZCA P3 R2 — shared helpers for the session verification handshake specs (`POST /api/auth/session`).
 *
 *  - `strictAdminAuth(verify)`: an Admin Auth double whose ONLY member is `verifyIdToken`. Reading any
 *    other member (e.g. a cookie-minting method) is RECORDED in `forbiddenAdminAccess` and yields
 *    `undefined`, so a route that tried to mint would both be caught by name-free assertion
 *    (`expect(forbiddenAdminAccess).toEqual([])`) and fail on the call.
 *  - `expectExpiryOnly(res)`: the response carries `no-store` and EXACTLY ONE `Set-Cookie`, the
 *    `__session` expiry with the retired cookie's attributes — never a non-expiry cookie.
 *  - `handshakeRequest(...)`: builds a POST with independent control of the Authorization header, the
 *    raw body, Content-Type, Origin, Sec-Fetch-Site and any spoofable header.
 */
import { NextRequest } from "next/server";

export const forbiddenAdminAccess: string[] = [];

export function strictAdminAuth(verify: (...a: unknown[]) => unknown): Record<string, unknown> {
  return new Proxy(
    {},
    {
      get(_t, key) {
        if (key === "verifyIdToken") return verify;
        if (typeof key === "symbol" || key === "then" || key === "toJSON") return undefined;
        forbiddenAdminAccess.push(String(key));
        return undefined;
      },
    }
  );
}

export const EXPIRY_SET_COOKIE = "__session=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=lax";

export function setCookiesOf(res: Response): string[] {
  const h = res.headers as Headers & { getSetCookie?: () => string[] };
  if (typeof h.getSetCookie === "function") return h.getSetCookie();
  const one = res.headers.get("set-cookie");
  return one ? [one] : [];
}

export function expectExpiryOnly(res: Response): void {
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  expect(setCookiesOf(res)).toEqual([EXPIRY_SET_COOKIE]);
}

export type HandshakeOpts = {
  url?: string;
  /** The raw Authorization header value (exactly as sent). */
  authorization?: string;
  /** Shorthand: `Authorization: Bearer <bearer>`. */
  bearer?: string;
  /** A JSON body `{ idToken: bodyToken }`. */
  bodyToken?: string;
  /** A raw body (wins over bodyToken). */
  rawBody?: string;
  /** Content-Type; defaults to application/json when a body is sent; `null` omits it. */
  contentType?: string | null;
  /** Origin; defaults to the request URL's origin; `null` omits it. */
  origin?: string | null;
  /** Sec-Fetch-Site; defaults to "same-origin"; `null` omits it. */
  secFetchSite?: string | null;
  headers?: Record<string, string>;
};

export function handshakeRequest(opts: HandshakeOpts = {}): NextRequest {
  const url = opts.url ?? "http://localhost:3000/api/auth/session";
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  const body = opts.rawBody ?? (opts.bodyToken !== undefined ? JSON.stringify({ idToken: opts.bodyToken }) : undefined);
  if (opts.authorization !== undefined) headers.authorization = opts.authorization;
  else if (opts.bearer !== undefined) headers.authorization = `Bearer ${opts.bearer}`;
  const contentType = opts.contentType === undefined ? (body !== undefined ? "application/json" : null) : opts.contentType;
  if (contentType !== null) headers["content-type"] = contentType;
  const origin = opts.origin === undefined ? new URL(url).origin : opts.origin;
  if (origin !== null) headers.origin = origin;
  const site = opts.secFetchSite === undefined ? "same-origin" : opts.secFetchSite;
  if (site !== null) headers["sec-fetch-site"] = site;
  return new NextRequest(url, { method: "POST", headers, ...(body !== undefined ? { body } : {}) });
}
