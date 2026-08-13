/**
 * Existing-User Personal Workspace Provisioning, Phase 2B —
 * classifyUserEligibility() / parseExclusionList() tests.
 */

import { classifyUserEligibility, parseExclusionList } from "@/lib/workspaces/provisioningEligibility";

describe("classifyUserEligibility", () => {
  it("grants a normal, enabled, non-excluded user", () => {
    const result = classifyUserEligibility({ uid: "uid-1", disabled: false }, new Set());
    expect(result).toEqual({ eligible: true });
  });

  it("excludes a disabled Auth user", () => {
    const result = classifyUserEligibility({ uid: "uid-1", disabled: true }, new Set());
    expect(result).toEqual({ eligible: false, reason: "excluded_disabled" });
  });

  it("excludes a uid present in the operator-supplied exclusion set", () => {
    const result = classifyUserEligibility({ uid: "uid-1", disabled: false }, new Set(["uid-1"]));
    expect(result).toEqual({ eligible: false, reason: "excluded_explicit" });
  });

  it("disabled takes precedence when a uid is both disabled AND explicitly excluded", () => {
    const result = classifyUserEligibility({ uid: "uid-1", disabled: true }, new Set(["uid-1"]));
    expect(result).toEqual({ eligible: false, reason: "excluded_disabled" });
  });

  it("does not exclude a uid absent from the exclusion set", () => {
    const result = classifyUserEligibility({ uid: "uid-1", disabled: false }, new Set(["uid-2", "uid-3"]));
    expect(result).toEqual({ eligible: true });
  });
});

describe("parseExclusionList", () => {
  it("parses one uid per line", () => {
    expect(parseExclusionList("uid-1\nuid-2\nuid-3")).toEqual(new Set(["uid-1", "uid-2", "uid-3"]));
  });

  it("ignores blank lines", () => {
    expect(parseExclusionList("uid-1\n\n\nuid-2\n")).toEqual(new Set(["uid-1", "uid-2"]));
  });

  it("ignores comment lines starting with #", () => {
    expect(parseExclusionList("# service accounts\nuid-1\n# more\nuid-2")).toEqual(new Set(["uid-1", "uid-2"]));
  });

  it("trims whitespace around each uid", () => {
    expect(parseExclusionList("  uid-1  \n\tuid-2\t")).toEqual(new Set(["uid-1", "uid-2"]));
  });

  it("returns an empty set for empty input", () => {
    expect(parseExclusionList("")).toEqual(new Set());
  });
});
