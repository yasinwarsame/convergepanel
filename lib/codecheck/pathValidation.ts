/**
 * CodeCheck Path Validation
 * 
 * Validates file paths in CodeCheck output to ensure they conform to
 * the ConvergePanel repo structure. Prevents LLMs from proposing files
 * in non-existent directories (e.g., src/).
 * 
 * ALLOWED TOP-LEVEL DIRECTORIES:
 * - app/        (Next.js app router)
 * - components/ (React components)
 * - lib/        (Utilities and shared code)
 * - prisma/     (Database schema and migrations)
 * - public/     (Static assets)
 * - scripts/    (Build/dev scripts)
 * 
 * @module lib/codecheck/pathValidation
 */

import type { CodeCheckFilePlanEntry, CodeCheckSpec, CodeCheckDiff } from "./types";

// ============================================
// CONSTANTS
// ============================================

/**
 * Allowed top-level directories in the ConvergePanel repo.
 * Any file path must start with one of these.
 */
export const ALLOWED_TOP_LEVEL_DIRS = [
  "app",
  "components",
  "lib",
  "prisma",
  "public",
  "scripts",
  "hooks",
] as const;

/**
 * Explicitly forbidden path prefixes that LLMs often incorrectly suggest.
 */
export const FORBIDDEN_PREFIXES = [
  "src/",
  "source/",
  "pages/",      // Next.js pages router (we use app router)
  "api/",        // Should be app/api/
  "utils/",      // Should be lib/utils/
  "helpers/",    // Should be lib/
  "services/",   // Should be lib/
  "config/",     // Config files should be at root or in lib/
  "tests/",      // Tests must live under lib/__tests__/
  "node_modules/",
  ".next/",
  ".git/",
] as const;

/**
 * Root-level config files that are READ-ONLY for CodeCheck.
 * CodeCheck can reference these but should not patch them.
 */
export const READ_ONLY_ROOT_FILES = [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "next.config.js",
  "next.config.mjs",
  "tailwind.config.js",
  "tailwind.config.ts",
  "postcss.config.js",
  ".env",
  ".env.local",
  ".env.production",
  ".gitignore",
  ".eslintrc.js",
  ".eslintrc.json",
] as const;

/**
 * Hint message for error responses.
 */
export const PATH_ERROR_HINT = 
  "This repo does not have a /src directory. Use lib/, app/, or components/ paths. " +
  "Canonical Firestore sanitizer is lib/firestore/sanitize.ts.";

// ============================================
// TYPES
// ============================================

/**
 * A single path validation violation
 */
export interface PathViolation {
  /** The invalid path */
  path: string;
  /** Why it's invalid */
  reason: string;
  /** Suggested fix (if available) */
  suggestion?: string;
}

/**
 * Result of path validation
 */
export interface PathValidationResult {
  /** Whether all paths are valid */
  valid: boolean;
  /** List of violations (empty if valid) */
  violations: PathViolation[];
  /** Human-readable summary */
  message: string;
}

// ============================================
// PATH VALIDATION
// ============================================

/**
 * Normalize a file path for validation.
 * - Removes leading slashes
 * - Removes leading "./"
 * - Trims whitespace
 */
export function normalizePath(path: string): string {
  let normalized = path.trim();
  
  // Remove leading slashes
  while (normalized.startsWith("/")) {
    normalized = normalized.slice(1);
  }
  
  // Remove leading "./"
  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  
  return normalized;
}

/**
 * Check if a path contains path traversal attempts.
 */
export function hasPathTraversal(path: string): boolean {
  const normalized = normalizePath(path);
  // Check for .. anywhere in the path
  return normalized.includes("..") || normalized.startsWith("../");
}

/**
 * Check if a path is a root-level read-only file.
 */
export function isReadOnlyRootFile(path: string): boolean {
  const normalized = normalizePath(path);
  return READ_ONLY_ROOT_FILES.includes(normalized as typeof READ_ONLY_ROOT_FILES[number]);
}

/**
 * Extract the top-level directory from a path.
 * Returns null if path is at root level (no directory).
 */
export function getTopLevelDir(path: string): string | null {
  const normalized = normalizePath(path);
  const slashIndex = normalized.indexOf("/");
  
  if (slashIndex === -1) {
    // Root-level file (e.g., "package.json") - allowed
    return null;
  }
  
  return normalized.slice(0, slashIndex);
}

