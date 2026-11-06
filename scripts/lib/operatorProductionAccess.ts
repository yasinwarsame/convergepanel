/**
 * Operator Production access — the grant WRITER. Import this FIRST in an operator script, before anything that loads
 * lib/firebase/admin.ts. See lib/firebase/operatorGrant.ts for the reader and docs/operations/firebase-environment-
 * isolation.md for the operator procedure.
 *
 * Target selection (`--confirm-project=<id>`, the scripts' existing flag):
 *   - absent → nothing is granted; Production stays refused (the script's own checks report it);
 *   - a NON-Production project → no grant is needed or created (Firebase isolation already allows it); the script runs
 *     against that project with whatever credentials its environment provides;
 *   - the Production project → a grant is created only when ALL hold (default refusal otherwise):
 *       · the operator supplies the approved Production credential explicitly: `--operator-credentials=<path to the
 *         service-account JSON>`. Credentials from .env.local or the environment are NEVER used for Production: they are
 *         removed from this process and replaced by the validated file;
 *       · the file is a Production service-account key (project_id "convergepanel", Production client_email, key);
 *       · this is a local operator shell (not Vercel, not a Next.js server, NODE_ENV not "production"); a checkout whose
 *         .env.local was written by `vercel env pull` is recognised and explained;
 *       · lib/firebase/admin.ts has not been loaded yet, and no grant exists yet;
 *       · the script is one of the reviewed operations, with its mode bound (read-only scripts refuse --execute).
 *   `--operator-preflight` runs every check, prints the result and exits WITHOUT granting or touching Firebase.
 *
 * Writes stay controlled by each script's own existing gates (exact project confirmation, --execute, candidate count +
 * fingerprint, ALLOW_* acknowledgements). Only the four reviewed scripts may import this module (pinned by
 * lib/firebase/__tests__/operatorAccess.spec.ts).
 */
import * as fs from "fs";
import * as path from "path";
import { OPERATOR_GRANT_KEY, operatorShellRefusal, type OperatorProductionGrant } from "../../lib/firebase/operatorGrant";
import { PRODUCTION_FIREBASE_PROJECT_ID, PRODUCTION_FIREBASE_PROJECT_NUMBER, serviceAccountProject } from "../../lib/firebase/projectIsolation";

/**
 * The ONLY operations that may obtain a grant, and the mode each may have. Read-only operations refuse `--execute`
 * outright; write-capable ones are "write" only with it.
 */
export const OPERATOR_OPERATIONS: Readonly<Record<string, "read-only" | "write-with-execute">> = Object.freeze({
  "check-project-run-invariant.ts": "read-only",
  "dry-run-project-normalization.ts": "read-only",
  "execute-project-normalization.ts": "write-with-execute",
  "provision-existing-personal-workspaces.ts": "write-with-execute",
});

const REPO_ENV_LOCAL = path.resolve(__dirname, "../../.env.local");
const OTHER_CREDENTIAL_VARS = ["FIREBASE_SERVICE_ACCOUNT_BASE64", "FIREBASE_SERVICE_ACCOUNT_JSON", "FIREBASE_CLIENT_EMAIL", "FIREBASE_PRIVATE_KEY"] as const;

export interface OperatorAccessOptions {
  loadedModules?: readonly string[];
  envLocalPath?: string;
  exit?: (code: number) => never | void;
}

function singleFlag(argv: readonly string[], name: string): string | undefined {
  const hits = argv.filter((a) => a.startsWith(`${name}=`));
  if (hits.length > 1) throw new Error(`[operator] Refusing: ${name} was given more than once (ambiguous).`);
  return hits.length === 1 ? hits[0].slice(name.length + 1) : undefined;
}

/** A checkout whose .env.local came from `vercel env pull` carries VERCEL / VERCEL_ENV lines. */
function envLocalLooksPulled(envLocalPath: string): boolean {
  try {
    return /^\s*VERCEL(_ENV)?\s*=/m.test(fs.readFileSync(envLocalPath, "utf8"));
  } catch {
    return false;
  }
}

/** Validates the operator-supplied credential file; returns its raw JSON text and client email. Never prints values. */
function loadOperatorCredential(file: string): { json: string; clientEmail: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    throw new Error(`[operator] Refusing: cannot read --operator-credentials file "${file}".`);
  }
  let parsed: { project_id?: unknown; client_email?: unknown; private_key?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("[operator] Refusing: --operator-credentials is not a JSON service-account key.");
  }
  if (parsed.project_id !== PRODUCTION_FIREBASE_PROJECT_ID) throw new Error("[operator] Refusing: the credential file's project_id is not the Production project.");
  const saProject = serviceAccountProject(parsed.client_email);
  if (saProject !== PRODUCTION_FIREBASE_PROJECT_ID && saProject !== PRODUCTION_FIREBASE_PROJECT_NUMBER) throw new Error("[operator] Refusing: the credential file's client_email is not a Production service account.");
  if (typeof parsed.private_key !== "string" || parsed.private_key.length === 0) throw new Error("[operator] Refusing: the credential file has no private_key.");
  return { json: raw, clientEmail: parsed.client_email as string };
}

