#!/usr/bin/env node
/**
 * Phase FIRST-ADMIN-C14 — thin, unconditional entrypoint.
 *
 * No `import.meta.url` guard, no argv comparison, no branch that can decline to
 * run. C11 had one and it silently no-opped on paths needing percent-encoding
 * or traversing a symlink, exiting 0 — the code the runbook reads as proof.
 *
 *   PRODUCTION containment proof (the only form the runbook accepts):
 *     node scripts/probe-admin-secret.mjs --production-two-phase
 *
 *   Single-shot diagnostic (never proves containment):
 *     node scripts/probe-admin-secret.mjs --observe
 *
 * THERE IS NO ORIGIN ARGUMENT TO THE PRODUCTION MODE, AND NO ENVIRONMENT
 * VARIABLE THAT CAN SUPPLY ONE. C13 read `PROBE_ORIGIN_OVERRIDE` here and
 * passed `requireCanonical: !PROBE_ALLOW_INSECURE_LOOPBACK`, so those two env
 * vars together ran the full bound transition against a foreign https host,
 * transmitted the live old `ADMIN_SECRET` to it, and printed
 * `PRODUCTION_CONTAINMENT_PROVEN`. Both variables are gone from this file.
 * Loopback testing is done by calling `createContainmentProof()` directly from
 * a test module, which the shipped CLI cannot be talked into doing.
 *
 * OLD_ADMIN_SECRET is read from an ALREADY-EXPORTED environment variable, once.
 * The runbook must not tell an operator to write `OLD_ADMIN_SECRET=<value> cmd`
 * inline: a high-entropy secret containing `$`, a backtick, a space, `!` or `*`
 * is mangled by the shell, and a mangled secret is rejected by the live route —
 * which the old one-shot tool reported as a successful rotation.
 */
import { createInterface } from "node:readline";
import {
  runProductionTwoPhase,
  observeOldSecret,
  CANONICAL_PRODUCTION_ORIGIN,
  OBSERVATIONS,
  POST_OUTCOMES,
  EXIT,
} from "./lib/probe-admin-secret.mjs";

const argv = process.argv.slice(2);
const env = process.env;

/** Reads one line. Returns null at EOF so a closed stdin can never look like consent. */
async function readLine(promptText) {
  process.stdout.write(promptText);
  const rl = createInterface({ input: process.stdin });
  for await (const line of rl) { rl.close(); return line; }
  return null;
}

async function main() {
  if (argv.includes("--production-two-phase")) {
    // The proof is memory-bound and operator-driven. Without an interactive
    // stdin the readline loop returns instantly, so the tool would print
    // "perform the rotation and DEPLOY it", wait for nothing, immediately fire
    // the post-check, and burn rate-limit budget on a guaranteed failure.
    if (!process.stdin.isTTY) {
      console.log("[INCONCLUSIVE] --production-two-phase needs an interactive terminal: it must pause while you rotate and deploy. Run it directly in a terminal, not under nohup, CI, or with stdin redirected.");
      return EXIT.INCONCLUSIVE;
    }

    const result = await runProductionTwoPhase({
      secret: env.OLD_ADMIN_SECRET,          // read ONCE, here
      log: (line) => console.log(line),
      prompt: async ({ attempt, lastOutcome }) => {
        if (attempt === 1) {
          const answer = await readLine(
            `\nThe old credential is confirmed LIVE at ${CANONICAL_PRODUCTION_ORIGIN}.\n` +
            "Now perform the authorized rotation/removal of ADMIN_SECRET and DEPLOY it.\n" +
            "Press Enter when the deployment has finished, or type 'q' to stop. This\n" +
            "process keeps the same origin and the same secret in memory; nothing is\n" +
            "re-read, on this attempt or any retry.\n> "
          );
          return answer !== null && answer.trim().toLowerCase() !== "q";
        }
        const why = lastOutcome === POST_OUTCOMES.NOT_YET_CONTAINED
          ? "The old credential is STILL ACCEPTED. If the deployment is still propagating, wait and retry."
          : "That response carried no verdict (rate limit, 5xx, transport or unattributed). The PRE evidence is still armed.";
        const answer = await readLine(
          `\n${why}\nPress Enter to retry the post-check, or type 'q' to stop without a proof.\n> `
        );
        return answer !== null && answer.trim().toLowerCase() !== "q";
      },
    });
    return result.exit;
  }

  // ---- NON-PRODUCTION DIAGNOSTIC ----------------------------------------
  if (argv.includes("--observe")) {
    const tIdx = argv.indexOf("--non-production-target");
    const target = tIdx >= 0 ? argv[tIdx + 1] : null;

    if (target) {
      console.log("[WARNING] NON-PRODUCTION DIAGNOSTIC. This is not Production mode and cannot");
      console.log(`[WARNING] produce a containment proof. The old ADMIN_SECRET WILL BE SENT to: ${target}`);
    }
    const r = await observeOldSecret({
      origin: target ?? CANONICAL_PRODUCTION_ORIGIN,
      secret: env.OLD_ADMIN_SECRET,
      // Canonical unless the operator typed the long, explicit, non-production flag.
      requireCanonical: !target,
    });
    console.log(`[${r.observation}] contacted ${target ?? CANONICAL_PRODUCTION_ORIGIN} — ${r.detail ?? ""}`.trim());
    console.log("[RESULT] OBSERVATION ONLY — a single response never proves containment. Use --production-two-phase.");
    return r.observation === OBSERVATIONS.ACCEPTED ? EXIT.NOT_CONTAINED : EXIT.INCONCLUSIVE;
  }

  console.log("[INCONCLUSIVE] usage: node scripts/probe-admin-secret.mjs --production-two-phase   (OLD_ADMIN_SECRET must already be exported)");
  return EXIT.INCONCLUSIVE;
}

process.exit(await main());