/**
 * Check if a path starts with a forbidden prefix.
 */
function getForbiddenPrefix(path: string): string | null {
  const normalized = normalizePath(path);
  
  for (const prefix of FORBIDDEN_PREFIXES) {
    if (normalized.startsWith(prefix)) {
      return prefix;
    }
  }
  
  return null;
}

/**
 * Get a suggested fix for a forbidden path.
 */
function getSuggestion(path: string, forbiddenPrefix: string): string | undefined {
  const normalized = normalizePath(path);
  const remainder = normalized.slice(forbiddenPrefix.length);
  
  switch (forbiddenPrefix) {
    case "tests/":
      // tests/api/echo.test.ts -> lib/__tests__/api/echo.test.ts
      // tests/echo.test.ts -> lib/__tests__/echo.test.ts
      return `lib/__tests__/${remainder}`;

    case "src/":
      // src/components/ -> components/
      // src/lib/ -> lib/
      // src/app/ -> app/
      // src/utils/ -> lib/utils/
      if (remainder.startsWith("components/")) {
        return `components/${remainder.slice("components/".length)}`;
      }
      if (remainder.startsWith("lib/")) {
        return `lib/${remainder.slice("lib/".length)}`;
      }
      if (remainder.startsWith("app/")) {
        return `app/${remainder.slice("app/".length)}`;
      }
      if (remainder.startsWith("utils/")) {
        return `lib/utils/${remainder.slice("utils/".length)}`;
      }
      return `lib/${remainder}`;
      
    case "pages/":
      // pages/api/foo.ts -> app/api/foo/route.ts
      if (remainder.startsWith("api/")) {
        const apiPath = remainder.slice("api/".length);
        const withoutExt = apiPath.replace(/\.(ts|tsx|js|jsx)$/, "");
        return `app/api/${withoutExt}/route.ts`;
      }
      return `app/${remainder}`;
      
    case "api/":
      return `app/api/${remainder}`;
      
    case "utils/":
    case "helpers/":
    case "services/":
      return `lib/${remainder}`;
      
    case "config/":
      return `lib/config/${remainder}`;
      
    default:
      return undefined;
  }
}

/**
 * Validate a single file path (for reading/referencing).
 */
export function validatePath(path: string): PathViolation | null {
  const normalized = normalizePath(path);
  
  // Empty path is invalid
  if (!normalized) {
    return {
      path,
      reason: "Empty path",
    };
  }
  
  // Check for path traversal attacks
  if (hasPathTraversal(normalized)) {
    return {
      path: normalized,
      reason: "Path traversal (..) is not allowed. All paths must be within the repository root.",
    };
  }
  
  // Check for forbidden prefixes first
  const forbiddenPrefix = getForbiddenPrefix(normalized);
  if (forbiddenPrefix) {
    return {
      path: normalized,
      reason: `Path starts with forbidden prefix "${forbiddenPrefix}". This directory does not exist in ConvergePanel.`,
      suggestion: getSuggestion(normalized, forbiddenPrefix),
    };
  }
  
  // Get top-level directory
  const topLevel = getTopLevelDir(normalized);
  
  // Root-level files are allowed (e.g., package.json, tsconfig.json)
  if (topLevel === null) {
    return null;
  }
  
  // Check if top-level directory is in allowed list
  if (!ALLOWED_TOP_LEVEL_DIRS.includes(topLevel as typeof ALLOWED_TOP_LEVEL_DIRS[number])) {
    // If the model proposes a test-ish top-level directory, map to lib/__tests__/
    const topLower = topLevel.toLowerCase();
    if (topLower === "test" || topLower === "tests" || topLower === "__tests__") {
      const remainder = normalized.slice(topLevel.length + 1);
      return {
        path: normalized,
        reason: `Top-level directory "${topLevel}/" is not allowed. Allowed directories: ${ALLOWED_TOP_LEVEL_DIRS.join(", ")}.`,
        suggestion: `lib/__tests__/${remainder}`,
      };
    }

    return {
      path: normalized,
      reason: `Top-level directory "${topLevel}/" is not allowed. Allowed directories: ${ALLOWED_TOP_LEVEL_DIRS.join(", ")}.`,
      // Generic fallback: keep file under lib/ (best-effort)
      suggestion: `lib/${normalized}`,
    };
  }
  
  return null;
}

