/**
 * Multi-Reviewer Production-Readiness Hardening, Step 5.15 —
 * seed/cleanup safety-guard tests.
 */

import { checkSeedGuard, isSeedExplicitlyAllowed, parseSeedCliArgs, isWithinSeedNamespace, seedId, GOVERNANCE_SEED_NAMESPACE } from "@/lib/governance/adaptiveGovernanceSeedSafety";

const BASE = { allowFlagValue: "true", resolvedProjectId: "convergepanel", confirmedProjectId: "convergepanel", nodeEnv: "development", vercelEnv: undefined };

describe("isSeedExplicitlyAllowed", () => {
  it("is true only for the exact string 'true'", () => {
    expect(isSeedExplicitlyAllowed("true")).toBe(true);
    expect(isSeedExplicitlyAllowed("TRUE")).toBe(false);
    expect(isSeedExplicitlyAllowed("1")).toBe(false);
    expect(isSeedExplicitlyAllowed("yes")).toBe(false);
    expect(isSeedExplicitlyAllowed(undefined)).toBe(false);
    expect(isSeedExplicitlyAllowed("")).toBe(false);
  });
});

describe("checkSeedGuard — production environment refused", () => {
  it("refuses when NODE_ENV is production, even with every other check passing", () => {
    const result = checkSeedGuard({ ...BASE, nodeEnv: "production" });
    expect(result).toEqual({ ok: false, reason: "node_env_production", message: expect.any(String) });
  });

  it("refuses when a VERCEL_ENV value is present (any value — indicates a Vercel build/runtime, never a local shell)", () => {
    expect(checkSeedGuard({ ...BASE, vercelEnv: "preview" })).toEqual({ ok: false, reason: "vercel_env_present", message: expect.any(String) });
    expect(checkSeedGuard({ ...BASE, vercelEnv: "production" })).toEqual({ ok: false, reason: "vercel_env_present", message: expect.any(String) });
  });

  it("allows an empty-string VERCEL_ENV (treated as absent)", () => {
    expect(checkSeedGuard({ ...BASE, vercelEnv: "" })).toEqual({ ok: true });
  });
});

describe("checkSeedGuard — missing allow flag refused", () => {
  it("refuses when ALLOW_NON_PROD_GOVERNANCE_SEED is not set", () => {
    const result = checkSeedGuard({ ...BASE, allowFlagValue: undefined });
    expect(result).toEqual({ ok: false, reason: "allow_flag_missing", message: expect.any(String) });
  });

  it("refuses a truthy-looking but non-exact value", () => {
    expect(checkSeedGuard({ ...BASE, allowFlagValue: "1" })).toEqual({ ok: false, reason: "allow_flag_missing", message: expect.any(String) });
  });
});

describe("checkSeedGuard — wrong project confirmation refused", () => {
  it("refuses when no --confirm-project was passed at all", () => {
    const result = checkSeedGuard({ ...BASE, confirmedProjectId: undefined });
    expect(result).toEqual({ ok: false, reason: "project_confirmation_missing", message: expect.any(String) });
  });

  it("refuses when the confirmed project does not match the actually resolved project", () => {
    const result = checkSeedGuard({ ...BASE, confirmedProjectId: "some-other-project" });
    expect(result).toEqual({ ok: false, reason: "project_confirmation_mismatch", message: expect.any(String) });
  });
});

describe("checkSeedGuard — passes only when every check is satisfied", () => {
  it("returns ok:true when the allow flag, project confirmation, and environment are all safe", () => {
    expect(checkSeedGuard(BASE)).toEqual({ ok: true });
  });

  it("checks are independent — fixing only one of several failures still fails on the next", () => {
    const allBad = { allowFlagValue: undefined, resolvedProjectId: "convergepanel", confirmedProjectId: undefined, nodeEnv: "production", vercelEnv: "production" };
    // Only fixing the allow flag still fails on project confirmation next.
    const result = checkSeedGuard({ ...allBad, allowFlagValue: "true" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("project_confirmation_missing");
  });
});

describe("parseSeedCliArgs", () => {
  const DEFAULTS = { dryRun: false, delete: false, cleanup: false, confirmProjectId: undefined, skipPrompt: false };

  it("parses --dry-run, --delete, --cleanup, --yes, and --confirm-project=<id>", () => {
    expect(parseSeedCliArgs(["--dry-run"])).toEqual({ ...DEFAULTS, dryRun: true });
    expect(parseSeedCliArgs(["--delete"])).toEqual({ ...DEFAULTS, delete: true });
    expect(parseSeedCliArgs(["--cleanup"])).toEqual({ ...DEFAULTS, cleanup: true });
    expect(parseSeedCliArgs(["--yes"])).toEqual({ ...DEFAULTS, skipPrompt: true });
    expect(parseSeedCliArgs(["--confirm-project=convergepanel"])).toEqual({ ...DEFAULTS, confirmProjectId: "convergepanel" });
  });

  it("cleanup's default (no flags at all) never sets --delete — dry-run/list-only by default", () => {
    expect(parseSeedCliArgs([]).delete).toBe(false);
  });

  it("combines multiple flags", () => {
    expect(parseSeedCliArgs(["--delete", "--confirm-project=convergepanel", "--yes"])).toEqual({
      ...DEFAULTS,
      delete: true,
      confirmProjectId: "convergepanel",
      skipPrompt: true,
    });
  });

  it("ignores unrecognized arguments rather than throwing", () => {
    expect(() => parseSeedCliArgs(["--unknown-flag", "positional"])).not.toThrow();
  });
});

describe("seedId / isWithinSeedNamespace", () => {
  it("every generated ID contains the shared namespace prefix", () => {
    expect(seedId("team", "1")).toContain(GOVERNANCE_SEED_NAMESPACE);
    expect(seedId("run", "a-ready")).toContain(GOVERNANCE_SEED_NAMESPACE);
  });

  it("is deterministic — the same scenario/suffix always produces the same ID", () => {
    expect(seedId("team", "1")).toBe(seedId("team", "1"));
  });

  it("isWithinSeedNamespace correctly classifies seeded vs real IDs", () => {
    expect(isWithinSeedNamespace(seedId("team", "1"))).toBe(true);
    expect(isWithinSeedNamespace("team_abc123_1700000000000")).toBe(false);
    expect(isWithinSeedNamespace("run-a1b2c3d4-e5f6-7890")).toBe(false);
  });
});
