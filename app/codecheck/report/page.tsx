"use client";

/**
 * Verification Report Route Page
 * 
 * This page displays the verification report after a CodeCheck verification.
 * 
 * Data flow:
 * - Report data is passed via sessionStorage (since we don't have persistence yet)
 * - Falls back gracefully if no report data is available
 * - User can navigate back to the main CodeCheck page
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { VerificationReport } from "@/lib/codecheck/types";
import VerificationReportPage from "@/components/codecheck/VerificationReportPage";
import { getStoredReport, clearStoredReport } from "@/lib/codecheck/reportStorage";

export default function ReportPage() {
  const router = useRouter();
  const [report, setReport] = useState<VerificationReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Try to load report from sessionStorage
    try {
      const storedReport = getStoredReport();
      if (storedReport) {
        setReport(storedReport);
      } else {
        setError("No verification report found. Please complete a verification first.");
      }
    } catch (err) {
      console.error("[Report Page] Failed to load report:", err);
      setError("Failed to load the verification report.");
    } finally {
      setLoading(false);
    }
  }, []);

  const handleBack = () => {
    router.push("/codecheck");
  };

  const handleStartNew = () => {
    // Clear the stored report
    clearStoredReport();
    router.push("/codecheck");
  };

  // Loading state
  if (loading) {
    return (
      <main className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 flex items-center justify-center">
        <div className="flex flex-col items-center gap-2 text-slate-300">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-sky-400 border-t-transparent" />
          <p className="text-sm">Loading report...</p>
        </div>
      </main>
    );
  }

  // Error state / No report
  if (error || !report) {
    return (
      <main className="min-h-screen bg-gradient-to-br from-slate-950 via-slate-900 to-slate-950 flex items-center justify-center">
        <div className="max-w-md text-center px-4">
          <div className="mb-6">
            <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-amber-900/30 text-amber-400">
              <svg className="h-8 w-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
          </div>
          <h1 className="text-xl font-semibold text-white mb-2">
            No Report Available
          </h1>
          <p className="text-sm text-slate-400 mb-6">
            {error || "Complete a verification in CodeCheck to generate a report."}
          </p>
          <Link
            href="/codecheck"
            className="inline-flex items-center rounded-full bg-sky-600 px-6 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-sky-700 transition"
          >
            Go to CodeCheck
          </Link>
        </div>
      </main>
    );
  }

  // Render the full report
  return (
    <VerificationReportPage
      report={report}
      onBack={handleBack}
      onStartNew={handleStartNew}
    />
  );
}
