/**
 * Multi-Reviewer Production-Readiness Hardening, Step 5.3/5.4 — pure,
 * zero-I/O seed-plan builder for the six deterministic multi-reviewer
 * scenarios. No Firebase Admin import — this module only ever COMPUTES the
 * exact document writes the seed script should perform; `scripts/seed-
 * adaptive-multi-reviewer-e2e.ts` is the only thing that actually touches
 * Firestore. This split is what makes the plan itself independently unit
 * testable (deterministic IDs, idempotent re-plan, no private content)
 * without a real or fake Firestore.
 *
 * Every document is built through the REAL production pure builders
 * (`buildNextAdaptiveHumanReviewPanel`, `buildAdaptiveHumanReviewVote`,
 * `buildFinalizedAdaptiveHumanReviewPanel`,
 * `buildOwnerOverriddenAdaptiveHumanReviewPanel`,
 * `buildFinalizedMultiReviewerHumanReview`,
 * `buildOverriddenMultiReviewerHumanReview`,
 * `buildAdaptivePanelFinalDecisionId`, `buildAdaptivePanelOverrideDecisionId`,
 * `buildAdaptiveTeamRunProjection`) rather than hand-rolled fixture
 * objects — guaranteeing every seeded document is exactly what the real
 * production transactions would have produced, byte for byte, not an
 * approximation that could drift from the real schema.
 */

import {
  buildNextAdaptiveHumanReviewPanel,
  buildFinalizedAdaptiveHumanReviewPanel,
  buildOwnerOverriddenAdaptiveHumanReviewPanel,
  AdaptiveHumanReviewPanelV1,
} from "./adaptiveHumanReviewPanel";
import { buildAdaptiveHumanReviewVote, buildAdaptiveHumanReviewVoteId, AdaptiveHumanReviewVoteV1 } from "./adaptiveHumanReviewVote";
import {
  buildAdaptivePanelFinalDecisionId,
  buildFinalConditionsUnion,
  buildFinalizedMultiReviewerHumanReview,
  buildAdaptivePanelFinalizationHistoryEntry,
} from "./adaptivePanelFinalization";
import {
  buildAdaptivePanelOverrideDecisionId,
  buildOverriddenMultiReviewerHumanReview,
  buildAdaptivePanelOverrideHistoryEntry,
} from "./adaptivePanelOverride";
import { ADAPTIVE_REVIEW_AGGREGATION_POLICY_VERSION } from "./adaptiveReviewAggregation";
import { buildAdaptiveTeamRunProjection, buildAdaptiveTeamRunProjectionId } from "./adaptiveTeamReview";
import { GovernanceRecordV1 } from "../adaptiveSchema/governanceRecord";
import { GOVERNANCE_SEED_NAMESPACE, seedId } from "./adaptiveGovernanceSeedSafety";

export const SEED_TEAM_ID = seedId("team", "1");
export const SEED_OWNER_UID = seedId("user", "owner");
export const SEED_ADMIN_UID = seedId("user", "admin");
export const SEED_REVIEWER_1_UID = seedId("user", "reviewer-1");
export const SEED_REVIEWER_2_UID = seedId("user", "reviewer-2");
export const SEED_REVIEWER_3_UID = seedId("user", "reviewer-3");
export const SEED_MEMBER_UID = seedId("user", "member");

/** `example.com` is reserved for documentation/testing by RFC 2606 — never a deliverable inbox, and never a real user's address. */
const SEED_EMAIL_DOMAIN = "example.com";

export type SeedTestUser = { uid: string; email: string; displayName: string; role: "owner" | "admin" | "member" };

