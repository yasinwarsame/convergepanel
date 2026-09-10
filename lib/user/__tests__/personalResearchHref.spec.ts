/**
 * PERSONAL-RESEARCH-URL-1 §C/§D/§AQ — the canonical address builder.
 * Fully real: no mocks, no transcription.
 */

import {
  personalResearchHref,
  isCanonicalPersonalRunId,
  personalResearchVerifyClaimHref,
  personalResearchFollowUpHref,
} from "@/lib/user/personalResearchHref";

describe("personalResearchHref", () => {
  it("builds the frozen canonical shape", () => {
    expect(personalResearchHref("run-1")).toBe("/workspace/research/run-1");
  });

  it("§C — percent-encodes slashes, percents, spaces and unicode, so no id can escape the route segment", () => {
    expect(personalResearchHref("a/b")).toBe("/workspace/research/a%2Fb");
    expect(personalResearchHref("100%")).toBe("/workspace/research/100%25");
    expect(personalResearchHref("run with spaces & stuff")).toBe("/workspace/research/run%20with%20spaces%20%26%20stuff");
    expect(personalResearchHref("rün-é")).toBe("/workspace/research/r%C3%BCn-%C3%A9");
    expect(personalResearchHref("a/b")).not.toContain("a/b");
    // a traversal attempt stays one segment
    expect(personalResearchHref("../../admin")).toBe("/workspace/research/..%2F..%2Fadmin");
  });

  it("§C — carries no query string, no Workspace id and no title slug", () => {
    const href = personalResearchHref("run-1");
    expect(href).not.toContain("?");
    expect(href).not.toContain("openResearchRun");
    expect(href.split("/").filter(Boolean)).toEqual(["workspace", "research", "run-1"]);
  });

  it("§D/§AQ — IDENTITY IS THE RUN ID: the same run yields the same address regardless of Project association", () => {
    // Project association is mutable (assign/move/remove). The builder takes no
    // projectId at all, so reassociation cannot change a saved report's address —
    // which is what lets a future Add-to-Team promotion name a stable source.
    const unfiled = personalResearchHref("run-7");
    const inProjectA = personalResearchHref("run-7");
    const inProjectB = personalResearchHref("run-7");
    expect(unfiled).toBe(inProjectA);
    expect(inProjectA).toBe(inProjectB);
    expect(personalResearchHref.length).toBe(1); // arity: runId only
  });
});

describe("isCanonicalPersonalRunId", () => {
  it("accepts a real server-issued id", () => {
    expect(isCanonicalPersonalRunId("abc123")).toBe(true);
    expect(isCanonicalPersonalRunId("run-7")).toBe(true);
  });

  it("§F — REJECTS the optimistic `r-${Date.now()}` placeholder, which would mint a permanently dead URL", () => {
    expect(isCanonicalPersonalRunId(`r-${Date.now()}`)).toBe(false);
    expect(isCanonicalPersonalRunId("r-1789059999999")).toBe(false);
    // but a real id that merely starts with r- is fine
    expect(isCanonicalPersonalRunId("r-abc")).toBe(true);
  });

  it("rejects blank, whitespace and non-strings", () => {
    for (const bad of ["", "   ", null, undefined, 0, {}, []]) {
      expect(isCanonicalPersonalRunId(bad as unknown)).toBe(false);
    }
  });
});

/**
 * PERSONAL-RESEARCH-URL-1-C1 §K/§P — THE ORIGIN-LINKED HAND-OFF CONTRACT.
 *
 * A URL is visible, editable and shareable, so what travels in it must be
 * something the server re-validates from scratch. These builders may carry
 * SELECTORS only: the run id and the server-issued claim id, nothing else.
 */
describe("personalResearchVerifyClaimHref — selectors only (C1 §K)", () => {
  it("carries exactly tab, originRunId and originClaimId", () => {
    const href = personalResearchVerifyClaimHref({ runId: "run-A", claimId: "claim-B" });
    expect(href).toBe("/?tab=verify&originRunId=run-A&originClaimId=claim-B");
    const params = new URLSearchParams(href!.slice(href!.indexOf("?") + 1));
    expect([...params.keys()].sort()).toEqual(["originClaimId", "originRunId", "tab"]);
    expect(params.get("tab")).toBe("verify");
    expect(params.get("originRunId")).toBe("run-A");
    expect(params.get("originClaimId")).toBe("claim-B");
  });

  it("carries NO claim text, project, workspace or uid, whatever is passed alongside", () => {
    const href = personalResearchVerifyClaimHref({
      runId: "run-A",
      claimId: "claim-B",
      // deliberately passed: extra properties must be structurally impossible to emit
      ...({ claimText: "Remote work reduces productivity", projectId: "proj-1", workspaceId: "ws-1", uid: "uid-1" } as never),
    });
    expect(href).toBe("/?tab=verify&originRunId=run-A&originClaimId=claim-B");
    for (const leak of ["Remote work", "claimText", "proj-1", "projectId", "ws-1", "workspaceId", "uid-1"]) {
      expect(href).not.toContain(leak);
    }
  });

  it("percent-encodes both selectors so neither can inject another parameter", () => {
    const href = personalResearchVerifyClaimHref({
      runId: "run A&tab=research",
      claimId: "v1:findings:0:a/b+c",
    });
    const q = new URLSearchParams(href!.slice(href!.indexOf("?") + 1));
    expect(q.get("originRunId")).toBe("run A&tab=research");
    expect(q.get("originClaimId")).toBe("v1:findings:0:a/b+c");
    // one tab parameter, still "verify": the injected one did not survive encoding
    expect(q.getAll("tab")).toEqual(["verify"]);
  });

  it.each([
    ["both blank", "", ""],
    ["blank claimId", "run-A", ""],
    ["whitespace claimId", "run-A", "   "],
    ["blank runId", "", "claim-B"],
    ["whitespace runId", "  ", "claim-B"],
  ])("returns null for %s — half a selector pair is NO target, not a weaker one", (_l, runId, claimId) => {
    expect(personalResearchVerifyClaimHref({ runId, claimId })).toBeNull();
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a number", 7],
    ["an object", { id: "x" }],
  ])("returns null when a selector is %s", (_l, bad) => {
    expect(personalResearchVerifyClaimHref({ runId: bad, claimId: "claim-B" })).toBeNull();
    expect(personalResearchVerifyClaimHref({ runId: "run-A", claimId: bad })).toBeNull();
  });

  it("trims the selectors rather than emitting padded ids", () => {
    expect(personalResearchVerifyClaimHref({ runId: " run-A ", claimId: " claim-B " }))
      .toBe("/?tab=verify&originRunId=run-A&originClaimId=claim-B");
  });
});

describe("personalResearchFollowUpHref — pre-fill only (C1 §R)", () => {
  it("uses the existing root composer contract", () => {
    expect(personalResearchFollowUpHref("What did the replication find?"))
      .toBe("/?tab=research&q=What%20did%20the%20replication%20find%3F");
  });

  it("encodes a question containing a bare percent, an ampersand and a hash", () => {
    const href = personalResearchFollowUpHref("50% of cases & #1 driver?")!;
    const q = new URLSearchParams(href.slice(href.indexOf("?") + 1));
    expect(q.get("q")).toBe("50% of cases & #1 driver?");
    expect(q.get("tab")).toBe("research");
    expect([...q.keys()].sort()).toEqual(["q", "tab"]);
  });

  it.each([["empty", ""], ["whitespace", "   "], ["null", null], ["a number", 5]])(
    "returns null for %s",
    (_l, bad) => {
      expect(personalResearchFollowUpHref(bad)).toBeNull();
    }
  );
});
