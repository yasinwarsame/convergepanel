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

export type TeamDocument = {
  id: string;
  name: string;
  createdBy: string;
  createdAt: Timestamp;
  members: TeamMember[];
  policyRules: PolicyRule[];
  settings: TeamSettings;
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
