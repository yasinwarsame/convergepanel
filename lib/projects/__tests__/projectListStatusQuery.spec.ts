import { parseProjectListStatusQuery } from "@/lib/projects/projectListStatusQuery";

function params(pairs: Array<[string, string]>): URLSearchParams {
  const sp = new URLSearchParams();
  for (const [k, v] of pairs) sp.append(k, v);
  return sp;
}

describe("parseProjectListStatusQuery", () => {
  it("status omitted -> active", () => {
    expect(parseProjectListStatusQuery(params([]))).toEqual({ ok: true, status: "active" });
  });

  it("status=active -> active", () => {
    expect(parseProjectListStatusQuery(params([["status", "active"]]))).toEqual({ ok: true, status: "active" });
  });

  it("status=archived -> archived", () => {
    expect(parseProjectListStatusQuery(params([["status", "archived"]]))).toEqual({ ok: true, status: "archived" });
  });

  it("status=all -> rejected, never coerced to active", () => {
    expect(parseProjectListStatusQuery(params([["status", "all"]]))).toEqual({ ok: false, reason: "invalid_value" });
  });

  it("status=garbage -> rejected", () => {
    expect(parseProjectListStatusQuery(params([["status", "garbage"]]))).toEqual({ ok: false, reason: "invalid_value" });
  });

  it("status=deleted -> rejected", () => {
    expect(parseProjectListStatusQuery(params([["status", "deleted"]]))).toEqual({ ok: false, reason: "invalid_value" });
  });

  it("status= (present, empty) -> rejected as an explicit invalid value, distinguishable from omission", () => {
    expect(parseProjectListStatusQuery(params([["status", ""]]))).toEqual({ ok: false, reason: "invalid_value" });
  });

  it("duplicate status parameters -> rejected as ambiguous, never first-or-last-wins", () => {
    expect(parseProjectListStatusQuery(params([["status", "active"], ["status", "archived"]]))).toEqual({ ok: false, reason: "duplicate" });
  });

  it("duplicate status parameters with the SAME value are still rejected — ambiguity is about the parameter shape, not whether the values happen to agree", () => {
    expect(parseProjectListStatusQuery(params([["status", "active"], ["status", "active"]]))).toEqual({ ok: false, reason: "duplicate" });
  });

  it("status is case-sensitive — 'Active'/'ARCHIVED' are rejected, never normalized", () => {
    expect(parseProjectListStatusQuery(params([["status", "Active"]]))).toEqual({ ok: false, reason: "invalid_value" });
    expect(parseProjectListStatusQuery(params([["status", "ARCHIVED"]]))).toEqual({ ok: false, reason: "invalid_value" });
  });
});
