/**
 * ADAPTIVE_RETRY_CORRECTION — persistence compatibility.
 * - Old persisted adaptive records (no retryOutcome) parse exactly as before.
 * - New records carrying retryOutcome parse and keep it verbatim.
 * - A Team snapshot copies adaptiveRetryUsage with the token aggregates it
 *   was added into (historical data, never recomputed, never re-added).
 */

jest.mock("@/lib/firebase/admin", () => ({ adminDb: null, adminAuth: null, FIREBASE_PROJECT_ID: "test" }));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { Timestamp } from "firebase-admin/firestore";
import { parsePersistedLegacyAdaptiveOutput } from "@/lib/adaptiveSchema/persistedOutput";
import { buildTeamRunSnapshotPayload } from "@/lib/firestore/teamRunSnapshots";

function legacyRecord(results: unknown[]) {
  return {
    version: 1,
    schemaId: "procedural",
    classification: { queryType: "procedural" },
    generatedAt: "2026-10-01T00:00:00.000Z",
    results,
    alignedClaims: [],
  };
}

const OLD_RESULT = { modelId: "claude", schemaId: "procedural", ok: true, data: { steps: [] }, retried: true, latencyMs: 12 };

describe("persisted legacy adaptive output", () => {
  it("an old record (no retryOutcome anywhere) parses to the identical object", () => {
    const raw = legacyRecord([OLD_RESULT, { modelId: "grok", schemaId: "procedural", ok: false, data: null, parseError: "Invalid JSON: x" }]);
    const snapshotBefore = JSON.stringify(raw);
    const parsed = parsePersistedLegacyAdaptiveOutput(raw);
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.output).toBe(raw);
    expect(JSON.stringify(raw)).toBe(snapshotBefore);
    expect(parsed.ok && (parsed.output.results[0] as any).retryOutcome).toBeUndefined();
  });

  it("a new record carrying retryOutcome parses and keeps the value verbatim", () => {
    const raw = legacyRecord([{ ...OLD_RESULT, retryOutcome: "adopted_partial" }]);
    const parsed = parsePersistedLegacyAdaptiveOutput(raw);
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.output.results[0].retryOutcome).toBe("adopted_partial");
  });
});

describe("Team run snapshot", () => {
  const now = Timestamp.fromMillis(1_760_000_000_000);
  const base = {
    question: "Compare A and B",
    createdAt: Timestamp.fromMillis(1_759_000_000_000),
    completedAt: Timestamp.fromMillis(1_759_000_100_000),
    status: "complete",
    runDocument: { runId: "src", userId: "u1", perModel: [] },
    tokenUsage: { byModel: {}, totals: { promptTokens: 130, completionTokens: 79, totalTokens: 209 } },
    totalTokens: 209,
    tokensByModel: { claude: 50, perplexity: 30 },
    tokensByProvider: { anthropic: 80, perplexity: 129 },
  };
  const build = (source: Record<string, unknown>) =>
    buildTeamRunSnapshotPayload({
      source,
      sourceRunId: "src",
      newRunId: "dst",
      uid: "u1",
      workspaceId: "w1",
      projectId: "p1",
      now,
      nowIso: now.toDate().toISOString(),
    });

  it("copies adaptiveRetryUsage verbatim alongside the aggregates it was added into", () => {
    const adaptiveRetryUsage = { schemaVersion: 1, calls: 2, usageUnavailableCalls: 0, totals: { promptTokens: 80, completionTokens: 49, totalTokens: 129 }, byModel: {}, userCounter: "applied" };
    const built = build({ ...base, adaptiveRetryUsage });
    expect(built.ok).toBe(true);
    const payload = (built as { ok: true; payload: Record<string, any> }).payload;
    expect(payload.adaptiveRetryUsage).toBe(adaptiveRetryUsage);
    expect(payload.totalTokens).toBe(209);
    expect(payload.tokensByModel).toEqual({ claude: 50, perplexity: 30 });
    expect(payload.totalTokens).toBe(80 + payload.adaptiveRetryUsage.totals.totalTokens);
  });

  it("a source without retries produces a snapshot without the field", () => {
    const built = build({ ...base, totalTokens: 80 });
    expect(built.ok).toBe(true);
    expect((built as { ok: true; payload: Record<string, any> }).payload).not.toHaveProperty("adaptiveRetryUsage");
  });
});
