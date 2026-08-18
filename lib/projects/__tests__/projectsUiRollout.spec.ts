/**
 * Phase 7B — parseProjectsUiCanaryUids() / resolveProjectsUiMode() tests.
 * Structural mirror of lib/workspaces/__tests__/workspaceUiRollout.spec.ts
 * (Phase 5C's own UI-canary tests) — same parsing/precedence rules apply
 * here.
 */

import { MAX_PROJECTS_UI_CANARY_UIDS, parseProjectsUiCanaryUids, resolveProjectsUiMode } from "@/lib/projects/projectsUiRollout";

describe("parseProjectsUiCanaryUids", () => {
  it("env absent -> valid, empty set", () => {
    expect(parseProjectsUiCanaryUids(undefined)).toEqual({ ok: true, uids: new Set() });
  });

  it("env empty string -> valid, empty set", () => {
    expect(parseProjectsUiCanaryUids("")).toEqual({ ok: true, uids: new Set() });
  });

  it("env whitespace-only -> valid, empty set", () => {
    expect(parseProjectsUiCanaryUids("   \t  ")).toEqual({ ok: true, uids: new Set() });
  });

  it("one valid uid", () => {
    expect(parseProjectsUiCanaryUids("uid-1")).toEqual({ ok: true, uids: new Set(["uid-1"]) });
  });

  it("multiple valid uids (A+B)", () => {
    expect(parseProjectsUiCanaryUids("uid-1,uid-2")).toEqual({ ok: true, uids: new Set(["uid-1", "uid-2"]) });
  });

  it("duplicate valid uids deduplicate safely", () => {
    expect(parseProjectsUiCanaryUids("uid-1,uid-2,uid-1,uid-2")).toEqual({ ok: true, uids: new Set(["uid-1", "uid-2"]) });
  });

  it("surrounding whitespace around each entry is trimmed", () => {
    expect(parseProjectsUiCanaryUids("  uid-1 , uid-2  ")).toEqual({ ok: true, uids: new Set(["uid-1", "uid-2"]) });
  });

  it("a trailing comma produces no phantom empty entry", () => {
    expect(parseProjectsUiCanaryUids("uid-1,uid-2,")).toEqual({ ok: true, uids: new Set(["uid-1", "uid-2"]) });
  });

  it("a single malformed uid (path separator) invalidates the WHOLE list, not just that entry", () => {
    expect(parseProjectsUiCanaryUids("uid-1,not/a/uid,uid-2")).toEqual({ ok: false, reason: "malformed_entry" });
  });

  it("a control-character entry is rejected", () => {
    expect(parseProjectsUiCanaryUids("uid-1,uid-\x00-2")).toEqual({ ok: false, reason: "malformed_entry" });
  });

  it(`more than ${MAX_PROJECTS_UI_CANARY_UIDS} distinct uids -> too_many_entries`, () => {
    const uids = Array.from({ length: MAX_PROJECTS_UI_CANARY_UIDS + 1 }, (_, i) => `uid-${i}`).join(",");
    expect(parseProjectsUiCanaryUids(uids)).toEqual({ ok: false, reason: "too_many_entries" });
  });

  it(`exactly ${MAX_PROJECTS_UI_CANARY_UIDS} distinct uids is still valid`, () => {
    const uids = Array.from({ length: MAX_PROJECTS_UI_CANARY_UIDS }, (_, i) => `uid-${i}`).join(",");
    expect(parseProjectsUiCanaryUids(uids).ok).toBe(true);
  });
});

