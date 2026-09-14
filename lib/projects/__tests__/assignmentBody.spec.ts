/** Project/Research Assignment — strict body parsers (allow-list, required keys, raw-size ceiling). */
import { parseProjectAssigneesBody, parseRunAssigneeBody, MAX_RAW_ASSIGNEE_UIDS } from "../assignmentBody";

describe("parseProjectAssigneesBody", () => {
  const TOKEN = { seconds: 1, nanoseconds: 0 };
  it("accepts exactly {assigneeUids, expectedUpdateTime}", () => {
    const r = parseProjectAssigneesBody({ assigneeUids: ["a"], expectedUpdateTime: TOKEN });
    expect(r).toEqual({ ok: true, assigneeUids: ["a"], expectedUpdateTime: TOKEN });
  });
  it("rejects an unknown field (never silently dropped)", () => {
    expect(parseProjectAssigneesBody({ assigneeUids: [], expectedUpdateTime: TOKEN, workspaceId: "x" })).toEqual({ ok: false, reason: "unknown_field" });
  });
  it.each([[{}], [{ assigneeUids: [] }], [{ expectedUpdateTime: TOKEN }], [{ assigneeUids: "a", expectedUpdateTime: TOKEN }], [null], ["str"]])("rejects %p as invalid_body", (body) => {
    expect(parseProjectAssigneesBody(body).ok).toBe(false);
  });
  it("oversized raw array is rejected BEFORE any canonicalization (convenience ceiling)", () => {
    const raw = Array.from({ length: MAX_RAW_ASSIGNEE_UIDS + 1 }, () => "a");
    expect(parseProjectAssigneesBody({ assigneeUids: raw, expectedUpdateTime: TOKEN })).toEqual({ ok: false, reason: "oversized" });
    const atCap = Array.from({ length: MAX_RAW_ASSIGNEE_UIDS }, () => "a");
    expect(parseProjectAssigneesBody({ assigneeUids: atCap, expectedUpdateTime: TOKEN }).ok).toBe(true);
  });
  it("does not validate element shape here — that is the primitive's canonicalization (raw passes through)", () => {
    const r = parseProjectAssigneesBody({ assigneeUids: [42], expectedUpdateTime: TOKEN });
    expect(r.ok).toBe(true);
  });
});

describe("parseRunAssigneeBody", () => {
  it("accepts set and clear with an explicit expected value (null allowed for both)", () => {
    expect(parseRunAssigneeBody({ assigneeUid: "u2", expectedAssigneeUid: null })).toEqual({ ok: true, assigneeUid: "u2", expectedAssigneeUid: null });
    expect(parseRunAssigneeBody({ assigneeUid: null, expectedAssigneeUid: "u1" })).toEqual({ ok: true, assigneeUid: null, expectedAssigneeUid: "u1" });
  });
  it("BOTH keys are required — an absent expectedAssigneeUid is not defaulted to null", () => {
    expect(parseRunAssigneeBody({ assigneeUid: "u2" })).toEqual({ ok: false, reason: "invalid_body" });
    expect(parseRunAssigneeBody({ expectedAssigneeUid: null })).toEqual({ ok: false, reason: "invalid_body" });
  });
  it("rejects unknown fields and non-string/empty values", () => {
    expect(parseRunAssigneeBody({ assigneeUid: "u2", expectedAssigneeUid: null, projectId: "p" })).toEqual({ ok: false, reason: "unknown_field" });
    expect(parseRunAssigneeBody({ assigneeUid: "", expectedAssigneeUid: null }).ok).toBe(false);
    expect(parseRunAssigneeBody({ assigneeUid: 5, expectedAssigneeUid: null }).ok).toBe(false);
    expect(parseRunAssigneeBody({ assigneeUid: "u", expectedAssigneeUid: "" }).ok).toBe(false);
  });
});
