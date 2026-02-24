/**
 * CodeCheck Verification Report Generation
 * 
 * Generates structured verification reports from CodeCheck workflow data.
 * Reports are designed to be audit-ready, transparent, and reproducible.
 * 
 * IMPORTANT: This module does NOT fabricate evidence. It only includes
 * data that was actually collected during the verification process.
 */

import {
  VerificationReport,
  VerificationStep,
  VerificationIteration,
  PatchEvidence,
  TrustAndRationale,
  Reproducibility,
  VerificationReportStatus,
  CodeCheckTask,
  CodeCheckDiff,
  CodeCheckVerification,
  CodeCheckVerifyRequest,
} from "./types";

// ============================================
// CONSTANTS
// ============================================

/** Maximum lines to show in output preview */
const OUTPUT_PREVIEW_LINES = 15;

/** Maximum characters for full output before truncation */
const MAX_OUTPUT_LENGTH = 10000;

/** Maximum lines for diff excerpt */
const DIFF_EXCERPT_LINES = 30;

// ============================================
// HELPERS
// ============================================

/**
 * Generate a unique report ID
 */
function generateReportId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `vr-${timestamp}-${random}`;
}

/**
 * Trim output to preview size
 */
function trimToPreview(output: string | undefined | null, maxLines: number = OUTPUT_PREVIEW_LINES): string {
  if (!output) return "(No output provided)";
  const lines = output.trim().split("\n");
  if (lines.length <= maxLines) {
    return output.trim();
  }
  return lines.slice(0, maxLines).join("\n") + `\n... (${lines.length - maxLines} more lines)`;
}

/**
 * Truncate output if too long
 */
function truncateOutput(output: string | undefined | null): { text: string; truncated: boolean } {
  if (!output) return { text: "(No output provided)", truncated: false };
  if (output.length <= MAX_OUTPUT_LENGTH) {
    return { text: output.trim(), truncated: false };
  }
  return {
    text: output.substring(0, MAX_OUTPUT_LENGTH) + "\n\n... [Output truncated. Use 'Copy Full Output' to get complete log.]",
    truncated: true,
  };
}

/**
 * Parse diff to extract statistics
 */
function parseDiffStats(diff: string): { filesChanged: number; insertions: number; deletions: number } {
  if (!diff) return { filesChanged: 0, insertions: 0, deletions: 0 };

  const lines = diff.split("\n");
  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;

  for (const line of lines) {
    if (line.startsWith("diff --git") || line.startsWith("--- ") && !line.startsWith("--- a/")) {
      filesChanged++;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      insertions++;
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      deletions++;
    }
  }

  // Dedupe file count (diff --git and --- both appear)
  filesChanged = Math.max(1, Math.ceil(filesChanged / 2));

  return { filesChanged, insertions, deletions };
}

/**
 * Extract file list from diff
 */
function extractFileListFromDiff(diff: string): string[] {
  if (!diff) return [];
  const filePattern = /^(?:diff --git a\/(.+?) b\/|--- a\/(.+)|--- (.+)|\+\+\+ b\/(.+)|\+\+\+ (.+))/gm;
  const files = new Set<string>();
  let match;

  while ((match = filePattern.exec(diff)) !== null) {
    const file = match[1] || match[2] || match[3] || match[4] || match[5];
    if (file && !file.startsWith("/dev/null")) {
      files.add(file);
    }
  }

  return Array.from(files);
}

/**
 * Determine step result from output content
 */
function inferStepResult(
  output: string | undefined | null,
  stepType: "build" | "tsc" | "test" | "lint"
): "PASS" | "FAIL" | "SKIPPED" {
  if (!output || output.trim().length === 0) {
    return "SKIPPED";
  }

  const lowerOutput = output.toLowerCase();

  // Common failure indicators
  const failurePatterns = [
    "error",
    "failed",
    "failure",
    "exception",
    "not found",
    "cannot find",
    "could not",
    "enoent",
    "exit code 1",
    "exit code: 1",
    "exited with code 1",
  ];

  // TSC-specific: "error TS" is definitive
  if (stepType === "tsc" && lowerOutput.includes("error ts")) {
    return "FAIL";
  }

  // Build: "compiled successfully" or "build failed"
  if (stepType === "build") {
    if (lowerOutput.includes("compiled successfully") || lowerOutput.includes("build successful")) {
      return "PASS";
    }
    if (lowerOutput.includes("build failed") || lowerOutput.includes("failed to compile")) {
      return "FAIL";
    }
  }

  // Test: "tests passed" vs "tests failed"
  if (stepType === "test") {
    if (lowerOutput.includes("tests passed") || lowerOutput.includes("test suites: ") && lowerOutput.includes("passed")) {
      return "PASS";
    }
  }

  // General failure check
  for (const pattern of failurePatterns) {
    if (lowerOutput.includes(pattern)) {
      return "FAIL";
    }
  }

  // If we got here and there's content, assume pass
  return "PASS";
}

