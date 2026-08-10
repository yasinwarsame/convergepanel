/**
 * Adaptive Research Export, Phase 1 — server-side PDF byte generation.
 * Deterministic, pure function of the frozen `AdaptiveResearchExportV1`
 * snapshot: same input always produces the same bytes (no timestamps
 * beyond what's already frozen in the record, no randomness, no network
 * calls, no remote fonts/images — Part 11). Takes no arguments beyond the
 * snapshot itself — no run/Firestore lookups — so it can never drift onto
 * the current mutable run state.
 *
 * This purity/determinism is exactly what lets Phase 2's regeneration route
 * reproduce byte-identical output from an old, preserved export record
 * without ever having stored the PDF bytes themselves — see
 * `renderAdaptiveResearchExport` below, the version-aware entry point both
 * the creation route (Phase 1) and the regeneration route (Phase 2) call.
 * The PDF bytes are still never durably stored anywhere (see
 * researchExport.ts's `AdaptiveExportArtifactStatus` doc comment): the
 * snapshot is the durable artifact, regeneration just re-derives the PDF
 * from it on demand, every time.
 */

import "server-only";
import { renderToBuffer } from "@react-pdf/renderer";
import { createHash } from "crypto";
import { AdaptiveResearchExportV1 } from "@/lib/adaptiveSchema/researchExport";
import { AdaptiveResearchDocument } from "./AdaptiveResearchDocument";

export interface RenderedAdaptivePdf {
  bytes: Buffer;
  sha256: string;
}

async function renderAdaptiveResearchPdfV1(record: AdaptiveResearchExportV1): Promise<RenderedAdaptivePdf> {
  // renderToBuffer's type signature wants a literal <Document> element, not
  // a wrapper component reference — calling the composer function directly
  // (rather than createElement(AdaptiveResearchDocument, {record})) gives
  // it exactly that.
  const bytes = await renderToBuffer(AdaptiveResearchDocument({ record }));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { bytes, sha256 };
}

/**
 * Adaptive Research Export, Phase 2 — version-aware regeneration dispatch.
 * Historical export records carry their own `version` (the
 * `AdaptiveResearchExportV1` contract's format version, per
 * researchExport.ts's own doc comment — distinct from `reportVersion` and
 * `schemaVersion`). A future contract version must get its own renderer
 * branch here; it must never silently fall through to the V1 renderer just
 * because that happens to be the only one that exists today; an
 * unrecognized version fails loudly rather than guessing at semantics a
 * later contract version might have changed.
 */
export async function renderAdaptiveResearchExport(record: AdaptiveResearchExportV1): Promise<RenderedAdaptivePdf> {
  switch (record.version) {
    case 1:
      return renderAdaptiveResearchPdfV1(record);
    default: {
      const unsupportedVersion: never = record.version;
      throw new Error(`Unsupported AdaptiveResearchExport contract version: ${String(unsupportedVersion)}`);
    }
  }
}
