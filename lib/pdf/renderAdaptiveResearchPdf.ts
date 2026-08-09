/**
 * Adaptive Research Export, Phase 1 — server-side PDF byte generation.
 * Deterministic, pure function of the frozen `AdaptiveResearchExportV1`
 * snapshot: same input always produces the same bytes (no timestamps
 * beyond what's already frozen in the record, no randomness, no network
 * calls, no remote fonts/images — Part 11). This determinism is what lets
 * "redownload" work without persisting the PDF bytes anywhere (Phase 1's
 * storage decision, see researchExport.ts's header comment): the snapshot
 * IS the durable artifact; the PDF is always reproducible from it.
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

export async function renderAdaptiveResearchPdf(record: AdaptiveResearchExportV1): Promise<RenderedAdaptivePdf> {
  // renderToBuffer's type signature wants a literal <Document> element, not
  // a wrapper component reference — calling the composer function directly
  // (rather than createElement(AdaptiveResearchDocument, {record})) gives
  // it exactly that.
  const bytes = await renderToBuffer(AdaptiveResearchDocument({ record }));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { bytes, sha256 };
}
