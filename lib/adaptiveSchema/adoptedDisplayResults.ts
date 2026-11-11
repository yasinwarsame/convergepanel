/**
 * Order 40 C (owner-authorized) — the validated per-slot results a Milestone-2 report actually used.
 *
 * Why it exists: the saved copy of every model response (`runDocument.perModel`, written by completeRun) is the
 * model's FIRST answer, because completeRun runs before adaptive finalization. When a corrective retry was adopted
 * (retryCorrection.ts mergeAdaptiveRetry: "adopted_full" / "adopted_partial"), the result that fed the aggregate was
 * never saved, so a reopened report could only say so (#312). This module defines one small, versioned, bounded
 * record, `runs/{runId}.adaptiveDisplayResults`, written ONCE after the adaptive output is persisted, holding for each
 * slot ONLY the validated `data` the live run accepted, bound to that run, schema and slot.
 *
 * What it is not:
 *   - not the first answer (that stays in `runDocument.perModel`, byte for byte unchanged);
 *   - not an input to anything: consensus, scoring, certainty, gates, decision outputs, review routing and governance
 *     never read it (they read `adaptiveOutput`, unchanged). It feeds only the reopened Model Responses section;
 *   - not synthesized: `data` is copied from the slot's own validated AdaptiveModelResult, never from aggregate cells;
 *   - never a prompt, key, provider payload, parse error or token count.
 *
 * Retry outcome: the existing `retryOutcome` enum (ADAPTIVE_RETRY_OUTCOMES) is recorded per slot exactly as the live
 * run set it, or null when no retry was considered. Together with `origin` it distinguishes: original accepted
 * (null / no_change / failed_call / skipped_budget / ineligible_substituted with validated first-answer data); retry
 * adopted in full (adopted_full); retry adopted in part (adopted_partial); retry attempted but not adopted (no_change);
 * retry failed or timed out (failed_call). A run without this record (every run before it existed) is "outcome
 * unavailable" and keeps #312's behaviour.
 *
 * Bounds (UTF-8 bytes, measured with Firestore's documented storage-size rules, firestoreValueBytes below): one slot
 * at most ADAPTIVE_DISPLAY_SLOT_MAX_BYTES, the whole record at most ADAPTIVE_DISPLAY_RECORD_MAX_BYTES, and never more
 * than the headroom the existing run document leaves under FIRESTORE_DOCUMENT_BUDGET_BYTES (Firestore's limit is
 * 1,048,576 bytes). A slot over a bound is OMITTED and marked unavailable ("size_limit"); its data is never truncated.
 *
 * Reading is strict (readAdoptedDisplayResults): any malformed, future-version, foreign-run, foreign-schema or
 * mismatched-slot data is ignored and the slot falls back to #312's presentation. The stored `data` must be a fixed
 * point of the live validator (re-validating it yields the same data), so nothing renders that the validator would not
 * have produced. Pure: no I/O, no provider call, no logging, never throws.
 */
import "server-only";
import type { ModelId } from "@/lib/types";
import type { AdaptiveModelResult, QueryType } from "./types";
import { ADAPTIVE_RETRY_OUTCOMES, isAdaptiveRetryOutcome, type AdaptiveRetryOutcome } from "./retryCorrection";
import { SCHEMA_REGISTRY, getResultSchema } from "./schemaRegistry";
import { validateAdaptiveResponse } from "./validator";

// ─── Contract ───────────────────────────────────────────────────────────────

/** The run-document field. Top-level, written once, never by the client. */
export const ADAPTIVE_DISPLAY_RESULTS_FIELD = "adaptiveDisplayResults";
export const ADAPTIVE_DISPLAY_RESULTS_SCHEMA_VERSION = 1;

export const ADAPTIVE_DISPLAY_RESULT_ORIGINS = ["original_accepted", "retry_adopted_full", "retry_adopted_partial"] as const;
export type AdaptiveDisplayResultOrigin = (typeof ADAPTIVE_DISPLAY_RESULT_ORIGINS)[number];

