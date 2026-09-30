/**
 * Client-side file text extraction.
 * Supports .txt, .md, .pdf (via pdfjs-dist), and .docx (via mammoth).
 * All parsing runs in the browser — nothing is uploaded.
 */

const SUPPORTED_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
]);

const SUPPORTED_EXTENSIONS = new Set([".txt", ".md", ".pdf", ".docx"]);

export function isFileSupported(file: File): boolean {
  const ext = "." + file.name.split(".").pop()?.toLowerCase();
  return SUPPORTED_TYPES.has(file.type) || SUPPORTED_EXTENSIONS.has(ext);
}

async function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.readAsText(file);
  });
}

async function readAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(new Error("Could not read file"));
    reader.readAsArrayBuffer(file);
  });
}

/**
 * Same-origin URL of the pdf.js worker. The file is copied out of the installed
 * pdfjs-dist at build time by scripts/pdfjs-worker/materialize.js, which owns the
 * `/vendor/pdfjs` prefix. It must stay on our origin: the CSP allows workers and
 * module scripts from 'self' only, so a CDN URL blocks both the worker and
 * pdf.js's fake-worker fallback (R-16). Keyed by the bundled library version so
 * the worker can never be a different release than the API calling it.
 */
export function pdfWorkerSrc(version: string): string {
  return `/vendor/pdfjs/${version}/pdf.worker.min.mjs`;
}

async function extractPdf(file: File): Promise<string> {
  const pdfjsLib = await import("pdfjs-dist");

  // A plain string URL, not webpack `new URL()` magic, so the ESM worker is
  // never pulled into the bundle. Assigned unconditionally so nothing else can
  // leave an off-origin value in place.
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerSrc(pdfjsLib.version);

  const buffer = await readAsArrayBuffer(file);
  const doc = await pdfjsLib.getDocument({ data: buffer }).promise;
  const pages: string[] = [];

  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items
      .map((item) => ("str" in item ? item.str : ""))
      .join(" ");
    pages.push(pageText);
  }

  return pages.join("\n\n");
}

async function extractDocx(file: File): Promise<string> {
  const mammoth = await import("mammoth");
  const buffer = await readAsArrayBuffer(file);
  const result = await mammoth.extractRawText({ arrayBuffer: buffer });
  return result.value;
}

export async function extractFileText(file: File): Promise<string> {
  const ext = "." + file.name.split(".").pop()?.toLowerCase();

  if (file.type === "application/pdf" || ext === ".pdf") {
    return extractPdf(file);
  }

  if (
    file.type === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    ext === ".docx"
  ) {
    return extractDocx(file);
  }

  if (
    file.type === "text/plain" ||
    file.type === "text/markdown" ||
    ext === ".txt" ||
    ext === ".md"
  ) {
    return readAsText(file);
  }

  throw new Error(
    `Unsupported file type "${file.name}". Please upload a .txt, .md, .pdf, or .docx file.`
  );
}
