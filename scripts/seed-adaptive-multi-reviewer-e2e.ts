/**
 * Multi-Reviewer Production-Readiness Hardening, Step 5.3/5.4 — safe,
 * non-production seed harness for the multi-reviewer governance
 * end-to-end verification scenarios (A-F). Never imported by, or reachable
 * from, any Next.js route or page — this is a standalone operator script
 * only, run manually via `npx ts-node`.
 *
 * IMPORTANT, DISCLOSED CONSTRAINT: this repository has no separate dev/
 * staging Firebase project — the SAME project ("convergepanel" by default)
 * is used everywhere. This script therefore cannot infer "safe to run"
 * from the environment; it requires the operator to explicitly confirm
 * BOTH an allow-flag and the exact target project ID before writing
 * anything (see `lib/governance/adaptiveGovernanceSeedSafety.ts`).
 *
 * Usage:
 *   ALLOW_NON_PROD_GOVERNANCE_SEED=true npx ts-node --compiler-options '{"module":"CommonJS"}' \
 *     scripts/seed-adaptive-multi-reviewer-e2e.ts --confirm-project=convergepanel --dry-run
 *
 *   (drop --dry-run to actually write; add --yes to skip the interactive
 *   confirmation prompt for non-interactive/CI-adjacent use)
 *
 * All seeded documents (team, runs, panels, votes, history) live under the
 * `gov-e2e-seed-` namespace (`lib/governance/adaptiveGovernanceSeedSafety.ts`)
 * — never a real team/user/run ID shape, and trivially identifiable for
 * cleanup (`scripts/cleanup-adaptive-multi-reviewer-e2e.ts`).
 */

// Load environment variables from .env.local BEFORE importing Firebase Admin.
const dotenv = require("dotenv");
const path = require("path");
dotenv.config({ path: path.resolve(__dirname, "../.env.local") });

import * as admin from "firebase-admin";
import { getApps, initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import * as readline from "readline";
import { randomBytes } from "crypto";

import { checkSeedGuard, parseSeedCliArgs } from "../lib/governance/adaptiveGovernanceSeedSafety";
import { buildAdaptiveGovernanceSeedPlan, SEED_TEST_USERS, SEED_TEAM_ID } from "../lib/governance/adaptiveGovernanceSeedPlan";

function resolveProjectId(): string {
  return process.env.FIREBASE_PROJECT_ID || process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID || "convergepanel";
}

function initFirebaseAdmin(projectId: string) {
  if (getApps().length === 0) {
    const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
    const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
    if (!clientEmail || !privateKey) {
      throw new Error("Firebase Admin SDK requires FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY in .env.local.");
    }
    initializeApp({ credential: cert({ projectId, clientEmail, privateKey }), projectId });
  }
  const adminDb = getFirestore();
  // See lib/firebase/admin.ts for why this is required — the Admin SDK
  // rejects `undefined` field values by default, and the real production
  // builders this script reuses legitimately produce them for absent
  // optional fields.
  adminDb.settings({ ignoreUndefinedProperties: true });
  return { adminAuth: getAuth(), adminDb };
}

function confirmInteractively(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === "yes");
    });
  });
}

function randomPassword(): string {
  return randomBytes(18).toString("base64url");
}

