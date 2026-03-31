import type { MetadataAnalysis, VideoMetadata } from "./videoPure";

/**
 * Builds the user prompt for each vision model. Structure matches what
 * the `/api/verify-video` route parses: top-level `verdict`, `confidence`, string arrays,
 * and `reasoning`. Frame rate is omitted from the prose when unknown (≤0).
 *
 * @param metadata - Duration, resolution, codec, optional camera/device from container, etc.
 * @param metadataAnalysis - Server-side heuristic flags (severity + field + observation).
 * @param frameCount - Number of JPEG frames the API will attach after this text block.
 */
export function buildVideoVerificationPrompt(
  metadata: VideoMetadata,
  metadataAnalysis: MetadataAnalysis,
  frameCount: number
): string {
  // Final line asks for JSON only (no markdown fences) to reduce parse errors server-side.
  return `You are a video authenticity analyst. You have been given ${frameCount} frames extracted at regular intervals from a video, plus metadata about the video file.

VIDEO METADATA:
- Duration: ${metadata.duration}s
- Resolution: ${metadata.width}x${metadata.height}
- Codec: ${metadata.codec}
- Frame rate: ${metadata.frameRate > 0 ? `${metadata.frameRate}fps` : "Not reported"}
- File size: ${(metadata.fileSize / 1024 / 1024).toFixed(1)}MB
- Format: ${metadata.format}
- Creation date: ${metadata.createdAt || "Not available"}
- Encoding software: ${metadata.encodingSoftware || "Not available"}
- Has audio: ${metadata.hasAudio}
- Camera / device (from container): ${metadata.cameraModel || "Not available"}

METADATA OBSERVATIONS:
${metadataAnalysis.flags.map((f) => `- [${f.severity}] ${f.field}: ${f.observation}`).join("\n") || "No notable observations"}

Analyze the provided frames for signs of AI generation or digital manipulation:

1. VISUAL CONSISTENCY: Are lighting, shadows, and reflections consistent across frames? Do colors and exposure change naturally or abruptly?
2. FACIAL ANALYSIS: If faces are present, do they show artifacts typical of deepfakes (warping, texture anomalies, inconsistent features between frames, uncanny valley effects)?
3. SPATIAL COHERENCE: Do objects, backgrounds, and scene elements maintain physical consistency between frames? Are there warping, morphing, or impossible geometries?
4. TEMPORAL INDICATORS: Based on the frame sequence, do transitions between frames appear natural for the claimed frame rate and duration?
5. GENERATION ARTIFACTS: Are there patterns typical of AI-generated video (repetitive textures, smooth/plastic skin, inconsistent fine details like hair, teeth, fingers, text, reflections)?
6. METADATA CONSISTENCY: Does the metadata support or contradict the visual content?

IMPORTANT GUIDELINES:
- You are NOT performing certified evidence-grade analysis. You are identifying potential indicators and signals.
- Clearly distinguish between STRONG indicators and WEAK/AMBIGUOUS signals.
- Consider that compression artifacts can mimic manipulation artifacts — note this where relevant.
- State your confidence level explicitly.
- Be specific about which frames show which indicators.

Respond in this exact JSON format:
{
  "verdict": "authentic" | "likely_manipulated" | "inconclusive" | "insufficient",
  "confidence": "high" | "medium" | "low",
  "summary": "One sentence overall assessment",
  "visualIndicators": ["list of specific visual observations with frame references"],
  "metadataIndicators": ["list of metadata observations"],
  "manipulationSignals": ["specific signs suggesting manipulation, with frame references"],
  "authenticitySignals": ["specific signs supporting authenticity"],
  "compressionNotes": ["observations that could be compression rather than manipulation"],
  "limitations": ["what you cannot determine from these frames alone"],
  "reasoning": "Detailed reasoning for your verdict"
}

Return ONLY the JSON object.`;
}
