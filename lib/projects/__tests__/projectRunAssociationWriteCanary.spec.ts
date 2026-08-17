/**
 * Going-Forward Run/Project Association Write Canary, Phase 6D.2 —
 * parseProjectRunAssociationCanaryUidAllowlist() /
 * resolveProjectRunAssociationWriteMode() tests. Deliberate structural
 * mirror of lib/workspaces/__tests__/personalRunWorkspaceWriteCanary.spec.ts
 * (Phase 3A) — same cases, same precedence, proving this module did not
 * invent a second interpretation of "master + canary."
 */

import {
  MAX_PROJECT_RUN_ASSOCIATION_CANARY_UIDS,
  parseProjectRunAssociationCanaryUidAllowlist,
  resolveProjectRunAssociationWriteMode,
} from "@/lib/projects/projectRunAssociationWriteCanary";

describe("parseProjectRunAssociationCanaryUidAllowlist", () => {
  it("env absent -> valid, empty set", () => {
    expect(parseProjectRunAssociationCanaryUidAllowlist(undefined)).toEqual({ ok: true, uids: new Set() });
  });

  it("env empty string -> valid, empty set", () => {
    expect(parseProjectRunAssociationCanaryUidAllowlist("")).toEqual({ ok: true, uids: new Set() });
  });

  it("env whitespace-only -> valid, empty set", () => {
    expect(parseProjectRunAssociationCanaryUidAllowlist("   \t  ")).toEqual({ ok: true, uids: new Set() });
  });

  it("one valid uid", () => {
    expect(parseProjectRunAssociationCanaryUidAllowlist("uid-1")).toEqual({ ok: true, uids: new Set(["uid-1"]) });
  });

  it("multiple valid uids (A+B shape)", () => {
    expect(parseProjectRunAssociationCanaryUidAllowlist("uid-1,uid-2")).toEqual({ ok: true, uids: new Set(["uid-1", "uid-2"]) });
  });

  it("duplicate valid uids deduplicate safely", () => {
    const result = parseProjectRunAssociationCanaryUidAllowlist("uid-1,uid-2,uid-1,uid-2");
    expect(result).toEqual({ ok: true, uids: new Set(["uid-1", "uid-2"]) });
  });

  it("surrounding whitespace around each entry is trimmed", () => {
    expect(parseProjectRunAssociationCanaryUidAllowlist("  uid-1 , uid-2  ")).toEqual({ ok: true, uids: new Set(["uid-1", "uid-2"]) });
  });

  it("a trailing comma produces no phantom empty entry", () => {
    expect(parseProjectRunAssociationCanaryUidAllowlist("uid-1,uid-2,")).toEqual({ ok: true, uids: new Set(["uid-1", "uid-2"]) });
  });

  it("a single malformed uid (path separator) invalidates the WHOLE list, not just that entry", () => {
    const result = parseProjectRunAssociationCanaryUidAllowlist("uid-1,not/a/uid,uid-2");
    expect(result).toEqual({ ok: false, reason: "malformed_entry" });
  });

  it("a control-character entry is rejected", () => {
    const result = parseProjectRunAssociationCanaryUidAllowlist("uid-1,uid-\x00-2");
    expect(result).toEqual({ ok: false, reason: "malformed_entry" });
  });

  it("mixture of valid and invalid entries fails the whole list", () => {
    const result = parseProjectRunAssociationCanaryUidAllowlist("uid-1,uid-2,../escape");
    expect(result).toEqual({ ok: false, reason: "malformed_entry" });
  });

  it("a literal '*' is never treated as a wildcard — exact-uid-equality only, proven functionally in the write-mode tests below", () => {
    const result = parseProjectRunAssociationCanaryUidAllowlist("uid-1,*");
    expect(result).toEqual({ ok: true, uids: new Set(["uid-1", "*"]) });
    const mode = resolveProjectRunAssociationWriteMode({ uid: "any-real-uid", globalWritesEnabled: false, canaryUidsRaw: "uid-1,*" });
    expect(mode.enabled).toBe(false);
  });

  it(`more than ${MAX_PROJECT_RUN_ASSOCIATION_CANARY_UIDS} distinct valid uids is rejected as too_many_entries`, () => {
    const uids = Array.from({ length: MAX_PROJECT_RUN_ASSOCIATION_CANARY_UIDS + 1 }, (_, i) => `uid-${i}`).join(",");
    expect(parseProjectRunAssociationCanaryUidAllowlist(uids)).toEqual({ ok: false, reason: "too_many_entries" });
  });

  it(`exactly ${MAX_PROJECT_RUN_ASSOCIATION_CANARY_UIDS} distinct valid uids is accepted`, () => {
    const uids = Array.from({ length: MAX_PROJECT_RUN_ASSOCIATION_CANARY_UIDS }, (_, i) => `uid-${i}`);
    const result = parseProjectRunAssociationCanaryUidAllowlist(uids.join(","));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.uids.size).toBe(MAX_PROJECT_RUN_ASSOCIATION_CANARY_UIDS);
  });

  it("duplicates of the same uid do not count multiple times against the maximum", () => {
    const dup = Array.from({ length: MAX_PROJECT_RUN_ASSOCIATION_CANARY_UIDS + 5 }, () => "uid-same").join(",");
    expect(parseProjectRunAssociationCanaryUidAllowlist(dup)).toEqual({ ok: true, uids: new Set(["uid-same"]) });
  });
});

