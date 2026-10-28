/**
 * Order 6 / S-E.2 (R1 MINOR-1, CodeQL): reader-visible text of a generated DOCX, through a structured reader instead
 * of regular expressions over XML. `mammoth` (a direct dependency) parses the package and walks paragraphs and runs,
 * so a phrase split across runs with different formatting comes back as one paragraph string.
 *
 * Input handling: the package is bounded in size, every XML part is refused if it declares a DOCTYPE or an ENTITY (no
 * DTD or entity processing can occur), and nothing outside the in-memory package is read: the reader resolves no
 * external entity, file or URL. A malformed package throws a DocxTextError; callers treat that as a failure.
 */
import JSZip from "jszip";
import mammoth from "mammoth";

export const MAX_DOCX_BYTES = 20 * 1024 * 1024;
export const MAX_XML_PART_BYTES = 10 * 1024 * 1024;

export class DocxTextError extends Error {}

/** Every non-empty paragraph of the document body, in reading order, with surrounding whitespace trimmed. */
export async function docxParagraphs(bytes: Buffer): Promise<string[]> {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) throw new DocxTextError("not a DOCX package: empty input");
  if (bytes.length > MAX_DOCX_BYTES) throw new DocxTextError(`DOCX package exceeds ${MAX_DOCX_BYTES} bytes`);
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch (err) {
    throw new DocxTextError(`not a DOCX package: ${(err as Error).message}`);
  }
  if (!zip.file("word/document.xml")) throw new DocxTextError("not a DOCX package: word/document.xml missing");
  for (const name of Object.keys(zip.files)) {
    const entry = zip.files[name];
    if (entry.dir || !/\.(xml|rels)$/i.test(name)) continue;
    const xml = await entry.async("string");
    if (xml.length > MAX_XML_PART_BYTES) throw new DocxTextError(`${name} exceeds ${MAX_XML_PART_BYTES} characters`);
    const upper = xml.toUpperCase();
    if (upper.includes("<!DOCTYPE") || upper.includes("<!ENTITY")) throw new DocxTextError(`${name} declares a DOCTYPE or ENTITY`);
  }
  let value: string;
  try {
    value = (await mammoth.extractRawText({ buffer: bytes })).value;
  } catch (err) {
    throw new DocxTextError(`unreadable DOCX: ${(err as Error).message}`);
  }
  return value
    .split(/\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}
