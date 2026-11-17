/**
 * READ-ONLY: print one user's custom claims and whether `admin === true`.
 *
 * Usage:
 *   node scripts/check-admin-claims.js \
 *     --confirm-project=<projectId> \
 *     --credentials=<service-account key file, mode 0600> \
 *     --uid=<uid>
 *
 * Every argument is required; there is no default user and no default project.
 * It never loads .env.local or credential environment variables: it uses only
 * the named key file, whose project_id must equal --confirm-project. It never
 * writes anything. To CHANGE the admin claim use
 * scripts/admin/set-system-admin-claim.ts.
 */

const fs = require("node:fs");
const path = require("node:path");

const FLAGS = ["--confirm-project", "--credentials", "--uid"];
const UID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const PROJECT_ID_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/;

/** Strict parser: known flags only, each once, each with a value, no positionals. Returns { ok, ... }. */
function parseReadOnlyArgs(argv) {
  const values = {};
  for (const token of argv) {
    if (!token.startsWith("--")) return { ok: false, code: "positional_arg", message: `Refusing positional argument "${token}".` };
    const eq = token.indexOf("=");
    const name = eq === -1 ? token : token.slice(0, eq);
    if (!FLAGS.includes(name)) return { ok: false, code: "unknown_flag", message: `Refusing unknown flag ${name}. Allowed: ${FLAGS.join(", ")}.` };
    if (Object.prototype.hasOwnProperty.call(values, name)) return { ok: false, code: "duplicate_flag", message: `Refusing: ${name} given more than once.` };
    const value = eq === -1 ? "" : token.slice(eq + 1);
    if (value === "") return { ok: false, code: "flag_value_missing", message: `Refusing: ${name} needs a value.` };
    values[name] = value;
  }
  for (const f of FLAGS) {
    if (!(f in values)) return { ok: false, code: "flag_missing", message: `Refusing: ${f}=... is required. There are no defaults.` };
  }
  if (!PROJECT_ID_PATTERN.test(values["--confirm-project"])) return { ok: false, code: "project_id_invalid", message: "Refusing: invalid --confirm-project." };
  if (!UID_PATTERN.test(values["--uid"])) return { ok: false, code: "target_uid_invalid", message: "Refusing: --uid must be 1-128 characters of [A-Za-z0-9_-]." };
  return { ok: true, confirmProject: values["--confirm-project"], credentialsPath: values["--credentials"], uid: values["--uid"] };
}

function runtimeRefusal(env) {
  for (const k of ["VERCEL", "VERCEL_ENV", "NEXT_RUNTIME", "FIREBASE_AUTH_EMULATOR_HOST"]) {
    if (env[k]) return `Refusing: ${k} is set. Run from a local operator shell.`;
  }
  if (env.NODE_ENV === "production") return "Refusing: NODE_ENV=production.";
  return null;
}

/**
 * Reads and validates the key file. Never echoes any key field other than
 * project_id. The file is opened ONCE (lstat refuses a symlink, then
 * open(O_NOFOLLOW) + fstat + read through that descriptor), so the checked
 * file is the file read.
 */
function loadKey(credentialsPath, confirmProject) {
  const file = path.resolve(credentialsPath);
  let lst;
  try {
    lst = fs.lstatSync(file);
  } catch {
    return { ok: false, code: "credentials_file_unreadable", message: "Refusing: the --credentials file does not exist or cannot be read." };
  }
  if (lst.isSymbolicLink()) {
    return { ok: false, code: "credentials_file_symlink", message: "Refusing: the --credentials file is a symbolic link. Name the real file." };
  }
  // A FIFO/socket/device is refused without opening it (open() on a FIFO blocks).
  if (!lst.isFile()) {
    return { ok: false, code: "credentials_file_unsafe", message: "Refusing: the --credentials file must be a regular file with mode 0600." };
  }
  let fd;
  try {
    // O_NONBLOCK: a FIFO swapped in after the lstat cannot block; fstat below refuses it.
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch {
    return { ok: false, code: "credentials_file_unreadable", message: "Refusing: the --credentials file could not be opened." };
  }
  let body;
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || (st.mode & 0o077) !== 0) {
      return { ok: false, code: "credentials_file_unsafe", message: "Refusing: the --credentials file must be a regular file with mode 0600." };
    }
    body = fs.readFileSync(fd, "utf8");
  } finally {
    fs.closeSync(fd);
  }
  let key;
  try {
    key = JSON.parse(body);
  } catch {
    return { ok: false, code: "credentials_invalid", message: "Refusing: the --credentials file is not valid JSON." };
  }
  if (!key || key.type !== "service_account" || typeof key.client_email !== "string" || typeof key.private_key !== "string") {
    return { ok: false, code: "credentials_invalid", message: "Refusing: the --credentials file is not a service-account key." };
  }
  if (key.project_id !== confirmProject) {
    return { ok: false, code: "project_confirmation_mismatch", message: `Refusing: --confirm-project does not match the credential's project_id (${String(key.project_id)}).` };
  }
  return { ok: true, key };
}

async function main(argv, env) {
  const runtime = runtimeRefusal(env);
  if (runtime) {
    console.error(runtime);
    return 2;
  }
  const args = parseReadOnlyArgs(argv);
  if (!args.ok) {
    console.error(`[${args.code}] ${args.message}`);
    return 2;
  }
  const loaded = loadKey(args.credentialsPath, args.confirmProject);
  if (!loaded.ok) {
    console.error(loaded.message);
    return 2;
  }

  const { cert, initializeApp, deleteApp } = require("firebase-admin/app");
  const { getAuth } = require("firebase-admin/auth");
  const app = initializeApp(
    {
      credential: cert({ projectId: loaded.key.project_id, clientEmail: loaded.key.client_email, privateKey: loaded.key.private_key }),
      projectId: loaded.key.project_id,
    },
    `check-admin-claims-${Date.now()}`
  );
  try {
    const user = await getAuth(app).getUser(args.uid);
    const claims = user.customClaims || {};
    console.log(`Project:  ${args.confirmProject}`);
    console.log(`UID:      ${user.uid}`);
    console.log(`Disabled: ${user.disabled === true ? "yes" : user.disabled === false ? "no" : "unknown"}`);
    console.log(`Custom claims: ${JSON.stringify(claims, null, 2)}`);
    console.log(`admin === true: ${claims.admin === true ? "YES" : "NO"}`);
    return 0;
  } catch (error) {
    // Only the error code: SDK messages are not echoed.
    console.error(`Lookup failed (${error && error.code ? error.code : "unknown error"}).`);
    return 1;
  } finally {
    await deleteApp(app).catch(() => undefined);
  }
}

module.exports = { parseReadOnlyArgs, runtimeRefusal, loadKey, main, runAsCli };

/** CLI entry shared with verify-admin-claims.js. Any unexpected failure prints a generic line (no message, no stack) and exits 1. */
function runAsCli(argv, env, exit = process.exit, writeErr = (l) => process.stderr.write(`${l}\n`)) {
  return main(argv, env).then(
    (code) => exit(code),
    () => {
      writeErr("Unexpected failure. Nothing was written (this tool is read-only).");
      exit(1);
    }
  );
}

if (require.main === module) {
  runAsCli(process.argv.slice(2), process.env);
}
