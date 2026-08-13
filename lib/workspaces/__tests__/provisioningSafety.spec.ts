/**
 * Existing-User Personal Workspace Provisioning, Phase 2B —
 * checkProjectIdentityConsistency() / checkProvisioningGuard() /
 * validateProvisioningConcurrency() / parseProvisioningCliArgs() tests.
 */

import {
  checkProjectIdentityConsistency,
  checkProvisioningGuard,
  isProvisioningExplicitlyAllowed,
  MAX_PROVISIONING_CONCURRENCY,
  MIN_PROVISIONING_CONCURRENCY,
  parseProvisioningCliArgs,
  validateProvisioningConcurrency,
} from "@/lib/workspaces/provisioningSafety";

describe("isProvisioningExplicitlyAllowed", () => {
  it.each(["true", "TRUE", "1", "yes", undefined, ""])("only the exact literal \"true\" allows — rejects: %s", (value) => {
    expect(isProvisioningExplicitlyAllowed(value)).toBe(value === "true");
  });
});

describe("checkProjectIdentityConsistency", () => {
  it("passes when the env constant and the actual initialized project agree", () => {
    const result = checkProjectIdentityConsistency({ envProjectId: "convergepanel", actualProjectId: "convergepanel" });
    expect(result).toEqual({ ok: true, projectId: "convergepanel" });
  });

  it("fails closed when the actual initialized project cannot be resolved at all", () => {
    const result = checkProjectIdentityConsistency({ envProjectId: "convergepanel", actualProjectId: undefined });
    expect(result).toEqual(expect.objectContaining({ ok: false, reason: "actual_project_unresolved" }));
  });

  it("detects split-brain: env constant says one project, the initialized Admin SDK is actually on another", () => {
    const result = checkProjectIdentityConsistency({ envProjectId: "convergepanel", actualProjectId: "some-other-project" });
    expect(result).toEqual(expect.objectContaining({ ok: false, reason: "firebase_project_configuration_mismatch" }));
  });

  it("split-brain is detected even when --confirm-project would separately match the (wrong) env value — this is the regression that matters", () => {
    // env project = A, initialized app project = B. An operator who passes
    // --confirm-project=A (matching the env constant they can see) must
    // still be blocked, because A is not what the SDK actually connected to.
    const result = checkProjectIdentityConsistency({ envProjectId: "A", actualProjectId: "B" });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("firebase_project_configuration_mismatch");
  });
});

describe("validateProvisioningConcurrency", () => {
  it.each([1, 5, MAX_PROVISIONING_CONCURRENCY])("accepts %d (in range)", (value) => {
    expect(validateProvisioningConcurrency(value)).toEqual({ ok: true, concurrency: value });
  });

  it.each([MAX_PROVISIONING_CONCURRENCY + 1, 0, -1, -100])("rejects %d (out of range) with invalid_concurrency", (value) => {
    const result = validateProvisioningConcurrency(value);
    expect(result).toEqual(expect.objectContaining({ ok: false, reason: "invalid_concurrency" }));
  });

  it("rejects NaN", () => {
    expect(validateProvisioningConcurrency(NaN)).toEqual(expect.objectContaining({ ok: false, reason: "invalid_concurrency" }));
  });

  it("rejects a decimal value — integer concurrency only", () => {
    expect(validateProvisioningConcurrency(2.5)).toEqual(expect.objectContaining({ ok: false, reason: "invalid_concurrency" }));
  });

  it("MIN/MAX constants are exported and consistent with the default (5) being in range", () => {
    expect(MIN_PROVISIONING_CONCURRENCY).toBe(1);
    expect(MAX_PROVISIONING_CONCURRENCY).toBeGreaterThanOrEqual(5);
  });
});

const VALID_GUARD_ARGS = {
  allowFlagValue: "true",
  actualProjectId: "convergepanel",
  confirmedProjectId: "convergepanel",
  nodeEnv: "development",
  vercelEnv: undefined,
};

