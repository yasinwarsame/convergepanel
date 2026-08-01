/**
 * Multi-Reviewer Production-Readiness Hardening, Step 5.5 — safe cleanup
 * for everything `scripts/seed-adaptive-multi-reviewer-e2e.ts` creates.
 * Dry-run (list only, no deletion) by DEFAULT — the operator must pass
 * `--delete` explicitly to actually remove anything. Never imported by, or
 * reachable from, any Next.js route or page.
 *
 * Usage:
 *   ALLOW_NON_PROD_GOVERNANCE_SEED=true npx ts-node --compiler-options '{"module":"CommonJS"}' \
 *     scripts/cleanup-adaptive-multi-reviewer-e2e.ts --confirm-project=convergepanel
 *   # (lists exactly what WOULD be deleted — no writes)
 *
 *   ALLOW_NON_PROD_GOVERNANCE_SEED=true npx ts-node --compiler-options '{"module":"CommonJS"}' \
 *     scripts/cleanup-adaptive-multi-reviewer-e2e.ts --confirm-project=convergepanel --delete
 *   # (actually deletes, after an interactive "type yes" confirmation
 *   #  unless --yes is also passed)
 *
 * Only ever targets paths that contain the `gov-e2e-seed-` namespace
 * (`isWithinSeedNamespace`, checked independently for every single
 * candidate path immediately before deletion — never a broad collection
 * wipe, never a query-derived path trusted without this final check).
 * Firebase Auth accounts created by the seed script are intentionally NOT
 * deleted here — they are inert without their password (never persisted
 * anywhere after the one-time console print) and safe to leave; delete
 * them manually via the Firebase Console if desired.
 *
 * Live-subcollection sweep: the static seed plan is the source of truth
 * for paths written AT SEED TIME, but a real browser-verification pass
 * (required by this feature's release invariants) exercises the real vote
 * / finalize / override APIs against seeded runs, which write additional
 * documents the static plan never listed (another reviewer's vote, a
 * finalization's history entry, etc.). Firestore does not cascade-delete
 * subcollections when a parent document is deleted, so those would
 * otherwise be orphaned. To close that gap without reintroducing a broad
 * collection wipe, this script ALSO queries the `humanReviewVotes` and
 * `humanReviewPanelHistory` subcollections live — but only ever scoped
 * under a `runs/{runId}` path that already passed `isWithinSeedNamespace`,
 * never a top-level collection-group query.
 */

const dotenv = require("dotenv");
const path = require("path");
dotenv.config({ path: path.resolve(__dirname, "../.env.local") });

import * as admin from "firebase-admin";
import { getApps, initializeApp, cert } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import * as readline from "readline";

import { checkSeedGuard, parseSeedCliArgs, isWithinSeedNamespace } from "../lib/governance/adaptiveGovernanceSeedSafety";
import { buildAdaptiveGovernanceSeedPlan, SEED_TEAM_ID } from "../lib/governance/adaptiveGovernanceSeedPlan";

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
  return { adminDb: getFirestore() };
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

/**
 * Enumerates every document path the seed plan is KNOWN to have written,
 * in an order safe for deletion (subcollection documents before their
 * parent document — a run's votes/panel/history before the run itself,
 * the run before the team). Deliberately does NOT run a Firestore query
 * against the live database to "discover" documents — the seed plan
 * itself is the single source of truth for what was ever written, so
 * cleanup can never accidentally sweep up an unrelated document that
 * merely happens to share a collection.
 */
function orderedCleanupPaths(): string[] {
  const plan = buildAdaptiveGovernanceSeedPlan();
  const paths: string[] = [];
  for (const scenario of plan.scenarios) {
    // Subcollection docs first (history, votes, panel), then the run doc, then its projection.
    for (const write of scenario.writes) {
      if (write.path !== `runs/${scenario.runId}`) paths.push(write.path);
    }
    paths.push(`runs/${scenario.runId}`);
  }
  // teamRuns projections (path derived independently of `runs/{runId}`, listed alongside their run above already via scenario.writes — no duplicate needed).
  for (const write of plan.teamWrites) paths.push(write.path); // the team document itself, last.
  return paths;
}

/**
 * Queries the live `humanReviewVotes` and `humanReviewPanelHistory`
 * subcollections for each known seed run ID and returns any document
 * paths not already covered by `orderedCleanupPaths()` — documents a real
 * vote/finalize/override call wrote during browser verification, after
 * the static seed plan ran. Every candidate path is still re-verified by
 * `isWithinSeedNamespace` by the caller before use; the query itself is
 * scoped under a single already-namespaced `runs/{runId}` document, never
 * a top-level collection-group query.
 */