export const ADAPTIVE_DISPLAY_UNAVAILABLE_REASONS = [
  /** The slot had no validated data live (it did not answer, or neither answer validated). */
  "no_validated_data",
  /** The slot's validated data exceeded a size bound; omitted, never truncated. */
  "size_limit",
  /** The validated data holds a value Firestore cannot store faithfully (e.g. a nested array); omitted. */
  "unsupported_value",
  /** The slot id occurs more than once in the run: it cannot be bound to one slot. */
  "duplicate_slot",
] as const;
export type AdaptiveDisplayUnavailableReason = (typeof ADAPTIVE_DISPLAY_UNAVAILABLE_REASONS)[number];

/** Panel call statuses (ConnectorStatus) recorded for the slot when the record was written. */
const EXECUTED_STATUSES = ["ok", "error", "timeout", "refused", "rate_limited", "substituted"] as const;
type ExecutedStatus = (typeof EXECUTED_STATUSES)[number];

export interface AdaptiveDisplayAvailableSlotV1 {
  availability: "available";
  /** Index of the slot in the run's panel results (= `runDocument.perModel` order). */
  slotIndex: number;
  /** The slot's recorded call status: only an answering slot can have data. */
  executedStatus: "ok" | "substituted";
  origin: AdaptiveDisplayResultOrigin;
  /** The live run's retryOutcome for this slot, or null when no retry was considered. */
  retryOutcome: AdaptiveRetryOutcome | null;
  /** The validated data the report used, exactly as the live validator / mergeAdaptiveRetry produced it. */
  data: Record<string, unknown>;
  invalidFields?: string[];
  truncatedFields?: string[];
}

export interface AdaptiveDisplayUnavailableSlotV1 {
  availability: "unavailable";
  reason: AdaptiveDisplayUnavailableReason;
  /** Absent only for "duplicate_slot", which has no single index or outcome. */
  slotIndex?: number;
  executedStatus?: ExecutedStatus;
  retryOutcome?: AdaptiveRetryOutcome | null;
}

export type AdaptiveDisplaySlotV1 = AdaptiveDisplayAvailableSlotV1 | AdaptiveDisplayUnavailableSlotV1;

export interface AdaptiveDisplayResultsV1 {
  schemaVersion: 1;
  /** The run this record belongs to; a record whose runId differs from the document being read is ignored. */
  runId: string;
  /** The persisted envelope's schema; a record for another schema is ignored. */
  schemaId: string;
  bySlot: Record<string, AdaptiveDisplaySlotV1>;
}

/** Per-slot bound: a slot's entry (field name + value) larger than this is omitted. */
export const ADAPTIVE_DISPLAY_SLOT_MAX_BYTES = 64 * 1024;
/** Whole-record bound (field name + value), whatever the document headroom. */
export const ADAPTIVE_DISPLAY_RECORD_MAX_BYTES = 256 * 1024;
/** The run document must stay at or under this after the write (Firestore's hard limit is 1,048,576 bytes). */
export const FIRESTORE_DOCUMENT_BUDGET_BYTES = 1_000_000;
/** Firestore's documented fixed per-document overhead. */
const FIRESTORE_DOCUMENT_OVERHEAD_BYTES = 32;
/** Firestore allows 20 levels of nested maps/arrays; this record stays well inside it. */
const MAX_VALUE_DEPTH = 16;

// ─── Firestore storage size ─────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

const utf8 = (s: string) => Buffer.byteLength(s, "utf8");

/**
 * Storage size of a value under Firestore's documented rules: string = UTF-8 bytes + 1; boolean / null = 1;
 * number / timestamp = 8; bytes = length; array = sum of its values; map = sum of (key UTF-8 bytes + 1 + value).
 * A reference, geopoint or other class instance is measured as a map of its own enumerable fields (an
 * over-estimate for the run document's Timestamp, which is handled as 8 bytes first). Undefined fields are not stored.
 */
export function firestoreValueBytes(value: unknown): number {
  if (value === undefined) return 0;
  if (value === null || typeof value === "boolean") return 1;
  if (typeof value === "number" || typeof value === "bigint") return 8;
  if (typeof value === "string") return utf8(value) + 1;
  if (value instanceof Date) return 8;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) return value.length;
  if (Array.isArray(value)) return value.reduce((sum: number, v) => sum + firestoreValueBytes(v), 0);
  if (typeof value === "object") {
    const o = value as Record<string, unknown>;
    if (typeof o.seconds === "number" && typeof o.nanoseconds === "number" && typeof o.toMillis === "function") return 8;
    let sum = 0;
    for (const [k, v] of Object.entries(o)) {
      if (v === undefined || typeof v === "function") continue;
      sum += utf8(k) + 1 + firestoreValueBytes(v);
    }
    return sum;
  }
  return 0;
}

