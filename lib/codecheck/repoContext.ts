/**
 * Repo Context — server-side introspection snapshot
 * Builds a context object describing the repo structure, deps, and conventions.
 * Injected into Planner + Implementer prompts so the LLM never invents paths.
 */

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { ALLOWED_TOP_LEVEL_DIRS } from "./pathValidation";
import { detectTestFramework, type TestFrameworkDetection } from "./testFramework";

export interface RepoContext {
  repoRoot: string;
  hasSrcDir: boolean;
  allowedTopDirs: string[];
  detectedTestFramework: TestFrameworkDetection;
  scripts: Record<string, string>;
  dependencies: Record<string, string>;
  importantPaths: string[];
  fileTreePreview: string[];
  repoSha?: string;
}

const IMPORTANT_PATHS = [
  "lib/firestore/sanitize.ts",
  "lib/firestore/safeWrite.ts",
  "lib/codecheck/orchestrate.ts",
  "lib/codecheck/prompts.ts",
  "lib/codecheck/types.ts",
  "lib/codecheck/pathValidation.ts",
  "lib/codecheck/testFramework.ts",
  "app/api/codecheck/route.ts",
  "app/codecheck/page.tsx",
  "lib/__tests__/",
  "scripts/",
];

const SKIP_DIRS = new Set([
  "node_modules", ".next", ".git", ".cache", ".vercel",
  "dist", "build", "coverage", ".turbo",
]);

const MAX_TREE_ENTRIES = 200;

function safeReadPackageJson(root: string): Record<string, unknown> | null {
  try {
    const raw = fs.readFileSync(path.join(root, "package.json"), "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function getStringRecord(obj: unknown): Record<string, string> {
  if (!obj || typeof obj !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function buildShallowTree(root: string, maxDepth: number): string[] {
  const entries: string[] = [];

  function walk(dir: string, depth: number, prefix: string) {
    if (depth > maxDepth || entries.length >= MAX_TREE_ENTRIES) return;
    let items: string[];
    try {
      items = fs.readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const item of items) {
      if (entries.length >= MAX_TREE_ENTRIES) break;
      if (SKIP_DIRS.has(item)) continue;
      if (item.startsWith(".") && depth === 0) continue;

      const fullPath = path.join(dir, item);
      const relPath = prefix ? `${prefix}/${item}` : item;
      let isDir = false;
      try {
        isDir = fs.statSync(fullPath).isDirectory();
      } catch {
        continue;
      }

      // At depth 0, only include allowed top-level dirs
      if (depth === 0 && isDir && !ALLOWED_TOP_LEVEL_DIRS.includes(item as typeof ALLOWED_TOP_LEVEL_DIRS[number])) {
        continue;
      }

      entries.push(isDir ? `${relPath}/` : relPath);
      if (isDir) {
        walk(fullPath, depth + 1, relPath);
      }
    }
  }

  walk(root, 0, "");
  return entries;
}

function getRepoSha(root: string): string | undefined {
  try {
    return execSync("git rev-parse HEAD", { cwd: root, timeout: 3000 })
      .toString()
      .trim();
  } catch {
    return undefined;
  }
}

function filterExistingPaths(root: string, paths: string[]): string[] {
  return paths.filter((p) => {
    try {
      fs.accessSync(path.join(root, p));
      return true;
    } catch {
      return false;
    }
  });
}

export function buildRepoContext(
  opts: { projectRoot?: string } = {}
): RepoContext {
  const root = opts.projectRoot ?? process.cwd();

  try {
    const pkg = safeReadPackageJson(root);
    const scripts = pkg ? getStringRecord(pkg.scripts) : {};
    const dependencies = pkg
      ? { ...getStringRecord(pkg.dependencies), ...getStringRecord(pkg.devDependencies) }
      : {};

    let hasSrcDir = false;
    try {
      hasSrcDir = fs.statSync(path.join(root, "src")).isDirectory();
    } catch { /* no src/ */ }

    const testFramework = detectTestFramework(root);
    const importantPaths = filterExistingPaths(root, IMPORTANT_PATHS);
    const fileTreePreview = buildShallowTree(root, 3);
    const repoSha = getRepoSha(root);

    return {
      repoRoot: root,
      hasSrcDir,
      allowedTopDirs: [...ALLOWED_TOP_LEVEL_DIRS],
      detectedTestFramework: testFramework,
      scripts,
      dependencies,
      importantPaths,
      fileTreePreview,
      repoSha,
    };
  } catch {
    return {
      repoRoot: root,
      hasSrcDir: false,
      allowedTopDirs: [...ALLOWED_TOP_LEVEL_DIRS],
      detectedTestFramework: { framework: "none", hasTestScript: false, notes: ["Failed to detect"] },
      scripts: {},
      dependencies: {},
      importantPaths: [],
      fileTreePreview: [],
    };
  }
}

export function formatRepoContextForPrompt(ctx: RepoContext): string {
  const MAX_CONTEXT_CHARS = 8000;
  const lines: string[] = [
    "REPO_CONTEXT:",
    `  hasSrcDir: ${ctx.hasSrcDir}`,
    `  allowedTopDirs: ${ctx.allowedTopDirs.join(", ")}`,
    `  testFramework: ${ctx.detectedTestFramework.framework}`,
    `  hasTestScript: ${ctx.detectedTestFramework.hasTestScript}`,
    ctx.detectedTestFramework.testCommand
      ? `  testCommand: ${ctx.detectedTestFramework.testCommand}`
      : "",
    `  scripts: ${Object.keys(ctx.scripts).join(", ") || "(none)"}`,
    `  importantPaths:\n${ctx.importantPaths.map((p) => `    - ${p}`).join("\n")}`,
    `  repoSha: ${ctx.repoSha ?? "(not a git repo)"}`,
    `  fileTree (top entries):`,
    ...ctx.fileTreePreview.slice(0, 60).map((e) => `    ${e}`),
    ctx.fileTreePreview.length > 60
      ? `    ... (${ctx.fileTreePreview.length - 60} more entries)`
      : "",
  ].filter(Boolean);

  const result = lines.join("\n");
  return result.length > MAX_CONTEXT_CHARS
    ? result.slice(0, MAX_CONTEXT_CHARS) + "\n  ... (truncated)"
    : result;
}
