#!/usr/bin/env node

/**
 * Path Validation Unit Tests
 * ===========================
 * 
 * Node.js script to verify CodeCheck path validation behavior.
 * Tests that invalid paths like src/ are rejected and valid paths are accepted.
 * 
 * USAGE:
 *   node scripts/test-path-validation.js
 *   npm run test:paths
 * 
 * EXIT CODES:
 *   0 - All tests passed
 *   1 - One or more tests failed
 */

// =============================================================================
// INLINE IMPLEMENTATION (mirrors lib/codecheck/pathValidation.ts)
// =============================================================================

const ALLOWED_TOP_LEVEL_DIRS = [
  "app",
  "components",
  "lib",
  "prisma",
  "public",
  "scripts",
  "hooks",
];

const FORBIDDEN_PREFIXES = [
  "src/",
  "source/",
  "pages/",
  "api/",
  "utils/",
  "helpers/",
  "services/",
  "config/",
  "node_modules/",
  ".next/",
  ".git/",
];

const READ_ONLY_ROOT_FILES = [
  "package.json",
  "tsconfig.json",
  "next.config.js",
];

function normalizePath(path) {
  let normalized = path.trim();
  while (normalized.startsWith("/")) {
    normalized = normalized.slice(1);
  }
  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  return normalized;
}

function hasPathTraversal(path) {
  const normalized = normalizePath(path);
  return normalized.includes("..");
}

function isReadOnlyRootFile(path) {
  const normalized = normalizePath(path);
  return READ_ONLY_ROOT_FILES.includes(normalized);
}

function getTopLevelDir(path) {
  const normalized = normalizePath(path);
  const slashIndex = normalized.indexOf("/");
  if (slashIndex === -1) {
    return null;
  }
  return normalized.slice(0, slashIndex);
}

function getForbiddenPrefix(path) {
  const normalized = normalizePath(path);
  for (const prefix of FORBIDDEN_PREFIXES) {
    if (normalized.startsWith(prefix)) {
      return prefix;
    }
  }
  return null;
}

function validatePath(path) {
  const normalized = normalizePath(path);
  
  if (!normalized) {
    return { path, reason: "Empty path" };
  }
  
  // Check for path traversal
  if (hasPathTraversal(normalized)) {
    return {
      path: normalized,
      reason: "Path traversal (..) is not allowed",
    };
  }
  
  const forbiddenPrefix = getForbiddenPrefix(normalized);
  if (forbiddenPrefix) {
    return {
      path: normalized,
      reason: `Path starts with forbidden prefix "${forbiddenPrefix}"`,
    };
  }
  
  const topLevel = getTopLevelDir(normalized);
  
  if (topLevel === null) {
    return null; // Root-level files are allowed
  }
  
  if (!ALLOWED_TOP_LEVEL_DIRS.includes(topLevel)) {
    return {
      path: normalized,
      reason: `Top-level directory "${topLevel}/" is not allowed`,
    };
  }
  
  return null;
}

function validatePathForPatching(path) {
  const baseViolation = validatePath(path);
  if (baseViolation) {
    return baseViolation;
  }
  
  const normalized = normalizePath(path);
  if (isReadOnlyRootFile(normalized)) {
    return {
      path: normalized,
      reason: `Root-level file "${normalized}" is read-only`,
    };
  }
  
  return null;
}

function validatePlanPatchIntegrity(filePlan, diff) {
  const patchPaths = extractPathsFromDiff(diff);
  const filePlanPaths = new Set(filePlan.map((e) => normalizePath(e.path)));
  
  const missingFromPlan = [];
  const invalidCreatePaths = [];
  
  for (const patchPath of patchPaths) {
    const normalized = normalizePath(patchPath);
    if (!filePlanPaths.has(normalized)) {
      missingFromPlan.push(normalized);
    }
  }
  
  for (const entry of filePlan) {
    if (entry.action === "create") {
      const violation = validatePathForPatching(entry.path);
      if (violation) {
        invalidCreatePaths.push(violation);
      }
    }
  }
  
  return {
    valid: missingFromPlan.length === 0 && invalidCreatePaths.length === 0,
    missingFromPlan,
    invalidCreatePaths,
  };
}

function extractPathsFromDiff(diff) {
  const paths = [];
  const lines = diff.split("\n");
  
  for (const line of lines) {
    const match = line.match(/^\+\+\+\s+(?:b\/)?(.+?)(?:\s|$)/);
    if (match) {
      const path = match[1].trim();
      if (path !== "/dev/null" && path !== "dev/null") {
        paths.push(path);
      }
    }
  }
  
  return [...new Set(paths)];
}

