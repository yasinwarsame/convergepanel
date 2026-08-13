/**
 * Personal Workspace Provisioning, Phase 2 — getPersonalWorkspaceId() tests.
 */

import { getPersonalWorkspaceId } from "@/lib/workspaces/personalWorkspaceId";

describe("getPersonalWorkspaceId", () => {
  it("derives the deterministic id for a valid uid", () => {
    expect(getPersonalWorkspaceId("owner-1")).toEqual({ ok: true, workspaceId: "personal-owner-1" });
  });

  it("derives the id for a realistic Firebase-shaped uid", () => {
    expect(getPersonalWorkspaceId("Td2BOHteYSUIafLh7qL8s0V2CCt2")).toEqual({
      ok: true,
      workspaceId: "personal-Td2BOHteYSUIafLh7qL8s0V2CCt2",
    });
  });

  it.each([
    ["empty string", ""],
    ["whitespace only", "   "],
    ["leading whitespace", " owner-1"],
    ["trailing whitespace", "owner-1 "],
    ["null", null],
    ["undefined", undefined],
    ["a number", 12345],
    ["an object", { uid: "owner-1" }],
    ["an array", ["owner-1"]],
    ["contains a slash", "owner/1"],
    ["is exactly '.'", "."],
    ["is exactly '..'", ".."],
    ["exceeds Firestore's document id byte limit", "u".repeat(1500)],
    ["contains a newline", "uid\n1"],
    ["contains a carriage return", "uid\r1"],
    ["contains a tab", "uid\t1"],
    ["contains a null byte", "uid\x001"],
    ["contains a DEL control character", "uid\x7f1"],
    ["contains a C0 control character mid-string", "ui\x0bd1"],
  ])("rejects: %s", (_label, uid) => {
    expect(getPersonalWorkspaceId(uid)).toEqual({ ok: false, reason: "invalid_uid" });
  });

  it("two different uids never collide", () => {
    const a = getPersonalWorkspaceId("uid-a");
    const b = getPersonalWorkspaceId("uid-b");
    expect(a.ok && b.ok && a.workspaceId !== b.workspaceId).toBe(true);
  });

  it("accepts a backslash — not a forbidden Firestore document-id character, unlike forward slash", () => {
    expect(getPersonalWorkspaceId("a\\b")).toEqual({ ok: true, workspaceId: "personal-a\\b" });
  });

  it("never produces an id matching Firestore's reserved __.*__ pattern, by construction (the personal- prefix never starts with __)", () => {
    const result = getPersonalWorkspaceId("__proto__");
    expect(result).toEqual({ ok: true, workspaceId: "personal-__proto__" });
    if (result.ok) {
      expect(/^__.*__$/.test(result.workspaceId)).toBe(false);
    }
  });
});
