/**
 * Claim verification pipeline: parsing, scoring, audit bundles, and prompts.
 */

import { cleanJsonResponse } from "@/lib/verification/cleanJsonResponse";

export type ModelVerdict = "accurate" | "partially_accurate" | "inaccurate" | "unverifiable";
export type ModelConfidence = "high" | "medium" | "low";

/**
 * Why a parsed response carries no usable verdict (`verdict: null`): the field is absent / null, or it holds a value
 * outside the prompt's vocabulary (claimVerificationPrompt.ts) even after formatting normalisation. Such a response is
 * malformed model output, not a model's judgement that the claim is unverifiable.
 */
export type ModelVerdictIssue = "missing_verdict" | "unrecognized_verdict";

export type ParsedModelVerification = {
  /** null when the response holds no recognised verdict (`verdictIssue` says why). */
  verdict: ModelVerdict | null;
  verdictIssue: ModelVerdictIssue | null;
  confidence: ModelConfidence;
  summary: string;
  correctParts: string[];
  incorrectParts: string[];
  unverifiableParts: string[];
  reasoning: string;
};

const VERDICTS: ModelVerdict[] = ["accurate", "partially_accurate", "inaccurate", "unverifiable"];
const CONFS: ModelConfidence[] = ["high", "medium", "low"];

/**
 * Formatting-only normalisation of the EXISTING vocabulary: case, surrounding whitespace, and runs of inner whitespace /
 * hyphens / underscores ("Partially-Accurate", " Inaccurate ", "partially  accurate"). The one alias that predates this
 * rule ("partial") is kept. No semantic alias ("true", "mostly accurate", "correct" …) is accepted: anything else is
 * `unrecognized_verdict`, never a silent "unverifiable" (doc 14 D-1; semantic aliases are owner decision OD-2).
 */
function normalizeVerdict(v: unknown): { verdict: ModelVerdict | null; issue: ModelVerdictIssue | null } {
  if (v === undefined || v === null) return { verdict: null, issue: "missing_verdict" };
  if (typeof v !== "string") return { verdict: null, issue: "unrecognized_verdict" };
  const s = v.trim().toLowerCase().replace(/[\s_-]+/g, "_");
  if (VERDICTS.includes(s as ModelVerdict)) return { verdict: s as ModelVerdict, issue: null };
  if (s === "partial") return { verdict: "partially_accurate", issue: null };
  return { verdict: null, issue: s === "" ? "missing_verdict" : "unrecognized_verdict" };
}

function normalizeConfidence(c: unknown): ModelConfidence {
  const s = String(c || "").toLowerCase();
  if (CONFS.includes(s as ModelConfidence)) return s as ModelConfidence;
  return "medium";
}

/** Map a parsed JSON object into the verification row shape (shared by API + fallbacks). */
export function parsedModelVerificationFromObject(obj: Record<string, unknown>): ParsedModelVerification {
  const { verdict, issue } = normalizeVerdict(obj.verdict);
  return {
    verdict,
    verdictIssue: issue,
    confidence: normalizeConfidence(obj.confidence),
    summary: String(obj.summary ?? "").slice(0, 500) || "No summary provided.",
    correctParts: Array.isArray(obj.correctParts)
      ? obj.correctParts.map((x) => String(x).slice(0, 800))
      : [],
    incorrectParts: Array.isArray(obj.incorrectParts)
      ? obj.incorrectParts.map((x) => String(x).slice(0, 800))
      : [],
    unverifiableParts: Array.isArray(obj.unverifiableParts)
      ? obj.unverifiableParts.map((x) => String(x).slice(0, 800))
      : [],
    reasoning: String(obj.reasoning ?? "").slice(0, 4000),
  };
}

/**
 * Parse verification JSON from raw model text. Always runs `cleanJsonResponse()` before
 * `JSON.parse` so markdown fences and prose are handled consistently.
 */
export function tryParseVerificationJson(jsonText: string | null): {
  ok: true;
  data: ParsedModelVerification & { verdict: ModelVerdict };
} | { ok: false; snippet: string } {
  if (!jsonText || !jsonText.trim()) {
    return { ok: false, snippet: "" };
  }
  const cleaned = cleanJsonResponse(jsonText);
  try {
    const obj = JSON.parse(cleaned) as Record<string, unknown>;
    const data = parsedModelVerificationFromObject(obj);
    // A response without a recognised verdict is not a verification result (same rule as buildClaimModelEvidence).
    if (data.verdict === null) return { ok: false, snippet: cleaned.slice(0, 400) };
    return { ok: true, data: data as ParsedModelVerification & { verdict: ModelVerdict } };
  } catch {
    return { ok: false, snippet: cleaned.slice(0, 400) };
  }
}
