/**
 * Query-Routing Redesign, Milestone 1 — protected-feature import boundary.
 *
 * A second, independent layer on top of the .eslintrc.json no-restricted-imports
 * rule: a static source scan (not ESLint's AST, so it can't silently stop
 * working if the ESLint config ever gets reorganized) proving no file under
 * lib/adaptiveSchema/** or components/adaptive/** imports from the protected
 * Claim Verification / Video Verification implementations.
 */

import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

const ROOT = join(__dirname, "..", "..", "..");
const SCAN_DIRS = [join(ROOT, "lib", "adaptiveSchema"), join(ROOT, "components", "adaptive")];

const FORBIDDEN_SPECIFIER_PATTERNS: RegExp[] = [
  /["']@\/lib\/video(\/|["'])/,
  /["']@\/app\/api\/verify-video(\/|["'])/,
  /["']@\/components\/VideoVerificationResult["']/,
  /["']@\/app\/api\/verify-claim(\/|["'])/,
  /["']@\/components\/ClaimVerificationResult["']/,
  /["']@\/lib\/verification\/runClaimVerificationPanel["']/,
  /["']@\/lib\/verification\/claimVerificationPrompt["']/,
  /["']@\/lib\/verification\/claimVerdict["']/,
  /["']@\/lib\/verification\/claimVerificationClientPayload["']/,
  /["']@\/lib\/verification\/cleanJsonResponse["']/,
  /["']@\/lib\/verification\/parseVerificationJson["']/,
  /["']@\/lib\/verification\/agreementDigest["']/,
  /["']@\/lib\/verification\/auditBundle["']/,
];

function listSourceFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = join(dir, entry);
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      files.push(...listSourceFiles(fullPath));
    } else if (/\.(ts|tsx)$/.test(entry) && !entry.endsWith(".d.ts")) {
      files.push(fullPath);
    }
  }
  return files;
}

describe("Import boundary: lib/adaptiveSchema and components/adaptive never import protected files", () => {
  const files = SCAN_DIRS.flatMap((dir) => listSourceFiles(dir));

  it("scanned at least one file per protected directory (sanity check the scan itself isn't a no-op)", () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it.each(files.map((f) => [f.replace(ROOT, ""), f] as const))("%s has no forbidden import", (_label, filePath) => {
    const content = readFileSync(filePath, "utf-8");
    for (const pattern of FORBIDDEN_SPECIFIER_PATTERNS) {
      expect(content).not.toMatch(pattern);
    }
  });
});