async function main() {
  const args = parseSeedCliArgs(process.argv.slice(2));
  const resolvedProjectId = resolveProjectId();

  // Print the target project BEFORE any guard/write, per Step 5.3's
  // explicit requirement — the operator sees this even if the guard then
  // refuses to proceed.
  console.log(`[seed] Target Firebase project (resolved): ${resolvedProjectId}`);
  console.log(`[seed] Mode: ${args.dryRun ? "DRY RUN (no writes)" : "LIVE WRITE"}`);

  const guard = checkSeedGuard({
    allowFlagValue: process.env.ALLOW_NON_PROD_GOVERNANCE_SEED,
    resolvedProjectId,
    confirmedProjectId: args.confirmProjectId,
    nodeEnv: process.env.NODE_ENV,
    vercelEnv: process.env.VERCEL_ENV,
  });
  if (!guard.ok) {
    console.error(`[seed] REFUSED (${guard.reason}): ${guard.message}`);
    process.exit(1);
  }

  const plan = buildAdaptiveGovernanceSeedPlan();
  const totalWrites = plan.teamWrites.length + plan.scenarios.reduce((n, s) => n + s.writes.length, 0);
  console.log(`[seed] Plan: 1 team (${SEED_TEAM_ID}), ${plan.scenarios.length} scenarios, ${totalWrites} Firestore document writes, ${SEED_TEST_USERS.length} Auth users.`);
  for (const scenario of plan.scenarios) {
    console.log(`[seed]   Scenario ${scenario.id} — ${scenario.name} (runId: ${scenario.runId}): ${scenario.description}`);
  }

  if (args.dryRun) {
    console.log("[seed] Dry run complete — no writes performed. Re-run without --dry-run to write.");
    return;
  }

  if (!args.skipPrompt) {
    const confirmed = await confirmInteractively(
      `[seed] About to write ${totalWrites} documents and ${SEED_TEST_USERS.length} Auth users to project "${resolvedProjectId}". Type "yes" to proceed: `
    );
    if (!confirmed) {
      console.log("[seed] Aborted by operator.");
      return;
    }
  }

  const { adminAuth, adminDb } = initFirebaseAdmin(resolvedProjectId);

  // ---- Auth users — idempotent: skip (never reset) an already-existing account. ----
  console.log("[seed] Provisioning Auth users…");
  const createdCredentials: { email: string; password: string }[] = [];
  for (const user of SEED_TEST_USERS) {
    try {
      await adminAuth.getUser(user.uid);
      console.log(`[seed]   ${user.email} already exists — leaving existing password unchanged.`);
    } catch {
      const password = randomPassword();
      await adminAuth.createUser({ uid: user.uid, email: user.email, password, displayName: user.displayName, emailVerified: true });
      createdCredentials.push({ email: user.email, password });
      console.log(`[seed]   Created ${user.email} (role: ${user.role}).`);
    }
  }

  // ---- Firestore documents. ----
  console.log("[seed] Writing Firestore documents…");
  const allWrites = [...plan.teamWrites, ...plan.scenarios.flatMap((s) => s.writes)];
  let created = 0;
  let alreadyExists = 0;
  let overwritten = 0;
  let failed = 0;
  for (const write of allWrites) {
    const ref = adminDb.doc(write.path);
    try {
      if (write.mode === "create") {
        try {
          await ref.create(write.data as admin.firestore.DocumentData);
          created++;
        } catch (err: unknown) {
          const code = (err as { code?: number | string })?.code;
          if (code === 6 || code === "ALREADY_EXISTS") {
            alreadyExists++;
          } else {
            throw err;
          }
        }
      } else {
        await ref.set(write.data as admin.firestore.DocumentData);
        overwritten++;
      }
    } catch (err) {
      failed++;
      console.error(`[seed]   FAILED: ${write.path}`, err instanceof Error ? err.message : err);
    }
  }

  console.log(`[seed] Done. Firestore: ${overwritten} set, ${created} created, ${alreadyExists} already existed, ${failed} failed.`);
  if (createdCredentials.length > 0) {
    console.log("[seed] NEW Auth credentials (shown ONCE — record them now, never logged again):");
    for (const c of createdCredentials) {
      console.log(`[seed]   ${c.email} / ${c.password}`);
    }
  }
  console.log(`[seed] Team ID: ${SEED_TEAM_ID}`);
  console.log("[seed] Run cleanup-adaptive-multi-reviewer-e2e.ts --dry-run first when you're done, to review what will be removed.");

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("[seed] Unexpected failure:", err);
  process.exit(1);
});
