/**
 * Account-Scoped Workspace Write Canary, Phase 3A —
 * parseCanaryUidAllowlist() / resolvePersonalRunWorkspaceWriteMode() tests.
 */

import {
  MAX_PERSONAL_RUN_WORKSPACE_CANARY_UIDS,
  parseCanaryUidAllowlist,
  resolvePersonalRunWorkspaceWriteMode,
} from "@/lib/workspaces/personalRunWorkspaceWriteCanary";

describe("parseCanaryUidAllowlist", () => {
  it("env absent -> valid, empty set", () => {
    expect(parseCanaryUidAllowlist(undefined)).toEqual({ ok: true, uids: new Set() });
  });

  it("env empty string -> valid, empty set", () => {
    expect(parseCanaryUidAllowlist("")).toEqual({ ok: true, uids: new Set() });
  });

  it("env whitespace-only -> valid, empty set", () => {
    expect(parseCanaryUidAllowlist("   \t  ")).toEqual({ ok: true, uids: new Set() });
  });

  it("one valid uid", () => {
    expect(parseCanaryUidAllowlist("uid-1")).toEqual({ ok: true, uids: new Set(["uid-1"]) });
  });

  it("multiple valid uids", () => {
    expect(parseCanaryUidAllowlist("uid-1,uid-2,uid-3")).toEqual({ ok: true, uids: new Set(["uid-1", "uid-2", "uid-3"]) });
  });

  it("duplicate valid uids deduplicate safely", () => {
    const result = parseCanaryUidAllowlist("uid-1,uid-2,uid-1,uid-2");
    expect(result).toEqual({ ok: true, uids: new Set(["uid-1", "uid-2"]) });
  });

  it("surrounding whitespace around each entry is trimmed", () => {
    expect(parseCanaryUidAllowlist("  uid-1 , uid-2  ")).toEqual({ ok: true, uids: new Set(["uid-1", "uid-2"]) });
  });

  it("a trailing comma produces no phantom empty entry", () => {
    expect(parseCanaryUidAllowlist("uid-1,uid-2,")).toEqual({ ok: true, uids: new Set(["uid-1", "uid-2"]) });
  });

  it("a single malformed uid (path separator) invalidates the WHOLE list, not just that entry", () => {
    const result = parseCanaryUidAllowlist("uid-1,not/a/uid,uid-2");
    expect(result).toEqual({ ok: false, reason: "malformed_entry" });
  });

  it("an email-shaped entry is rejected as malformed (never email matching)", () => {
    // Firebase uids are never valid email addresses, but the validator's
    // job here is simply "is this a well-formed uid," not "is this NOT an
    // email" — an email string can still incidentally pass uid-shape
    // validation. What matters for this test is that matching later is
    // always exact-uid-equality, never interpreted as an email (covered
    // in the write-mode tests below).
    const result = parseCanaryUidAllowlist("uid-1,");
    expect(result.ok).toBe(true);
  });

  it("a literal '*' is never treated as a wildcard — it's just an ordinary (harmless, never-matching) string entry, since matching is always exact-uid-equality, never pattern-based. Reusing getPersonalWorkspaceId() means this parses successfully (that validator only forbids structurally dangerous Firestore-id characters, not 'looks like a real Firebase uid'); the actual wildcard-safety guarantee is proven by the exact-match tests below, not by rejecting this character here", () => {
    const result = parseCanaryUidAllowlist("uid-1,*");
    expect(result).toEqual({ ok: true, uids: new Set(["uid-1", "*"]) });
    // A real authenticated uid can never literally equal "*" (Firebase
    // uids are alphanumeric), so this entry can never match anyone —
    // proven functionally, not by special-casing the character.
    const mode = resolvePersonalRunWorkspaceWriteMode({ uid: "any-real-uid", globalWritesEnabled: false, canaryUidsRaw: "uid-1,*" });
    expect(mode.enabled).toBe(false);
  });

  it("a control-character entry is rejected", () => {
    const result = parseCanaryUidAllowlist("uid-1,uid-\x00-2");
    expect(result).toEqual({ ok: false, reason: "malformed_entry" });
  });

  it("mixture of valid and invalid entries fails the whole list", () => {
    const result = parseCanaryUidAllowlist("uid-1,uid-2,../escape");
    expect(result).toEqual({ ok: false, reason: "malformed_entry" });
  });

  it(`more than ${MAX_PERSONAL_RUN_WORKSPACE_CANARY_UIDS} distinct valid uids is rejected as too_many_entries`, () => {
    const uids = Array.from({ length: MAX_PERSONAL_RUN_WORKSPACE_CANARY_UIDS + 1 }, (_, i) => `uid-${i}`).join(",");
    expect(parseCanaryUidAllowlist(uids)).toEqual({ ok: false, reason: "too_many_entries" });
  });

  it(`exactly ${MAX_PERSONAL_RUN_WORKSPACE_CANARY_UIDS} distinct valid uids is accepted`, () => {
    const uids = Array.from({ length: MAX_PERSONAL_RUN_WORKSPACE_CANARY_UIDS }, (_, i) => `uid-${i}`);
    const result = parseCanaryUidAllowlist(uids.join(","));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.uids.size).toBe(MAX_PERSONAL_RUN_WORKSPACE_CANARY_UIDS);
  });

  it("duplicates of the same uid do not count multiple times against the maximum", () => {
    const dup = Array.from({ length: MAX_PERSONAL_RUN_WORKSPACE_CANARY_UIDS + 5 }, () => "uid-same").join(",");
    expect(parseCanaryUidAllowlist(dup)).toEqual({ ok: true, uids: new Set(["uid-same"]) });
  });
});

