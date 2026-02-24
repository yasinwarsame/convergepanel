"use client";

/**
 * Verification Report Page Component
 * 
 * Displays a comprehensive, audit-ready verification report after a CodeCheck
 * verification is complete. Designed to be printable and shareable.
 * 
 * Features:
 * - Status overview with PASS/FAIL indicator
 * - Verification steps timeline
 * - Patch evidence with diff stats
 * - Iteration log for fix loops
 * - Trust & rationale section
 * - Reproducibility commands
 * - Export options (Markdown, JSON)
 */

import { useState } from "react";
import Link from "next/link";
import {
  VerificationReport,
  VerificationStep,
  VerificationIteration,
} from "@/lib/codecheck/types";
import { reportToMarkdown, reportToJson } from "@/lib/codecheck/report";

// ============================================
// PROPS
// ============================================

interface VerificationReportPageProps {
  report: VerificationReport;
  onBack?: () => void;
  onStartNew?: () => void;
}

// ============================================
// HELPER COMPONENTS
// ============================================

/**
 * Status badge with appropriate colors
 */
function StatusBadge({ status }: { status: "PASS" | "FAIL" }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-4 py-1.5 text-sm font-bold ${
        status === "PASS"
          ? "bg-green-600 text-white"
          : "bg-red-600 text-white"
      }`}
    >
      {status === "PASS" ? "✓ PASS" : "✗ FAIL"}
    </span>
  );
}

/**
 * Step result indicator
 */
function StepResultBadge({ result }: { result: "PASS" | "FAIL" | "SKIPPED" }) {
  const styles = {
    PASS: "bg-green-900/50 text-green-300 border-green-700",
    FAIL: "bg-red-900/50 text-red-300 border-red-700",
    SKIPPED: "bg-slate-700/50 text-slate-400 border-slate-600",
  };

  const icons = {
    PASS: "✓",
    FAIL: "✗",
    SKIPPED: "○",
  };

  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium ${styles[result]}`}>
      {icons[result]} {result}
    </span>
  );
}

/**
 * Collapsible section component
 */
function CollapsibleSection({
  title,
  defaultOpen = false,
  children,
  badge,
}: {
  title: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
  badge?: React.ReactNode;
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);

  return (
    <div className="rounded-xl bg-slate-800/50 ring-1 ring-slate-700 overflow-hidden">
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center justify-between px-5 py-4 text-left hover:bg-slate-700/30 transition"
      >
        <div className="flex items-center gap-3">
          <svg
            className={`h-4 w-4 text-slate-400 transition-transform ${isOpen ? "rotate-90" : ""}`}
            fill="none"
            stroke="currentColor"
            viewBox="0 0 24 24"
          >
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
          <span className="text-sm font-medium text-white">{title}</span>
        </div>
        {badge}
      </button>
      {isOpen && (
        <div className="px-5 pb-5 pt-2 border-t border-slate-700/50">
          {children}
        </div>
      )}
    </div>
  );
}

/**
 * Copy button component
 */
function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <button
      onClick={handleCopy}
      className="inline-flex items-center gap-1.5 rounded-md bg-slate-700 px-2.5 py-1 text-xs font-medium text-slate-300 hover:bg-slate-600 transition"
    >
      {copied ? (
        <>
          <svg className="h-3.5 w-3.5 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
          Copied!
        </>
      ) : (
        <>
          <svg className="h-3.5 w-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
          </svg>
          {label}
        </>
      )}
    </button>
  );
}

/**
 * Verification step card
 */