function validatePatchPaths(diff) {
  const paths = extractPathsFromDiff(diff);
  const violations = [];
  
  for (const path of paths) {
    const violation = validatePath(path);
    if (violation) {
      violations.push(violation);
    }
  }
  
  return {
    valid: violations.length === 0,
    violations,
  };
}

// =============================================================================
// TEST FRAMEWORK
// =============================================================================

let passed = 0;
let failed = 0;

function assertEqual(actual, expected, testName) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    passed++;
    console.log(`✅ ${testName}`);
    return true;
  } else {
    failed++;
    console.log(`❌ ${testName}`);
    console.log(`   Expected: ${JSON.stringify(expected)}`);
    console.log(`   Actual:   ${JSON.stringify(actual)}`);
    return false;
  }
}

function assertNull(actual, testName) {
  if (actual === null) {
    passed++;
    console.log(`✅ ${testName}`);
    return true;
  } else {
    failed++;
    console.log(`❌ ${testName}`);
    console.log(`   Expected: null`);
    console.log(`   Actual:   ${JSON.stringify(actual)}`);
    return false;
  }
}

function assertNotNull(actual, testName) {
  if (actual !== null) {
    passed++;
    console.log(`✅ ${testName}`);
    return true;
  } else {
    failed++;
    console.log(`❌ ${testName}`);
    console.log(`   Expected: not null`);
    console.log(`   Actual:   null`);
    return false;
  }
}

function assertTrue(actual, testName) {
  if (actual === true) {
    passed++;
    console.log(`✅ ${testName}`);
    return true;
  } else {
    failed++;
    console.log(`❌ ${testName}`);
    console.log(`   Expected: true`);
    console.log(`   Actual:   ${actual}`);
    return false;
  }
}

function assertFalse(actual, testName) {
  if (actual === false) {
    passed++;
    console.log(`✅ ${testName}`);
    return true;
  } else {
    failed++;
    console.log(`❌ ${testName}`);
    console.log(`   Expected: false`);
    console.log(`   Actual:   ${actual}`);
    return false;
  }
}

// =============================================================================
// TEST CASES
// =============================================================================

console.log("\n📂 Path Validation Tests\n");
console.log("=".repeat(60) + "\n");

// Test normalizePath
console.log("--- normalizePath ---");
assertEqual(normalizePath("/app/page.tsx"), "app/page.tsx", "removes leading slash");
assertEqual(normalizePath("./app/page.tsx"), "app/page.tsx", "removes leading ./");
assertEqual(normalizePath("  app/page.tsx  "), "app/page.tsx", "trims whitespace");

// Test getTopLevelDir
console.log("\n--- getTopLevelDir ---");
assertEqual(getTopLevelDir("app/page.tsx"), "app", "extracts app");
assertEqual(getTopLevelDir("components/Button.tsx"), "components", "extracts components");
assertNull(getTopLevelDir("package.json"), "returns null for root files");

// Test validatePath - valid paths
console.log("\n--- validatePath (valid) ---");
assertNull(validatePath("app/page.tsx"), "app/ paths valid");
assertNull(validatePath("components/Button.tsx"), "components/ paths valid");
assertNull(validatePath("lib/utils.ts"), "lib/ paths valid");
assertNull(validatePath("prisma/schema.prisma"), "prisma/ paths valid");
assertNull(validatePath("public/favicon.ico"), "public/ paths valid");
assertNull(validatePath("scripts/build.js"), "scripts/ paths valid");
assertNull(validatePath("hooks/useAuth.ts"), "hooks/ paths valid");
assertNull(validatePath("package.json"), "root config files valid");
assertNull(validatePath("tsconfig.json"), "root tsconfig valid");

// Test validatePath - src/ rejection (CRITICAL)
console.log("\n--- validatePath (src/ rejection) ---");
assertNotNull(validatePath("src/components/Button.tsx"), "rejects src/components/");
assertNotNull(validatePath("src/lib/utils.ts"), "rejects src/lib/");
assertNotNull(validatePath("src/app/page.tsx"), "rejects src/app/");
assertNotNull(validatePath("src/utils.ts"), "rejects src/ root");

// Test validatePath - other forbidden prefixes
console.log("\n--- validatePath (other forbidden) ---");
assertNotNull(validatePath("pages/index.tsx"), "rejects pages/");
assertNotNull(validatePath("api/users.ts"), "rejects api/ without app/");
assertNotNull(validatePath("utils/helpers.ts"), "rejects utils/");
assertNotNull(validatePath("services/api.ts"), "rejects services/");

