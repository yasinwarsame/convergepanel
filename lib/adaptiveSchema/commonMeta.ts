/**
 * Common response envelope builder (query-routing redesign, Milestone 1).
 *
 * Client-safe (no "server-only") — routeClassifiedQuery.ts calls this from
 * code that must also run in AdaptivePanelResponse.tsx (a client component).
 */

import { CommonResponseMeta, QueryClassification, QueryType, AnswerShape } from "./types";

export function buildCommonMeta(params: {
  classification: QueryClassification;
  queryType: QueryType;
  answerShape: AnswerShape;
  dataBasis: CommonResponseMeta["dataBasis"];
  evidenceQuality: CommonResponseMeta["evidenceQuality"];
  uncertainties?: string[];
  blindSpots?: string[];
  humanReviewNeeded?: boolean;
  consensusSummary?: string;
  disagreementSummary?: string;
  recommendedNextAction?: string;
}): CommonResponseMeta {
  return {
    schemaVersion: 2,
    queryType: params.queryType,
    answerShape: params.answerShape,
    dataBasis: params.dataBasis,
    freshness: params.classification.freshness,
    riskLevel: params.classification.riskLevel,
    evidenceQuality: params.evidenceQuality,
    consensusSummary: params.consensusSummary,
    disagreementSummary: params.disagreementSummary,
    uncertainties: params.uncertainties ?? [],
    blindSpots: params.blindSpots ?? [],
    humanReviewNeeded: params.humanReviewNeeded ?? false,
    recommendedNextAction: params.recommendedNextAction,
    generatedAt: new Date().toISOString(),
  };
}
