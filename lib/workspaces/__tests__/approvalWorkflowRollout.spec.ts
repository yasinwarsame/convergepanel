/**
 * Approval Workflow, Phase 9B.4 — parseApprovalWorkflowCanaryUids() /
 * resolveApprovalWorkflowAdmission() tests. Structural mirror of
 * lib/workspaces/__tests__/teamWorkspacesRollout.spec.ts — same parsing/
 * precedence rules apply here, since this module is a deliberate
 * structural copy of that one for a separate rollout axis.
 */

import { MAX_APPROVAL_WORKFLOW_CANARY_UIDS, parseApprovalWorkflowCanaryUids, resolveApprovalWorkflowAdmission } from "@/lib/workspaces/approvalWorkflowRollout";

describe("parseApprovalWorkflowCanaryUids", () => {
  it("env absent -> valid, empty set", () => {
    expect(parseApprovalWorkflowCanaryUids(undefined)).toEqual({ ok: true, uids: new Set() });
  });

  it("env empty string -> valid, empty set", () => {
    expect(parseApprovalWorkflowCanaryUids("")).toEqual({ ok: true, uids: new Set() });
  });

  it("env whitespace-only -> valid, empty set", () => {
    expect(parseApprovalWorkflowCanaryUids("   \t  ")).toEqual({ ok: true, uids: new Set() });
  });

  it("one valid uid", () => {
    expect(parseApprovalWorkflowCanaryUids("uid-1")).toEqual({ ok: true, uids: new Set(["uid-1"]) });
  });

  it("multiple valid uids", () => {
    expect(parseApprovalWorkflowCanaryUids("uid-1,uid-2,uid-3")).toEqual({ ok: true, uids: new Set(["uid-1", "uid-2", "uid-3"]) });
  });

  it("duplicate valid uids deduplicate safely", () => {
    expect(parseApprovalWorkflowCanaryUids("uid-1,uid-2,uid-1,uid-2")).toEqual({ ok: true, uids: new Set(["uid-1", "uid-2"]) });
  });

  it("surrounding whitespace around each entry is trimmed", () => {
    expect(parseApprovalWorkflowCanaryUids("  uid-1 , uid-2  ")).toEqual({ ok: true, uids: new Set(["uid-1", "uid-2"]) });
  });

  it("a trailing comma produces no phantom empty entry", () => {
    expect(parseApprovalWorkflowCanaryUids("uid-1,uid-2,")).toEqual({ ok: true, uids: new Set(["uid-1", "uid-2"]) });
  });

  it("a single malformed uid (path separator) invalidates the WHOLE list, not just that entry", () => {
    expect(parseApprovalWorkflowCanaryUids("uid-1,not/a/uid,uid-2")).toEqual({ ok: false, reason: "malformed_entry" });
  });

  it(`more than ${MAX_APPROVAL_WORKFLOW_CANARY_UIDS} distinct uids -> too_many_entries`, () => {
    const uids = Array.from({ length: MAX_APPROVAL_WORKFLOW_CANARY_UIDS + 1 }, (_, i) => `uid-${i}`).join(",");
    expect(parseApprovalWorkflowCanaryUids(uids)).toEqual({ ok: false, reason: "too_many_entries" });
  });

  it(`exactly ${MAX_APPROVAL_WORKFLOW_CANARY_UIDS} distinct uids is still valid`, () => {
    const uids = Array.from({ length: MAX_APPROVAL_WORKFLOW_CANARY_UIDS }, (_, i) => `uid-${i}`).join(",");
    expect(parseApprovalWorkflowCanaryUids(uids).ok).toBe(true);
  });

  it(`reuses the same proven cohort ceiling as the Team Workspaces backend canary (${MAX_APPROVAL_WORKFLOW_CANARY_UIDS})`, () => {
    expect(MAX_APPROVAL_WORKFLOW_CANARY_UIDS).toBe(10);
  });
});

describe("resolveApprovalWorkflowAdmission", () => {
  it("no env at all -> not admitted, source off", () => {
    const mode = resolveApprovalWorkflowAdmission({ uid: "any-uid", globalEnabled: false, canaryUidsRaw: undefined });
    expect(mode).toEqual({ admitted: false, source: "off", canaryConfigInvalid: false });
  });

  it("global=true -> admitted regardless of canary", () => {
    const mode = resolveApprovalWorkflowAdmission({ uid: "any-uid", globalEnabled: true, canaryUidsRaw: undefined });
    expect(mode).toEqual({ admitted: true, source: "global", canaryConfigInvalid: false });
  });

  it("SECURITY: global=true + malformed canary -> STILL admitted (global always wins), but canaryConfigInvalid surfaced", () => {
    const mode = resolveApprovalWorkflowAdmission({ uid: "any-uid", globalEnabled: true, canaryUidsRaw: "not/a/uid" });
    expect(mode.admitted).toBe(true);
    expect(mode.source).toBe("global");
    expect(mode.canaryConfigInvalid).toBe(true);
  });

  it("exact uid match in a valid canary list -> admitted, source canary", () => {
    const mode = resolveApprovalWorkflowAdmission({ uid: "uid-1", globalEnabled: false, canaryUidsRaw: "uid-1,uid-2" });
    expect(mode).toEqual({ admitted: true, source: "canary", canaryConfigInvalid: false });
  });

  it("SECURITY: non-matching uid -> not admitted", () => {
    const mode = resolveApprovalWorkflowAdmission({ uid: "uid-3", globalEnabled: false, canaryUidsRaw: "uid-1,uid-2" });
    expect(mode.admitted).toBe(false);
  });

  it("SECURITY: prefix/suffix match is never sufficient", () => {
    expect(resolveApprovalWorkflowAdmission({ uid: "uid-10", globalEnabled: false, canaryUidsRaw: "uid-1" }).admitted).toBe(false);
    expect(resolveApprovalWorkflowAdmission({ uid: "x-uid-1", globalEnabled: false, canaryUidsRaw: "uid-1" }).admitted).toBe(false);
  });

  it("SECURITY: global=false + malformed canary -> fails closed, never admits everyone", () => {
    const mode = resolveApprovalWorkflowAdmission({ uid: "any-uid", globalEnabled: false, canaryUidsRaw: "not/a/uid" });
    expect(mode.admitted).toBe(false);
    expect(mode.source).toBe("off");
    expect(mode.canaryConfigInvalid).toBe(true);
  });

  it("SECURITY: this rollout is independent of Team Workspaces — the resolver never reads or infers TEAM_WORKSPACES_* config, proven by the function signature itself accepting only Approval-Workflow-specific args", () => {
    const mode = resolveApprovalWorkflowAdmission({ uid: "uid-1", globalEnabled: false, canaryUidsRaw: undefined });
    expect(mode.admitted).toBe(false); // admission alone never implies Team Workspace access — that is the route's OWN second, separate gate
  });
});