/** Size of one top-level field as stored: name + value. */
export function firestoreFieldBytes(name: string, value: unknown): number {
  return utf8(name) + 1 + firestoreValueBytes(value);
}

/** Size of a whole document's fields plus Firestore's fixed overhead (the document name is added by the caller's margin). */
export function firestoreDocumentBytes(data: Record<string, unknown> | undefined): number {
  if (!data) return FIRESTORE_DOCUMENT_OVERHEAD_BYTES;
  let sum = FIRESTORE_DOCUMENT_OVERHEAD_BYTES;
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    sum += firestoreFieldBytes(k, v);
  }
  return sum;
}

// ─── Serialization (write side) ─────────────────────────────────────────────

/**
 * A faithful, storable copy of validated data, or null when it holds anything Firestore would not store as-is
 * (a nested array, a non-finite number, a class instance, a function, excessive depth). Undefined object fields are
 * dropped, exactly as Firestore's ignoreUndefinedProperties would; an undefined array element is unstorable.
 */
function storableCopy(value: unknown, depth: number, parentIsArray: boolean): { ok: true; value: unknown } | { ok: false } {
  if (depth > MAX_VALUE_DEPTH) return { ok: false };
  if (value === null || typeof value === "string" || typeof value === "boolean") return { ok: true, value };
  if (typeof value === "number") return Number.isFinite(value) ? { ok: true, value } : { ok: false };
  if (Array.isArray(value)) {
    if (parentIsArray) return { ok: false };
    const out: unknown[] = [];
    for (const v of value) {
      if (v === undefined) return { ok: false };
      const c = storableCopy(v, depth + 1, true);
      if (!c.ok) return c;
      out.push(c.value);
    }
    return { ok: true, value: out };
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      if (k.length === 0) return { ok: false };
      const c = storableCopy(v, depth + 1, false);
      if (!c.ok) return c;
      out[k] = c.value;
    }
    return { ok: true, value: out };
  }
  return { ok: false };
}

function fieldKeyList(value: unknown, allowed: ReadonlySet<string>): string[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const keys = value.filter((k): k is string => typeof k === "string" && allowed.has(k));
  return keys.length === value.length ? Array.from(new Set(keys)) : undefined;
}

function originFor(retryOutcome: AdaptiveRetryOutcome | undefined): AdaptiveDisplayResultOrigin {
  if (retryOutcome === "adopted_full") return "retry_adopted_full";
  if (retryOutcome === "adopted_partial") return "retry_adopted_partial";
  return "original_accepted";
}

export type BuildAdaptiveDisplayResultsOutcome =
  | { ok: true; record: AdaptiveDisplayResultsV1; bytes: number; omittedForSize: number }
  /** Nothing is written: the slots cannot be bound, or even the minimal record does not fit. */
  | { ok: false; reason: "slot_mismatch" | "unsupported_schema" | "oversized" };

/**
 * Builds the record from the live run's own values: the panel results (one per slot, in saved order) and the
 * finalized adaptive results (same order, same length). `maxRecordBytes` is the field-size budget the caller computed
 * from the run document (never above ADAPTIVE_DISPLAY_RECORD_MAX_BYTES). Deterministic: the same inputs and budget
 * always produce the same record. Slots are admitted in slot order; once a slot does not fit, it is omitted and
 * marked "size_limit", and later slots that still fit are admitted.
 */
