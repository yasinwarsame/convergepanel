/**
 * Existing-User Personal Workspace Provisioning, Phase 2B —
 * checkProvisioningGuard() / parseProvisioningCliArgs() tests.
 */

import { checkProvisioningGuard, isProvisioningExplicitlyAllowed, parseProvisioningCliArgs } from "@/lib/workspaces/provisioningSafety";

const VALID_ARGS = {
  allowFlagValue: "true",
  resolvedProjectId: "convergepanel",
  confirmedProjectId: "convergepanel",
  nodeEnv: "development",
  vercelEnv: undefined,
};

describe("isProvisioningExplicitlyAllowed", () => {
  it.each(["true", "TRUE", "1", "yes", undefined, ""])("only the exact literal \"true\" allows — rejects: %s", (value) => {
    expect(isProvisioningExplicitlyAllowed(value)).toBe(value === "true");
  });
});

describe("checkProvisioningGuard", () => {
  it("passes with all conditions satisfied", () => {
    expect(checkProvisioningGuard(VALID_ARGS)).toEqual({ ok: true });
  });

  it("fails when the allow flag is missing", () => {
    const result = checkProvisioningGuard({ ...VALID_ARGS, allowFlagValue: undefined });
    expect(result).toEqual(expect.objectContaining({ ok: false, reason: "allow_flag_missing" }));
  });

  it("fails when --confirm-project is missing", () => {
    const result = checkProvisioningGuard({ ...VALID_ARGS, confirmedProjectId: undefined });
    expect(result).toEqual(expect.objectContaining({ ok: false, reason: "project_confirmation_missing" }));
  });

  it("fails when --confirm-project does not match the resolved project", () => {
    const result = checkProvisioningGuard({ ...VALID_ARGS, confirmedProjectId: "some-other-project" });
    expect(result).toEqual(expect.objectContaining({ ok: false, reason: "project_confirmation_mismatch" }));
  });

  it("fails when NODE_ENV=production", () => {
    const result = checkProvisioningGuard({ ...VALID_ARGS, nodeEnv: "production" });
    expect(result).toEqual(expect.objectContaining({ ok: false, reason: "node_env_production" }));
  });

  it("fails when VERCEL_ENV is present", () => {
    const result = checkProvisioningGuard({ ...VALID_ARGS, vercelEnv: "production" });
    expect(result).toEqual(expect.objectContaining({ ok: false, reason: "vercel_env_present" }));
  });

  it("the allow-flag check always wins first, even if other conditions also fail", () => {
    const result = checkProvisioningGuard({
      allowFlagValue: undefined,
      resolvedProjectId: "convergepanel",
      confirmedProjectId: undefined,
      nodeEnv: "production",
      vercelEnv: "production",
    });
    expect(result).toEqual(expect.objectContaining({ reason: "allow_flag_missing" }));
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

  it("parses --page-size and --concurrency as numbers, with sane defaults otherwise", () => {
    const args = parseProvisioningCliArgs(["--page-size=100", "--concurrency=8"]);
    expect(args.pageSize).toBe(100);
    expect(args.concurrency).toBe(8);
    const defaults = parseProvisioningCliArgs([]);
    expect(defaults.pageSize).toBeGreaterThan(0);
    expect(defaults.concurrency).toBeGreaterThan(0);
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
