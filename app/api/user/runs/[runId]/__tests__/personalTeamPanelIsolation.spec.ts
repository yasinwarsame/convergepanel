/**
 * PHASE 1 — Personal/Team review-panel isolation.
 *
 * A Personal reviewer assignment (`humanReviewAssignment/current` with
 * `teamId: null`) is an independent, narrow capability: it authorizes the
 * assigned uid to read and decide THEIR OWN assigned review of one run. It
 * is NOT a grant of legacy Team review authority.
 *
 * Those two records are structurally independent. A legacy run (no
 * `workspaceId` field at all) can carry a legacy Team `humanReviewPanel/current`
 * AND a Personal assignment at the same time, because
 * `submitAdaptiveHumanReviewPanel` never touches the assignment document.
 * The Personal governance route used to treat co-location as authorization
 * ("a panel is team-only by construction (personal runs never have one)"),
 * which handed an unrelated Personal reviewer the Team panel's reviewer
 * identities, per-reviewer vote states, quorum and aggregate counts.
 *
 * Both Personal surfaces are asserted TOGETHER here (§13 parity): fixing one
 * while the other still resolves Team reviewer identities would leave the
 * same disclosure open through a different URL.
 *
 * The suppression assertions are deliberately paired with NOT-CALLED
 * assertions on the panel/vote getters and the identity resolver. Redacting
 * Team names AFTER resolving them still reads the data; the boundary has to
 * run first. Those not-called assertions are also what makes the owner
 * control non-vacuous: for the OWNER the very same getters MUST still run.
 */

