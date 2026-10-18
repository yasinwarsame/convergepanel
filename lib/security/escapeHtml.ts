/**
 * HTML output encoding for untrusted text placed into application-authored HTML (text content or a quoted
 * attribute value). Encodes the five characters that can change HTML structure: & < > " '. `&` first, so an
 * existing entity is shown literally rather than decoded. Pure and client-safe.
 *
 * This is the security boundary for model-written text in HTML built by string templates (lib/consensus.ts): the
 * text is data, never markup. It is not a sanitizer and must not be used on HTML that is meant to stay HTML.
 */
export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
