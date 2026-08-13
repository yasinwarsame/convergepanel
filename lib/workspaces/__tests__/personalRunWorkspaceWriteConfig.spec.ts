/**
 * Workspace-Aware Writes for New Personal Adaptive Runs, Phase 3 —
 * checkPersonalRunWorkspaceWriteConfiguration() flag-matrix tests.
 */

import { checkPersonalRunWorkspaceWriteConfiguration } from "@/lib/workspaces/personalRunWorkspaceWriteConfig";

describe("checkPersonalRunWorkspaceWriteConfiguration — full flag matrix", () => {
  it("W=false / RW=false -> ok (writes off, mismatch can't occur)", () => {
    expect(checkPersonalRunWorkspaceWriteConfiguration({ workspacesEnabled: false, writesEnabled: false })).toEqual({ ok: true });
  });

  it("W=false / RW=true -> INVALID (would create runs the owner can't access)", () => {
    const result = checkPersonalRunWorkspaceWriteConfiguration({ workspacesEnabled: false, writesEnabled: true });
    expect(result).toEqual({ ok: false, reason: "workspaces_disabled_but_writes_enabled" });
  });

  it("W=true / RW=false -> ok (writes off; safe regardless of W)", () => {
    expect(checkPersonalRunWorkspaceWriteConfiguration({ workspacesEnabled: true, writesEnabled: false })).toEqual({ ok: true });
  });

  it("W=true / RW=true -> ok (the only combination that safely binds new runs)", () => {
    expect(checkPersonalRunWorkspaceWriteConfiguration({ workspacesEnabled: true, writesEnabled: true })).toEqual({ ok: true });
  });
});
