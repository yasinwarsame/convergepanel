/**
 * Adaptive Research Export, Phase 1 — server-side PDF byte generation.
 * Deterministic, pure function of the frozen `AdaptiveResearchExportV1`
 * snapshot: same input always produces the same bytes (no timestamps
 * beyond what's already frozen in the record, no randomness, no network
 * calls, no remote fonts/images — Part 11). Takes no arguments beyond the
 * snapshot itself — no run/Firestore lookups — so it can never drift onto
 * the current mutable run state.
 *
 * This purity/determinism is what would let a FUTURE render-from-snapshot
 * endpoint reproduce byte-identical output from an old, preserved export
 * record without ever having stored the PDF bytes themselves. Phase 1 does
 * not build that endpoint — the only caller today is the single POST
 * export route, which always renders from a snapshot it just built from
 * the current run. Do not describe this as an already-implemented
 * "redownload"/"regenerate a past export" capability; it isn't one yet
 * (see researchExport.ts's `AdaptiveExportArtifactStatus` doc comment for
 * the precise Phase 1 guarantee: the snapshot is the durable artifact, the
 * PDF bytes are not).
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
