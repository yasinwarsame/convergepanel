/**
 * Team Workspace Core Foundation, Phase 8B.2 — parseTeamWorkspacesCanaryUids() /
 * resolveTeamWorkspacesMode() tests. Structural mirror of
 * lib/projects/__tests__/projectsRollout.spec.ts — same parsing/
 * precedence rules apply here.
 */

import { MAX_TEAM_WORKSPACES_CANARY_UIDS, parseTeamWorkspacesCanaryUids, resolveTeamWorkspacesMode } from "@/lib/workspaces/teamWorkspacesRollout";

describe("parseTeamWorkspacesCanaryUids", () => {
  it("env absent -> valid, empty set", () => {
    expect(parseTeamWorkspacesCanaryUids(undefined)).toEqual({ ok: true, uids: new Set() });
  });

  it("env empty string -> valid, empty set", () => {
    expect(parseTeamWorkspacesCanaryUids("")).toEqual({ ok: true, uids: new Set() });
  });

  it("env whitespace-only -> valid, empty set", () => {
    expect(parseTeamWorkspacesCanaryUids("   \t  ")).toEqual({ ok: true, uids: new Set() });
  });

  it("one valid uid", () => {
    expect(parseTeamWorkspacesCanaryUids("uid-1")).toEqual({ ok: true, uids: new Set(["uid-1"]) });
  });

  it("multiple valid uids", () => {
    expect(parseTeamWorkspacesCanaryUids("uid-1,uid-2,uid-3")).toEqual({ ok: true, uids: new Set(["uid-1", "uid-2", "uid-3"]) });
  });

  it("duplicate valid uids deduplicate safely", () => {
    expect(parseTeamWorkspacesCanaryUids("uid-1,uid-2,uid-1,uid-2")).toEqual({ ok: true, uids: new Set(["uid-1", "uid-2"]) });
  });

  it("surrounding whitespace around each entry is trimmed", () => {
    expect(parseTeamWorkspacesCanaryUids("  uid-1 , uid-2  ")).toEqual({ ok: true, uids: new Set(["uid-1", "uid-2"]) });
  });

  it("a trailing comma produces no phantom empty entry", () => {
    expect(parseTeamWorkspacesCanaryUids("uid-1,uid-2,")).toEqual({ ok: true, uids: new Set(["uid-1", "uid-2"]) });
  });

  it("a single malformed uid (path separator) invalidates the WHOLE list, not just that entry", () => {
    expect(parseTeamWorkspacesCanaryUids("uid-1,not/a/uid,uid-2")).toEqual({ ok: false, reason: "malformed_entry" });
  });

  it("a control-character entry is rejected", () => {
    expect(parseTeamWorkspacesCanaryUids("uid-1,uid-\x00-2")).toEqual({ ok: false, reason: "malformed_entry" });
  });

  it(`more than ${MAX_TEAM_WORKSPACES_CANARY_UIDS} distinct uids -> too_many_entries`, () => {
    const uids = Array.from({ length: MAX_TEAM_WORKSPACES_CANARY_UIDS + 1 }, (_, i) => `uid-${i}`).join(",");
    expect(parseTeamWorkspacesCanaryUids(uids)).toEqual({ ok: false, reason: "too_many_entries" });
  });

  it(`exactly ${MAX_TEAM_WORKSPACES_CANARY_UIDS} distinct uids is still valid`, () => {
    const uids = Array.from({ length: MAX_TEAM_WORKSPACES_CANARY_UIDS }, (_, i) => `uid-${i}`).join(",");
    const result = parseTeamWorkspacesCanaryUids(uids);
    expect(result.ok).toBe(true);
  });

  it(`reuses the same proven cohort ceiling as the Projects backend canary (${MAX_TEAM_WORKSPACES_CANARY_UIDS})`, () => {
    expect(MAX_TEAM_WORKSPACES_CANARY_UIDS).toBe(10);
  });
});

