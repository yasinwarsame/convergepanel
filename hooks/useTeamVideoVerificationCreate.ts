"use client";

/**
 * TEAM-VERIFICATION-PARITY-R5-I3-B — the ONE client mutation for ordinary Team
 * Video creation, against the already-live
 * `POST /api/workspaces/{W}/video-verifications`.
 *
 * This is the TEAM half of the I3-A split. `VideoUploaderSurface` prepares the
 * video in the browser and knows nothing about where it is going; this hook
 * owns everything that makes the request a TEAM request — the Workspace
 * locator, the Project locator, the authenticated identity, the endpoint, the
 * Team error vocabulary and the server-authoritative success envelope.
 *
 * W1 — THE CONSUMER BOUNDARY (carried forward from I3-A).
 *
 * The shared contract proof deliberately does not perform recursive
 * information-flow analysis through every nested type, so the property that
 * actually matters is proven HERE, at the consumer: Team context is CLOSED
 * OVER by this hook and combined with the prepared payload only while building
 * the HTTP request. It is never written into, merged into, or spread onto the
 * `PreparedVideoUpload` value the surface handed us. `buildTeamVideoRequestBody`
 * below is the single choke point where the two meet, it reads exactly four
 * fields off `prepared`, and it never mutates it. The Workspace locator lives
 * in the URL and never in the body at all.
 *
 * THE ROUTE IS THE SCOPE. `projectId` comes from the discriminated address the
 * composer was mounted at, never from form state, so no client input can file a
 * Video into another Project. For the Unfiled address the key is OMITTED rather
 * than sent as `null` — the route canonicalizes absent and explicit-null
 * identically, and absence is its ordinary contract.
 *
 * MUTATION SAFETY — this request runs three vision models and spends quota, and
 * there is no idempotency key, so a retry can create a second Video and bill
 * twice:
 *
 *   - a synchronous `inFlightRef` (not merely React state) makes a rapid
 *     double activation issue exactly ONE request;
 *   - NOTHING is retried automatically — not a network failure, not a timeout,
 *     not 5xx, not 429. A dropped connection may have landed;
 *   - the ONE exception is HTTP 401, which the route's frozen ordering proves
 *     is pre-side-effect: identity resolves before the rate-limit bucket,
 *     before body parsing, before Gate 1, before the dedup lookup, before the
 *     usage pre-charge and before provider execution. So a 401 cannot have
 *     created anything and exactly one forced-refresh retry with the identical
 *     body is safe. A second 401 is `auth_error`, with no third request;
 *   - anything that leaves the outcome genuinely unknown (transport failure,
 *     5xx, an unrecognised sub-500 code, a malformed success body, or a success
 *     whose Workspace/Project does not match this route) returns
 *     `outcome_unknown`, never "rejected" — the caller must tell the user to
 *     CHECK before resubmitting.
 *
 * TWO ERROR VOCABULARIES, on purpose. This route answers body/quota failures in
 * Personal's shape (`{error:{code}}` — `plan_required`, `video_limit_reached`,
 * `no_frames`, …) and authorization failures in the Team concealment shape
 * (`{errorCode}` — `insufficient_capability`, `not_found`,
 * `team_workspaces_disabled`). Both are read; anything else is not provably a
 * non-creation.
 *
 * A `_deduplicated: true` success is a SUCCESS: the server matched an existing
 * Team artifact, freshly reauthorized it for `research.read`, and spent
 * nothing. It carries the same locators and is navigated to identically.
 *
 * The request is deliberately NOT aborted on unmount: a client abort is not a
 * server cancellation, and cancelling a provider-running write would invite
 * exactly the duplicate resubmit this hook exists to prevent.
 */

import { useCallback, useRef, useState } from "react";
import type { User } from "firebase/auth";
import { useAuth } from "@/components/AuthProvider";
import { authedFetch } from "@/lib/client/authedFetch";
import type { PreparedVideoUpload } from "@/lib/verification/videoUploadClientContract";

export type TeamVideoCreateAddress =
  | { kind: "workspace"; workspaceId: string }
  | { kind: "project"; workspaceId: string; projectId: string };

/**
 * A definite server rejection: no Video was created, so correcting and
 * resubmitting is safe.
 *
 * Both of the route's vocabularies are represented. `unauthorized` appears in
 * both — Personal-shaped for the signed-out precondition this hook enforces
 * itself, Team-shaped from the route.
 */
export type TeamVideoCreateRejectionCode =
  // Team concealment vocabulary (`errorCode`)
  | "not_found"
  | "insufficient_capability"
  | "team_workspaces_disabled"
  // Personal-shaped vocabulary (`error.code`)
  | "plan_required"
  | "video_limit_reached"
  | "run_limit_reached"
  | "model_limit"
  | "rate_limit_exceeded"
  | "no_frames"
  | "too_many_frames"
  | "invalid_frame"
  | "invalid_metadata"
  | "file_too_large"
  | "frame_too_large"
  | "payload_too_large"
  | "invalid_request"
  // Client-side preconditions and the terminal second 401
  | "unauthorized"
  | "auth_error";

const REJECTION_CODES: ReadonlySet<string> = new Set<TeamVideoCreateRejectionCode>([
  "not_found",
  "insufficient_capability",
  "team_workspaces_disabled",
  "plan_required",
  "video_limit_reached",
  "run_limit_reached",
  "model_limit",
  "rate_limit_exceeded",
  "no_frames",
  "too_many_frames",
  "invalid_frame",
  "invalid_metadata",
  "file_too_large",
  "frame_too_large",
  "payload_too_large",
  "invalid_request",
  "unauthorized",
  "auth_error",
]);

