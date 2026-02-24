/**
 * CodeCheck Types
 * 
 * Type definitions for the ConvergePanel CodeCheck (beta) workflow.
 * This module defines types for the 3-model orchestration:
 * - Planner: requirements → spec + task list
 * - Implementer: task + files → unified diff
 * - Verifier: logs → pass/fail + fix diff
 * 
 * IMPORTANT: No `as any` casts. All types are strict.
 */

// ============================================
// INTAKE TYPES
// ============================================

/**
 * User-provided intake for CodeCheck workflow
 */
export interface CodeCheckIntake {
  /** Feature/bug requirements (what, who, why) */
  requirements: string;
  /** Tech stack info (frameworks, versions, key dependencies) */
  stack: string;
  /** Constraints and "do not change" areas */
  constraints: string;
  /** Optional: file tree or list of relevant file paths */
  fileTree?: string;
  /** Optional: verification commands available (e.g., "npm run build") */
  verificationCommands?: string[];
}

// ============================================
// SPEC & TASK TYPES (Planner output)
// ============================================

/**
 * A file in the file plan
 */
export interface CodeCheckFilePlanEntry {
  /** File path (relative to repo root) */
  path: string;
  /** Purpose/description of this file */
  purpose: string;
  /** Whether to create or modify */
  action: "create" | "modify";
}

/**
 * A single atomic task in the task list
 */
export interface CodeCheckTask {
  /** Task ID (e.g., "1", "2", etc.) */
  id: string;
  /** Short goal description */
  goal: string;
  /** Files this task will touch */
  filesTouched: string[];
  /** Acceptance criteria (checklist items) */
  acceptanceCriteria: string[];
  /** Verification commands to run after implementation */
  verificationCommands: string[];
  /** Optional: dependencies on other task IDs */
  dependsOn?: string[];
}

/**
 * Contested area with multiple options
 */
export interface CodeCheckContestedArea {
  /** What decision needs to be made */
  topic: string;
  /** Available options */
  options: Array<{
    id: string;
    approach: string;
    tradeoff: string;
  }>;
  /** Recommended option ID */
  recommendation: string;
  /** Why this option is recommended */
  recommendationReason: string;
}

/**
 * Full spec output from Planner
 */
export interface CodeCheckSpec {
  /** Summary bullets (max 5) */
  summary: string[];
  /** Architecture description (text) */
  architecture: string;
  /** File plan */
  filePlan: CodeCheckFilePlanEntry[];
  /** Ordered task list */
  tasks: CodeCheckTask[];
  /** Assumptions made due to missing info */
  assumptions: string[];
  /** Contested areas (if any) */
  contestedAreas: CodeCheckContestedArea[];
}

// ============================================
// IMPLEMENTATION TYPES (Implementer output)
// ============================================

/**
 * File content provided by user for implementation
 */
export interface CodeCheckFileContent {
  /** File path */
  path: string;
  /** Full file content */
  content: string;
}

/**
 * Implementation request (task + file contents)
 */
/**
 * Summary of a previously completed task (for cross-task awareness)
 */
export interface PriorTaskSummary {
  /** Schema version for forward compatibility (bump when fields change) */
  v: 1;
  /** Task ID */
  taskId: string;
  /** Brief description of what was done */
  goal: string;
  /** Files created or modified by this task */
  filesTouched: string[];
  /** The unified diff text (so implementer knows what code exists) */
  diff: string;
  /**
   * SHA-256 hash of the full diff (hex). Present when the diff was truncated
   * so the server can verify integrity if needed in the future.
   */
  diffHash?: string;
}

export interface CodeCheckImplementRequest {
  /** The task to implement */
  task: CodeCheckTask;
  /** Contents of files needed for implementation */
  fileContents: CodeCheckFileContent[];
  /** Context from previously completed tasks in this workflow */
  priorTasks?: PriorTaskSummary[];
}

/**
 * Unified diff output from Implementer
 */
export interface CodeCheckDiff {
  /** Task ID this diff implements */
  taskId: string;
  /** Files touched by this diff */
  filesTouched: string[];
  /** Diff lines as array of strings (join with newline). Preferred — avoids JSON parse issues. */
  diff_unified?: string[];
  /** Base64 chunks (each ≤200 chars). Join then decode for diff text. Legacy. */
  diff_b64_chunks?: string[];
  /** Base64-encoded unified diff (UTF-8). Legacy fallback. */
  diff_b64?: string;
  /** The unified diff (git-apply compatible) */
  diff: string;
  /** Optional implementation notes */
  notes?: string;
  /** Whether Implementer needs more files */
  needsMoreFiles?: string[];
  /** Verification commands to run after applying patch */
  verificationCommands?: string[];
}

