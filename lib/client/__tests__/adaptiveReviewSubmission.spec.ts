/**
 * Query-Routing Redesign, Phase 2A, Step 7, Part E2 —
 * submitAdaptiveReviewDecision() tests. `postJson` is injected, so this
 * exercises the full submission/response-mapping logic without mocking
 * Firebase auth or rendering any component.
 */

import { submitAdaptiveReviewDecision, PostJsonResponseLike } from "@/lib/client/adaptiveReviewSubmission";
import type { AdaptiveReviewDecisionRequest } from "@/lib/governance/adaptiveReviewFormContract";

const REQUEST: AdaptiveReviewDecisionRequest = {
  status: "approved",
  expectedUpdatedAt: "2026-07-30T00:00:00.000Z",
};

function fakeResponse(status: number, body: unknown, ok = status >= 200 && status < 300): PostJsonResponseLike {
  return { ok, status, json: async () => body };
}

describe("submitAdaptiveReviewDecision", () => {
  it("posts to the correct endpoint exactly once, with the given request", async () => {
    const postJson = jest.fn().mockResolvedValue(fakeResponse(200, { ok: true, review: { status: "approved", reviewedAt: "x" }, projectionSyncStatus: "synced" }));
    await submitAdaptiveReviewDecision({ runId: "run-1", request: REQUEST, postJson });
    expect(postJson).toHaveBeenCalledTimes(1);
    expect(postJson).toHaveBeenCalledWith("/api/teams/adaptive-runs/run-1/decision", REQUEST);
  });

  it("maps a successful response", async () => {
    const postJson = jest
      .fn()
      .mockResolvedValue(fakeResponse(200, { ok: true, review: { status: "approved", reviewedAt: "2026-07-30T01:00:00.000Z" }, projectionSyncStatus: "synced" }));
    const result = await submitAdaptiveReviewDecision({ runId: "run-1", request: REQUEST, postJson });
    expect(result).toEqual({ kind: "success", status: "approved", reviewedAt: "2026-07-30T01:00:00.000Z", projectionSyncStatus: "synced" });
  });

  it("maps a successful response with projectionSyncStatus 'failed' as still a success", async () => {
    const postJson = jest
      .fn()
      .mockResolvedValue(fakeResponse(200, { ok: true, review: { status: "approved", reviewedAt: "x" }, projectionSyncStatus: "failed" }));
    const result = await submitAdaptiveReviewDecision({ runId: "run-1", request: REQUEST, postJson });
    expect(result).toEqual({ kind: "success", status: "approved", reviewedAt: "x", projectionSyncStatus: "failed" });
  });

  it("maps 409 stale_expected_updated_at to 'stale'", async () => {
    const postJson = jest.fn().mockResolvedValue(fakeResponse(409, { ok: false, error: { code: "stale_expected_updated_at", message: "x" } }));
    const result = await submitAdaptiveReviewDecision({ runId: "run-1", request: REQUEST, postJson });
    expect(result).toEqual({ kind: "stale" });
  });

  it("maps 409 terminal_review_exists to 'terminal'", async () => {
    const postJson = jest.fn().mockResolvedValue(fakeResponse(409, { ok: false, error: { code: "terminal_review_exists", message: "x" } }));
    const result = await submitAdaptiveReviewDecision({ runId: "run-1", request: REQUEST, postJson });
    expect(result).toEqual({ kind: "terminal" });
  });

  it("maps 401 to unauthenticated, 403 to forbidden, 404 to not_found", async () => {
    const u = await submitAdaptiveReviewDecision({ runId: "r", request: REQUEST, postJson: async () => fakeResponse(401, {}) });
    expect(u).toEqual({ kind: "unauthenticated" });
    const f = await submitAdaptiveReviewDecision({ runId: "r", request: REQUEST, postJson: async () => fakeResponse(403, {}) });
    expect(f).toEqual({ kind: "forbidden" });
    const n = await submitAdaptiveReviewDecision({ runId: "r", request: REQUEST, postJson: async () => fakeResponse(404, {}) });
    expect(n).toEqual({ kind: "not_found" });
  });

  it("maps 400 to validation_error", async () => {
    const result = await submitAdaptiveReviewDecision({ runId: "r", request: REQUEST, postJson: async () => fakeResponse(400, { ok: false, error: { code: "validation_error" } }) });
    expect(result).toEqual({ kind: "validation_error" });
  });

  it("maps 500 to server_error", async () => {
    const result = await submitAdaptiveReviewDecision({ runId: "r", request: REQUEST, postJson: async () => fakeResponse(500, {}) });
    expect(result).toEqual({ kind: "server_error" });
  });

  it("maps 503 to unavailable", async () => {
    const result = await submitAdaptiveReviewDecision({ runId: "r", request: REQUEST, postJson: async () => fakeResponse(503, {}) });
    expect(result).toEqual({ kind: "unavailable" });
  });

  it("maps a thrown network error to network_error, never assuming failure vs success", async () => {
    const postJson = jest.fn().mockRejectedValue(new Error("network down"));
    const result = await submitAdaptiveReviewDecision({ runId: "r", request: REQUEST, postJson });
    expect(result).toEqual({ kind: "network_error" });
  });

  it("maps an unreadable response body to server_error, never throwing", async () => {
    const postJson = jest.fn().mockResolvedValue({ ok: false, status: 500, json: async () => { throw new Error("bad json"); } });
    const result = await submitAdaptiveReviewDecision({ runId: "r", request: REQUEST, postJson });
    expect(result).toEqual({ kind: "server_error" });
  });

  it("never retries — exactly one postJson call even on failure", async () => {
    const postJson = jest.fn().mockResolvedValue(fakeResponse(500, {}));
    await submitAdaptiveReviewDecision({ runId: "r", request: REQUEST, postJson });
    expect(postJson).toHaveBeenCalledTimes(1);
  });
});
