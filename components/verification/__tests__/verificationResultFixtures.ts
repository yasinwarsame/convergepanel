/**
 * TEAM-VERIFICATION-PARITY-R2 — shared stored-result fixtures for the Claim and
 * Video verification presentation suites (not a spec file).
 */

import type { ClaimVerificationClientPayload } from "@/lib/verification/claimVerificationClientPayload";
import type { VideoVerificationClientPayload } from "@/lib/verification/videoVerificationClientPayload";

export function claimFixture(over: Partial<ClaimVerificationClientPayload> = {}): ClaimVerificationClientPayload {
  return {
    verificationId: "vcl-fixture-1",
    claim: "The Eiffel Tower was completed in 1889.",
    verdict: "confirmed",
    consensusScore: 88,
    confidenceLabel: "High",
    evidenceQuality: "strong",
    supportRatio: 0.8,
    modelEvidence: [
      { modelId: "chatgpt", status: "ok", verdict: "accurate", confidence: "high", summary: "Completed March 1889.", correctParts: ["1889 completion"], incorrectParts: [], unverifiableParts: [] },
      { modelId: "claude", status: "ok", verdict: "partially_accurate", confidence: "medium", summary: "Opened to the public in May 1889.", correctParts: ["year"], incorrectParts: ["exact month"], unverifiableParts: ["attendance"] },
    ],
    aggregateSummary: { totalModels: 2, modelsAgreeAccurate: 1, modelsAgreeInaccurate: 0, modelsPartial: 1, modelsUnverifiable: 0 },
    whereModelsAgree: ["Completion year is 1889"],
    whereModelsDisagree: [{ point: "Opening month", models: ["claude"] }],
    auditBundle: {
      version: "1",
      kind: "claim_verification",
      claimCharCount: 40,
      modelCount: 2,
      verdict: "confirmed",
      consensusScore: 88,
      confidenceLabel: "High",
      evidenceQuality: "strong",
      perModel: [
        { modelId: "chatgpt", pipelineStatus: "ok", verdictLabel: "accurate", confidence: "high", summaryLength: 21, counts: { correct: 1, incorrect: 0, unverifiable: 0 } },
        { modelId: "claude", pipelineStatus: "parse_error", verdictLabel: null, confidence: null, summaryLength: 0, counts: { correct: 0, incorrect: 0, unverifiable: 0 } },
      ],
      generatedAt: "2026-09-10T12:00:00.000Z",
    } as ClaimVerificationClientPayload["auditBundle"],
    accurateAmongUsable: 1,
    usableModelCount: 2,
    governanceStatus: "needs_review",
    ...over,
  };
}

export function videoFixture(over: Partial<VideoVerificationClientPayload> = {}): VideoVerificationClientPayload {
  return {
    verificationId: "vid-fixture-1",
    fileName: "harbour-clip.mp4",
    verdict: "authentic_captured",
    contentType: "camera_footage",
    consensusScore: 91,
    confidenceLabel: "High",
    evidenceQuality: "strong",
    supportRatio: 100,
    metadata: {
      duration: 12.4,
      width: 1920,
      height: 1080,
      codec: "h264",
      frameRate: 30,
      fileSize: 5_242_880,
      format: "mp4",
      createdAt: "2026-08-01T00:00:00.000Z",
      encodingSoftware: "iPhone",
      hasAudio: true,
      cameraModel: "iPhone 16 Pro",
    } as VideoVerificationClientPayload["metadata"],
    metadataAnalysis: { flags: [{ field: "encodingSoftware", observation: "Consumer phone encoder", severity: "info" }], summary: "Consistent." } as VideoVerificationClientPayload["metadataAnalysis"],
    modelEvidence: [
      { modelId: "chatgpt", modelName: "GPT", status: "ok", verdict: "authentic_captured", confidence: "high", summary: "Natural motion blur.", visualIndicators: ["motion blur"], metadataIndicators: ["phone encoder"], manipulationSignals: [], authenticitySignals: ["sensor noise"], productionSignals: [], deceptionIndicators: [], compressionNotes: ["mild"], limitations: ["short clip"] },
      { modelId: "gemini", modelName: "Gemini", status: "refused", verdict: "inconclusive", confidence: "low", summary: "", visualIndicators: [], metadataIndicators: [], manipulationSignals: [], authenticitySignals: [], compressionNotes: [], limitations: [] },
    ],
    agreementPoints: ["Camera capture"],
    disagreementPoints: ["Lighting source"],
    frameCount: 12,
    warnings: ["One model declined"],
    governanceStatus: "needs_review",
    timestampIso: "2026-09-10T12:00:00.000Z",
    ...over,
  };
}