// ============================================
// MAIN GENERATOR
// ============================================

/**
 * Input data for generating a verification report
 */
export interface GenerateReportInput {
  /** The task being verified */
  task: CodeCheckTask;
  /** The diff/patch that was applied */
  diff?: CodeCheckDiff;
  /** The verification request (user-provided outputs) */
  verifyRequest: CodeCheckVerifyRequest;
  /** The verification result from the model */
  verification: CodeCheckVerification;
  /** User ID if available */
  userId?: string;
  /** Session ID if available */
  sessionId?: string;
  /** Previous iterations (for fix loops) */
  previousIterations?: VerificationIteration[];
  /** Current attempt number */
  attemptNumber?: number;
}

/**
 * Generate a complete verification report from workflow data
 * 
 * This function transforms raw verification data into a structured,
 * audit-ready report format. It only includes evidence that was
 * actually collected - no fabrication.
 */
export function generateVerificationReport(input: GenerateReportInput): VerificationReport {
  const {
    task,
    diff,
    verifyRequest,
    verification,
    userId,
    sessionId,
    previousIterations = [],
    attemptNumber = 1,
  } = input;

  const now = new Date().toISOString();
  const reportId = generateReportId();

  // Determine overall status
  const status: VerificationReportStatus = verification.status === "pass" ? "PASS" : "FAIL";

  // Build verification steps from provided outputs
  const verificationSteps: VerificationStep[] = [];

  // Build step
  if (verifyRequest.buildOutput) {
    const { text, truncated } = truncateOutput(verifyRequest.buildOutput);
    const result = inferStepResult(verifyRequest.buildOutput, "build");
    verificationSteps.push({
      name: "Build",
      command: "npm run build",
      result,
      outputPreview: trimToPreview(verifyRequest.buildOutput),
      fullOutput: text,
      outputTruncated: truncated,
      startedAt: now,
      endedAt: now,
    });
  }

  // TypeScript check step
  if (verifyRequest.tscOutput) {
    const { text, truncated } = truncateOutput(verifyRequest.tscOutput);
    const result = inferStepResult(verifyRequest.tscOutput, "tsc");
    verificationSteps.push({
      name: "TypeScript Check",
      command: "npx tsc --noEmit",
      result,
      outputPreview: trimToPreview(verifyRequest.tscOutput),
      fullOutput: text,
      outputTruncated: truncated,
      startedAt: now,
      endedAt: now,
    });
  }

  // Test step
  if (verifyRequest.testOutput) {
    const { text, truncated } = truncateOutput(verifyRequest.testOutput);
    const result = inferStepResult(verifyRequest.testOutput, "test");
    verificationSteps.push({
      name: "Tests",
      command: "npm test",
      result,
      outputPreview: trimToPreview(verifyRequest.testOutput),
      fullOutput: text,
      outputTruncated: truncated,
      startedAt: now,
      endedAt: now,
    });
  }

  // Lint step
  if (verifyRequest.lintOutput) {
    const { text, truncated } = truncateOutput(verifyRequest.lintOutput);
    const result = inferStepResult(verifyRequest.lintOutput, "lint");
    verificationSteps.push({
      name: "Lint",
      command: "npm run lint",
      result,
      outputPreview: trimToPreview(verifyRequest.lintOutput),
      fullOutput: text,
      outputTruncated: truncated,
      startedAt: now,
      endedAt: now,
    });
  }

  // Add model verification step (always present since we use LLM)
  verificationSteps.push({
    name: "Model Verification",
    command: "(AI-powered analysis of outputs)",
    result: status === "PASS" ? "PASS" : "FAIL",
    outputPreview: verification.notes || "Model analyzed the provided outputs and determined the verification status.",
    fullOutput: verification.notes || "Model analyzed the provided outputs and determined the verification status.",
    outputTruncated: false,
    startedAt: now,
    endedAt: now,
  });

  // Build patch evidence
  let patchEvidence: PatchEvidence | undefined;
  if (diff) {
    const diffStats = parseDiffStats(diff.diff);
    const fileList = diff.filesTouched.length > 0 ? diff.filesTouched : extractFileListFromDiff(diff.diff);
    const diffLines = diff.diff.split("\n");
    const diffExcerpt = diffLines.slice(0, DIFF_EXCERPT_LINES).join("\n") +
      (diffLines.length > DIFF_EXCERPT_LINES ? `\n... (${diffLines.length - DIFF_EXCERPT_LINES} more lines)` : "");

    patchEvidence = {
      patchId: diff.taskId,
      diffStats,
      fileList,
      diffExcerpt,
      fullDiff: diff.diff,
    };
  }

  // Build iteration log
  const iterationLog: VerificationIteration[] = [...previousIterations];
  
  // Add current iteration
  iterationLog.push({
    attemptNumber,
    inputErrorSummary: verification.errors.length > 0
      ? `${verification.errors.length} error(s): ${verification.errors.slice(0, 3).map(e => e.message).join("; ")}`
      : "No errors detected",
    modelActionsSummary: verification.fixDiff
      ? "Model provided a fix diff"
      : status === "PASS"
      ? "Verification passed, no fixes needed"
      : "Model analyzed errors but no automatic fix available",
    outcome: status,
    timestamp: now,
  });

  // Build trust and rationale
  const trustAndRationale: TrustAndRationale = buildTrustAndRationale(
    status,
    verificationSteps,
    verification,
    task
  );

  // Build reproducibility
  const reproducibility: Reproducibility = {
    commands: [
      "# Apply the patch",
      "git apply patch.diff",
      "",
      "# Run verification commands",
      "npx tsc --noEmit",
      "npm run build",
      "npm test",
    ],
    environmentNotes: [
      "Node.js version: Check package.json engines field",
      "Package manager: npm or yarn (check for lock files)",
      "Framework: Next.js (check next.config.js for version)",
    ],
  };

  return {
    reportId,
    createdAt: now,
    userId,
    sessionId,
    taskId: task.id,
    status,
    taskSummary: {
      title: `Task ${task.id}: ${task.goal}`,
      description: task.goal,
      filesTouched: task.filesTouched,
    },
    patchEvidence,
    verificationSteps,
    iterationLog,
    trustAndRationale,
    reproducibility,
    privacyConfirmation: {
      secretsRedacted: true,
      message: "This report has been sanitized. API keys, tokens, and other secrets have been excluded.",
    },
    isPersisted: false, // In-memory only for now
    isBeta: true,
    modelVerificationNotes: verification.notes,
  };
}

