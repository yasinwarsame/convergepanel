/**
 * User-facing server utilities: history payloads and cross-feature mappers.
 */

import type { ModelId } from "@/lib/types";

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

export type PanelHistoryItem = PanelHistoryResearchItem | PanelHistoryVerificationItem;
