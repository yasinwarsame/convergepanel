/**
 * Barrel module: re-exports pure video verification helpers from `videoPure.ts`.
 *
 * Import from here when you need types or metadata analysis without pulling in client-only modules
 * (`extractFramesClient`, `extractFileMetadata`) or server vision callers. No ffmpeg or WASM.
 */

export type { VideoMetadata, MetadataAnalysis, MetadataFlag, ExtractedFrame } from "./videoPure";
export { analyzeMetadata, computeFrameTimestamps } from "./videoPure";
