/**
 * Test Framework Detection (server-side)
 *
 * Detects whether the repo already has a test runner configured.
 * This is used to enforce: "Add tests only if a test framework already exists;
 * otherwise provide a dev verification snippet/script."
 */

import fs from "fs";
import path from "path";

export type TestFramework = "vitest" | "jest" | "playwright" | "none";

export interface TestFrameworkDetection {
  framework: TestFramework;
  hasTestScript: boolean;
  testCommand?: string;
  notes: string[];
}

function readPackageJson(repoRoot: string): Record<string, unknown> | null {
  try {
    const p = path.join(repoRoot, "package.json");
    const raw = fs.readFileSync(p, "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function getStringRecord(obj: unknown): Record<string, string> {
  if (!obj || typeof obj !== "object") return {};
  const rec = obj as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function hasAnyDep(deps: Record<string, string>, names: string[]): boolean {
  return names.some((n) => Object.prototype.hasOwnProperty.call(deps, n));
}

/**
 * Detect the test framework by inspecting package.json scripts and deps.
 * - Prefers explicit dependencies (vitest/jest/playwright)
 * - Falls back to test script contents heuristics
 */
export function detectTestFramework(repoRoot: string = process.cwd()): TestFrameworkDetection {
  const pkg = readPackageJson(repoRoot);
  if (!pkg) {
    return {
      framework: "none",
      hasTestScript: false,
      notes: ["package.json not found or unreadable; treating as no test framework."],
    };
  }

  const scripts = getStringRecord((pkg as Record<string, unknown>).scripts);
  const deps = {
    ...getStringRecord((pkg as Record<string, unknown>).dependencies),
    ...getStringRecord((pkg as Record<string, unknown>).devDependencies),
  };

  const hasTestScript = typeof scripts.test === "string" && scripts.test.trim().length > 0;
  const notes: string[] = [];

  // Dependency-based detection (most reliable)
  if (hasAnyDep(deps, ["vitest"])) {
    notes.push("Detected vitest dependency.");
    return {
      framework: "vitest",
      hasTestScript,
      testCommand: hasTestScript ? "npm test" : "npx vitest run",
      notes,
    };
  }

  if (hasAnyDep(deps, ["jest", "ts-jest", "@jest/globals"])) {
    notes.push("Detected jest dependency.");
    return {
      framework: "jest",
      hasTestScript,
      testCommand: hasTestScript ? "npm test" : "npx jest",
      notes,
    };
  }

  if (hasAnyDep(deps, ["@playwright/test", "playwright"])) {
    notes.push("Detected playwright dependency.");
    return {
      framework: "playwright",
      hasTestScript,
      testCommand: hasTestScript ? "npm test" : "npx playwright test",
      notes,
    };
  }

  // Script heuristic fallback
  if (hasTestScript) {
    const s = scripts.test.toLowerCase();
    if (s.includes("vitest")) {
      notes.push("Detected vitest via test script.");
      return { framework: "vitest", hasTestScript: true, testCommand: "npm test", notes };
    }
    if (s.includes("jest")) {
      notes.push("Detected jest via test script.");
      return { framework: "jest", hasTestScript: true, testCommand: "npm test", notes };
    }
    if (s.includes("playwright")) {
      notes.push("Detected playwright via test script.");
      return { framework: "playwright", hasTestScript: true, testCommand: "npm test", notes };
    }
    notes.push("test script exists but runner not identifiable; treating as 'none' to avoid inventing tests.");
  } else {
    notes.push("No test script found and no known test runner deps detected.");
  }

  return {
    framework: "none",
    hasTestScript,
    notes,
  };
}

/**
 * Standard verification commands policy:
 * - Always: typecheck + build
 * - Add tests only if a framework exists (and preferably a test script)
 */
export function getRecommendedVerificationCommands(det: TestFrameworkDetection): string[] {
  const base = ["npx tsc --noEmit", "npm run build"];
  if (det.framework !== "none" && det.testCommand) return [...base, det.testCommand];
  return base;
}
