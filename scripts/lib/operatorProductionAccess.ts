/**
 * Operator Production access — the grant WRITER. Import this FIRST in an operator script, before anything that loads
 * lib/firebase/admin.ts. See lib/firebase/operatorGrant.ts for the full contract.
 *
 * Grants Production Firebase Admin access for THIS process only when ALL hold:
 *   - the operator names the target explicitly: `--confirm-project=<firebase-project-id>` (the scripts' existing flag);
 *   - this is a local operator shell (not Vercel, not a Next.js server, NODE_ENV not "production");
 *   - lib/firebase/admin.ts has not been loaded yet, and no grant exists yet.
 * Without `--confirm-project`, nothing is granted and Production stays refused (the script's own checks then report it).
 *
 * Mode: "write" only when `--execute` is on the command line, otherwise "read-only". The grant never weakens a script's
 * own safeguards (exact project confirmation, --execute, candidate count + fingerprint, ALLOW_* acknowledgements); it
 * only lets lib/firebase/admin.ts initialize against the project the operator named. Read-only scripts stay structurally
 * write-free.
 *
 * Only the four reviewed scripts may import this module (pinned by lib/firebase/__tests__/operatorAccess.spec.ts).
 */
import * as path from "path";
import { OPERATOR_GRANT_KEY, operatorShellRefusal, type OperatorProductionGrant } from "../../lib/firebase/operatorGrant";

export function grantOperatorProductionAccessFromArgv(argv: readonly string[], loadedModules: readonly string[] = Object.keys(require.cache ?? {})): OperatorProductionGrant | null {
  const confirmArgs = argv.filter((a) => a.startsWith("--confirm-project="));
  if (confirmArgs.length === 0) {
    console.error("[operator] No --confirm-project=<id>: Production Firebase access NOT granted.");
    return null;
  }
  if (confirmArgs.length > 1) throw new Error("[operator] Refusing: --confirm-project was given more than once (ambiguous target).");
  const projectId = confirmArgs[0].slice("--confirm-project=".length);
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) throw new Error(`[operator] Refusing: "${projectId}" is not a valid Firebase project id.`);
  const refusal = operatorShellRefusal();
  if (refusal !== null) throw new Error(`[operator] Refusing Production access: ${refusal}. Operator access exists only in a local operator shell.`);
  if (Object.getOwnPropertyDescriptor(globalThis, OPERATOR_GRANT_KEY)) throw new Error("[operator] Refusing: an operator grant already exists in this process.");
  if (loadedModules.some((m) => /[\\/]lib[\\/]firebase[\\/]admin\.(ts|js)$/.test(m))) {
    throw new Error("[operator] Refusing: lib/firebase/admin was loaded before the operator grant. Import scripts/lib/operatorProductionAccess first.");
  }
  const grant: OperatorProductionGrant = Object.freeze({
    version: 1,
    projectId,
    operation: path.basename(argv[1] ?? "unknown-operation"),
    mode: argv.includes("--execute") ? "write" : "read-only",
    grantedAt: new Date().toISOString(),
  });
  Object.defineProperty(globalThis, OPERATOR_GRANT_KEY, { value: grant, writable: false, configurable: false, enumerable: false });
  console.error(`[operator] Production Firebase access GRANTED for this process: project=${grant.projectId} operation=${grant.operation} mode=${grant.mode} at=${grant.grantedAt}`);
  return grant;
}

// Side effect on import (by design: it must run before lib/firebase/admin.ts is loaded by the script's other imports).
if (process.env.JEST_WORKER_ID === undefined) grantOperatorProductionAccessFromArgv(process.argv);
