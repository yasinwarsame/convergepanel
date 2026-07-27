/**
 * Shared prop contract for adaptive renderers.
 *
 * Every renderHint component (ConsensusMapView, MetricsGridView, ...) takes
 * the same props: the schema that drove the prompts, the classification
 * that selected it, one AdaptiveModelResult per model (ok or parseError),
 * and — for schemas with claim[] fields — the pre-aligned claims matrix.
 */

import {
  AdaptiveModelResult,
  AlignedClaim,
  QueryClassification,
  ResultSchema,
} from "@/lib/adaptiveSchema/types";

export interface AdaptiveRendererProps {
  schema: ResultSchema;
  classification: QueryClassification;
  results: AdaptiveModelResult[];
  /** Present only for schemas with claim[] fields (Phase 4b output). */
  alignedClaims?: AlignedClaim[];
}
