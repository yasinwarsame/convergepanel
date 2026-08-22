/**
 * Team Workspace Invitations, Phase 8D.2 — the app-owned Resend HTTPS
 * adapter for transactional invitation email. No SDK dependency (matches
 * this codebase's existing `lib/connectors/`/`lib/video/visionCalls.ts`
 * convention of calling every external provider via plain `fetch()`).
 *
 * This module owns ONLY the outbound send — it never touches Firestore,
 * never generates a bearer token, and never decides whether an invitation
 * should exist. The raw token, invitation id, and delivery version are all
 * supplied by the caller (the route layer, which itself only ever
 * receives them from the already-committed Phase 8D.1 core).
 *
 * Preview safety: `process.env.VERCEL_ENV === "preview"` short-circuits to
 * `preview_delivery_disabled` before any config validation or network
 * call — a Vercel Preview deployment must never send a real email in this
 * phase, and no preview opt-in variable exists.
 *
 * Configuration is validated lazily, only when this function is actually
 * invoked — importing this module never throws and never requires
 * `RESEND_API_KEY`/`TRANSACTIONAL_EMAIL_FROM`/`APP_BASE_URL` to be set, so
 * builds, tests, and Preview deployments succeed without real credentials.
 */

import "server-only";
import { logger } from "@/lib/logger";
import { RESEND_API_KEY, TRANSACTIONAL_EMAIL_FROM, APP_BASE_URL } from "@/lib/env";

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 2;

export interface SendWorkspaceInvitationEmailArgs {
  invitationId: string;
  deliveryVersion: number;
  rawToken: string;
  to: string;
  workspaceName: string;
  inviterName?: string | null;
  role: "admin" | "member" | "reviewer" | "viewer";
  expiresAt: Date;
}

export type SendWorkspaceInvitationEmailResult =
  | { status: "sent"; providerMessageId: string }
  | { status: "configuration_missing" }
  | { status: "preview_delivery_disabled" }
  | { status: "provider_unavailable" }
  | { status: "provider_rate_limited" }
  | { status: "provider_rejected" }
  | { status: "idempotency_conflict" }
  | { status: "send_failed" };