async function discoverLiveExtraPaths(
  adminDb: FirebaseFirestore.Firestore,
  runIds: readonly string[],
  alreadyKnownPaths: ReadonlySet<string>
): Promise<string[]> {
  const extra: string[] = [];
  for (const runId of runIds) {
    if (!isWithinSeedNamespace(runId)) continue;
    for (const subcollection of ["humanReviewVotes", "humanReviewPanelHistory"] as const) {
      const snap = await adminDb.collection(`runs/${runId}/${subcollection}`).get();
      for (const doc of snap.docs) {
        const fullPath = `runs/${runId}/${subcollection}/${doc.id}`;
        if (!alreadyKnownPaths.has(fullPath)) extra.push(fullPath);
      }
    }
  }
  return extra;
}

async function main() {
  const args = parseSeedCliArgs(process.argv.slice(2));
  const resolvedProjectId = resolveProjectId();

  console.log(`[cleanup] Target Firebase project (resolved): ${resolvedProjectId}`);
  console.log(`[cleanup] Mode: ${args.delete ? "DELETE" : "DRY RUN (list only, no deletion)"}`);

  const guard = checkSeedGuard({
    allowFlagValue: process.env.ALLOW_NON_PROD_GOVERNANCE_SEED,
    resolvedProjectId,
    confirmedProjectId: args.confirmProjectId,
    nodeEnv: process.env.NODE_ENV,
    vercelEnv: process.env.VERCEL_ENV,
  });
  if (!guard.ok) {
    console.error(`[cleanup] REFUSED (${guard.reason}): ${guard.message}`);
    process.exit(1);
  }

  const plan = buildAdaptiveGovernanceSeedPlan();
  const candidatePaths = orderedCleanupPaths();
  // Final, independent safety check — every single path, never trusted
  // solely because it came from the plan builder.
  const safePaths = candidatePaths.filter(isWithinSeedNamespace);
  const unsafePaths = candidatePaths.filter((p) => !isWithinSeedNamespace(p));
  if (unsafePaths.length > 0) {
    // Should be unreachable (the plan builder only ever produces
    // namespaced paths, proven by its own test suite) — fails closed
    // rather than ever deleting a path this check can't vouch for.
    console.error(`[cleanup] REFUSED: ${unsafePaths.length} candidate path(s) fell OUTSIDE the seed namespace — refusing to proceed at all.`);
    process.exit(1);
  }

  const { adminDb } = initFirebaseAdmin(resolvedProjectId);
  const runIds = plan.scenarios.map((s) => s.runId);
  const liveExtraPaths = (await discoverLiveExtraPaths(adminDb, runIds, new Set(safePaths))).filter(isWithinSeedNamespace);
  const allPaths = [...safePaths, ...liveExtraPaths];

  console.log(`[cleanup] ${safePaths.length} document(s) from the static seed plan will be targeted:`);
  for (const p of safePaths) console.log(`[cleanup]   ${p}`);
  if (liveExtraPaths.length > 0) {
    console.log(`[cleanup] ${liveExtraPaths.length} additional document(s) found live (written after seeding, e.g. by browser verification) will ALSO be targeted:`);
    for (const p of liveExtraPaths) console.log(`[cleanup]   ${p}`);
  }

  if (!args.delete) {
    console.log("[cleanup] Dry run complete — nothing deleted. Re-run with --delete to actually remove these documents.");
    return;
  }

  if (!args.skipPrompt) {
    const confirmed = await confirmInteractively(`[cleanup] About to DELETE ${allPaths.length} documents from project "${resolvedProjectId}". Type "yes" to proceed: `);
    if (!confirmed) {
      console.log("[cleanup] Aborted by operator.");
      return;
    }
  }

  let deleted = 0;
  let alreadyAbsent = 0;
  let failed = 0;
  const failures: string[] = [];
  for (const p of allPaths) {
    try {
      const snap = await adminDb.doc(p).get();
      if (!snap.exists) {
        alreadyAbsent++;
        continue;
      }
      await adminDb.doc(p).delete();
      deleted++;
    } catch (err) {
      failed++;
      failures.push(p);
      console.error(`[cleanup]   FAILED: ${p}`, err instanceof Error ? err.message : err);
    }
  }

  console.log(`[cleanup] Done. ${deleted} deleted, ${alreadyAbsent} already absent (idempotent), ${failed} failed.`);
  if (failures.length > 0) {
    console.log("[cleanup] Partial failure — re-run this script (idempotent) to retry the remaining paths:");
    for (const p of failures) console.log(`[cleanup]   ${p}`);
    process.exit(1);
  }
  console.log(`[cleanup] Note: Auth accounts for the ${SEED_TEAM_ID} test users were NOT deleted — remove manually via the Firebase Console if desired.`);
}

main().catch((err) => {
  console.error("[cleanup] Unexpected failure:", err);
  process.exit(1);
});