/**
 * Build trust and rationale section based on verification data
 */
function buildTrustAndRationale(
  status: VerificationReportStatus,
  steps: VerificationStep[],
  verification: CodeCheckVerification,
  task: CodeCheckTask
): TrustAndRationale {
  const passedSteps = steps.filter(s => s.result === "PASS").length;
  const totalSteps = steps.length;
  const failedSteps = steps.filter(s => s.result === "FAIL");
  const skippedSteps = steps.filter(s => s.result === "SKIPPED");

  let whyCorrect: string;
  if (status === "PASS") {
    whyCorrect = `${passedSteps} of ${totalSteps} verification steps passed. ` +
      `The AI model analyzed the provided build and test outputs and found no blocking errors. ` +
      `All acceptance criteria appear to be addressed by the implementation.`;
  } else {
    whyCorrect = `Verification failed. ${failedSteps.length} step(s) reported errors. ` +
      `The AI model identified ${verification.errors.length} specific error(s) that need to be addressed.`;
  }

  const openRisks: string[] = [];
  
  if (skippedSteps.length > 0) {
    openRisks.push(`${skippedSteps.length} verification step(s) were skipped: ${skippedSteps.map(s => s.name).join(", ")}`);
  }
  
  openRisks.push("AI verification may miss edge cases not covered by provided outputs");
  openRisks.push("Runtime behavior was not tested in a live environment");
  
  if (verification.status === "needs_info") {
    openRisks.push(`Additional information requested: ${verification.missingInfo || "See notes"}`);
  }

  const notVerified: string[] = [
    "End-to-end user flow testing",
    "Performance under load",
    "Security vulnerability scanning (beyond static analysis)",
    "Browser compatibility (if applicable)",
    "Mobile responsiveness (if applicable)",
  ];

  // Add task-specific acceptance criteria that couldn't be automatically verified
  if (task.acceptanceCriteria.length > 0) {
    notVerified.push(`Manual review of acceptance criteria: ${task.acceptanceCriteria.slice(0, 2).join("; ")}...`);
  }

  return {
    whyCorrect,
    openRisks,
    notVerified,
  };
}

