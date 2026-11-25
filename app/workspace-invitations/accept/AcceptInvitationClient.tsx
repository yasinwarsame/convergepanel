"use client";

/**
 * Team Workspace Invitations, Phase 8D.3.1 — invitation-acceptance browser
 * entry point. Frozen by the Phase 8D.3.0/8D.3.0.1 audits:
 *
 * - The credential (`invitationId`/`token`) arrives ONLY via a URL fragment
 *   (`#invitationId=...&token=...`), which never reaches the server.
 *   GHSA-655j-5f43-92pw: on a full page load it is captured into memory and
 *   removed from the address bar by `scrubUrlBeforeTelemetry()` BEFORE Sentry
 *   or PostHog initialize (instrumentation-client.ts); this page takes it once
 *   via `takeCapturedInvitationCredential()`. If a fragment is somehow still
 *   present (that scrub did not run first), it is captured/scrubbed here in a
 *   `useLayoutEffect` before paint, as before. It is kept in a ref, not React
 *   state, for the ordinary already-signed-in path.
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
 *   gap, before the request is ever sent. `handleRetry` never force-resets
 *   it; a rapid double-click on Retry (a real Production defect found via
 *   canary testing, Phase 8D.3.4-R1) must see the guard still held by the
 *   first in-flight attempt and no-op. This flow never auto-polls or
 *   auto-loops accept → login → accept.
 * - `successLatchRef` is a second, independent guard: once a successful
 *   acceptance response has been observed, no later response — however it
 *   might arrive — is ever allowed to regress the UI away from success.
 * - Identity-isolation C1 (owner D-3, 2026-11-25): the acceptance POST is
 *   sent through `authedFetch`, so it carries the Firebase ID token of the
 *   user this page currently shows (`Authorization: Bearer`) alongside the
 *   shared `__session` cookie. (The Firebase client session is shared by all
 *   tabs of this origin; the token is not unique to a tab. What it adds is
 *   that the server checks the identity the page renders, not whichever
 *   account last wrote the cookie.)
 *   The server (`resolveRequestIdentity`) then requires both to verify and
 *   name the same uid; a stale cookie for a different account yields a
 *   401 (`credential_mismatch`) and is never accepted as that account.
 *   The token is read from the user this page shows (`useAuth().user`) at
 *   the moment of the attempt; it never appears in a URL or in storage.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { sendEmailVerification, signOut, type User } from "firebase/auth";
import { auth } from "@/lib/firebase/client";
import { authedFetch } from "@/lib/client/authedFetch";
import { useAuth } from "@/components/AuthProvider";
import { clearServerSession } from "@/lib/client/sessionSync";
import { isTelemetryFreeDocument } from "@/lib/telemetry/telemetryFreeDocument";
import {
  clearInvitationAcceptance,
  handOffInvitationCredential,
  hasInvitationAcceptanceEnvelope,
  isInvitationDocumentSuperseded,
  subscribeInvitationDocumentSuperseded,
  parseInvitationFragment,
  restoreInvitationAcceptance,
  scrubInvitationAcceptanceHistory,
  storeInvitationAcceptance,
  takeCapturedInvitationCredential,
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

  // Review R7 F3/F4: re-render the moment this document hands the invitation off (see the render below).
  const superseded = useSyncExternalStore(subscribeInvitationDocumentSuperseded, isInvitationDocumentSuperseded, () => false);

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
    // Review R7 F4: this document already handed the invitation to a successor (e.g. the page chunk loaded after the
    // fragment guard fired). Nothing to do here: stay in the loading view; never "Invitation unavailable".
    if (isInvitationDocumentSuperseded()) return;

    // GHSA-655j-5f43-92pw: on a full page load the pre-telemetry scrub (instrumentation-client.ts, before either SDK
    // initializes) has already captured the credential into memory and removed the fragment. Take it exactly once.
    const captured = takeCapturedInvitationCredential();
    const rawHash = window.location.hash;
    const hasHash = rawHash.length > 1; // more than a bare "#"
    // Defence in depth: a fragment still in the address bar (that scrub did not run first, e.g. `next dev`, where the
    // instrumentation file is appended rather than prepended) is captured and scrubbed here exactly as before.
    const parsed = hasHash ? parseInvitationFragment(rawHash) : captured;

    // Review R4 NIT-2: a credential fragment in a telemetry-ENABLED document (no producer exists; defence in depth) is
    // never processed there: scrubbed, carried in the existing envelope, and the tab moves to a fresh acceptance
    // document (telemetry-free because the envelope is present), as the same-document fragment guard does.
    if (hasHash && parsed && !isTelemetryFreeDocument()) {
      scrubInvitationAcceptanceHistory(window.history, INVITATION_ACCEPTANCE_ROUTE_PATH);
      handOffInvitationCredential(window.sessionStorage, parsed);
      window.location.replace(INVITATION_ACCEPTANCE_ROUTE_PATH);
      return;
    }

    if (parsed) {
      if (hasHash) scrubInvitationAcceptanceHistory(window.history, INVITATION_ACCEPTANCE_ROUTE_PATH);

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

    // GHSA-655j-5f43-92pw (correction round, review R3 MAJOR-1): the envelope holds the raw token, so it is only ever
    // read in a telemetry-free document. A telemetry-enabled document that reaches this page (e.g. one restored from the
    // back/forward cache and then soft-navigated here after sign-in) never touches it: it is replaced by a fresh full
    // load of the acceptance page, which starts with the envelope present and is therefore telemetry-free.
    if (!isTelemetryFreeDocument() && hasInvitationAcceptanceEnvelope(window.sessionStorage)) {
      // Stays in "capturing" (loading view): never "invalid_or_expired", never an acceptance attempt in this document.
      handOffInvitationCredential(window.sessionStorage, null); // envelope untouched; this document loses write access
      window.location.replace(INVITATION_ACCEPTANCE_ROUTE_PATH);
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
        // caller was never authenticated in the first place. Since C1 it also
        // covers a cookie that names a different account than the page's
        // bearer token (`credential_mismatch`); "Sign in again" clears both.
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

  const attemptAcceptance = useCallback(async (credential: InvitationAcceptanceCredential, acceptingUser: User | null) => {
    // Synchronous acquire — no async gap between the check and the set, so
    // a second invocation (rapid double-click, a re-firing effect, an
    // overlapping explicit retry) that lands before this one completes
    // always no-ops here, never issuing a second `fetch`.
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setIsAccepting(true);
    setViewState("accepting");

    // C1: no signed-in Firebase user means no bearer credential to send. Never fall back to a cookie-only request;
    // treat it exactly like a server 401 (keep the credential for the re-authentication round trip).
    if (!acceptingUser) {
      storeInvitationAcceptance(window.sessionStorage, credential, Date.now());
      inFlightRef.current = false;
      setIsAccepting(false);
      if (isInvitationDocumentSuperseded()) return;
      if (successLatchRef.current) return;
      setViewState("session_expired");
      return;
    }

    let res: Response;
    try {
      res = await authedFetch(`/api/workspace-invitations/${encodeURIComponent(credential.invitationId)}/accept`, {
        user: acceptingUser,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify({ token: credential.token }),
      });
    } catch {
      // Network failure, or (C1) the ID token could not be obtained — in which case no request was sent at all.
      inFlightRef.current = false;
      setIsAccepting(false);
      // Review R6 MINOR-3: a later invitation took over this tab while A was in flight; A's failure is not B's.
      if (isInvitationDocumentSuperseded()) return;
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

    // Review R6 MINOR-3: a later invitation (B) took over this tab while this request for A was in flight. A's outcome
    // must not touch B's envelope (also enforced at the storage boundary) nor show a success/failure that reads as B's.
    if (isInvitationDocumentSuperseded()) {
      inFlightRef.current = false;
      setIsAccepting(false);
      return;
    }

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
      case "already_member_success": {
        const acceptedWorkspaceId = typeof body?.workspaceId === "string" && body.workspaceId.length > 0 ? body.workspaceId : null;
        // Phase 12A.1C1 — `workspaceId` is a REQUIRED field on every
        // genuine 200/ok acceptance response (the accept API's typed
        // result has no success variant that omits it). Its absence
        // means this response is malformed under the current contract.
        // Never silently reproduce the old "lands in Personal mode" bug
        // by falling back to "/" — fail safely instead: never latch
        // success, never clear the credential (so Retry can genuinely
        // re-attempt), and surface the EXISTING generic failure UX.
        if (!acceptedWorkspaceId) {
          inFlightRef.current = false;
          setIsAccepting(false);
          setViewState("internal_error");
          return;
        }
        successLatchRef.current = true;
        clearInvitationAcceptance(window.sessionStorage);
        credentialRef.current = null;
        inFlightRef.current = false;
        setIsAccepting(false);
        if (next === "already_member_success" && typeof body?.effectiveRole === "string") {
          setAlreadyMemberRole(body.effectiveRole);
        }
        setJoinedWorkspaceId(acceptedWorkspaceId);
        setViewState(next);
        return;
      }
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
    if (isInvitationDocumentSuperseded()) return; // review R6 MINOR-3: this document no longer owns the invitation

    const credential = credentialRef.current;
    if (!credential) {
      setViewState("invalid_or_expired");
      return;
    }

    if (syncState === "authenticated" && canMutate) {
      void attemptAcceptance(credential, user);
      return;
    }

    if (syncState === "signed_out" || syncState === "session_error") {
      storeInvitationAcceptance(window.sessionStorage, credential, Date.now());
      setViewState("needs_authentication");
      router.replace(LOGIN_REDIRECT_HREF);
      return;
    }

    // authenticating / syncing_session / signing_out — keep waiting.
  }, [viewState, authReady, syncState, canMutate, user, attemptAcceptance, router]);

  const handleRetry = useCallback(() => {
    const credential = credentialRef.current;
    if (!credential || isInvitationDocumentSuperseded()) return;
    // Never force-reset inFlightRef here — attemptAcceptance is the sole
    // owner of that lock's lifecycle. If a request is already in flight,
    // this call synchronously no-ops inside attemptAcceptance; if the
    // previous attempt already completed, the lock was already released
    // there, and this is a legitimate new attempt.
    void attemptAcceptance(credential, user);
  }, [attemptAcceptance, user]);

  const handleSendVerification = useCallback(async () => {
    if (!user || verificationSendState === "pending" || isInvitationDocumentSuperseded()) return; // review R7 F3
    setVerificationSendState("pending");
    try {
      await sendEmailVerification(user);
      if (isInvitationDocumentSuperseded()) return;
      setVerificationSendState("sent");
    } catch {
      if (isInvitationDocumentSuperseded()) return;
      setVerificationSendState("failed");
    }
  }, [user, verificationSendState]);

  const handleVerifiedRetry = useCallback(async () => {
    if (isInvitationDocumentSuperseded()) return; // review R7 F3 (handleRetry re-checks after the reload)
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
    // Review R6 MINOR-3 / R7 F3: ownership is checked immediately before EVERY consequential step. Once a later
    // invitation owns the tab, this document never signs out (shared auth state the successor relies on), never
    // touches the envelope, never navigates and never shows an error about the earlier invitation.
    if (isInvitationDocumentSuperseded()) return;
    const credential = credentialRef.current;
    if (credential) {
      storeInvitationAcceptance(window.sessionStorage, credential, Date.now());
    }
    setAccountSwitchError(false);
    beginLogout();
    try {
      await clearServerSession();
      if (isInvitationDocumentSuperseded()) return;
      await signOut(auth);
      if (isInvitationDocumentSuperseded()) return;
      router.replace(LOGIN_REDIRECT_HREF);
    } catch {
      if (isInvitationDocumentSuperseded()) return;
      setAccountSwitchError(true);
    }
  }, [beginLogout, router]);

  // Review R7 F3/F4: rendering follows the document's hand-off state: once superseded, only the loading view.
  if (superseded || isInvitationDocumentSuperseded()) return <p>Loading your invitation…</p>;

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
          <button
            type="button"
            onClick={() => {
              // By construction, this view only ever renders after a
              // non-empty workspaceId was confirmed present on the
              // acceptance response (see attemptAcceptance's malformed-
              // success guard above) — this is never expected to be
              // null. If it somehow is, do nothing rather than falling
              // back to "/" (Personal mode) — that fallback is exactly
              // the bug this phase exists to prevent.
              if (!joinedWorkspaceId) return;
              router.replace(`/workspace/team/${encodeURIComponent(joinedWorkspaceId)}`);
            }}
          >
            Go to your Workspace
          </button>
        </div>
      );

    case "already_member_success":
      return (
        <div>
          <h1>You&apos;re already a member</h1>
          <p>You&apos;re already a member of this workspace{alreadyMemberRole ? ` as ${alreadyMemberRole}` : ""}.</p>
          <button
            type="button"
            onClick={() => {
              // By construction, this view only ever renders after a
              // non-empty workspaceId was confirmed present on the
              // acceptance response (see attemptAcceptance's malformed-
              // success guard above) — this is never expected to be
              // null. If it somehow is, do nothing rather than falling
              // back to "/" (Personal mode) — that fallback is exactly
              // the bug this phase exists to prevent.
              if (!joinedWorkspaceId) return;
              router.replace(`/workspace/team/${encodeURIComponent(joinedWorkspaceId)}`);
            }}
          >
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