function VerificationStepCard({ step, index }: { step: VerificationStep; index: number }) {
  const [showFull, setShowFull] = useState(false);

  return (
    <div className="rounded-lg bg-slate-900/50 border border-slate-700 p-4">
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-center gap-3">
          <div className={`flex h-8 w-8 items-center justify-center rounded-full text-sm font-bold ${
            step.result === "PASS" 
              ? "bg-green-900/50 text-green-300" 
              : step.result === "FAIL"
              ? "bg-red-900/50 text-red-300"
              : "bg-slate-700 text-slate-400"
          }`}>
            {index + 1}
          </div>
          <div>
            <h4 className="text-sm font-medium text-white">{step.name}</h4>
            <code className="text-xs text-slate-500">{step.command}</code>
          </div>
        </div>
        <StepResultBadge result={step.result} />
      </div>

      {/* Output preview */}
      <div className="mt-3">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-slate-500">Output:</span>
          <div className="flex items-center gap-2">
            <CopyButton text={step.fullOutput} label="Copy Output" />
            {step.fullOutput !== step.outputPreview && (
              <button
                onClick={() => setShowFull(!showFull)}
                className="text-xs text-sky-400 hover:text-sky-300"
              >
                {showFull ? "Show Less" : "Show More"}
              </button>
            )}
          </div>
        </div>
        <pre className="rounded-md bg-slate-950 p-3 text-xs font-mono text-slate-400 overflow-x-auto whitespace-pre-wrap max-h-48 overflow-y-auto">
          {showFull ? step.fullOutput : step.outputPreview}
        </pre>
        {step.outputTruncated && !showFull && (
          <p className="text-xs text-amber-400 mt-2">
            ⚠ Output was truncated. Click "Show More" or "Copy Output" for full content.
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Iteration log entry
 */
function IterationEntry({ iteration }: { iteration: VerificationIteration }) {
  return (
    <div className="flex gap-4 items-start">
      <div className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
        iteration.outcome === "PASS" 
          ? "bg-green-900/50 text-green-300" 
          : "bg-red-900/50 text-red-300"
      }`}>
        {iteration.attemptNumber}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-white">
            Attempt {iteration.attemptNumber}
          </span>
          <StepResultBadge result={iteration.outcome} />
        </div>
        <p className="text-xs text-slate-400 mt-1">{iteration.inputErrorSummary}</p>
        <p className="text-xs text-slate-500 mt-0.5">{iteration.modelActionsSummary}</p>
        <p className="text-xs text-slate-600 mt-1">
          {new Date(iteration.timestamp).toLocaleString()}
        </p>
      </div>
    </div>
  );
}

// ============================================
// MAIN COMPONENT
// ============================================

export default function VerificationReportPage({
  report,
  onBack,
  onStartNew,
}: VerificationReportPageProps) {
  const [showFullDiff, setShowFullDiff] = useState(false);

  const handleExportMarkdown = () => {
    const markdown = reportToMarkdown(report);
    navigator.clipboard.writeText(markdown);
  };

  const handleDownloadJson = () => {
    const json = reportToJson(report);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `verification-report-${report.reportId}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handlePrint = () => {
    window.print();
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 text-slate-100">
      <div className="mx-auto max-w-4xl px-4 py-8 print:py-4">
        
        {/* Not Persisted Banner */}
        {!report.isPersisted && (
          <div className="mb-6 rounded-lg bg-amber-900/30 border border-amber-700 p-3 print:hidden">
            <p className="text-sm text-amber-200 flex items-center gap-2">
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <span>
                <strong>Session-only report:</strong> This report is not persisted. It will be lost when you leave this page.
              </span>
            </p>
          </div>
        )}

        {/* Header */}
        <div className="mb-8 print:mb-4">
          <div className="flex items-start justify-between gap-4 flex-wrap">
            <div>
              <div className="flex items-center gap-3 mb-2">
                <h1 className="text-2xl font-bold text-white print:text-black">
                  Verification Report
                </h1>
                <span className="rounded-full bg-sky-600/30 px-2 py-0.5 text-xs font-medium text-sky-300 print:hidden">
                  Beta
                </span>
              </div>
              <p className="text-sm text-slate-400 print:text-gray-600">
                Report ID: {report.reportId}
              </p>
              <p className="text-sm text-slate-400 print:text-gray-600">
                Generated: {new Date(report.createdAt).toLocaleString()}
              </p>
            </div>
            <StatusBadge status={report.status} />
          </div>
        </div>

        {/* Task Summary Card */}
        <div className="mb-6 rounded-2xl bg-slate-800/50 p-6 ring-1 ring-slate-700 print:ring-gray-300">
          <h2 className="text-lg font-semibold text-white mb-3 flex items-center gap-2">
            <svg className="h-5 w-5 text-sky-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
            What Was Verified
          </h2>
          <h3 className="text-base font-medium text-white mb-2">{report.taskSummary.title}</h3>
          <p className="text-sm text-slate-300 mb-4">{report.taskSummary.description}</p>
          
          {report.taskSummary.filesTouched.length > 0 && (
            <div>
              <p className="text-xs text-slate-500 mb-2">Files touched:</p>
              <div className="flex flex-wrap gap-2">
                {report.taskSummary.filesTouched.map((file, i) => (
                  <span key={i} className="rounded bg-slate-700 px-2 py-1 text-xs font-mono text-slate-300">
                    {file}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Verification Steps */}
        <div className="mb-6">
          <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
            <svg className="h-5 w-5 text-sky-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            Checks Run
            <span className="text-xs text-slate-500 font-normal">
              ({report.verificationSteps.filter(s => s.result === "PASS").length}/{report.verificationSteps.length} passed)
            </span>
          </h2>
          <div className="space-y-4">
            {report.verificationSteps.map((step, i) => (
              <VerificationStepCard key={i} step={step} index={i} />
            ))}
          </div>
        </div>

        {/* Patch Evidence */}
        {report.patchEvidence && (
          <CollapsibleSection
            title="Patch Evidence"
            defaultOpen={true}
            badge={
              <span className="text-xs text-slate-400">
                {report.patchEvidence.diffStats.filesChanged} files, 
                +{report.patchEvidence.diffStats.insertions} / 
                -{report.patchEvidence.diffStats.deletions}
              </span>
            }
          >
            <div className="space-y-4">
              {/* Diff Stats */}
              <div className="grid grid-cols-3 gap-4">
                <div className="rounded-lg bg-slate-900/50 p-3 text-center">
                  <p className="text-2xl font-bold text-white">{report.patchEvidence.diffStats.filesChanged}</p>
                  <p className="text-xs text-slate-500">Files Changed</p>
                </div>
                <div className="rounded-lg bg-green-900/30 p-3 text-center">
                  <p className="text-2xl font-bold text-green-400">+{report.patchEvidence.diffStats.insertions}</p>
                  <p className="text-xs text-slate-500">Insertions</p>
                </div>
                <div className="rounded-lg bg-red-900/30 p-3 text-center">
                  <p className="text-2xl font-bold text-red-400">-{report.patchEvidence.diffStats.deletions}</p>
                  <p className="text-xs text-slate-500">Deletions</p>
                </div>
              </div>

              {/* File List */}
              <div>
                <p className="text-xs text-slate-500 mb-2">Files in patch:</p>
                <div className="flex flex-wrap gap-2">
                  {report.patchEvidence.fileList.map((file, i) => (
                    <span key={i} className="rounded bg-slate-700 px-2 py-1 text-xs font-mono text-slate-300">
                      {file}
                    </span>
                  ))}
                </div>
              </div>

              {/* Diff Preview */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <p className="text-xs text-slate-500">Diff excerpt:</p>
                  <div className="flex items-center gap-2">
                    <CopyButton text={report.patchEvidence.fullDiff} label="Copy Full Diff" />
                    <button
                      onClick={() => setShowFullDiff(!showFullDiff)}
                      className="text-xs text-sky-400 hover:text-sky-300"
                    >
                      {showFullDiff ? "Show Excerpt" : "View Full Patch"}
                    </button>
                  </div>
                </div>
                <pre className="rounded-md bg-slate-950 p-3 text-xs font-mono text-slate-400 overflow-x-auto whitespace-pre-wrap max-h-96 overflow-y-auto">
                  {showFullDiff ? report.patchEvidence.fullDiff : report.patchEvidence.diffExcerpt}
                </pre>
              </div>
            </div>
          </CollapsibleSection>
        )}

        {/* Iteration Log */}
        {report.iterationLog.length > 0 && (
          <div className="mb-6 mt-6">
            <CollapsibleSection
              title="Iteration Log"
              defaultOpen={report.iterationLog.length > 1}
              badge={
                <span className="text-xs text-slate-400">
                  {report.iterationLog.length} attempt(s)
                </span>
              }
            >
              <div className="space-y-4">
                {report.iterationLog.map((iteration, i) => (
                  <IterationEntry key={i} iteration={iteration} />
                ))}
              </div>
            </CollapsibleSection>
          </div>
        )}

        {/* Trust & Rationale */}
        <div className="mb-6 rounded-2xl bg-slate-800/50 p-6 ring-1 ring-slate-700">
          <h2 className="text-lg font-semibold text-white mb-4 flex items-center gap-2">
            <svg className="h-5 w-5 text-sky-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>
            Trust & Rationale
          </h2>

          {/* Why Correct */}
          <div className="mb-4">
            <h3 className="text-sm font-medium text-slate-300 mb-2">Why we believe this is correct:</h3>
            <p className="text-sm text-slate-400">{report.trustAndRationale.whyCorrect}</p>
          </div>

          {/* Open Risks */}
          <div className="mb-4">
            <h3 className="text-sm font-medium text-amber-300 mb-2 flex items-center gap-1.5">
              <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              Open Risks / Assumptions:
            </h3>
            <ul className="list-disc list-inside space-y-1 text-sm text-slate-400">
              {report.trustAndRationale.openRisks.map((risk, i) => (
                <li key={i}>{risk}</li>
              ))}
            </ul>
          </div>

          {/* Not Verified */}
          <div>
            <h3 className="text-sm font-medium text-slate-300 mb-2">What we did NOT verify:</h3>
            <ul className="list-disc list-inside space-y-1 text-sm text-slate-500">
              {report.trustAndRationale.notVerified.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </div>
        </div>

        {/* Reproducibility */}
        <CollapsibleSection title="Reproduce Locally" defaultOpen={false}>
          <div className="space-y-4">
            <div>
              <div className="flex items-center justify-between mb-2">
                <p className="text-xs text-slate-500">Commands:</p>
                <CopyButton text={report.reproducibility.commands.join("\n")} label="Copy Commands" />
              </div>
              <pre className="rounded-md bg-slate-950 p-3 text-xs font-mono text-slate-400 overflow-x-auto whitespace-pre-wrap">
                {report.reproducibility.commands.join("\n")}
              </pre>
            </div>
            <div>
              <p className="text-xs text-slate-500 mb-2">Environment notes:</p>
              <ul className="list-disc list-inside space-y-1 text-sm text-slate-400">
                {report.reproducibility.environmentNotes.map((note, i) => (
                  <li key={i}>{note}</li>
                ))}
              </ul>
            </div>
          </div>
        </CollapsibleSection>

        {/* Privacy Banner */}
        <div className="mt-6 rounded-lg bg-slate-800/30 border border-slate-700 p-4">
          <p className="text-xs text-slate-500 flex items-center gap-2">
            <svg className="h-4 w-4 text-green-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>
            {report.privacyConfirmation.message}
          </p>
        </div>

        {/* Model Verification Notes */}
        {report.modelVerificationNotes && (
          <div className="mt-4 rounded-lg bg-sky-900/20 border border-sky-700 p-4">
            <p className="text-xs text-sky-300 mb-1 font-medium">Model Verification Notes:</p>
            <p className="text-sm text-sky-200">{report.modelVerificationNotes}</p>
          </div>
        )}

        {/* Actions */}
        <div className="mt-8 flex flex-wrap gap-3 print:hidden">
          {onBack && (
            <button
              onClick={onBack}
              className="inline-flex items-center rounded-full bg-slate-700 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-slate-600 transition"
            >
              ← Back to Tasks
            </button>
          )}

          {onStartNew && (
            <button
              onClick={onStartNew}
              className="inline-flex items-center rounded-full bg-slate-700 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-slate-600 transition"
            >
              Start New Workflow
            </button>
          )}

          <button
            onClick={handleExportMarkdown}
            className="inline-flex items-center gap-2 rounded-full bg-sky-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-sky-700 transition"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3" />
            </svg>
            Copy as Markdown
          </button>

          <button
            onClick={handleDownloadJson}
            className="inline-flex items-center gap-2 rounded-full bg-slate-700 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-slate-600 transition"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
            </svg>
            Download JSON
          </button>

          <button
            onClick={handlePrint}
            className="inline-flex items-center gap-2 rounded-full bg-slate-700 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-slate-600 transition"
          >
            <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
            </svg>
            Print
          </button>
        </div>

        {/* Footer */}
        <div className="mt-8 pt-4 border-t border-slate-800 text-center">
          <p className="text-xs text-slate-600">
            CodeCheck Beta — ConvergePanel — 
            <Link href="/codecheck" className="text-sky-400 hover:text-sky-300 ml-1">
              Return to CodeCheck
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
