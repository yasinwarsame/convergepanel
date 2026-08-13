/**
 * Existing-User Personal Workspace Provisioning, Phase 2B — pure, zero-I/O
 * safety-check logic for the bulk provisioning CLI
 * (scripts/workspaces/provision-existing-personal-workspaces.ts).
 * Deliberately mirrors the shape of
 * `lib/governance/adaptiveGovernanceSeedSafety.ts`'s already-established,
 * tested guard pattern rather than inventing a new one — same disclosed
 * constraint applies here: this repository has no separate dev/staging
 * Firebase project, so the primary defense is explicit, redundant operator
 * confirmation (an allow-flag AND a project-ID match), never environment
 * inference alone.
 *
 * This guard is checked ONLY before EXECUTE (mutating) mode. Dry-run mode
 * performs zero writes by construction (see
 * `lib/workspaces/existingUserProvisioning.ts`'s `discoverUserWorkspaceStatus`)
 * and needs no gate — mutation must require an explicit flag, never the
 * reverse.
 */

/** True only for the exact literal `"true"` — matches every other boolean env-flag convention in this codebase (`lib/env.ts`, `isSeedExplicitlyAllowed`). */
export function isProvisioningExplicitlyAllowed(allowFlagValue: string | undefined): boolean {
  return allowFlagValue === "true";
}

export type ProvisioningGuardFailureReason =
  | "allow_flag_missing"
  | "project_confirmation_missing"
  | "project_confirmation_mismatch"
  | "node_env_production"
  | "vercel_env_present";

export type ProvisioningGuardResult = { ok: true } | { ok: false; reason: ProvisioningGuardFailureReason; message: string };

export function checkProvisioningGuard(args: {
  allowFlagValue: string | undefined;
  resolvedProjectId: string;
  confirmedProjectId: string | undefined;
  nodeEnv: string | undefined;
  vercelEnv: string | undefined;
}): ProvisioningGuardResult {
  if (!isProvisioningExplicitlyAllowed(args.allowFlagValue)) {
    return {
      ok: false,
      reason: "allow_flag_missing",
      message: "Refusing to execute: set ALLOW_WORKSPACE_PROVISIONING=true explicitly to acknowledge this writes real Firestore documents.",
    };
  }
  if (!args.confirmedProjectId) {
    return {
      ok: false,
      reason: "project_confirmation_missing",
      message: `Refusing to execute: pass --confirm-project=${args.resolvedProjectId} to explicitly confirm the target Firebase project.`,
    };
  }
  if (args.confirmedProjectId !== args.resolvedProjectId) {
    return {
      ok: false,
      reason: "project_confirmation_mismatch",
      message: `Refusing to execute: --confirm-project=${args.confirmedProjectId} does not match the actually resolved project (${args.resolvedProjectId}). Re-check which project you intend to target.`,
    };
  }
  // Defense-in-depth only — see the module doc comment above. The primary
  // defense is always the two explicit checks above.
  if (args.nodeEnv === "production") {
    return {
      ok: false,
      reason: "node_env_production",
      message: "Refusing to execute: NODE_ENV=production. This script must never run against a production runtime.",
    };
  }
  if (args.vercelEnv !== undefined && args.vercelEnv !== "") {
    return {
      ok: false,
      reason: "vercel_env_present",
      message: "Refusing to execute: a VERCEL_ENV value is present, indicating this is executing inside a Vercel build/runtime, never a local operator shell.",
    };
  }
  return { ok: true };
}

export interface ProvisioningCliArgs {
  execute: boolean;
  confirmProjectId: string | undefined;
  pageSize: number;
  concurrency: number;
  excludeUids: string[];
  excludeFilePath: string | undefined;
  startPageToken: string | undefined;
  outputPath: string | undefined;
  skipPrompt: boolean;
}

const DEFAULT_PAGE_SIZE = 1000; // matches Firebase Admin SDK's own listUsers() max/default page size
const DEFAULT_CONCURRENCY = 5; // conservative starting point per the program spec's "5-10 concurrent ensure calls"

/**
 * Pure argv parser. `--dry-run` is the implicit default (no flag needed);
 * `--execute` is the sole, explicit opt-in to mutation. There is no way to
 * accidentally reach execute mode via a missing/misspelled flag — anything
 * other than the exact literal `--execute` leaves `execute: false`.
 */
export function parseProvisioningCliArgs(argv: readonly string[]): ProvisioningCliArgs {
  let execute = false;
  let confirmProjectId: string | undefined;
  let pageSize = DEFAULT_PAGE_SIZE;
  let concurrency = DEFAULT_CONCURRENCY;
  const excludeUids: string[] = [];
  let excludeFilePath: string | undefined;
  let startPageToken: string | undefined;
  let outputPath: string | undefined;
  let skipPrompt = false;

  for (const arg of argv) {
    if (arg === "--execute") execute = true;
    else if (arg === "--yes") skipPrompt = true;
    else if (arg.startsWith("--confirm-project=")) confirmProjectId = arg.slice("--confirm-project=".length);
    else if (arg.startsWith("--page-size=")) pageSize = Number(arg.slice("--page-size=".length)) || DEFAULT_PAGE_SIZE;
    else if (arg.startsWith("--concurrency=")) concurrency = Number(arg.slice("--concurrency=".length)) || DEFAULT_CONCURRENCY;
    else if (arg.startsWith("--exclude-uid=")) excludeUids.push(arg.slice("--exclude-uid=".length));
    else if (arg.startsWith("--exclude-file=")) excludeFilePath = arg.slice("--exclude-file=".length);
    else if (arg.startsWith("--start-page-token=")) startPageToken = arg.slice("--start-page-token=".length);
    else if (arg.startsWith("--output=")) outputPath = arg.slice("--output=".length);
  }

  return { execute, confirmProjectId, pageSize, concurrency, excludeUids, excludeFilePath, startPageToken, outputPath, skipPrompt };
}
