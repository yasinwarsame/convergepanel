"use client";

/**
 * CodeCheck Page
 * 
 * Multi-step workflow for AI-assisted code generation with verification:
 * 1. Intake: User provides requirements, stack, constraints
 * 2. Plan: AI generates spec with file plan and task list
 * 3. Implement: User selects task, provides file contents, AI generates diff
 * 4. Verify: User runs commands, pastes logs, AI analyzes and suggests fixes
 * 
 * This is the trust + verification layer for AI-generated code.
 */

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useAuth } from "@/components/AuthProvider";
import {
  CodeCheckIntake,
  CodeCheckSpec,
  CodeCheckTask,
  CodeCheckDiff,
  CodeCheckVerification,
  CodeCheckApiResponse,
  CodeCheckClaudeReview,
  CodeCheckVerifyRequest,
  PriorTaskSummary,
  VerificationReport,
} from "@/lib/codecheck/types";
import { generateVerificationReport } from "@/lib/codecheck/report";
import { storeReportForDisplay, clearStoredReport } from "@/lib/codecheck/reportStorage";

// ============================================
// TYPES
// ============================================

type WorkflowPhase = "intake" | "plan" | "implement" | "verify" | "complete";

// ============================================
// CLAUDE REVIEW COMPONENT
// ============================================

/**
 * Severity badge colors
 */
function getSeverityStyle(severity: "low" | "medium" | "high"): string {
  switch (severity) {
    case "low":
      return "bg-blue-900/50 text-blue-300 border-blue-700";
    case "medium":
      return "bg-yellow-900/50 text-yellow-300 border-yellow-700";
    case "high":
      return "bg-red-900/50 text-red-300 border-red-700";
    default:
      return "bg-slate-700 text-slate-300 border-slate-600";
  }
}

/**
 * Claude Review Section Component
 * Displays Claude Opus review with issues, suggestions, and alternative code
 */
