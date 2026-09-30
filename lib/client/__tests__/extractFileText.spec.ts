/**
 * R-16 — client file extraction.
 *
 * pdfjs-dist and mammoth are replaced with fakes: the real pdfjs-dist ESM build
 * cannot load under this Jest config (see lib/pdf/__tests__/testUtils.ts), and
 * Node has no Worker/CSP to exercise anyway. So this proves the worker URL the
 * code configures and the extraction plumbing around it. It does NOT prove a
 * browser loads the worker under the real CSP — only the preview acceptance
 * does that.
 */

const fakePdfjs = {
  version: "6.3.289",
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: jest.fn(),
};
jest.mock("pdfjs-dist", () => fakePdfjs);

const extractRawText = jest.fn();
jest.mock("mammoth", () => ({ extractRawText }));

// Node has File and Blob but no FileReader; this minimal stand-in delegates to
// Blob's own readers so the code under test runs its real FileReader path.
class TestFileReader {
  result: string | ArrayBuffer | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readAsText(b: Blob) {
    b.text().then((t) => { this.result = t; this.onload?.(); }, () => this.onerror?.());
  }
  readAsArrayBuffer(b: Blob) {
    b.arrayBuffer().then((a) => { this.result = a; this.onload?.(); }, () => this.onerror?.());
  }
}
(globalThis as unknown as { FileReader: unknown }).FileReader = TestFileReader;

import { extractFileText, isFileSupported, pdfWorkerSrc } from "@/lib/client/extractFileText";

const materializer = require("@/scripts/pdfjs-worker/materialize.js") as {
  servedWorkerUrl: (v: string) => string;
};

/** workerSrc as it was when getDocument ran — pdf.js reads it synchronously there. */
let workerSrcAtGetDocument: string | undefined;

function fakePdf(pages: string[][]) {
  fakePdfjs.getDocument.mockImplementation(() => {
    workerSrcAtGetDocument = fakePdfjs.GlobalWorkerOptions.workerSrc;
    return docResult(pages);
  });
}

function docResult(pages: string[][]) {
  return {
    promise: Promise.resolve({
      numPages: pages.length,
      getPage: async (i: number) => ({
        getTextContent: async () => ({ items: pages[i - 1].map((str) => ({ str })) }),
      }),
    }),
  };
}

const pdfFile = () => new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "doc.pdf", { type: "application/pdf" });

beforeEach(() => {
  fakePdfjs.GlobalWorkerOptions.workerSrc = "";
  workerSrcAtGetDocument = undefined;
  fakePdfjs.getDocument.mockReset();
  extractRawText.mockReset();
});

describe("PDF worker source", () => {
  it("A: configures a same-origin, root-relative worker URL", async () => {
    fakePdf([["x"]]);
    await extractFileText(pdfFile());
    const src = fakePdfjs.GlobalWorkerOptions.workerSrc;
    expect(src).toBe("/vendor/pdfjs/6.3.289/pdf.worker.min.mjs");
    // Root-relative on our origin: not scheme-qualified, not protocol-relative.
    expect(src.startsWith("/")).toBe(true);
    expect(src.startsWith("//")).toBe(false);
    expect(new URL(src, "https://convergepanel.com").origin).toBe("https://convergepanel.com");
  });

  it("sets the worker URL before getDocument runs (pdf.js reads it synchronously there)", async () => {
    fakePdf([["x"]]);
    await extractFileText(pdfFile());
    expect(fakePdfjs.getDocument).toHaveBeenCalledTimes(1);
    expect(workerSrcAtGetDocument).toBe("/vendor/pdfjs/6.3.289/pdf.worker.min.mjs");
  });

  it("B: overrides a pre-existing CDN worker URL instead of keeping it", async () => {
    fakePdfjs.GlobalWorkerOptions.workerSrc =
      "https://cdn.jsdelivr.net/npm/pdfjs-dist@6.3.289/build/pdf.worker.min.mjs";
    fakePdf([["x"]]);
    await extractFileText(pdfFile());
    expect(fakePdfjs.GlobalWorkerOptions.workerSrc).not.toMatch(/jsdelivr|:\/\//);
  });

  it("uses the bundled library version, so API and worker releases cannot diverge", async () => {
    fakePdfjs.version = "9.9.9";
    try {
      fakePdf([["x"]]);
      await extractFileText(pdfFile());
      expect(fakePdfjs.GlobalWorkerOptions.workerSrc).toBe("/vendor/pdfjs/9.9.9/pdf.worker.min.mjs");
    } finally {
      fakePdfjs.version = "6.3.289";
    }
  });

  it("C: the client URL is exactly the path the build materializes", () => {
    for (const v of ["6.3.289", "7.0.0"]) {
      expect(pdfWorkerSrc(v)).toBe(materializer.servedWorkerUrl(v));
    }
  });
});

describe("extraction behaviour", () => {
  it("joins PDF page text with blank lines between pages", async () => {
    fakePdf([["Hello", "world"], ["TEST-CODE-4711"]]);
    await expect(extractFileText(pdfFile())).resolves.toBe("Hello world\n\nTEST-CODE-4711");
    expect(fakePdfjs.getDocument).toHaveBeenCalledWith({ data: expect.any(ArrayBuffer) });
  });

  it("propagates a pdf.js failure instead of swallowing it", async () => {
    fakePdfjs.getDocument.mockReturnValue({
      promise: Promise.reject(new Error('Setting up fake worker failed: "x".')),
    });
    await expect(extractFileText(pdfFile())).rejects.toThrow(/fake worker failed/);
  });

  it("H: reads .txt and .md as text", async () => {
    await expect(extractFileText(new File(["plain text"], "a.txt", { type: "text/plain" }))).resolves.toBe("plain text");
    await expect(extractFileText(new File(["# md"], "a.md", { type: "" }))).resolves.toBe("# md");
  });

  it("H: extracts .docx through mammoth", async () => {
    extractRawText.mockResolvedValue({ value: "docx body" });
    const f = new File([new Uint8Array([1, 2])], "a.docx", { type: "" });
    await expect(extractFileText(f)).resolves.toBe("docx body");
    expect(extractRawText).toHaveBeenCalledWith({ arrayBuffer: expect.any(ArrayBuffer) });
    expect(fakePdfjs.getDocument).not.toHaveBeenCalled();
  });

  it("H: rejects unsupported types", async () => {
    const f = new File(["x"], "a.exe", { type: "application/octet-stream" });
    expect(isFileSupported(f)).toBe(false);
    await expect(extractFileText(f)).rejects.toThrow(/Unsupported file type/);
  });
});
