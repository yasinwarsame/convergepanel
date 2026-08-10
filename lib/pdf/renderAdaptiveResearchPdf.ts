/**
 * Adaptive Research Export — server-side PDF byte generation.
 * Deterministic, pure function of the frozen `AdaptiveResearchExportV1`
 * snapshot: same input always produces the same bytes (no timestamps
 * beyond what's already frozen in the record, no randomness, no network
 * calls, no remote fonts/images — Part 11). Takes no arguments beyond the
 * snapshot itself — no run/Firestore lookups — so it can never drift onto
 * the current mutable run state.
 *
 * This purity/determinism is exactly what lets Phase 2's regeneration route
 * reproduce byte-identical output from an old, preserved export record
 * without ever having stored the PDF bytes themselves. The PDF bytes are
 * still never durably stored anywhere (see researchExport.ts's
 * `AdaptiveExportArtifactStatus` doc comment): the snapshot is the durable
 * artifact, regeneration just re-derives the file from it on demand, every
 * time.
 *
 * `renderAdaptiveResearchExport` below is the shared, version-AND-format
 * -aware entry point every caller uses (the PDF-only Phase 1 creation
 * route, the Phase 2 regeneration route, and Phase 3's now-format-aware
 * creation route) — kept in this file (not moved to a new "neutral"
 * location) purely to avoid rewiring every existing caller's import path;
 * its role is genuinely format-agnostic despite the filename.
 */

import "server-only";
import { renderToBuffer } from "@react-pdf/renderer";
import { createHash } from "crypto";
import { AdaptiveResearchExportV1 } from "@/lib/adaptiveSchema/researchExport";
import { AdaptiveResearchDocument } from "./AdaptiveResearchDocument";
import { renderAdaptiveResearchDocxV1 } from "@/lib/docx/renderAdaptiveResearchDocx";

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
 * Adaptive Research Export, Phase 2/3 — version-AND-format-aware
 * regeneration dispatch. Historical export records carry their own
 * `version` (the `AdaptiveResearchExportV1` contract's format version, per
 * researchExport.ts's own doc comment — distinct from `format`,
 * `reportVersion`, and `schemaVersion`). A future contract version must
 * get its own dispatch branch here; it must never silently fall through
 * to the V1 renderers just because those happen to be the only ones that
 * exist today. Within a supported contract version, `format` selects
 * which renderer runs — `"pdf"` and `"docx"` are two independent, equally
 * first-class outputs of the SAME frozen `reportSnapshot`, never one
 * falling back to the other. Both unrecognized contract versions and
 * unrecognized formats fail loudly rather than guessing at semantics a
 * later value might have changed.
 */
export async function renderAdaptiveResearchExport(record: AdaptiveResearchExportV1): Promise<RenderedAdaptivePdf> {
  switch (record.version) {
    case 1:
      switch (record.format) {
        case "pdf":
          return renderAdaptiveResearchPdfV1(record);
        case "docx":
          return renderAdaptiveResearchDocxV1(record);
        default: {
          const unsupportedFormat: never = record.format;
          throw new Error(`Unsupported AdaptiveResearchExport format: ${String(unsupportedFormat)}`);
        }
      }
    default: {
      const unsupportedVersion: never = record.version;
      throw new Error(`Unsupported AdaptiveResearchExport contract version: ${String(unsupportedVersion)}`);
    }
  }
}
