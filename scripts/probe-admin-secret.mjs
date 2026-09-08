#!/usr/bin/env node
/**
 * Phase FIRST-ADMIN-C13 — thin, unconditional entrypoint.
 *
 * No `import.meta.url` guard, no argv comparison, no branch that can decline to
 * run. C11 had one and it silently no-opped on paths needing percent-encoding
 * or traversing a symlink, exiting 0 — the code the runbook reads as proof.
 *
 *   PRODUCTION containment proof (the only form the runbook accepts):
 *     node scripts/probe-admin-secret.mjs --production-two-phase
 *
 *   Single-shot diagnostic (never proves containment):
 *     node scripts/probe-admin-secret.mjs --observe <origin>
 *
 * OLD_ADMIN_SECRET is read from an ALREADY-EXPORTED environment variable, once.
 * The runbook must not tell an operator to write `OLD_ADMIN_SECRET=<value> cmd`
 * inline: a high-entropy secret containing `$`, a backtick, a space, `!` or `*`
 * is mangled by the shell, and a mangled secret is rejected by the live route —
 * which the old one-shot tool reported as a successful rotation.
 */
import { createInterface } from "node:readline";
import {
  createContainmentProof,
  observeOldSecret,
  CANONICAL_PRODUCTION_ORIGIN,
  OBSERVATIONS,
  EXIT,
} from "./lib/probe-admin-secret.mjs";

const argv = process.argv.slice(2);
const env = process.env;
const insecure = env.PROBE_ALLOW_INSECURE_LOOPBACK === "1";
const originOverride = env.PROBE_ORIGIN_OVERRIDE;

async function waitForOperator(prompt) {
  process.stdout.write(prompt);
  const rl = createInterface({ input: process.stdin });
  for await (const _line of rl) { rl.close(); return; }
}

async function main() {
  if (argv.includes("--production-two-phase")) {
    const origin = originOverride ?? CANONICAL_PRODUCTION_ORIGIN;
    const proof = createContainmentProof({
      origin,
      secret: env.OLD_ADMIN_SECRET,          // read ONCE, here
      requireCanonical: !insecure,
      allowInsecureLoopback: insecure,
    });

    const pre = await proof.precheck();
    console.log(`[PRE] ${pre.ok ? "OK" : "ABORT"} ${pre.detail ?? ""}`.trim());
    if (!pre.ok) {
      console.log("[RESULT] NOT PROVEN — the pre-check did not confirm the old credential is live at the target origin. Do not rotate on the strength of this run, and do not treat any later rejection as proof.");
      return EXIT.INCONCLUSIVE;
    }

    proof.armForRotation();
    await waitForOperator(
      "\nThe old credential is confirmed LIVE at the target origin.\n" +
      "Now perform the authorized rotation/removal of ADMIN_SECRET and DEPLOY it.\n" +
      "Press Enter when the deployment has finished. This process keeps the same\n" +
      "origin and the same secret in memory; nothing is re-read.\n> "
    );

    const post = await proof.postcheck();
    console.log(`[POST] ${post.ok ? "OK" : "ABORT"} ${post.detail ?? ""}`.trim());
    if (!post.ok) {
      console.log("[RESULT] NOT PROVEN — containment is NOT established.");
      return EXIT.NOT_CONTAINED;
    }
    console.log("[RESULT] PRODUCTION_CONTAINMENT_PROVEN — the same origin accepted this exact old credential before the rotation and rejected it after the deployment.");
    return EXIT.PROVEN;
  }

  const idx = argv.indexOf("--observe");
  const origin = idx >= 0 ? argv[idx + 1] : argv[0];
  if (!origin) {
    console.log("[INCONCLUSIVE] usage: node scripts/probe-admin-secret.mjs --production-two-phase   (OLD_ADMIN_SECRET must already be exported)");
    return EXIT.INCONCLUSIVE;
  }
  const r = await observeOldSecret({
    origin,
    secret: env.OLD_ADMIN_SECRET,
    requireCanonical: false,
    allowInsecureLoopback: insecure,
  });
  console.log(`[${r.observation}] ${r.detail ?? ""}`.trim());
  console.log("[RESULT] OBSERVATION ONLY — a single response never proves containment. Use --production-two-phase.");
  return r.observation === OBSERVATIONS.ACCEPTED ? EXIT.NOT_CONTAINED : EXIT.INCONCLUSIVE;
}

process.exit(await main());
