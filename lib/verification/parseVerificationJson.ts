/**
 * Claim verification pipeline: parsing, scoring, audit bundles, and prompts.
 */

import type { ModelId } from "@/lib/types";
import { cleanJsonResponse } from "@/lib/verification/cleanJsonResponse";

export type ModelVerdict = "accurate" | "partially_accurate" | "inaccurate" | "unverifiable";
export type ModelConfidence = "high" | "medium" | "low";

export type ParsedModelVerification = {
  verdict: ModelVerdict;
  confidence: ModelConfidence;
  summary: string;
  correctParts: string[];
  incorrectParts: string[];
  unverifiableParts: string[];
  reasoning: string;
};

const VERDICTS: ModelVerdict[] = ["accurate", "partially_accurate", "inaccurate", "unverifiable"];
const CONFS: ModelConfidence[] = ["high", "medium", "low"];

function normalizeVerdict(v: unknown): ModelVerdict {
  const s = String(v || "").toLowerCase().replace(/\s+/g, "_");
  if (VERDICTS.includes(s as ModelVerdict)) return s as ModelVerdict;
  if (s === "partial") return "partially_accurate";
  return "unverifiable";
}

function normalizeConfidence(c: unknown): ModelConfidence {
  const s = String(c || "").toLowerCase();
  if (CONFS.includes(s as ModelConfidence)) return s as ModelConfidence;
  return "medium";
}

/** Map a parsed JSON object into the verification row shape (shared by API + fallbacks). */
export function parsedModelVerificationFromObject(obj: Record<string, unknown>): ParsedModelVerification {
  return {
    verdict: normalizeVerdict(obj.verdict),
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
  data: ParsedModelVerification;
} | { ok: false; snippet: string } {
  if (!jsonText || !jsonText.trim()) {
    return { ok: false, snippet: "" };
  }
  const cleaned = cleanJsonResponse(jsonText);
  try {
    const obj = JSON.parse(cleaned) as Record<string, unknown>;
    return { ok: true, data: parsedModelVerificationFromObject(obj) };
  } catch {
    return { ok: false, snippet: cleaned.slice(0, 400) };
  }
}

export function parseVerificationJsonFallback(modelId: ModelId, rawText: string | null): ParsedModelVerification {
  const r = tryParseVerificationJson(rawText ?? "");
  if (r.ok) return r.data;
  return {
    verdict: "unverifiable",
    confidence: "low",
    summary: `Could not parse JSON from ${modelId}.`,
    correctParts: [],
    incorrectParts: [],
    unverifiableParts: ["Model returned non-JSON output"],
    reasoning: "",
  };
}
