/**
 * PERSONAL-RESEARCH-URL-1 §C/§D/§AQ — the canonical address builder.
 * Fully real: no mocks, no transcription.
 */

import { personalResearchHref, isCanonicalPersonalRunId } from "@/lib/user/personalResearchHref";

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
