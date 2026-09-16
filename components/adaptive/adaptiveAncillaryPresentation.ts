/**
 * TEAM-RESEARCH-PARITY-R3-P0 — the adaptive ANCILLARY presentation contract.
 *
 * "Ancillary" = the parts of an adaptive report that are not the research
 * itself and that are bound to a particular product surface's data and
 * authorization domain:
 *   - export ACTION        (`AdaptiveExportButton` → POST /api/user/runs/{id}/export)
 *   - export HISTORY       (`AdaptiveExportHistorySection` → /api/user/runs/{id}/exports…)
 *   - review / governance  (`ReviewGovernanceSection` → GET /api/user/runs/{id}/governance,
 *                           then its history child → the Personal review-history route
 *                           or the LEGACY Teams /api/teams/adaptive-runs/{id}/history route)
 *
 * All three are Personal (or legacy-Teams) surfaces. The CALLER — never the
 * renderer — chooses how they present:
 *
 *   - absent / `personal_default` → exactly today's behaviour: the shared
 *     renderer mounts those three components itself. The live composer and
 *     the Personal durable report pass nothing and are unchanged.
 *   - `delegated_read_only` → the shared renderer mounts NONE of them and
 *     performs no ancillary network request. It renders only what the caller
 *     hands it: `exportSurface` in the export position,
 *     `reviewGovernanceSurface` in the review/governance position. A missing
 *     (`undefined`) or `null` surface renders NOTHING — it never falls back
 *     to a Personal component.
 *
 * Never inferred from viewerRole, workspace, run id, URL, assignee, creator
 * or governance state. The renderer knows no route: any link (for example a
 * Workspace review link) lives inside the caller-supplied surface.
 */

import type { ReactNode } from "react";

export type AdaptiveAncillaryPresentation =
  | { kind: "personal_default" }
  | {
      kind: "delegated_read_only";
      /** Rendered in place of the Personal export action + export history. Absent/null → nothing. */
      exportSurface?: ReactNode | null;
      /** Rendered in place of the Personal review & governance section. Absent/null → nothing. */
      reviewGovernanceSurface?: ReactNode | null;
    };

/** The contract when a caller passes nothing. */
export const PERSONAL_DEFAULT_ANCILLARY_PRESENTATION: AdaptiveAncillaryPresentation = Object.freeze({ kind: "personal_default" as const });

/** Absent WHOLE policy → Personal default. A present policy is returned as-is. */
export function resolveAdaptiveAncillaryPresentation(policy: AdaptiveAncillaryPresentation | null | undefined): AdaptiveAncillaryPresentation {
  return policy ?? PERSONAL_DEFAULT_ANCILLARY_PRESENTATION;
}
