/**
 * Adaptive Research Export, Phase 3 — DOCX test helpers. Extracts plain,
 * reader-visible text from a real generated .docx's `word/document.xml`
 * (via JSZip + a simple tag-strip), so schema-semantics tests can assert
 * on actual rendered content the same way `lib/pdf/__tests__/testUtils.ts`
 * walks the PDF composer's mocked element tree — except here nothing is
 * mocked; this reads the REAL package the real renderer produced.
 */

import JSZip from "jszip";

export async function extractDocxText(bytes: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.files["word/document.xml"].async("string");
  // Word inserts a paragraph mark between block elements — turn those into
  // newlines before stripping tags, so adjacent paragraphs/cells don't
  // silently concatenate into one unbroken word run.
  const withBreaks = xml.replace(/<\/w:p>/g, "\n").replace(/<\/w:tc>/g, "\t");
  const textOnly = withBreaks.replace(/<[^>]+>/g, "");
  // OOXML escapes &, <, >, ' and " — decode them back for readable assertions.
  return textOnly
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"');
}