/**
 * Validate a single file path for PATCHING (stricter than reading).
 * Root-level config files are read-only.
 */
export function validatePathForPatching(path: string): PathViolation | null {
  // First run standard validation
  const baseViolation = validatePath(path);
  if (baseViolation) {
    return baseViolation;
  }
  
  const normalized = normalizePath(path);
  
  // Check if it's a read-only root file
  if (isReadOnlyRootFile(normalized)) {
    return {
      path: normalized,
      reason: `Root-level file "${normalized}" is read-only. CodeCheck cannot patch this file.`,
    };
  }
  
  return null;
}

/**
 * Validate all paths in a File Plan.
 */
export function validateFilePlanPaths(filePlan: CodeCheckFilePlanEntry[]): PathValidationResult {
  const violations: PathViolation[] = [];
  
  for (const entry of filePlan) {
    const violation = validatePath(entry.path);
    if (violation) {
      violations.push(violation);
    }
  }
  
  if (violations.length === 0) {
    return {
      valid: true,
      violations: [],
      message: "All file plan paths are valid.",
    };
  }
  
  const violationSummary = violations
    .map((v) => `  - ${v.path}: ${v.reason}${v.suggestion ? ` (suggested: ${v.suggestion})` : ""}`)
    .join("\n");
  
  return {
    valid: false,
    violations,
    message: `File plan contains ${violations.length} invalid path(s):\n${violationSummary}`,
  };
}

/**
 * Validate all paths in a CodeCheck spec (both file plan and task filesTouched).
 */
export function validateSpecPaths(spec: CodeCheckSpec): PathValidationResult {
  const violations: PathViolation[] = [];
  
  // Validate file plan paths
  for (const entry of spec.filePlan) {
    const violation = validatePath(entry.path);
    if (violation) {
      violations.push({
        ...violation,
        reason: `[filePlan] ${violation.reason}`,
      });
    }
  }
  
  // Validate task filesTouched
  for (const task of spec.tasks) {
    for (const filePath of task.filesTouched) {
      const violation = validatePath(filePath);
      if (violation) {
        violations.push({
          ...violation,
          reason: `[task ${task.id}] ${violation.reason}`,
        });
      }
    }
  }
  
  if (violations.length === 0) {
    return {
      valid: true,
      violations: [],
      message: "All spec paths are valid.",
    };
  }
  
  const violationSummary = violations
    .map((v) => `  - ${v.path}: ${v.reason}${v.suggestion ? ` (suggested: ${v.suggestion})` : ""}`)
    .join("\n");
  
  return {
    valid: false,
    violations,
    message: `Spec contains ${violations.length} invalid path(s):\n${violationSummary}`,
  };
}

// ============================================
// PATCH VALIDATION
// ============================================

/**
 * Extract file paths from a unified diff.
 * Parses "+++ b/path/to/file" lines.
 */
export function extractPathsFromDiff(diff: string): string[] {
  const paths: string[] = [];
  const lines = diff.split("\n");
  
  for (const line of lines) {
    // Match "+++ b/path/to/file" or "+++ path/to/file"
    const match = line.match(/^\+\+\+\s+(?:b\/)?(.+?)(?:\s|$)/);
    if (match) {
      const path = match[1].trim();
      // Skip /dev/null (for new files)
      if (path !== "/dev/null" && path !== "dev/null") {
        paths.push(path);
      }
    }
    
    // Also check "--- a/path" for renamed/deleted files
    const minusMatch = line.match(/^---\s+(?:a\/)?(.+?)(?:\s|$)/);
    if (minusMatch) {
      const path = minusMatch[1].trim();
      if (path !== "/dev/null" && path !== "dev/null") {
        paths.push(path);
      }
    }
  }
  
  // Deduplicate
  return [...new Set(paths)];
}

/**
 * Validate all paths in a unified diff.
 */