const mockedResolveRequestIdentity = jest.fn();
jest.mock("@/lib/auth/resolveRequestIdentity", () => ({
  resolveRequestIdentity: (...a: any[]) => mockedResolveRequestIdentity(...a),
}));
jest.mock("@/lib/auth/identityResolutionTelemetry", () => ({ logIdentityResolutionFailure: jest.fn() }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const mockedGetAssignment = jest.fn();
const mockedGetPanel = jest.fn();
const mockedGetVote = jest.fn();
jest.mock("@/lib/firestore/runs", () => ({
  getAdaptiveHumanReviewAssignment: (...a: any[]) => mockedGetAssignment(...a),
  getAdaptiveHumanReviewPanel: (...a: any[]) => mockedGetPanel(...a),
  getAdaptiveHumanReviewVote: (...a: any[]) => mockedGetVote(...a),
}));

const mockedLoadUserAndTeam = jest.fn();
jest.mock("@/lib/teams/teamApiAuth", () => ({ loadUserAndTeam: (...a: any[]) => mockedLoadUserAndTeam(...a) }));

/** Every uid the route asks the identity resolver to resolve, across both routes. */
let resolvedUidCalls: string[][] = [];
jest.mock("@/lib/governance/reviewerIdentity", () => ({
  resolveReviewerDisplayNames: async (uids: string[]) => {
    resolvedUidCalls.push([...uids]);
    return new Map(uids.map((u) => [u, `NAME_OF_${u}`]));
  },
  UNKNOWN_REVIEWER_LABEL: "Unknown reviewer",
  REVIEWER_UNAVAILABLE_LABEL: "Unavailable",
}));

const mockedGetWorkspace = jest.fn();
jest.mock("@/lib/firestore/workspaces", () => ({ getWorkspace: (...a: any[]) => mockedGetWorkspace(...a) }));

let runDoc: Record<string, unknown> | null = null;
let historyDocs: Array<{ id: string; data: Record<string, unknown> }> = [];
const mockAdminDb: any = {
  collection: () => ({
    doc: () => ({
      get: async () => ({ exists: runDoc !== null, data: () => runDoc }),
      collection: () => ({ get: async () => ({ docs: historyDocs.map((d) => ({ id: d.id, data: () => d.data })) }) }),
    }),
  }),
};
jest.mock("@/lib/firebase/admin", () => ({ get adminDb() { return mockAdminDb; } }));

import { NextRequest } from "next/server";
import { GET as governanceGET } from "@/app/api/user/runs/[runId]/governance/route";
import { GET as historyGET } from "@/app/api/user/runs/[runId]/review-history/route";

const RUN = "run-legacy-1";
const OWNER = "owner-uid";
const REVIEWER = "personal-reviewer-uid";
const TEAM_REVIEWERS = ["teamReviewerA", "teamReviewerB", "teamReviewerC"];

function governanceRecord() {
  return {
    version: 1,
    schemaId: "decision_support",
    answerShape: "decision_support_view",
    adaptiveOutputVersion: 1,
    humanReview: { status: "unreviewed" },
    decisionReceipt: {
      conclusion: "C", basis: [], assumptions: [], uncertainties: [],
      limitations: [], sources: [], sourceBacked: false, humanReviewNeeded: false,
    },
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

/** A LEGACY run: the `workspaceId` key is genuinely absent, never present-and-undefined. */
function seedLegacyRun() {
  runDoc = { userId: OWNER, question: "q", governanceRecord: governanceRecord() };
}

function seedPersonalAssignment() {
  mockedGetAssignment.mockResolvedValue({
    status: "found",
    assignment: {
      version: 1, runId: RUN, teamId: null, assignedReviewerUserId: REVIEWER,
      assignedByUserId: OWNER, assignedAt: "2026-08-01T00:00:00.000Z", revision: 1,
    },
  });
}

function seedLegacyTeamPanel() {
  mockedGetPanel.mockResolvedValue({
    status: "found",
    panel: {
      schemaVersion: 1, kind: "adaptive_review_panel", teamId: "team-SECRET", runId: RUN,
      mode: "majority_quorum", reviewerUserIds: [...TEAM_REVIEWERS],
      requiredReviewerCount: 3, quorum: 2, status: "open", revision: 3,
      createdAt: "2026-08-02T00:00:00.000Z", createdByUserId: "team-admin-uid",
      updatedAt: "2026-08-02T00:00:00.000Z", updatedByUserId: "team-admin-uid",
    },
  });
  mockedGetVote.mockImplementation(async (_r: string, _rev: number, reviewerUserId: string) => ({
    status: "found",
    vote: {
      version: 1, runId: RUN, teamId: "team-SECRET", panelRevision: 3,
      reviewerUserId, status: "approved", comment: `PRIVATE COMMENT BY ${reviewerUserId}`,
      submittedAt: "2026-08-03T00:00:00.000Z",
    },
  }));
}

/** History: one legacy TEAM decision row and one PERSONAL decision row on the same run. */
function seedMixedHistory() {
  historyDocs = [
    {
      id: "hist-team",
      data: {
        version: 1, kind: "adaptive_human_review", historyId: "hist-team", decisionId: "hist-team",
        runId: RUN, teamId: "team-SECRET", schemaId: "decision_support", answerShape: "decision_support_view",
        priorStatus: "unreviewed", newStatus: "approved", reviewerId: "teamReviewerA",
        reviewedAt: "2026-08-03T00:00:00.000Z", governanceRecordUpdatedAt: "2026-08-03T00:00:00.000Z",
        commentPresent: true, conditionsCount: 0,
      },
    },
    {
      id: "hist-personal",
      data: {
        version: 1, kind: "adaptive_human_review", historyId: "hist-personal", decisionId: "hist-personal",
        runId: RUN, teamId: null, schemaId: "decision_support", answerShape: "decision_support_view",
        priorStatus: "unreviewed", newStatus: "changes_requested", reviewerId: REVIEWER,
        reviewedAt: "2026-08-04T00:00:00.000Z", governanceRecordUpdatedAt: "2026-08-04T00:00:00.000Z",
          commentPresent: false, conditionsCount: 0,
      },
    },
  ];
}

const params = { params: { runId: RUN } } as any;
const callGovernance = async () => {
  const res = await governanceGET(new NextRequest(`http://localhost/api/user/runs/${RUN}/governance`), params);
  return { status: res.status, body: await res.json() };
};
const callHistory = async () => {
  const res = await historyGET(new NextRequest(`http://localhost/api/user/runs/${RUN}/review-history`), params);
  return { status: res.status, body: await res.json() };
};

/** Every Team-panel-derived field the audit enumerated, as one searchable blob. */
function teamPanelLeakSurface(body: unknown): string[] {
  const s = JSON.stringify(body);
  const leaks: string[] = [];
  for (const uid of TEAM_REVIEWERS) {
    if (s.includes(uid)) leaks.push(`raw-uid:${uid}`);
    if (s.includes(`NAME_OF_${uid}`)) leaks.push(`displayName:${uid}`);
  }
  if (s.includes("team-SECRET")) leaks.push("teamId");
  if (s.includes("PRIVATE COMMENT")) leaks.push("voteComment");
  const gov = (body as any)?.governance;
  if (gov && gov.panel !== null && gov.panel !== undefined) leaks.push("panelObject");
  return leaks;
}

function identityResolverSawTeamReviewers(): boolean {
  return resolvedUidCalls.some((call) => call.some((u) => TEAM_REVIEWERS.includes(u)));
}

beforeEach(() => {
  jest.clearAllMocks();
  resolvedUidCalls = [];
  historyDocs = [];
  runDoc = null;
  mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: REVIEWER });
  mockedGetAssignment.mockResolvedValue({ status: "absent" });
  mockedGetPanel.mockResolvedValue({ status: "absent" });
  mockedGetVote.mockResolvedValue({ status: "absent" });
  mockedLoadUserAndTeam.mockResolvedValue(null);
  mockedGetWorkspace.mockResolvedValue(null);
});

describe("L1 — legacy run + Personal assignment + NO panel (the control the fix must not break)", () => {
  it("governance still serves the Personal reviewer their own assignment", async () => {
    seedLegacyRun();
    seedPersonalAssignment();
    const r = await callGovernance();
    expect(r.status).toBe(200);
    expect(r.body.viewerRole).toBe("personal_reviewer");
    expect(r.body.governance.assignment.reviewerDisplayName).toBe(`NAME_OF_${REVIEWER}`);
    expect(r.body.humanReviewStatus).toBe("unreviewed");
    expect(r.body.governanceUpdatedAt).toBe("2026-08-01T00:00:00.000Z");
  });

  it("review-history still serves the Personal reviewer their own decision rows", async () => {
    seedLegacyRun();
    seedPersonalAssignment();
    historyDocs = [
      {
        id: "hist-personal",
        data: {
          version: 1, kind: "adaptive_human_review", historyId: "hist-personal", decisionId: "hist-personal",
          runId: RUN, teamId: null, schemaId: "decision_support", answerShape: "decision_support_view",
          priorStatus: "unreviewed", newStatus: "changes_requested", reviewerId: REVIEWER,
          reviewedAt: "2026-08-04T00:00:00.000Z", governanceRecordUpdatedAt: "2026-08-04T00:00:00.000Z",
          commentPresent: false, conditionsCount: 0,
        },
      },
    ];
    const r = await callHistory();
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0].reviewerDisplayName).toBe(`NAME_OF_${REVIEWER}`);
  });
});

