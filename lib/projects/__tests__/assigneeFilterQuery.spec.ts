import { parseAssigneeFilterQuery } from "../assigneeFilterQuery";

describe("parseAssigneeFilterQuery", () => {
  it("absent ⇒ no filter; `me` ⇒ me", () => {
    expect(parseAssigneeFilterQuery(new URLSearchParams(""))).toEqual({ ok: true, filter: null });
    expect(parseAssigneeFilterQuery(new URLSearchParams("assignee=me"))).toEqual({ ok: true, filter: "me" });
  });
  it("a caller-supplied uid is NEVER accepted as a filter value (no enumeration by uid)", () => {
    expect(parseAssigneeFilterQuery(new URLSearchParams("assignee=some-other-uid"))).toEqual({ ok: false, reason: "invalid_value" });
    expect(parseAssigneeFilterQuery(new URLSearchParams("assignee="))).toEqual({ ok: false, reason: "invalid_value" });
  });
  it("duplicates are rejected as ambiguous", () => {
    expect(parseAssigneeFilterQuery(new URLSearchParams("assignee=me&assignee=me"))).toEqual({ ok: false, reason: "duplicate" });
  });
});
