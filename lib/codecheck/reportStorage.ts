/**
 * Report Storage Utilities
 * 
 * Helper functions for storing and retrieving verification reports
 * using sessionStorage. This provides in-memory persistence for the
 * current session until Firestore persistence is implemented.
 */

import { VerificationReport } from "./types";

// Session storage key for the report
const REPORT_STORAGE_KEY = "codecheck_verification_report";

/**
 * Store a report in sessionStorage for the report page to display
 * Call this function before navigating to /codecheck/report
 */
export function storeReportForDisplay(report: VerificationReport): void {
  if (typeof window === "undefined") return;
  
  try {
    sessionStorage.setItem(REPORT_STORAGE_KEY, JSON.stringify(report));
  } catch (err) {
    console.error("[Report] Failed to store report:", err);
  }
}

/**
 * Retrieve a report from sessionStorage
 */
export function getStoredReport(): VerificationReport | null {
  if (typeof window === "undefined") return null;
  
  try {
    const storedReport = sessionStorage.getItem(REPORT_STORAGE_KEY);
    if (storedReport) {
      return JSON.parse(storedReport) as VerificationReport;
    }
    return null;
  } catch (err) {
    console.error("[Report] Failed to get stored report:", err);
    return null;
  }
}

/**
 * Clear the stored report from sessionStorage
 */
export function clearStoredReport(): void {
  if (typeof window === "undefined") return;
  
  try {
    sessionStorage.removeItem(REPORT_STORAGE_KEY);
  } catch (err) {
    console.error("[Report] Failed to clear report:", err);
  }
}

/**
 * Get the storage key (for direct access if needed)
 */
export function getReportStorageKey(): string {
  return REPORT_STORAGE_KEY;
}
