"use client";

/**
 * TEAM-VERIFICATION-PARITY-R5-I2 — the ONE client read of a Team Video
 * verification DETAIL, backed by the already-live R5-I1 endpoint
 * `GET /api/workspaces/{W}/video-verifications/{verificationId}[?projectId={P}]`.
 *
 * NOT AN AUTHORIZATION BOUNDARY. The Server Component that renders the shell
 * has already enforced identity, Team Workspace access and `research.read`,
 * and the endpoint re-derives all of it per request. The checks performed here
 * on `team.workspaceId` / `team.projectId` are ROUTE CONTAINMENT: a response
 * that does not belong to this exact address is never handed to the view.
 *
 * NETWORK-BOUNDARY VALIDATION IS THIS HOOK'S JOB. `VideoVerificationResultView`
 * is a pure presentation component shared with Personal Video; it must not be
 * made defensive against malformed transport data. So every field that view
 * reads — including each `modelEvidence` row's arrays and the whole `metadata`
 * / `metadataAnalysis` shape — is validated here BEFORE the payload is handed
 * over. A 2xx that cannot be rendered honestly becomes `malformed`, never a
 * half-painted result.
 *
 * TRANSPORT (mirrors the hardened Team Claim detail read):
 *   - waits for auth readiness; one request per (uid, workspaceId, projectId, verificationId);
 *   - a generation guard claimed synchronously before the first await and
 *     re-checked before every commit, plus an AbortController — a late response
 *     for an earlier Video, Project, Workspace or identity never paints;
 *   - exactly one forced token-refresh retry on HTTP 401, then an honest
 *     session state; a second 401 is a finished session, never a missing Video;
 *   - retry repeats the READ only.
 *
 * Read-only: no write, no POST, no provider execution, no quota, no governance
 * call, and never a Personal (`/api/user/...` or `/api/verify-video`) route.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { User } from "firebase/auth";
import { useAuth } from "@/components/AuthProvider";
import { authedFetch } from "@/lib/client/authedFetch";
import { createGenerationGuard } from "@/lib/client/authGeneration";
import type { VideoVerificationClientPayload, VideoModelEvidenceRow } from "@/lib/verification/videoVerificationClientPayload";
import { teamVideoDetailApiUrl } from "@/lib/workspaces/teamVideoDetailHref";

/** The Project label the R5-I1 detail response carries — id/name/status only. */
export type TeamVideoDetailProject = { id: string; name: string; status: string };

export type TeamVideoDetailTeam = {
  workspaceId: string;
  projectId: string | null;
  project: TeamVideoDetailProject | null;
  createdAt: string;
};

export type TeamVideoDetailState =
  | { kind: "loading" }
  | { kind: "ready"; payload: VideoVerificationClientPayload; team: TeamVideoDetailTeam }
  /** 404 `not_found` from the server, AND every route-containment failure — one indistinguishable treatment. */
  | { kind: "not_found" }
  /** 403 `insufficient_capability`: the viewer's capability changed after the page was gated. */
  | { kind: "forbidden" }
  /** The session was rejected after one forced refresh — says nothing about the Video. */
  | { kind: "auth_error" }
  /** 503 or a transport failure: honest and retryable. */
  | { kind: "unavailable" }
  /** 500 `internal_error`: explicit, never an empty success. */
  | { kind: "internal" }
  /** A 2xx body that cannot be represented honestly. */
  | { kind: "malformed" };

const VERDICTS: ReadonlySet<string> = new Set(["authentic_captured", "authentic_produced", "likely_manipulated", "inconclusive", "insufficient", "authentic"]);
const CONFIDENCE: ReadonlySet<string> = new Set(["High", "Medium", "Low"]);
const EVIDENCE: ReadonlySet<string> = new Set(["strong", "mixed", "weak"]);
const GOVERNANCE: ReadonlySet<string> = new Set(["approved", "needs_review", "blocked"]);
const SEVERITY: ReadonlySet<string> = new Set(["info", "warning", "suspicious"]);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function nonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.length > 0;
}
function finiteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}
function stringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}
function optionalStringArray(v: unknown): boolean {
  return v === undefined || stringArray(v);
}
function isProject(v: unknown): v is TeamVideoDetailProject {
  return isObject(v) && typeof v.id === "string" && typeof v.name === "string" && typeof v.status === "string";
}

