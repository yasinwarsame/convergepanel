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
 * parsing argv, running the safety guard, and writing the result file).
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
 * Resumability: no persisted Firestore checkpoint document is used —
 * `ensurePersonalWorkspace()` is fully idempotent, so a full re-run is
 * always safe and cheap (already-provisioned users simply report
 * `existing` again, at the cost of one extra read each). For very large
 * populations, this script also prints the current Auth `pageToken`
 * after every completed page — an operator can pass that back via
 * `--start-page-token=<token>` to resume from exactly that point rather
 * than re-scanning from the beginning. Both strategies are safe; which
 * to use is an operator choice based on population size and cost
 * tolerance (documented in docs/workspaces/architecture.md).
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
import { adminAuth, FIREBASE_PROJECT_ID } from "@/lib/firebase/admin";
import { runExistingUserProvisioning, type ListUsersPage } from "@/lib/workspaces/existingUserProvisioningRun";
import { parseExclusionList, type AuthUserForEligibility } from "@/lib/workspaces/provisioningEligibility";
import { checkProvisioningGuard, parseProvisioningCliArgs } from "@/lib/workspaces/provisioningSafety";
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

function loadExclusionSet(cliUids: string[], filePath: string | undefined): Set<string> {
  const set = new Set<string>(cliUids);
  if (filePath) {
    const contents = fs.readFileSync(filePath, "utf8");
    for (const uid of parseExclusionList(contents)) set.add(uid);
  }
  return set;
}

async function main() {
  if (!adminAuth) {
    console.error("Firebase Admin Auth is not available — check credentials.");
    process.exit(1);
  }

  const args = parseProvisioningCliArgs(process.argv.slice(2));
  const dryRun = !args.execute;

  if (args.execute) {
    const guard = checkProvisioningGuard({
      allowFlagValue: process.env.ALLOW_WORKSPACE_PROVISIONING,
      resolvedProjectId: FIREBASE_PROJECT_ID,
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
        `This will provision real Personal Workspace documents in Firebase project "${FIREBASE_PROJECT_ID}".`
      );
      if (!confirmed) {
        console.log("Aborted.");
        process.exit(1);
      }
    }
  }

  const excludedUids = loadExclusionSet(args.excludeUids, args.excludeFilePath);
  const startedAt = new Date().toISOString();

  const listUsersPage = async (pageToken: string | undefined): Promise<ListUsersPage> => {
    const page = await adminAuth!.listUsers(args.pageSize, pageToken);
    const users: AuthUserForEligibility[] = page.users.map((u) => ({ uid: u.uid, disabled: u.disabled }));
    return { users, pageToken: page.pageToken || undefined };
  };

  const result = await runExistingUserProvisioning({
    dryRun,
    concurrency: args.concurrency,
    excludedUids,
    startPageToken: args.startPageToken,
    listUsersPage,
    onPageComplete: (info) => {
      console.log(`[page complete] scanned=${info.scanned} eligible=${info.eligible} excluded=${info.excluded} nextPageToken=${info.nextPageToken ?? "(none — final page)"}`);
    },
  });

  const completedAt = new Date().toISOString();

  const report = {
    project: FIREBASE_PROJECT_ID,
    dryRun,
    startedAt,
    completedAt,
    pageSize: args.pageSize,
    concurrency: args.concurrency,
    startPageToken: args.startPageToken ?? null,
    ...result,
  };

  const outputPath = args.outputPath ?? path.join(process.cwd(), `workspace-provisioning-${startedAt.replace(/[:.]/g, "-")}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));

  console.log("");
  console.log(`Mode: ${dryRun ? "DRY RUN (no writes)" : "EXECUTE"}`);
  console.log(`Project: ${FIREBASE_PROJECT_ID}`);
  console.log(`Scanned: ${result.totals.scanned}`);
  console.log(`Eligible: ${result.totals.eligible}`);
  console.log(`Excluded: ${result.totals.excluded}`);
  for (const [status, count] of Object.entries(result.counts)) {
    console.log(`  ${status}: ${count}`);
  }
  console.log(`Conflicts: ${result.conflicts.length}`);
  console.log(`Failed: ${result.failures.length}`);
  console.log(`Result artifact: ${outputPath}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("PROVISIONING_SCRIPT_ERROR:", e);
    process.exit(1);
  });
