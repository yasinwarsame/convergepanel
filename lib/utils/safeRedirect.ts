/**
 * Validates and sanitizes redirect URLs to prevent open redirect attacks.
 *
 * Only allows internal paths (starting with "/") and rejects any URL that
 * could redirect to an external domain.
 */
export function safeRedirect(value: string | null | undefined, fallback = "/"): string {
  if (!value || typeof value !== "string") return fallback;

  const decoded = decodeURIComponent(value).trim();

  if (!decoded.startsWith("/")) return fallback;
  if (decoded.startsWith("//")) return fallback;
  if (decoded.toLowerCase().includes("http://")) return fallback;
  if (decoded.toLowerCase().includes("https://")) return fallback;

  return decoded;
}