/** Every property `VideoVerificationResultView` reads off a model row. */
function isModelEvidenceRow(v: unknown): v is VideoModelEvidenceRow {
  if (!isObject(v)) return false;
  if (!nonEmptyString(v.modelId)) return false;
  if (typeof v.modelName !== "string") return false;
  if (typeof v.status !== "string") return false;
  if (typeof v.verdict !== "string") return false;
  if (typeof v.confidence !== "string") return false;
  if (v.contentType !== undefined && typeof v.contentType !== "string") return false;
  if (typeof v.summary !== "string") return false;
  if (!stringArray(v.visualIndicators)) return false;
  if (!stringArray(v.metadataIndicators)) return false;
  if (!stringArray(v.manipulationSignals)) return false;
  if (!stringArray(v.authenticitySignals)) return false;
  if (!optionalStringArray(v.productionSignals)) return false;
  if (!optionalStringArray(v.deceptionIndicators)) return false;
  if (!stringArray(v.compressionNotes)) return false;
  if (!stringArray(v.limitations)) return false;
  return true;
}

/** The whole `VideoMetadata` shape the shared view renders. */
function isVideoMetadata(v: unknown): boolean {
  if (!isObject(v)) return false;
  if (!finiteNumber(v.duration)) return false;
  if (!finiteNumber(v.width)) return false;
  if (!finiteNumber(v.height)) return false;
  if (typeof v.codec !== "string") return false;
  if (!finiteNumber(v.frameRate)) return false;
  if (!finiteNumber(v.fileSize)) return false;
  if (typeof v.format !== "string") return false;
  if (!(v.createdAt === null || typeof v.createdAt === "string")) return false;
  if (!(v.encodingSoftware === null || typeof v.encodingSoftware === "string")) return false;
  if (typeof v.hasAudio !== "boolean") return false;
  if (!(v.cameraModel === null || typeof v.cameraModel === "string")) return false;
  return true;
}

function isMetadataAnalysis(v: unknown): boolean {
  if (!isObject(v)) return false;
  if (typeof v.summary !== "string") return false;
  if (!Array.isArray(v.flags)) return false;
  return v.flags.every(
    (f) => isObject(f) && typeof f.field === "string" && typeof f.observation === "string" && typeof f.severity === "string" && SEVERITY.has(f.severity)
  );
}

/**
 * Validates an R5-I1 detail body as untrusted input, then applies route
 * containment. `malformed` means "a 2xx we cannot render honestly";
 * `out_of_scope` means "authentic, but not this address's Video".
 */
