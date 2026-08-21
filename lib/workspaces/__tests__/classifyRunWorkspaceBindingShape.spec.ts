/**
 * Team Run Lists, Phase 8C-B2 — pure classifier tests. No Firestore, no
 * I/O of any kind.
 */

import { classifyRunWorkspaceBindingShape } from "../classifyRunWorkspaceBindingShape";

const OWNER = "owner-uid-1";
const PERSONAL_OWNER_WS = "personal-owner-uid-1";

describe("classifyRunWorkspaceBindingShape", () => {
  it("1. workspaceId key absent -> legacy", () => {
    const r = classifyRunWorkspaceBindingShape({ hasWorkspaceIdField: false, workspaceIdValue: undefined, userId: OWNER });
    expect(r).toEqual({ kind: "legacy" });
  });

  it("2. workspaceId key present but value undefined -> invalid malformed_workspace_id", () => {
    const r = classifyRunWorkspaceBindingShape({ hasWorkspaceIdField: true, workspaceIdValue: undefined, userId: OWNER });
    expect(r).toEqual({ kind: "invalid", reason: "malformed_workspace_id" });
  });

  it("3a. workspaceId null -> invalid malformed_workspace_id", () => {
    const r = classifyRunWorkspaceBindingShape({ hasWorkspaceIdField: true, workspaceIdValue: null, userId: OWNER });
    expect(r).toEqual({ kind: "invalid", reason: "malformed_workspace_id" });
  });

  it("3b. workspaceId non-string (number) -> invalid malformed_workspace_id", () => {
    const r = classifyRunWorkspaceBindingShape({ hasWorkspaceIdField: true, workspaceIdValue: 42, userId: OWNER });
    expect(r).toEqual({ kind: "invalid", reason: "malformed_workspace_id" });
  });

  it("4. workspaceId empty string -> invalid malformed_workspace_id", () => {
    const r = classifyRunWorkspaceBindingShape({ hasWorkspaceIdField: true, workspaceIdValue: "", userId: OWNER });
    expect(r).toEqual({ kind: "invalid", reason: "malformed_workspace_id" });
  });

  it("5a. invalid run.userId (wrong type) with an otherwise well-formed workspaceId -> invalid run_owner_invalid", () => {
    const r = classifyRunWorkspaceBindingShape({ hasWorkspaceIdField: true, workspaceIdValue: "VQCBcztCPrdWsKwDRwiw", userId: 12345 });
    expect(r).toEqual({ kind: "invalid", reason: "run_owner_invalid" });
  });

  it("5b. invalid run.userId (empty string) -> invalid run_owner_invalid", () => {
    const r = classifyRunWorkspaceBindingShape({ hasWorkspaceIdField: true, workspaceIdValue: "VQCBcztCPrdWsKwDRwiw", userId: "" });
    expect(r).toEqual({ kind: "invalid", reason: "run_owner_invalid" });
  });

  it("5c. missing run.userId -> invalid run_owner_invalid", () => {
    const r = classifyRunWorkspaceBindingShape({ hasWorkspaceIdField: true, workspaceIdValue: "VQCBcztCPrdWsKwDRwiw", userId: undefined });
    expect(r).toEqual({ kind: "invalid", reason: "run_owner_invalid" });
  });

  it("6. correct personal-{run.userId} -> personal", () => {
    const r = classifyRunWorkspaceBindingShape({ hasWorkspaceIdField: true, workspaceIdValue: PERSONAL_OWNER_WS, userId: OWNER });
    expect(r).toEqual({ kind: "personal", workspaceId: PERSONAL_OWNER_WS });
  });

  it("7. valid other workspace string (Team-shaped auto-id) -> non_personal_bound", () => {
    const r = classifyRunWorkspaceBindingShape({ hasWorkspaceIdField: true, workspaceIdValue: "VQCBcztCPrdWsKwDRwiw", userId: OWNER });
    expect(r).toEqual({ kind: "non_personal_bound", workspaceId: "VQCBcztCPrdWsKwDRwiw" });
  });

  it("8. personal-B on run owned by A -> non_personal_bound (never 'personal', never Team)", () => {
    const r = classifyRunWorkspaceBindingShape({ hasWorkspaceIdField: true, workspaceIdValue: "personal-B", userId: "A" });
    expect(r).toEqual({ kind: "non_personal_bound", workspaceId: "personal-B" });
  });

  it("9. a valid Team-style id -> non_personal_bound ONLY, never implicitly classified as Team", () => {
    const r = classifyRunWorkspaceBindingShape({ hasWorkspaceIdField: true, workspaceIdValue: "aTeamWorkspaceAutoId12", userId: OWNER });
    expect(r.kind).toBe("non_personal_bound");
    expect(r.kind).not.toBe("personal");
    // The result type has no "team" member at all — this classifier never claims Team.
    expect((r as any).kind).not.toBe("team");
  });

  it("purity: calling twice with identical input yields identical output (no hidden state/I-O)", () => {
    const input = { hasWorkspaceIdField: true, workspaceIdValue: PERSONAL_OWNER_WS, userId: OWNER };
    const r1 = classifyRunWorkspaceBindingShape(input);
    const r2 = classifyRunWorkspaceBindingShape(input);
    expect(r1).toEqual(r2);
  });
});
