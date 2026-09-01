"use client";

/**
 * Team Workspace Invitations, Phase 8D.3.1 — invitation-acceptance browser
 * entry point. Frozen by the Phase 8D.3.0/8D.3.0.1 audits:
 *
 * - The credential (`invitationId`/`token`) arrives ONLY via a URL fragment
 *   (`#invitationId=...&token=...`), which never reaches the server, and is
 *   captured/scrubbed from the address bar in a `useLayoutEffect` before
 *   paint. It is kept in a ref, not React state, for the ordinary
 *   already-signed-in path — no need to round-trip it through a render.
 * - `user !== null` is NOT sufficient to call the acceptance API — only
 *   `syncState === "authenticated"` (`canMutate`) proves the client
 *   Firebase uid and the server `__session` cookie agree. See
 *   `AuthProvider.tsx`'s own module doc for why.
 * - A signed-out visitor's credential is persisted to sessionStorage (30
 *   minute TTL) before redirecting to `/login`, so the post-login return
 *   trip can restore it with no fragment involved.
 * - `inFlightRef` is a hard single-flight guard: at most one POST is ever
 *   in the air for a given credential. Only `attemptAcceptance` itself
 *   acquires/releases it — checked and set synchronously, with no async
 *   gap, before `fetch` is ever called. `handleRetry` never force-resets
 *   it; a rapid double-click on Retry (a real Production defect found via
 *   canary testing, Phase 8D.3.4-R1) must see the guard still held by the
 *   first in-flight attempt and no-op. This flow never auto-polls or
 *   auto-loops accept → login → accept.
 * - `successLatchRef` is a second, independent guard: once a successful
 *   acceptance response has been observed, no later response — however it
 *   might arrive — is ever allowed to regress the UI away from success.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { sendEmailVerification, signOut } from "firebase/auth";
import { auth } from "@/lib/firebase/client";
import { useAuth } from "@/components/AuthProvider";
import { clearServerSession } from "@/lib/client/sessionSync";
import {
  clearInvitationAcceptance,
  parseInvitationFragment,
  restoreInvitationAcceptance,
  scrubInvitationAcceptanceHistory,
  storeInvitationAcceptance,
  INVITATION_ACCEPTANCE_ROUTE_PATH,
  type InvitationAcceptanceCredential,
} from "@/lib/client/invitationAcceptance";

type AcceptanceViewState =
  | "initializing"
  | "capturing"
  | "auth_loading"
  | "needs_authentication"
  | "needs_verification"
  | "accepting"
  | "success"
  | "already_member_success"
  | "wrong_account"
  | "invalid_or_expired"
  | "temporarily_unavailable"
  | "internal_error"
  | "session_expired";

interface AcceptResponseBody {
  ok?: boolean;
  workspaceId?: string;
  alreadyMember?: boolean;
  effectiveRole?: string;
  errorCode?: string;
}

const LOGIN_REDIRECT_HREF = `/login?redirect=${encodeURIComponent(INVITATION_ACCEPTANCE_ROUTE_PATH)}`;

export default function AcceptInvitationClient() {
  const router = useRouter();
  const { user, authReady, syncState, canMutate, beginLogout } = useAuth();

  const [viewState, setViewState] = useState<AcceptanceViewState>("initializing");
  const [alreadyMemberRole, setAlreadyMemberRole] = useState<string | null>(null);
  /**
   * Phase 12A.1 — the joined Workspace's id, read ONLY from this exact
   * successful acceptance response (`acceptResult.workspaceId`), never
   * inferred or looked up elsewhere. Drives the post-success redirect so
   * an invited collaborator lands inside the Workspace they just joined
   * instead of the Personal home page.
   */
  const [joinedWorkspaceId, setJoinedWorkspaceId] = useState<string | null>(null);
  const [verificationSendState, setVerificationSendState] = useState<"idle" | "pending" | "sent" | "failed">("idle");
  const [accountSwitchError, setAccountSwitchError] = useState(false);
  const [isAccepting, setIsAccepting] = useState(false);

  const credentialRef = useRef<InvitationAcceptanceCredential | null>(null);
  const captureDoneRef = useRef(false);
  const inFlightRef = useRef(false);
  const successLatchRef = useRef(false);

  // Fragment capture + scrub — runs exactly once, before paint.
  useLayoutEffect(() => {
    if (captureDoneRef.current) return;
    captureDoneRef.current = true;
    setViewState("capturing");
    if (typeof window === "undefined") return;

    const rawHash = window.location.hash;
    const hasHash = rawHash.length > 1; // more than a bare "#"

    if (hasHash) {
      const parsed = parseInvitationFragment(rawHash);
      scrubInvitationAcceptanceHistory(window.history, INVITATION_ACCEPTANCE_ROUTE_PATH);

      if (parsed.kind === "valid") {
        // The fragment is authoritative for this navigation — never
        // silently fall back to an older stored invitation.
        clearInvitationAcceptance(window.sessionStorage);
        credentialRef.current = { invitationId: parsed.invitationId, token: parsed.token };
        setViewState("auth_loading");
      } else {
        clearInvitationAcceptance(window.sessionStorage);
        setViewState("invalid_or_expired");
      }
      return;
    }

    const restored = restoreInvitationAcceptance(window.sessionStorage, Date.now());
    if (restored) {
      credentialRef.current = restored;
      setViewState("auth_loading");
    } else {
      setViewState("invalid_or_expired");
    }
  }, []);

  const classifyAcceptanceResponse = (status: number, body: AcceptResponseBody | null): AcceptanceViewState => {
    switch (status) {
      case 200:
        return body?.alreadyMember === true ? "already_member_success" : "success";
      case 400:
        return "invalid_or_expired";
      case 401:
        // We only ever POST after syncState === "authenticated" — a 401
        // here means the server session has since gone stale, not that the
        // caller was never authenticated in the first place.
        return "session_expired";
      case 403:
        if (body?.errorCode === "email_verification_required") return "needs_verification";
        if (body?.errorCode === "invitation_email_mismatch") return "wrong_account";
        return "internal_error";
      case 404:
        return "invalid_or_expired";
      case 503:
        return "temporarily_unavailable";
      default:
        return "internal_error";
    }
  };

  const attemptAcceptance = useCallback(async (credential: InvitationAcceptanceCredential) => {
    // Synchronous acquire — no async gap between the check and the set, so
    // a second invocation (rapid double-click, a re-firing effect, an
    // overlapping explicit retry) that lands before this one completes
    // always no-ops here, never issuing a second `fetch`.
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setIsAccepting(true);
    setViewState("accepting");

    let res: Response;
    try {
      res = await fetch(`/api/workspace-invitations/${encodeURIComponent(credential.invitationId)}/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({ token: credential.token }),
      });
    } catch {
      inFlightRef.current = false;
      setIsAccepting(false);
      if (successLatchRef.current) return;
      setViewState("temporarily_unavailable");
      return;
    }

    let body: AcceptResponseBody | null = null;
    try {
      body = (await res.json()) as AcceptResponseBody;
    } catch {
      body = null;
    }

    const next = classifyAcceptanceResponse(res.status, body);

    // A success has already been latched — this response is stale/redundant
    // (e.g. a request that was in flight before a prior one committed).
    // Release the lock, but never let it regress the UI away from success.
    if (successLatchRef.current && next !== "success" && next !== "already_member_success") {
      inFlightRef.current = false;
      setIsAccepting(false);
      return;
    }

    switch (next) {
      case "success":
      case "already_member_success":
        successLatchRef.current = true;
        clearInvitationAcceptance(window.sessionStorage);
        credentialRef.current = null;
        inFlightRef.current = false;
        setIsAccepting(false);
        if (next === "already_member_success" && typeof body?.effectiveRole === "string") {
          setAlreadyMemberRole(body.effectiveRole);
        }
        if (typeof body?.workspaceId === "string" && body.workspaceId.length > 0) {
          setJoinedWorkspaceId(body.workspaceId);
        }
        setViewState(next);
        return;
      case "invalid_or_expired":
        clearInvitationAcceptance(window.sessionStorage);
        credentialRef.current = null;
        inFlightRef.current = false;
        setIsAccepting(false);
        setViewState("invalid_or_expired");
        return;
      case "needs_verification":
      case "session_expired":
        // Continuity: verification/re-auth may involve tab switching,
        // reload, or navigation, so this is an approved sessionStorage use.
        storeInvitationAcceptance(window.sessionStorage, credential, Date.now());
        inFlightRef.current = false;
        setIsAccepting(false);
        setViewState(next);
        return;
      case "wrong_account":
      case "temporarily_unavailable":
      case "internal_error":
        inFlightRef.current = false;
        setIsAccepting(false);
        setViewState(next);
        return;
      default:
        inFlightRef.current = false;
        setIsAccepting(false);
        setViewState("internal_error");
        return;
    }
  }, []);

  // Auth-gated orchestration — re-evaluated as authReady/syncState settle.
  useEffect(() => {
    if (viewState !== "auth_loading") return;
    if (!authReady) return;

    const credential = credentialRef.current;
    if (!credential) {
      setViewState("invalid_or_expired");
      return;
    }

    if (syncState === "authenticated" && canMutate) {
      void attemptAcceptance(credential);
      return;
    }

    if (syncState === "signed_out" || syncState === "session_error") {
      storeInvitationAcceptance(window.sessionStorage, credential, Date.now());
      setViewState("needs_authentication");
      router.replace(LOGIN_REDIRECT_HREF);
      return;
    }

    // authenticating / syncing_session / signing_out — keep waiting.
  }, [viewState, authReady, syncState, canMutate, attemptAcceptance, router]);

  const handleRetry = useCallback(() => {
    const credential = credentialRef.current;
    if (!credential) return;
    // Never force-reset inFlightRef here — attemptAcceptance is the sole
    // owner of that lock's lifecycle. If a request is already in flight,
    // this call synchronously no-ops inside attemptAcceptance; if the
    // previous attempt already completed, the lock was already released
    // there, and this is a legitimate new attempt.
    void attemptAcceptance(credential);
  }, [attemptAcceptance]);

  const handleSendVerification = useCallback(async () => {
    if (!user || verificationSendState === "pending") return;
    setVerificationSendState("pending");
    try {
      await sendEmailVerification(user);
      setVerificationSendState("sent");
    } catch {
      setVerificationSendState("failed");
    }
  }, [user, verificationSendState]);

  const handleVerifiedRetry = useCallback(async () => {
    if (user) {
      try {
        await user.reload();
      } catch {
        // Best-effort client freshness only — the server's own
        // adminAuth.getUser(uid) lookup remains authoritative.
      }
    }
    handleRetry();
  }, [user, handleRetry]);

  const handleSwitchAccount = useCallback(async () => {
    const credential = credentialRef.current;
    if (credential) {
      storeInvitationAcceptance(window.sessionStorage, credential, Date.now());
    }
    setAccountSwitchError(false);
    beginLogout();
    try {
      await clearServerSession();
      await signOut(auth);
      router.replace(LOGIN_REDIRECT_HREF);
    } catch {
      setAccountSwitchError(true);
    }
  }, [beginLogout, router]);

  switch (viewState) {
    case "initializing":
    case "capturing":
    case "auth_loading":
      return <p>Loading your invitation…</p>;

    case "needs_authentication":
      return <p>Redirecting you to sign in…</p>;

    case "accepting":
      return <p>Accepting your invitation…</p>;

    case "success":
      return (
        <div>
          <h1>You&apos;ve joined the workspace</h1>
          <p>Your invitation has been accepted.</p>
          <button type="button" onClick={() => router.replace(joinedWorkspaceId ? `/workspace/team/${encodeURIComponent(joinedWorkspaceId)}` : "/")}>
            Go to your Workspace
          </button>
        </div>
      );

    case "already_member_success":
      return (
        <div>
          <h1>You&apos;re already a member</h1>
          <p>You&apos;re already a member of this workspace{alreadyMemberRole ? ` as ${alreadyMemberRole}` : ""}.</p>
          <button type="button" onClick={() => router.replace(joinedWorkspaceId ? `/workspace/team/${encodeURIComponent(joinedWorkspaceId)}` : "/")}>
            Go to your Workspace
          </button>
        </div>
      );

    case "wrong_account":
      return (
        <div role="alert">
          <h1>Different account</h1>
          <p>This invitation belongs to a different account.</p>
          <button type="button" onClick={() => void handleSwitchAccount()}>
            Switch account
          </button>
          {accountSwitchError && <p role="alert">Couldn&apos;t switch accounts. Please try again.</p>}
        </div>
      );

    case "needs_verification":
      return (
        <div>
          <h1>Verify your email</h1>
          <p>Please verify your account&apos;s email address before accepting this invitation.</p>
          <button type="button" onClick={() => void handleSendVerification()} disabled={verificationSendState === "pending"}>
            Send verification email
          </button>
          {verificationSendState === "sent" && <p>Verification email sent.</p>}
          {verificationSendState === "failed" && <p role="alert">Couldn&apos;t send verification email. Please try again.</p>}
          <button type="button" onClick={() => void handleVerifiedRetry()}>
            I&apos;ve verified — retry
          </button>
        </div>
      );

    case "session_expired":
      return (
        <div role="alert">
          <h1>Session expired</h1>
          <p>Your session has expired. Please sign in again.</p>
          <button type="button" onClick={() => void handleSwitchAccount()}>
            Sign in again
          </button>
        </div>
      );

    case "invalid_or_expired":
      return (
        <div role="alert">
          <h1>Invitation unavailable</h1>
          <p>This invitation is invalid, expired, or no longer available.</p>
        </div>
      );

    case "temporarily_unavailable":
      return (
        <div role="alert">
          <h1>Temporarily unavailable</h1>
          <p>We&apos;re having trouble reaching our servers. Please try again.</p>
          <button type="button" onClick={handleRetry} disabled={isAccepting}>
            Retry
          </button>
        </div>
      );

    case "internal_error":
      return (
        <div role="alert">
          <h1>Something went wrong</h1>
          <p>Something went wrong. Please try again.</p>
          <button type="button" onClick={handleRetry} disabled={isAccepting}>
            Retry
          </button>
        </div>
      );

    default:
      return null;
  }
}
