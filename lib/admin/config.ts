/**
 * Admin / governance allowlists (optional env fallbacks when Firestore role is not set).
 */

/** Trim, lowercase, NFKC, strip zero-width / BOM so token emails match the allowlist. */
function normalizeEmailForMatch(raw: string): string {
  return raw
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim()
    .toLowerCase();
}

function parseEmailList(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(",")
    .map((s) => normalizeEmailForMatch(s))
    .filter(Boolean);
}

/**
 * Built-in governance admin emails (matched case-insensitively after {@link normalizeEmailForMatch}).
 * Env `GOVERNANCE_ADMIN_EMAILS` is merged in {@link isAdminEmail}.
 */
export const ADMIN_EMAILS = [
  "yasinwarsame@hotmail.com",
  "ywarsame@convergepanel.com",
] as const;

/** Effective allowlist for logs (built-in + env), lowercased, deduped. */
export function governanceAdminEmailsForLog(): string {
  const fromEnv = parseEmailList(process.env.GOVERNANCE_ADMIN_EMAILS);
  const builtIn = ADMIN_EMAILS.map((e) => normalizeEmailForMatch(e));
  return [...new Set([...builtIn, ...fromEnv])].join(",");
}

/** Built-in list + comma-separated `GOVERNANCE_ADMIN_EMAILS` — admin for governance APIs. */
export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  const normalized = normalizeEmailForMatch(String(email));
  if (!normalized) return false;
  if (ADMIN_EMAILS.some((admin) => normalizeEmailForMatch(admin) === normalized)) return true;
  return parseEmailList(process.env.GOVERNANCE_ADMIN_EMAILS).includes(normalized);
}

/** Comma-separated emails in GOVERNANCE_REVIEWER_EMAILS — reviewer role via env. */
export function isReviewerEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return parseEmailList(process.env.GOVERNANCE_REVIEWER_EMAILS).includes(normalizeEmailForMatch(String(email)));
}
