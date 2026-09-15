/**
 * ADD-TO-TEAM-PROJECT-C1 — legacy result READ compatibility for
 * `getTeamWorkspaceRun()`.
 *
 * The snapshot writer (`createTeamRunSnapshotFromPersonal()`) deliberately
 * accepts an older complete Personal run that carries top-level legacy
 * `results[]` but no `runDocument`, and copies `results[]` into the Team
 * snapshot. The Team reader must therefore restore such a run through the
 * SAME shared fallback the Personal reader already applies
 * (`publicizePanelResults()`), or a supported source snapshots successfully
 * and then renders as a completed Team report with zero model results.
 *
 * Real `getTeamWorkspaceRun()`, real `publicizePanelResults()`, real
 * `buildTeamRunSnapshotPayload()` — only Firestore is an in-memory fake.
 * M27 target: removing the fallback makes the end-to-end regression fail
 * because the returned results become empty.
 */

import { Timestamp } from "firebase-admin/firestore";
import type { RunDocument } from "@/lib/panel/schemas";

type StoredDoc = { data: Record<string, unknown> };
const runs = new Map<string, StoredDoc>();

const mockAdminDb: any = {
  collection: (name: string) => {
    if (name !== "runs") throw new Error(`unexpected collection ${name}`);
    return {
      doc: (id: string) => ({
        get: async () => {
          const entry = runs.get(id);
          return { exists: entry !== undefined, data: () => entry?.data, id };
        },
      }),
    };
  },
};
jest.mock("@/lib/firebase/admin", () => ({
  get adminDb() {
    return mockAdminDb;
  },
}));
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { getTeamWorkspaceRun } from "@/lib/firestore/teamWorkspaceRuns";
import { buildTeamRunSnapshotPayload } from "@/lib/firestore/teamRunSnapshots";
import { publicizePanelResults } from "@/lib/panel/publicize";

const WS_ID = "ws-team-1";
const PROJECT_ID = "proj-1";
const RUN_ID = "run-detail-1";
const UID = "member-1";
const ts = (s: number) => new Timestamp(s, 0);

function baseRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { userId: UID, workspaceId: WS_ID, projectId: PROJECT_ID, question: "What is the capital of Kenya?", selectedModels: ["chatgpt"], status: "complete", createdAt: ts(1000), completedAt: ts(1001), ...overrides };
}

function runDocument(text = "Nairobi (runDocument)."): RunDocument {
  return {
    runId: RUN_ID,
    userId: UID,
    createdAt: ts(1000),
    question: "What is the capital of Kenya?",
    selectedModels: ["chatgpt"],
    perModel: [{ modelId: "chatgpt", status: "ok", rawTextTruncated: text, latencyMs: 120, tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 }, wasTruncated: false }],
    totals: { promptTokens: 10, completionTokens: 5, reasoningTokens: 0, totalTokens: 15 },
    flags: { storageTruncated: false, synthesisTruncated: false },
  };
}

/** The pre-`runDocument` top-level format older complete Personal runs carry. */
const LEGACY_TEXT = "Nairobi (legacy results).";
const legacyResults = () => [{ modelId: "chatgpt", status: "ok", rawText: LEGACY_TEXT, latencyMs: 90 }];

const read = () => getTeamWorkspaceRun({ workspaceId: WS_ID, projectId: PROJECT_ID, runId: RUN_ID });

beforeEach(() => {
  runs.clear();
});