export function validatePatchPaths(diff: string): PathValidationResult {
  const paths = extractPathsFromDiff(diff);
  const violations: PathViolation[] = [];
  
  for (const path of paths) {
    const violation = validatePath(path);
    if (violation) {
      violations.push(violation);
    }
  }
  
  if (violations.length === 0) {
    return {
      valid: true,
      violations: [],
      message: "All patch paths are valid.",
    };
  }
  
  const violationSummary = violations
    .map((v) => `  - ${v.path}: ${v.reason}${v.suggestion ? ` (suggested: ${v.suggestion})` : ""}`)
    .join("\n");
  
  return {
    valid: false,
    violations,
    message: `Patch contains ${violations.length} invalid path(s):\n${violationSummary}`,
  };
}

/**
 * Validate a CodeCheckDiff object.
 */
export function validateDiffPaths(diffObj: CodeCheckDiff): PathValidationResult {
  const violations: PathViolation[] = [];
  
  // Validate filesTouched using stricter patching rules
  for (const path of diffObj.filesTouched) {
    const violation = validatePathForPatching(path);
    if (violation) {
      violations.push({
        ...violation,
        reason: `[filesTouched] ${violation.reason}`,
      });
    }
  }
  
  // Validate paths in the actual diff content using stricter patching rules
  const paths = extractPathsFromDiff(diffObj.diff);
  for (const path of paths) {
    const violation = validatePathForPatching(path);
    if (violation) {
      violations.push({
        ...violation,
        reason: `[diff content] ${violation.reason}`,
      });
    }
  }
  
  if (violations.length === 0) {
    return {
      valid: true,
      violations: [],
      message: "All diff paths are valid.",
    };
  }
  
  const violationSummary = violations
    .map((v) => `  - ${v.path}: ${v.reason}${v.suggestion ? ` (suggested: ${v.suggestion})` : ""}`)
    .join("\n");
  
  return {
    valid: false,
    violations,
    message: `Diff contains ${violations.length} invalid path(s):\n${violationSummary}`,
  };
}

// ============================================
// PLAN ↔ PATCH INTEGRITY VALIDATION
// ============================================

/**
 * Result of plan↔patch integrity check
 */
export interface PlanPatchIntegrityResult {
  /** Whether integrity check passed */
  valid: boolean;
  /** Paths in patch that are not in file plan */
  missingFromPlan: string[];
  /** Create actions pointing to paths that failed validation */
  invalidCreatePaths: PathViolation[];
  /** Human-readable message */
  message: string;
}

/**
 * Validate that all patch paths are present in the file plan.
 * This ensures plan↔patch integrity: you can't patch a file
 * that wasn't declared in the plan.
 * 
 * @param filePlan - The file plan from the spec
 * @param diff - The unified diff content
 * @returns Integrity validation result
 */
export function validatePlanPatchIntegrity(
  filePlan: CodeCheckFilePlanEntry[],
  diff: string
): PlanPatchIntegrityResult {
  const patchPaths = extractPathsFromDiff(diff);
  const filePlanPaths = new Set(filePlan.map((e) => normalizePath(e.path)));
  
  const missingFromPlan: string[] = [];
  const invalidCreatePaths: PathViolation[] = [];
  
  // Check each patch path is in the file plan
  for (const patchPath of patchPaths) {
    const normalized = normalizePath(patchPath);
    if (!filePlanPaths.has(normalized)) {
      missingFromPlan.push(normalized);
    }
  }
  
  // Check create actions have valid paths
  for (const entry of filePlan) {
    if (entry.action === "create") {
      const violation = validatePathForPatching(entry.path);
      if (violation) {
        invalidCreatePaths.push(violation);
      }
    }
  }
  
  const valid = missingFromPlan.length === 0 && invalidCreatePaths.length === 0;
  
  if (valid) {
    return {
      valid: true,
      missingFromPlan: [],
      invalidCreatePaths: [],
      message: "Plan↔patch integrity check passed.",
    };
  }
  
  const parts: string[] = [];
  
  if (missingFromPlan.length > 0) {
    parts.push(`Patch contains ${missingFromPlan.length} path(s) not in file plan: ${missingFromPlan.join(", ")}`);
  }
  
  if (invalidCreatePaths.length > 0) {
    const createIssues = invalidCreatePaths
      .map((v) => `  - ${v.path}: ${v.reason}`)
      .join("\n");
    parts.push(`Invalid create paths:\n${createIssues}`);
  }
  
  return {
    valid: false,
    missingFromPlan,
    invalidCreatePaths,
    message: parts.join("\n"),
  };
}