describe("L2/L3/L4 — legacy run + Personal assignment + legacy TEAM panel", () => {
  beforeEach(() => {
    seedLegacyRun();
    seedPersonalAssignment();
    seedLegacyTeamPanel();
  });

  it("L2: governance discloses NO Team panel field whatsoever", async () => {
    const r = await callGovernance();
    expect(r.status).toBe(200);
    expect(r.body.viewerRole).toBe("personal_reviewer");
    expect(teamPanelLeakSurface(r.body)).toEqual([]);
  });

  it("L3: the Team panel and its votes are never even READ", async () => {
    await callGovernance();
    expect(mockedGetPanel).not.toHaveBeenCalled();
    expect(mockedGetVote).not.toHaveBeenCalled();
  });

  it("L3: Team reviewer identities are never resolved (guard precedes enrichment)", async () => {
    await callGovernance();
    expect(identityResolverSawTeamReviewers()).toBe(false);
  });

  it("L4: historyScope does not betray that a Team panel exists", async () => {
    const r = await callGovernance();
    expect(r.body.historyScope).toBe("personal");
  });

  it("L2: review-history suppresses Team decision rows but keeps the Personal one", async () => {
    seedMixedHistory();
    const r = await callHistory();
    expect(r.status).toBe(200);
    expect(teamPanelLeakSurface(r.body)).toEqual([]);
    expect(r.body.items).toHaveLength(1);
    expect(r.body.items[0].newStatus).toBe("changes_requested");
  });

  it("L3: review-history never resolves a Team reviewer's identity", async () => {
    seedMixedHistory();
    await callHistory();
    expect(identityResolverSawTeamReviewers()).toBe(false);
  });
});