export const SEED_TEST_USERS: readonly SeedTestUser[] = [
  { uid: SEED_OWNER_UID, email: `gov-e2e-owner@${SEED_EMAIL_DOMAIN}`, displayName: "Seed Owner", role: "owner" },
  { uid: SEED_ADMIN_UID, email: `gov-e2e-admin@${SEED_EMAIL_DOMAIN}`, displayName: "Seed Admin", role: "admin" },
  { uid: SEED_REVIEWER_1_UID, email: `gov-e2e-reviewer-1@${SEED_EMAIL_DOMAIN}`, displayName: "Seed Reviewer One", role: "admin" },
  { uid: SEED_REVIEWER_2_UID, email: `gov-e2e-reviewer-2@${SEED_EMAIL_DOMAIN}`, displayName: "Seed Reviewer Two", role: "admin" },
  { uid: SEED_REVIEWER_3_UID, email: `gov-e2e-reviewer-3@${SEED_EMAIL_DOMAIN}`, displayName: "Seed Reviewer Three", role: "admin" },
  { uid: SEED_MEMBER_UID, email: `gov-e2e-member@${SEED_EMAIL_DOMAIN}`, displayName: "Seed Ordinary Member", role: "member" },
];

export type FirestoreWrite = {
  /** Slash-separated full document path, e.g. `runs/gov-e2e-seed-run-a/humanReviewPanel/current`. */
  path: string;
  data: object;
  /** `set` (idempotent overwrite — team/run/panel/vote docs, safely re-seedable) or `create` (idempotent create-only — history/event/audit, matching the real production writer convention exactly). */
  mode: "set" | "create";
};

export type SeedScenario = {
  id: "A" | "B" | "C" | "D" | "E" | "F";
  name: string;
  runId: string;
  description: string;
  writes: FirestoreWrite[];
};

export type AdaptiveGovernanceSeedPlan = {
  namespace: string;
  teamWrites: FirestoreWrite[];
  scenarios: SeedScenario[];
};

const SEED_NOW = "2026-01-01T00:00:00.000Z";

function baseGovernanceRecord(overrides: Partial<GovernanceRecordV1> = {}): GovernanceRecordV1 {
  return {
    version: 1,
    schemaId: "decision_support",
    answerShape: "decision_support_view",
    adaptiveOutputVersion: 1,
    humanReview: { status: "unreviewed" },
    decisionReceipt: {
      conclusion: "[SEED DATA] This is a deterministic, non-production governance seed record used for multi-reviewer end-to-end verification. It carries no real user content.",
      basis: ["Seed basis point A", "Seed basis point B"],
      assumptions: ["Seed assumption A"],
      uncertainties: ["Seed uncertainty A"],
      limitations: ["Seed limitation A"],
      sources: [],
      sourceBacked: false,
      humanReviewNeeded: true,
    },
    createdAt: SEED_NOW,
    updatedAt: SEED_NOW,
    ...overrides,
  };
}

function runDoc(runId: string, governanceRecord: GovernanceRecordV1): FirestoreWrite {
  return {
    path: `runs/${runId}`,
    mode: "set",
    data: {
      question: `[SEED DATA] ${GOVERNANCE_SEED_NAMESPACE} — governance multi-reviewer verification run (${runId})`,
      status: "completed",
      userId: SEED_OWNER_UID,
      teamId: SEED_TEAM_ID,
      createdAt: SEED_NOW,
      governanceRecord,
    },
  };
}

function projectionDoc(runId: string, humanReviewStatus: GovernanceRecordV1["humanReview"]["status"]): FirestoreWrite {
  const projection = buildAdaptiveTeamRunProjection({
    teamId: SEED_TEAM_ID,
    userId: SEED_OWNER_UID,
    runId,
    schemaId: "decision_support",
    answerShape: "decision_support_view",
    receiptConclusion: "[SEED DATA] deterministic governance seed record",
    sourceBacked: false,
    humanReviewNeeded: true,
    humanReviewStatus,
    now: SEED_NOW,
  });
  return { path: `teamRuns/${buildAdaptiveTeamRunProjectionId(SEED_TEAM_ID, runId)}`, mode: "set", data: projection };
}

function panelDoc(runId: string, panel: AdaptiveHumanReviewPanelV1): FirestoreWrite {
  return { path: `runs/${runId}/humanReviewPanel/current`, mode: "set", data: panel };
}

function voteDoc(runId: string, vote: AdaptiveHumanReviewVoteV1): FirestoreWrite {
  const voteId = buildAdaptiveHumanReviewVoteId(vote.panelRevision, vote.reviewerUserId);
  return { path: `runs/${runId}/humanReviewVotes/${voteId}`, mode: "set", data: vote };
}

