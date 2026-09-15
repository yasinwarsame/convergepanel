/** Project/Research Assignment (D4) — `?assignee=me` resolution against the caller's OWN current eligibility. */
import { resolveAssigneeFilterForCaller } from "../assigneeFilterResolution";
import { capabilitiesForRole } from "../capabilities";

describe("resolveAssigneeFilterForCaller", () => {
  it("no filter ⇒ none, regardless of capability", () => {
    expect(resolveAssigneeFilterForCaller({ filter: null, uid: "u", capabilities: [], target: "run" })).toEqual({ kind: "none" });
  });
  it("D4 — run view: a caller without research.create (Reviewer/Viewer) gets a definitively EMPTY view, never their stale rows", () => {
    expect(resolveAssigneeFilterForCaller({ filter: "me", uid: "u", capabilities: capabilitiesForRole("viewer"), target: "run" })).toEqual({ kind: "empty" });
    expect(resolveAssigneeFilterForCaller({ filter: "me", uid: "u", capabilities: capabilitiesForRole("reviewer"), target: "run" })).toEqual({ kind: "empty" });
  });
  it("positive control — run view: a Member (holds research.create) filters by their OWN uid", () => {
    expect(resolveAssigneeFilterForCaller({ filter: "me", uid: "u", capabilities: capabilitiesForRole("member"), target: "run" })).toEqual({ kind: "uid", uid: "u" });
  });
  it("Project view: every active caller filters by their own uid (any active member is an eligible Project assignee)", () => {
    expect(resolveAssigneeFilterForCaller({ filter: "me", uid: "u", capabilities: capabilitiesForRole("viewer"), target: "project" })).toEqual({ kind: "uid", uid: "u" });
  });
});
