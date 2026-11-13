/**
 * User-facing server utilities: history payloads and cross-feature mappers.
 */

import type { ModelId } from "@/lib/types";
import type { ConsensusScoreWithheldReason, StoredConsensusIndependence } from "@/lib/panel/independentVoices";
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
  /**
   * From stored synthesis consensus summary when available (0–100) AND the run's persisted rows prove at least two
   * independent executing models; otherwise absent and `synthesisConsensusWithheld` says why.
   */
  synthesisConsensusScore?: number;
  synthesisConsensusWithheld?: ConsensusScoreWithheldReason;
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
  /** The stored score, or null when it is withheld (`consensusWithheld`): not a multi-model consensus. */
  consensusScore: number | null;
  /** Present when the stored rows do not prove >= 2 independent executing models (lib/panel/storedVerificationIndependence.ts). */
  consensusWithheld?: ConsensusScoreWithheldReason;
  /** Whether the stored rows prove >= 2 independent executing models with a usable answer. */
  modelIndependence: StoredConsensusIndependence;
  governanceStatus?: PanelHistoryGovernanceStatus;
};

export type PanelHistoryVideoVerificationItem = {
  type: "video_verification";
  id: string;
  at: string;
  fileName: string;
  durationSeconds: number;
  verdict: string;
  /**
   * The stored score; ABSENT when it is withheld (`consensusWithheld`; C-c CC-07/CC-08, PQ-2 strict: video rows record
   * no provider, so a stored video score is never presented as a multi-model consensus). Absent rather than null so the
   * frozen History renderer (app/page.tsx, number | undefined) is untouched.
   */
  consensusScore?: number;
  consensusWithheld?: ConsensusScoreWithheldReason;
  governanceStatus?: PanelHistoryGovernanceStatus;
};

export type PanelHistoryItem =
  | PanelHistoryResearchItem
  | PanelHistoryVerificationItem
  | PanelHistoryVideoVerificationItem;
