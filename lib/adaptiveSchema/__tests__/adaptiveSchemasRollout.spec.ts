/**
 * Adaptive Result Schema System, Phase 9D.0-A —
 * parseAdaptiveSchemasCanaryUids() / resolveAdaptiveSchemasAdmission()
 * tests. Structural mirror of
 * lib/workspaces/__tests__/approvalWorkflowRollout.spec.ts — same
 * parsing/precedence rules apply here, since this module is a deliberate
 * structural copy of that one for a separate rollout axis.
 */

import { MAX_ADAPTIVE_SCHEMAS_CANARY_UIDS, parseAdaptiveSchemasCanaryUids, resolveAdaptiveSchemasAdmission } from "@/lib/adaptiveSchema/adaptiveSchemasRollout";

describe("parseAdaptiveSchemasCanaryUids", () => {
  it("env absent -> valid, empty set", () => {
    expect(parseAdaptiveSchemasCanaryUids(undefined)).toEqual({ ok: true, uids: new Set() });
  });

  it("env empty string -> valid, empty set", () => {
    expect(parseAdaptiveSchemasCanaryUids("")).toEqual({ ok: true, uids: new Set() });
  });

  it("env whitespace-only -> valid, empty set", () => {
    expect(parseAdaptiveSchemasCanaryUids("   \t  ")).toEqual({ ok: true, uids: new Set() });
  });

  it("one valid uid", () => {
    expect(parseAdaptiveSchemasCanaryUids("uid-1")).toEqual({ ok: true, uids: new Set(["uid-1"]) });
  });

  it("multiple valid uids", () => {
    expect(parseAdaptiveSchemasCanaryUids("uid-1,uid-2,uid-3")).toEqual({ ok: true, uids: new Set(["uid-1", "uid-2", "uid-3"]) });
  });

  it("duplicate valid uids deduplicate safely", () => {
    expect(parseAdaptiveSchemasCanaryUids("uid-1,uid-2,uid-1,uid-2")).toEqual({ ok: true, uids: new Set(["uid-1", "uid-2"]) });
  });

  it("surrounding whitespace around each entry is trimmed", () => {
    expect(parseAdaptiveSchemasCanaryUids("  uid-1 , uid-2  ")).toEqual({ ok: true, uids: new Set(["uid-1", "uid-2"]) });
  });

  it("a trailing comma produces no phantom empty entry", () => {
    expect(parseAdaptiveSchemasCanaryUids("uid-1,uid-2,")).toEqual({ ok: true, uids: new Set(["uid-1", "uid-2"]) });
  });

  it("a single malformed uid (path separator) invalidates the WHOLE list, not just that entry", () => {
    expect(parseAdaptiveSchemasCanaryUids("uid-1,not/a/uid,uid-2")).toEqual({ ok: false, reason: "malformed_entry" });
  });

  it('a literal "all" entry parses as an ordinary uid-shaped string, not a special wildcard token — see the resolver test for proof it still requires an exact match', () => {
    expect(parseAdaptiveSchemasCanaryUids("all")).toEqual({ ok: true, uids: new Set(["all"]) });
  });

  it(`more than ${MAX_ADAPTIVE_SCHEMAS_CANARY_UIDS} distinct uids -> too_many_entries`, () => {
    const uids = Array.from({ length: MAX_ADAPTIVE_SCHEMAS_CANARY_UIDS + 1 }, (_, i) => `uid-${i}`).join(",");
    expect(parseAdaptiveSchemasCanaryUids(uids)).toEqual({ ok: false, reason: "too_many_entries" });
  });

  it(`exactly ${MAX_ADAPTIVE_SCHEMAS_CANARY_UIDS} distinct uids is still valid`, () => {
    const uids = Array.from({ length: MAX_ADAPTIVE_SCHEMAS_CANARY_UIDS }, (_, i) => `uid-${i}`).join(",");
    expect(parseAdaptiveSchemasCanaryUids(uids).ok).toBe(true);
  });

  it(`reuses the same proven cohort ceiling as the Team Workspaces / Approval Workflow canaries (${MAX_ADAPTIVE_SCHEMAS_CANARY_UIDS})`, () => {
    expect(MAX_ADAPTIVE_SCHEMAS_CANARY_UIDS).toBe(10);
  });
});