export function grantOperatorProductionAccessFromArgv(argv: readonly string[], opts: OperatorAccessOptions = {}): OperatorProductionGrant | null {
  const loadedModules = opts.loadedModules ?? Object.keys(require.cache ?? {});
  const envLocalPath = opts.envLocalPath ?? REPO_ENV_LOCAL;
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  const preflight = argv.includes("--operator-preflight");

  const projectId = singleFlag(argv, "--confirm-project");
  if (projectId === undefined) {
    console.error("[operator] No --confirm-project=<id>: Production Firebase access NOT granted.");
    if (preflight) exit(1);
    return null;
  }
  if (!/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(projectId)) throw new Error(`[operator] Refusing: "${projectId}" is not a valid Firebase project id.`);
  if (projectId !== PRODUCTION_FIREBASE_PROJECT_ID) {
    // Review n-1: never silently ignore an operator-selected credential — it exists only for Production.
    if (argv.some((a) => a.startsWith("--operator-credentials="))) {
      throw new Error(`[operator] Refusing: --operator-credentials is only for the Production project; target "${projectId}" uses this checkout's isolated-project credentials.`);
    }
    console.error(`[operator] Target "${projectId}" is not the Production project: no operator grant is needed or created; this checkout's own (isolated-project) credentials are used, and Firebase isolation still refuses any Production credential.`);
    if (preflight) {
      console.error("[operator] PREFLIGHT (non-Production target): nothing granted, Firebase not touched. The script's own --confirm-project identity check (where it has one) runs after initialization.");
      exit(0);
    }
    return null;
  }

  // ---- Production target: every check below must pass (default refusal). ----
  const credentialFile = singleFlag(argv, "--operator-credentials");
  if (credentialFile === undefined) {
    throw new Error("[operator] Refusing: Production access requires --operator-credentials=<path to the approved Production service-account JSON>. Credentials from .env.local or the environment are never used for Production.");
  }
  const refusal = operatorShellRefusal();
  if (refusal !== null) {
    if (/VERCEL/.test(refusal) && envLocalLooksPulled(envLocalPath)) {
      throw new Error("[operator] Refusing Production access: this checkout's .env.local was written by `vercel env pull` (it sets VERCEL/VERCEL_ENV). Run Production operator commands from a separate operator checkout without pulled Vercel variables (docs/operations/firebase-environment-isolation.md).");
    }
    throw new Error(`[operator] Refusing Production access: ${refusal}. Operator access exists only in a local operator shell.`);
  }
  if (Object.getOwnPropertyDescriptor(globalThis, OPERATOR_GRANT_KEY)) throw new Error("[operator] Refusing: an operator grant already exists in this process.");
  if (loadedModules.some((m) => /[\\/]lib[\\/]firebase[\\/]admin\.(ts|js)$/.test(m))) {
    throw new Error("[operator] Refusing: lib/firebase/admin was loaded before the operator grant. Import scripts/lib/operatorProductionAccess first.");
  }
  const operation = path.basename(argv[1] ?? "");
  const policy = Object.prototype.hasOwnProperty.call(OPERATOR_OPERATIONS, operation) ? OPERATOR_OPERATIONS[operation] : undefined;
  if (policy === undefined) throw new Error(`[operator] Refusing: "${operation}" is not a reviewed operator operation.`);
  const execute = argv.includes("--execute");
  if (policy === "read-only" && execute) throw new Error(`[operator] Refusing: ${operation} is read-only and does not accept --execute.`);
  const credential = loadOperatorCredential(credentialFile);
  const mode = policy === "write-with-execute" && execute ? "write" : "read-only";
  const maskedEmail = credential.clientEmail.replace(/^(.{4}).*(@.*)$/, "$1…$2");

  if (preflight) {
    console.error(`[operator] PREFLIGHT OK (nothing granted, Firebase not touched): project=${projectId} operation=${operation} mode=${mode} credential=${path.basename(credentialFile)} (${maskedEmail})`);
    exit(0);
    return null;
  }

  // Install ONLY the operator-selected credential for this process (the base64 form would otherwise take precedence).
  for (const k of OTHER_CREDENTIAL_VARS) delete process.env[k];
  process.env.FIREBASE_SERVICE_ACCOUNT_JSON = credential.json;
  process.env.FIREBASE_PROJECT_ID = PRODUCTION_FIREBASE_PROJECT_ID;

  const grant: OperatorProductionGrant = Object.freeze({ version: 1, projectId, operation, mode, grantedAt: new Date().toISOString() });
  Object.defineProperty(globalThis, OPERATOR_GRANT_KEY, { value: grant, writable: false, configurable: false, enumerable: false });
  console.error(`[operator] Production Firebase access GRANTED for this process: project=${grant.projectId} operation=${grant.operation} mode=${grant.mode} credential=${path.basename(credentialFile)} (${maskedEmail}) at=${grant.grantedAt}`);
  return grant;
}

// Side effect on import (by design: it must run before lib/firebase/admin.ts is loaded by the script's other imports).
if (process.env.JEST_WORKER_ID === undefined) grantOperatorProductionAccessFromArgv(process.argv);