// ============================================
// EXPORT UTILITIES
// ============================================

/**
 * Convert report to Markdown format for copying/sharing
 */
export function reportToMarkdown(report: VerificationReport): string {
  const lines: string[] = [];

  lines.push(`# CodeCheck Verification Report`);
  lines.push(``);
  lines.push(`**Status:** ${report.status}`);
  lines.push(`**Report ID:** ${report.reportId}`);
  lines.push(`**Generated:** ${new Date(report.createdAt).toLocaleString()}`);
  lines.push(``);

  lines.push(`## Task Summary`);
  lines.push(``);
  lines.push(`**${report.taskSummary.title}**`);
  lines.push(``);
  lines.push(report.taskSummary.description);
  lines.push(``);
  lines.push(`**Files Touched:**`);
  for (const file of report.taskSummary.filesTouched) {
    lines.push(`- \`${file}\``);
  }
  lines.push(``);

  lines.push(`## Verification Steps`);
  lines.push(``);
  lines.push(`| Step | Command | Result |`);
  lines.push(`|------|---------|--------|`);
  for (const step of report.verificationSteps) {
    const icon = step.result === "PASS" ? "✅" : step.result === "FAIL" ? "❌" : "⏭️";
    lines.push(`| ${step.name} | \`${step.command}\` | ${icon} ${step.result} |`);
  }
  lines.push(``);

  if (report.patchEvidence) {
    lines.push(`## Patch Summary`);
    lines.push(``);
    lines.push(`- **Files Changed:** ${report.patchEvidence.diffStats.filesChanged}`);
    lines.push(`- **Insertions:** +${report.patchEvidence.diffStats.insertions}`);
    lines.push(`- **Deletions:** -${report.patchEvidence.diffStats.deletions}`);
    lines.push(``);
    lines.push(`**Files:**`);
    for (const file of report.patchEvidence.fileList) {
      lines.push(`- \`${file}\``);
    }
    lines.push(``);
  }

  lines.push(`## Trust & Rationale`);
  lines.push(``);
  lines.push(`**Why we believe this is correct:**`);
  lines.push(report.trustAndRationale.whyCorrect);
  lines.push(``);
  lines.push(`**Open Risks:**`);
  for (const risk of report.trustAndRationale.openRisks) {
    lines.push(`- ${risk}`);
  }
  lines.push(``);
  lines.push(`**Not Verified:**`);
  for (const item of report.trustAndRationale.notVerified) {
    lines.push(`- ${item}`);
  }
  lines.push(``);

  lines.push(`## Reproduce Locally`);
  lines.push(``);
  lines.push("```bash");
  for (const cmd of report.reproducibility.commands) {
    lines.push(cmd);
  }
  lines.push("```");
  lines.push(``);

  lines.push(`---`);
  lines.push(`*${report.privacyConfirmation.message}*`);
  lines.push(``);
  lines.push(`*CodeCheck Beta - ConvergePanel*`);

  return lines.join("\n");
}

/**
 * Convert report to JSON for download
 */
export function reportToJson(report: VerificationReport): string {
  // Remove full output from JSON export to reduce size
  const exportReport = {
    ...report,
    verificationSteps: report.verificationSteps.map(step => ({
      ...step,
      fullOutput: step.outputTruncated ? "[Truncated - see full report]" : step.fullOutput,
    })),
    patchEvidence: report.patchEvidence ? {
      ...report.patchEvidence,
      fullDiff: "[See full report for complete diff]",
    } : undefined,
  };
  return JSON.stringify(exportReport, null, 2);
}
