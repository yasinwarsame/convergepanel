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

Your verdict must be one of these five options:

"authentic_captured" — This appears to be real footage captured by a physical 
camera or device. Visual elements are consistent with real-world physics. 
Metadata supports a physical capture device (camera model, creation date, 
standard codec). No significant manipulation indicators.

"authentic_produced" — This appears to be legitimately produced content such 
as animation, motion graphics, promotional material, screen recordings, or 
AI-assisted creative production. The content is NOT attempting to deceive — 
it presents itself as produced/animated content. This includes marketing 
videos, explainer animations, AI-generated art used openly, and professional 
video production.

"likely_manipulated" — This content shows indicators of deceptive manipulation. 
This includes: deepfakes (face swaps on real footage), AI-generated footage 
presented as if it were real camera footage, doctored evidence, altered 
timestamps or metadata to misrepresent origin, or any content where the 
apparent intent is to make the viewer believe something happened that did not.
The key distinction: manipulation implies deceptive intent — the content 
pretends to be something it is not.

"inconclusive" — Cannot determine with confidence. Mixed signals from 
different indicators.

"insufficient" — Not enough data for meaningful analysis.

IMPORTANT DISTINCTION: A video being AI-generated does NOT automatically mean 
it is "likely_manipulated." An AI-generated marketing animation is 
"authentic_produced" — it is what it claims to be. A deepfake of a politician 
saying something they never said is "likely_manipulated" — it pretends to be 
real footage. The difference is deceptive intent, not the presence of AI.

To determine deceptive intent, consider:
- Does the content present itself as real camera footage when it is not?
- Are real people's faces or voices being impersonated?
- Is the metadata fabricated to suggest a real capture device?
- Would a reasonable viewer be misled about what they are seeing?
- Is the style openly artistic/animated (not deceptive) or attempting photorealism (potentially deceptive)?

Respond in this exact JSON format:
{
  "verdict": "authentic_captured" | "authentic_produced" | "likely_manipulated" | "inconclusive" | "insufficient",
  "confidence": "high" | "medium" | "low",
  "contentType": "camera_footage" | "animation" | "screen_recording" | "ai_generated_creative" | "ai_generated_deceptive" | "mixed" | "unknown",
  "summary": "One sentence overall assessment",
  "deceptionIndicators": ["specific signs suggesting deceptive intent, if any"],
  "visualIndicators": ["list of specific visual observations with frame references"],
  "metadataIndicators": ["list of metadata observations"],
  "manipulationSignals": ["specific signs suggesting manipulation, with frame references"],
  "authenticitySignals": ["specific signs supporting authenticity"],
  "productionSignals": ["signs this is legitimately produced content — animation style, motion graphics, consistent branding, professional editing"],
  "compressionNotes": ["observations that could be compression rather than manipulation"],
  "limitations": ["what you cannot determine from these frames alone"],
  "reasoning": "Detailed reasoning for your verdict, specifically addressing whether deceptive intent is present"
}

Return ONLY the JSON object.`;
}