describe("L5 — the Personal surface does not become a Team surface for an incidental Team member", () => {
  it("suppression is identical when the caller happens to share a legacy team", async () => {
    seedLegacyRun();
    seedPersonalAssignment();
    seedLegacyTeamPanel();
    // The caller IS in a legacy team (so the masked-email roster is non-empty),
    // but this Personal endpoint performs no Team authorization at all — team
    // membership must not silently upgrade the response.
    mockedLoadUserAndTeam.mockResolvedValue({
      user: { email: "reviewer@test.com" },
      team: { id: "team-SECRET", members: [{ uid: REVIEWER, email: "reviewer@test.com" }, { uid: "teamReviewerA", email: "a@test.com" }] },
    });
    const r = await callGovernance();
    expect(teamPanelLeakSurface(r.body)).toEqual([]);
    expect(mockedGetPanel).not.toHaveBeenCalled();
  });
});

describe("owner control — the fix restricts the Personal REVIEWER, not the run owner", () => {
  beforeEach(() => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: OWNER });
    seedLegacyRun();
    seedPersonalAssignment();
    seedLegacyTeamPanel();
  });

  it("the owner's panel view is unchanged — proving the not-called assertions above are not vacuous", async () => {
    const r = await callGovernance();
    expect(r.status).toBe(200);
    expect(r.body.viewerRole).toBe("owner");
    expect(mockedGetPanel).toHaveBeenCalled();
    expect(mockedGetVote).toHaveBeenCalledTimes(TEAM_REVIEWERS.length);
    expect(r.body.governance.panel).not.toBeNull();
    expect(identityResolverSawTeamReviewers()).toBe(true);
  });

  it("the owner still receives every history row", async () => {
    seedMixedHistory();
    const r = await callHistory();
    expect(r.body.items).toHaveLength(2);
  });
});

describe("L6–L9 — pre-existing fail-closed behaviour must survive the correction", () => {
  it("L6: a Team-Workspace-bound run stays excluded from Personal assignment authority", async () => {
    runDoc = { userId: OWNER, question: "q", workspaceId: "ws-team-abc123", governanceRecord: governanceRecord() };
    seedPersonalAssignment();
    seedLegacyTeamPanel();
    const g = await callGovernance();
    expect(g.status).toBe(404);
    const h = await callHistory();
    expect(h.status).toBe(404);
    expect(mockedGetPanel).not.toHaveBeenCalled();
  });

  it("L7: an assignment belonging to another uid is refused", async () => {
    seedLegacyRun();
    mockedGetAssignment.mockResolvedValue({
      status: "found",
      assignment: {
        version: 1, runId: RUN, teamId: null, assignedReviewerUserId: "somebody-else",
        assignedByUserId: OWNER, assignedAt: "2026-08-01T00:00:00.000Z", revision: 1,
      },
    });
    seedLegacyTeamPanel();
    const g = await callGovernance();
    expect(g.status).toBe(403);
    expect(mockedGetPanel).not.toHaveBeenCalled();
  });

  it("L8: a missing run is a concealed 404", async () => {
    runDoc = null;
    seedPersonalAssignment();
    const g = await callGovernance();
    expect(g.status).toBe(404);
  });

  it("L9: a malformed Workspace binding fails closed", async () => {
    runDoc = { userId: OWNER, question: "q", workspaceId: 12345, governanceRecord: governanceRecord() };
    seedPersonalAssignment();
    seedLegacyTeamPanel();
    const g = await callGovernance();
    expect(g.status).toBe(404);
    expect(mockedGetPanel).not.toHaveBeenCalled();
  });
});

