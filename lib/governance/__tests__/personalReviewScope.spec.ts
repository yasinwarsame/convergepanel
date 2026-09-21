/**
 * PHASE 1 — truth table for the Personal/Team review scope boundary.
 *
 * Every predicate here must be an ALLOW-LIST. The first version of
 * `viewerMayReadReviewPanel` was `role !== "personal_reviewer"`, which
 * returned "may read the panel" for `"unauthorized"` — a value inside its own
 * declared parameter type — and would have silently admitted every role added
 * to `AdaptiveRunAccessRole` later. These tests pin the inverse property: an
 * unrecognised scope value is DENIED, not defaulted open.
 */

import {
  viewerMayReadReviewPanel,
  viewerMayReadDecisionProvenance,
  viewerMayReadDecisionReviewerIdentity,
  historyRowIsInPersonalReviewScope,
  classifyCanonicalDecisionScope,
} from "@/lib/governance/personalReviewScope";

describe("viewerMayReadReviewPanel — allow-list", () => {
  it.each([
    ["owner", true],
    ["personal_reviewer", false],
    ["unauthorized", false],
  ])("%s -> %s", (role, expected) => {
    expect(viewerMayReadReviewPanel(role as never)).toBe(expected);
  });

  it.each([undefined, null, "", "personalReviewer", "team_member", "workspace_member", "admin"])(
    "denies the unrecognised value %p rather than defaulting open",
    (role) => {
      expect(viewerMayReadReviewPanel(role as never)).toBe(false);
    }
  );
});

describe("viewerMayReadDecisionProvenance — allow-list", () => {
  it.each([
    ["owner", true],
    ["team_member", true],
    ["team_reviewer", true],
    ["personal_reviewer", false],
    ["unauthorized", false],
  ])("%s -> %s", (role, expected) => {
    expect(viewerMayReadDecisionProvenance(role as never)).toBe(expected);
  });

  it.each([undefined, null, "", "owner ", "OWNER", "future_role"])("denies %p", (role) => {
    expect(viewerMayReadDecisionProvenance(role as never)).toBe(false);
  });
});

describe("historyRowIsInPersonalReviewScope — allow-list on the persisted discriminator", () => {
  it("admits only an OWN `teamId` property that is exactly null", () => {
    expect(historyRowIsInPersonalReviewScope({ teamId: null })).toBe(true);
  });

  it.each([
    ["absent key", {}],
    ["undefined value", { teamId: undefined }],
    ["empty string", { teamId: "" }],
    ["real team", { teamId: "team-1" }],
    ["the string null", { teamId: "null" }],
    ["zero", { teamId: 0 }],
    ["false", { teamId: false }],
    ["array host", []],
    ["raw null", null],
    ["raw string", "teamId"],
  ])("excludes %s", (_label, raw) => {
    expect(historyRowIsInPersonalReviewScope(raw)).toBe(false);
  });

  it("excludes a PROTOTYPE-INHERITED teamId — own-property only", () => {
    const row = Object.create({ teamId: null });
    expect("teamId" in row).toBe(true); // the weaker `in` check would admit it
    expect(historyRowIsInPersonalReviewScope(row)).toBe(false);
  });
});

describe("classifyCanonicalDecisionScope", () => {
  const base = { reviewerId: "r1", reviewedAt: "2026-08-03T00:00:00.000Z", status: "approved" };
  const row = (over: Record<string, unknown> = {}) => ({
    reviewerId: "r1",
    reviewedAt: "2026-08-03T00:00:00.000Z",
    newStatus: "approved",
    teamId: null,
    ...over,
  });

  it("a matching personal row proves personal scope", () => {
    expect(classifyCanonicalDecisionScope({ ...base, decidedVia: "single_reviewer", historyRows: [row()] })).toBe("personal");
  });

  it("a matching TEAM row proves team scope", () => {
    expect(classifyCanonicalDecisionScope({ ...base, decidedVia: "single_reviewer", historyRows: [row({ teamId: "team-1" })] })).toBe("team");
  });

  it.each(["multi_reviewer_panel", "multi_reviewer_owner_override"])(
    "%s is team-scoped by definition, with no lookup and regardless of rows",
    (decidedVia) => {
      expect(classifyCanonicalDecisionScope({ ...base, decidedVia, historyRows: [row()] })).toBe("team");
    }
  );

  it.each([
    ["no rows at all", []],
    ["a row for a different reviewer", [row({ reviewerId: "other" })]],
    ["a row at a different timestamp", [row({ reviewedAt: "2026-01-01T00:00:00.000Z" })]],
    ["a row with a different terminal status", [row({ newStatus: "rejected" })]],
    ["TWO rows matching the same decision", [row(), row()]],
    ["a matching row whose teamId key is absent", [{ reviewerId: "r1", reviewedAt: "2026-08-03T00:00:00.000Z", newStatus: "approved" }]],
  ])("returns unknown (a denial) for %s", (_label, rows) => {
    expect(classifyCanonicalDecisionScope({ ...base, decidedVia: "single_reviewer", historyRows: rows as unknown[] })).toBe("unknown");
  });

  it.each([
    ["a missing reviewerId", { reviewerId: undefined }],
    ["a blank reviewerId", { reviewerId: "" }],
    ["a missing reviewedAt", { reviewedAt: undefined }],
  ])("returns unknown for %s", (_label, over) => {
    expect(classifyCanonicalDecisionScope({ ...base, ...over, decidedVia: undefined, historyRows: [row()] })).toBe("unknown");
  });
});

describe("viewerMayReadDecisionReviewerIdentity", () => {
  const VIEWER = "viewer-uid";

  it("the owner always may", () => {
    expect(viewerMayReadDecisionReviewerIdentity({ role: "owner", scope: "unknown", viewerUid: VIEWER, reviewerId: "anyone" })).toBe(true);
  });

  it("a personal reviewer may read THEIR OWN decision even when provenance is unprovable", () => {
    expect(viewerMayReadDecisionReviewerIdentity({ role: "personal_reviewer", scope: "unknown", viewerUid: VIEWER, reviewerId: VIEWER })).toBe(true);
  });

  it("a personal reviewer may read a decision proven personal", () => {
    expect(viewerMayReadDecisionReviewerIdentity({ role: "personal_reviewer", scope: "personal", viewerUid: VIEWER, reviewerId: "prev-personal" })).toBe(true);
  });

  it.each([
    ["team-scoped", "team"],
    ["unprovable", "unknown"],
  ])("a personal reviewer may NOT read a %s decision by someone else", (_label, scope) => {
    expect(
      viewerMayReadDecisionReviewerIdentity({ role: "personal_reviewer", scope: scope as never, viewerUid: VIEWER, reviewerId: "TEAM_ACTOR" })
    ).toBe(false);
  });

  it("an empty reviewerId never matches an empty viewer uid into a grant", () => {
    expect(viewerMayReadDecisionReviewerIdentity({ role: "personal_reviewer", scope: "unknown", viewerUid: "", reviewerId: "" })).toBe(false);
  });

  it.each(["unauthorized", "team_member", undefined])("denies role %p", (role) => {
    expect(viewerMayReadDecisionReviewerIdentity({ role: role as never, scope: "personal", viewerUid: VIEWER, reviewerId: VIEWER })).toBe(false);
  });
});