// Test validatePath - unknown directories
console.log("\n--- validatePath (unknown dirs) ---");
assertNotNull(validatePath("foo/bar.ts"), "rejects unknown foo/");
assertNotNull(validatePath("random/file.ts"), "rejects unknown random/");

// Test extractPathsFromDiff
console.log("\n--- extractPathsFromDiff ---");
const diff1 = `--- a/app/page.tsx
+++ b/app/page.tsx
@@ -1,5 +1,5 @@
`;
const paths1 = extractPathsFromDiff(diff1);
assertTrue(paths1.includes("app/page.tsx"), "extracts path from +++ b/");

const diff2 = `--- /dev/null
+++ components/Button.tsx
@@ -0,0 +1,10 @@
`;
const paths2 = extractPathsFromDiff(diff2);
assertTrue(paths2.includes("components/Button.tsx"), "extracts path without b/ prefix");

// Test validatePatchPaths
console.log("\n--- validatePatchPaths ---");
const validDiff = `--- /dev/null
+++ b/lib/newFile.ts
@@ -0,0 +1,5 @@
+export function foo() {}
`;
assertTrue(validatePatchPaths(validDiff).valid, "valid patch passes");

const invalidDiff = `--- /dev/null
+++ b/src/utils.ts
@@ -0,0 +1,5 @@
+export function foo() {}
`;
assertFalse(validatePatchPaths(invalidDiff).valid, "patch with src/ fails");

// Nested test - realistic LLM output
console.log("\n--- Realistic LLM Scenarios ---");
const llmDiff = `diff --git a/src/components/Header.tsx b/src/components/Header.tsx
new file mode 100644
--- /dev/null
+++ b/src/components/Header.tsx
@@ -0,0 +1,20 @@
+import React from 'react';
+export const Header = () => <header>Hello</header>;
`;
const llmResult = validatePatchPaths(llmDiff);
assertFalse(llmResult.valid, "catches LLM proposing src/components/");
assertTrue(llmResult.violations.length > 0, "has violations");

// Path traversal tests
console.log("\n--- Path Traversal ---");
assertTrue(hasPathTraversal("../secrets.env"), "detects ../");
assertTrue(hasPathTraversal("foo/../bar.ts"), "detects embedded ..");
assertFalse(hasPathTraversal("lib/utils.ts"), "allows normal paths");
assertNotNull(validatePath("../secrets.env"), "rejects ../secrets.env");

// Additional forbidden paths
console.log("\n--- Additional Forbidden Paths ---");
assertNotNull(validatePath("node_modules/package/index.js"), "rejects node_modules/");
assertNotNull(validatePath(".next/server/pages.js"), "rejects .next/");
assertNotNull(validatePath(".git/config"), "rejects .git/");

// Read-only root files
console.log("\n--- Read-Only Root Files ---");
assertTrue(isReadOnlyRootFile("package.json"), "package.json is read-only");
assertTrue(isReadOnlyRootFile("tsconfig.json"), "tsconfig.json is read-only");
assertFalse(isReadOnlyRootFile("lib/utils.ts"), "lib/utils.ts is not read-only");
assertNotNull(validatePathForPatching("package.json"), "cannot patch package.json");
assertNull(validatePathForPatching("lib/utils.ts"), "can patch lib/utils.ts");

// Plan↔Patch integrity
console.log("\n--- Plan↔Patch Integrity ---");
const filePlan1 = [{ path: "lib/utils.ts", purpose: "Utils", action: "modify" }];
const diff1_ok = `--- a/lib/utils.ts\n+++ b/lib/utils.ts\n@@ -1,1 +1,1 @@\n`;
assertTrue(validatePlanPatchIntegrity(filePlan1, diff1_ok).valid, "patch matches plan");

const diff1_bad = `--- a/lib/other.ts\n+++ b/lib/other.ts\n@@ -1,1 +1,1 @@\n`;
assertFalse(validatePlanPatchIntegrity(filePlan1, diff1_bad).valid, "patch path not in plan rejected");

const filePlan2 = [{ path: "src/bad.ts", purpose: "Bad", action: "create" }];
assertFalse(validatePlanPatchIntegrity(filePlan2, "").valid, "invalid create path rejected");

// =============================================================================
// SUMMARY
// =============================================================================

console.log("\n" + "=".repeat(60));
console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);

if (failed > 0) {
  console.log("❌ Some tests failed!\n");
  process.exit(1);
} else {
  console.log("✅ All tests passed!\n");
  process.exit(0);
}
