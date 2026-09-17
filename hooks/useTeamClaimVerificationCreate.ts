"use client";

/**
 * TEAM-VERIFICATION-PARITY-R4-I3 — the ONE client mutation for ORDINARY Team
 * Claim creation, against the already-live
 * `POST /api/workspaces/{W}/verifications`.
 *
 * TWO MODES, one mutation-safety implementation.
 *
 * ORDINARY (R4-I3): `{claim, models}` for an Unfiled Claim, `{claim, models,
 * projectId}` for a Project-bound one.
 *
 * ORIGIN-LINKED (R4-I4): exactly `{runId, claimId, models}`, built by the
 * shared `buildOriginLinkedVerifyClaimRequestBody()` choke point. The client
 * sends no claim text and no `projectId`: the server resolves the authoritative
 * claim, the source run's CURRENT Project and the origin snapshot from the two
 * locators alone. A mixed body is unrepresentable in the input type, and the
 * server would reject it as `ambiguous_request_mode` anyway.
 *
 * THE ROUTE IS THE SCOPE. `projectId` comes from the discriminated address the
 * page was mounted at, never from form state, so no client input can refile a
 * Claim into another Project. For the Unfiled address `projectId` is OMITTED
 * rather than sent as `null`: absence is the server's own ordinary contract.
 *
 * MUTATION SAFETY — this request can run providers and spend quota, and there
 * is no idempotency key, so a retry can create a second Claim and bill twice:
 *
 *   - a synchronous `inFlightRef` (not merely React state) makes a rapid
 *     double-click, double-Enter or button+keyboard activation issue exactly
 *     ONE request;
 *   - NOTHING is retried automatically — not a network failure, not a timeout,
 *     not 5xx, not 429. A dropped connection may have landed;
 *   - the ONE exception is HTTP 401, which the route proves is pre-side-effect:
 *     `getUid()` runs before the rate-limit bucket, before body parsing, before
 *     Gate 1, before quota, before provider execution and before the Gate-2
 *     write. So a 401 cannot have created anything, and exactly one
 *     forced-refresh retry with the identical body is safe. A second 401 is
 *     `auth_error`, with no third request and no body parsing;
 *   - anything that leaves the outcome genuinely unknown (transport failure,
 *     5xx, malformed success body, or a success whose Workspace/Project does
 *     not match this route) returns `outcome_unknown`, never "failed" — the
 *     caller must tell the user to CHECK before resubmitting.
 *
 * The request is deliberately NOT aborted on unmount: a client abort is not a
 * server cancellation, and cancelling a provider-running write would invite
 * exactly the duplicate resubmit this hook exists to prevent. The caller owns
 * navigation ownership instead.
 */

import { useCallback, useRef, useState } from "react";
import type { User } from "firebase/auth";
import { useAuth } from "@/components/AuthProvider";
import { authedFetch } from "@/lib/client/authedFetch";
import { buildOriginLinkedVerifyClaimRequestBody } from "@/lib/verification/originLinkedVerifyClaimRequest";
import type { TeamClaimOriginTarget } from "@/lib/workspaces/teamClaimOriginHandoff";
import type { ModelId } from "@/lib/types";

export type TeamClaimCreateAddress =
  | { kind: "workspace"; workspaceId: string }
  | { kind: "project"; workspaceId: string; projectId: string };

/** A definite server rejection: nothing was created, so correcting and resubmitting is safe. */
export type TeamClaimCreateRejectionCode =
  | "invalid_claim"
  | "claim_too_long"
  | "not_enough_models"
  | "PLAN_MODEL_LIMIT_REACHED"
  | "RUN_LIMIT_REACHED"
  | "rate_limit_exceeded"
  | "unauthorized"
  | "auth_error"
  | "team_workspace_not_found"
  | "insufficient_capability"
  | "project_not_found"
  | "project_archived"
  | "invalid_request"
  | "invalid_request_body"
  | "unexpected_field"
  | "origin_not_eligible"
  | "ambiguous_request_mode"
  | "invalid_origin_locator";

const REJECTION_CODES: ReadonlySet<string> = new Set<TeamClaimCreateRejectionCode>([
  "invalid_claim",
  "claim_too_long",
  "not_enough_models",
  "PLAN_MODEL_LIMIT_REACHED",
  "RUN_LIMIT_REACHED",
  "rate_limit_exceeded",
  "unauthorized",
  "auth_error",
  "team_workspace_not_found",
  "insufficient_capability",
  "project_not_found",
  "project_archived",
  "invalid_request",
  "invalid_request_body",
  "unexpected_field",
  "origin_not_eligible",
  "ambiguous_request_mode",
  "invalid_origin_locator",
]);

/** Safe, user-facing quota data the server may attach to a plan/run-limit rejection. */
export type TeamClaimCreateUsageHint = { runsUsed?: number; runsLimit?: number; resetsAt?: string; plan?: string; maxModelsPerRun?: number };

