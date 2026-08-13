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
 * `checkProvisioningGuard()` is checked ONLY before EXECUTE (mutating)
 * mode. Dry-run mode performs zero writes by construction (see
 * `lib/workspaces/existingUserProvisioning.ts`'s `discoverUserWorkspaceStatus`)
 * and needs no allow-flag/confirm-project/interactive gate — mutation must
 * require an explicit flag, never the reverse.
 *
 * `checkProjectIdentityConsistency()`, by contrast, runs for BOTH dry-run
 * and execute: a dry-run report is only trustworthy if it's known to have
 * enumerated the project the operator actually intended, so project
 * identity is validated before any enumeration in either mode.
 */

/** True only for the exact literal `"true"` — matches every other boolean env-flag convention in this codebase (`lib/env.ts`, `isSeedExplicitlyAllowed`). */
export function isProvisioningExplicitlyAllowed(allowFlagValue: string | undefined): boolean {
  return allowFlagValue === "true";
}

export type ProjectIdentityFailureReason = "actual_project_unresolved" | "firebase_project_configuration_mismatch";

export type ProjectIdentityResult =
  | { ok: true; projectId: string }
  | { ok: false; reason: ProjectIdentityFailureReason; message: string };

/**
 * Resolves and validates the actual Firebase project this run would
 * target, independent of anything the operator passes on the CLI.
 * `envProjectId` is `FIREBASE_PROJECT_ID` (`lib/firebase/admin.ts`'s
 * fallback-to-`"convergepanel"` constant); `actualProjectId` is read back
 * from the ALREADY-INITIALIZED Admin SDK app itself
 * (`getInitializedFirebaseProjectId()`), never re-derived from another
 * environment variable. If the initialized app's project can't be
 * determined at all, or if it disagrees with `FIREBASE_PROJECT_ID`
 * (a "split-brain" misconfiguration — e.g. `FIREBASE_SERVICE_ACCOUNT_BASE64`
 * embeds a different `project_id` than `FIREBASE_PROJECT_ID` was set to),
 * this fails closed. No `--yes` or interactive prompt can override either
 * failure — both are checked before any operator-facing confirmation step
 * even runs.
 */
export function checkProjectIdentityConsistency(args: { envProjectId: string; actualProjectId: string | undefined }): ProjectIdentityResult {
  if (!args.actualProjectId) {
    return {
      ok: false,
      reason: "actual_project_unresolved",
      message: "Refusing to proceed: could not determine the actual Firebase project from the initialized Admin SDK app. Aborting rather than assuming a project identity.",
    };
  }
  if (args.envProjectId !== args.actualProjectId) {
    return {
      ok: false,
      reason: "firebase_project_configuration_mismatch",
      message: `Refusing to proceed: FIREBASE_PROJECT_ID ("${args.envProjectId}") does not match the actual initialized Firebase project ("${args.actualProjectId}"). This indicates a misconfigured environment — aborting rather than guessing which one is correct.`,
    };
  }
  return { ok: true, projectId: args.actualProjectId };
}

export type ProvisioningGuardFailureReason =
  | "project_confirmation_missing"
  | "project_confirmation_mismatch"
  | "allow_flag_missing"
  | "node_env_production"
  | "vercel_env_present";

export type ProvisioningGuardResult = { ok: true } | { ok: false; reason: ProvisioningGuardFailureReason; message: string };

/**
 * Checked only after `checkProjectIdentityConsistency()` has already
 * passed — `args.actualProjectId` here is that already-validated project
 * identity, not a separately-trusted input. `--confirm-project` is
 * compared against this actual identity, never against
 * `FIREBASE_PROJECT_ID` directly, so a split-brain env misconfiguration
 * can never be papered over by an operator confirming the (wrong) env
 * value.
 */
export function checkProvisioningGuard(args: {
  allowFlagValue: string | undefined;
  actualProjectId: string;
  confirmedProjectId: string | undefined;
  nodeEnv: string | undefined;
  vercelEnv: string | undefined;
}): ProvisioningGuardResult {
  if (!args.confirmedProjectId) {
    return {
      ok: false,
      reason: "project_confirmation_missing",
      message: `Refusing to execute: pass --confirm-project=${args.actualProjectId} to explicitly confirm the target Firebase project.`,
    };
  }
  if (args.confirmedProjectId !== args.actualProjectId) {
    return {
      ok: false,
      reason: "project_confirmation_mismatch",
      message: `Refusing to execute: --confirm-project=${args.confirmedProjectId} does not match the actual initialized Firebase project (${args.actualProjectId}). Re-check which project you intend to target.`,
    };
  }
  if (!isProvisioningExplicitlyAllowed(args.allowFlagValue)) {
    return {
      ok: false,
      reason: "allow_flag_missing",
      message: "Refusing to execute: set ALLOW_WORKSPACE_PROVISIONING=true explicitly to acknowledge this writes real Firestore documents.",
    };
  }
  // Defense-in-depth only — see the module doc comment above. The primary
  // defense is always the explicit checks above.
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

export const MIN_PROVISIONING_CONCURRENCY = 1;
/** Conservative operational ceiling — not a Firebase/Firestore hard limit, an intentional guardrail against operator error (e.g. a typo'd extra zero) blowing past the "5-10 concurrent" spec by orders of magnitude. */
export const MAX_PROVISIONING_CONCURRENCY = 20;

export type ConcurrencyValidationResult = { ok: true; concurrency: number } | { ok: false; reason: "invalid_concurrency"; message: string };

/**
 * Rejects out-of-range or non-integer concurrency explicitly rather than
 * silently clamping — a bulk-mutation safety knob should fail loudly on
 * clearly-wrong operator input, not quietly substitute a different value
 * the operator never asked for.
 */
export function validateProvisioningConcurrency(concurrency: number): ConcurrencyValidationResult {
  if (!Number.isInteger(concurrency) || concurrency < MIN_PROVISIONING_CONCURRENCY || concurrency > MAX_PROVISIONING_CONCURRENCY) {
    return {
      ok: false,
      reason: "invalid_concurrency",
      message: `Refusing to proceed: --concurrency must be an integer between ${MIN_PROVISIONING_CONCURRENCY} and ${MAX_PROVISIONING_CONCURRENCY} (got ${concurrency}).`,
    };
  }
  return { ok: true, concurrency };
}

/**
 * Pure argv parser. `--dry-run` is the implicit default (no flag needed);
 * `--execute` is the sole, explicit opt-in to mutation. There is no way to
 * accidentally reach execute mode via a missing/misspelled flag — anything
 * other than the exact literal `--execute` leaves `execute: false`.
 *
 * `--concurrency`'s parsed value is intentionally left as-is (including
 * `NaN` for malformed input) rather than silently substituted with the
 * default — validation (and the explicit `invalid_concurrency` rejection)
 * happens separately in `validateProvisioningConcurrency()`, called by the
 * CLI script right after parsing. Only a MISSING `--concurrency` flag
 * falls back to `DEFAULT_CONCURRENCY`; a present-but-malformed one must be
 * caught, not defaulted away.
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
    else if (arg.startsWith("--concurrency=")) concurrency = Number(arg.slice("--concurrency=".length));
    else if (arg.startsWith("--exclude-uid=")) excludeUids.push(arg.slice("--exclude-uid=".length));
    else if (arg.startsWith("--exclude-file=")) excludeFilePath = arg.slice("--exclude-file=".length);
    else if (arg.startsWith("--start-page-token=")) startPageToken = arg.slice("--start-page-token=".length);
    else if (arg.startsWith("--output=")) outputPath = arg.slice("--output=".length);
  }

  return { execute, confirmProjectId, pageSize, concurrency, excludeUids, excludeFilePath, startPageToken, outputPath, skipPrompt };
}