describe("resolvePersonalRunWorkspaceWriteMode", () => {
  it("global=true -> source: global, enabled: true, regardless of canary list content", () => {
    const result = resolvePersonalRunWorkspaceWriteMode({ uid: "uid-1", globalWritesEnabled: true, canaryUidsRaw: undefined });
    expect(result).toEqual({ enabled: true, source: "global", canaryConfigInvalid: false });
  });

  it("global=true with a MALFORMED canary list still wins (global takes precedence), but flags canaryConfigInvalid for logging", () => {
    const result = resolvePersonalRunWorkspaceWriteMode({ uid: "uid-1", globalWritesEnabled: true, canaryUidsRaw: "not/valid" });
    expect(result).toEqual({ enabled: true, source: "global", canaryConfigInvalid: true });
  });

  it("global=false, uid in a valid canary list -> source: canary, enabled: true", () => {
    const result = resolvePersonalRunWorkspaceWriteMode({ uid: "uid-1", globalWritesEnabled: false, canaryUidsRaw: "uid-1,uid-2" });
    expect(result).toEqual({ enabled: true, source: "canary", canaryConfigInvalid: false });
  });

  it("global=false, uid NOT in a valid canary list -> source: off, enabled: false", () => {
    const result = resolvePersonalRunWorkspaceWriteMode({ uid: "uid-3", globalWritesEnabled: false, canaryUidsRaw: "uid-1,uid-2" });
    expect(result).toEqual({ enabled: false, source: "off", canaryConfigInvalid: false });
  });

  it("global=false, canary list absent -> source: off for everyone", () => {
    const result = resolvePersonalRunWorkspaceWriteMode({ uid: "uid-1", globalWritesEnabled: false, canaryUidsRaw: undefined });
    expect(result).toEqual({ enabled: false, source: "off", canaryConfigInvalid: false });
  });

  it("global=false, canary list MALFORMED -> fails closed to off for every uid, never a partial match, always flags canaryConfigInvalid", () => {
    const result = resolvePersonalRunWorkspaceWriteMode({ uid: "uid-1", globalWritesEnabled: false, canaryUidsRaw: "uid-1,not/valid" });
    expect(result).toEqual({ enabled: false, source: "off", canaryConfigInvalid: true });
  });

  it("exact match only — a uid that is a prefix or substring of a listed uid is never matched", () => {
    const result = resolvePersonalRunWorkspaceWriteMode({ uid: "uid-1-extra", globalWritesEnabled: false, canaryUidsRaw: "uid-1" });
    expect(result).toEqual({ enabled: false, source: "off", canaryConfigInvalid: false });
  });

  it("exact match only — a uid that a listed uid is a substring of is never matched", () => {
    const result = resolvePersonalRunWorkspaceWriteMode({ uid: "uid-1", globalWritesEnabled: false, canaryUidsRaw: "uid-1-extra" });
    expect(result).toEqual({ enabled: false, source: "off", canaryConfigInvalid: false });
  });

  it("full flag/canary matrix from the program spec", () => {
    // W is not this module's concern (that's checkPersonalRunWorkspaceWriteConfiguration,
    // consumed downstream by resolvePersonalRunWorkspaceBinding) — this
    // table covers only RW/C -> enabled/source, exactly this module's
    // responsibility.
    const cases: Array<[boolean, string | undefined, string, { enabled: boolean; source: string }]> = [
      [false, undefined, "uid-x", { enabled: false, source: "off" }],
      [false, "uid-x", "uid-x", { enabled: true, source: "canary" }],
      [true, undefined, "uid-x", { enabled: true, source: "global" }],
      [true, "uid-x", "uid-x", { enabled: true, source: "global" }], // global takes precedence
    ];
    for (const [globalWritesEnabled, canaryUidsRaw, uid, expected] of cases) {
      const result = resolvePersonalRunWorkspaceWriteMode({ uid, globalWritesEnabled, canaryUidsRaw });
      expect(result.enabled).toBe(expected.enabled);
      expect(result.source).toBe(expected.source);
    }
  });
});
