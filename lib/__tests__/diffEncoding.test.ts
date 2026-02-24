/**
 * Diff Encoding Tests
 *
 * Ensures base64 diff decoding, chunked decoding (with auto-split),
 * unified diff validation, and NOT_UNIFIED_DIFF_ERROR path.
 */

import {
  decodeBase64Diff,
  joinBase64Chunks,
  isUnifiedDiff,
  NOT_UNIFIED_DIFF_ERROR,
} from "@/lib/codecheck/diffEncoding";

const SAMPLE_DIFF = [
  "--- a/app/api/echo/route.ts",
  "+++ b/app/api/echo/route.ts",
  "@@ -0,0 +1,3 @@",
  "+export function POST() {}",
].join("\n");

/** Longer diff whose base64 exceeds 200 chars (for auto-split tests). */
const LONG_DIFF = [
  "--- a/app/api/echo/route.ts",
  "+++ b/app/api/echo/route.ts",
  "@@ -0,0 +1,10 @@",
  "+import { NextRequest, NextResponse } from 'next/server';",
  "+",
  "+export async function POST(request: NextRequest) {",
  "+  const body = await request.json();",
  "+  return NextResponse.json({",
  "+    ok: true,",
  "+    echo: body,",
  "+    timestamp: new Date().toISOString(),",
  "+  });",
  "+}",
].join("\n");

// ============================================
// isUnifiedDiff
// ============================================

describe("isUnifiedDiff", () => {
  it("accepts valid unified diff", () => {
    expect(isUnifiedDiff(SAMPLE_DIFF)).toBe(true);
  });

  it("rejects non-diff text", () => {
    expect(isUnifiedDiff("hello world")).toBe(false);
  });

  it("rejects raw source code (not a diff)", () => {
    const rawCode = "export function hello() { return 'world'; }";
    expect(isUnifiedDiff(rawCode)).toBe(false);
  });
});

// ============================================
// decodeBase64Diff
// ============================================

describe("decodeBase64Diff", () => {
  it("decodes valid base64", () => {
    const b64 = Buffer.from(SAMPLE_DIFF, "utf8").toString("base64");
    const result = decodeBase64Diff(b64);
    expect(result.ok).toBe(true);
    expect(result.diff).toBe(SAMPLE_DIFF);
  });

  it("strips embedded whitespace before decoding", () => {
    const b64 = Buffer.from(SAMPLE_DIFF, "utf8").toString("base64");
    const withBreaks = b64.slice(0, 20) + "\n" + b64.slice(20);
    const result = decodeBase64Diff(withBreaks);
    expect(result.ok).toBe(true);
    expect(result.diff).toBe(SAMPLE_DIFF);
  });

  it("rejects NUL bytes in decoded output", () => {
    const b64 = Buffer.from("a\u0000b", "utf8").toString("base64");
    const result = decodeBase64Diff(b64);
    expect(result.ok).toBe(false);
  });
});

// ============================================
// joinBase64Chunks
// ============================================

describe("joinBase64Chunks", () => {
  it("joins correctly-sized chunks and decodes", () => {
    const b64 = Buffer.from(SAMPLE_DIFF, "utf8").toString("base64");
    const chunks: string[] = [];
    for (let i = 0; i < b64.length; i += 76) {
      chunks.push(b64.slice(i, i + 76));
    }
    const result = joinBase64Chunks(chunks);
    expect(result.ok).toBe(true);
    expect(result.diff).toBe(SAMPLE_DIFF);
  });

  it("auto-splits a single oversized chunk and decodes successfully", () => {
    const b64 = Buffer.from(LONG_DIFF, "utf8").toString("base64");
    // Confirm the base64 actually exceeds 200 chars
    expect(b64.length).toBeGreaterThan(200);
    // Pass as a single element — should be auto-split, not rejected
    const result = joinBase64Chunks([b64]);
    expect(result.ok).toBe(true);
    expect(result.diff).toBe(LONG_DIFF);
  });

  it("auto-splits mixed oversized and normal chunks", () => {
    const b64 = Buffer.from(LONG_DIFF, "utf8").toString("base64");
    // Split into two: one big, one small
    const mid = Math.floor(b64.length / 2);
    const chunks = [b64.slice(0, mid + 150), b64.slice(mid + 150)];
    const result = joinBase64Chunks(chunks);
    expect(result.ok).toBe(true);
    expect(result.diff).toBe(LONG_DIFF);
  });

  it("rejects non-array input", () => {
    expect(joinBase64Chunks("notarray").ok).toBe(false);
  });

  it("rejects empty array", () => {
    expect(joinBase64Chunks([]).ok).toBe(false);
  });

  it("rejects chunk with invalid base64 characters", () => {
    expect(joinBase64Chunks(["abc!@#"]).ok).toBe(false);
  });

  it("rejects chunk with internal whitespace", () => {
    expect(joinBase64Chunks(["abc def"]).ok).toBe(false);
  });

  it("trims whitespace around chunks", () => {
    const b64 = Buffer.from(SAMPLE_DIFF, "utf8").toString("base64");
    const chunks = [b64.slice(0, 50), b64.slice(50)].map((c) => " " + c + " ");
    const result = joinBase64Chunks(chunks);
    expect(result.ok).toBe(true);
    expect(result.diff).toBe(SAMPLE_DIFF);
  });
});

// ============================================
// NOT_UNIFIED_DIFF_ERROR path
// ============================================

describe("not-unified-diff error path", () => {
  it("decoded raw source code passes base64 decode but fails isUnifiedDiff", () => {
    const rawCode = 'export function hello() { return "world"; }';
    const b64 = Buffer.from(rawCode, "utf8").toString("base64");
    const chunks: string[] = [];
    for (let i = 0; i < b64.length; i += 76) {
      chunks.push(b64.slice(i, i + 76));
    }

    // Base64 decode succeeds
    const result = joinBase64Chunks(chunks);
    expect(result.ok).toBe(true);
    expect(result.diff).toBe(rawCode);

    // But it's not a unified diff
    expect(isUnifiedDiff(result.diff!)).toBe(false);
  });

  it("NOT_UNIFIED_DIFF_ERROR constant has the expected message", () => {
    expect(NOT_UNIFIED_DIFF_ERROR).toContain("not a unified diff");
    expect(NOT_UNIFIED_DIFF_ERROR).toContain("--- a/");
  });
});
