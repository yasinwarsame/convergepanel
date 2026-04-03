/**
 * Client-safe shape for video verification (API response + history reload).
 */

import type { MetadataAnalysis, VideoMetadata } from "@/lib/video/videoPure";
import type { PanelHistoryGovernanceStatus } from "@/lib/user/panelHistory";

export type VideoModelEvidenceRow = {
  modelId: string;
  modelName: string;
  status: string;
  verdict: string;
  confidence: string;
  /** Majority-normalized content classification from the vision model. */
  contentType?: string;
  summary: string;
  visualIndicators: string[];
  metadataIndicators: string[];
  manipulationSignals: string[];
  authenticitySignals: string[];
  productionSignals?: string[];
  deceptionIndicators?: string[];
  compressionNotes: string[];
  limitations: string[];
};

export type VideoVerificationClientPayload = {
  verificationId: string;
  fileName: string;
  verdict: string;
  /** Aggregate content-type label when models agree (or plurality). */
  contentType?: string;
  consensusScore: number;
  confidenceLabel: "High" | "Medium" | "Low";
  evidenceQuality: "strong" | "mixed" | "weak";
  /** Stored/API: 0–100 percentage of dominant verdict support. */
  supportRatio: number;
  metadata: VideoMetadata;
  metadataAnalysis: MetadataAnalysis;
  modelEvidence: VideoModelEvidenceRow[];
  agreementPoints: string[];
  disagreementPoints: string[];
  frameCount: number;
  warnings: string[];
  governanceStatus?: PanelHistoryGovernanceStatus | null;
  timestampIso?: string | null;
};
