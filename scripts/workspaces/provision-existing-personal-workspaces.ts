/**
 * Existing-User Personal Workspace Provisioning, Phase 2B — the bulk CLI.
 *
 * Enumerates Firebase Auth users (canonical population — see
 * lib/workspaces/provisioningEligibility.ts's doc comment for why, not
 * `users/{uid}` Firestore docs), classifies eligibility, and either
 * previews (`--dry-run`, the default) or actually provisions
 * (`--execute`) a Personal Workspace for each eligible user — by calling
 * the already-production-proven `ensurePersonalWorkspace()` /
 * `getWorkspace()`. This script itself contains NO deterministic-id,
 * create, conflict, pagination, or concurrency logic — all of that lives
 * in lib/workspaces/existingUserProvisioning.ts and
 * lib/workspaces/existingUserProvisioningRun.ts (the latter is
 * dependency-injection-tested against fake multi-page fixtures; this
 * file's only job is wiring the real `adminAuth.listUsers` binding,
 * parsing argv, running the safety guards, and writing the result file).
 *
 * Run via the `workspaces:provision-existing` npm script (see
 * package.json) — that script wires the required `--conditions=react-server`
 * flag (resolves `server-only`-guarded imports to a no-op, via that
 * package's own official export condition — never a custom patch) and
 * the `-r ./scripts/workspaces/register-path-alias.js` preload (resolves
 * the `@/*` path alias, since `tsconfig-paths` needs a `baseUrl` this
 * repo's tsconfig.json deliberately doesn't set for Next.js's own sake).
 *
 * Usage:
 *   npm run workspaces:provision-existing -- --dry-run
 *   npm run workspaces:provision-existing -- --execute --confirm-project=convergepanel
 *
 * Safety ordering (both modes validate project identity + exclusions
 * before ANY enumeration; only --execute additionally requires the
 * allow-flag/interactive-confirm gate — see checkProvisioningGuard()'s
 * doc comment for why dry-run needs project-identity validation too: an
 * enumeration against the wrong project would make the whole report
 * meaningless, not just unsafe):
 *   parse CLI -> validate concurrency -> validate exclusions
 *   -> resolve + validate actual Firebase project identity
 *   -> [execute only] confirm-project match -> allow-flag -> interactive yes
 *   -> enumerate -> provision/discover
 *
 * Resumability: no persisted Firestore checkpoint document is used —
 * `ensurePersonalWorkspace()` is fully idempotent, so a full re-run is
 * always safe and cheap (already-provisioned users simply report
 * `existing` again, at the cost of one extra read each). For very large
 * populations, this script also prints the current Auth `pageToken`
 * after every completed page — an operator can pass that back via
 * `--start-page-token=<token>` to resume from exactly that point rather
 * than re-scanning from the beginning. Both strategies are safe; which
 * to use is an operator choice based on population size and cost
 * tolerance (documented in docs/workspaces/architecture.md). A run that
 * fails partway through Auth enumeration itself is never silently lost —
 * see runExistingUserProvisioning()'s `status: "incomplete"` handling
 * below; this script always writes a result artifact, whether the run
 * completed or not, and exits non-zero whenever it didn't.
 */

// Load .env.local BEFORE importing anything that touches Firebase Admin —
// matches scripts/seed-adaptive-multi-reviewer-e2e.ts's exact convention.
// Uses require() (not `import`) specifically so it executes at this exact
// textual position in the compiled CommonJS output, ahead of the
// lib/firebase/admin import below.
const dotenv = require("dotenv");
const nodePath = require("path");
dotenv.config({ path: nodePath.resolve(__dirname, "../../.env.local") });

import "server-only";
import { adminAuth, FIREBASE_PROJECT_ID, getInitializedFirebaseProjectId } from "@/lib/firebase/admin";
import { runExistingUserProvisioning, type ListUsersPage, type RunProvisioningResult } from "@/lib/workspaces/existingUserProvisioningRun";
import { loadExclusionSet, validateExclusionUids, type AuthUserForEligibility } from "@/lib/workspaces/provisioningEligibility";
import {
  checkProjectIdentityConsistency,
  checkProvisioningGuard,
  parseProvisioningCliArgs,
  validateProvisioningConcurrency,
} from "@/lib/workspaces/provisioningSafety";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";

