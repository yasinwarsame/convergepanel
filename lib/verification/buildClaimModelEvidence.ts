/**
 * Phase 8C-E.1 — mechanically extracted from `app/api/verify-claim/route.ts`
 * (the per-model JSON-parse/repair orchestration that turns raw
 * `ModelResult[]` into `StoredVerificationModelSummary[]`). This was
 * inline route code, not a standalone function, until this extraction —
 * the E.0 audit's "existing per-model parser" characterization referred
 * to the individual primitives this function still calls
 * (`cleanJsonResponse`/`repairTruncatedJson`/`parsedModelVerificationFromObject`),
 * not to this orchestration itself.
 *
 * Extracted so the new Team Claim route can call it directly instead of
 * duplicating this logic, per the frozen E1 instruction not to duplicate
 * Claim execution internals. Pure function, no side effects beyond
 * `logger` calls (unchanged from the original inline block).
 */

import "server-only";
import { ModelResult } from "@/lib/types";
import { parsedModelVerificationFromObject, type ModelVerdict } from "@/lib/verification/parseVerificationJson";
import { cleanJsonResponse, repairTruncatedJson } from "@/lib/verification/cleanJsonResponse";
import type { StoredVerificationModelSummary } from "@/lib/firestore/verifications";
import { logger } from "@/lib/logger";
import { canonicalProvider } from "@/lib/panel/providerRegistry";
import { placeholderClass } from "@/lib/panel/executionIdentity";

function isConnectorSuccess(r: ModelResult): boolean {
  return r.status === "ok" || r.status === "substituted";
}

/** `{ substituted: true, provider? }` for a substituted result (provider only when recorded); `{}` otherwise. */
function substitutionAttribution(r: ModelResult): { substituted?: true; provider?: string } {
  if (r.status !== "substituted") return {};
  const provider = typeof r.provider === "string" && r.provider.trim().length > 0 ? r.provider.trim() : undefined;
  return provider ? { substituted: true, provider } : { substituted: true };
}

/**
 * Order 33 (owner ruling A): `{ provider }` for a SUCCESSFUL own-provider answer — the connector returned `status: "ok"`
 * with the provider the claim dispatch stamped from the connector function it invoked
 * (runClaimVerificationPanel), canonical (lib/panel/providerRegistry.ts), and text that is not the exact stored
 * placeholder literal (D-5 INVALID_MOCK records no provider; since F-2, Order 34, a genuine answer that merely mentions a
 * "mock response" — the VALIDITY_UNKNOWN text oracle — is a model response). `{}` otherwise: a failed / timed-out / refused /
 * rate-limited / parse_error / placeholder / unstamped row records no provider, and its identity stays unverified.
 */
function ownProviderAttribution(r: ModelResult): { provider?: string } {
  if (r.status !== "ok") return {};
  const provider = canonicalProvider(r.provider);
  if (!provider) return {};
  // F-2 (Order 34): only the exact placeholder literal is excluded. A genuine answer that discusses a "mock response"
  // is a model response (VALIDITY_UNKNOWN is a text oracle for historical rows, not an authority on a current write).
  if (placeholderClass({ modelId: r.modelId, status: "ok", rawText: r.rawText ?? "" }) === "INVALID_MOCK") return {};
  return { provider };
}

export function buildClaimModelEvidence(modelResults: ModelResult[]): StoredVerificationModelSummary[] {
  return modelResults.map((r) => {
    if (!isConnectorSuccess(r)) {
      return {
        modelId: r.modelId,
        status: "failed" as const,
        verdict: "failed",
        confidence: "low",
        summary: r.errorMessage || "Model request failed.",
        correctParts: [] as string[],
        incorrectParts: [] as string[],
        unverifiableParts: [] as string[],
      };
    }
    const modelId = r.modelId;
    const rawText = r.rawText ?? "";
    logger.debug(`[verify-claim] Raw response from ${modelId}`, { length: rawText.length });

    const cleaned = cleanJsonResponse(rawText);
    const trimmedRaw = rawText.trim();
    if (cleaned !== trimmedRaw) {
      logger.debug(
        `[verify-claim] Cleaned JSON response for ${modelId}`,
        { removedChars: rawText.length - cleaned.length }
      );
    }
    let d: ReturnType<typeof parsedModelVerificationFromObject>;
    try {
      const obj = JSON.parse(cleaned) as Record<string, unknown>;
      d = parsedModelVerificationFromObject(obj);
    } catch {
      try {
        const repaired = repairTruncatedJson(cleaned);
        const obj = JSON.parse(repaired) as Record<string, unknown>;
        d = parsedModelVerificationFromObject(obj);
        logger.debug(`[verify-claim] Repaired truncated JSON for ${modelId}`);
      } catch {
        logger.error(
          `[verify-claim] JSON parse failed even after repair for ${modelId}`,
          { cleanedPreview: cleaned.substring(0, 100) }
        );
        return {
          modelId,
          status: "parse_error" as const,
          verdict: "parse_error",
          confidence: "low",
          summary: "Model returned invalid JSON; could not parse verification result.",
          correctParts: [],
          incorrectParts: [],
          unverifiableParts: ["Non-JSON or malformed response"],
        };
      }
    }
    return {
      modelId,
      status: "ok" as const,
      verdict: d.verdict,
      confidence: d.confidence,
      summary: d.summary,
      correctParts: d.correctParts,
      incorrectParts: d.incorrectParts,
      unverifiableParts: d.unverifiableParts,
      // Execution attribution: a connector-reported substitute is recorded, never stored as the slot's own answer
      // (lib/panel/storedVerificationIndependence.ts); an own-provider answer records the provider the dispatch
      // stamped (Order 33). The requested slot (`modelId`) and the outcome (`status`) stay separate fields.
      ...substitutionAttribution(r),
      ...ownProviderAttribution(r),
    };
  });
}

export type { ModelVerdict };
