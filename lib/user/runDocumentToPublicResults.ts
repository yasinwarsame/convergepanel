/**
 * Rehydrates panel row data from a compact Firestore `runDocument` into
 * saved-run results for the read APIs (Personal run detail, Team run detail,
 * Team project research page).
 *
 * Saved-run provenance honesty (S1): `provider`, `requestedModel` and (on a
 * substituted row) `substitutedFrom` are copied ONLY from what the persisted
 * `perModel` row carries (Step 6.2a onward). Nothing is derived from current
 * model configuration or from `modelId`, and `actualModel` is never emitted.
 * A run completed before 6.2a therefore returns none of those keys.
 */

import type { PersistedPanelResultPublic, RunDocument } from "@/lib/panel/schemas";
import { normalizePersistedModelResult } from "@/lib/panel/normalize";

export function runDocumentToPublicResults(runDocument: RunDocument | null | undefined): PersistedPanelResultPublic[] {
  if (!runDocument?.perModel?.length) return [];

  return runDocument.perModel.map((p) => {
    const text = typeof p.rawTextTruncated === "string" ? p.rawTextTruncated : "";
    const tu = p.tokenUsage ?? {
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    };
    const raw = {
      modelId: p.modelId,
      status: p.status,
      rawTextFull: text,
      rawText: text,
      latencyMs: typeof p.latencyMs === "number" ? p.latencyMs : 0,
      tokenUsage: tu,
      wasTruncatedForStorage: p.wasTruncated,
      provider: p.provider,
      requestedModel: p.requestedModel,
      substitutedFrom: p.substitutedFrom,
    };
    return normalizePersistedModelResult(raw) as unknown as PersistedPanelResultPublic;
  });
}
