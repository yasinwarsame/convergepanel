"use client";

/**
 * TEAM-VERIFICATION-PARITY-R4-I1 — the ONE client read of a Team Claim
 * verification DETAIL, backed by the already-live R3 endpoint
 * `GET /api/workspaces/{W}/verifications/{verificationId}[?projectId={P}]`.
 *
 * NOT AN AUTHORIZATION BOUNDARY. The Server Component that renders the shell
 * has already enforced identity, Team Workspace access and `research.read`,
 * and the endpoint re-derives all of it per request. The checks performed here
 * on `team.workspaceId` / `team.projectId` are ROUTE CONTAINMENT: a response
 * that does not belong to this exact address is never handed to the view.
 *
 * AUTH STATES (frozen by TEAM-CLAIM-DETAIL-AUTH-H1, matching the
 * Production-stable Team Video detail contract):
 *   - `authReady === false`                -> `loading`, zero requests;
 *   - `authReady === true`, no user        -> `auth_error`, zero requests;
 *   - `authReady === true`, user present   -> the canonical Team detail GET.
 * The signed-out case is terminal and is distinct from HTTP 401 handling below.
 *
 * TRANSPORT (mirrors the hardened Team research detail read in
 * `components/workspace/projects/TeamResearchDetailShell.tsx`):
 *   - waits for auth readiness; one request per (uid, workspaceId, projectId, verificationId);
 *   - a generation guard claimed synchronously before the first await and
 *     re-checked before every commit, plus an AbortController — a late response
 *     for an earlier Claim, Project, Workspace or identity never paints;
 *   - exactly one forced token-refresh retry on HTTP 401, then an honest
 *     session state; a second 401 is a finished session, never a missing Claim;
 *   - retry repeats the READ only.
 *
 * Read-only: no write, no POST, no provider execution, no quota, no governance
 * call, and never a Personal (`/api/user/...`) route.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { User } from "firebase/auth";
import { useAuth } from "@/components/AuthProvider";
import { authedFetch } from "@/lib/client/authedFetch";
import { createGenerationGuard } from "@/lib/client/authGeneration";
import type { ClaimVerificationClientPayload } from "@/lib/verification/claimVerificationClientPayload";
import { teamClaimDetailApiUrl } from "@/lib/workspaces/teamClaimDetailHref";

/** The Project label the R3 detail response carries — id/name/status only. */
export type TeamClaimDetailProject = { id: string; name: string; status: string };

export type TeamClaimDetailTeam = {
  workspaceId: string;
  projectId: string | null;
  project: TeamClaimDetailProject | null;
  createdAt: string;
};

export type TeamClaimDetailState =
  | { kind: "loading" }
  | { kind: "ready"; payload: ClaimVerificationClientPayload; team: TeamClaimDetailTeam }
  /** 404 `not_found` from the server, AND every route-containment failure — one indistinguishable treatment. */
  | { kind: "not_found" }
  /** 403 `insufficient_capability`: the viewer's capability changed after the page was gated. */
  | { kind: "forbidden" }
  /** The session was rejected after one forced refresh — says nothing about the Claim. */
  | { kind: "auth_error" }
  /** 503 or a transport failure: honest and retryable. */
  | { kind: "unavailable" }
  /** 500 `internal_error`: explicit, never an empty success. */
  | { kind: "internal" }
  /** A 2xx body that cannot be represented honestly. */
  | { kind: "malformed" };

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isProject(v: unknown): v is TeamClaimDetailProject {
  return isObject(v) && typeof v.id === "string" && typeof v.name === "string" && typeof v.status === "string";
}

/**
 * Validates an R3 detail body as untrusted input, then applies route
 * containment. `malformed` means "a 2xx we cannot render honestly";
 * `out_of_scope` means "authentic, but not this address's Claim".
 */
export function interpretTeamClaimDetailResponse(
  body: unknown,
  address: { workspaceId: string; projectId: string | null }
): { kind: "malformed" } | { kind: "out_of_scope" } | { kind: "ready"; payload: ClaimVerificationClientPayload; team: TeamClaimDetailTeam } {
  if (!isObject(body) || body.ok !== true) return { kind: "malformed" };

  const team = body.team;
  if (!isObject(team)) return { kind: "malformed" };
  if (typeof team.workspaceId !== "string" || team.workspaceId.length === 0) return { kind: "malformed" };
  if (!(team.projectId === null || (typeof team.projectId === "string" && team.projectId.length > 0))) return { kind: "malformed" };
  if (!(team.project === null || isProject(team.project))) return { kind: "malformed" };
  if (typeof team.createdAt !== "string") return { kind: "malformed" };

  const p = body.payload;
  if (!isObject(p)) return { kind: "malformed" };
  if (typeof p.claim !== "string" || p.claim.length === 0) return { kind: "malformed" };
  if (typeof p.verdict !== "string" || p.verdict.length === 0) return { kind: "malformed" };
  if (typeof p.consensusScore !== "number" || !Number.isFinite(p.consensusScore)) return { kind: "malformed" };
  if (typeof p.confidenceLabel !== "string" || p.confidenceLabel.length === 0) return { kind: "malformed" };
  if (!Array.isArray(p.modelEvidence)) return { kind: "malformed" };
  if (!isObject(p.aggregateSummary)) return { kind: "malformed" };
  if (!Array.isArray(p.whereModelsAgree)) return { kind: "malformed" };
  if (!Array.isArray(p.whereModelsDisagree)) return { kind: "malformed" };
  if (!isObject(p.auditBundle)) return { kind: "malformed" };

  // ROUTE CONTAINMENT. The API is authoritative and already conceals a
  // mismatch; this is defense in depth and is never "corrected" by an
  // automatic redirect to where the Claim actually lives.
  if (team.workspaceId !== address.workspaceId) return { kind: "out_of_scope" };
  if (team.projectId !== address.projectId) return { kind: "out_of_scope" };

  return {
    kind: "ready",
    payload: p as unknown as ClaimVerificationClientPayload,
    team: {
      workspaceId: team.workspaceId,
      projectId: team.projectId,
      project: team.project,
      createdAt: team.createdAt,
    },
  };
}

