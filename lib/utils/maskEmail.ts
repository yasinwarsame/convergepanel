/**
 * Masks an email address for privacy in governance UI.
 * "sarah.jones@company.com" → "sar***@company.com"
 * Local part ≤3 characters: first character + "***@domain".
 * Returns the trimmed string if it does not look like an email.
 * Does not mask when the address matches the current user's email (case-insensitive).
 */
export function maskEmail(email: string, currentUserEmail?: string | null): string {
  const trimmed = (email ?? "").trim();
  if (!trimmed || !trimmed.includes("@")) return trimmed;

  if (
    currentUserEmail &&
    trimmed.toLowerCase() === currentUserEmail.trim().toLowerCase()
  ) {
    return trimmed;
  }

  const at = trimmed.indexOf("@");
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  if (!local || !domain) return trimmed;

  if (local.length <= 3) {
    return `${local.charAt(0)}***@${domain}`;
  }
  return `${local.slice(0, 3)}***@${domain}`;
}
