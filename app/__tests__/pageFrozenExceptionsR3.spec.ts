/**
 * Privacy remediation PR #329 — the hash-frozen `app/page.tsx` exception,
 * PROVEN to touch nothing else.
 *
 * `app/page.tsx` is byte-pinned (readableFrozenFiles / dsProvenanceUiBoundaries).
 * The owner authorized exactly two classes of change:
 *   - R2 (logging-only): nine console-logging arguments stop carrying model
 *     output;
 *   - R3 (reader, owner D5): the `/verify` hand-off reader also accepts the
 *     tab-scoped hand-off, so new links never put claim text in a URL.
 *     Exactly one import line and two reader lines.
 *
 * This test reverses EXACTLY those listed edits on the current file and
 * requires the result to be byte-identical to the original blob
 * (8d97e6296c16b9b0a41c30a8311a88e61de9c9a5, main at cabbdbb8). Any other
 * difference anywhere in the file fails here.
 */
import { createHash } from "crypto";
import { readFileSync } from "fs";
import { join } from "path";

const ORIGINAL_BLOB = "8d97e6296c16b9b0a41c30a8311a88e61de9c9a5";
const gitBlob = (s: string) => {
  const data = Buffer.from(s, "utf8");
  return createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${data.length}\0`), data])).digest("hex");
};
const PAGE = readFileSync(join(__dirname, "..", "page.tsx"), "utf8");

/** [current text, original text] — every authorized edit, exact. */
const R2_LOGGING: Array<[string, string]> = [
  ["          responseTextLength: responseText.length, // privacy (2026-11-18): no response body excerpt", "          responseText: responseText.substring(0, 500),"],
  ['        console.log("[panel] API response received:", { length: responseText.length }); // privacy (2026-11-18): no model-output excerpt', '        console.log("[panel] Raw API response (first 500 chars):", responseText.substring(0, 500)); // Log for debugging'],
  ["          errorName: jsonError?.name, // privacy (2026-11-18): a SyntaxError message quotes the body\n          responseTextLength: responseText.length, // privacy (2026-11-18): no model-output excerpt", "          error: jsonError,\n          responseText: responseText.substring(0, 1000), // First 1000 chars"],
  ["            responseKeys: Object.keys(data), // privacy (2026-11-18): was the full response", "            fullResponse: data,"],
  ['        console.error("Invalid response structure:", { keys: data && typeof data === "object" ? Object.keys(data) : typeof data }); // privacy (2026-11-18)', '        console.error("Invalid response structure:", data);'],
  ['      console.log("[panel] Results received from API"); // privacy (2026-11-18): was data.results (every model\'s rawText)', '      console.log("[panel] Raw results from API:", data.results);'],
  ['            console.warn("[panel] Skipping malformed result:", { modelId: result?.modelId, status: result?.status }); // privacy (2026-11-18)', '            console.warn("[panel] Skipping malformed result:", result);'],
];
const R3_READER: Array<[string, string]> = [
  ['import { consumeAppHandoff } from "@/lib/client/verifyPrefill"; // privacy (PR #329 R3): tab-scoped /verify hand-off\n', ""],
  ['      const claim = params.get("claim") || consumeAppHandoff("verify", user.uid); // privacy (PR #329 R3): new links carry no claim', '      const claim = params.get("claim");'],
  ['      const q = params.get("q") || consumeAppHandoff("research", user.uid); // privacy (PR #329 R3): new links carry no question', '      const q = params.get("q");'],
];

function reverse(src: string, edits: Array<[string, string]>): string {
  let out = src;
  for (const [cur, orig] of edits) {
    const n = out.split(cur).length - 1;
    expect({ edit: cur.slice(0, 60), occurrences: n }).toEqual({ edit: cur.slice(0, 60), occurrences: cur.startsWith("            responseKeys") ? 2 : 1 });
    out = out.split(cur).join(orig);
  }
  return out;
}

describe("app/page.tsx — only the authorized privacy edits differ from the original", () => {
  it("reversing exactly the R2 logging edits and R3 reader edits restores the original blob byte-for-byte", () => {
    expect(gitBlob(reverse(PAGE, [...R2_LOGGING, ...R3_READER]))).toBe(ORIGINAL_BLOB);
  });

  it("the legacy ?claim= / ?q= reader is still FIRST (bookmarked links keep working), the hand-off is the fallback", () => {
    expect(PAGE).toContain('const claim = params.get("claim") || consumeAppHandoff("verify", user.uid);');
    expect(PAGE).toContain('const q = params.get("q") || consumeAppHandoff("research", user.uid);');
  });
});

describe("new hand-off writers never put claim / question text in a URL", () => {
  const read = (p: string) => readFileSync(join(__dirname, "..", "..", p), "utf8");
  it("/verify pushes /?tab=verify and /?tab=research only", () => {
    const src = read("app/verify/page.tsx");
    expect(src).not.toMatch(/\?tab=verify&claim=|\?tab=research&q=/);
    expect(src).toContain('router.push("/?tab=verify")');
    expect(src).toContain('router.push("/?tab=research")');
  });
  it("the personal research follow-up writes the hand-off and pushes /?tab=research", () => {
    const src = read("components/workspace/PersonalResearchDetailShell.tsx");
    expect(src).not.toMatch(/personalResearchFollowUpHref\(/);
    expect(src).toContain('router.push("/?tab=research")');
  });
});
