/**
 * TEAM-VERIFICATION-PARITY-R5-I3-A §G/§H — the transport-neutral contract
 * between the shared Video uploader surface and whoever submits its output.
 *
 * The surface owns everything that happens in the BROWSER before any network
 * call: file selection and validation, preview, frame extraction, file-metadata
 * extraction, legal acknowledgement, quota presentation and progress. What it
 * produces is a `PreparedVideoUpload` — a description of the prepared video and
 * nothing else.
 *
 * WHAT DELIBERATELY DOES NOT LIVE HERE: `workspaceId`, `projectId`, a uid, a
 * token, an endpoint, capabilities, a plan or a quota. Those are transport and
 * authorization concerns owned by the wrapper that submits. Keeping them out is
 * what lets one surface serve Personal Video today and Team Video in R5-I3-B
 * without the surface ever learning which endpoint it is feeding — and it is
 * what makes "the shared surface names no endpoint" a mechanically checkable
 * property rather than a convention.
 *
 * Pure types: no React, no network, no storage, no Firebase.
 */

import type { ClientExtractedFrame } from "@/lib/video/extractFramesClient";

/**
 * Browser-reported video metadata, enriched with what the container parse
 * recovered. This is exactly the shape today's Personal uploader already sends
 * as `metadata`; it is named here rather than redefined.
 */
export type PreparedVideoMetadata = {
  duration: number;
  width: number;
  height: number;
  fileSize: number;
  fileName: string;
  fileType: string;
  /** From the container parse; `"unknown"` when it could not be determined. */
  codec: string;
  hasAudio: boolean;
  createdAt: string | null;
  encodingSoftware: string | null;
  cameraModel: string | null;
};

/** Everything the browser prepared, and nothing about where it is going. */
export type PreparedVideoUpload = {
  /** The locally selected file's name — never a server-supplied value. */
  fileName: string;
  frames: ClientExtractedFrame[];
  metadata: PreparedVideoMetadata;
  /** Non-fatal extraction issues, surfaced to the API and the UI. */
  warnings: string[];
};

/**
 * The result of a submission attempt, in transport-neutral terms.
 *
 * `outcome_unknown` exists from the start so R5-I3-B can adopt the Team
 * mutation-safety posture — a provider-spending POST whose outcome cannot be
 * proven must never be silently retried — without a second presentation
 * rewrite. Personal transport does NOT begin producing it in I3-A: today's
 * Personal uploader shows its existing retryable error copy for those cases,
 * and that behaviour is frozen.
 */
export type VideoUploadSubmitOutcome<TSuccess> =
  /** The transport proved the mutation succeeded. */
  | { status: "ok"; value: TSuccess }
  /** The transport proved a definite rejection, and supplies safe presentation copy. */
  | { status: "rejected"; message: string; showUpgrade?: boolean }
  /**
   * The transport CANNOT prove whether the mutation completed. The surface must
   * neither resubmit nor discard the selection: the user has to be told to check
   * before trying again.
   */
  | { status: "outcome_unknown" };

/** The submit callback a wrapper supplies to the shared surface. */
export type SubmitPreparedVideo<TSuccess> = (prepared: PreparedVideoUpload) => Promise<VideoUploadSubmitOutcome<TSuccess>>;