function ClaudeReviewSection({
  review,
  title,
}: {
  review: CodeCheckClaudeReview;
  title: string;
}) {
  const [showAlternative, setShowAlternative] = useState(false);

  return (
    <div className="rounded-2xl bg-gradient-to-br from-purple-900/20 to-slate-800/50 p-6 ring-1 ring-purple-700/50">
      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-purple-600/30 text-purple-300">
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div>
            <h2 className="text-lg font-medium text-white">{title}</h2>
            <p className="text-xs text-purple-300">
              {review.model} • {(review.latencyMs / 1000).toFixed(1)}s
            </p>
          </div>
        </div>
        <span
          className={`inline-flex rounded-full border px-3 py-1 text-xs font-medium ${getSeverityStyle(
            review.overallSeverity
          )}`}
        >
          {review.overallSeverity === "low" && "✓ Low Risk"}
          {review.overallSeverity === "medium" && "⚠ Medium Risk"}
          {review.overallSeverity === "high" && "⚠ High Risk"}
        </span>
      </div>

      {/* Summary */}
      <div className="mb-4">
        <p className="text-sm text-slate-300">{review.reviewSummary}</p>
      </div>

      {/* Issues */}
      {review.issues.length > 0 && (
        <div className="mb-4">
          <h3 className="text-sm font-medium text-white mb-2">
            Issues Found ({review.issues.length})
          </h3>
          <div className="space-y-2">
            {review.issues.map((issue, i) => (
              <div
                key={i}
                className="rounded-lg bg-slate-900/50 border border-slate-700 p-3"
              >
                <div className="flex items-start justify-between gap-2">
                  <h4 className="text-sm font-medium text-white">{issue.title}</h4>
                  <span
                    className={`inline-flex shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium ${getSeverityStyle(
                      issue.severity
                    )}`}
                  >
                    {issue.severity}
                  </span>
                </div>
                <p className="mt-1 text-sm text-slate-400">{issue.detail}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* No issues */}
      {review.issues.length === 0 && (
        <div className="mb-4 rounded-lg bg-green-900/30 border border-green-700 p-3">
          <p className="text-sm text-green-300">
            ✓ No issues found. The code looks good!
          </p>
        </div>
      )}

      {/* Suggestions */}
      {review.suggestions.length > 0 && (
        <div className="mb-4">
          <h3 className="text-sm font-medium text-white mb-2">Suggestions</h3>
          <ul className="list-disc list-inside space-y-1 text-sm text-slate-400">
            {review.suggestions.map((suggestion, i) => (
              <li key={i}>{suggestion}</li>
            ))}
          </ul>
        </div>
      )}

      {/* Alternative Code */}
      {review.alternativeCode && (
        <div>
          <button
            onClick={() => setShowAlternative(!showAlternative)}
            className="flex items-center gap-2 text-sm text-purple-400 hover:text-purple-300"
          >
            <svg
              className={`h-4 w-4 transition-transform ${
                showAlternative ? "rotate-90" : ""
              }`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M9 5l7 7-7 7"
              />
            </svg>
            {showAlternative ? "Hide" : "Show"} Alternative Implementation
          </button>
          {showAlternative && (
            <pre className="mt-3 rounded-lg bg-slate-900 p-4 overflow-x-auto text-xs font-mono text-slate-300 whitespace-pre-wrap">
              {review.alternativeCode}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

// ============================================
// MAIN COMPONENT
// ============================================

export default function CodeCheckPage() {
  const { user, loading: authLoading } = useAuth();
  const router = useRouter();

  // Workflow state
  const [phase, setPhase] = useState<WorkflowPhase>("intake");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Intake state
  const [requirements, setRequirements] = useState("");
  const [stack, setStack] = useState("");
  const [constraints, setConstraints] = useState("");
  const [fileTree, setFileTree] = useState("");

  // Plan state
  const [spec, setSpec] = useState<CodeCheckSpec | null>(null);

  // Task progress tracking (NEW: persist across task switches)
  const [completedTaskIds, setCompletedTaskIds] = useState<Set<string>>(new Set());
  const [taskDiffs, setTaskDiffs] = useState<Map<string, CodeCheckDiff>>(new Map());
  const [taskVerifications, setTaskVerifications] = useState<Map<string, CodeCheckVerification>>(new Map());
  // Tracks which task card has its artifacts panel expanded in the task list
  const [expandedTaskId, setExpandedTaskId] = useState<string | null>(null);

  // Implement state
  const [selectedTask, setSelectedTask] = useState<CodeCheckTask | null>(null);
  const [fileContents, setFileContents] = useState("");
  const [diff, setDiff] = useState<CodeCheckDiff | null>(null);

  // Verify state
  const [buildOutput, setBuildOutput] = useState("");
  const [tscOutput, setTscOutput] = useState("");
  const [testOutput, setTestOutput] = useState("");
  const [verification, setVerification] = useState<CodeCheckVerification | null>(null);

  // Claude review state (multi-model)
  const [planClaudeReview, setPlanClaudeReview] = useState<CodeCheckClaudeReview | null>(null);
  const [diffClaudeReview, setDiffClaudeReview] = useState<CodeCheckClaudeReview | null>(null);
  const [claudeReviewSkipped, setClaudeReviewSkipped] = useState<string | null>(null);

  // Primary model info (Planner/Implementer/Verifier)
  const [primaryModel, setPrimaryModel] = useState<{ model: string; latencyMs: number } | null>(null);

  // Prior context metadata (for trust indicator)
  const [priorContext, setPriorContext] = useState<{ sent: number; truncated: number } | null>(null);

  // Verification report state
  const [verificationReport, setVerificationReport] = useState<VerificationReport | null>(null);
  const [lastVerifyRequest, setLastVerifyRequest] = useState<CodeCheckVerifyRequest | null>(null);

  // Copy feedback state
  const [copied, setCopied] = useState(false);

  // Auth guard
  useEffect(() => {
    if (!authLoading && !user) {
      router.push("/login");
    }
  }, [user, authLoading, router]);

  // ============================================
  // API CALLS
  // ============================================

  /**
   * Get auth headers for API calls
   */
  async function getAuthHeaders(): Promise<Record<string, string>> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (user) {
      try {
        const idToken = await user.getIdToken();
        headers["Authorization"] = `Bearer ${idToken}`;
      } catch (err) {
        console.warn("[CodeCheck] Failed to get ID token:", err);
      }
    }
    return headers;
  }

  async function handleGeneratePlan() {
    if (!requirements.trim() || !stack.trim()) {
      setError("Requirements and Stack are required.");
      return;
    }

    setLoading(true);
    setError("");

    try {
      const intake: CodeCheckIntake = {
        requirements: requirements.trim(),
        stack: stack.trim(),
        constraints: constraints.trim(),
        fileTree: fileTree.trim() || undefined,
        verificationCommands: ["npx tsc --noEmit", "npm run build"],
      };

      const headers = await getAuthHeaders();
      const res = await fetch("/api/codecheck", {
        method: "POST",
        headers,
        body: JSON.stringify({ action: "plan", intake }),
      });

      const data: CodeCheckApiResponse = await res.json();

      if (!data.ok || !data.spec) {
        setError(data.error?.message || "Failed to generate plan.");
        return;
      }

      setSpec(data.spec);
      
      // Capture primary model info
      if (data.multiModel?.primary) {
        setPrimaryModel(data.multiModel.primary);
      }

      // Capture Claude review from multi-model response
      if (data.multiModel?.claudeReview) {
        setPlanClaudeReview(data.multiModel.claudeReview);
        setClaudeReviewSkipped(null);
      } else if (data.multiModel?.claudeReviewSkipped) {
        setClaudeReviewSkipped(data.multiModel.claudeReviewSkipped);
        setPlanClaudeReview(null);
      }
      
      setPhase("plan");
    } catch (err) {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleImplementTask() {
    if (!selectedTask) {
      setError("Please select a task first.");
      return;
    }

    setLoading(true);
    setError("");

    try {
      // Parse file contents (simple format: path on first line, content after)
      const parsedFiles = parseFileContents(fileContents);

      // Build prior task context from completed tasks (oldest → newest ordering preserved)
      // Skip: current task, empty diffs, needsMoreFiles-only results
      // Deduplicates by diffHash so re-runs of the same task don't bloat context
      const DIFF_HASH_THRESHOLD = 120; // lines — matches server-side truncation cap

      async function hashDiff(diff: string): Promise<string> {
        // Canonicalize line endings before hashing (Windows \r\n → Unix \n)
        const canonical = diff.replace(/\r\n/g, "\n");
        const data = new TextEncoder().encode(canonical);
        const buf = await crypto.subtle.digest("SHA-256", data);
        return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join("");
      }

      const priorTasks: PriorTaskSummary[] = [];
      const seenHashes = new Set<string>();
      let priorTruncatedCount = 0;

      if (spec) {
        for (const task of spec.tasks) {
          if (task.id === selectedTask.id) continue;
          const existingDiff = taskDiffs.get(task.id);
          if (
            existingDiff &&
            existingDiff.diff &&
            existingDiff.diff.trim().length > 0 &&
            !(existingDiff.needsMoreFiles && existingDiff.needsMoreFiles.length > 0 && existingDiff.diff.trim().length === 0)
          ) {
            const canonicalDiff = existingDiff.diff.replace(/\r\n/g, "\n");
            const lineCount = canonicalDiff.split("\n").length;

            // Always compute hash for deduplication
            const hash = await hashDiff(canonicalDiff);

            // Skip if we've already seen an identical diff (dedup by hash)
            if (seenHashes.has(hash)) continue;
            seenHashes.add(hash);

            const entry: PriorTaskSummary = {
              v: 1,
              taskId: task.id,
              goal: task.goal,
              filesTouched: existingDiff.filesTouched,
              diff: canonicalDiff,
            };
            // Attach hash when diff will be truncated server-side
            if (lineCount > DIFF_HASH_THRESHOLD) {
              entry.diffHash = hash;
              priorTruncatedCount++;
            }
            priorTasks.push(entry);
          }
        }
      }

      // Store context metadata for UI indicator
      const priorContextMeta = priorTasks.length > 0
        ? { sent: priorTasks.length, truncated: priorTruncatedCount }
        : null;

      const headers = await getAuthHeaders();
      const res = await fetch("/api/codecheck", {
        method: "POST",
        headers,
        body: JSON.stringify({
          action: "implement",
          implementRequest: {
            task: selectedTask,
            fileContents: parsedFiles,
            ...(priorTasks.length > 0 ? { priorTasks } : {}),
          },
        }),
      });

      const data: CodeCheckApiResponse = await res.json();

      if (!data.ok || !data.diff) {
        setError(data.error?.message || "Failed to generate diff.");
        return;
      }

      const generatedDiff = data.diff;
      setDiff(generatedDiff);
      
      // Save diff for this task (NEW: persist across task switches)
      if (generatedDiff) {
        setTaskDiffs((prev) => new Map(prev).set(selectedTask.id, generatedDiff));
      }
      
      // Capture primary model info
      if (data.multiModel?.primary) {
        setPrimaryModel(data.multiModel.primary);
      }

      // Capture Claude review from multi-model response
      if (data.multiModel?.claudeReview) {
        setDiffClaudeReview(data.multiModel.claudeReview);
        setClaudeReviewSkipped(null);
      } else if (data.multiModel?.claudeReviewSkipped) {
        setClaudeReviewSkipped(data.multiModel.claudeReviewSkipped);
        setDiffClaudeReview(null);
      }

      // Store prior context metadata for trust indicator
      setPriorContext(priorContextMeta);
      
      setPhase("implement");
    } catch (err) {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  async function handleVerify() {
    if (!diff || !selectedTask) {
      setError("No diff or task to verify.");
      return;
    }

    // Require at least one log output for verification
    const hasBuildOutput = buildOutput.trim().length > 0;
    const hasTscOutput = tscOutput.trim().length > 0;
    const hasTestOutput = testOutput.trim().length > 0;

    if (!hasBuildOutput && !hasTscOutput && !hasTestOutput) {
      setError(
        "Please paste at least one verification output. Run 'npm run build' or 'npx tsc --noEmit' and paste the result above."
      );
      return;
    }

    setLoading(true);
    setError("");

    // Build the verify request (include filesTouched for pre-existing error filtering)
    const verifyRequest: CodeCheckVerifyRequest = {
      taskId: diff.taskId,
      buildOutput: buildOutput.trim() || undefined,
      tscOutput: tscOutput.trim() || undefined,
      testOutput: testOutput.trim() || undefined,
      filesTouched: diff.filesTouched,
    };

    try {
      const headers = await getAuthHeaders();
      const res = await fetch("/api/codecheck", {
        method: "POST",
        headers,
        body: JSON.stringify({
          action: "verify",
          verifyRequest,
        }),
      });

      const data: CodeCheckApiResponse = await res.json();

      if (!data.ok || !data.verification) {
        setError(data.error?.message || "Failed to verify.");
        return;
      }

      const verificationResult = data.verification;
      setVerification(verificationResult);
      setLastVerifyRequest(verifyRequest);

      // Save verification for this task (NEW: persist across task switches)
      if (verificationResult) {
        setTaskVerifications((prev) => new Map(prev).set(diff.taskId, verificationResult));

        // Mark task as complete if it passed (NEW)
        if (verificationResult.status === "pass") {
          setCompletedTaskIds((prev) => new Set(prev).add(diff.taskId));
        }
      }

      // Generate the verification report
      const report = generateVerificationReport({
        task: selectedTask,
        diff,
        verifyRequest,
        verification: data.verification,
        userId: user?.uid,
        attemptNumber: 1, // First attempt for now
      });

      setVerificationReport(report);

      // Store the report for the report page
      storeReportForDisplay(report);

      setPhase("verify");
    } catch (err) {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  // ============================================
  // HELPERS
  // ============================================

  function parseFileContents(input: string): Array<{ path: string; content: string }> {
    // Format: ### path/to/file.ts\n```\ncontent\n```
    const files: Array<{ path: string; content: string }> = [];
    const regex = /###\s*(.+?)\s*\n```[\w]*\n([\s\S]*?)```/g;
    let match;

    while ((match = regex.exec(input)) !== null) {
      files.push({
        path: match[1].trim(),
        content: match[2],
      });
    }

    return files;
  }

  function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000); // Reset after 2 seconds
  }

  function resetWorkflow() {
    setPhase("intake");
    setSpec(null);
    setSelectedTask(null);
    setFileContents("");
    setDiff(null);
    setBuildOutput("");
    setTscOutput("");
    setTestOutput("");
    setVerification(null);
    setVerificationReport(null);
    setLastVerifyRequest(null);
    setPlanClaudeReview(null);
    setDiffClaudeReview(null);
    setClaudeReviewSkipped(null);
    setPrimaryModel(null);
    setPriorContext(null);
    setError("");
    
    // Clear task progress tracking
    setCompletedTaskIds(new Set());
    setTaskDiffs(new Map());
    setTaskVerifications(new Map());
    setExpandedTaskId(null);
    
    // Clear stored report
    clearStoredReport();
  }

  // ============================================
  // RENDER
  // ============================================

  // Loading state
  if (authLoading) {
    return (
      <main className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 flex items-center justify-center">
        <div className="flex flex-col items-center gap-2 text-slate-300">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-sky-400 border-t-transparent" />
          <p className="text-sm">Loading...</p>
        </div>
      </main>
    );
  }

  // Not logged in (will redirect)
  if (!user) {
    return null;
  }

  return (
    <main className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-slate-100">
      <div className="mx-auto max-w-5xl px-4 py-8">
        {/* Header */}
        <div className="mb-8">
          <div className="flex items-center justify-between">
            <div>
              <h1 className="text-2xl font-semibold text-white">CodeCheck</h1>
              <p className="mt-1 text-sm text-slate-400">
                AI-assisted code generation with verification
              </p>
            </div>
            <Link
              href="/"
              className="text-sm text-sky-400 hover:text-sky-300"
            >
              ← Back to Panel
            </Link>
          </div>

          {/* Progress indicator — completed steps are clickable for back-navigation */}
          <div className="mt-6 flex items-center gap-2">
            {(["intake", "plan", "implement", "verify"] as const).map((p, i) => {
              const phases = ["intake", "plan", "implement", "verify"] as const;
              const currentIdx = phases.indexOf(phase as typeof phases[number]);
              const isCompleted = i < currentIdx;
              const isCurrent = phase === p;
              // Allow clicking completed steps to navigate back (only if relevant data exists)
              const canNavigate = isCompleted && (
                (p === "intake") ||
                (p === "plan" && spec !== null)
              );

              return (
                <div key={p} className="flex items-center">
                  <button
                    type="button"
                    disabled={!canNavigate}
                    onClick={() => {
                      if (!canNavigate) return;
                      if (p === "plan") {
                        setPhase("plan");
                        setDiff(null);
                        setVerification(null);
                        setVerificationReport(null);
                        setBuildOutput("");
                        setTscOutput("");
                        setTestOutput("");
                        setSelectedTask(null);
                      } else if (p === "intake") {
                        setPhase("intake");
                      }
                    }}
                    className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-medium transition-colors ${
                      isCurrent
                        ? "bg-sky-600 text-white"
                        : isCompleted
                        ? "bg-sky-800 text-sky-200 hover:bg-sky-700 cursor-pointer"
                        : "bg-slate-700 text-slate-400 cursor-default"
                    }`}
                    title={canNavigate ? `Go back to ${p}` : undefined}
                  >
                    {i + 1}
                  </button>
                  <span
                    className={`ml-2 text-sm capitalize ${
                      isCurrent ? "text-white" : "text-slate-400"
                    }`}
                  >
                    {p}
                  </span>
                  {i < 3 && (
                    <div className="mx-3 h-px w-8 bg-slate-700" />
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* Error display */}
        {error && (
          <div className="mb-6 rounded-lg bg-red-900/50 border border-red-700 p-4">
            <p className="text-sm text-red-200">{error}</p>
          </div>
        )}

        {/* Phase: Intake */}
        {phase === "intake" && (
          <div className="space-y-6">
            <div className="rounded-2xl bg-slate-800/50 p-6 ring-1 ring-slate-700">
              <h2 className="text-lg font-medium text-white mb-4">
                1. Describe Your Task
              </h2>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-1">
                    Requirements <span className="text-red-400">*</span>
                  </label>
                  <textarea
                    value={requirements}
                    onChange={(e) => setRequirements(e.target.value)}
                    rows={4}
                    className="w-full rounded-lg bg-slate-900 border border-slate-600 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
                    placeholder="Describe the feature, bug fix, or change you want to implement..."
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-1">
                    Tech Stack <span className="text-red-400">*</span>
                  </label>
                  <textarea
                    value={stack}
                    onChange={(e) => setStack(e.target.value)}
                    rows={2}
                    className="w-full rounded-lg bg-slate-900 border border-slate-600 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
                    placeholder="e.g., Next.js 14, TypeScript, Firebase, Tailwind CSS..."
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-1">
                    Constraints
                  </label>
                  <textarea
                    value={constraints}
                    onChange={(e) => setConstraints(e.target.value)}
                    rows={2}
                    className="w-full rounded-lg bg-slate-900 border border-slate-600 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-sky-500 focus:ring-1 focus:ring-sky-500"
                    placeholder="e.g., Do not modify auth flow, keep changes minimal..."
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-1">
                    File Tree (optional)
                  </label>
                  <textarea
                    value={fileTree}
                    onChange={(e) => setFileTree(e.target.value)}
                    rows={4}
                    className="w-full rounded-lg bg-slate-900 border border-slate-600 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-sky-500 focus:ring-1 focus:ring-sky-500 font-mono text-xs"
                    placeholder="Paste output of: find . -type f -name '*.ts*' | head -50"
                  />
                </div>
              </div>

              <div className="mt-6">
                <button
                  onClick={handleGeneratePlan}
                  disabled={loading || !requirements.trim() || !stack.trim()}
                  className="inline-flex items-center rounded-full bg-sky-600 px-6 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-sky-700 focus:outline-none focus:ring-2 focus:ring-sky-500 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {loading ? (
                    <>
                      <div className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                      Generating Plan...
                    </>
                  ) : (
                    "Generate Plan"
                  )}
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Phase: Plan */}
        {phase === "plan" && spec && (
          <div className="space-y-6">
            {/* Primary model badge */}
            {primaryModel && (
              <div className="flex items-center gap-2 text-xs text-slate-400">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-800 border border-slate-700 px-3 py-1 font-medium">
                  <span className="h-1.5 w-1.5 rounded-full bg-sky-400" />
                  {primaryModel.model}
                </span>
                <span>• {(primaryModel.latencyMs / 1000).toFixed(1)}s</span>
              </div>
            )}

            {/* Summary */}
            <div className="rounded-2xl bg-slate-800/50 p-6 ring-1 ring-slate-700">
              <h2 className="text-lg font-medium text-white mb-4">Summary</h2>
              <ul className="list-disc list-inside space-y-1 text-sm text-slate-300">
                {spec.summary.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            </div>

            {/* File Plan */}
            <div className="rounded-2xl bg-slate-800/50 p-6 ring-1 ring-slate-700">
              <h2 className="text-lg font-medium text-white mb-4">File Plan</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-slate-700">
                      <th className="text-left py-2 text-slate-400 font-medium">Path</th>
                      <th className="text-left py-2 text-slate-400 font-medium">Purpose</th>
                      <th className="text-left py-2 text-slate-400 font-medium">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {spec.filePlan.map((file, i) => (
                      <tr key={i} className="border-b border-slate-700/50">
                        <td className="py-2 font-mono text-xs text-sky-400">{file.path}</td>
                        <td className="py-2 text-slate-300">{file.purpose}</td>
                        <td className="py-2">
                          <span
                            className={`inline-flex rounded-full px-2 py-0.5 text-xs font-medium ${
                              file.action === "create"
                                ? "bg-green-900/50 text-green-300"
                                : "bg-yellow-900/50 text-yellow-300"
                            }`}
                          >
                            {file.action}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Claude Opus Review (Plan) */}
            {planClaudeReview && (
              <ClaudeReviewSection review={planClaudeReview} title="Claude Sonnet Review" />
            )}
            {claudeReviewSkipped && !planClaudeReview && (
              <div className="rounded-2xl bg-slate-800/30 p-4 ring-1 ring-slate-700">
                <p className="text-sm text-slate-500 flex items-center gap-2">
                  <span className="text-slate-600">ℹ️</span>
                  Claude review skipped: {claudeReviewSkipped}
                </p>
              </div>
            )}

            {/* Task List */}
            <div className="rounded-2xl bg-slate-800/50 p-6 ring-1 ring-slate-700">
              <h2 className="text-lg font-medium text-white mb-4">
                Tasks ({spec.tasks.length})
              </h2>
              <div className="space-y-4">
                {spec.tasks.map((task) => {
                  const isCompleted = completedTaskIds.has(task.id);
                  const hasVerification = taskVerifications.has(task.id);
                  const hasDiff = taskDiffs.has(task.id);
                  const isExpanded = expandedTaskId === task.id;
                  const savedDiff = taskDiffs.get(task.id);
                  const savedVerification = taskVerifications.get(task.id);
                  
                  return (
                    <div
                      key={task.id}
                      className={`rounded-lg border transition ${
                        selectedTask?.id === task.id
                          ? "border-sky-500 bg-sky-900/20"
                          : isCompleted
                          ? "border-green-700 bg-green-900/10"
                          : hasDiff
                          ? "border-yellow-700 bg-yellow-900/10"
                          : "border-slate-700 hover:border-slate-600"
                      }`}
                    >
                      {/* Task header — clickable to select */}
                      <div
                        className="p-4 cursor-pointer"
                        onClick={() => setSelectedTask(task)}
                      >
                        <div className="flex items-start justify-between">
                          <div className="flex-1">
                            <div className="flex items-center gap-2">
                              <h3 className="font-medium text-white">
                                Task {task.id}: {task.goal}
                              </h3>
                              {isCompleted && (
                                <span className="inline-flex items-center gap-1 rounded-full bg-green-900/50 border border-green-700 px-2 py-0.5 text-xs font-medium text-green-300">
                                  ✓ Complete
                                </span>
                              )}
                              {!isCompleted && hasDiff && (
                                <span className="inline-flex items-center gap-1 rounded-full bg-yellow-900/50 border border-yellow-700 px-2 py-0.5 text-xs font-medium text-yellow-300">
                                  ⚠ In Progress
                                </span>
                              )}
                            </div>
                            <p className="mt-1 text-xs text-slate-400 font-mono">
                              Files: {task.filesTouched.join(", ")}
                            </p>
                          </div>
                          <input
                            type="radio"
                            checked={selectedTask?.id === task.id}
                            onChange={() => setSelectedTask(task)}
                            className="mt-1"
                          />
                        </div>
                        <div className="mt-3">
                          <p className="text-xs text-slate-400 mb-1">Acceptance Criteria:</p>
                          <ul className="list-disc list-inside text-sm text-slate-300 space-y-0.5">
                            {task.acceptanceCriteria.map((ac, i) => (
                              <li key={i}>{ac}</li>
                            ))}
                          </ul>
                        </div>
                      </div>

                      {/* Artifacts toggle — only show if task has saved results */}
                      {(hasDiff || hasVerification) && (
                        <div className="border-t border-slate-700/50">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setExpandedTaskId(isExpanded ? null : task.id);
                            }}
                            className="w-full flex items-center justify-between px-4 py-2 text-xs font-medium text-slate-400 hover:text-slate-200 hover:bg-slate-800/30 transition"
                          >
                            <span className="flex items-center gap-1.5">
                              <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                              </svg>
                              {isCompleted ? "View Generated Code & Verification" : "View Generated Diff"}
                            </span>
                            <svg
                              className={`h-4 w-4 transition-transform ${isExpanded ? "rotate-180" : ""}`}
                              fill="none" stroke="currentColor" viewBox="0 0 24 24"
                            >
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                            </svg>
                          </button>

                          {/* Expanded artifacts panel */}
                          {isExpanded && (
                            <div className="px-4 pb-4 space-y-4">
                              {/* Generated Diff */}
                              {savedDiff && savedDiff.diff && savedDiff.diff.trim().length > 0 && (
                                <div>
                                  <div className="flex items-center justify-between mb-2">
                                    <h4 className="text-sm font-medium text-slate-300 flex items-center gap-1.5">
                                      <svg className="h-4 w-4 text-sky-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 20l4-16m4 4l4 4-4 4M6 16l-4-4 4-4" />
                                      </svg>
                                      Generated Diff
                                    </h4>
                                    <button
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        copyToClipboard(savedDiff.diff);
                                      }}
                                      className={`text-xs font-medium transition-colors ${
                                        copied ? "text-green-400" : "text-sky-400 hover:text-sky-300"
                                      }`}
                                    >
                                      {copied ? (
                                        <span className="flex items-center gap-1">
                                          <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
                                          Copied!
                                        </span>
                                      ) : (
                                        "Copy Diff"
                                      )}
                                    </button>
                                  </div>
                                  <pre className="rounded-lg bg-slate-900 p-3 overflow-x-auto text-xs font-mono text-slate-300 whitespace-pre-wrap max-h-64 overflow-y-auto">
                                    {savedDiff.diff}
                                  </pre>
                                  {savedDiff.notes && (
                                    <p className="mt-2 text-xs text-slate-500 italic">{savedDiff.notes}</p>
                                  )}
                                </div>
                              )}

                              {/* Verification Results */}
                              {savedVerification && (
                                <div>
                                  <h4 className="text-sm font-medium text-slate-300 mb-2 flex items-center gap-1.5">
                                    {savedVerification.status === "pass" ? (
                                      <svg className="h-4 w-4 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                                      </svg>
                                    ) : (
                                      <svg className="h-4 w-4 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
                                      </svg>
                                    )}
                                    Verification: {savedVerification.status === "pass" ? "Passed" : savedVerification.status === "fail" ? "Failed" : "Needs Info"}
                                  </h4>

                                  {/* Verification errors */}
                                  {savedVerification.errors && savedVerification.errors.length > 0 && (
                                    <div className="rounded-lg bg-red-900/20 border border-red-800/50 p-3 mb-2">
                                      <p className="text-xs font-medium text-red-300 mb-1">
                                        {savedVerification.errors.length} error{savedVerification.errors.length !== 1 ? "s" : ""} found:
                                      </p>
                                      <ul className="space-y-1">
                                        {savedVerification.errors.map((err, i) => (
                                          <li key={i} className="text-xs text-red-200">
                                            <span className="text-red-400 font-mono">{err.file && `${err.file}${err.line ? `:${err.line}` : ""}`}</span>
                                            {err.file && " — "}
                                            {err.message}
                                          </li>
                                        ))}
                                      </ul>
                                    </div>
                                  )}

                                  {/* Verification notes */}
                                  {savedVerification.notes && (
                                    <p className="text-xs text-slate-400 italic">{savedVerification.notes}</p>
                                  )}

                                  {/* Fix diff */}
                                  {savedVerification.fixDiff && (
                                    <div className="mt-2">
                                      <div className="flex items-center justify-between mb-1">
                                        <p className="text-xs font-medium text-slate-400">Suggested Fix:</p>
                                        <button
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            copyToClipboard(savedVerification.fixDiff || "");
                                          }}
                                          className={`text-xs font-medium transition-colors ${
                                            copied ? "text-green-400" : "text-sky-400 hover:text-sky-300"
                                          }`}
                                        >
                                          {copied ? "Copied!" : "Copy Fix"}
                                        </button>
                                      </div>
                                      <pre className="rounded-lg bg-slate-900 p-3 overflow-x-auto text-xs font-mono text-slate-300 whitespace-pre-wrap max-h-48 overflow-y-auto">
                                        {savedVerification.fixDiff}
                                      </pre>
                                    </div>
                                  )}
                                </div>
                              )}

                              {/* Verification commands (for reference) */}
                              {savedDiff?.verificationCommands && savedDiff.verificationCommands.length > 0 && (
                                <div>
                                  <p className="text-xs font-medium text-slate-400 mb-1">Verification Commands:</p>
                                  <div className="rounded-lg bg-slate-900 p-2">
                                    {savedDiff.verificationCommands.map((cmd, i) => (
                                      <code key={i} className="block text-xs text-slate-300 font-mono py-0.5">
                                        $ {cmd}
                                      </code>
                                    ))}
                                  </div>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* All tasks completed - show success and option to start new workflow */}
              {(() => {
                const allTasksCompleted = spec.tasks.length > 0 && 
                  spec.tasks.every(task => completedTaskIds.has(task.id));
                
                if (allTasksCompleted && !selectedTask) {
                  return (
                    <div className="mt-6 rounded-2xl bg-gradient-to-br from-green-900/30 to-emerald-900/20 p-6 ring-1 ring-green-700/50">
                      <div className="flex items-start gap-4">
                        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-green-600/30 text-green-300">
                          <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                        </div>
                        <div className="flex-1">
                          <h3 className="text-lg font-semibold text-white">All Tasks Completed! 🎉</h3>
                          <p className="text-sm text-slate-300 mt-2">
                            You've successfully completed all {spec.tasks.length} task{spec.tasks.length !== 1 ? 's' : ''} in this workflow. 
                            {spec.tasks.length > 1 ? ' Each task has been implemented and verified.' : ' The task has been implemented and verified.'}
                          </p>
                          <div className="mt-4 flex gap-3">
                            <button
                              onClick={resetWorkflow}
                              className="inline-flex items-center gap-2 rounded-full bg-green-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-green-700 transition"
                            >
                              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                              </svg>
                              Start New Workflow
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                }
                return null;
              })()}

              {/* Prompt to select a task if none selected and not all completed */}
              {!selectedTask && spec.tasks.length > 0 && 
               !spec.tasks.every(task => completedTaskIds.has(task.id)) && (
                <div className="mt-6 rounded-lg bg-sky-900/30 border border-sky-700 p-4">
                  <p className="text-sm text-sky-200">
                    <strong>Next step:</strong> Click on a task above to select it, then you can implement it.
                  </p>
                </div>
              )}

              {/* Show when no tasks available */}
              {spec.tasks.length === 0 && (
                <div className="mt-6 rounded-lg bg-yellow-900/30 border border-yellow-700 p-4">
                  <p className="text-sm text-yellow-200">
                    <strong>No tasks generated.</strong> The planner did not return any tasks. Try regenerating the plan with more specific requirements.
                  </p>
                </div>
              )}

              {selectedTask && (() => {
                const existingDiff = taskDiffs.get(selectedTask.id);
                const existingVerification = taskVerifications.get(selectedTask.id);
                const isCompleted = completedTaskIds.has(selectedTask.id);
                
                return (
                  <div className="mt-6 space-y-4">
                    <div className={`rounded-lg border p-4 mb-4 ${
                      isCompleted 
                        ? "bg-green-900/20 border-green-600" 
                        : existingDiff 
                        ? "bg-yellow-900/20 border-yellow-600" 
                        : "bg-sky-900/20 border-sky-600"
                    }`}>
                      <p className="text-sm text-sky-200">
                        <strong>Selected:</strong> Task {selectedTask.id} - {selectedTask.goal}
                      </p>
                      {isCompleted && (
                        <p className="text-xs text-green-300 mt-1">
                          ✓ This task has been completed and verified
                        </p>
                      )}
                      {!isCompleted && existingDiff && (
                        <p className="text-xs text-yellow-300 mt-1">
                          ⚠ This task has a generated diff but hasn't been verified yet
                        </p>
                      )}
                    </div>

                    {/* Show resume button if diff exists */}
                    {existingDiff && (
                      <div className="rounded-lg bg-slate-900/50 border border-slate-700 p-4">
                        <p className="text-sm text-slate-300 mb-3">
                          A diff already exists for this task. You can:
                        </p>
                        <div className="flex gap-3">
                          <button
                            onClick={() => {
                              setDiff(existingDiff);
                              if (existingVerification) {
                                setVerification(existingVerification);
                                setPhase("verify");
                              } else {
                                setPhase("implement");
                              }
                            }}
                            className="inline-flex items-center rounded-full bg-sky-600 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-sky-700"
                          >
                            {existingVerification ? "View Results" : "Continue to Verify"}
                          </button>
                          <button
                            onClick={() => {
                              // Allow regenerating diff
                              setTaskDiffs((prev) => {
                                const newMap = new Map(prev);
                                newMap.delete(selectedTask.id);
                                return newMap;
                              });
                            }}
                            className="inline-flex items-center rounded-full bg-slate-700 px-4 py-2 text-sm font-semibold text-white shadow-sm hover:bg-slate-600"
                          >
                            Regenerate Diff
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Show file contents input only if no diff exists */}
                    {!existingDiff && (
                      <>
                        <div>
                          <label className="block text-sm font-medium text-slate-300 mb-1">
                            Paste File Contents (optional for new files)
                          </label>
                          <p className="text-xs text-slate-500 mb-2">
                            Format: ### path/to/file.ts followed by ```content```
                          </p>
                          <textarea
                            value={fileContents}
                            onChange={(e) => setFileContents(e.target.value)}
                            rows={8}
                            className="w-full rounded-lg bg-slate-900 border border-slate-600 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-sky-500 focus:ring-1 focus:ring-sky-500 font-mono text-xs"
                            placeholder={`### ${selectedTask.filesTouched[0] || "path/to/file.ts"}\n\`\`\`typescript\n// paste file content here\n\`\`\``}
                          />
                        </div>

                        <button
                          onClick={handleImplementTask}
                          disabled={loading}
                          className="inline-flex items-center rounded-full bg-sky-600 px-6 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-sky-700 focus:outline-none focus:ring-2 focus:ring-sky-500 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {loading ? (
                            <>
                              <div className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                              Generating Diff...
                            </>
                          ) : (
                            `Implement Task ${selectedTask.id}`
                          )}
                        </button>
                      </>
                    )}
                  </div>
                );
              })()}
            </div>
          </div>
        )}

        {/* Phase: Implement (show diff) */}
        {phase === "implement" && diff && (
          <div className="space-y-6">
            {/* Primary model badge + prior context indicator */}
            <div className="flex items-center gap-3 flex-wrap">
              {primaryModel && (
                <div className="flex items-center gap-2 text-xs text-slate-400">
                  <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-800 border border-slate-700 px-3 py-1 font-medium">
                    <span className="h-1.5 w-1.5 rounded-full bg-sky-400" />
                    {primaryModel.model}
                  </span>
                  <span>• {(primaryModel.latencyMs / 1000).toFixed(1)}s</span>
                </div>
              )}
              {priorContext && priorContext.sent > 0 && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-slate-800 border border-emerald-800 px-3 py-1 text-xs font-medium text-emerald-400">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                  Prior context: {priorContext.sent} task{priorContext.sent !== 1 ? "s" : ""}
                  {priorContext.truncated > 0 && (
                    <span className="text-emerald-500/70"> ({priorContext.truncated} truncated)</span>
                  )}
                </span>
              )}
            </div>

            {/* Top-level back button — always visible on implement screen */}
            <button
              onClick={() => {
                setPhase("plan");
                setDiff(null);
                setBuildOutput("");
                setTscOutput("");
                setTestOutput("");
                setSelectedTask(null);
              }}
              className="inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-white transition-colors"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
              Back to Tasks
            </button>

            <div className="rounded-2xl bg-slate-800/50 p-6 ring-1 ring-slate-700">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-medium text-white">
                  Generated Diff for Task {diff.taskId}
                </h2>
                <button
                  onClick={() => copyToClipboard(diff.diff)}
                  className={`text-sm font-medium transition-colors ${
                    copied 
                      ? "text-green-400" 
                      : "text-sky-400 hover:text-sky-300"
                  }`}
                >
                  {copied ? (
                    <span className="flex items-center gap-1.5">
                      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                      Copied!
                    </span>
                  ) : (
                    "Copy to Clipboard"
                  )}
                </button>
              </div>

              {diff.notes && (
                <p className="text-sm text-slate-400 mb-4">{diff.notes}</p>
              )}

              <pre className="rounded-lg bg-slate-900 p-4 overflow-x-auto text-xs font-mono text-slate-300 whitespace-pre-wrap">
                {diff.diff}
              </pre>

              {diff.needsMoreFiles && diff.needsMoreFiles.length > 0 && (
                <div className="mt-4 rounded-2xl bg-amber-900/20 border border-amber-700/50 p-5">
                  <div className="flex items-start gap-3">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-amber-600/30 text-amber-300 mt-0.5">
                      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
                      </svg>
                    </div>
                    <div className="flex-1">
                      <h3 className="text-sm font-semibold text-amber-200">
                        Some files could not be found in the project
                      </h3>
                      <p className="mt-1 text-sm text-slate-400">
                        The server tried to auto-read these files but they were not found. They may not exist yet (this task might create them), or the paths may be incorrect. You can try re-running the task.
                      </p>
                      <ul className="mt-3 space-y-1">
                        {diff.needsMoreFiles.map((f, i) => {
                          const cleanPath = f
                            .replace(/^paste\s+(the\s+)?content\s+of\s+/i, "")
                            .replace(/\s*\(.*\)\s*$/, "")
                            .trim();
                          return (
                            <li key={i} className="flex items-center gap-2 text-sm">
                              <span className="text-amber-400">→</span>
                              <code className="rounded bg-slate-800 px-2 py-0.5 text-xs text-amber-300 font-mono">
                                {cleanPath}
                              </code>
                            </li>
                          );
                        })}
                      </ul>
                      <button
                        onClick={() => {
                          if (selectedTask) {
                            setDiff(null);
                            handleImplementTask();
                          }
                        }}
                        className="mt-4 inline-flex items-center gap-2 rounded-full bg-amber-600 px-5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-amber-700 transition"
                      >
                        <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                        </svg>
                        Retry Implementation
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Claude Opus Review (Diff) */}
            {diffClaudeReview && (
              <ClaudeReviewSection review={diffClaudeReview} title="Claude Sonnet Code Review" />
            )}
            {claudeReviewSkipped && !diffClaudeReview && (
              <div className="rounded-2xl bg-slate-800/30 p-4 ring-1 ring-slate-700">
                <p className="text-sm text-slate-500 flex items-center gap-2">
                  <span className="text-slate-600">ℹ️</span>
                  Claude review skipped: {claudeReviewSkipped}
                </p>
              </div>
            )}

            {/* Verification inputs — only show if there's an actual diff to verify */}
            {diff.diff && diff.diff.trim().length > 0 && (
            <div className="rounded-2xl bg-slate-800/50 p-6 ring-1 ring-slate-700">
              <h2 className="text-lg font-medium text-white mb-2">
                3. Verify the Diff
              </h2>
              <p className="text-sm text-slate-400 mb-4">
                Apply the diff to your codebase, then run verification commands and paste the output below.
              </p>

              {/* Instructions */}
              <div className="mb-4 rounded-lg bg-slate-900/50 border border-slate-700 p-4">
                <p className="text-sm font-medium text-slate-300 mb-2">Steps to verify:</p>
                <ol className="text-sm text-slate-400 space-y-1 list-decimal list-inside">
                  <li>Copy the diff above and apply it to your project (e.g., using <code className="text-sky-400">git apply</code>)</li>
                  <li>Run <code className="text-sky-400">npm run build</code> or <code className="text-sky-400">npx tsc --noEmit</code></li>
                  <li>Paste the <strong>complete terminal output</strong> below (at least one field required)</li>
                  <li>Click Verify to analyze the results</li>
                </ol>
              </div>

              <div className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-1">
                    Build Output <span className="text-slate-500">(npm run build)</span>
                  </label>
                  <textarea
                    value={buildOutput}
                    onChange={(e) => setBuildOutput(e.target.value)}
                    rows={4}
                    className="w-full rounded-lg bg-slate-900 border border-slate-600 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-sky-500 focus:ring-1 focus:ring-sky-500 font-mono text-xs"
                    placeholder="$ npm run build&#10;&#10;> my-app@1.0.0 build&#10;> next build&#10;&#10;✓ Compiled successfully..."
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-1">
                    TypeScript Output <span className="text-slate-500">(npx tsc --noEmit)</span>
                  </label>
                  <textarea
                    value={tscOutput}
                    onChange={(e) => setTscOutput(e.target.value)}
                    rows={4}
                    className="w-full rounded-lg bg-slate-900 border border-slate-600 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-sky-500 focus:ring-1 focus:ring-sky-500 font-mono text-xs"
                    placeholder="$ npx tsc --noEmit&#10;&#10;(no output means no errors, paste that info or any errors)"
                  />
                </div>

                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-1">
                    Test Output <span className="text-slate-500">(npm test) - optional</span>
                  </label>
                  <textarea
                    value={testOutput}
                    onChange={(e) => setTestOutput(e.target.value)}
                    rows={4}
                    className="w-full rounded-lg bg-slate-900 border border-slate-600 px-3 py-2 text-sm text-white placeholder-slate-500 focus:border-sky-500 focus:ring-1 focus:ring-sky-500 font-mono text-xs"
                    placeholder="$ npm test&#10;&#10;PASS src/tests/...&#10;..."
                  />
                </div>
              </div>

              {/* Validation hint */}
              {!buildOutput.trim() && !tscOutput.trim() && !testOutput.trim() && (
                <p className="mt-3 text-sm text-amber-400">
                  At least one verification output is required to proceed.
                </p>
              )}

              <div className="mt-6 flex gap-4">
                <button
                  onClick={() => {
                    // Go back to plan/task list without losing progress
                    setPhase("plan");
                    setDiff(null);
                    setBuildOutput("");
                    setTscOutput("");
                    setTestOutput("");
                    setSelectedTask(null);
                  }}
                  className="inline-flex items-center rounded-full bg-slate-700 px-6 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-slate-600"
                >
                  ← Back to Tasks
                </button>
                <button
                  onClick={handleVerify}
                  disabled={loading || (!buildOutput.trim() && !tscOutput.trim() && !testOutput.trim())}
                  className="inline-flex items-center rounded-full bg-sky-600 px-6 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-sky-700 focus:outline-none focus:ring-2 focus:ring-sky-500 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {loading ? (
                    <>
                      <div className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                      Verifying...
                    </>
                  ) : (
                    "Verify"
                  )}
                </button>
              </div>
            </div>
            )}
          </div>
        )}

        {/* Phase: Verify (show results) */}
        {phase === "verify" && verification && (
          <div className="space-y-6">
            {/* Top-level back button */}
            <button
              onClick={() => {
                setPhase("plan");
                setDiff(null);
                setVerification(null);
                setVerificationReport(null);
                setBuildOutput("");
                setTscOutput("");
                setTestOutput("");
                setSelectedTask(null);
              }}
              className="inline-flex items-center gap-1.5 text-sm text-slate-400 hover:text-white transition-colors"
            >
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
              Back to Tasks
            </button>

            <div className="rounded-2xl bg-slate-800/50 p-6 ring-1 ring-slate-700">
              <div className="flex items-center gap-3 mb-4">
                <h2 className="text-lg font-medium text-white">
                  Verification Result
                </h2>
                <span
                  className={`inline-flex rounded-full px-3 py-1 text-sm font-medium ${
                    verification.status === "pass"
                      ? "bg-green-900/50 text-green-300"
                      : verification.status === "fail"
                      ? "bg-red-900/50 text-red-300"
                      : "bg-yellow-900/50 text-yellow-300"
                  }`}
                >
                  {verification.status.toUpperCase()}
                </span>
              </div>

              {verification.notes && (
                <p className="text-sm text-slate-300 mb-4">{verification.notes}</p>
              )}

              {verification.errors.length > 0 && (
                <div className="mb-4">
                  <h3 className="text-sm font-medium text-slate-300 mb-2">Errors Found:</h3>
                  <ul className="space-y-2">
                    {verification.errors.map((err, i) => (
                      <li
                        key={i}
                        className="rounded-lg bg-red-900/20 border border-red-800 p-3"
                      >
                        <p className="text-xs font-mono text-red-300">
                          {err.file}:{err.line || "?"}:{err.column || "?"}
                        </p>
                        <p className="text-sm text-red-200 mt-1">{err.message}</p>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {verification.fixDiff && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-sm font-medium text-slate-300">Suggested Fix:</h3>
                    <button
                      onClick={() => copyToClipboard(verification.fixDiff || "")}
                      className={`text-xs font-medium transition-colors ${
                        copied 
                          ? "text-green-400" 
                          : "text-sky-400 hover:text-sky-300"
                      }`}
                    >
                      {copied ? (
                        <span className="flex items-center gap-1">
                          <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                          </svg>
                          Copied
                        </span>
                      ) : (
                        "Copy"
                      )}
                    </button>
                  </div>
                  <pre className="rounded-lg bg-slate-900 p-4 overflow-x-auto text-xs font-mono text-slate-300 whitespace-pre-wrap">
                    {verification.fixDiff}
                  </pre>
                </div>
              )}

              {verification.status === "pass" && (
                <div className="mt-4 rounded-lg bg-green-900/30 border border-green-700 p-4">
                  <p className="text-sm text-green-200">
                    Task {verification.taskId} completed successfully!
                  </p>
                  <button
                    onClick={() => {
                      setPhase("plan");
                      setDiff(null);
                      setVerification(null);
                      setVerificationReport(null);
                      setBuildOutput("");
                      setTscOutput("");
                      setTestOutput("");
                      setSelectedTask(null);
                    }}
                    className="mt-3 inline-flex items-center gap-2 rounded-full bg-green-600 px-5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-green-700 transition"
                  >
                    Continue to Next Task →
                  </button>
                </div>
              )}
            </div>

            {/* View Report CTA */}
            {verificationReport && (
              <div className="rounded-2xl bg-gradient-to-r from-sky-900/30 to-purple-900/30 p-6 ring-1 ring-sky-700/50">
                <div className="flex items-start gap-4">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-sky-600/30 text-sky-300">
                    <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                  </div>
                  <div className="flex-1">
                    <h3 className="text-base font-semibold text-white">Verification Report Available</h3>
                    <p className="text-sm text-slate-400 mt-1">
                      View the full audit-ready report with evidence, reproduction steps, and trust analysis.
                    </p>
                    <Link
                      href="/codecheck/report"
                      className="mt-3 inline-flex items-center gap-2 rounded-full bg-sky-600 px-5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-sky-700 transition"
                    >
                      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                      View Full Report
                    </Link>
                  </div>
                </div>
              </div>
            )}

            {/* Actions */}
            <div className="flex flex-wrap gap-4">
              <button
                onClick={() => {
                  // Keep task progress, just go back to plan view
                  setPhase("plan");
                  setDiff(null);
                  setVerification(null);
                  setVerificationReport(null);
                  setBuildOutput("");
                  setTscOutput("");
                  setTestOutput("");
                  setSelectedTask(null);
                }}
                className="inline-flex items-center rounded-full bg-sky-600 px-6 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-sky-700"
              >
                ← Back to Tasks
              </button>

              <button
                onClick={resetWorkflow}
                className="inline-flex items-center rounded-full border border-slate-600 bg-transparent px-6 py-2.5 text-sm font-medium text-slate-400 hover:text-white hover:border-slate-500 hover:bg-slate-800"
              >
                Start Over
              </button>
            </div>
          </div>
        )}
      </div>
    </main>
  );
}