describe("resolveProjectRunAssociationWriteMode", () => {
  it("global=true -> source: global, enabled: true, regardless of canary list content", () => {
    const result = resolveProjectRunAssociationWriteMode({ uid: "uid-1", globalWritesEnabled: true, canaryUidsRaw: undefined });
    expect(result).toEqual({ enabled: true, source: "global", canaryConfigInvalid: false });
  });

  it("global=true with a MALFORMED canary list still wins (global takes precedence), but flags canaryConfigInvalid for logging", () => {
    const result = resolveProjectRunAssociationWriteMode({ uid: "uid-1", globalWritesEnabled: true, canaryUidsRaw: "not/valid" });
    expect(result).toEqual({ enabled: true, source: "global", canaryConfigInvalid: true });
  });

  it("global=false, uid in a valid canary list -> source: canary, enabled: true (independent activation path, not subordinate to global)", () => {
    const result = resolveProjectRunAssociationWriteMode({ uid: "uid-1", globalWritesEnabled: false, canaryUidsRaw: "uid-1,uid-2" });
    expect(result).toEqual({ enabled: true, source: "canary", canaryConfigInvalid: false });
  });

  it("global=false, uid NOT in a valid canary list -> source: off, enabled: false", () => {
    const result = resolveProjectRunAssociationWriteMode({ uid: "uid-3", globalWritesEnabled: false, canaryUidsRaw: "uid-1,uid-2" });
    expect(result).toEqual({ enabled: false, source: "off", canaryConfigInvalid: false });
  });

  it("global=false, canary list absent -> source: off for everyone", () => {
    const result = resolveProjectRunAssociationWriteMode({ uid: "uid-1", globalWritesEnabled: false, canaryUidsRaw: undefined });
    expect(result).toEqual({ enabled: false, source: "off", canaryConfigInvalid: false });
  });

  it("global=false, canary list MALFORMED -> fails closed to off for every uid, never a partial match, always flags canaryConfigInvalid", () => {
    const result = resolveProjectRunAssociationWriteMode({ uid: "uid-1", globalWritesEnabled: false, canaryUidsRaw: "uid-1,not/valid" });
    expect(result).toEqual({ enabled: false, source: "off", canaryConfigInvalid: true });
  });

  it("exact match only — a uid that is a prefix or substring of a listed uid is never matched", () => {
    const result = resolveProjectRunAssociationWriteMode({ uid: "uid-1-extra", globalWritesEnabled: false, canaryUidsRaw: "uid-1" });
    expect(result).toEqual({ enabled: false, source: "off", canaryConfigInvalid: false });
  });

  it("exact match only — a uid that a listed uid is a substring of is never matched", () => {
    const result = resolveProjectRunAssociationWriteMode({ uid: "uid-1", globalWritesEnabled: false, canaryUidsRaw: "uid-1-extra" });
    expect(result).toEqual({ enabled: false, source: "off", canaryConfigInvalid: false });
  });

  it("full flag/canary matrix — exactly mirrors the Phase 3A precedent's matrix", () => {
    const cases: Array<[boolean, string | undefined, string, { enabled: boolean; source: string }]> = [
      [false, undefined, "uid-x", { enabled: false, source: "off" }],
      [false, "uid-x", "uid-x", { enabled: true, source: "canary" }],
      [true, undefined, "uid-x", { enabled: true, source: "global" }],
      [true, "uid-x", "uid-x", { enabled: true, source: "global" }], // global takes precedence
      [true, "not/valid", "uid-x", { enabled: true, source: "global" }], // malformed canary irrelevant when global=true
    ];
    for (const [globalWritesEnabled, canaryUidsRaw, uid, expected] of cases) {
      const result = resolveProjectRunAssociationWriteMode({ uid, globalWritesEnabled, canaryUidsRaw });
      expect(result.enabled).toBe(expected.enabled);
      expect(result.source).toBe(expected.source);
    }
  });

  it("MUTATION-GUARD: global=false + a valid canary containing the uid must resolve to enabled — this is the exact decision frozen at Phase 6D.1 closure (canary is an independent activation path, not subordinate to global)", () => {
    const result = resolveProjectRunAssociationWriteMode({ uid: "canary-uid", globalWritesEnabled: false, canaryUidsRaw: "canary-uid" });
    expect(result.enabled).toBe(true);
    expect(result.source).toBe("canary");
  });
});