export type TeamClaimCreateOutcome =
  | { status: "ok"; verificationId: string; workspaceId: string; projectId: string | null }
  /** A definite non-creation. Safe to correct and resubmit. */
  | { status: "rejected"; code: TeamClaimCreateRejectionCode; usage?: TeamClaimCreateUsageHint }
  /** The outcome cannot be proven either way. NEVER auto-resubmit after this. */
  | { status: "outcome_unknown" }
  /** A second submit was attempted while one was already in flight; no request was issued. */
  | { status: "already_submitting" };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * ORDINARY carries the user's own claim text; ORIGIN-LINKED carries only the
 * two locators. A discriminated union makes a mixed body unrepresentable — the
 * server rejects `claim` + `runId` together as `ambiguous_request_mode`, and
 * this type means a call site cannot construct that shape in the first place.
 */
export type TeamClaimCreateInput =
  | { claim: string; selectedModels: ModelId[] }
  | { origin: TeamClaimOriginTarget; selectedModels: ModelId[] };

function isOriginInput(input: TeamClaimCreateInput): input is { origin: TeamClaimOriginTarget; selectedModels: ModelId[] } {
  return "origin" in input;
}

export interface UseTeamClaimVerificationCreateResult {
  isSubmitting: boolean;
  submit: (args: TeamClaimCreateInput) => Promise<TeamClaimCreateOutcome>;
}

export function useTeamClaimVerificationCreate(args: { address: TeamClaimCreateAddress }): UseTeamClaimVerificationCreateResult {
  const { address } = args;
  const { user, authReady } = useAuth();
  const [isSubmitting, setIsSubmitting] = useState(false);
  /** Synchronous: React state updates are batched and cannot gate a same-tick second activation. */
  const inFlightRef = useRef(false);

  const submit = useCallback(
    async (payload: TeamClaimCreateInput): Promise<TeamClaimCreateOutcome> => {
      if (inFlightRef.current) return { status: "already_submitting" };
      if (!authReady || !user) return { status: "rejected", code: "unauthorized" };

      inFlightRef.current = true;
      setIsSubmitting(true);

      const url = `/api/workspaces/${encodeURIComponent(address.workspaceId)}/verifications`;
      // ORIGIN-LINKED: exactly {runId, claimId, models}, built by the shared
      // auditable choke point so no call site can add `claim` or `projectId`.
      // ORDINARY: the route's own scope, never form state; Unfiled OMITS the key.
      const body = isOriginInput(payload)
        ? buildOriginLinkedVerifyClaimRequestBody({ runId: payload.origin.runId, claimId: payload.origin.claimId, models: payload.selectedModels })
        : address.kind === "project"
          ? { claim: payload.claim, models: payload.selectedModels, projectId: address.projectId }
          : { claim: payload.claim, models: payload.selectedModels };
      const serialized = JSON.stringify(body);

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
          // Proven pre-side-effect by the route's ordering; identical body.
          res = await post(true);
          if (res.status === 401) {
            return { status: "rejected", code: "auth_error" };
          }
        }

        // A server fault leaves the outcome genuinely unknown: the write may
        // have landed before the failure. Never reported as "failed".
        if (res.status >= 500) return { status: "outcome_unknown" };

        const raw = await res.json().catch(() => null);

        if (!res.ok) {
          const code = isObject(raw) && typeof raw.errorCode === "string" ? raw.errorCode : null;
          if (code !== null && REJECTION_CODES.has(code)) {
            const usage: Record<string, unknown> = {};
            for (const k of ["runsUsed", "runsLimit", "resetsAt", "plan", "maxModelsPerRun"]) {
              if (isObject(raw) && raw[k] !== undefined) usage[k] = raw[k];
            }
            return {
              status: "rejected",
              code: code as TeamClaimCreateRejectionCode,
              ...(Object.keys(usage).length > 0 ? { usage: usage as TeamClaimCreateUsageHint } : {}),
            };
          }
          // An unrecognised non-2xx below 500 is not provably a non-creation.
          return { status: "outcome_unknown" };
        }

        // Untrusted success body + route containment. A mismatch means an
        // artifact may exist somewhere this form did not address, so it is
        // reported as unknown and NEVER "corrected" by navigating elsewhere.
        if (!isObject(raw) || raw.ok !== true) return { status: "outcome_unknown" };
        if (typeof raw.verificationId !== "string" || raw.verificationId.length === 0) return { status: "outcome_unknown" };
        if (raw.workspaceId !== address.workspaceId) return { status: "outcome_unknown" };

        if (isOriginInput(payload)) {
          // The client has NO Project authority in origin-linked mode: the
          // source run's current Project is resolved server-side and may have
          // changed since the handoff link was created. So the shape is
          // validated, never compared to a browser-held Project id.
          const resolvedProjectId = raw.projectId;
          if (!(resolvedProjectId === null || (typeof resolvedProjectId === "string" && resolvedProjectId.length > 0))) {
            return { status: "outcome_unknown" };
          }
          return { status: "ok", verificationId: raw.verificationId, workspaceId: raw.workspaceId, projectId: resolvedProjectId };
        }

        const expectedProjectId = address.kind === "project" ? address.projectId : null;
        if (raw.projectId !== expectedProjectId) return { status: "outcome_unknown" };

        return { status: "ok", verificationId: raw.verificationId, workspaceId: raw.workspaceId, projectId: expectedProjectId };
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
