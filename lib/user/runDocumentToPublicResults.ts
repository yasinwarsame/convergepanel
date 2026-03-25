/**
 * Rehydrates panel row data from a compact Firestore `runDocument` into
 * `PanelResultPublic` objects suitable for the main panel UI and synthesis APIs.
 */

import type { RunDocument } from "@/lib/panel/schemas";
import type { PanelResultPublic } from "@/lib/panel/schemas";
import { normalizeModelResultPublic } from "@/lib/panel/normalize";
import { getPanelModelConfig } from "@/lib/panelModels";

export function runDocumentToPublicResults(runDocument: RunDocument | null | undefined): PanelResultPublic[] {
  if (!runDocument?.perModel?.length) return [];

  return runDocument.perModel.map((p) => {
    const cfg = getPanelModelConfig(p.modelId);
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
      requestedModel: p.modelId,
      provider: cfg.provider,
      actualModel: p.modelId,
    };
    return normalizeModelResultPublic(raw as any) as unknown as PanelResultPublic;
  });
}