// ============================================
// VERIFICATION TYPES (Verifier output)
// ============================================

/**
 * A single error parsed from verification logs
 */
export interface CodeCheckError {
  /** File path where error occurred */
  file: string;
  /** Line number (if available) */
  line?: number;
  /** Column number (if available) */
  column?: number;
  /** Error message */
  message: string;
  /** Error severity */
  severity: "error" | "warning";
}

/**
 * Verification request (logs from user)
 */
export interface CodeCheckVerifyRequest {
  /** Task ID being verified */
  taskId: string;
  /** Build output (e.g., npm run build) */
  buildOutput?: string;
  /** TypeScript check output (e.g., npx tsc --noEmit) */
  tscOutput?: string;
  /** Test output (e.g., npm test) */
  testOutput?: string;
  /** Lint output (e.g., npm run lint) */
  lintOutput?: string;
  /** Files touched by the diff (used for pre-existing error filtering) */
  filesTouched?: string[];
  /** Verification commands that were run (for evidence tracking) */
  verificationCommands?: string[];
}

/**
 * Verification result from Verifier
 */
export interface CodeCheckVerification {
  /** Task ID verified */
  taskId: string;
  /** Overall status */
  status: "pass" | "fail" | "needs_info";
  /** Parsed errors (if any) */
  errors: CodeCheckError[];
  /** Fix diff (if status is "fail") */
  fixDiff?: string;
  /** Diagnosis notes */
  notes?: string;
  /** What info is missing (if status is "needs_info") */
  missingInfo?: string;
}

// ============================================
// DECISION LOG & REPORT TYPES
// ============================================

/**
 * A decision made during the workflow
 */
export interface CodeCheckDecision {
  /** ISO timestamp */
  timestamp: string;
  /** What was decided */
  decision: string;
  /** Why it was decided */
  reason: string;
  /** Who approved (always "user" in v1) */
  approvedBy: "user";
}

/**
 * Final verification report
 */
export interface CodeCheckReport {
  /** Number of tasks completed */
  tasksCompleted: number;
  /** Number of tasks that passed on first try */
  tasksPassedFirstTry: number;
  /** Number of tasks requiring fixes */
  tasksRequiringFixes: number;
  /** Total fix iterations across all tasks */
  totalFixIterations: number;
  /** Unsafe patterns found (should be empty if rules followed) */
  unsafePatternsFound: string[];
  /** Decision log */
  decisionLog: CodeCheckDecision[];
  /** Recommendations for follow-up */
  recommendations: string[];
}

// ============================================
// API TYPES
// ============================================

/**
 * CodeCheck API action types
 */
export type CodeCheckAction = "plan" | "implement" | "verify";

/**
 * CodeCheck API request body
 */
export interface CodeCheckApiRequest {
  action: CodeCheckAction;
  /** For "plan" action */
  intake?: CodeCheckIntake;
  /** For "implement" action */
  implementRequest?: CodeCheckImplementRequest;
  /** For "verify" action */
  verifyRequest?: CodeCheckVerifyRequest;
}

// ============================================
// MULTI-MODEL TYPES
// ============================================

/**
 * Issue severity level
 */
export type CodeCheckIssueSeverity = "low" | "medium" | "high";

/**
 * A single issue identified by the Claude reviewer
 */
export interface CodeCheckReviewIssue {
  /** Short issue title */
  title: string;
  /** Detailed explanation */
  detail: string;
  /** Issue severity */
  severity: CodeCheckIssueSeverity;
}

/**
 * Claude Opus review result
 */
export interface CodeCheckClaudeReview {
  /** Overall review summary */
  reviewSummary: string;
  /** List of issues found */
  issues: CodeCheckReviewIssue[];
  /** Overall severity assessment */
  overallSeverity: CodeCheckIssueSeverity;
  /** Alternative code implementation (if significant issues found) */
  alternativeCode?: string;
  /** Suggestions for improvement */
  suggestions: string[];
  /** Model used for this review */
  model: string;
  /** Latency in milliseconds */
  latencyMs: number;
}

/**
 * Multi-model output for CodeCheck responses
 * This provides transparency into which models contributed to the result
 */
export interface CodeCheckMultiModel {
  /** Primary generator output (Planner/Implementer/Verifier) */
  primary: {
    model: string;
    latencyMs: number;
  };
  /** Claude Opus review (optional - may be skipped if unavailable) */
  claudeReview?: CodeCheckClaudeReview;
  /** Warning if Claude review was skipped */
  claudeReviewSkipped?: string;
}

/**
 * CodeCheck API response
 */
