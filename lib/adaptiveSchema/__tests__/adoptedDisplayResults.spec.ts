/**
 * Order 40 C — unit contract of the adopted display-results record (lib/adaptiveSchema/adoptedDisplayResults.ts):
 * the builder's origins, outcomes and bounds; the strict reader's binding and validation; the Firestore size rules.
 * The end-to-end chain (model → retry → writer → authenticated read → render) is
 * components/research/__tests__/adoptedRetryPersistence.spec.tsx.
 */
jest.mock("@/lib/logger", () => ({ logger: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import {
  ADAPTIVE_DISPLAY_RECORD_MAX_BYTES,
  ADAPTIVE_DISPLAY_RESULTS_FIELD,
  ADAPTIVE_DISPLAY_SLOT_MAX_BYTES,
  buildAdaptiveDisplayResultsRecord,
  firestoreDocumentBytes,
  firestoreFieldBytes,
  firestoreValueBytes,
  readAdoptedDisplayResults,
  sameJsonValue,
  type AdaptiveDisplayResultsV1,
} from "@/lib/adaptiveSchema/adoptedDisplayResults";
import { SCHEMA_REGISTRY } from "@/lib/adaptiveSchema/schemaRegistry";
import { validateAdaptiveResponse } from "@/lib/adaptiveSchema/validator";
import { mergeAdaptiveRetry, ADAPTIVE_RETRY_OUTCOMES } from "@/lib/adaptiveSchema/retryCorrection";
import type { AdaptiveModelResult } from "@/lib/adaptiveSchema/types";
import { reconstructModelResults } from "@/lib/adaptiveSchema/reconstructModelResults";

const schema = SCHEMA_REGISTRY.comparison_matrix;
const RUN = "run-abc";
const roundTrip = <T,>(v: T): T => JSON.parse(JSON.stringify(v));

const answer = (who: string, extra: Record<string, unknown> = {}) => ({
  cells: [
    { subject: "Carbon Taxes", attribute: "Effectiveness", value: `${who} high`, verdict: "better" },
    { subject: "Regulatory Standards", attribute: "Effectiveness", value: `${who} moderate`, verdict: "worse" },
  ],
  directConclusion: `${who}: carbon pricing leads.`,
  tradeoffs: [`${who}: politically harder.`],
  bestUseRecommendations: [`${who}: when price certainty matters.`],
  uncertainties: [],
  ...extra,
});
const validated = (modelId: string, v: unknown): AdaptiveModelResult => validateAdaptiveResponse(modelId as never, schema, typeof v === "string" ? v : JSON.stringify(v), { silent: true });
const panelRow = (modelId: string, status = "ok") => ({ modelId, status });

function build(rows: { modelId: string; status: string }[], adaptive: AdaptiveModelResult[], maxRecordBytes?: number) {
  const out = buildAdaptiveDisplayResultsRecord({ runId: RUN, schemaId: "comparison_matrix", panelResults: rows, adaptiveResults: adaptive, maxRecordBytes });
  if (!out.ok) throw new Error(`not built: ${out.reason}`);
  return out;
}
const read = (raw: unknown, rows: { modelId: string; status: string }[], runId = RUN, schemaId = "comparison_matrix") =>
  readAdoptedDisplayResults(raw, { runId, schemaId, rows });

describe("builder — origin and the recorded retry outcome", () => {
  it("records each slot's origin from the live retryOutcome, and the outcome itself, using only the existing enum", () => {
    const first = validated("claude", "not json");
    const full = mergeAdaptiveRetry(first, validated("claude", answer("Retry"))).result;
    const partialFirst = validated("grok", answer("GrokFirst", { directConclusion: 7 }));
    expect(partialFirst.ok).toBe(true);
    expect(partialFirst.invalidFields).toEqual(["directConclusion"]);
    const partial = mergeAdaptiveRetry(partialFirst, validated("grok", answer("GrokRetry"))).result;
    const rows = ["chatgpt", "claude", "grok", "perplexity", "gemini", "deepseek"].map((m) => panelRow(m));
    const adaptive: AdaptiveModelResult[] = [
      validated("chatgpt", answer("ChatGPT")),
      full,
      partial,
      { ...validated("perplexity", "not json"), retryOutcome: "failed_call" },
      { ...validated("gemini", answer("GeminiFirst", { directConclusion: 7 })), retried: true, retryOutcome: "no_change" },
      { ...validated("deepseek", "not json"), retryOutcome: "skipped_budget" },
    ];
    const { record } = build(rows, adaptive);
    const slot = (m: string) => record.bySlot[m] as any;
    expect([slot("chatgpt").origin, slot("chatgpt").retryOutcome]).toEqual(["original_accepted", null]);
    expect([slot("claude").origin, slot("claude").retryOutcome]).toEqual(["retry_adopted_full", "adopted_full"]);
    expect([slot("grok").origin, slot("grok").retryOutcome]).toEqual(["retry_adopted_partial", "adopted_partial"]);
    expect(slot("grok").data.directConclusion).toBe("GrokRetry: carbon pricing leads.");
    expect(slot("grok").data.cells[0].value).toBe("GrokFirst high");
    expect(slot("perplexity")).toEqual({ availability: "unavailable", reason: "no_validated_data", slotIndex: 3, executedStatus: "ok", retryOutcome: "failed_call" });
    // retry attempted, not adopted: the first answer's validated data stands, and the outcome says so.
    expect([slot("gemini").origin, slot("gemini").retryOutcome]).toEqual(["original_accepted", "no_change"]);
    expect(slot("deepseek")).toEqual({ availability: "unavailable", reason: "no_validated_data", slotIndex: 5, executedStatus: "ok", retryOutcome: "skipped_budget" });
    for (const s of Object.values(record.bySlot) as any[]) {
      if (s.retryOutcome !== null && s.retryOutcome !== undefined) expect(ADAPTIVE_RETRY_OUTCOMES).toContain(s.retryOutcome);
    }
  });

  it("data is the slot's own validated data (a fresh copy), never an aggregate", () => {
    const r = validated("chatgpt", answer("ChatGPT"));
    const { record } = build([panelRow("chatgpt")], [r]);
    expect((record.bySlot.chatgpt as any).data).toEqual(r.data);
    expect((record.bySlot.chatgpt as any).data).not.toBe(r.data);
  });

  it("holds only the contract's keys: no text, prompt, parse error, coercion, latency or token field", () => {
    const r = { ...validated("chatgpt", answer("ChatGPT")), latencyMs: 9, parseError: "secret", coercions: [{ field: "x" }] } as unknown as AdaptiveModelResult;
    const { record } = build([panelRow("chatgpt")], [r]);
    expect(Object.keys(record).sort()).toEqual(["bySlot", "runId", "schemaId", "schemaVersion"]);
    expect(Object.keys(record.bySlot.chatgpt).sort()).toEqual(["availability", "data", "executedStatus", "origin", "retryOutcome", "slotIndex"]);
    expect(JSON.stringify(record)).not.toMatch(/secret|latency|coercion|token/i);
  });

  it("a slot that did not answer, or answered without validated data, is unavailable — never synthesized", () => {
    const { record } = build(
      [panelRow("chatgpt", "timeout"), panelRow("claude", "error"), panelRow("grok", "ok")],
      [validated("chatgpt", null as never), validated("claude", null as never), { ...validated("grok", "{}"), retryOutcome: "failed_call" }]
    );
    expect(record.bySlot.chatgpt).toEqual({ availability: "unavailable", reason: "no_validated_data", slotIndex: 0, executedStatus: "timeout", retryOutcome: null });
    expect(record.bySlot.claude).toEqual({ availability: "unavailable", reason: "no_validated_data", slotIndex: 1, executedStatus: "error", retryOutcome: null });
    expect((record.bySlot.grok as any).availability).toBe("unavailable");
  });

  it("a slot whose recorded status is not an answer never carries data, even if an adaptive result claims some", () => {
    for (const status of ["error", "timeout", "refused", "rate_limited", "unknown_status"]) {
      const { record } = build([panelRow("chatgpt", status)], [validated("chatgpt", answer("x"))]);
      expect(record.bySlot.chatgpt).toMatchObject({ availability: "unavailable", reason: "no_validated_data" });
      expect("data" in record.bySlot.chatgpt).toBe(false);
    }
  });

  it("a substituted slot keeps its status; its ineligible retry outcome is recorded", () => {
    const { record } = build([panelRow("claude", "substituted")], [{ ...validated("claude", answer("DeepSeek")) }]);
    expect(record.bySlot.claude).toMatchObject({ availability: "available", executedStatus: "substituted", origin: "original_accepted", retryOutcome: null });
    const { record: r2 } = build([panelRow("claude", "substituted")], [{ ...validated("claude", "x"), retryOutcome: "ineligible_substituted" }]);
    expect(r2.bySlot.claude).toMatchObject({ availability: "unavailable", reason: "no_validated_data", retryOutcome: "ineligible_substituted" });
  });

  it("a duplicated slot id is marked once as duplicate_slot and never carries data", () => {
    const { record } = build([panelRow("claude"), panelRow("claude"), panelRow("grok")], [validated("claude", answer("A")), validated("claude", answer("B")), validated("grok", answer("G"))]);
    expect(record.bySlot.claude).toEqual({ availability: "unavailable", reason: "duplicate_slot" });
    expect((record.bySlot.grok as any).slotIndex).toBe(2);
  });

  it("refuses to build when the slots cannot be bound (length or id mismatch) or the schema is unknown", () => {
    const r = validated("chatgpt", answer("x"));
    expect(buildAdaptiveDisplayResultsRecord({ runId: RUN, schemaId: "comparison_matrix", panelResults: [panelRow("chatgpt"), panelRow("claude")], adaptiveResults: [r] })).toEqual({ ok: false, reason: "slot_mismatch" });
    expect(buildAdaptiveDisplayResultsRecord({ runId: RUN, schemaId: "comparison_matrix", panelResults: [panelRow("claude")], adaptiveResults: [r] })).toEqual({ ok: false, reason: "slot_mismatch" });
    expect(buildAdaptiveDisplayResultsRecord({ runId: "", schemaId: "comparison_matrix", panelResults: [panelRow("chatgpt")], adaptiveResults: [r] })).toEqual({ ok: false, reason: "slot_mismatch" });
    expect(buildAdaptiveDisplayResultsRecord({ runId: RUN, schemaId: "not_a_schema", panelResults: [panelRow("chatgpt")], adaptiveResults: [r] })).toEqual({ ok: false, reason: "unsupported_schema" });
  });

  it("data Firestore cannot store faithfully is omitted as unsupported_value, never coerced", () => {
    const base = validated("chatgpt", answer("x"));
    for (const bad of [{ cells: [[1, 2]] }, { directConclusion: Number.NaN }, { directConclusion: new Date() }, { tradeoffs: [undefined] }]) {
      const { record } = build([panelRow("chatgpt")], [{ ...base, data: { ...base.data, ...bad } as never }]);
      expect(record.bySlot.chatgpt).toMatchObject({ availability: "unavailable", reason: "unsupported_value" });
    }
  });

  it("is deterministic", () => {
    const rows = [panelRow("chatgpt"), panelRow("claude")];
    const adaptive = [validated("chatgpt", answer("x")), validated("claude", answer("y"))];
    expect(build(rows, adaptive).record).toEqual(build(rows, adaptive).record);
  });
});

describe("builder — size bounds (omit and mark, never truncate)", () => {
  const big = (n: number) => ({ ...answer("x"), tradeoffs: Array.from({ length: n }, (_, i) => `t${i} ${"w".repeat(40)}`) });

  it("a slot over the per-slot bound is omitted as size_limit; smaller slots are kept whole", () => {
    // tradeoffs is capped by maxItems in the validator, so the per-slot bound is exercised with an oversized data value.
    const ok = validated("chatgpt", answer("x"));
    const huge = { ...ok, data: { ...ok.data, directConclusion: "z".repeat(ADAPTIVE_DISPLAY_SLOT_MAX_BYTES) } } as AdaptiveModelResult;
    const out = build([panelRow("chatgpt"), panelRow("claude")], [huge, validated("claude", answer("y"))]);
    expect(out.record.bySlot.chatgpt).toEqual({ availability: "unavailable", reason: "size_limit", slotIndex: 0, executedStatus: "ok", retryOutcome: null });
    expect(out.record.bySlot.claude).toMatchObject({ availability: "available" });
    expect((out.record.bySlot.claude as any).data).toEqual(validated("claude", answer("y")).data);
    expect(out.omittedForSize).toBe(1);
    void big;
  });

  it("the exact per-slot boundary: an entry of exactly the bound is kept; one byte more is omitted", () => {
    const ok = validated("chatgpt", answer("x"));
    const sized = (len: number) => ({ ...ok, data: { ...ok.data, directConclusion: "z".repeat(len) } }) as AdaptiveModelResult;
    const entryBytes = (len: number) => firestoreFieldBytes("chatgpt", (build([panelRow("chatgpt")], [sized(len)], ADAPTIVE_DISPLAY_RECORD_MAX_BYTES * 4).record.bySlot.chatgpt));
    // Find the length whose available entry is exactly the bound.
    const probe = 1000;
    const atProbe = entryBytes(probe);
    const exact = probe + (ADAPTIVE_DISPLAY_SLOT_MAX_BYTES - atProbe);
    expect(firestoreFieldBytes("chatgpt", { availability: "available", slotIndex: 0, executedStatus: "ok", origin: "original_accepted", retryOutcome: null, data: sized(exact).data })).toBe(ADAPTIVE_DISPLAY_SLOT_MAX_BYTES);
    expect(build([panelRow("chatgpt")], [sized(exact)]).record.bySlot.chatgpt.availability).toBe("available");
    expect(build([panelRow("chatgpt")], [sized(exact + 1)]).record.bySlot.chatgpt).toMatchObject({ availability: "unavailable", reason: "size_limit" });
  });

  it("the record budget: slots are admitted in order until the budget, later ones that fit are still admitted, and the record never exceeds it", () => {
    const ok = validated("a", answer("x"));
    const sized = (id: string, len: number) => ({ ...ok, modelId: id, data: { ...ok.data, directConclusion: "z".repeat(len) } }) as AdaptiveModelResult;
    const rows = ["a", "b", "c"].map((m) => panelRow(m));
    const adaptive = [sized("a", 30_000), sized("b", 30_000), sized("c", 100)];
    const all = build(rows, adaptive, ADAPTIVE_DISPLAY_RECORD_MAX_BYTES);
    expect(Object.values(all.record.bySlot).every((s) => s.availability === "available")).toBe(true);
    const budget = all.bytes - 20_000; // room for a and c, not b
    const out = build(rows, adaptive, budget);
    expect(out.record.bySlot.a.availability).toBe("available");
    expect(out.record.bySlot.b).toMatchObject({ availability: "unavailable", reason: "size_limit" });
    expect(out.record.bySlot.c.availability).toBe("available");
    expect(out.bytes).toBeLessThanOrEqual(budget);
    expect(out.bytes).toBe(firestoreFieldBytes(ADAPTIVE_DISPLAY_RESULTS_FIELD, out.record));
    // Exactly at the full size every slot fits; one byte less and the last oversize slot in order goes.
    expect(Object.values(build(rows, adaptive, all.bytes).record.bySlot).every((s) => s.availability === "available")).toBe(true);
    expect(build(rows, adaptive, all.bytes - 1).omittedForSize).toBeGreaterThan(0);
  });

  it("when even the minimal record (envelope + markers) does not fit, nothing is built", () => {
    const out = buildAdaptiveDisplayResultsRecord({ runId: RUN, schemaId: "comparison_matrix", panelResults: [panelRow("chatgpt")], adaptiveResults: [validated("chatgpt", answer("x"))], maxRecordBytes: 50 });
    expect(out).toEqual({ ok: false, reason: "oversized" });
  });

  it("the budget never exceeds the absolute record bound, whatever the caller passes", () => {
    const ok = validated("a", answer("x"));
    const rows = Array.from({ length: 6 }, (_, i) => panelRow(`m${i}`));
    const adaptive = rows.map((r) => ({ ...ok, modelId: r.modelId, data: { ...ok.data, directConclusion: "z".repeat(60_000) } }) as AdaptiveModelResult);
    const out = build(rows, adaptive, 10_000_000);
    expect(out.bytes).toBeLessThanOrEqual(ADAPTIVE_DISPLAY_RECORD_MAX_BYTES);
    expect(out.omittedForSize).toBeGreaterThan(0);
  });
});

describe("Firestore storage size rules", () => {
  it("follows the documented sizes", () => {
    expect(firestoreValueBytes("my_string")).toBe(10); // UTF-8 bytes + 1
    expect(firestoreValueBytes("é")).toBe(3);
    expect(firestoreValueBytes(1)).toBe(8);
    expect(firestoreValueBytes(true)).toBe(1);
    expect(firestoreValueBytes(null)).toBe(1);
    expect(firestoreValueBytes(["a", "b"])).toBe(4);
    expect(firestoreValueBytes({ ab: "c" })).toBe(3 + 2);
    expect(firestoreValueBytes({ x: undefined })).toBe(0);
    expect(firestoreValueBytes({ seconds: 1, nanoseconds: 0, toMillis: () => 1 })).toBe(8);
    expect(firestoreFieldBytes("f", "v")).toBe(2 + 2);
    expect(firestoreDocumentBytes({ f: "v" })).toBe(32 + 4);
    expect(firestoreDocumentBytes(undefined)).toBe(32);
  });
});

// ─── Reader ─────────────────────────────────────────────────────────────────

function healthyRecord() {
  const rows = [panelRow("chatgpt"), panelRow("claude"), panelRow("grok")];
  const full = mergeAdaptiveRetry(validated("claude", "not json"), validated("claude", answer("Retry"))).result;
  const partial = mergeAdaptiveRetry(validated("grok", answer("GrokFirst", { directConclusion: 7 })), validated("grok", answer("GrokRetry"))).result;
  const { record } = build(rows, [validated("chatgpt", answer("ChatGPT")), full, partial]);
  return { rows, record: roundTrip(record) as AdaptiveDisplayResultsV1, full, partial };
}

describe("reader — accepts only a record bound to this run, schema and slot", () => {
  it("a healthy record round-trips (Firestore key order does not matter)", () => {
    const { rows, record, full, partial } = healthyRecord();
    const reversed = JSON.parse(JSON.stringify(record), (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v));
    const got = read(reversed, rows);
    expect(got.status).toBe("valid");
    expect(Array.from(got.slots.keys()).sort()).toEqual(["chatgpt", "claude", "grok"]);
    expect(got.slots.get("claude")!.origin).toBe("retry_adopted_full");
    expect(got.slots.get("claude")!.result.data).toEqual(full.data);
    expect(got.slots.get("grok")!.origin).toBe("retry_adopted_partial");
    expect(got.slots.get("grok")!.result.data).toEqual(partial.data);
    expect(got.slots.get("chatgpt")!.origin).toBe("original_accepted");
  });

  it.each([
    ["absent (undefined)", undefined, "absent"],
    ["absent (null)", null, "absent"],
    ["a string", "x", "malformed"],
    ["an array", [], "malformed"],
    ["a future version", { schemaVersion: 2, runId: RUN, schemaId: "comparison_matrix", bySlot: {}, extra: 1 }, "unsupported_version"],
    ["version 0", { schemaVersion: 0, runId: RUN, schemaId: "comparison_matrix", bySlot: {} }, "malformed"],
    ["version as a string", { schemaVersion: "1", runId: RUN, schemaId: "comparison_matrix", bySlot: {} }, "malformed"],
    ["an unknown top-level key", { schemaVersion: 1, runId: RUN, schemaId: "comparison_matrix", bySlot: {}, prompt: "x" }, "malformed"],
    ["bySlot not a map", { schemaVersion: 1, runId: RUN, schemaId: "comparison_matrix", bySlot: [] }, "malformed"],
    ["another run's record", { schemaVersion: 1, runId: "other-run", schemaId: "comparison_matrix", bySlot: {} }, "foreign"],
    ["no runId", { schemaVersion: 1, schemaId: "comparison_matrix", bySlot: {} }, "foreign"],
    ["another schema's record", { schemaVersion: 1, runId: RUN, schemaId: "ranked_enumeration", bySlot: {} }, "foreign"],
  ])("%s → %s, no slots", (_l, raw, status) => {
    const got = read(raw, [panelRow("chatgpt")]);
    expect(got.status).toBe(status);
    expect(got.slots.size).toBe(0);
  });

  it("another run's record holding real slots yields nothing for this run", () => {
    const { rows, record } = healthyRecord();
    expect(read(record, rows, "run-other").slots.size).toBe(0);
  });

  const tamper = (fn: (r: any) => void) => {
    const { rows, record } = healthyRecord();
    const copy: any = roundTrip(record);
    fn(copy);
    return read(copy, rows);
  };

  it.each([
    ["wrong slotIndex", (r: any) => (r.bySlot.claude.slotIndex = 0)],
    ["slotIndex out of range", (r: any) => (r.bySlot.claude.slotIndex = 9)],
    ["slotIndex not an integer", (r: any) => (r.bySlot.claude.slotIndex = 1.5)],
    ["recorded status differs from the saved row", (r: any) => (r.bySlot.claude.executedStatus = "substituted")],
    ["unknown origin", (r: any) => (r.bySlot.claude.origin = "retry_adopted")],
    ["unknown origin with an outcome no rule rejects", (r: any) => Object.assign(r.bySlot.claude, { origin: "verbatim_retry", retryOutcome: null })],
    ["origin contradicts the outcome (full vs partial)", (r: any) => (r.bySlot.claude.retryOutcome = "adopted_partial")],
    ["origin original with an adopted outcome", (r: any) => (r.bySlot.claude.origin = "original_accepted")],
    ["unknown outcome", (r: any) => (r.bySlot.claude.retryOutcome = "maybe")],
    ["an unknown slot key", (r: any) => (r.bySlot.claude.rawText = "x")],
    ["availability unavailable", (r: any) => (r.bySlot.claude.availability = "unavailable")],
    ["data missing", (r: any) => delete r.bySlot.claude.data],
    ["data empty", (r: any) => (r.bySlot.claude.data = {})],
    ["data a string", (r: any) => (r.bySlot.claude.data = "x")],
    ["a data key outside the schema", (r: any) => (r.bySlot.claude.data.injected = "x")],
    ["data the validator would change (enum drift)", (r: any) => (r.bySlot.claude.data.cells[0].verdict = "Better")],
    ["data the validator rejects (wrong type)", (r: any) => (r.bySlot.claude.data.cells = "x")],
    ["invalidFields outside the schema", (r: any) => (r.bySlot.claude.invalidFields = ["nope"])],
    ["invalidFields duplicated", (r: any) => (r.bySlot.claude.invalidFields = ["cells", "cells"])],
    ["oversized slot", (r: any) => (r.bySlot.claude.data.directConclusion = "z".repeat(ADAPTIVE_DISPLAY_SLOT_MAX_BYTES))],
  ])("a slot with %s is dropped; the others stand", (_l, fn) => {
    const got = tamper(fn);
    expect(got.status).toBe("valid");
    expect(got.slots.has("claude")).toBe(false);
    expect(got.slots.has("chatgpt")).toBe(true);
  });

  it("an accepted original whose recorded status differs from the saved row's is dropped (both directions)", () => {
    const { rows, record } = healthyRecord();
    const forged: any = roundTrip(record);
    forged.bySlot.chatgpt.executedStatus = "substituted"; // origin original_accepted + null outcome is legal for substituted
    expect(read(forged, rows).slots.has("chatgpt")).toBe(false);
    expect(read(record, rows.map((r) => (r.modelId === "chatgpt" ? { ...r, status: "substituted" } : r))).slots.has("chatgpt")).toBe(false);
    expect(read(record, rows).slots.has("chatgpt")).toBe(true);
  });

  it("a slot whose id occurs twice in the saved rows is never used", () => {
    const { record } = healthyRecord();
    const got = read(record, [panelRow("chatgpt"), panelRow("claude"), panelRow("grok"), panelRow("claude")]);
    expect(got.slots.has("claude")).toBe(false);
    expect(got.slots.has("chatgpt")).toBe(true);
  });

  it("a substituted slot can only be an accepted original (a recorded retry is impossible for it)", () => {
    const rows = [panelRow("claude", "substituted")];
    const { record } = build(rows, [validated("claude", answer("Sub"))]);
    expect(read(roundTrip(record), rows).slots.get("claude")!.origin).toBe("original_accepted");
    const forged: any = roundTrip(record);
    forged.bySlot.claude.origin = "retry_adopted_full";
    forged.bySlot.claude.retryOutcome = "adopted_full";
    expect(read(forged, rows).slots.size).toBe(0);
  });

  it("never throws on hostile input (throwing getters, cycles, random shapes)", () => {
    const throwing = { schemaVersion: 1, runId: RUN, schemaId: "comparison_matrix", get bySlot() { throw new Error("boom"); } };
    expect(read(throwing, [panelRow("x")]).status).toBe("malformed");
    const cyc: any = { schemaVersion: 1, runId: RUN, schemaId: "comparison_matrix", bySlot: { chatgpt: { availability: "available", slotIndex: 0, executedStatus: "ok", origin: "original_accepted", retryOutcome: null } } };
    cyc.bySlot.chatgpt.data = { cells: [] };
    cyc.bySlot.chatgpt.data.self = cyc;
    expect(() => read(cyc, [panelRow("chatgpt")])).not.toThrow();
    for (const v of [0, 1, true, Symbol("s"), () => 1, new Map(), { bySlot: { a: null } }, { schemaVersion: 1, runId: RUN, schemaId: "comparison_matrix", bySlot: { a: 1, b: [], c: "x" } }]) {
      expect(() => read(v, [panelRow("a")])).not.toThrow();
    }
    expect(() => readAdoptedDisplayResults({ schemaVersion: 1, runId: RUN, schemaId: "comparison_matrix", bySlot: {} }, { runId: RUN, schemaId: "comparison_matrix", rows: null as never })).not.toThrow();
  });

  it("stored data is a fixed point of the live validator for every result the run can adopt", () => {
    const { rows, record } = healthyRecord();
    for (const id of rows.map((r) => r.modelId)) {
      const data = (record.bySlot[id] as any).data;
      expect(sameJsonValue(validated(id, data).data, data)).toBe(true);
    }
  });
});

describe("sameJsonValue", () => {
  it("is key-order-insensitive for maps and order-sensitive for arrays", () => {
    expect(sameJsonValue({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
    expect(sameJsonValue([1, 2], [2, 1])).toBe(false);
    expect(sameJsonValue({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(sameJsonValue({ a: "1" }, { a: 1 })).toBe(false);
    expect(sameJsonValue({ a: [] }, { a: {} })).toBe(false);
  });
});

describe("reconstructModelResults uses an adopted result only for a slot id seen once", () => {
  it("duplicated rows never take an adopted entry, even when handed one", () => {
    const adopted = new Map([["claude", { origin: "retry_adopted_full" as const, result: validated("claude", answer("Retry")) }]]);
    const rows = [
      { modelId: "claude", status: "ok", rawText: "not json" },
      { modelId: "claude", status: "ok", rawText: "not json" },
      { modelId: "grok", status: "ok", rawText: "not json" },
    ];
    const out = reconstructModelResults("comparison_matrix", rows, { adoptedResults: new Map([...adopted, ["grok", { origin: "original_accepted" as const, result: validated("grok", answer("G")) }]]) });
    expect(out.slice(0, 2).map((r) => [r.ok, r.savedResultOrigin])).toEqual([[false, undefined], [false, undefined]]);
    expect([out[2].ok, out[2].savedResultOrigin, out[2].savedResponseText]).toEqual([true, "original_accepted", "not json"]);
  });
});
