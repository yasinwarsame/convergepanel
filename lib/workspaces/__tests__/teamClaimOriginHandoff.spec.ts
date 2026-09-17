/**
 * TEAM-VERIFICATION-PARITY-R4-I4 §AI/§AJ — the research→claim handoff address
 * and its query classifier.
 *
 * The whole security value of this module is negative: the handoff may carry
 * ONLY the two locators, and a malformed one must never silently become an
 * ordinary free-text claim form.
 */

import {
  teamClaimOriginHandoffHref,
  parseTeamClaimOriginQuery,
  ORIGIN_RUN_ID_PARAM,
  ORIGIN_CLAIM_ID_PARAM,
} from "@/lib/workspaces/teamClaimOriginHandoff";

const W = "ws-1";
const RUN = "run-9";
const CLAIM_ID = "v1:key_findings:0:abcDEF123";

describe("teamClaimOriginHandoffHref", () => {
  it("always targets the Workspace-level creation route", () => {
    expect(teamClaimOriginHandoffHref({ workspaceId: W, runId: RUN, claimId: "c1" })).toBe(
      "/workspace/team/ws-1/claims/new?originRunId=run-9&originClaimId=c1"
    );
  });

  it("uses the Workspace route even when the source research is Project-filed", () => {
    // The browser is not authoritative for the Project binding; the run may
    // have moved since this link was made.
    const href = teamClaimOriginHandoffHref({ workspaceId: W, runId: RUN, claimId: "c1" });
    expect(href).not.toContain("/projects/");
    expect(href.startsWith("/workspace/team/ws-1/claims/new?")).toBe(true);
  });

  it("carries exactly the two locator parameters and nothing else", () => {
    const href = teamClaimOriginHandoffHref({ workspaceId: W, runId: RUN, claimId: CLAIM_ID });
    const query = new URLSearchParams(href.split("?")[1]);
    expect([...query.keys()].sort()).toEqual([ORIGIN_CLAIM_ID_PARAM, ORIGIN_RUN_ID_PARAM].sort());
    expect(query.get(ORIGIN_RUN_ID_PARAM)).toBe(RUN);
    expect(query.get(ORIGIN_CLAIM_ID_PARAM)).toBe(CLAIM_ID);
  });

  it("never carries claim text, a Project id, an origin object or a return URL", () => {
    const href = teamClaimOriginHandoffHref({ workspaceId: W, runId: RUN, claimId: CLAIM_ID });
    for (const forbidden of ["claim=", "claimText", "summary", "title", "projectId", "origin=", "returnTo", "uid", "role"]) {
      expect(href).not.toContain(forbidden);
    }
  });

  it("encodes the Workspace path segment and both query values exactly once", () => {
    const href = teamClaimOriginHandoffHref({ workspaceId: "w s/1", runId: "run 9", claimId: "v1:a:0:x/y" });
    expect(href.startsWith("/workspace/team/w%20s%2F1/claims/new?")).toBe(true);
    const query = new URLSearchParams(href.split("?")[1]);
    expect(query.get(ORIGIN_RUN_ID_PARAM)).toBe("run 9");
    expect(query.get(ORIGIN_CLAIM_ID_PARAM)).toBe("v1:a:0:x/y");
  });

  it("cannot be steered outside the addressed Workspace", () => {
    const href = teamClaimOriginHandoffHref({ workspaceId: W, runId: "../../admin", claimId: "c" });
    expect(href.startsWith("/workspace/team/ws-1/claims/new?")).toBe(true);
    expect(href).not.toContain("/admin/");
  });
});

describe("parseTeamClaimOriginQuery", () => {
  it("classifies an absent pair as ordinary creation", () => {
    expect(parseTeamClaimOriginQuery({})).toEqual({ kind: "ordinary" });
    expect(parseTeamClaimOriginQuery(undefined)).toEqual({ kind: "ordinary" });
    expect(parseTeamClaimOriginQuery({ other: "x" })).toEqual({ kind: "ordinary" });
  });

  it("classifies a complete pair as an origin handoff", () => {
    expect(parseTeamClaimOriginQuery({ originRunId: RUN, originClaimId: CLAIM_ID })).toEqual({
      kind: "origin",
      target: { runId: RUN, claimId: CLAIM_ID },
    });
  });

  it.each([
    ["runId without claimId", { originRunId: RUN }],
    ["claimId without runId", { originClaimId: CLAIM_ID }],
    ["empty runId", { originRunId: "", originClaimId: CLAIM_ID }],
    ["empty claimId", { originRunId: RUN, originClaimId: "" }],
    ["both empty", { originRunId: "", originClaimId: "" }],
    ["repeated runId", { originRunId: [RUN, "run-other"], originClaimId: CLAIM_ID }],
    ["repeated claimId", { originRunId: RUN, originClaimId: [CLAIM_ID, "other"] }],
    ["both repeated", { originRunId: [RUN], originClaimId: [CLAIM_ID] }],
  ])("classifies %s as INVALID, never as ordinary", (_label, query) => {
    // A broken research handoff must not quietly become a free-text claim form.
    expect(parseTeamClaimOriginQuery(query as Record<string, string | string[] | undefined>)).toEqual({ kind: "invalid" });
  });

  it("round-trips a built href through the parser", () => {
    const href = teamClaimOriginHandoffHref({ workspaceId: W, runId: RUN, claimId: CLAIM_ID });
    const query = new URLSearchParams(href.split("?")[1]);
    expect(parseTeamClaimOriginQuery({ originRunId: query.get(ORIGIN_RUN_ID_PARAM)!, originClaimId: query.get(ORIGIN_CLAIM_ID_PARAM)! })).toEqual({
      kind: "origin",
      target: { runId: RUN, claimId: CLAIM_ID },
    });
  });
});
