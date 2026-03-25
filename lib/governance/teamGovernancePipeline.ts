/**
 * Team governance: policies, consensus thresholds, and review workflows.
 */

import "server-only";

import { adminDb } from "@/lib/firebase/admin";
import { Timestamp, type DocumentData } from "firebase-admin/firestore";
import type { UserProfile } from "@/lib/types";
import type { ConsensusSummary } from "@/lib/verification/consensusScoring";
import { DEFAULT_POLICIES, evaluatePolicies, type PolicyRule } from "./policyEngine";
import type { TeamDocument, TeamRunAuditBundle, TeamGovernanceSnapshot } from "./teamTypes";

export type GovernanceClientFields = {
  policyFlags?: string[];
  blockedByPolicy?: boolean;
  policyBlockMessage?: string;
  governanceReviewRequired?: boolean;
  teamRunId?: string;
};

function asTeamDoc(id: string, data: DocumentData): TeamDocument {
  const settings = data.settings ?? {
    minimumConsensusForAction: 60,
    flagThreshold: 50,
  };
  return {
    id,
    name: String(data.name ?? ""),
    createdBy: String(data.createdBy ?? ""),
    createdAt: data.createdAt,
    members: Array.isArray(data.members) ? data.members : [],
    policyRules: Array.isArray(data.policyRules) ? data.policyRules : DEFAULT_POLICIES,
    settings: {
      minimumConsensusForAction: Number(settings.minimumConsensusForAction ?? 60),
      flagThreshold: Number(settings.flagThreshold ?? 50),
    },
  };
}

/**
 * For users with a teamId: evaluate policies, write teamRuns (no raw model text in audit),
 * optionally snapshot governance on runs/{runId} for cache replay.
 * Individual users (no team) → empty object (no side effects).
 */
export async function applyTeamGovernancePipeline(input: {
  uid: string;
  userEmail: string;
  consensusSummary: ConsensusSummary;
  consensusScore: number;
  type: "research" | "verification";
  query: string;
  verdict?: string;
  auditBundle: TeamRunAuditBundle;
  runId?: string;
  verificationId?: string;
}): Promise<GovernanceClientFields> {
  if (!adminDb) return {};

  const userSnap = await adminDb.collection("users").doc(input.uid).get();
  const ud = userSnap.data() as UserProfile | undefined;
  const teamId = ud?.teamId;
  if (!teamId || typeof teamId !== "string") return {};

  const teamSnap = await adminDb.collection("teams").doc(teamId).get();
  if (!teamSnap.exists) return {};

  const team = asTeamDoc(teamId, teamSnap.data()!);
  const rules: PolicyRule[] =
    Array.isArray(team.policyRules) && team.policyRules.length > 0
      ? (team.policyRules as PolicyRule[])
      : DEFAULT_POLICIES;

  const evaluation = evaluatePolicies(rules, input.consensusSummary);
  const policyFlagIds = evaluation.triggered.map((t) => t.rule.id);

  const belowMin =
    input.consensusScore < team.settings.minimumConsensusForAction
      ? ["below_minimum_consensus_for_action"]
      : [];

  const policyFlags = [...new Set([...policyFlagIds, ...belowMin])];

  const blockedRule = evaluation.triggered.find((t) => t.rule.action === "block");
  const blocked = evaluation.blocked;
  const blockMessage = blocked
    ? `This result was blocked by team policy: ${blockedRule?.rule.name ?? "governance rule"}.`
    : undefined;

  const governanceReviewRequired =
    blocked ||
    evaluation.requiresReview ||
    evaluation.triggered.length > 0 ||
    input.consensusScore < team.settings.minimumConsensusForAction;

  const teamRunId = `${teamId}-${input.uid}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

  try {
    await adminDb
      .collection("teamRuns")
      .doc(teamRunId)
      .set({
        id: teamRunId,
        teamId,
        userId: input.uid,
        userEmail: input.userEmail,
        type: input.type,
        query: input.query.slice(0, 5000),
        verdict: input.verdict ?? null,
        consensusScore: input.consensusScore,
        consensusSummary: input.consensusSummary,
        auditBundle: input.auditBundle,
        policyFlags,
        timestamp: Timestamp.now(),
        runId: input.runId ?? null,
        verificationId: input.verificationId ?? null,
      });
  } catch (e) {
    console.error("[teamGovernancePipeline] teamRuns write failed", e);
    return {
      policyFlags,
      blockedByPolicy: blocked,
      policyBlockMessage: blockMessage,
      governanceReviewRequired,
    };
  }

  const snapshot: TeamGovernanceSnapshot = {
    policyFlags,
    blocked,
    governanceReviewRequired,
    blockMessage,
    evaluatedAt: new Date().toISOString(),
  };

  if (input.runId) {
    try {
      await adminDb.collection("runs").doc(input.runId).set({ teamGovernance: snapshot }, { merge: true });
    } catch (e) {
      console.error("[teamGovernancePipeline] runs teamGovernance merge failed", e);
    }
  }

  return {
    policyFlags,
    blockedByPolicy: blocked,
    policyBlockMessage: blockMessage,
    governanceReviewRequired,
    teamRunId,
  };
}

export function mergeGovernanceIntoBody(
  body: Record<string, unknown>,
  gov: GovernanceClientFields
): Record<string, unknown> {
  if (!gov.policyFlags && !gov.blockedByPolicy && !gov.governanceReviewRequired) return body;
  return {
    ...body,
    ...(gov.policyFlags?.length ? { policyFlags: gov.policyFlags } : {}),
    ...(gov.blockedByPolicy ? { blockedByPolicy: true } : {}),
    ...(gov.policyBlockMessage ? { policyBlockMessage: gov.policyBlockMessage } : {}),
    ...(gov.governanceReviewRequired ? { governanceReviewRequired: true } : {}),
    ...(gov.teamRunId ? { teamRunId: gov.teamRunId } : {}),
  };
}

export function governanceFromRunDoc(data: DocumentData | undefined): GovernanceClientFields {
  const g = data?.teamGovernance as TeamGovernanceSnapshot | undefined;
  if (!g) return {};
  return {
    policyFlags: g.policyFlags,
    blockedByPolicy: g.blocked,
    policyBlockMessage: g.blockMessage,
    governanceReviewRequired: g.governanceReviewRequired,
  };
}
