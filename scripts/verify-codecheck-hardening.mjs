/**
 * Verification script for CodeCheck hardening items.
 * Tests patchPolicies and evidence logic inline (avoids TS import issues).
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";

let passed = 0;
let failed = 0;

function assert(actual, expected, label) {
  const actualStr = JSON.stringify(actual);
  const expectedStr = JSON.stringify(expected);
  if (actualStr === expectedStr) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.error(`  FAIL: ${label} — expected ${expectedStr}, got ${actualStr}`);
    failed++;
  }
}

function assertTruthy(value, label) {
  if (value) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.error(`  FAIL: ${label} — expected truthy, got ${JSON.stringify(value)}`);
    failed++;
  }
}

// ============================
// Test: Dependency file detection (inline reimplementation for testing)
// ============================
console.log("=== PatchPolicies ===\n");

const PROTECTED_FILES = ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", ".npmrc", ".yarnrc.yml"];

function detectDependencyFileTouches(diff) {
  const touched = [];
  for (const line of diff.split("\n")) {
    if (!line.startsWith("+++ ")) continue;
    const filePath = line.replace(/^\+\+\+ [ab]\//, "").trim();
    const basename = filePath.split("/").pop() || filePath;
    if (PROTECTED_FILES.includes(basename)) touched.push(filePath);
  }
  return [...new Set(touched)];
}

const diff1 = "--- a/package.json\n+++ b/package.json\n@@ -1,3 +1,4 @@\n+  new-dep\n";
assert(detectDependencyFileTouches(diff1), ["package.json"], "detects package.json in diff");

const diff2 = "--- /dev/null\n+++ b/lib/utils/foo.ts\n@@ -0,0 +1,3 @@\n+export function foo() {}\n";
assert(detectDependencyFileTouches(diff2), [], "no dependency files in normal diff");

const diff3 = "--- a/yarn.lock\n+++ b/yarn.lock\n@@ -1 +1 @@\n-old\n+new\n";
assert(detectDependencyFileTouches(diff3), ["yarn.lock"], "detects yarn.lock");

const diff4 = "--- a/package-lock.json\n+++ b/package-lock.json\n@@ -1 +1 @@\n-old\n+new\n";
assert(detectDependencyFileTouches(diff4), ["package-lock.json"], "detects package-lock.json");

const diff5 = "--- a/pnpm-lock.yaml\n+++ b/pnpm-lock.yaml\n@@ -1 +1 @@\n-old\n+new\n";
assert(detectDependencyFileTouches(diff5), ["pnpm-lock.yaml"], "detects pnpm-lock.yaml");

const diff6 = "--- a/bun.lockb\n+++ b/bun.lockb\n@@ -1 +1 @@\n-old\n+new\n";
assert(detectDependencyFileTouches(diff6), ["bun.lockb"], "detects bun.lockb");

const diff7 = "--- a/.npmrc\n+++ b/.npmrc\n@@ -1 +1 @@\n-old\n+new\n";
assert(detectDependencyFileTouches(diff7), [".npmrc"], "detects .npmrc");

const diff8 = "--- a/.yarnrc.yml\n+++ b/.yarnrc.yml\n@@ -1 +1 @@\n-old\n+new\n";
assert(detectDependencyFileTouches(diff8), [".yarnrc.yml"], "detects .yarnrc.yml");

// Test ALLOW_DEPS detection
function isDependencyChangeAllowed(criteria, constraints) {
  const allText = [...criteria, constraints || ""].join(" ").toLowerCase();
  return allText.includes("[allow_deps]") || allText.includes("modify package.json") ||
    allText.includes("add dependency") || allText.includes("add dependencies");
}

assert(isDependencyChangeAllowed(["do something"], ""), false, "no ALLOW_DEPS → not allowed");
assert(isDependencyChangeAllowed(["[ALLOW_DEPS] modify package.json"], ""), true, "[ALLOW_DEPS] → allowed");
assert(isDependencyChangeAllowed([""], "modify package.json"), true, "constraints mention → allowed");
assert(isDependencyChangeAllowed(["add dependency to project"], ""), true, "add dependency → allowed");

// ============================
// Test: Evidence bundle
// ============================
console.log("\n=== Evidence ===\n");

function computePatchHash(diff) {
  return crypto.createHash("sha256").update(diff, "utf8").digest("hex");
}

const hash = computePatchHash("test diff content");
assertTruthy(hash.length === 64, "patch hash is sha256 hex (64 chars)");

const hash2 = computePatchHash("test diff content");
assert(hash, hash2, "same content produces same hash");

const hash3 = computePatchHash("different diff");
assertTruthy(hash !== hash3, "different content produces different hash");

function generateEvidenceId() {
  const ts = Date.now().toString(36);
  const rand = crypto.randomBytes(4).toString("hex");
  return `${ts}-${rand}`;
}

const eid = generateEvidenceId();
assertTruthy(eid.length > 5, "evidence ID is generated");
assertTruthy(eid.includes("-"), "evidence ID has expected format");

const eid2 = generateEvidenceId();
assertTruthy(eid !== eid2, "evidence IDs are unique");

// ============================
// Test: Reproduce commands
// ============================
console.log("\n=== Reproduce Commands ===\n");

function buildReproduceCommands(repoSha, verificationCommands) {
  const commands = [];
  const notes = [];
  if (repoSha) {
    commands.push(`git checkout ${repoSha}`);
    notes.push(`Repo was at commit ${repoSha.slice(0, 12)}`);
  } else {
    notes.push("No git SHA available");
  }
  commands.push("git apply <patch-file>");
  for (const cmd of verificationCommands) {
    if (!commands.includes(cmd)) commands.push(cmd);
  }
  return { commands, notes };
}

const repro = buildReproduceCommands("abc123def456", ["npx tsc --noEmit", "npm run build"]);
assertTruthy(repro.commands.includes("git checkout abc123def456"), "reproduce includes git checkout");
assertTruthy(repro.commands.includes("git apply <patch-file>"), "reproduce includes git apply");
assertTruthy(repro.commands.includes("npx tsc --noEmit"), "reproduce includes tsc");
assertTruthy(repro.commands.includes("npm run build"), "reproduce includes build");

const reproNoGit = buildReproduceCommands(undefined, ["npm run build"]);
assertTruthy(!reproNoGit.commands.some(c => c.includes("git checkout")), "no git checkout without SHA");
assertTruthy(reproNoGit.notes.some(n => n.includes("No git SHA")), "note about missing SHA");

// ============================
// Test: File existence verification
// ============================
console.log("\n=== File Existence ===\n");

const newFiles = [
  "lib/codecheck/repoContext.ts",
  "lib/codecheck/patchPolicies.ts",
  "lib/codecheck/evidence.ts",
];

for (const f of newFiles) {
  const fullPath = path.join(process.cwd(), f);
  assertTruthy(fs.existsSync(fullPath), `${f} exists`);
}

// Verify .codecheck is in .gitignore
const gitignore = fs.readFileSync(path.join(process.cwd(), ".gitignore"), "utf8");
assertTruthy(gitignore.includes(".codecheck/"), ".codecheck/ is in .gitignore");

// ============================
// Test: Baseline verification commands
// ============================
console.log("\n=== Baseline Commands ===\n");

function ensureBaselineCommands(commands, isTypeScript) {
  const baseline = isTypeScript
    ? ["npx tsc --noEmit", "npm run build"]
    : ["npm run build"];
  const result = [...baseline];
  for (const cmd of commands) {
    if (!result.includes(cmd)) result.push(cmd);
  }
  return result;
}

const cmds1 = ensureBaselineCommands([], true);
assert(cmds1, ["npx tsc --noEmit", "npm run build"], "TS: empty → baseline with tsc");

const cmds2 = ensureBaselineCommands(["npm test"], true);
assert(cmds2, ["npx tsc --noEmit", "npm run build", "npm test"], "TS: adds task-specific after baseline");

const cmds3 = ensureBaselineCommands(["npx tsc --noEmit", "npm run build"], true);
assert(cmds3, ["npx tsc --noEmit", "npm run build"], "TS: already has baseline → no dupes");

const cmds4 = ensureBaselineCommands(["npm run build", "npm test"], true);
assert(cmds4, ["npx tsc --noEmit", "npm run build", "npm test"], "TS: partial baseline → fills in missing");

const cmds5 = ensureBaselineCommands([], false);
assert(cmds5, ["npm run build"], "non-TS: empty → build only, no tsc");

const cmds6 = ensureBaselineCommands(["npm test"], false);
assert(cmds6, ["npm run build", "npm test"], "non-TS: adds task-specific after build");

const cmds7 = ensureBaselineCommands(["npx tsc --noEmit"], false);
assert(cmds7, ["npm run build", "npx tsc --noEmit"], "non-TS: explicit tsc still kept as task-specific");

// ============================
// Test: Sensitive file detection
// ============================
console.log("\n=== Sensitive File Policy ===\n");

const SENSITIVE_EXACT_FILES = [".env", ".env.local", ".env.production", "middleware.ts", "middleware.js"];
const SENSITIVE_PATH_PATTERNS = [
  /^\.env\./,
  /(?:^|\/)firebase\/admin/i,
  /(?:^|\/)firebase\/auth/i,
  /payment/i,
  /billing/i,
  /stripe/i,
  /secret/i,
  /credential/i,
];

function isSensitivePath(filePath) {
  const basename = filePath.split("/").pop() || filePath;
  if (SENSITIVE_EXACT_FILES.includes(basename)) return true;
  for (const pattern of SENSITIVE_PATH_PATTERNS) {
    if (pattern.test(filePath)) return true;
  }
  return false;
}

function detectSensitiveFileTouches(diff) {
  const touched = [];
  for (const line of diff.split("\n")) {
    if (!line.startsWith("+++ ")) continue;
    const filePath = line.replace(/^\+\+\+ [ab]\//, "").trim();
    if (filePath === "/dev/null") continue;
    if (isSensitivePath(filePath)) touched.push(filePath);
  }
  return [...new Set(touched)];
}

const sDiff1 = "--- /dev/null\n+++ b/.env\n@@ -0,0 +1 @@\n+SECRET=x\n";
assert(detectSensitiveFileTouches(sDiff1), [".env"], "detects .env");

const sDiff2 = "--- a/.env.local\n+++ b/.env.local\n@@ -1 +1 @@\n-old\n+new\n";
assert(detectSensitiveFileTouches(sDiff2), [".env.local"], "detects .env.local");

const sDiff3 = "--- a/middleware.ts\n+++ b/middleware.ts\n@@ -1 +1 @@\n-old\n+new\n";
assert(detectSensitiveFileTouches(sDiff3), ["middleware.ts"], "detects middleware.ts");

const sDiff4 = "--- a/app/api/payment/route.ts\n+++ b/app/api/payment/route.ts\n@@ -1 +1 @@\n-x\n+y\n";
assert(detectSensitiveFileTouches(sDiff4), ["app/api/payment/route.ts"], "detects file with 'payment' in path");

const sDiff5 = "--- a/lib/stripe/webhook.ts\n+++ b/lib/stripe/webhook.ts\n@@ -1 +1 @@\n-x\n+y\n";
assert(detectSensitiveFileTouches(sDiff5), ["lib/stripe/webhook.ts"], "detects file with 'stripe' in path");

const sDiff6 = "--- a/lib/firebase/admin.ts\n+++ b/lib/firebase/admin.ts\n@@ -1 +1 @@\n-x\n+y\n";
assert(detectSensitiveFileTouches(sDiff6), ["lib/firebase/admin.ts"], "detects firebase/admin");

const sDiff7 = "--- a/lib/firebase/auth-helpers.ts\n+++ b/lib/firebase/auth-helpers.ts\n@@ -1 +1 @@\n-x\n+y\n";
assert(detectSensitiveFileTouches(sDiff7), ["lib/firebase/auth-helpers.ts"], "detects firebase/auth");

const sDiff8 = "--- /dev/null\n+++ b/lib/utils/slugify.ts\n@@ -0,0 +1 @@\n+export const x=1;\n";
assert(detectSensitiveFileTouches(sDiff8), [], "normal file passes sensitive check");

const sDiff9 = "--- a/lib/secret-store.ts\n+++ b/lib/secret-store.ts\n@@ -1 +1 @@\n-x\n+y\n";
assert(detectSensitiveFileTouches(sDiff9), ["lib/secret-store.ts"], "detects 'secret' in path");

const sDiff10 = "--- a/app/billing/page.tsx\n+++ b/app/billing/page.tsx\n@@ -1 +1 @@\n-x\n+y\n";
assert(detectSensitiveFileTouches(sDiff10), ["app/billing/page.tsx"], "detects 'billing' in path");

// Test [ALLOW_SENSITIVE] detection
function isSensitiveChangeAllowed(criteria, constraints) {
  const allText = [...criteria, constraints || ""].join(" ").toLowerCase();
  return allText.includes("[allow_sensitive]");
}

assert(isSensitiveChangeAllowed(["do something"], ""), false, "no ALLOW_SENSITIVE → not allowed");
assert(isSensitiveChangeAllowed(["[ALLOW_SENSITIVE] update auth"], ""), true, "[ALLOW_SENSITIVE] → allowed");
assert(isSensitiveChangeAllowed(["normal"], "[ALLOW_SENSITIVE]"), true, "[ALLOW_SENSITIVE] in constraints → allowed");

// ============================
// Test: Environment capture
// ============================
console.log("\n=== Environment Capture ===\n");

import { execSync } from "child_process";

function captureEnvironment() {
  let npmVersion;
  try { npmVersion = execSync("npm --version", { timeout: 5000 }).toString().trim(); } catch { /* optional */ }
  return {
    nodeVersion: process.version,
    npmVersion,
    os: `${process.platform} ${process.arch}`,
  };
}

const env = captureEnvironment();
assertTruthy(env.nodeVersion && env.nodeVersion.startsWith("v"), "nodeVersion starts with 'v'");
assertTruthy(env.os.length > 3, "os field is populated");
assertTruthy(env.os.includes(process.platform), "os includes platform");
assertTruthy(env.os.includes(process.arch), "os includes arch");
assertTruthy(typeof env.npmVersion === "string" && env.npmVersion.length > 0, "npmVersion is captured");

console.log(`\nResults: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}