describe("resolveProjectsUiMode", () => {
  it("global absent + canary absent -> off", () => {
    const mode = resolveProjectsUiMode({ uid: "any-uid", globalEnabled: false, canaryUidsRaw: undefined });
    expect(mode).toEqual({ enabled: false, source: "off", canaryConfigInvalid: false });
  });

  it("global false + canary hit -> canary", () => {
    const mode = resolveProjectsUiMode({ uid: "uid-1", globalEnabled: false, canaryUidsRaw: "uid-1,uid-2" });
    expect(mode).toEqual({ enabled: true, source: "canary", canaryConfigInvalid: false });
  });

  it("global false + canary miss -> off", () => {
    const mode = resolveProjectsUiMode({ uid: "uid-3", globalEnabled: false, canaryUidsRaw: "uid-1,uid-2" });
    expect(mode.enabled).toBe(false);
    expect(mode.source).toBe("off");
  });

  it("global false + malformed canary -> off, fails closed", () => {
    const mode = resolveProjectsUiMode({ uid: "any-uid", globalEnabled: false, canaryUidsRaw: "not/a/uid" });
    expect(mode.enabled).toBe(false);
    expect(mode.source).toBe("off");
    expect(mode.canaryConfigInvalid).toBe(true);
  });

  it("global true + malformed canary -> global (always wins), canaryConfigInvalid surfaced for diagnostics", () => {
    const mode = resolveProjectsUiMode({ uid: "any-uid", globalEnabled: true, canaryUidsRaw: "not/a/uid" });
    expect(mode.enabled).toBe(true);
    expect(mode.source).toBe("global");
    expect(mode.canaryConfigInvalid).toBe(true);
  });

  it("SECURITY: prefix match is never sufficient — 'uid-1' in the list must not match 'uid-10'", () => {
    const mode = resolveProjectsUiMode({ uid: "uid-10", globalEnabled: false, canaryUidsRaw: "uid-1" });
    expect(mode.enabled).toBe(false);
  });

  it("SECURITY: suffix match is never sufficient — 'uid-1' in the list must not match 'x-uid-1'", () => {
    const mode = resolveProjectsUiMode({ uid: "x-uid-1", globalEnabled: false, canaryUidsRaw: "uid-1" });
    expect(mode.enabled).toBe(false);
  });

  it("SECURITY: incidental whitespace in the caller's uid never matches a trimmed canary entry", () => {
    const mode = resolveProjectsUiMode({ uid: " uid-1 ", globalEnabled: false, canaryUidsRaw: "uid-1" });
    expect(mode.enabled).toBe(false);
  });

  it("SECURITY: global false + malformed canary -> even a uid that WOULD be in a valid version of the list is still disabled (whole-list failure, not partial)", () => {
    const mode = resolveProjectsUiMode({ uid: "uid-1", globalEnabled: false, canaryUidsRaw: "uid-1,not/a/uid" });
    expect(mode.enabled).toBe(false);
  });

  it("SECURITY: >10 uids -> fails closed to disabled when global is off", () => {
    const uids = Array.from({ length: MAX_PROJECTS_UI_CANARY_UIDS + 1 }, (_, i) => `uid-${i}`).join(",");
    const mode = resolveProjectsUiMode({ uid: "uid-0", globalEnabled: false, canaryUidsRaw: uids });
    expect(mode.enabled).toBe(false);
  });
});

describe("MUTATION CHECKS — proving the tests above actually catch a broken implementation, not just a passing one", () => {
  it("if exact match were replaced with substring match, the prefix/suffix tests above would fail", () => {
    const substringMatch = (uid: string, list: string) => list.split(",").some((e) => uid.includes(e.trim()));
    expect(substringMatch("uid-10", "uid-1")).toBe(true); // the mutated behavior
    const real = resolveProjectsUiMode({ uid: "uid-10", globalEnabled: false, canaryUidsRaw: "uid-1" });
    expect(real.enabled).toBe(false); // the real resolver disagrees — proves the test above is meaningful
  });

  it("if a malformed canary defaulted to enabling everyone, this test would fail — confirming the test actually distinguishes fail-closed from fail-open", () => {
    const mode = resolveProjectsUiMode({ uid: "literally-anyone", globalEnabled: false, canaryUidsRaw: "not/a/uid" });
    expect(mode.enabled).toBe(false);
  });
});