export function buildAdaptiveDisplayResultsRecord(args: {
  runId: string;
  schemaId: string;
  panelResults: ReadonlyArray<{ modelId: string; status: string }>;
  adaptiveResults: ReadonlyArray<AdaptiveModelResult>;
  maxRecordBytes?: number;
}): BuildAdaptiveDisplayResultsOutcome {
  const { runId, schemaId, panelResults, adaptiveResults } = args;
  if (!Object.prototype.hasOwnProperty.call(SCHEMA_REGISTRY, schemaId)) return { ok: false, reason: "unsupported_schema" };
  if (typeof runId !== "string" || runId.length === 0) return { ok: false, reason: "slot_mismatch" };
  if (panelResults.length !== adaptiveResults.length) return { ok: false, reason: "slot_mismatch" };
  for (let i = 0; i < panelResults.length; i += 1) {
    if (panelResults[i]?.modelId !== adaptiveResults[i]?.modelId || typeof panelResults[i]?.modelId !== "string") {
      return { ok: false, reason: "slot_mismatch" };
    }
  }
  const schemaFieldKeys = new Set(getResultSchema(schemaId as QueryType).fields.map((f) => f.key));
  const budget = Math.min(args.maxRecordBytes ?? ADAPTIVE_DISPLAY_RECORD_MAX_BYTES, ADAPTIVE_DISPLAY_RECORD_MAX_BYTES);

  const occurrences = new Map<string, number>();
  for (const r of panelResults) occurrences.set(r.modelId, (occurrences.get(r.modelId) ?? 0) + 1);

  // First pass: each slot's full entry, or its unavailable marker.
  type Planned = { modelId: string; full: AdaptiveDisplaySlotV1; marker: AdaptiveDisplayUnavailableSlotV1 };
  const planned: Planned[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < panelResults.length; i += 1) {
    const modelId = panelResults[i].modelId;
    if ((occurrences.get(modelId) ?? 0) > 1) {
      if (!seen.has(modelId)) {
        seen.add(modelId);
        const marker: AdaptiveDisplayUnavailableSlotV1 = { availability: "unavailable", reason: "duplicate_slot" };
        planned.push({ modelId, full: marker, marker });
      }
      continue;
    }
    const status = panelResults[i].status;
    const executedStatus = (EXECUTED_STATUSES as readonly string[]).includes(status) ? (status as ExecutedStatus) : undefined;
    const adaptive = adaptiveResults[i];
    const retryOutcome = isAdaptiveRetryOutcome(adaptive.retryOutcome) ? adaptive.retryOutcome : null;
    const unavailable = (reason: AdaptiveDisplayUnavailableReason): AdaptiveDisplayUnavailableSlotV1 => ({
      availability: "unavailable",
      reason,
      slotIndex: i,
      ...(executedStatus ? { executedStatus } : {}),
      retryOutcome,
    });
    const answered = executedStatus === "ok" || executedStatus === "substituted";
    if (!answered || adaptive.ok !== true || !isPlainObject(adaptive.data)) {
      const marker = unavailable("no_validated_data");
      planned.push({ modelId, full: marker, marker });
      continue;
    }
    const copy = storableCopy(adaptive.data, 0, false);
    if (!copy.ok) {
      const marker = unavailable("unsupported_value");
      planned.push({ modelId, full: marker, marker });
      continue;
    }
    const invalidFields = fieldKeyList(adaptive.invalidFields, schemaFieldKeys);
    const truncatedFields = fieldKeyList(adaptive.truncatedFields, schemaFieldKeys);
    const full: AdaptiveDisplayAvailableSlotV1 = {
      availability: "available",
      slotIndex: i,
      executedStatus: executedStatus as "ok" | "substituted",
      origin: originFor(adaptive.retryOutcome),
      retryOutcome,
      data: copy.value as Record<string, unknown>,
      ...(invalidFields ? { invalidFields } : {}),
      ...(truncatedFields ? { truncatedFields } : {}),
    };
    planned.push({ modelId, full, marker: unavailable("size_limit") });
  }

  // Second pass: admit within the bounds. The envelope and every marker are reserved first, so the record that is
  // written can never exceed the budget, whatever is admitted.
  const envelope: AdaptiveDisplayResultsV1 = { schemaVersion: 1, runId, schemaId, bySlot: {} };
  let used = firestoreFieldBytes(ADAPTIVE_DISPLAY_RESULTS_FIELD, envelope);
  for (const p of planned) used += firestoreFieldBytes(p.modelId, p.marker);
  if (used > budget) return { ok: false, reason: "oversized" };

  let omittedForSize = 0;
  for (const p of planned) {
    if (p.full.availability !== "available") {
      envelope.bySlot[p.modelId] = p.full;
      continue;
    }
    const fullBytes = firestoreFieldBytes(p.modelId, p.full);
    const markerBytes = firestoreFieldBytes(p.modelId, p.marker);
    if (fullBytes <= ADAPTIVE_DISPLAY_SLOT_MAX_BYTES && used - markerBytes + fullBytes <= budget) {
      envelope.bySlot[p.modelId] = p.full;
      used += fullBytes - markerBytes;
    } else {
      envelope.bySlot[p.modelId] = p.marker;
      omittedForSize += 1;
    }
  }
  return { ok: true, record: envelope, bytes: firestoreFieldBytes(ADAPTIVE_DISPLAY_RESULTS_FIELD, envelope), omittedForSize };
}

