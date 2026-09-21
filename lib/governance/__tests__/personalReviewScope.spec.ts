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

import { buildPersonalReviewDecisionId, buildAdaptiveReviewDecisionId, buildWorkspaceReviewDecisionId } from "@/lib/governance/adaptiveHumanReviewHistory";
import {
  viewerMayReadReviewPanel,
  viewerMayReadDecisionProvenance,
  viewerMayReadDecisionReviewerIdentity,
  historyRowIsInPersonalReviewScope,
  expectedPersonalDecisionId,
  classifyDecisionScopeFromPersonalDoc,
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

describe("expectedPersonalDecisionId — the exact, derivable linkage", () => {
  it("reconstructs the id the Personal decision route writes under", () => {
    const id = expectedPersonalDecisionId({ runId: "run-1", reviewedAt: "2026-08-03T00:00:00.000Z", status: "approved" });
    expect(id).toBe(buildPersonalReviewDecisionId("run-1", "2026-08-03T00:00:00.000Z", "approved"));
  });

  it("is NAMESPACE-SEPARATED from the Team and Workspace forms for identical material", () => {
    const personal = expectedPersonalDecisionId({ runId: "run-1", reviewedAt: "2026-08-03T00:00:00.000Z", status: "approved" });
    const team = buildAdaptiveReviewDecisionId("team-1", "run-1", "2026-08-03T00:00:00.000Z", "approved");
    const workspace = buildWorkspaceReviewDecisionId("ws-1", "run-1", "2026-08-03T00:00:00.000Z", "approved");
    expect(new Set([personal, team, workspace]).size).toBe(3);
  });

  it.each([
    ["blank runId", { runId: "  ", reviewedAt: "2026-08-03T00:00:00.000Z", status: "approved" }],
    ["missing reviewedAt", { runId: "run-1", reviewedAt: undefined, status: "approved" }],
    ["blank reviewedAt", { runId: "run-1", reviewedAt: "", status: "approved" }],
    ["missing status", { runId: "run-1", reviewedAt: "2026-08-03T00:00:00.000Z", status: undefined }],
  ])("returns null (never throws) for %s", (_label, args) => {
    expect(expectedPersonalDecisionId(args as never)).toBeNull();
  });
});

describe("classifyDecisionScopeFromPersonalDoc — authority truth table", () => {
  const base = { reviewerId: "r1", reviewedAt: "2026-08-03T00:00:00.000Z", status: "approved", decidedVia: "single_reviewer" as string | undefined };
  const personalRow = (over: Record<string, unknown> = {}) => ({
    exists: true,
    data: { reviewerId: "r1", reviewedAt: "2026-08-03T00:00:00.000Z", newStatus: "approved", teamId: null, ...over },
  });

  it("the personal-namespaced document, agreeing with the record, proves personal scope", () => {
    expect(classifyDecisionScopeFromPersonalDoc({ ...base, personalDoc: personalRow() })).toBe("personal");
  });

  it.each(["multi_reviewer_panel", "multi_reviewer_owner_override"])(
    "%s is team-scoped by definition — no lookup, and a present personal doc cannot override it",
    (decidedVia) => {
      expect(classifyDecisionScopeFromPersonalDoc({ ...base, decidedVia, personalDoc: personalRow() })).toBe("team");
    }
  );

  it.each([
    ["the document is absent (a Team or Workspace decision wrote a DIFFERENT id)", { exists: false, data: null }],
    ["the read failed entirely", null],
    ["the body is not an object", { exists: true, data: "nope" }],
    ["the body is an array", { exists: true, data: [] }],
    ["the body is null", { exists: true, data: null }],
  ])("returns unknown when %s", (_label, doc) => {
    expect(classifyDecisionScopeFromPersonalDoc({ ...base, personalDoc: doc as never })).toBe("unknown");
  });

  it.each([
    ["teamId is a real team", personalRow({ teamId: "team-1" })],
    ["teamId key is absent", { exists: true, data: { reviewerId: "r1", reviewedAt: "2026-08-03T00:00:00.000Z", newStatus: "approved" } }],
    ["the reviewer disagrees with the record", personalRow({ reviewerId: "someone-else" })],
    ["the timestamp disagrees with the record", personalRow({ reviewedAt: "2026-01-01T00:00:00.000Z" })],
    ["the status disagrees with the record", personalRow({ newStatus: "rejected" })],
  ])("returns unknown when %s", (_label, doc) => {
    expect(classifyDecisionScopeFromPersonalDoc({ ...base, personalDoc: doc as never })).toBe("unknown");
  });

  it("a WORKSPACE decision cannot be mislabelled personal even though it also stores teamId: null", () => {
    // The Workspace writer stores `teamId: null` exactly like the Personal
    // one — the old discriminator could not tell them apart. The namespaced
    // id can: a Workspace decision simply is not at the personal id, so the
    // point read misses.
    expect(classifyDecisionScopeFromPersonalDoc({ ...base, personalDoc: { exists: false, data: null } })).toBe("unknown");
  });

  it.each([
    ["a missing reviewerId", { reviewerId: undefined }],
    ["a blank reviewerId", { reviewerId: "" }],
    ["a missing reviewedAt", { reviewedAt: undefined }],
  ])("returns unknown for %s", (_label, over) => {
    expect(classifyDecisionScopeFromPersonalDoc({ ...base, ...over, decidedVia: undefined, personalDoc: personalRow() } as never)).toBe("unknown");
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
