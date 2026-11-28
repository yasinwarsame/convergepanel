/**
 * Session verification handshake — ZCA P3 R2 "verify, don't mint".
 *
 * `POST /api/auth/session` VERIFIES the caller's Firebase ID token (revocation-checked) and answers
 * `{ authenticated: true, uid }`. That answer is the server confirmation behind the client's
 * `syncState === "authenticated"` (components/AuthProvider.tsx, lib/client/sessionSync.ts). It mints
 * NOTHING: there is no session cookie any more, and no route reads one. Every protected route
 * authenticates each request from its own `Authorization: Bearer` (the shared request-identity resolver
 * and the privileged-access guard).
 *
 * Every response of this route — success or failure, POST or DELETE — carries a `__session`
 * EXPIRY (`Max-Age=0`, the attributes the retired cookie was set with) and `Cache-Control: no-store`.
 * The expiry is one-way cleanup of a cookie earlier builds set; it can only delete.
 *
 * Route: POST / DELETE /api/auth/session. There is deliberately no GET (ZCA L-2): Next.js answers 405.
 */

import { NextRequest, NextResponse } from "next/server";
import { adminAuth as firebaseAdminAuth } from "@/lib/firebase/admin";
import { logAuthSessionEvent } from "@/lib/authTelemetry";
import { logger } from "@/lib/logger";
import { getVercelDeploymentHosts } from "@/lib/auth/vercelDeploymentHosts";
import { startVerificationDeadline, type VerificationOutcome } from "@/lib/auth/authVerificationDeadline";
import { isVerifierUnavailableCode } from "@/lib/auth/resolveRequestIdentity";

// Ensure Node.js runtime (Firebase Admin requires Node.js, not Edge)
export const runtime = "nodejs";

/**
 * The ONLY cookie write in the application (pinned by __tests__/authSurface/authSurfaceStatic.spec.ts):
 * an expiry of the retired `__session` cookie, with the attributes it was created with (an expiry with
 * different `path`/`secure`/`sameSite` can be treated as a different cookie and leave the original in
 * place). No `domain` override, so it addresses the exact request host, as the creation did.
 */
function finish(response: NextResponse): NextResponse {
  response.headers.set("Cache-Control", "no-store");
  response.cookies.set("__session", "", { httpOnly: true, secure: true, sameSite: "lax", path: "/", maxAge: 0 });
  return response;
}

function json(body: Record<string, unknown>, status = 200): NextResponse {
  return finish(NextResponse.json(body, { status }));
}

function errorCodeOf(err: unknown): string {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    return typeof code === "string" ? code : "";
  }
  return "";
}

/**
 * R2 L-2 — the origins a handshake may come from, computed SERVER-SIDE ONLY:
 *   - `request.nextUrl.origin` (the origin this request was addressed to);
 *   - the pinned Production hosts (apex, www, the Production `vercel.app` alias);
 *   - this deployment's own Vercel system hosts (`VERCEL_URL`, `VERCEL_BRANCH_URL`), so an isolated
 *     Preview works on both its deployment URL and its branch alias.
 * `Host` / `X-Forwarded-Host` / `X-Forwarded-Proto` are never consulted as an independent source.
 */
const PINNED_PRODUCTION_ORIGINS: readonly string[] = Object.freeze([
  "https://convergepanel.com",
  "https://www.convergepanel.com",
  "https://convergepanel.vercel.app",
]);

const HOST_NAME = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?(?::\d{1,5})?$/i;

function allowedOrigins(request: NextRequest): ReadonlySet<string> {
  const allowed = new Set<string>([request.nextUrl.origin, ...PINNED_PRODUCTION_ORIGINS]);
  for (const host of getVercelDeploymentHosts()) {
    if (HOST_NAME.test(host)) allowed.add(new URL(`https://${host}`).origin);
  }
  return allowed;
}