describe("resolveTeamWorkspacesMode", () => {
  it("no env at all -> disabled, source off", () => {
    const mode = resolveTeamWorkspacesMode({ uid: "any-uid", globalEnabled: false, canaryUidsRaw: undefined });
    expect(mode).toEqual({ enabled: false, source: "off", canaryConfigInvalid: false });
  });

  it("global=false, no canary -> disabled", () => {
    const mode = resolveTeamWorkspacesMode({ uid: "any-uid", globalEnabled: false, canaryUidsRaw: "" });
    expect(mode.enabled).toBe(false);
    expect(mode.source).toBe("off");
  });

  it("global=true -> enabled regardless of canary", () => {
    const mode = resolveTeamWorkspacesMode({ uid: "any-uid", globalEnabled: true, canaryUidsRaw: undefined });
    expect(mode).toEqual({ enabled: true, source: "global", canaryConfigInvalid: false });
  });

  it("SECURITY: global=true + malformed canary -> STILL enabled (global always wins), but canaryConfigInvalid surfaced for diagnostics", () => {
    const mode = resolveTeamWorkspacesMode({ uid: "any-uid", globalEnabled: true, canaryUidsRaw: "not/a/uid" });
    expect(mode.enabled).toBe(true);
    expect(mode.source).toBe("global");
    expect(mode.canaryConfigInvalid).toBe(true);
  });

  it("exact uid match in a valid canary list -> enabled, source canary", () => {
    const mode = resolveTeamWorkspacesMode({ uid: "uid-1", globalEnabled: false, canaryUidsRaw: "uid-1,uid-2" });
    expect(mode).toEqual({ enabled: true, source: "canary", canaryConfigInvalid: false });
  });

  it("SECURITY: non-matching uid -> disabled", () => {
    const mode = resolveTeamWorkspacesMode({ uid: "uid-3", globalEnabled: false, canaryUidsRaw: "uid-1,uid-2" });
    expect(mode.enabled).toBe(false);
  });

  it("SECURITY: prefix match is never sufficient — 'uid-1' in the list must not match 'uid-10'", () => {
    const mode = resolveTeamWorkspacesMode({ uid: "uid-10", globalEnabled: false, canaryUidsRaw: "uid-1" });
    expect(mode.enabled).toBe(false);
  });

  it("SECURITY: suffix match is never sufficient — 'uid-1' in the list must not match 'x-uid-1'", () => {
    const mode = resolveTeamWorkspacesMode({ uid: "x-uid-1", globalEnabled: false, canaryUidsRaw: "uid-1" });
    expect(mode.enabled).toBe(false);
  });

  it("SECURITY: incidental whitespace in the caller's uid never matches a trimmed canary entry", () => {
    const mode = resolveTeamWorkspacesMode({ uid: " uid-1 ", globalEnabled: false, canaryUidsRaw: "uid-1" });
    expect(mode.enabled).toBe(false); // caller's uid is never trimmed — only the config entries are
  });

  it("duplicate entries in canary config are harmless", () => {
    const mode = resolveTeamWorkspacesMode({ uid: "uid-1", globalEnabled: false, canaryUidsRaw: "uid-1,uid-1,uid-1" });
    expect(mode.enabled).toBe(true);
  });

  it("SECURITY: global=false + malformed canary -> fails closed to disabled, never enables everyone", () => {
    const mode = resolveTeamWorkspacesMode({ uid: "any-uid", globalEnabled: false, canaryUidsRaw: "not/a/uid" });
    expect(mode.enabled).toBe(false);
    expect(mode.source).toBe("off");
    expect(mode.canaryConfigInvalid).toBe(true);
  });

  it("SECURITY: global=false + malformed canary -> even a uid that WOULD be in a valid version of the list is still disabled (whole-list failure, not partial)", () => {
    const mode = resolveTeamWorkspacesMode({ uid: "uid-1", globalEnabled: false, canaryUidsRaw: "uid-1,not/a/uid" });
    expect(mode.enabled).toBe(false);
  });

  it("SECURITY: >10 uids -> fails closed to disabled when global is off", () => {
    const uids = Array.from({ length: MAX_TEAM_WORKSPACES_CANARY_UIDS + 1 }, (_, i) => `uid-${i}`).join(",");
    const mode = resolveTeamWorkspacesMode({ uid: "uid-0", globalEnabled: false, canaryUidsRaw: uids });
    expect(mode.enabled).toBe(false);
  });
});

describe("MUTATION CHECKS — proving the tests above actually catch a broken implementation, not just a passing one", () => {
  it("if exact match were replaced with substring match, the prefix/suffix tests above would fail", () => {
    const substringMatch = (uid: string, list: string) => list.split(",").some((e) => uid.includes(e.trim()));
    expect(substringMatch("uid-10", "uid-1")).toBe(true); // the mutated behavior
    const real = resolveTeamWorkspacesMode({ uid: "uid-10", globalEnabled: false, canaryUidsRaw: "uid-1" });
    expect(real.enabled).toBe(false); // the real resolver disagrees — proves the test above is meaningful
  });

  it("if a malformed canary defaulted to enabling everyone, this test would fail — confirming the test actually distinguishes fail-closed from fail-open", () => {
    const mode = resolveTeamWorkspacesMode({ uid: "literally-anyone", globalEnabled: false, canaryUidsRaw: "not/a/uid" });
    expect(mode.enabled).toBe(false);
  });
});