// ─── Strict reader ──────────────────────────────────────────────────────────

/** One slot's adopted result, verified against the run being read. */
export interface AdoptedSlotResult {
  origin: AdaptiveDisplayResultOrigin;
  result: AdaptiveModelResult;
}

export type AdoptedDisplayResultsRead =
  | { status: "absent" | "unsupported_version" | "malformed" | "foreign"; slots: ReadonlyMap<string, AdoptedSlotResult> }
  | { status: "valid"; slots: ReadonlyMap<string, AdoptedSlotResult> };

const RECORD_KEYS = new Set(["schemaVersion", "runId", "schemaId", "bySlot"]);
const AVAILABLE_KEYS = new Set(["availability", "slotIndex", "executedStatus", "origin", "retryOutcome", "data", "invalidFields", "truncatedFields"]);

/** Order-insensitive for object keys (Firestore does not preserve map key order), order-sensitive for arrays. */
export function sameJsonValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => sameJsonValue(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a).filter((k) => a[k] !== undefined);
    const kb = Object.keys(b).filter((k) => b[k] !== undefined);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && sameJsonValue(a[k], b[k]));
  }
  return false;
}

/** Retry outcomes that leave the first answer standing (or were never a retry). */
const ORIGINAL_OUTCOMES: ReadonlySet<string> = new Set(ADAPTIVE_RETRY_OUTCOMES.filter((o) => o !== "adopted_full" && o !== "adopted_partial"));

function originMatchesOutcome(origin: AdaptiveDisplayResultOrigin, outcome: AdaptiveRetryOutcome | null, executedStatus: "ok" | "substituted"): boolean {
  if (executedStatus === "substituted") return origin === "original_accepted" && (outcome === null || outcome === "ineligible_substituted");
  if (origin === "retry_adopted_full") return outcome === "adopted_full";
  if (origin === "retry_adopted_partial") return outcome === "adopted_partial";
  return outcome === null || (ORIGINAL_OUTCOMES.has(outcome) && outcome !== "ineligible_substituted");
}

function optionalFieldKeys(value: unknown, allowed: ReadonlySet<string>): { ok: true; value?: string[] } | { ok: false } {
  if (value === undefined) return { ok: true };
  const keys = fieldKeyList(value, allowed);
  return keys && keys.length === (value as unknown[]).length ? { ok: true, value: keys } : { ok: false };
}