// ==================================================================
// Private helpers — HTML escaping, content, acceptance URL, idempotency key.
// ==================================================================

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function sanitizeForSubject(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

const ROLE_DISPLAY_NAMES: Record<string, string> = { admin: "Admin", member: "Member", reviewer: "Reviewer", viewer: "Viewer" };

function displayRoleName(role: string): string {
  return ROLE_DISPLAY_NAMES[role] ?? role;
}

function formatExpiresAt(expiresAt: Date): string {
  return expiresAt.toUTCString();
}

/**
 * Fragment-only transport — the bearer token and invitation id are placed
 * after `#`, never in a query parameter or pathname, so they never reach
 * the server in the acceptance page's own HTTP request line, proxy logs,
 * or CDN logs. No trailing slash from `origin` (a `URL`'s own `.origin`
 * never carries one).
 */
function buildInvitationAcceptanceUrl(origin: string, invitationId: string, rawToken: string): string {
  const encodedId = encodeURIComponent(invitationId);
  const encodedToken = encodeURIComponent(rawToken);
  return `${origin}/workspace-invitations/accept#invitationId=${encodedId}&token=${encodedToken}`;
}

/** Frozen exact key shape: `workspace-invitation/<invitationId>/v<deliveryVersion>` — no email, token, or hash. */
function buildDeliveryIdempotencyKey(invitationId: string, deliveryVersion: number): string {
  return `workspace-invitation/${invitationId}/v${deliveryVersion}`;
}

function buildInvitationEmailHtml(args: { workspaceName: string; inviterName: string | null; role: string; expiresAt: Date; acceptanceUrl: string }): string {
  const workspaceName = escapeHtml(args.workspaceName);
  const role = escapeHtml(displayRoleName(args.role));
  const acceptanceUrl = escapeHtml(args.acceptanceUrl);
  const expires = escapeHtml(formatExpiresAt(args.expiresAt));
  const inviterLine = args.inviterName ? `<p>${escapeHtml(args.inviterName)} has invited you.</p>` : "";
  return [
    "<div>",
    "<p>ConvergePanel</p>",
    inviterLine,
    `<p>You've been invited to join <strong>${workspaceName}</strong> as a <strong>${role}</strong>.</p>`,
    `<p><a href="${acceptanceUrl}">Accept invitation</a></p>`,
    `<p>This invitation expires on ${expires}.</p>`,
    "<p>This invitation is intended for your email address. If you weren't expecting this, you can safely ignore it.</p>",
    "</div>",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildInvitationEmailText(args: { workspaceName: string; inviterName: string | null; role: string; expiresAt: Date; acceptanceUrl: string }): string {
  const inviterLine = args.inviterName ? `${args.inviterName} has invited you.` : "";
  return [
    "ConvergePanel",
    inviterLine,
    `You've been invited to join ${args.workspaceName} as a ${displayRoleName(args.role)}.`,
    `Accept your invitation: ${args.acceptanceUrl}`,
    `This invitation expires on ${formatExpiresAt(args.expiresAt)}.`,
    "This invitation is intended for your email address. If you weren't expecting this, you can safely ignore it.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

// ==================================================================
// Provider transport
// ==================================================================

type ResendAttemptOutcome =
  | { kind: "success"; id: string }
  | { kind: "retryable" }
  | { kind: "rate_limited" }
  | { kind: "idempotency_conflict" }
  | { kind: "rejected" }
  | { kind: "malformed_success" };

/**
 * ONE HTTP attempt. Never throws — every failure mode (network error,
 * timeout, non-2xx status, malformed body) is classified into a
 * discriminated outcome. Never logs the request/response body (may echo
 * the recipient address or other request details).
 */
async function performResendAttempt(apiKey: string, idempotencyKey: string, bodyStr: string, attempt: number, invitationId: string): Promise<ResendAttemptOutcome> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
      body: bodyStr,
      signal: controller.signal,
    });
  } catch {
    logger.warn("[email/workspaceInvitations] Resend request failed (network/timeout)", { invitationId, attempt });
    return { kind: "retryable" };
  } finally {
    clearTimeout(timeout);
  }

  if (response.status >= 500) {
    logger.warn("[email/workspaceInvitations] Resend returned a server error", { invitationId, attempt, httpStatus: response.status });
    return { kind: "retryable" };
  }
  if (response.status === 429) {
    logger.warn("[email/workspaceInvitations] Resend rate-limited this request", { invitationId, attempt, httpStatus: response.status });
    return { kind: "rate_limited" };
  }
  if (response.status === 409) {
    let providerCode = "";
    try {
      const parsed = await response.json();
      providerCode = typeof parsed?.name === "string" ? parsed.name : "";
    } catch {
      // Unparseable 409 body — fall through to the conservative, non-retried classification below.
    }
    logger.warn("[email/workspaceInvitations] Resend returned a 409 idempotency conflict", { invitationId, attempt, providerCode });
    if (providerCode === "concurrent_idempotent_requests") {
      return { kind: "retryable" };
    }
    return { kind: "idempotency_conflict" };
  }
  if (response.status >= 400) {
    logger.warn("[email/workspaceInvitations] Resend rejected this request", { invitationId, attempt, httpStatus: response.status });
    return { kind: "rejected" };
  }

  try {
    const parsed = await response.json();
    if (typeof parsed?.id === "string" && parsed.id.length > 0) {
      return { kind: "success", id: parsed.id };
    }
    logger.warn("[email/workspaceInvitations] Resend returned a 2xx response with no usable id", { invitationId, attempt });
    return { kind: "malformed_success" };
  } catch {
    logger.warn("[email/workspaceInvitations] Resend returned an unparseable 2xx response body", { invitationId, attempt });
    return { kind: "malformed_success" };
  }
}

/**
 * The single app-owned interface Phase 8D.2's routes call after an
 * invitation has already durably committed. The provider payload,
 * serialized body, and idempotency key are all constructed exactly ONCE —
 * any retry inside this call reuses them byte-for-byte, never injecting
 * `Date.now()`/a fresh UUID/a fresh nonce. At most `MAX_ATTEMPTS` (2)
 * HTTP attempts are made; retry is reserved for network failure/timeout,
 * HTTP 5xx, and Resend's own `concurrent_idempotent_requests` — never for
 * `invalid_idempotency_key`, `invalid_idempotent_request`, ordinary 4xx,
 * or 429 (see module doc comment / Phase 8D.2 spec §25).
 */
export async function sendWorkspaceInvitationEmail(args: SendWorkspaceInvitationEmailArgs): Promise<SendWorkspaceInvitationEmailResult> {
  if (process.env.VERCEL_ENV === "preview") {
    return { status: "preview_delivery_disabled" };
  }

  if (!RESEND_API_KEY || RESEND_API_KEY.length === 0) {
    return { status: "configuration_missing" };
  }
  if (!TRANSACTIONAL_EMAIL_FROM || TRANSACTIONAL_EMAIL_FROM.length === 0) {
    return { status: "configuration_missing" };
  }
  if (!APP_BASE_URL || APP_BASE_URL.length === 0) {
    return { status: "configuration_missing" };
  }

  let baseUrl: URL;
  try {
    baseUrl = new URL(APP_BASE_URL);
  } catch {
    return { status: "configuration_missing" };
  }
  if (process.env.VERCEL_ENV === "production" && baseUrl.protocol !== "https:") {
    return { status: "configuration_missing" };
  }

  const acceptanceUrl = buildInvitationAcceptanceUrl(baseUrl.origin, args.invitationId, args.rawToken);
  const idempotencyKey = buildDeliveryIdempotencyKey(args.invitationId, args.deliveryVersion);

  const subject = `You're invited to join ${sanitizeForSubject(args.workspaceName)} on ConvergePanel`;
  const html = buildInvitationEmailHtml({ workspaceName: args.workspaceName, inviterName: args.inviterName ?? null, role: args.role, expiresAt: args.expiresAt, acceptanceUrl });
  const text = buildInvitationEmailText({ workspaceName: args.workspaceName, inviterName: args.inviterName ?? null, role: args.role, expiresAt: args.expiresAt, acceptanceUrl });

  const payload = { from: TRANSACTIONAL_EMAIL_FROM, to: args.to, subject, html, text };
  const bodyStr = JSON.stringify(payload);

  let attempt = 0;
  while (attempt < MAX_ATTEMPTS) {
    attempt += 1;
    const outcome = await performResendAttempt(RESEND_API_KEY, idempotencyKey, bodyStr, attempt, args.invitationId);
    switch (outcome.kind) {
      case "success":
        return { status: "sent", providerMessageId: outcome.id };
      case "rate_limited":
        return { status: "provider_rate_limited" };
      case "idempotency_conflict":
        return { status: "idempotency_conflict" };
      case "rejected":
        return { status: "provider_rejected" };
      case "malformed_success":
        return { status: "send_failed" };
      case "retryable":
        if (attempt >= MAX_ATTEMPTS) {
          return { status: "provider_unavailable" };
        }
        continue;
    }
  }
  return { status: "provider_unavailable" };
}
