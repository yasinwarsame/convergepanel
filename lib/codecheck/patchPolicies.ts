/**
 * Patch Policies — dependency file protection + sensitive file protection
 * Rejects diffs that modify protected files unless explicitly allowed.
 */

const PROTECTED_FILES = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  ".npmrc",
  ".yarnrc.yml",
] as const;

export interface PolicyViolation {
  touchedFiles: string[];
  allowed: boolean;
  reason: string;
}

export type DependencyPolicyViolation = PolicyViolation;
export type SensitiveFilePolicyViolation = PolicyViolation;

/**
 * Scans a unified diff string for lines that touch dependency/lockfiles.
 * Returns the list of protected files found in +++ b/ headers.
 */
export function detectDependencyFileTouches(diff: string): string[] {
  const touched: string[] = [];
  const lines = diff.split("\n");
  for (const line of lines) {
    if (!line.startsWith("+++ ")) continue;
    const filePath = line.replace(/^\+\+\+ [ab]\//, "").trim();
    const basename = filePath.split("/").pop() ?? filePath;
    if (PROTECTED_FILES.includes(basename as typeof PROTECTED_FILES[number])) {
      touched.push(filePath);
    }
  }
  return [...new Set(touched)];
}

/**
 * Checks whether dependency file changes are explicitly allowed by the task.
 * Looks for "[ALLOW_DEPS]" in acceptanceCriteria or constraints containing
 * "modify package.json" or "add dependency".
 */
export function isDependencyChangeAllowed(
  acceptanceCriteria: string[],
  constraints?: string
): boolean {
  const allText = [...acceptanceCriteria, constraints ?? ""].join(" ").toLowerCase();
  return (
    allText.includes("[allow_deps]") ||
    allText.includes("modify package.json") ||
    allText.includes("add dependency") ||
    allText.includes("add dependencies") ||
    allText.includes("install package") ||
    allText.includes("update dependencies")
  );
}

/**
 * Enforces the dependency policy on a diff.
 * Returns null if no violation, or a violation object if blocked.
 */
export function enforceDependencyPolicy(
  diff: string,
  acceptanceCriteria: string[],
  constraints?: string
): DependencyPolicyViolation | null {
  const touched = detectDependencyFileTouches(diff);
  if (touched.length === 0) return null;

  const allowed = isDependencyChangeAllowed(acceptanceCriteria, constraints);
  if (allowed) return null;

  return {
    touchedFiles: touched,
    allowed: false,
    reason: `Patch modifies protected dependency files: ${touched.join(", ")}. ` +
      `To allow this, include "[ALLOW_DEPS]" in acceptance criteria or mention "modify package.json" in constraints.`,
  };
}

// ============================================
// SENSITIVE FILE POLICY
// ============================================

const SENSITIVE_EXACT_FILES = [
  ".env",
  ".env.local",
  ".env.production",
  "middleware.ts",
  "middleware.js",
] as const;

const SENSITIVE_PATH_PATTERNS: RegExp[] = [
  /^\.env\./,
  /(?:^|\/)firebase\/admin/i,
  /(?:^|\/)firebase\/auth/i,
  /payment/i,
  /billing/i,
  /stripe/i,
  /secret/i,
  /credential/i,
];

function isSensitivePath(filePath: string): boolean {
  const basename = filePath.split("/").pop() ?? filePath;
  if (SENSITIVE_EXACT_FILES.includes(basename as typeof SENSITIVE_EXACT_FILES[number])) {
    return true;
  }
  for (const pattern of SENSITIVE_PATH_PATTERNS) {
    if (pattern.test(filePath)) return true;
  }
  return false;
}

export function detectSensitiveFileTouches(diff: string): string[] {
  const touched: string[] = [];
  for (const line of diff.split("\n")) {
    if (!line.startsWith("+++ ")) continue;
    const filePath = line.replace(/^\+\+\+ [ab]\//, "").trim();
    if (filePath === "/dev/null") continue;
    if (isSensitivePath(filePath)) {
      touched.push(filePath);
    }
  }
  return [...new Set(touched)];
}

export function isSensitiveChangeAllowed(
  acceptanceCriteria: string[],
  constraints?: string
): boolean {
  const allText = [...acceptanceCriteria, constraints ?? ""].join(" ").toLowerCase();
  if (allText.includes("[allow_sensitive]")) return true;
  const fileMentions = allText.match(
    /modify\s+([\w./\-]+\.(ts|js|env[\w.]*))/gi
  );
  if (!fileMentions) return false;
  return fileMentions.some((m) => {
    const mentioned = m.replace(/^modify\s+/i, "").trim();
    return isSensitivePath(mentioned);
  });
}

export function enforceSensitiveFilePolicy(
  diff: string,
  acceptanceCriteria: string[],
  constraints?: string
): SensitiveFilePolicyViolation | null {
  const touched = detectSensitiveFileTouches(diff);
  if (touched.length === 0) return null;

  const allowed = isSensitiveChangeAllowed(acceptanceCriteria, constraints);
  if (allowed) return null;

  return {
    touchedFiles: touched,
    allowed: false,
    reason: `Patch modifies sensitive files: ${touched.join(", ")}. ` +
      `To allow this, include "[ALLOW_SENSITIVE]" in acceptance criteria or explicitly mention modifying these files in constraints.`,
  };
}