/**
 * Build a structured error response for path validation failures.
 * This provides user-friendly error information for the UI.
 */
export function buildPathValidationError(
  pathResult?: PathValidationResult,
  integrityResult?: PlanPatchIntegrityResult
): {
  code: string;
  message: string;
  details: string[];
  hint: string;
} {
  const details: string[] = [];
  
  if (pathResult && !pathResult.valid) {
    for (const v of pathResult.violations) {
      details.push(`${v.path}: ${v.reason}${v.suggestion ? ` → suggested: ${v.suggestion}` : ""}`);
    }
  }
  
  if (integrityResult && !integrityResult.valid) {
    for (const path of integrityResult.missingFromPlan) {
      details.push(`${path}: Patch path not declared in file plan`);
    }
    for (const v of integrityResult.invalidCreatePaths) {
      details.push(`${v.path}: Invalid create path - ${v.reason}`);
    }
  }
  
  return {
    code: "invalid_file_paths",
    message: "Invalid file path(s) proposed by CodeCheck",
    details,
    hint: PATH_ERROR_HINT,
  };
}

// ============================================
// AUTO-CORRECTION HELPERS
// ============================================

/**
 * Replace a single path string using the violation's suggestion.
 * Returns the suggestion if available, otherwise the original.
 */
function applyPathSuggestion(original: string, violations: PathViolation[]): string {
  const normalized = normalizePath(original);
  const match = violations.find((v) => normalizePath(v.path) === normalized);
  if (match?.suggestion) return match.suggestion;
  return original;
}

/**
 * Auto-correct invalid paths in a diff object using suggestions.
 * Returns a new diff object with corrected paths (does not mutate original).
 * Also rewrites paths inside the diff text (--- a/..., +++ b/...).
 */
export function autoCorrectDiffPaths(
  diffObj: CodeCheckDiff,
  violations: PathViolation[]
): CodeCheckDiff {
  const corrected = { ...diffObj };

  // Fix filesTouched
  corrected.filesTouched = diffObj.filesTouched.map((p) =>
    applyPathSuggestion(p, violations)
  );

  // Fix paths inside the diff text
  if (corrected.diff) {
    let fixedDiff = corrected.diff;
    for (const v of violations) {
      if (!v.suggestion) continue;
      const normalizedPath = normalizePath(v.path);
      // Replace in --- a/path and +++ b/path headers
      fixedDiff = fixedDiff
        .replace(new RegExp(`--- a/${escapeRegex(normalizedPath)}`, "g"), `--- a/${v.suggestion}`)
        .replace(new RegExp(`\\+\\+\\+ b/${escapeRegex(normalizedPath)}`, "g"), `+++ b/${v.suggestion}`);
    }
    corrected.diff = fixedDiff;
  }

  // Fix diff_unified array if present
  if (corrected.diff_unified) {
    corrected.diff_unified = corrected.diff_unified.map((line) => {
      let fixed = line;
      for (const v of violations) {
        if (!v.suggestion) continue;
        const normalizedPath = normalizePath(v.path);
        fixed = fixed
          .replace(`--- a/${normalizedPath}`, `--- a/${v.suggestion}`)
          .replace(`+++ b/${normalizedPath}`, `+++ b/${v.suggestion}`);
      }
      return fixed;
    });
  }

  return corrected;
}

/**
 * Auto-correct invalid paths in a spec object using suggestions.
 * Returns a new spec object with corrected paths (does not mutate original).
 */
export function autoCorrectSpecPaths(
  spec: CodeCheckSpec,
  violations: PathViolation[]
): CodeCheckSpec {
  const corrected = { ...spec };

  // Fix filePlan paths
  corrected.filePlan = spec.filePlan.map((entry) => ({
    ...entry,
    path: applyPathSuggestion(entry.path, violations),
  }));

  // Fix task filesTouched
  corrected.tasks = spec.tasks.map((task) => ({
    ...task,
    filesTouched: task.filesTouched.map((p) => applyPathSuggestion(p, violations)),
  }));

  return corrected;
}

/** Escape a string for safe use in a RegExp */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