describe("L10 — the read boundary is independent of the panel-CREATION rollout flag", () => {
  it("suppression is identical whether MULTI_REVIEWER_GOVERNANCE_ENABLED is false or true", async () => {
    const run = async () => {
      jest.clearAllMocks();
      resolvedUidCalls = [];
      mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: REVIEWER });
      mockedLoadUserAndTeam.mockResolvedValue(null);
      seedLegacyRun();
      seedPersonalAssignment();
      seedLegacyTeamPanel();
      return (await callGovernance()).body;
    };
    const whenFalse = await run();
    jest.replaceProperty(require("@/lib/env"), "MULTI_REVIEWER_GOVERNANCE_ENABLED", true as never);
    const whenTrue = await run();
    expect(whenTrue).toEqual(whenFalse);
    expect(teamPanelLeakSurface(whenTrue)).toEqual([]);
  });

  it("neither Personal route consults the rollout flag at all", () => {
    const fs = require("fs");
    for (const f of [
      "app/api/user/runs/[runId]/governance/route.ts",
      "app/api/user/runs/[runId]/review-history/route.ts",
    ]) {
      expect(fs.readFileSync(f, "utf8")).not.toContain("MULTI_REVIEWER_GOVERNANCE_ENABLED");
    }
  });
});

describe("§13 parity — neither route may expose a field the other suppresses", () => {
  it("both routes suppress the identical Team-derived field set", async () => {
    seedLegacyRun();
    seedPersonalAssignment();
    seedLegacyTeamPanel();
    seedMixedHistory();
    const g = await callGovernance();
    const h = await callHistory();
    expect(teamPanelLeakSurface(g.body)).toEqual([]);
    expect(teamPanelLeakSurface(h.body)).toEqual([]);
    expect(identityResolverSawTeamReviewers()).toBe(false);
  });
});

/**
 * A LEGACY run whose canonical `humanReview` was DECIDED BY A TEAM ACTOR via
 * the Team decision route — no panel involved. This is the shape the first
 * version of the fix missed entirely: the earlier parity fixture left
 * `humanReview.status = "unreviewed"` with no `reviewerId`, so the vulnerable
 * `singleReviewer` branch was never entered and the test passed vacuously.
 */
const TEAM_ACTOR = "TEAM_ACTOR_UID";
function seedTeamDecidedRun() {
  runDoc = {
    userId: OWNER,
    question: "q",
    governanceRecord: {
      ...governanceRecord(),
      humanReview: { status: "approved", reviewerId: TEAM_ACTOR, reviewedAt: "2026-08-03T00:00:00.000Z", decidedVia: "single_reviewer" },
    },
  };
  historyDocs = [
    {
      id: "h-team",
      data: {
        version: 1, kind: "adaptive_human_review", historyId: "h-team", decisionId: "h-team",
        runId: RUN, teamId: "team-SECRET", schemaId: "decision_support", answerShape: "decision_support_view",
        priorStatus: "unreviewed", newStatus: "approved", reviewerId: TEAM_ACTOR,
        reviewedAt: "2026-08-03T00:00:00.000Z", governanceRecordUpdatedAt: "2026-08-03T00:00:00.000Z",
        commentPresent: true, conditionsCount: 0,
      },
    },
  ];
}

function identityResolverSaw(uid: string): boolean {
  return resolvedUidCalls.some((call) => call.includes(uid));
}