export function interpretTeamVideoDetailResponse(
  body: unknown,
  address: { workspaceId: string; projectId: string | null; verificationId: string }
): { kind: "malformed" } | { kind: "out_of_scope" } | { kind: "ready"; payload: VideoVerificationClientPayload; team: TeamVideoDetailTeam } {
  if (!isObject(body) || body.ok !== true) return { kind: "malformed" };

  const team = body.team;
  if (!isObject(team)) return { kind: "malformed" };
  if (!nonEmptyString(team.workspaceId)) return { kind: "malformed" };
  if (!(team.projectId === null || nonEmptyString(team.projectId))) return { kind: "malformed" };
  if (!(team.project === null || isProject(team.project))) return { kind: "malformed" };
  if (!nonEmptyString(team.createdAt) || Number.isNaN(Date.parse(team.createdAt))) return { kind: "malformed" };

  // DETAIL Project pairing. Unlike a LIST row, a filed Video whose Project
  // could not be resolved legitimately keeps its non-null `projectId` with a
  // null label — that is "Project unavailable", not "Unfiled". The only
  // internally inconsistent combinations are an Unfiled row carrying a Project,
  // and a label whose id disagrees with the binding.
  if (team.projectId === null && team.project !== null) return { kind: "malformed" };
  if (team.projectId !== null && team.project !== null && team.project.id !== team.projectId) return { kind: "malformed" };

  const p = body.payload;
  if (!isObject(p)) return { kind: "malformed" };
  if (!nonEmptyString(p.verificationId)) return { kind: "malformed" };
  if (!nonEmptyString(p.fileName)) return { kind: "malformed" };
  if (typeof p.verdict !== "string" || !VERDICTS.has(p.verdict)) return { kind: "malformed" };
  if (p.contentType !== undefined && !nonEmptyString(p.contentType)) return { kind: "malformed" };
  if (!finiteNumber(p.consensusScore)) return { kind: "malformed" };
  if (typeof p.confidenceLabel !== "string" || !CONFIDENCE.has(p.confidenceLabel)) return { kind: "malformed" };
  if (typeof p.evidenceQuality !== "string" || !EVIDENCE.has(p.evidenceQuality)) return { kind: "malformed" };
  if (!finiteNumber(p.supportRatio)) return { kind: "malformed" };
  if (!finiteNumber(p.frameCount) || !Number.isInteger(p.frameCount) || p.frameCount < 0) return { kind: "malformed" };
  if (!isVideoMetadata(p.metadata)) return { kind: "malformed" };
  if (!isMetadataAnalysis(p.metadataAnalysis)) return { kind: "malformed" };
  if (!Array.isArray(p.modelEvidence) || !p.modelEvidence.every(isModelEvidenceRow)) return { kind: "malformed" };
  if (!stringArray(p.agreementPoints)) return { kind: "malformed" };
  if (!stringArray(p.disagreementPoints)) return { kind: "malformed" };
  if (!stringArray(p.warnings)) return { kind: "malformed" };
  if (!(p.governanceStatus === undefined || p.governanceStatus === null || (typeof p.governanceStatus === "string" && GOVERNANCE.has(p.governanceStatus)))) {
    return { kind: "malformed" };
  }
  if (!(p.timestampIso === undefined || p.timestampIso === null || (nonEmptyString(p.timestampIso) && !Number.isNaN(Date.parse(p.timestampIso))))) {
    return { kind: "malformed" };
  }
  // The payload must describe the Video this address asked for.
  if (p.verificationId !== address.verificationId) return { kind: "malformed" };

  // ROUTE CONTAINMENT. The API is authoritative and already conceals a
  // mismatch; this is defense in depth and is never "corrected" by an
  // automatic redirect to where the Video actually lives.
  if (team.workspaceId !== address.workspaceId) return { kind: "out_of_scope" };
  if (team.projectId !== address.projectId) return { kind: "out_of_scope" };

  return {
    kind: "ready",
    payload: p as unknown as VideoVerificationClientPayload,
    team: {
      workspaceId: team.workspaceId,
      projectId: team.projectId,
      project: team.project,
      createdAt: team.createdAt,
    },
  };
}

export type UseTeamVideoVerificationArgs = {
  workspaceId: string;
  verificationId: string;
  /** `null` for the Unfiled address; the addressed Project id for a Project address. */
  expectedProjectId: string | null;
};

export function useTeamVideoVerification({ workspaceId, verificationId, expectedProjectId }: UseTeamVideoVerificationArgs): {
  state: TeamVideoDetailState;
  retry: () => void;
} {
  const { user, authReady } = useAuth();
  const [state, setState] = useState<TeamVideoDetailState>({ kind: "loading" });
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

    if (!authReady || !uid) {
      return () => controller.abort();
    }

    const owns = () => mountedRef.current && guard.isCurrent(generation);
    const url = teamVideoDetailApiUrl({ workspaceId, projectId: expectedProjectId, verificationId });

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

        const interpreted = interpretTeamVideoDetailResponse(body, { workspaceId, projectId: expectedProjectId, verificationId });
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