describe("checkProvisioningGuard", () => {
  it("passes with all conditions satisfied", () => {
    expect(checkProvisioningGuard(VALID_GUARD_ARGS)).toEqual({ ok: true });
  });

  it("fails when --confirm-project is missing", () => {
    const result = checkProvisioningGuard({ ...VALID_GUARD_ARGS, confirmedProjectId: undefined });
    expect(result).toEqual(expect.objectContaining({ ok: false, reason: "project_confirmation_missing" }));
  });

  it("fails when --confirm-project does not match the actual initialized project", () => {
    const result = checkProvisioningGuard({ ...VALID_GUARD_ARGS, confirmedProjectId: "some-other-project" });
    expect(result).toEqual(expect.objectContaining({ ok: false, reason: "project_confirmation_mismatch" }));
  });

  it("fails when the allow flag is missing", () => {
    const result = checkProvisioningGuard({ ...VALID_GUARD_ARGS, allowFlagValue: undefined });
    expect(result).toEqual(expect.objectContaining({ ok: false, reason: "allow_flag_missing" }));
  });

  it("fails when NODE_ENV=production", () => {
    const result = checkProvisioningGuard({ ...VALID_GUARD_ARGS, nodeEnv: "production" });
    expect(result).toEqual(expect.objectContaining({ ok: false, reason: "node_env_production" }));
  });

  it("fails when VERCEL_ENV is present", () => {
    const result = checkProvisioningGuard({ ...VALID_GUARD_ARGS, vercelEnv: "production" });
    expect(result).toEqual(expect.objectContaining({ ok: false, reason: "vercel_env_present" }));
  });

  it("project-confirmation checks win first, even if other conditions also fail — project identity is validated before the mutation-allow gate", () => {
    const result = checkProvisioningGuard({
      allowFlagValue: undefined,
      actualProjectId: "convergepanel",
      confirmedProjectId: undefined,
      nodeEnv: "production",
      vercelEnv: "production",
    });
    expect(result).toEqual(expect.objectContaining({ reason: "project_confirmation_missing" }));
  });

  it("a confirmed project mismatch wins over a missing allow flag", () => {
    const result = checkProvisioningGuard({
      allowFlagValue: undefined,
      actualProjectId: "convergepanel",
      confirmedProjectId: "wrong-project",
      nodeEnv: "development",
      vercelEnv: undefined,
    });
    expect(result).toEqual(expect.objectContaining({ reason: "project_confirmation_mismatch" }));
  });
});

describe("parseProvisioningCliArgs", () => {
  it("defaults to dry-run (execute: false) with no flags", () => {
    expect(parseProvisioningCliArgs([]).execute).toBe(false);
  });

  it("--execute is the sole way to opt into mutation", () => {
    expect(parseProvisioningCliArgs(["--execute"]).execute).toBe(true);
  });

  it("an unrecognized or misspelled flag never accidentally enables execute", () => {
    expect(parseProvisioningCliArgs(["--exec", "--Execute", "--execute=true"]).execute).toBe(false);
  });

  it("parses --confirm-project", () => {
    expect(parseProvisioningCliArgs(["--confirm-project=convergepanel"]).confirmProjectId).toBe("convergepanel");
  });

  it("parses --page-size, with a sane default otherwise", () => {
    const args = parseProvisioningCliArgs(["--page-size=100"]);
    expect(args.pageSize).toBe(100);
    const defaults = parseProvisioningCliArgs([]);
    expect(defaults.pageSize).toBeGreaterThan(0);
  });

  it("defaults concurrency to 5 when --concurrency is absent entirely", () => {
    expect(parseProvisioningCliArgs([]).concurrency).toBe(5);
  });

  it("parses a well-formed --concurrency", () => {
    expect(parseProvisioningCliArgs(["--concurrency=8"]).concurrency).toBe(8);
  });

  it("does NOT silently substitute the default for a malformed --concurrency — preserves NaN for validateProvisioningConcurrency to reject", () => {
    expect(parseProvisioningCliArgs(["--concurrency=notanumber"]).concurrency).toBeNaN();
  });

  it("preserves an explicit out-of-range --concurrency value as-is (validation happens separately)", () => {
    expect(parseProvisioningCliArgs(["--concurrency=1000"]).concurrency).toBe(1000);
    expect(parseProvisioningCliArgs(["--concurrency=0"]).concurrency).toBe(0);
    expect(parseProvisioningCliArgs(["--concurrency=-5"]).concurrency).toBe(-5);
    expect(parseProvisioningCliArgs(["--concurrency=2.5"]).concurrency).toBe(2.5);
  });

  it("collects multiple --exclude-uid flags", () => {
    expect(parseProvisioningCliArgs(["--exclude-uid=a", "--exclude-uid=b"]).excludeUids).toEqual(["a", "b"]);
  });

  it("parses --exclude-file, --start-page-token, --output, --yes", () => {
    const args = parseProvisioningCliArgs(["--exclude-file=/tmp/x.txt", "--start-page-token=tok1", "--output=/tmp/out.json", "--yes"]);
    expect(args.excludeFilePath).toBe("/tmp/x.txt");
    expect(args.startPageToken).toBe("tok1");
    expect(args.outputPath).toBe("/tmp/out.json");
    expect(args.skipPrompt).toBe(true);
  });
});
