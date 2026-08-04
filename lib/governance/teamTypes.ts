/**
 * Team governance: policies, consensus thresholds, and review workflows.
 */

import type { Timestamp } from "firebase-admin/firestore";
import type { AuditBundle } from "@/lib/verification/auditBundle";
import type { ConsensusSummary } from "@/lib/verification/consensusScoring";
import type { PolicyRule } from "./policyEngine";

export type TeamMemberRole = "owner" | "admin" | "member";

export type TeamMember = {
  uid: string;
  email: string;
  role: TeamMemberRole;
  joinedAt: string;
};

export type TeamSettings = {
  minimumConsensusForAction: number;
  flagThreshold: number;
};

/**
 * Query-Routing Redesign, Phase 2A, Step 7, Part C
 * (docs/governance-decision-receipts-design.md §21.3) — a NEW, additive,
 * top-level field, deliberately NOT nested inside `TeamSettings` above:
 * `minimumConsensusForAction`/`flagThreshold` are a consensus-threshold
 * axis with no adaptive meaning (§20.5 — every legacy team-policy rule
 * requires a `ConsensusSummary`); adaptive review eligibility is a
 * conceptually separate axis. Optional and defaulting to fully disabled
 * when absent or malformed — existing teams are never silently enrolled.
 */
export type AdaptiveReviewMode = "flagged_only" | "human_review_needed" | "all";

export type AdaptiveReviewSettings = {
  enabled: boolean;
  mode: AdaptiveReviewMode;
};

/**
 * Multi-Reviewer Panel Foundation, Part B (docs/governance-decision-receipts-design.md
 * §29, §30) — a SEPARATE opt-in axis from `AdaptiveReviewSettings` above
 * (which only governs whether a `teamRuns` projection is created at all).
 * This setting governs a materially different, higher-stakes capability
 * (a run's ENTIRE decision-submission path can be blocked while an open
 * panel exists) — deliberately not folded into `AdaptiveReviewSettings` so
 * the two can never be confused or accidentally enabled together. `mode`
 * is restricted to `"majority_quorum"` only in Part B — no other mode
 * exists to select yet.
 */
export type AdaptiveMultiReviewerMode = "majority_quorum";

export type AdaptiveMultiReviewerSettings = {
  enabled: boolean;
  mode: AdaptiveMultiReviewerMode;
};

export type TeamDocument = {
  id: string;
  name: string;
  createdBy: string;
  createdAt: Timestamp;
  members: TeamMember[];
  policyRules: PolicyRule[];
  settings: TeamSettings;
  /** Absent for every existing team until explicitly configured — never assumed enabled. */
  adaptiveReviewSettings?: AdaptiveReviewSettings;
  /** Absent for every existing team until explicitly configured — never assumed enabled. Missing or malformed always means disabled, never a silent permissive default. */
  adaptiveMultiReviewerSettings?: AdaptiveMultiReviewerSettings;
};

// TODO: move members to subcollection for teams > 100 (Firestore 1MB doc limit)

export type TeamRunAuditBundle =
  | AuditBundle
  | {
      version: "1";
      kind: "research_synthesis";
      runId: string;
      timestamp: string;
      models: Array<{ modelId: string; status: string }>;
      overallConsensusScore: number;
      claims: Array<{ claimTruncated: string; supportRatio: number; evidenceQuality: string }>;
      generatedAt: string;
      questionCharCount: number;
      modelCount: number;
      modelsHealthy: number;
      keyFindingsCount: number;
      disagreementsCount: number;
    };

export type TeamRunHumanDecision = {
  action: "approved" | "rejected" | "escalated";
  decidedBy: string;
  decidedAt: string;
  notes: string;
};

export type TeamRunDocument = {
  id: string;
  teamId: string;
  userId: string;
  userEmail: string;
  type: "research" | "verification";
  query: string;
  verdict?: string;
  consensusScore: number;
  consensusSummary: ConsensusSummary;
  auditBundle: TeamRunAuditBundle;
  policyFlags: string[];
  humanDecision?: TeamRunHumanDecision;
  timestamp: Timestamp;
  /** Optional link back to panel run for research */
  runId?: string;
  verificationId?: string;
};

export type TeamGovernanceSnapshot = {
  policyFlags: string[];
  blocked: boolean;
  governanceReviewRequired: boolean;
  blockMessage?: string;
  evaluatedAt: string;
};