export type UseTeamClaimVerificationArgs = {
  workspaceId: string;
  verificationId: string;
  /** `null` for the Unfiled address; the addressed Project id for a Project address. */
  expectedProjectId: string | null;
};

export function useTeamClaimVerification({ workspaceId, verificationId, expectedProjectId }: UseTeamClaimVerificationArgs): {
  state: TeamClaimDetailState;
  retry: () => void;
} {
  const { user, authReady } = useAuth();
  const [state, setState] = useState<TeamClaimDetailState>({ kind: "loading" });
  const [retryTick, setRetryTick] = useState(0);

  const guard = useRef(createGenerationGuard()).current;
  const mountedRef = useRef(false);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      guard.next();
    };
  }, [guard]);

  const uid = user?.uid ?? null;

  useEffect(() => {
    // Claimed synchronously: this address + identity is now the page's intent,
    // and every earlier read loses authority immediately.
    const generation = guard.next();
    const controller = new AbortController();
    setState({ kind: "loading" });

    // Auth has not resolved yet: stay on the loading surface. This is the only
    // non-terminal outcome, and it resolves as soon as the provider settles.
    if (!authReady) {
      return () => controller.abort();
    }
    // Auth HAS resolved and there is no signed-in user. That is terminal, and
    // it must say so: the server-rendered page was admitted under a session
    // that has since resolved signed-out, so leaving the surface on "Loading
    // this claim…" would hang it indefinitely. `auth_error` is the honest
    // state — the shell already renders "We couldn't verify your session" with
    // a sign-in action — and it deliberately says NOTHING about whether the
    // Claim exists, unlike not_found/forbidden. No request is issued, and no
    // forced refresh is attempted without a user to refresh.
    //
    // Claimed AFTER guard.next() above, so a transition to signed-out also
    // invalidates any in-flight read for the previous identity.
    if (!uid || !user) {
      setState({ kind: "auth_error" });
      return () => controller.abort();
    }

    const owns = () => mountedRef.current && guard.isCurrent(generation);
    const url = teamClaimDetailApiUrl({ workspaceId, projectId: expectedProjectId, verificationId });

    void (async () => {
      try {
        const read = (forceTokenRefresh = false) =>
          authedFetch(url, {
            user: user as User,
            authReady,
            method: "GET",
            cache: "no-store",
            signal: controller.signal,
            ...(forceTokenRefresh ? { forceTokenRefresh: true } : {}),
          });

        let res = await read();
        if (!owns()) return;

        if (res.status === 401) {
          res = await read(true);
          if (!owns()) return;
          if (res.status === 401) {
            setState({ kind: "auth_error" });
            return;
          }
        }

        if (res.status === 403) {
          setState({ kind: "forbidden" });
          return;
        }
        if (res.status === 404) {
          setState({ kind: "not_found" });
          return;
        }
        if (res.status === 500) {
          setState({ kind: "internal" });
          return;
        }
        if (res.status >= 500) {
          setState({ kind: "unavailable" });
          return;
        }
        if (!res.ok) {
          // Any other non-2xx (e.g. a 400 this client should never provoke)
          // is treated as absent rather than described.
          setState({ kind: "not_found" });
          return;
        }

        const body = await res.json().catch(() => null);
        if (!owns()) return;

        const interpreted = interpretTeamClaimDetailResponse(body, { workspaceId, projectId: expectedProjectId });
        if (interpreted.kind === "malformed") {
          setState({ kind: "malformed" });
          return;
        }
        if (interpreted.kind === "out_of_scope") {
          setState({ kind: "not_found" });
          return;
        }
        setState({ kind: "ready", payload: interpreted.payload, team: interpreted.team });
      } catch {
        // An aborted obsolete request must not surface an error of its own.
        if (!owns()) return;
        setState({ kind: "unavailable" });
      }
    })();

    return () => controller.abort();
  }, [workspaceId, expectedProjectId, verificationId, uid, authReady, user, guard, retryTick]);

  /** Repeats the READ only. */
  const retry = useCallback(() => {
    setRetryTick((n) => n + 1);
  }, []);

  return { state, retry };
}
