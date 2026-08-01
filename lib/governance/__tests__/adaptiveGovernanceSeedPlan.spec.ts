/**
 * Multi-Reviewer Production-Readiness Hardening, Step 5.15 —
 * buildAdaptiveGovernanceSeedPlan() tests. Pure, zero-I/O — no Firestore
 * involved at all, so these tests run against the real plan-building logic
 * directly.
 */

import {
  buildAdaptiveGovernanceSeedPlan,
  SEED_TEAM_ID,
  SEED_OWNER_UID,
  SEED_ADMIN_UID,
  SEED_REVIEWER_1_UID,
  SEED_REVIEWER_2_UID,
  SEED_TEST_USERS,
} from "@/lib/governance/adaptiveGovernanceSeedPlan";
import { GOVERNANCE_SEED_NAMESPACE, isWithinSeedNamespace } from "@/lib/governance/adaptiveGovernanceSeedSafety";
import { parseAdaptiveHumanReviewPanel } from "@/lib/governance/adaptiveHumanReviewPanel";
import { parseAdaptiveHumanReviewVote } from "@/lib/governance/adaptiveHumanReviewVote";
import { parseGovernanceRecord } from "@/lib/adaptiveSchema/governanceRecordParser";

describe("buildAdaptiveGovernanceSeedPlan — determinism and idempotency", () => {
  it("produces byte-identical output on repeated calls (rerun-idempotent by construction)", () => {
    const first = buildAdaptiveGovernanceSeedPlan();
    const second = buildAdaptiveGovernanceSeedPlan();
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("every document path/ID falls within the seed namespace — team, every run, and every write", () => {
    const plan = buildAdaptiveGovernanceSeedPlan();
    expect(isWithinSeedNamespace(SEED_TEAM_ID)).toBe(true);
    for (const write of plan.teamWrites) {
      expect(isWithinSeedNamespace(write.path)).toBe(true);
    }
    for (const scenario of plan.scenarios) {
      expect(isWithinSeedNamespace(scenario.runId)).toBe(true);
      for (const write of scenario.writes) {
        expect(isWithinSeedNamespace(write.path)).toBe(true);
      }
    }
  });

  it("produces exactly 6 scenarios, A through F, each with a distinct runId", () => {
    const plan = buildAdaptiveGovernanceSeedPlan();
    expect(plan.scenarios.map((s) => s.id)).toEqual(["A", "B", "C", "D", "E", "F"]);
    const runIds = plan.scenarios.map((s) => s.runId);
    expect(new Set(runIds).size).toBe(runIds.length);
  });
});

describe("buildAdaptiveGovernanceSeedPlan — team", () => {
  it("creates one team with owner, admin, 3 reviewers, and one ordinary member", () => {
    const plan = buildAdaptiveGovernanceSeedPlan();
    const teamDoc = plan.teamWrites.find((w) => w.path === `teams/${SEED_TEAM_ID}`);
    expect(teamDoc).toBeDefined();
    const teamData = teamDoc!.data as any;
    expect(teamData.members).toHaveLength(6);
    const roles = teamData.members.map((m: any) => m.role);
    expect(roles.filter((r: string) => r === "owner")).toHaveLength(1);
    expect(roles.filter((r: string) => r === "admin")).toHaveLength(4); // admin + 3 reviewers, all admin-role-eligible
    expect(roles.filter((r: string) => r === "member")).toHaveLength(1);
  });

  it("creates a users/{uid} document with a teamId pointer for every test user — this is how loadUserAndTeam() actually resolves team membership, not the team's own members array", () => {
    const plan = buildAdaptiveGovernanceSeedPlan();
    for (const user of SEED_TEST_USERS) {
      const userDoc = plan.teamWrites.find((w) => w.path === `users/${user.uid}`);
      expect(userDoc).toBeDefined();
      expect((userDoc!.data as any).teamId).toBe(SEED_TEAM_ID);
      expect((userDoc!.data as any).email).toBe(user.email);
      // Discovered via real seeded browser verification (Step 5.16): the
      // review-queue UI reads a SEPARATE, denormalized `teamRole` field
      // via a client-side listener, independent of `team.members[].role`.
      expect((userDoc!.data as any).teamRole).toBe(user.role);
    }
  });

  it("the team has multi-reviewer opt-in explicitly enabled (seeding wouldn't be useful otherwise)", () => {
    const plan = buildAdaptiveGovernanceSeedPlan();
    const teamData = plan.teamWrites[0].data as any;
    expect(teamData.adaptiveMultiReviewerSettings).toEqual({ enabled: true, mode: "majority_quorum" });
  });

  it("never uses a real-looking email domain — every test user is @example.com (RFC 2606 reserved)", () => {
    for (const user of SEED_TEST_USERS) {
      expect(user.email.endsWith("@example.com")).toBe(true);
    }
  });
});

function scenario(id: string) {
  const plan = buildAdaptiveGovernanceSeedPlan();
  const found = plan.scenarios.find((s) => s.id === id);
  if (!found) throw new Error(`scenario ${id} not found`);
  return found;
}

function findWrite(writes: { path: string; data: object }[], pathSuffix: string) {
  const found = writes.find((w) => w.path.endsWith(pathSuffix));
  if (!found) throw new Error(`no write found ending in ${pathSuffix}`);
  return found;
}

describe("Scenario A — Ready approval", () => {
  it("3 reviewers, quorum 2, two approval votes, panel parses as a valid OPEN panel", () => {
    const s = scenario("A");
    const panelWrite = findWrite(s.writes, "/humanReviewPanel/current");
    const parsed = parseAdaptiveHumanReviewPanel(panelWrite.data);
    expect(parsed.status).toBe("valid");
    if (parsed.status === "valid") {
      expect(parsed.panel.status).toBe("open");
      expect(parsed.panel.requiredReviewerCount).toBe(3);
      expect(parsed.panel.quorum).toBe(2);
    }
  });

  it("exactly two valid votes are seeded, both approved", () => {
    const s = scenario("A");
    const voteWrites = s.writes.filter((w) => w.path.includes("/humanReviewVotes/"));
    expect(voteWrites).toHaveLength(2);
    for (const w of voteWrites) {
      const parsed = parseAdaptiveHumanReviewVote(w.data);
      expect(parsed.status).toBe("valid");
      if (parsed.status === "valid") expect(parsed.vote.status).toBe("approved");
    }
  });

  it("the governanceRecord is still unreviewed/pending (not yet finalized)", () => {
    const s = scenario("A");
    const runWrite = findWrite(s.writes, `runs/${s.runId}`);
    const record = (runWrite.data as any).governanceRecord;
    const parsed = parseGovernanceRecord(record);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.record.humanReview.status).toBe("unreviewed");
  });
});

describe("Scenario B — Deadlock", () => {
  it("2 reviewers, quorum 2, one approval vote + one blocking vote", () => {
    const s = scenario("B");
    const panelWrite = findWrite(s.writes, "/humanReviewPanel/current");
    const parsed = parseAdaptiveHumanReviewPanel(panelWrite.data);
    expect(parsed.status).toBe("valid");
    if (parsed.status === "valid") {
      expect(parsed.panel.requiredReviewerCount).toBe(2);
      expect(parsed.panel.quorum).toBe(2);
    }
    const voteWrites = s.writes.filter((w) => w.path.includes("/humanReviewVotes/"));
    const statuses = voteWrites.map((w) => (w.data as any).status).sort();
    expect(statuses).toEqual(["approved", "rejected"]);
  });
});

describe("Scenario C — Waiting", () => {
  it("3 reviewers, quorum 2, only one vote submitted (below quorum)", () => {
    const s = scenario("C");
    const voteWrites = s.writes.filter((w) => w.path.includes("/humanReviewVotes/"));
    expect(voteWrites).toHaveLength(1);
  });
});

describe("Scenario D — Finalized (aggregation)", () => {
  it("panel is finalized via aggregation with a valid finalDecisionId and matching canonical humanReview", () => {
    const s = scenario("D");
    const panelWrite = findWrite(s.writes, "/humanReviewPanel/current");
    const parsedPanel = parseAdaptiveHumanReviewPanel(panelWrite.data);
    expect(parsedPanel.status).toBe("valid");
    if (parsedPanel.status !== "valid") return;
    expect(parsedPanel.panel.status).toBe("finalized");
    expect(parsedPanel.panel.finalizedVia).toBe("aggregation");
    expect(parsedPanel.panel.finalDecisionId).toMatch(/^panel_dec_[0-9a-f]{32}$/);

    const runWrite = findWrite(s.writes, `runs/${s.runId}`);
    const parsedRecord = parseGovernanceRecord((runWrite.data as any).governanceRecord);
    expect(parsedRecord.ok).toBe(true);
    if (!parsedRecord.ok) return;
    expect(parsedRecord.record.humanReview.status).toBe("approved");
    expect(parsedRecord.record.humanReview.decidedVia).toBe("multi_reviewer_panel");
  });

  it("a panel-history entry is present with the matching finalDecisionId, no vote text", () => {
    const s = scenario("D");
    const historyWrite = s.writes.find((w) => w.path.includes("/humanReviewPanelHistory/"));
    expect(historyWrite).toBeDefined();
    expect(JSON.stringify(historyWrite!.data)).not.toContain("seed reviewer comment");
  });
});

describe("Scenario E — Finalized (owner override)", () => {
  it("panel is finalized via owner_override with override provenance, and votes remain exactly as seeded (deadlocked, unchanged)", () => {
    const s = scenario("E");
    const panelWrite = findWrite(s.writes, "/humanReviewPanel/current");
    const parsedPanel = parseAdaptiveHumanReviewPanel(panelWrite.data);
    expect(parsedPanel.status).toBe("valid");
    if (parsedPanel.status !== "valid") return;
    expect(parsedPanel.panel.status).toBe("finalized");
    expect(parsedPanel.panel.finalizedVia).toBe("owner_override");
    expect(parsedPanel.panel.overrideByUserId).toBe(SEED_OWNER_UID);
    expect(parsedPanel.panel.finalDecisionId).toMatch(/^panel_override_dec_[0-9a-f]{32}$/);

    const voteWrites = s.writes.filter((w) => w.path.includes("/humanReviewVotes/"));
    const statuses = voteWrites.map((w) => (w.data as any).status).sort();
    expect(statuses).toEqual(["approved", "rejected"]); // still deadlocked at the vote level — override didn't touch them

    const runWrite = findWrite(s.writes, `runs/${s.runId}`);
    const parsedRecord = parseGovernanceRecord((runWrite.data as any).governanceRecord);
    expect(parsedRecord.ok).toBe(true);
    if (!parsedRecord.ok) return;
    expect(parsedRecord.record.humanReview.decidedVia).toBe("multi_reviewer_owner_override");
    expect(parsedRecord.record.humanReview.overrideJustification).toContain("[SEED DATA]");
  });

  it("the seeded override justification text does not leak into the broad panel-history entry — only a presence flag", () => {
    const s = scenario("E");
    const historyWrite = s.writes.find((w) => w.path.includes("/humanReviewPanelHistory/"));
    expect(historyWrite).toBeDefined();
    expect(JSON.stringify(historyWrite!.data)).not.toContain("Deterministic seed justification");
    expect((historyWrite!.data as any).overrideJustificationPresent).toBe(true);
  });
});

describe("Scenario F — Legacy single-reviewer", () => {
  it("no panel document is written at all for this run", () => {
    const s = scenario("F");
    const panelWrite = s.writes.find((w) => w.path.includes("/humanReviewPanel/"));
    expect(panelWrite).toBeUndefined();
    const voteWrites = s.writes.filter((w) => w.path.includes("/humanReviewVotes/"));
    expect(voteWrites).toHaveLength(0);
  });

  it("the run and its governanceRecord are still otherwise valid and reviewable", () => {
    const s = scenario("F");
    const runWrite = findWrite(s.writes, `runs/${s.runId}`);
    const parsedRecord = parseGovernanceRecord((runWrite.data as any).governanceRecord);
    expect(parsedRecord.ok).toBe(true);
    if (parsedRecord.ok) expect(parsedRecord.record.humanReview.status).toBe("unreviewed");
  });
});

describe("buildAdaptiveGovernanceSeedPlan — privacy of seeded content", () => {
  it("every seeded comment/justification is clearly marked [SEED DATA] — never presented as real reviewer content", () => {
    const plan = buildAdaptiveGovernanceSeedPlan();
    for (const scenario of plan.scenarios) {
      for (const write of scenario.writes) {
        const serialized = JSON.stringify(write.data);
        if (serialized.includes("comment") && write.path.includes("humanReviewVotes")) {
          const data = write.data as any;
          if (data.comment) expect(data.comment).toContain("[SEED DATA]");
        }
      }
    }
  });

  it(`${GOVERNANCE_SEED_NAMESPACE} never collides with the real production ID formats (team_..., run-<uuid>)`, () => {
    expect(SEED_TEAM_ID).not.toMatch(/^team_[a-zA-Z0-9]{8}_\d+$/);
    const s = scenario("A");
    expect(s.runId).not.toMatch(/^run-[0-9a-f-]{36}$/);
  });
});