export interface CodeCheckApiResponse {
  ok: boolean;
  /** For "plan" action */
  spec?: CodeCheckSpec;
  /** For "implement" action */
  diff?: CodeCheckDiff;
  /** For "verify" action */
  verification?: CodeCheckVerification;
  /** Multi-model output (optional, for enhanced responses) */
  multiModel?: CodeCheckMultiModel;
  /** Error info (if ok is false) */
  error?: {
    code: string;
    message: string;
    details?: string[];
    hint?: string;
  };
  /** Evidence bundle ID (for trust/audit trail) */
  evidenceId?: string;
}

// ============================================
// VERIFICATION REPORT TYPES
// ============================================

/**
 * Verification report status
 */
export type VerificationReportStatus = "PASS" | "FAIL";

/**
 * Verification step result
 */
export type VerificationStepResult = "PASS" | "FAIL" | "SKIPPED";

/**
 * A single verification step (command execution)
 */
export interface VerificationStep {
  /** Step name (e.g., "TypeScript Check", "Build", "Tests") */
  name: string;
  /** Command that was run (or would be run) */
  command: string;
  /** Result of this step */
  result: VerificationStepResult;
  /** Exit code if available */
  exitCode?: number;
  /** Timestamp when started (ISO) */
  startedAt?: string;
  /** Timestamp when ended (ISO) */
  endedAt?: string;
  /** Trimmed preview of output (first N lines) */
  outputPreview: string;
  /** Full output (may be truncated) */
  fullOutput: string;
  /** Whether output was truncated */
  outputTruncated: boolean;
}

/**
 * Iteration log entry (for fix loops)
 */
export interface VerificationIteration {
  /** Attempt number (1, 2, 3...) */
  attemptNumber: number;
  /** Summary of input errors that prompted this iteration */
  inputErrorSummary: string;
  /** Summary of what the model did to fix */
  modelActionsSummary: string;
  /** Outcome of this iteration */
  outcome: VerificationReportStatus;
  /** Timestamp (ISO) */
  timestamp: string;
}

/**
 * Patch evidence section
 */
export interface PatchEvidence {
  /** Patch ID if available */
  patchId?: string;
  /** Diff statistics */
  diffStats: {
    filesChanged: number;
    insertions: number;
    deletions: number;
  };
  /** List of files touched */
  fileList: string[];
  /** First N lines of diff for preview */
  diffExcerpt: string;
  /** Full diff content */
  fullDiff: string;
}

/**
 * Trust and rationale section
 */
export interface TrustAndRationale {
  /** Why we believe the result is correct */
  whyCorrect: string;
  /** Open risks and assumptions */
  openRisks: string[];
  /** What was NOT verified */
  notVerified: string[];
}

/**
 * Reproducibility section
 */
export interface Reproducibility {
  /** Exact commands to reproduce locally */
  commands: string[];
  /** Environment notes */
  environmentNotes: string[];
}

/**
 * Full Verification Report
 */
export interface VerificationReport {
  /** Unique report ID */
  reportId: string;
  /** Creation timestamp (ISO) */
  createdAt: string;
  /** User ID if available */
  userId?: string;
  /** Session ID if available */
  sessionId?: string;
  /** Task ID being verified */
  taskId: string;
  /** Overall verification status */
  status: VerificationReportStatus;
  /** Task summary */
  taskSummary: {
    title: string;
    description: string;
    filesTouched: string[];
  };
  /** Patch evidence */
  patchEvidence?: PatchEvidence;
  /** Verification steps performed */
  verificationSteps: VerificationStep[];
  /** Iteration log (for fix loops) */
  iterationLog: VerificationIteration[];
  /** Trust and rationale */
  trustAndRationale: TrustAndRationale;
  /** Reproducibility information */
  reproducibility: Reproducibility;
  /** Privacy confirmation */
  privacyConfirmation: {
    secretsRedacted: boolean;
    message: string;
  };
  /** Whether report is persisted to storage */
  isPersisted: boolean;
  /** Beta feature flag */
  isBeta: boolean;
  /** Model verification notes (if LLM-based verification) */
  modelVerificationNotes?: string;
}

// ============================================
// ROLE TYPES (for orchestration)
// ============================================

/**
 * The 3 model roles in CodeCheck
 */
export type CodeCheckRole = "planner" | "implementer" | "verifier";

/**
 * Result from calling a CodeCheck role
 */
export interface CodeCheckRoleResult {
  ok: boolean;
  /** Raw content from the model */
  content: string;
  /** Parsed structured data (role-specific) */
  parsed?: CodeCheckSpec | CodeCheckDiff | CodeCheckVerification;
  /** Error message if ok is false */
  error?: string;
  /** Latency in milliseconds */
  latencyMs: number;
}