/**
 * CSRF / origin rule (R1 L1 + R2 L-2). Allowed only when BOTH hold:
 *   - `Sec-Fetch-Site` is `same-origin`, or absent;
 *   - `Origin` is absent, or exactly one of the allowed origins. `Origin: null` (an opaque origin:
 *     sandboxed frame, `data:` page, some redirects) is never allowed.
 * Missing `Origin` (defined behaviour): allowed when `Sec-Fetch-Site` is also same-origin or absent.
 * Every browser in scope sends `Origin` on a `fetch` POST, so its absence means a non-browser caller,
 * which holds its own token and has no ambient credential to abuse — and the handshake mints nothing.
 */
function originVerdict(request: NextRequest): "allowed" | "cross_origin" {
  const site = request.headers.get("sec-fetch-site");
  if (site !== null && site !== "same-origin") return "cross_origin";
  const origin = request.headers.get("origin");
  if (origin === null) return "allowed";
  if (origin === "null") return "cross_origin";
  return allowedOrigins(request).has(origin) ? "allowed" : "cross_origin";
}

function isJsonContentType(value: string | null): boolean {
  if (value === null) return false;
  return value.split(";")[0].trim().toLowerCase() === "application/json";
}

const BEARER = /^Bearer[ \t]+([^\s]+)[ \t]*$/i;

/**
 * R1 L2 — credential precedence. The header and the body are parsed independently:
 *   - a present `Authorization` header that is not `Bearer <token>` is 401 and the body is NOT read
 *     (no fallback);
 *   - a header-only request is valid (no body needed);
 *   - a body token requires `Content-Type: application/json`;
 *   - when both are present they must be byte-equal, else 401 `credential_conflict`.
 * New clients send both (R1 L3, rollback compatibility); old open tabs send the body only.
 */
async function presentedToken(request: NextRequest): Promise<{ ok: true; token: string } | { ok: false; response: NextResponse }> {
  const header = request.headers.get("authorization");
  let headerToken: string | null = null;
  if (header !== null) {
    const match = BEARER.exec(header);
    if (!match) {
      logAuthSessionEvent("session_sync_failed", { route: "POST /api/auth/session", failureCategory: "malformed_authorization" });
      return { ok: false, response: json({ error: "Invalid or expired token", code: "malformed_authorization" }, 401) };
    }
    headerToken = match[1];
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return { ok: false, response: json({ error: "Invalid request body" }, 400) };
  }
  let bodyToken: string | null = null;
  if (raw.trim() !== "") {
    if (!isJsonContentType(request.headers.get("content-type"))) {
      return { ok: false, response: json({ error: "Content-Type must be application/json", code: "unsupported_media_type" }, 415) };
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return { ok: false, response: json({ error: "Invalid request body" }, 400) };
    }
    if (typeof body === "object" && body !== null && "idToken" in body) {
      const t = (body as { idToken?: unknown }).idToken;
      if (typeof t !== "string" || t === "") return { ok: false, response: json({ error: "ID token is required" }, 400) };
      bodyToken = t;
    }
  }

  if (headerToken !== null && bodyToken !== null && headerToken !== bodyToken) {
    logAuthSessionEvent("session_sync_failed", { route: "POST /api/auth/session", failureCategory: "credential_conflict" });
    return { ok: false, response: json({ error: "Invalid or expired token", code: "credential_conflict" }, 401) };
  }
  const token = headerToken ?? bodyToken;
  if (token === null) return { ok: false, response: json({ error: "ID token is required" }, 400) };
  return { ok: true, token };
}

