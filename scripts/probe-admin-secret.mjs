#!/usr/bin/env node
/**
 * Phase FIRST-ADMIN-C12 — thin, unconditional entrypoint.
 *
 * C11 guarded this body with `import.meta.url === \`file://${process.argv[1]}\``,
 * which silently failed to match on paths needing percent-encoding or
 * traversing a symlink: the probe printed nothing, sent nothing, and exited 0 —
 * the code the runbook reads as "containment proven". There is now no branch
 * that can decline to run. The implementation lives in ./lib/ so it stays
 * testable without needing an entry guard at all.
 */
import { runCli } from "./lib/probe-admin-secret.mjs";

const { exitCode, line } = await runCli(process.argv.slice(2), process.env);
console.log(line);
process.exit(exitCode);
