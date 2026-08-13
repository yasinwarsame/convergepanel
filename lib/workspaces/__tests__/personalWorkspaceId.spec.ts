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
  ])("rejects: %s", (_label, uid) => {
    expect(getPersonalWorkspaceId(uid)).toEqual({ ok: false, reason: "invalid_uid" });
  });

  it("two different uids never collide", () => {
    const a = getPersonalWorkspaceId("uid-a");
    const b = getPersonalWorkspaceId("uid-b");
    expect(a.ok && b.ok && a.workspaceId !== b.workspaceId).toBe(true);
  });
});
