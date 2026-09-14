/**
 * Project/Research Assignment — the shared pure normalization module. Each
 * "bounded" claim is proven by the ORDER of the checks (shape → dedupe →
 * cap-on-unique) with a positive control on the same fixture.
 */

import { canonicalizeAssigneeUids, normalizeStoredAssigneeUids, normalizeStoredAssigneeUid, assigneeUidsEqual, diffAssigneeUids, isValidAssigneeUidShape, MAX_PROJECT_ASSIGNEES } from "../assignmentNormalization";

const uid = (n: number) => `user-${String(n).padStart(3, "0")}`;

describe("canonicalizeAssigneeUids — request side, zero I/O", () => {
  it("dedupes, sorts by code unit, and accepts ≤ 20 unique", () => {
    const r = canonicalizeAssigneeUids(["b-uid", "a-uid", "b-uid", "c-uid"]);
    expect(r).toEqual({ ok: true, uids: ["a-uid", "b-uid", "c-uid"] });
  });

  it("BOUNDED READS PRECONDITION — 1,000 entries collapsing to ≤ 20 unique is VALID (cap applies to the UNIQUE count)", () => {
    const raw = Array.from({ length: 1000 }, (_, i) => uid(i % 5));
    const r = canonicalizeAssigneeUids(raw);
    expect(r).toEqual({ ok: true, uids: [uid(0), uid(1), uid(2), uid(3), uid(4)] });
  });

  it("BOUNDED READS PRECONDITION — 1,000 entries with > 20 unique is too_many_assignees (positive control: exactly 20 unique passes)", () => {
    const raw21 = Array.from({ length: 1000 }, (_, i) => uid(i % 21));
    expect(canonicalizeAssigneeUids(raw21)).toEqual({ ok: false, reason: "too_many_assignees" });
    const raw20 = Array.from({ length: 1000 }, (_, i) => uid(i % 20));
    const ok = canonicalizeAssigneeUids(raw20);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.uids).toHaveLength(MAX_PROJECT_ASSIGNEES);
  });

  it.each([[null], ["not-an-array"], [[""]], [[" padded"]], [[42]], [[{ uid: "x" }]], [["ok", null]]])("rejects malformed shape %p as invalid_shape", (input) => {
    expect(canonicalizeAssigneeUids(input)).toEqual({ ok: false, reason: "invalid_shape" });
  });

  it("an empty array is valid (clears all assignees)", () => {
    expect(canonicalizeAssigneeUids([])).toEqual({ ok: true, uids: [] });
  });
});

describe("normalizeStoredAssigneeUids — stored side", () => {
  it("absent ⇒ [] not malformed; valid ⇒ canonical, not malformed even if unsorted/duplicated", () => {
    expect(normalizeStoredAssigneeUids(undefined)).toEqual({ uids: [], malformed: false });
    expect(normalizeStoredAssigneeUids(["z", "a", "z"])).toEqual({ uids: ["a", "z"], malformed: false });
  });

  it.each([["x"], [null], [42], [[1]], [[""]], [{}]])("malformed stored value %p ⇒ [] with malformed: true (never thrown, never passed through)", (raw) => {
    expect(normalizeStoredAssigneeUids(raw)).toEqual({ uids: [], malformed: true });
  });
});

describe("normalizeStoredAssigneeUid — stored side, single", () => {
  it("absent/null ⇒ null; valid ⇒ value", () => {
    expect(normalizeStoredAssigneeUid(undefined)).toEqual({ uid: null, malformed: false });
    expect(normalizeStoredAssigneeUid(null)).toEqual({ uid: null, malformed: false });
    expect(normalizeStoredAssigneeUid("user-1")).toEqual({ uid: "user-1", malformed: false });
  });

  it.each([[42], [""], [" x"], [{}], [[]], [true]])("malformed %p ⇒ null with malformed: true", (raw) => {
    expect(normalizeStoredAssigneeUid(raw)).toEqual({ uid: null, malformed: true });
  });
});

describe("helpers", () => {
  it("isValidAssigneeUidShape is the repository uid-shape rule", () => {
    expect(isValidAssigneeUidShape("user-1")).toBe(true);
    expect(isValidAssigneeUidShape("")).toBe(false);
    expect(isValidAssigneeUidShape(" a")).toBe(false);
    expect(isValidAssigneeUidShape(1)).toBe(false);
  });
  it("assigneeUidsEqual compares canonical lists; diff records both directions", () => {
    expect(assigneeUidsEqual(["a", "b"], ["a", "b"])).toBe(true);
    expect(assigneeUidsEqual(["a"], ["a", "b"])).toBe(false);
    expect(diffAssigneeUids(["a", "b"], ["b", "c"])).toEqual({ addedUids: ["c"], removedUids: ["a"] });
  });
});