export async function POST(request: NextRequest) {
  if (originVerdict(request) !== "allowed") {
    logAuthSessionEvent("session_sync_failed", { route: "POST /api/auth/session", failureCategory: "cross_origin" });
    return json({ error: "Cross-origin request refused", code: "cross_origin" }, 403);
  }

  const presented = await presentedToken(request);
  if (!presented.ok) return presented.response;
  const idToken = presented.token;

  // A local const: its null-check narrowing also holds inside the deadline closure below.
  const adminAuth = firebaseAdminAuth;
  if (!adminAuth) {
    logger.error("[auth-session] POST failed: Firebase Admin Auth is not initialized");
    return json({ error: "Authentication service unavailable" }, 500);
  }

  // uid is derived EXCLUSIVELY from server-side verification of the presented token — the client
  // never asserts its own uid.
  //
  // checkRevoked = true (SESSREV): the SDK reads the live Auth record (`getUser`) and rejects a
  // DISABLED account (`auth/user-disabled`) and a token whose `auth_time` predates
  // `tokensValidAfterTime` (`auth/id-token-revoked`).
  //
  // R5 (deadline): the live read runs under the end-to-end deadline shared with
  // resolveRequestIdentity (AUTH_VERIFICATION_DEADLINE_MS, including the per-instance cap on
  // in-flight verifications). Pending at the deadline — or refused at the cap — answers the same
  // 503 as a verifier outage; a result that arrives later is never read.
  const deadline = startVerificationDeadline("session_mint");
  try {
    const verified = await deadline.run(() => adminAuth.verifyIdToken(idToken, true));
    if (verified.kind === "deadline" || verified.kind === "capped") {
      return verificationUnavailable("identity verification unavailable", verified.kind);
    }
    let decodedUid: string;
    try {
      if (verified.kind === "rejected") throw verified.error;
      const decoded = verified.value;
      if (typeof decoded?.uid !== "string" || decoded.uid === "") {
        throw Object.assign(new Error("decoded token has no uid"), { code: "auth/invalid-id-token" });
      }
      decodedUid = decoded.uid;
    } catch (err) {
      const code = errorCodeOf(err);
      if (isVerifierUnavailableCode(code)) {
        // The verifier could not run (Auth backend / network) — not a verdict on the credential.
        logger.error("[auth-session] POST failed: identity verification unavailable", { errorCode: code });
        logAuthSessionEvent("session_sync_failed", { route: "POST /api/auth/session", failureCategory: "auth_unavailable" });
        return authUnavailableResponse();
      }
      // Disabled and revoked are deliberately indistinguishable from an invalid token in the response
      // body (no account-state disclosure); the category is recorded server-side only.
      const failureCategory =
        code === "auth/user-disabled" ? "account_disabled" : code.includes("revoked") ? "revoked_token" : "invalid_token";
      logAuthSessionEvent("session_sync_failed", { route: "POST /api/auth/session", failureCategory });
      return json({ error: "Invalid or expired token" }, 401);
    }
    logAuthSessionEvent("session_sync_succeeded", { route: "POST /api/auth/session" });
    return json({ authenticated: true, uid: decodedUid });
  } finally {
    deadline.dispose();
  }
}

/**
 * The deadline / cap answer: the route's verifier-outage 503 (same body and telemetry category). The
 * cut-off itself is logged by the deadline module.
 */
function verificationUnavailable(step: string, cause: Exclude<VerificationOutcome<unknown>["kind"], "fulfilled" | "rejected">): NextResponse {
  logger.error(`[auth-session] POST failed: ${step}`, { cause });
  logAuthSessionEvent("session_sync_failed", { route: "POST /api/auth/session", failureCategory: "auth_unavailable" });
  return authUnavailableResponse();
}

/**
 * Stage 0 (owner D-7): the single "verification could not run" answer: HTTP 503 plus
 * `code: "auth_unavailable"` (the same code getRequestUid / reportReviewCaller answer). How the client
 * handles it (lib/client/sessionSync.ts, components/AuthProvider.tsx, Stage 0 F3): a same-uid token
 * refresh of an already-confirmed tab keeps its state; every other handshake ends as `server_error`
 * and Firebase is signed out. The client never retries a 503 automatically.
 */
function authUnavailableResponse(): NextResponse {
  return json({ error: "Authentication service unavailable", code: "auth_unavailable" }, 503);
}

/**
 * DELETE — an idempotent expiry of the retired cookie, for tabs still running an older build. No
 * current client calls it (pinned by the authSurface static oracle). Always 200.
 */
export async function DELETE(_request: NextRequest) {
  logAuthSessionEvent("session_cleared", { route: "DELETE /api/auth/session" });
  return json({ authenticated: false });
}