describe("getTeamWorkspaceRun — completed-run result restoration (C1)", () => {
  it("T1/T8 — a completed run with a valid runDocument (a native Team run) uses runDocument results exactly as before", async () => {
    runs.set(RUN_ID, { data: baseRun({ runDocument: runDocument() }) });
    const r = await read();
    expect(r.status).toBe("complete");
    if (r.status !== "complete") throw new Error("expected complete");
    expect(r.results).toHaveLength(1);
    expect(r.results[0].modelId).toBe("chatgpt");
    expect(r.results[0].rawTextFull).toBe("Nairobi (runDocument).");
  });

  it("T2 — runDocument absent + legacy results present → NON-EMPTY public Team results", async () => {
    runs.set(RUN_ID, { data: baseRun({ results: legacyResults() }) });
    const r = await read();
    if (r.status !== "complete") throw new Error("expected complete");
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.results[0].modelId).toBe("chatgpt");
    expect(r.results[0].status).toBe("ok");
    expect(JSON.stringify(r.results)).toContain(LEGACY_TEXT);
  });

  it("T3 — legacy results are CONVERTED through the shared publicizer, never returned raw", async () => {
    const raw = legacyResults();
    runs.set(RUN_ID, { data: baseRun({ results: raw }) });
    const r = await read();
    if (r.status !== "complete") throw new Error("expected complete");
    expect(r.results[0]).not.toBe(raw[0]);
    // Byte-identical to what the shared publicizer produces for the same rows — one converter, not two.
    expect(JSON.stringify(r.results)).toBe(JSON.stringify(publicizePanelResults(raw)));
    // The publicizer's guarantees are present on the output and absent on the raw row.
    expect(r.results[0].requestedModel).toBeDefined();
    expect((raw[0] as Record<string, unknown>).requestedModel).toBeUndefined();
    // Positive control for "never raw": a malformed legacy row (no modelId) is dropped by the publicizer.
    runs.set(RUN_ID, { data: baseRun({ results: [{ status: "ok", rawText: "no model id" }, ...raw] }) });
    const r2 = await read();
    if (r2.status !== "complete") throw new Error("expected complete");
    expect(r2.results).toHaveLength(1);
  });

  it("T4 — when runDocument yields rows AND legacy results exist, runDocument stays authoritative", async () => {
    runs.set(RUN_ID, { data: baseRun({ runDocument: runDocument(), results: legacyResults() }) });
    const r = await read();
    if (r.status !== "complete") throw new Error("expected complete");
    expect(r.results).toHaveLength(1);
    expect(r.results[0].rawTextFull).toBe("Nairobi (runDocument).");
    expect(JSON.stringify(r.results)).not.toContain(LEGACY_TEXT);
  });

  it("T5 — neither usable runDocument rows nor legacy results → the existing empty-result behavior, still `complete`", async () => {
    runs.set(RUN_ID, { data: baseRun() });
    let r = await read();
    expect(r).toEqual({ status: "complete", runId: RUN_ID, question: "What is the capital of Kenya?", governanceStatus: undefined, results: [], assignee: null });
    // A runDocument with no perModel rows and a non-array `results` is the same.
    runs.set(RUN_ID, { data: baseRun({ runDocument: { ...runDocument(), perModel: [] }, results: "not-an-array" }) });
    r = await read();
    if (r.status !== "complete") throw new Error("expected complete");
    expect(r.results).toEqual([]);
  });

  it("T6 — pending / non-complete semantics are unchanged, even when legacy results are present", async () => {
    for (const status of ["running", "error", "queued"]) {
      runs.set(RUN_ID, { data: baseRun({ status, results: legacyResults() }) });
      const r = await read();
      expect(r).toEqual({ status: "pending", runId: RUN_ID, question: "What is the capital of Kenya?", governanceStatus: undefined, assignee: null });
      expect((r as { results?: unknown }).results).toBeUndefined();
    }
  });

  it("T7 — Workspace/Project containment is unchanged: a legacy-results run in another Workspace or Project is concealed", async () => {
    runs.set(RUN_ID, { data: baseRun({ workspaceId: "ws-other", results: legacyResults() }) });
    expect(await read()).toEqual({ status: "not_found" });
    runs.set(RUN_ID, { data: baseRun({ projectId: "proj-other", results: legacyResults() }) });
    expect(await read()).toEqual({ status: "not_found" });
    runs.set(RUN_ID, { data: baseRun({ projectId: null, results: legacyResults() }) });
    expect(await read()).toEqual({ status: "not_found" });
    // Positive control: the same run in the right Workspace + Project reads complete with results.
    runs.set(RUN_ID, { data: baseRun({ results: legacyResults() }) });
    const r = await read();
    expect(r.status).toBe("complete");
  });
});

describe("END-TO-END — a legacy-results-only Personal source, snapshotted, reads back on the Team detail path (M27 target)", () => {
  it("the destination the snapshot writer builds for such a source yields the model response through the real Team reader", async () => {
    // 1. The supported source shape: complete, Personal-owned, legacy `results[]`, NO runDocument.
    const source = { userId: UID, question: "What is the capital of Kenya?", selectedModels: ["chatgpt"], status: "complete", createdAt: ts(500), completedAt: ts(600), results: legacyResults() };
    expect(Object.prototype.hasOwnProperty.call(source, "runDocument")).toBe(false);

    // 2. The exact destination document the writer would `tx.create()`.
    const built = buildTeamRunSnapshotPayload({ source, sourceRunId: "run-src", newRunId: RUN_ID, uid: UID, workspaceId: WS_ID, projectId: PROJECT_ID, now: ts(900), nowIso: new Date(900_000).toISOString() });
    expect(built.ok).toBe(true);
    if (!built.ok) throw new Error("expected ok");
    expect(built.payload.status).toBe("complete");
    expect(Array.isArray(built.payload.results)).toBe(true);
    expect(built.payload.runDocument).toBeUndefined();
    runs.set(RUN_ID, { data: built.payload });

    // 3. What TeamResearchResultView receives.
    const r = await read();
    expect(r.status).toBe("complete");
    if (r.status !== "complete") throw new Error("expected complete");
    expect(r.results).toHaveLength(1);
    expect(r.results[0].modelId).toBe("chatgpt");
    expect(r.results[0].status).toBe("ok");
    expect(JSON.stringify(r.results)).toContain(LEGACY_TEXT);
  });
});
