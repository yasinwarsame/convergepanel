/**
 * Multi-Reviewer Production-Readiness Hardening, Step 5.3/5.5 — pure,
 * zero-I/O safety-check logic shared by the seed script
 * (`scripts/seed-adaptive-multi-reviewer-e2e.ts`) and the cleanup script
 * (`scripts/cleanup-adaptive-multi-reviewer-e2e.ts`). No Firebase Admin
 * import here — these functions only ever inspect already-resolved
 * strings/booleans the caller supplies; they never read `process.env`
 * directly, so they stay independently unit-testable without mocking any
 * environment.
 *
 * CRITICAL, DISCLOSED CONSTRAINT (Step 5.1 audit): this repository has NO
 * separate dev/staging Firebase project — `FIREBASE_PROJECT_ID` (or its
 * hardcoded default, `"convergepanel"`) is the SAME project used in every
 * environment, local development included. There is therefore no
 * environment-based signal (`NODE_ENV`, a distinct project ID, etc.) that
 * can reliably prove "this is safe to seed." The safety model here
 * compensates with explicit, redundant operator confirmation instead of
 * environment inference: an allow-flag AND a project-ID confirmation that
 * must match the ACTUALLY resolved project, both required, neither
 * sufficient alone. `NODE_ENV`/`VERCEL_ENV` checks are added as a THIRD,
 * defense-in-depth layer — deliberately not the primary defense, since
 * they cannot distinguish a developer's local shell from anything else in
 * this codebase's actual deployment setup.
 */

/** Every seeded document's identifying fields carry this exact prefix — never reused for any real team/user/run. */
export const GOVERNANCE_SEED_NAMESPACE = "gov-e2e-seed";

export function seedId(scenario: string, suffix: string): string {
  return `${GOVERNANCE_SEED_NAMESPACE}-${scenario}-${suffix}`;
}

/** True only for the exact literal `"true"` — matches every other boolean env-flag convention in this codebase (`lib/env.ts`). */
export function isSeedExplicitlyAllowed(allowFlagValue: string | undefined): boolean {
  return allowFlagValue === "true";
}

export type SeedGuardFailureReason =
  | "allow_flag_missing"
  | "project_confirmation_missing"
  | "project_confirmation_mismatch"
  | "node_env_production"
  | "vercel_env_present";

export type SeedGuardResult = { ok: true } | { ok: false; reason: SeedGuardFailureReason; message: string };

/**
 * The single, shared gate both scripts call before performing ANY write
 * (seed or cleanup). Every check is independent and fails closed — the
 * first failing check wins, none are skipped by an earlier pass.
 */
export function checkSeedGuard(args: {
  allowFlagValue: string | undefined;
  resolvedProjectId: string;
  confirmedProjectId: string | undefined;
  nodeEnv: string | undefined;
  vercelEnv: string | undefined;
}): SeedGuardResult {
  if (!isSeedExplicitlyAllowed(args.allowFlagValue)) {
    return {
      ok: false,
      reason: "allow_flag_missing",
      message: "Refusing to run: set ALLOW_NON_PROD_GOVERNANCE_SEED=true explicitly to acknowledge this writes real Firestore documents.",
    };
  }
  if (!args.confirmedProjectId) {
    return {
      ok: false,
      reason: "project_confirmation_missing",
      message: `Refusing to run: pass --confirm-project=${args.resolvedProjectId} to explicitly confirm the target Firebase project.`,
    };
  }
  if (args.confirmedProjectId !== args.resolvedProjectId) {
    return {
      ok: false,
      reason: "project_confirmation_mismatch",
      message: `Refusing to run: --confirm-project=${args.confirmedProjectId} does not match the actually resolved project (${args.resolvedProjectId}). This is very likely a mistake — re-check which project you intend to target.`,
    };
  }
  // Defense-in-depth only (see the module doc comment above) — this
  // repository's single-project setup means the primary defense is
  // ALWAYS the two explicit checks above, never this one.
  if (args.nodeEnv === "production") {
    return {
      ok: false,
      reason: "node_env_production",
      message: "Refusing to run: NODE_ENV=production. This script must never run against a production runtime.",
    };
  }
  if (args.vercelEnv !== undefined && args.vercelEnv !== "") {
    return {
      ok: false,
      reason: "vercel_env_present",
      message: "Refusing to run: a VERCEL_ENV value is present, indicating this is executing inside a Vercel build/runtime, never a local operator shell.",
    };
  }
  return { ok: true };
}

/**
 * Pure argv parser shared by both scripts. `--dry-run` (seed script —
 * explicit opt-IN to previewing without writing) and `--delete` (cleanup
 * script — explicit opt-IN to actually deleting; cleanup's default with
 * NEITHER flag is always a dry-run/list-only preview, per Step 5.5's own
 * "dry-run default" requirement) are deliberately separate flags for two
 * different scripts with opposite defaults — never conflated into one.
 * `--yes` skips the interactive "type yes" confirmation prompt but never
 * skips any of the other guards (allow-flag, project confirmation,
 * environment checks all still apply). No I/O.
 */
export function parseSeedCliArgs(argv: readonly string[]): {
  dryRun: boolean;
  delete: boolean;
  cleanup: boolean;
  confirmProjectId: string | undefined;
  skipPrompt: boolean;
} {
  let confirmProjectId: string | undefined;
  let dryRun = false;
  let deleteFlag = false;
  let cleanup = false;
  let skipPrompt = false;
  for (const arg of argv) {
    if (arg === "--dry-run") dryRun = true;
    else if (arg === "--delete") deleteFlag = true;
    else if (arg === "--cleanup") cleanup = true;
    else if (arg === "--yes") skipPrompt = true;
    else if (arg.startsWith("--confirm-project=")) confirmProjectId = arg.slice("--confirm-project=".length);
  }
  return { dryRun, delete: deleteFlag, cleanup, confirmProjectId, skipPrompt };
}

/**
 * True only for a document ID/path that lives entirely within the seed
 * namespace — the cleanup script's own last line of defense against ever
 * deleting a real document, checked independently of whatever query
 * produced the candidate path.
 */
export function isWithinSeedNamespace(idOrPath: string): boolean {
  return idOrPath.includes(GOVERNANCE_SEED_NAMESPACE);
}