describe("F1 — a legacy TEAM actor's single-reviewer decision is not disclosed to a Personal reviewer", () => {
  beforeEach(() => {
    seedTeamDecidedRun();
    seedPersonalAssignment();
  });

  it("the Team decider's uid never reaches the identity resolver", async () => {
    await callGovernance();
    expect(identityResolverSaw(TEAM_ACTOR)).toBe(false);
  });

  it("singleReviewer does not carry the Team decider's identity", async () => {
    const r = await callGovernance();
    expect(r.status).toBe(200);
    expect(r.body.viewerRole).toBe("personal_reviewer");
    expect(r.body.governance.singleReviewer).toBeNull();
    expect(JSON.stringify(r.body)).not.toContain(`NAME_OF_${TEAM_ACTOR}`);
    expect(JSON.stringify(r.body)).not.toContain(TEAM_ACTOR);
  });

  it("PARITY: governance and review-history agree — both hide that decision", async () => {
    const g = await callGovernance();
    const h = await callHistory();
    expect(h.body.items).toEqual([]);
    expect(JSON.stringify(g.body)).not.toContain(TEAM_ACTOR);
    expect(JSON.stringify(h.body)).not.toContain(TEAM_ACTOR);
    expect(identityResolverSaw(TEAM_ACTOR)).toBe(false);
  });

  it("CONTROL: the reviewer's OWN decision is still shown to them", async () => {
    runDoc = {
      userId: OWNER,
      question: "q",
      governanceRecord: {
        ...governanceRecord(),
        humanReview: { status: "approved", reviewerId: REVIEWER, reviewedAt: "2026-08-04T00:00:00.000Z", decidedVia: "single_reviewer" },
      },
    };
    const r = await callGovernance();
    expect(r.body.governance.singleReviewer).not.toBeNull();
    expect(r.body.governance.singleReviewer.displayName).toBe(`NAME_OF_${REVIEWER}`);
  });

  it("CONTROL: the OWNER still sees the Team decider", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: OWNER });
    const r = await callGovernance();
    expect(r.body.viewerRole).toBe("owner");
    expect(r.body.governance.singleReviewer.displayName).toBe(`NAME_OF_${TEAM_ACTOR}`);
    expect(identityResolverSaw(TEAM_ACTOR)).toBe(true);
  });
});

describe("F2 — a finalized panel's reviewer is not resolved for a Personal reviewer", () => {
  it("the panelist uid never reaches the identity resolver, even though no name is returned", async () => {
    runDoc = {
      userId: OWNER,
      question: "q",
      governanceRecord: {
        ...governanceRecord(),
        humanReview: { status: "approved", reviewerId: "TEAM_PANELIST_UID", reviewedAt: "2026-08-03T00:00:00.000Z", decidedVia: "multi_reviewer_panel" },
      },
    };
    seedPersonalAssignment();
    const r = await callGovernance();
    expect(r.body.governance.singleReviewer).toBeNull();
    expect(identityResolverSaw("TEAM_PANELIST_UID")).toBe(false);
  });
});

/**
 * §14 — the LEGACY-family (System A) branch of reviewer-identity suppression.
 *
 * Previously uncovered: deleting the guard from the legacy branch of
 * `buildReviewGovernanceViewModel` passed the whole suite. That branch is
 * live — a run with no Milestone-2 governance record but a legacy
 * `governanceStatus` falls into it, and `governanceReviewedBy` is typically a
 * team admin. Reaching it needs a run whose `governanceRecord` is absent.
 */
describe("§14 — legacy System A governance family", () => {
  const LEGACY_REVIEWER = "LEGACY_GOV_REVIEWER";

  beforeEach(() => {
    runDoc = {
      userId: OWNER,
      question: "q",
      // No governanceRecord at all -> legacy family.
      governanceStatus: "approved",
      governanceReasons: ["policy ok"],
      governanceReviewedBy: LEGACY_REVIEWER,
      governanceReviewedAt: "2026-08-02T00:00:00.000Z",
    };
    seedPersonalAssignment();
  });

  it("a Personal reviewer never learns the legacy governance reviewer's identity", async () => {
    const r = await callGovernance();
    expect(r.status).toBe(200);
    expect(r.body.viewerRole).toBe("personal_reviewer");
    expect(r.body.governance.family).toBe("legacy");
    expect(r.body.governance.reviewer).toBeNull();
    expect(identityResolverSaw(LEGACY_REVIEWER)).toBe(false);
    expect(JSON.stringify(r.body)).not.toContain(LEGACY_REVIEWER);
  });

  it("CONTROL: the owner still sees it — so the assertion above is not vacuous", async () => {
    mockedResolveRequestIdentity.mockResolvedValue({ status: "authenticated", uid: OWNER });
    const r = await callGovernance();
    expect(r.body.governance.family).toBe("legacy");
    expect(r.body.governance.reviewer.displayName).toBe(`NAME_OF_${LEGACY_REVIEWER}`);
    expect(identityResolverSaw(LEGACY_REVIEWER)).toBe(true);
  });
});
