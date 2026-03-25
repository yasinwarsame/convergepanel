/**
 * Admin / governance allowlists (optional env fallbacks when Firestore role is not set).
 */

function parseEmailList(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** Comma-separated lowercase emails in GOVERNANCE_ADMIN_EMAILS — admin for governance APIs (match is case-insensitive). */
export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const normalized = email.trim().toLowerCase();
  if (!normalized) return false;
  return parseEmailList(process.env.GOVERNANCE_ADMIN_EMAILS).includes(normalized);
}

/** Comma-separated emails in GOVERNANCE_REVIEWER_EMAILS — reviewer role via env. */
export function isReviewerEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return parseEmailList(process.env.GOVERNANCE_REVIEWER_EMAILS).includes(email.trim().toLowerCase());
}