export type TeamVideoCreateOutcome =
  /** The server confirmed creation (or matched an existing Team artifact). */
  | { status: "ok"; verificationId: string; workspaceId: string; projectId: string | null; deduplicated: boolean }
  /** A definite non-creation. Safe to correct and resubmit. */
  | { status: "rejected"; code: TeamVideoCreateRejectionCode }
  /** The outcome cannot be proven either way. NEVER auto-resubmit after this. */
  | { status: "outcome_unknown" }
  /** A second submit was attempted while one was already in flight; no request was issued. */
  | { status: "already_submitting" };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * W1 CHOKE POINT — the single place prepared video data and Team routing meet.
 *
 * It READS four fields off `prepared` and returns a NEW object. `prepared` is
 * never mutated and never spread wholesale, so no field of it can silently
 * acquire Team context, and no Team field can ride along inside it. The
 * Workspace locator is not here at all: it belongs to the URL.
 *
 * Exported so the consumer-boundary test can drive this exact function rather
 * than a re-implementation of it.
 */
export function buildTeamVideoRequestBody(
  prepared: PreparedVideoUpload,
  projectId: string | null
): { frames: PreparedVideoUpload["frames"]; metadata: PreparedVideoUpload["metadata"]; warnings: string[]; projectId?: string } {
  const body = {
    frames: prepared.frames,
    metadata: prepared.metadata,
    warnings: prepared.warnings,
  };
  // Unfiled OMITS the key; the route canonicalizes absent and null identically.
  return projectId === null ? body : { ...body, projectId };
}

export interface UseTeamVideoVerificationCreateResult {
  isSubmitting: boolean;
  submit: (prepared: PreparedVideoUpload) => Promise<TeamVideoCreateOutcome>;
}

export function useTeamVideoVerificationCreate(args: { address: TeamVideoCreateAddress }): UseTeamVideoVerificationCreateResult {
  const { address } = args;
  const { user, authReady } = useAuth();
  const [isSubmitting, setIsSubmitting] = useState(false);
  /** Synchronous: React state updates are batched and cannot gate a same-tick second activation. */
  const inFlightRef = useRef(false);

  const submit = useCallback(
    async (prepared: PreparedVideoUpload): Promise<TeamVideoCreateOutcome> => {
      if (inFlightRef.current) return { status: "already_submitting" };
      if (!authReady || !user) return { status: "rejected", code: "unauthorized" };

      inFlightRef.current = true;
      setIsSubmitting(true);

      const url = `/api/workspaces/${encodeURIComponent(address.workspaceId)}/video-verifications`;
      const expectedProjectId = address.kind === "project" ? address.projectId : null;
      const serialized = JSON.stringify(buildTeamVideoRequestBody(prepared, expectedProjectId));

      try {
        const post = (forceTokenRefresh = false) =>
          authedFetch(url, {
            user: user as User,
            authReady,
            method: "POST",
            body: serialized,
            ...(forceTokenRefresh ? { forceTokenRefresh: true } : {}),
          });

        let res = await post();

        if (res.status === 401) {
          // Proven pre-side-effect by the route's frozen ordering; identical body.
          res = await post(true);
          if (res.status === 401) {
            return { status: "rejected", code: "auth_error" };
          }
        }

        // A server fault leaves the outcome genuinely unknown: the write may
        // have landed before the failure. Never reported as a rejection.
        if (res.status >= 500) return { status: "outcome_unknown" };

        const raw = await res.json().catch(() => null);

        if (!res.ok) {
          // Team concealment vocabulary first, then Personal's nested shape.
          const teamCode = isObject(raw) && typeof raw.errorCode === "string" ? raw.errorCode : null;
          const nested = isObject(raw) && isObject(raw.error) ? raw.error : null;
          const personalCode = nested && typeof nested.code === "string" ? nested.code : null;
          const code = teamCode ?? personalCode;
          if (code !== null && REJECTION_CODES.has(code)) {
            return { status: "rejected", code: code as TeamVideoCreateRejectionCode };
          }
          // An unrecognised non-2xx below 500 is not provably a non-creation.
          return { status: "outcome_unknown" };
        }

        // Untrusted success body + route containment. A mismatch means an
        // artifact may exist somewhere this composer did not address, so it is
        // reported as unknown and NEVER "corrected" by navigating elsewhere.
        if (!isObject(raw) || raw.ok !== true) return { status: "outcome_unknown" };
        if (typeof raw.verificationId !== "string" || raw.verificationId.length === 0) return { status: "outcome_unknown" };
        if (raw.workspaceId !== address.workspaceId) return { status: "outcome_unknown" };
        if (raw.projectId !== expectedProjectId) return { status: "outcome_unknown" };

        return {
          status: "ok",
          verificationId: raw.verificationId,
          workspaceId: address.workspaceId,
          projectId: expectedProjectId,
          deduplicated: raw._deduplicated === true,
        };
      } catch {
        // Transport failure: the request may have been delivered and executed.
        return { status: "outcome_unknown" };
      } finally {
        inFlightRef.current = false;
        setIsSubmitting(false);
      }
    },
    [address, authReady, user]
  );

  return { isSubmitting, submit };
}
