/**
 * TEAM-RESEARCH-PARITY-R2 — LAYER 2: persisted run interpretation.
 *
 * `interpretPersistedRunReadPayload()` turns the SUCCESSFUL body of a persisted
 * run read (`GET /api/user/runs/[runId]` today; the Team research detail API's
 * shared research fields in R3 — both are built by the same server builder) into
 * a validated, discriminated presentation state. It was extracted verbatim from
 * `PersonalResearchDetailShell` so the Personal and Team report pages interpret
 * a saved run identically.
 *
 * It is PURE and client-safe: no network, no React state, no Firestore, no
 * mutation of its input. It is NOT an authorization boundary — the server
 * already decided who may read; and it does NOT decide route containment
 * (whether a Team-bound run may show on a Personal address, or vice versa) —
 * that stays with the transport shell that knows which address it serves.
 *
 * RESPONSE IDENTITY (C1 §A/§B): fails CLOSED as `malformed` unless `ok === true`,
 * `runId` is a non-empty string EQUAL to the id the caller requested, and
 * `viewerRole` is exactly one of the four roles the read API issues. The route
 * id chooses what to request; only the response proves what was returned. A
 * missing or unknown role is a response-contract failure, never defaulted.
 *
 * ENVELOPE ORDER (load-bearing): a valid `adaptive` envelope wins; otherwise a
 * valid `legacyAdaptive` envelope; otherwise the raw model rows, with an honest
 * restore notice when a structured envelope exists but is malformed or from a
 * newer version. `adaptive.status === "absent"` alone is NOT evidence of an
 * ordinary run — it is also correct for every legacy-adaptive run.
 *
 * A COMPLETED run with no usable structured result AND zero rows is `malformed`:
 * it must never render as "you haven't run this yet".
 */

import type { AdaptivePanelPayload } from "@/components/ResultsDisplay";
import {
  adaptPersistedOutputToPanelPayload,
  adaptPersistedLegacyOutputToPanelPayload,
} from "@/lib/user/adaptivePersistedOutputAdapter";
import type { ModelResult } from "@/lib/types";

export const PERSISTED_RUN_VIEWER_ROLES = ["owner", "personal_reviewer", "team_member", "team_reviewer"] as const;
export type PersistedRunViewerRole = (typeof PERSISTED_RUN_VIEWER_ROLES)[number];

export const MALFORMED_STRUCTURED_RESULT_NOTICE =
  "This run's structured result couldn't be restored — showing the raw model responses instead.";
export const NEWER_VERSION_STRUCTURED_RESULT_NOTICE =
  "This run's structured result was saved by a newer version of ConvergePanel — showing the raw model responses instead.";

/** Only what the shared result renderer needs. No transport, auth, Workspace, Project, assignee or navigation state. */
export type PersistedResearchPresentation = {
  runId: string;
  viewerRole: PersistedRunViewerRole;
  question: string;
  results: ModelResult[];
  adaptive: AdaptivePanelPayload | null;
  restoreNotice: string | null;
  synthesisReport: unknown;
  synthesisConsensusSummary: unknown;
  orgGovernanceStatus: "approved" | "needs_review" | "blocked" | null;
  /** The Team/org governance banner projection, exactly as the read API emitted it (`undefined` when absent). */
  governance: unknown;
};

export type PersistedRunInterpretation =
  | { kind: "malformed" }
  | { kind: "in_progress"; question: string; viewerRole: PersistedRunViewerRole }
  | { kind: "failed"; question: string; viewerRole: PersistedRunViewerRole }
  | { kind: "ready"; presentation: PersistedResearchPresentation };

function isViewerRole(value: unknown): value is PersistedRunViewerRole {
  return typeof value === "string" && (PERSISTED_RUN_VIEWER_ROLES as readonly string[]).includes(value);
}

export function interpretPersistedRunReadPayload(raw: unknown, expectedRunId: string): PersistedRunInterpretation {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { kind: "malformed" };
  const data = raw as Record<string, any>;
  if (data.ok !== true) return { kind: "malformed" };

  // POSITIVE acceptance of the role, never absence of refusal.
  if (!isViewerRole(data.viewerRole)) return { kind: "malformed" };
  const viewerRole = data.viewerRole;

  // The response must carry its own identity, and it must be the one requested.
  if (typeof data.runId !== "string" || data.runId.length === 0 || data.runId !== expectedRunId) {
    return { kind: "malformed" };
  }

  const question = typeof data.question === "string" ? data.question : "";
  const status = typeof data.status === "string" ? data.status : "";
  if (status === "queued" || status === "running") {
    return { kind: "in_progress", question, viewerRole };
  }
  if (status === "error" || status === "failed") {
    return { kind: "failed", question, viewerRole };
  }

  // Same envelope ORDER the root composer uses: adaptive, then legacy-adaptive,
  // then raw rows. Never reclassifies, never executes, never regenerates.
  let adaptive: AdaptivePanelPayload | null = null;
  let restoreNotice: string | null = null;
  if (data.adaptive?.status === "valid" && data.adaptive.output) {
    adaptive = adaptPersistedOutputToPanelPayload(data.adaptive.output, {
      humanReview: data.adaptive.humanReview,
      reviewRouting: data.adaptive.reviewRouting,
    });
  } else if (data.legacyAdaptive?.status === "valid" && data.legacyAdaptive.output) {
    adaptive = adaptPersistedLegacyOutputToPanelPayload(data.legacyAdaptive.output);
  } else if (data.adaptive?.status === "malformed" || data.legacyAdaptive?.status === "malformed") {
    restoreNotice = MALFORMED_STRUCTURED_RESULT_NOTICE;
  } else if (data.adaptive?.status === "unsupported_version" || data.legacyAdaptive?.status === "unsupported_version") {
    restoreNotice = NEWER_VERSION_STRUCTURED_RESULT_NOTICE;
  }

  const results = Array.isArray(data.results) ? (data.results as ModelResult[]) : [];
  // A completed artifact with neither a structured result nor usable rows
  // cannot be shown honestly. It is NOT "you haven't run this yet".
  if (!adaptive && results.length === 0) return { kind: "malformed" };

  const og = data.governanceStatus;
  return {
    kind: "ready",
    presentation: {
      runId: data.runId,
      viewerRole,
      question,
      results,
      adaptive,
      restoreNotice,
      synthesisReport: data.synthesisCache?.report ?? null,
      synthesisConsensusSummary: data.synthesisCache?.consensusSummary ?? null,
      orgGovernanceStatus: og === "approved" || og === "needs_review" || og === "blocked" ? og : null,
      governance: data.governance ?? undefined,
    },
  };
}
