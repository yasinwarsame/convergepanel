/**
 * Team Workspace Invitations, Phase 8D.3.1 — browser credential utility
 * behavior for the invitation-acceptance link
 * (`/workspace-invitations/accept#invitationId=...&token=...`).
 *
 * Scope is deliberately narrow: fragment parsing, malformed-percent
 * validation, input bounds, the transient sessionStorage envelope, and the
 * post-capture history scrub. This module performs NO fetch/API calls, NO
 * Firebase auth, NO navigation (router-level), and NO UI rendering — all of
 * that lives in `AcceptInvitationClient.tsx`, which is the only caller.
 *
 * `URLSearchParams` already percent-decodes `.get()`/`.getAll()` results —
 * running `decodeURIComponent()` on top of that would risk ambiguous or
 * double decoding of a security-relevant credential, so this module decodes
 * exactly once. Malformed percent-encoding is rejected on the RAW fragment
 * substring, before `URLSearchParams` gets a chance to tolerantly normalize
 * it away.
 */

export const SESSION_STORAGE_KEY = "convergepanel.invitationAcceptance.v1";

export const INVITATION_ACCEPTANCE_TTL_MS = 30 * 60 * 1000;

export const INVITATION_ACCEPTANCE_ROUTE_PATH = "/workspace-invitations/accept";

const MAX_INVITATION_ID_LENGTH = 256;
const MAX_TOKEN_LENGTH = 512;
const CONTROL_CHAR_PATTERN = /[\x00-\x1F\x7F]/;

export interface InvitationAcceptanceCredential {
  invitationId: string;
  token: string;
}

export type ParsedInvitationFragment = ({ kind: "valid" } & InvitationAcceptanceCredential) | { kind: "invalid" };

function hasMalformedPercentEncoding(raw: string): boolean {
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== "%") continue;
    const hex = raw.slice(i + 1, i + 3);
    if (!/^[0-9a-fA-F]{2}$/.test(hex)) return true;
  }
  return false;
}

function isWithinBounds(value: string, maxLength: number): boolean {
  return value.length >= 1 && value.length <= maxLength && !CONTROL_CHAR_PATTERN.test(value);
}

/**
 * Parses the raw `location.hash` (leading "#" optional) into a credential.
 * Unknown extra fragment fields are ignored. Duplicate `invitationId`/
 * `token` fields are rejected outright rather than resolved via
 * first-wins/last-wins, since either choice would silently accept an
 * ambiguous, attacker-influenceable input.
 */
export function parseInvitationFragment(rawHash: string): ParsedInvitationFragment {
  if (typeof rawHash !== "string") return { kind: "invalid" };

  const withoutLeadingHash = rawHash.startsWith("#") ? rawHash.slice(1) : rawHash;
  if (withoutLeadingHash.length === 0) return { kind: "invalid" };
  if (hasMalformedPercentEncoding(withoutLeadingHash)) return { kind: "invalid" };

  const params = new URLSearchParams(withoutLeadingHash);
  const invitationIds = params.getAll("invitationId");
  const tokens = params.getAll("token");
  if (invitationIds.length !== 1 || tokens.length !== 1) return { kind: "invalid" };

  const invitationId = invitationIds[0];
  const token = tokens[0];
  if (!isWithinBounds(invitationId, MAX_INVITATION_ID_LENGTH)) return { kind: "invalid" };
  if (!isWithinBounds(token, MAX_TOKEN_LENGTH)) return { kind: "invalid" };

  return { kind: "valid", invitationId, token };
}

interface StoredInvitationAcceptanceEnvelope {
  version: 1;
  invitationId: string;
  token: string;
  storedAt: number;
}

function isValidEnvelopeShape(value: unknown): value is StoredInvitationAcceptanceEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    v.version === 1 &&
    typeof v.invitationId === "string" &&
    isWithinBounds(v.invitationId, MAX_INVITATION_ID_LENGTH) &&
    typeof v.token === "string" &&
    isWithinBounds(v.token, MAX_TOKEN_LENGTH) &&
    typeof v.storedAt === "number" &&
    Number.isFinite(v.storedAt)
  );
}

/** Best-effort write — a quota/private-mode exception leaves nothing stored, never throws. */
export function storeInvitationAcceptance(storage: Pick<Storage, "setItem">, credential: InvitationAcceptanceCredential, now: number): void {
  const envelope: StoredInvitationAcceptanceEnvelope = { version: 1, invitationId: credential.invitationId, token: credential.token, storedAt: now };
  try {
    storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(envelope));
  } catch {
    // Storage unavailable — caller proceeds without persisted continuity.
  }
}

/** Best-effort — never throws. Malformed, wrong-version, or expired records are cleared, not silently extended. */
export function restoreInvitationAcceptance(storage: Pick<Storage, "getItem" | "removeItem">, now: number): InvitationAcceptanceCredential | null {
  let raw: string | null;
  try {
    raw = storage.getItem(SESSION_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    clearInvitationAcceptance(storage);
    return null;
  }

  if (!isValidEnvelopeShape(parsed)) {
    clearInvitationAcceptance(storage);
    return null;
  }

  const age = now - parsed.storedAt;
  if (!Number.isFinite(age) || age < 0 || age > INVITATION_ACCEPTANCE_TTL_MS) {
    clearInvitationAcceptance(storage);
    return null;
  }

  return { invitationId: parsed.invitationId, token: parsed.token };
}

export function clearInvitationAcceptance(storage: Pick<Storage, "removeItem">): void {
  try {
    storage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // Best-effort.
  }
}

export interface ScrubbableHistory {
  readonly state: unknown;
  replaceState(state: unknown, title: string, url?: string | URL | null): void;
}

/**
 * Rewrites the current history entry to strip the credential-bearing
 * fragment, preserving whatever `history.state` Next.js's router already
 * placed there. Never `null` (would blow away router state) and never
 * `pushState` (would leave a credential-bearing entry reachable via back
 * navigation).
 */
export function scrubInvitationAcceptanceHistory(history: ScrubbableHistory, pathname: string = INVITATION_ACCEPTANCE_ROUTE_PATH): void {
  history.replaceState(history.state, "", pathname);
}