describe("resolveAdaptiveSchemasAdmission", () => {
  it("no env at all -> not admitted, source off", () => {
    const mode = resolveAdaptiveSchemasAdmission({ uid: "any-uid", globalEnabled: false, canaryUidsRaw: undefined });
    expect(mode).toEqual({ admitted: false, source: "off", canaryConfigInvalid: false });
  });

  it("global=true -> admitted regardless of canary (backward compatible with today's global-only behavior)", () => {
    const mode = resolveAdaptiveSchemasAdmission({ uid: "any-uid", globalEnabled: true, canaryUidsRaw: undefined });
    expect(mode).toEqual({ admitted: true, source: "global", canaryConfigInvalid: false });
  });

  it("SECURITY: global=true + malformed canary -> STILL admitted (global always wins), but canaryConfigInvalid surfaced", () => {
    const mode = resolveAdaptiveSchemasAdmission({ uid: "any-uid", globalEnabled: true, canaryUidsRaw: "not/a/uid" });
    expect(mode.admitted).toBe(true);
    expect(mode.source).toBe("global");
    expect(mode.canaryConfigInvalid).toBe(true);
  });

  it("exact uid match in a valid canary list -> admitted, source canary", () => {
    const mode = resolveAdaptiveSchemasAdmission({ uid: "uid-1", globalEnabled: false, canaryUidsRaw: "uid-1,uid-2" });
    expect(mode).toEqual({ admitted: true, source: "canary", canaryConfigInvalid: false });
  });

  it("SECURITY: non-matching uid -> not admitted", () => {
    const mode = resolveAdaptiveSchemasAdmission({ uid: "uid-3", globalEnabled: false, canaryUidsRaw: "uid-1,uid-2" });
    expect(mode.admitted).toBe(false);
  });

  it("SECURITY: prefix/suffix match is never sufficient", () => {
    expect(resolveAdaptiveSchemasAdmission({ uid: "uid-10", globalEnabled: false, canaryUidsRaw: "uid-1" }).admitted).toBe(false);
    expect(resolveAdaptiveSchemasAdmission({ uid: "x-uid-1", globalEnabled: false, canaryUidsRaw: "uid-1" }).admitted).toBe(false);
  });

  it('SECURITY: a literal "all" entry never means everyone — only an exact-matching uid is admitted', () => {
    expect(resolveAdaptiveSchemasAdmission({ uid: "some-other-uid", globalEnabled: false, canaryUidsRaw: "all" }).admitted).toBe(false);
    expect(resolveAdaptiveSchemasAdmission({ uid: "all", globalEnabled: false, canaryUidsRaw: "all" }).admitted).toBe(true); // only because the literal string "all" happens to be this caller's actual uid
  });

  it("SECURITY: global=false + malformed canary -> fails closed, never admits everyone", () => {
    const mode = resolveAdaptiveSchemasAdmission({ uid: "any-uid", globalEnabled: false, canaryUidsRaw: "not/a/uid" });
    expect(mode.admitted).toBe(false);
    expect(mode.source).toBe("off");
    expect(mode.canaryConfigInvalid).toBe(true);
  });

  it("SECURITY: this rollout is independent of Team Workspaces and Approval Workflow — the resolver never reads or infers either, proven by the function signature itself accepting only adaptive-schema-specific args", () => {
    const mode = resolveAdaptiveSchemasAdmission({ uid: "uid-1", globalEnabled: false, canaryUidsRaw: undefined });
    expect(mode.admitted).toBe(false); // admission alone never implies Team Workspace or Approval Workflow access — those remain the route's OWN separate gates
  });
});
