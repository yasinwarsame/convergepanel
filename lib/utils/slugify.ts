/**
 * Converts a string into a URL-friendly slug.
 *
 * - Lowercases the input
 * - Strips unicode diacritics (combining marks)
 * - Collapses whitespace/underscore/hyphen runs into one hyphen
 * - Removes non-alphanumeric, non-dash characters
 * - Trims leading/trailing dashes
 */
export function slugify(text: string): string {
  return text
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[\s_-]+/g, "-")
    .replace(/[^a-z0-9-]/g, "")
    .replace(/^-+|-+$/g, "");
}
