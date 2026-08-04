/**
 * User-facing server utilities: history payloads and cross-feature mappers.
 */

import type { ModelId } from "@/lib/types";
import type { QueryType } from "@/lib/adaptiveSchema/types";

/** Stored on run / verification docs when org governance evaluation ran. */
export type PanelHistoryGovernanceStatus = "approved" | "needs_review" | "blocked";

export type PanelHistoryResearchItem = {
  type: "research";
  id: string;
  at: string;
  question: string;
  selectedModels: ModelId[];
  status?: string;
  modelsOk?: number;
  modelsTotal?: number;
  /** From stored synthesis consensus summary when available (0–100). */
  synthesisConsensusScore?: number;
  governanceStatus?: PanelHistoryGovernanceStatus;
  /**
   * Query-Routing Redesign, Phase 1 — summary-only signal that a versioned
   * adaptive envelope exists on this run, so the history list can badge it
   * without fetching the full envelope (that's the detail endpoint's job —
   * see app/api/user/runs/[runId]/route.ts). Absent for runs from before
   * this phase and for the 10 legacy-active schemas, which never build one.
   */
  hasAdaptiveOutput?: boolean;
  adaptiveSchemaId?: QueryType;
};

export type PanelHistoryVerificationItem = {
  type: "verification";
  id: string;
  at: string;
  claim: string;
  verdict: string;
  consensusScore: number;
  governanceStatus?: PanelHistoryGovernanceStatus;
};

export type PanelHistoryVideoVerificationItem = {
  type: "video_verification";
  id: string;
  at: string;
  fileName: string;
  durationSeconds: number;
  verdict: string;
  consensusScore: number;
  governanceStatus?: PanelHistoryGovernanceStatus;
};

export type PanelHistoryItem =
  | PanelHistoryResearchItem
  | PanelHistoryVerificationItem
  | PanelHistoryVideoVerificationItem;