async function confirmInteractively(message: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${message} Type "yes" to continue: `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "yes");
    });
  });
}

async function main() {
  if (!adminAuth) {
    console.error("Firebase Admin Auth is not available — check credentials.");
    process.exit(1);
  }

  const args = parseProvisioningCliArgs(process.argv.slice(2));
  const dryRun = !args.execute;

  const concurrencyCheck = validateProvisioningConcurrency(args.concurrency);
  if (!concurrencyCheck.ok) {
    console.error(concurrencyCheck.message);
    process.exit(1);
  }

  let excludedUids: Set<string>;
  try {
    excludedUids = loadExclusionSet(args.excludeUids, args.excludeFilePath);
  } catch (e: any) {
    console.error(`Refusing to proceed: ${e?.message ?? e}. An exclusion file that can't be loaded must never be silently treated as "no exclusions."`);
    process.exit(1);
  }
  const exclusionCheck = validateExclusionUids(excludedUids);
  if (!exclusionCheck.ok) {
    console.error(exclusionCheck.message);
    process.exit(1);
  }

  // Resolved and validated for BOTH dry-run and execute — an enumeration
  // against the wrong project makes a dry-run report meaningless, not
  // just an execute run unsafe. Never overridable by --yes.
  const identityCheck = checkProjectIdentityConsistency({
    envProjectId: FIREBASE_PROJECT_ID,
    actualProjectId: getInitializedFirebaseProjectId(),
  });
  if (!identityCheck.ok) {
    console.error(identityCheck.message);
    process.exit(1);
  }
  const actualProjectId = identityCheck.projectId;

  if (args.execute) {
    const guard = checkProvisioningGuard({
      allowFlagValue: process.env.ALLOW_WORKSPACE_PROVISIONING,
      actualProjectId,
      confirmedProjectId: args.confirmProjectId,
      nodeEnv: process.env.NODE_ENV,
      vercelEnv: process.env.VERCEL_ENV,
    });
    if (!guard.ok) {
      console.error(guard.message);
      process.exit(1);
    }
    if (!args.skipPrompt) {
      const confirmed = await confirmInteractively(
        `This will provision real Personal Workspace documents in Firebase project "${actualProjectId}".`
      );
      if (!confirmed) {
        console.log("Aborted.");
        process.exit(1);
      }
    }
  }

  const startedAt = new Date().toISOString();

  const listUsersPage = async (pageToken: string | undefined): Promise<ListUsersPage> => {
    const page = await adminAuth!.listUsers(args.pageSize, pageToken);
    const users: AuthUserForEligibility[] = page.users.map((u) => ({ uid: u.uid, disabled: u.disabled }));
    return { users, pageToken: page.pageToken || undefined };
  };

  let result: RunProvisioningResult;
  try {
    result = await runExistingUserProvisioning({
      dryRun,
      concurrency: concurrencyCheck.concurrency,
      excludedUids,
      startPageToken: args.startPageToken,
      listUsersPage,
      onPageComplete: (info) => {
        console.log(`[page complete] scanned=${info.scanned} eligible=${info.eligible} excluded=${info.excluded} nextPageToken=${info.nextPageToken ?? "(none — final page)"}`);
      },
    });
  } catch (unexpectedError: any) {
    // runExistingUserProvisioning() already absorbs the one failure mode
    // it knows how to describe safely (Auth-enumeration rejection) into a
    // status:"incomplete" result. Reaching this catch means something
    // genuinely unexpected happened — still write a best-effort artifact
    // rather than losing all trace of the run, per the same
    // never-silently-lose-partial-progress principle.
    console.error("PROVISIONING_SCRIPT_UNEXPECTED_ERROR:", unexpectedError?.message ?? unexpectedError);
    result = {
      status: "incomplete",
      totals: { scanned: 0, eligible: 0, excluded: 0 },
      counts: {},
      conflicts: [],
      failures: [],
      excludedRecords: [],
      lastPageToken: null,
      pageCount: 0,
      fatalError: { code: "enumeration_failed", message: "An unexpected error occurred before the run could complete. See script logs for detail." },
    };
  }

  const completedAt = new Date().toISOString();

  const report = {
    project: actualProjectId,
    dryRun,
    startedAt,
    completedAt,
    pageSize: args.pageSize,
    concurrency: concurrencyCheck.concurrency,
    startPageToken: args.startPageToken ?? null,
    ...result,
  };

  const outputPath = args.outputPath ?? path.join(process.cwd(), `workspace-provisioning-${startedAt.replace(/[:.]/g, "-")}.json`);
  let artifactWriteFailed = false;
  try {
    fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));
  } catch (writeError: any) {
    artifactWriteFailed = true;
    console.error(`WARNING: failed to write result artifact to ${outputPath} (${writeError?.message ?? writeError}). The run's outcome is only visible in the console output above.`);
  }

  console.log("");
  console.log(`Mode: ${dryRun ? "DRY RUN (no writes)" : "EXECUTE"}`);
  console.log(`Status: ${result.status.toUpperCase()}`);
  console.log(`Project: ${actualProjectId}`);
  console.log(`Scanned: ${result.totals.scanned}`);
  console.log(`Eligible: ${result.totals.eligible}`);
  console.log(`Excluded: ${result.totals.excluded}`);
  for (const [status, count] of Object.entries(result.counts)) {
    console.log(`  ${status}: ${count}`);
  }
  console.log(`Conflicts: ${result.conflicts.length}`);
  console.log(`Failed: ${result.failures.length}`);
  if (!artifactWriteFailed) console.log(`Result artifact: ${outputPath}`);

  if (result.status === "incomplete") {
    console.error(`Run did NOT complete (${result.fatalError?.code ?? "unknown_error"}: ${result.fatalError?.message ?? "no detail available"}). Do not treat these totals as full coverage.`);
    process.exit(1);
  }
  if (artifactWriteFailed) {
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("PROVISIONING_SCRIPT_ERROR:", e);
    process.exit(1);
  });
