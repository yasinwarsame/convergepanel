/**
 * TEAM-VERIFICATION-PARITY-R5-I1 — Team Video fixtures for the shared
 * in-memory Firestore fake (not a spec file).
 *
 * Reuses the already-reviewed query/sort/startAfter/limit engine, write
 * recorder and Project fixture from `teamClaimFakeFirestore` verbatim: the
 * engine is collection-agnostic, so duplicating it would only risk the two
 * copies drifting. Only the Video ROW fixture is new.
 */

export { FakeTimestamp, FakeFieldPath, fakeFirestoreModule, createFakeState, makeFakeDb, projectDoc, TEAM_W, DOC_ID_SENTINEL } from "./teamClaimFakeFirestore";
export type { FakeDoc, FakeState, RecordedQuery } from "./teamClaimFakeFirestore";

import { FakeTimestamp, TEAM_W, type FakeDoc } from "./teamClaimFakeFirestore";

/**
 * A canonical, valid Team Video row exactly as `saveTeamVideoVerification()`
 * persists one. Overrides may delete a field with `undefined` semantics by
 * passing `{ field: undefined }` only where the test then removes the key —
 * use `teamVideoDocWithout()` for genuine absence.
 */
export function teamVideoDoc(id: string, overrides: Record<string, unknown> = {}, ms = 1_700_000_000_000): FakeDoc {
  return {
    id,
    data: {
      userId: "uploader-a",
      userEmail: "uploader-a@example.com",
      type: "video_verification",
      fileName: `${id}.mp4`,
      verdict: "authentic_captured",
      contentType: "camera_footage",
      consensusScore: 88,
      confidenceLabel: "High",
      evidenceQuality: "strong",
      supportRatio: 88,
      metadata: { duration: 12, width: 1920, height: 1080, codec: "h264", frameRate: 30, fileSize: 1024, format: "mp4", createdAt: null, encodingSoftware: null, hasAudio: true, cameraModel: null },
      metadataAnalysis: { flags: [], summary: "" },
      modelResults: [{ modelId: "chatgpt", modelName: "ChatGPT", status: "ok", verdict: "authentic_captured", confidence: "high", summary: "ok" }],
      agreementPoints: [],
      disagreementPoints: [],
      frameCount: 8,
      warnings: [],
      totalTokens: 1234,
      timestamp: FakeTimestamp.fromMillis(ms),
      workspaceId: TEAM_W,
      projectId: null,
      ...overrides,
    },
  };
}

/** A Team Video row with the named top-level fields genuinely ABSENT. */
export function teamVideoDocWithout(id: string, fields: string[], overrides: Record<string, unknown> = {}, ms = 1_700_000_000_000): FakeDoc {
  const doc = teamVideoDoc(id, overrides, ms);
  for (const f of fields) delete doc.data[f];
  return doc;
}

/** A PERSONAL Video row: no `workspaceId`/`projectId` fields at all. */
export function personalVideoDoc(id: string, overrides: Record<string, unknown> = {}, ms = 1_700_000_000_000): FakeDoc {
  return teamVideoDocWithout(id, ["workspaceId", "projectId"], overrides, ms);
}