function readSlot(
  modelId: string,
  raw: unknown,
  schemaId: QueryType,
  schemaFieldKeys: ReadonlySet<string>,
  rows: ReadonlyArray<{ modelId?: unknown; status?: unknown } | null | undefined>,
  occurrences: ReadonlyMap<string, number>
): AdoptedSlotResult | null {
  if (!isPlainObject(raw) || raw.availability !== "available") return null;
  if (Object.keys(raw).some((k) => !AVAILABLE_KEYS.has(k))) return null;
  const { slotIndex, executedStatus, origin, retryOutcome, data } = raw;
  if (typeof slotIndex !== "number" || !Number.isInteger(slotIndex) || slotIndex < 0) return null;
  if (executedStatus !== "ok" && executedStatus !== "substituted") return null;
  if (typeof origin !== "string" || !(ADAPTIVE_DISPLAY_RESULT_ORIGINS as readonly string[]).includes(origin)) return null;
  if (retryOutcome !== null && !isAdaptiveRetryOutcome(retryOutcome)) return null;
  if (!originMatchesOutcome(origin as AdaptiveDisplayResultOrigin, retryOutcome as AdaptiveRetryOutcome | null, executedStatus)) return null;
  // Bound to the exact slot of the run being read: same index, same id, same recorded status, and an id seen once.
  const row = rows[slotIndex];
  if (!row || row.modelId !== modelId || row.status !== executedStatus || occurrences.get(modelId) !== 1) return null;
  if (!isPlainObject(data) || Object.keys(data).length === 0) return null;
  if (firestoreFieldBytes(modelId, raw) > ADAPTIVE_DISPLAY_SLOT_MAX_BYTES) return null;
  const invalidFields = optionalFieldKeys(raw.invalidFields, schemaFieldKeys);
  const truncatedFields = optionalFieldKeys(raw.truncatedFields, schemaFieldKeys);
  if (!invalidFields.ok || !truncatedFields.ok) return null;
  if (Object.keys(data).some((k) => !schemaFieldKeys.has(k))) return null;
  // The stored data must be exactly what the live validator accepts: re-validating it changes nothing.
  let serialized: string;
  try {
    serialized = JSON.stringify(data);
  } catch {
    return null;
  }
  const revalidated = validateAdaptiveResponse(modelId as ModelId, getResultSchema(schemaId), serialized, { silent: true });
  if (!revalidated.ok || !revalidated.data || !sameJsonValue(revalidated.data, data)) return null;
  return {
    origin: origin as AdaptiveDisplayResultOrigin,
    result: {
      modelId: modelId as ModelId,
      schemaId,
      ok: true,
      data: revalidated.data,
      ...(invalidFields.value ? { invalidFields: invalidFields.value } : {}),
      ...(truncatedFields.value ? { truncatedFields: truncatedFields.value } : {}),
      ...(retryOutcome === "adopted_full" || retryOutcome === "adopted_partial" ? { retried: true, retryOutcome } : {}),
    },
  };
}

const NONE: ReadonlyMap<string, AdoptedSlotResult> = new Map();

/**
 * The verified adopted results for the run being read. `rows` are the saved panel rows already in the read payload
 * (runDocumentToPublicResults order). Every failure is a status with no slots; one bad slot drops only that slot.
 */
export function readAdoptedDisplayResults(
  raw: unknown,
  expected: { runId: string; schemaId: string; rows: ReadonlyArray<{ modelId?: unknown; status?: unknown } | null | undefined> }
): AdoptedDisplayResultsRead {
  try {
    if (raw === undefined || raw === null) return { status: "absent", slots: NONE };
    if (!isPlainObject(raw)) return { status: "malformed", slots: NONE };
    if (raw.schemaVersion !== ADAPTIVE_DISPLAY_RESULTS_SCHEMA_VERSION) {
      return { status: typeof raw.schemaVersion === "number" && raw.schemaVersion > 1 ? "unsupported_version" : "malformed", slots: NONE };
    }
    if (Object.keys(raw).some((k) => !RECORD_KEYS.has(k)) || !isPlainObject(raw.bySlot)) return { status: "malformed", slots: NONE };
    if (typeof raw.runId !== "string" || raw.runId.length === 0 || raw.runId !== expected.runId) return { status: "foreign", slots: NONE };
    if (raw.schemaId !== expected.schemaId || !Object.prototype.hasOwnProperty.call(SCHEMA_REGISTRY, expected.schemaId)) return { status: "foreign", slots: NONE };
    if (!Array.isArray(expected.rows)) return { status: "malformed", slots: NONE };
    const schemaId = expected.schemaId as QueryType;
    const schemaFieldKeys = new Set(getResultSchema(schemaId).fields.map((f) => f.key));
    const occurrences = new Map<string, number>();
    for (const row of expected.rows) {
      if (row && typeof row.modelId === "string") occurrences.set(row.modelId, (occurrences.get(row.modelId) ?? 0) + 1);
    }
    const slots = new Map<string, AdoptedSlotResult>();
    for (const [modelId, entry] of Object.entries(raw.bySlot)) {
      const slot = readSlot(modelId, entry, schemaId, schemaFieldKeys, expected.rows, occurrences);
      if (slot) slots.set(modelId, slot);
    }
    return { status: "valid", slots };
  } catch {
    return { status: "malformed", slots: NONE };
  }
}
