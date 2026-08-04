/**
 * Immutable Adaptive Review History — decisionId + history-entry builder
 * tests.
 */

import {
  buildAdaptiveReviewDecisionId,
  buildAdaptiveHumanReviewHistoryEntry,
  isAdaptiveReviewTerminalStatus,
  isAdaptiveReviewNonTerminalStatus,
} from "@/lib/governance/adaptiveHumanReviewHistory";

describe("buildAdaptiveReviewDecisionId", () => {
  it("is deterministic — identical input produces identical output", () => {
    const a = buildAdaptiveReviewDecisionId("team-1", "run-1", "2026-07-30T00:00:00.000Z", "approved");
    const b = buildAdaptiveReviewDecisionId("team-1", "run-1", "2026-07-30T00:00:00.000Z", "approved");
    expect(a).toBe(b);
  });

  it("produces a distinct ID when runId differs", () => {
    const a = buildAdaptiveReviewDecisionId("team-1", "run-1", "2026-07-30T00:00:00.000Z", "approved");
    const b = buildAdaptiveReviewDecisionId("team-1", "run-2", "2026-07-30T00:00:00.000Z", "approved");
    expect(a).not.toBe(b);
  });

  it("produces a distinct ID when reviewedAt differs", () => {
    const a = buildAdaptiveReviewDecisionId("team-1", "run-1", "2026-07-30T00:00:00.000Z", "approved");
    const b = buildAdaptiveReviewDecisionId("team-1", "run-1", "2026-07-30T00:00:01.000Z", "approved");
    expect(a).not.toBe(b);
  });

  it("produces a distinct ID when newStatus differs", () => {
    const a = buildAdaptiveReviewDecisionId("team-1", "run-1", "2026-07-30T00:00:00.000Z", "approved");
    const b = buildAdaptiveReviewDecisionId("team-1", "run-1", "2026-07-30T00:00:00.000Z", "rejected");
    expect(a).not.toBe(b);
  });

  it("produces a distinct ID when teamId differs", () => {
    const a = buildAdaptiveReviewDecisionId("team-1", "run-1", "2026-07-30T00:00:00.000Z", "approved");
    const b = buildAdaptiveReviewDecisionId("team-2", "run-1", "2026-07-30T00:00:00.000Z", "approved");
    expect(a).not.toBe(b);
  });

  it("produces a safe Firestore document ID: no slash, no raw team/run values recoverable", () => {
    const id = buildAdaptiveReviewDecisionId("team-1", "run-1", "2026-07-30T00:00:00.000Z", "approved");
    expect(id).not.toContain("/");
    expect(id).not.toContain("team-1");
    expect(id).not.toContain("run-1");
    expect(id).toMatch(/^dec_[0-9a-f]{32}$/);
  });

  it("rejects empty components", () => {
    expect(() => buildAdaptiveReviewDecisionId("", "run-1", "2026-07-30T00:00:00.000Z", "approved")).toThrow();
    expect(() => buildAdaptiveReviewDecisionId("team-1", "", "2026-07-30T00:00:00.000Z", "approved")).toThrow();
    expect(() => buildAdaptiveReviewDecisionId("team-1", "run-1", "", "approved")).toThrow();
    expect(() => buildAdaptiveReviewDecisionId("team-1", "run-1", "2026-07-30T00:00:00.000Z", "")).toThrow();
  });
});

describe("buildAdaptiveHumanReviewHistoryEntry", () => {
  const BASE = {
    decisionId: "dec_abc123",
    runId: "run-1",
    teamId: "team-1",
    schemaId: "decision_support" as const,
    answerShape: "decision_support_view" as const,
    priorStatus: "unreviewed" as const,
    newStatus: "approved" as const,
    reviewerId: "reviewer-uid",
    reviewedAt: "2026-07-30T00:00:00.000Z",
    governanceRecordUpdatedAt: "2026-07-30T00:00:00.000Z",
    now: "2026-07-30T00:00:01.000Z",
  };

  it("builds the full metadata-only contract", () => {
    const entry = buildAdaptiveHumanReviewHistoryEntry(BASE);
    expect(entry).toEqual({
      version: 1,
      kind: "adaptive_human_review",
      historyId: "dec_abc123",
      decisionId: "dec_abc123",
      runId: "run-1",
      teamId: "team-1",
      schemaId: "decision_support",
      answerShape: "decision_support_view",
      priorStatus: "unreviewed",
      newStatus: "approved",
      reviewerId: "reviewer-uid",
      reviewedAt: "2026-07-30T00:00:00.000Z",
      governanceRecordUpdatedAt: "2026-07-30T00:00:00.000Z",
      commentPresent: false,
      conditionsCount: 0,
      createdAt: "2026-07-30T00:00:01.000Z",
    });
  });

  it("historyId always equals decisionId", () => {
    const entry = buildAdaptiveHumanReviewHistoryEntry(BASE);
    expect(entry.historyId).toBe(entry.decisionId);
  });

  it("commentPresent is true only for a non-empty, non-whitespace comment", () => {
    expect(buildAdaptiveHumanReviewHistoryEntry({ ...BASE, comment: "a real comment" }).commentPresent).toBe(true);
    expect(buildAdaptiveHumanReviewHistoryEntry({ ...BASE, comment: "   " }).commentPresent).toBe(false);
    expect(buildAdaptiveHumanReviewHistoryEntry({ ...BASE, comment: undefined }).commentPresent).toBe(false);
  });

  it("conditionsCount reflects the real array length, never the content", () => {
    const entry = buildAdaptiveHumanReviewHistoryEntry({ ...BASE, conditions: ["a", "b", "c"] });
    expect(entry.conditionsCount).toBe(3);
    expect(JSON.stringify(entry)).not.toContain('"a"');
  });

  it("never includes the raw comment or condition text anywhere in the output", () => {
    const entry = buildAdaptiveHumanReviewHistoryEntry({
      ...BASE,
      comment: "SENSITIVE COMMENT TEXT",
      conditions: ["SENSITIVE CONDITION TEXT"],
    });
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain("SENSITIVE COMMENT TEXT");
    expect(serialized).not.toContain("SENSITIVE CONDITION TEXT");
  });

  it("never includes raw question, receipt conclusion, sources, or automated-governance reasons (not accepted as inputs at all)", () => {
    const entry = buildAdaptiveHumanReviewHistoryEntry(BASE) as Record<string, unknown>;
    for (const forbidden of ["question", "conclusion", "sources", "reasons", "basis", "assumptions", "uncertainties", "limitations"]) {
      expect(entry).not.toHaveProperty(forbidden);
    }
  });
});

describe("isAdaptiveReviewTerminalStatus / isAdaptiveReviewNonTerminalStatus", () => {
  it("classifies all 4 terminal statuses correctly", () => {
    for (const s of ["approved", "approved_with_conditions", "changes_requested", "rejected"] as const) {
      expect(isAdaptiveReviewTerminalStatus(s)).toBe(true);
      expect(isAdaptiveReviewNonTerminalStatus(s)).toBe(false);
    }
  });

  it("classifies unreviewed/pending as non-terminal", () => {
    for (const s of ["unreviewed", "pending"] as const) {
      expect(isAdaptiveReviewNonTerminalStatus(s)).toBe(true);
      expect(isAdaptiveReviewTerminalStatus(s)).toBe(false);
    }
  });
});