function openPanelFor(runId: string, reviewerUserIds: string[]): AdaptiveHumanReviewPanelV1 {
  return buildNextAdaptiveHumanReviewPanel({
    teamId: SEED_TEAM_ID,
    runId,
    reviewerUserIds,
    actorUserId: SEED_ADMIN_UID,
    now: SEED_NOW,
    current: null,
  });
}

function voteFor(runId: string, reviewerUserId: string, status: AdaptiveHumanReviewVoteV1["status"], panelRevision: number): AdaptiveHumanReviewVoteV1 {
  return buildAdaptiveHumanReviewVote({
    teamId: SEED_TEAM_ID,
    runId,
    panelRevision,
    reviewerUserId,
    status,
    comment: status === "changes_requested" || status === "rejected" ? "[SEED DATA] seed reviewer comment" : undefined,
    now: SEED_NOW,
  });
}

/** Pure. Builds the full deterministic plan for all six scenarios plus the shared seed team — no I/O, no Firestore, safe to call in a unit test. */
export function buildAdaptiveGovernanceSeedPlan(): AdaptiveGovernanceSeedPlan {
  const teamWrites: FirestoreWrite[] = [
    {
      path: `teams/${SEED_TEAM_ID}`,
      mode: "set",
      data: {
        name: `[SEED DATA] ${GOVERNANCE_SEED_NAMESPACE} multi-reviewer verification team`,
        createdBy: SEED_OWNER_UID,
        createdAt: SEED_NOW,
        members: SEED_TEST_USERS.map((u) => ({ uid: u.uid, email: u.email, role: u.role, joinedAt: SEED_NOW })),
        policyRules: [],
        settings: { minimumConsensusForAction: 60, flagThreshold: 50 },
        adaptiveReviewSettings: { enabled: true, mode: "all" },
        adaptiveMultiReviewerSettings: { enabled: true, mode: "majority_quorum" },
      },
    },
    // Team MEMBERSHIP alone is not how this codebase resolves "what team is
    // this user on" for page/route access — `loadUserAndTeam()`
    // (`lib/teams/teamApiAuth.ts`) reads `users/{uid}.teamId` as the
    // pointer, THEN loads that team, for every SERVER-side authorization
    // check. Separately, and discovered only via a real seeded browser
    // session (not caught by any unit test, since the fake-Firestore test
    // harnesses never modeled this CLIENT-side path): the review-queue
    // page's own gating (`components/teamGovernance/TeamReviewQueue.tsx`)
    // reads `teamRole` from a REAL-TIME CLIENT SDK LISTENER on
    // `users/{uid}` via `useUserPlan()` (`hooks/useUserPlan.ts`) —a
    // SEPARATE, DENORMALIZED copy of the member's role, independent of
    // `team.members[].role`, mirroring exactly what
    // `app/api/teams/members/route.ts` itself writes when a real owner
    // adds a member. All three (team membership, `users/{uid}.teamId`,
    // `users/{uid}.teamRole`) must be seeded together, or the seeded team
    // is reachable server-side but the client-rendered review queue
    // incorrectly reports "Insufficient permissions".
    ...SEED_TEST_USERS.map((u) => ({
      path: `users/${u.uid}`,
      mode: "set" as const,
      data: { email: u.email, name: u.displayName, teamId: SEED_TEAM_ID, teamRole: u.role, plan: "full" },
    })),
  ];

  const scenarios: SeedScenario[] = [];

  // ---- Scenario A — Ready approval: 3 reviewers, quorum 2, two approval-group votes, ready to finalize. ----
  {
    const runId = seedId("run", "a-ready");
    const reviewerIds = [SEED_REVIEWER_1_UID, SEED_REVIEWER_2_UID, SEED_REVIEWER_3_UID];
    const panel = openPanelFor(runId, reviewerIds);
    const votes = [voteFor(runId, SEED_REVIEWER_1_UID, "approved", panel.revision), voteFor(runId, SEED_REVIEWER_2_UID, "approved", panel.revision)];
    scenarios.push({
      id: "A",
      name: "Ready approval",
      runId,
      description: "3 reviewers, quorum 2, two approval-group votes submitted — panel is READY to finalize (not yet finalized).",
      writes: [runDoc(runId, baseGovernanceRecord()), projectionDoc(runId, "unreviewed"), panelDoc(runId, panel), ...votes.map((v) => voteDoc(runId, v))],
    });
  }

  // ---- Scenario B — Deadlock: 2 reviewers, one approval vote, one blocking vote. ----
  {
    const runId = seedId("run", "b-deadlock");
    const reviewerIds = [SEED_REVIEWER_1_UID, SEED_REVIEWER_2_UID];
    const panel = openPanelFor(runId, reviewerIds);
    const votes = [voteFor(runId, SEED_REVIEWER_1_UID, "approved", panel.revision), voteFor(runId, SEED_REVIEWER_2_UID, "rejected", panel.revision)];
    scenarios.push({
      id: "B",
      name: "Deadlock",
      runId,
      description: "2 reviewers, quorum 2, one approval vote + one blocking vote submitted — panel is DEADLOCKED (owner override is the escape hatch).",
      writes: [runDoc(runId, baseGovernanceRecord()), projectionDoc(runId, "unreviewed"), panelDoc(runId, panel), ...votes.map((v) => voteDoc(runId, v))],
    });
  }

  // ---- Scenario C — Waiting: 3 reviewers, one submitted vote, quorum not met. ----
  {
    const runId = seedId("run", "c-waiting");
    const reviewerIds = [SEED_REVIEWER_1_UID, SEED_REVIEWER_2_UID, SEED_REVIEWER_3_UID];
    const panel = openPanelFor(runId, reviewerIds);
    const votes = [voteFor(runId, SEED_REVIEWER_1_UID, "approved", panel.revision)];
    scenarios.push({
      id: "C",
      name: "Waiting",
      runId,
      description: "3 reviewers, quorum 2, one vote submitted — panel is WAITING (below quorum).",
      writes: [runDoc(runId, baseGovernanceRecord()), projectionDoc(runId, "unreviewed"), panelDoc(runId, panel), ...votes.map((v) => voteDoc(runId, v))],
    });
  }

  // ---- Scenario D — Finalized via aggregation: canonical humanReview terminal, panel finalized, history/event/audit artifacts present. ----
  {
    const runId = seedId("run", "d-finalized-aggregation");
    const reviewerIds = [SEED_REVIEWER_1_UID, SEED_REVIEWER_2_UID, SEED_REVIEWER_3_UID];
    const openPanel = openPanelFor(runId, reviewerIds);
    const votes = [voteFor(runId, SEED_REVIEWER_1_UID, "approved", openPanel.revision), voteFor(runId, SEED_REVIEWER_2_UID, "approved", openPanel.revision)];
    const finalDecisionId = buildAdaptivePanelFinalDecisionId(SEED_TEAM_ID, runId, openPanel.revision, "approved", ADAPTIVE_REVIEW_AGGREGATION_POLICY_VERSION);
    const finalizedPanel = buildFinalizedAdaptiveHumanReviewPanel({
      current: openPanel,
      actorUserId: SEED_OWNER_UID,
      now: SEED_NOW,
      finalStatus: "approved",
      finalDecisionId,
      aggregationPolicyVersion: ADAPTIVE_REVIEW_AGGREGATION_POLICY_VERSION,
    });
    const humanReview = buildFinalizedMultiReviewerHumanReview({
      finalStatus: "approved",
      finalizingActorUid: SEED_OWNER_UID,
      reviewedAt: SEED_NOW,
      conditions: buildFinalConditionsUnion(votes, [SEED_REVIEWER_1_UID, SEED_REVIEWER_2_UID]),
      panelRevision: openPanel.revision,
      aggregationPolicyVersion: ADAPTIVE_REVIEW_AGGREGATION_POLICY_VERSION,
      supportingReviewerCount: 2,
    });
    const historyEntry = buildAdaptivePanelFinalizationHistoryEntry({
      teamId: SEED_TEAM_ID,
      runId,
      preFinalizationPanelRevision: openPanel.revision,
      finalizedPanelRevision: finalizedPanel.revision,
      finalStatus: "approved",
      finalDecisionId,
      aggregationPolicyVersion: ADAPTIVE_REVIEW_AGGREGATION_POLICY_VERSION,
      reviewerCount: 3,
      submittedCount: 2,
      supportingReviewerCount: 2,
      actorUserId: SEED_OWNER_UID,
      finalizedAt: SEED_NOW,
    });
    scenarios.push({
      id: "D",
      name: "Finalized (aggregation)",
      runId,
      description: "Panel finalized via ordinary aggregation — canonical humanReview terminal, panel finalizedVia 'aggregation', panel-history entry present.",
      writes: [
        runDoc(runId, baseGovernanceRecord({ humanReview, updatedAt: SEED_NOW })),
        projectionDoc(runId, "approved"),
        panelDoc(runId, finalizedPanel),
        ...votes.map((v) => voteDoc(runId, v)),
        { path: `runs/${runId}/humanReviewPanelHistory/${historyEntry.eventId}`, mode: "create", data: historyEntry },
      ],
    });
  }

  // ---- Scenario E — Finalized via owner override: finalizedVia owner_override, override provenance, votes unchanged (deadlocked before the override). ----
  {
    const runId = seedId("run", "e-finalized-override");
    const reviewerIds = [SEED_REVIEWER_1_UID, SEED_REVIEWER_2_UID];
    const openPanel = openPanelFor(runId, reviewerIds);
    const votes = [voteFor(runId, SEED_REVIEWER_1_UID, "approved", openPanel.revision), voteFor(runId, SEED_REVIEWER_2_UID, "rejected", openPanel.revision)];
    const justification = "[SEED DATA] Deterministic seed justification for the owner-override end-to-end scenario — the panel deadlocked and the owner broke the tie.";
    const finalDecisionId = buildAdaptivePanelOverrideDecisionId({
      teamId: SEED_TEAM_ID,
      runId,
      panelRevision: openPanel.revision,
      status: "approved",
      justification,
    });
    const overriddenPanel = buildOwnerOverriddenAdaptiveHumanReviewPanel({
      current: openPanel,
      actorUserId: SEED_OWNER_UID,
      now: SEED_NOW,
      finalStatus: "approved",
      finalDecisionId,
      aggregationPolicyVersion: ADAPTIVE_REVIEW_AGGREGATION_POLICY_VERSION,
    });
    const humanReview = buildOverriddenMultiReviewerHumanReview({
      finalStatus: "approved",
      overridingOwnerUid: SEED_OWNER_UID,
      reviewedAt: SEED_NOW,
      justification,
      panelRevision: openPanel.revision,
    });
    const historyEntry = buildAdaptivePanelOverrideHistoryEntry({
      teamId: SEED_TEAM_ID,
      runId,
      preOverridePanelRevision: openPanel.revision,
      overriddenPanelRevision: overriddenPanel.revision,
      finalStatus: "approved",
      finalDecisionId,
      overrideByUserId: SEED_OWNER_UID,
      conditionsCount: 0,
      finalizedAt: SEED_NOW,
    });
    scenarios.push({
      id: "E",
      name: "Finalized (owner override)",
      runId,
      description: "Panel deadlocked, then owner-overridden — canonical humanReview terminal via multi_reviewer_owner_override, panel finalizedVia 'owner_override', votes unchanged, override-history entry present.",
      writes: [
        runDoc(runId, baseGovernanceRecord({ humanReview, updatedAt: SEED_NOW })),
        projectionDoc(runId, "approved"),
        panelDoc(runId, overriddenPanel),
        ...votes.map((v) => voteDoc(runId, v)),
        { path: `runs/${runId}/humanReviewPanelHistory/${historyEntry.eventId}`, mode: "create", data: historyEntry },
      ],
    });
  }

  // ---- Scenario F — Legacy single-reviewer: no panel at all. ----
  {
    const runId = seedId("run", "f-legacy-single-reviewer");
    scenarios.push({
      id: "F",
      name: "Legacy single-reviewer",
      runId,
      description: "No panel exists for this run — the existing single-reviewer assignment/decision workflow remains the only path, completely unaffected by multi-reviewer panels.",
      writes: [runDoc(runId, baseGovernanceRecord()), projectionDoc(runId, "unreviewed")],
    });
  }

  return { namespace: GOVERNANCE_SEED_NAMESPACE, teamWrites, scenarios };
}
