/**
 * Item 7A — structured-output degradation disclosure. The ONE place that decides what a report says about how many
 * selected models produced usable structured output, and which did not.
 *
 * Source of truth: the run's persisted `CommonResponseMeta` only.
 * - `totalModels` and `modelsWithUsableOutput` are the counts (both recorded since Phase 1).
 * - `structuredOutput` is the per-slot record (written since Item 7A, only when a slot was not complete).
 * A call that completed at the provider is never counted as a usable result: usability is `modelsWithUsableOutput`.
 *
 * Fail closed: a missing or malformed per-slot record never becomes a guess. When the counts show a shortfall but no
 * valid per-slot record exists (every run before Item 7A), the disclosure says the affected models were not recorded.
 * A run with no shortfall and no record shows nothing.
 *
 * Pure and client-safe: no I/O, no logging, never throws. Field keys and counts only; never model content.
 */
import type { CommonResponseMeta, StructuredOutputRecordV1, StructuredOutputSlotV1 } from "./types";

export interface StructuredOutputDisclosureModel {
  modelId: string;
  /** "unavailable" = no usable structured output; "partial" = some fields or items not recovered; "shortened" = cut to a field limit only. */
  state: "unavailable" | "partial" | "shortened";
  /** Number of schema fields with no usable value (partial only). */
  fieldsNotRecovered: number;
  /** Total items discarded by salvage across kept fields (partial only). */
  itemsDropped: number;
  /** Number of fields shortened to fit the schema's word or item limits. */
  fieldsShortened: number;
}

export interface StructuredOutputDisclosure {
  selected: number;
  usable: number;
  /** e.g. "5 models selected · 4 usable structured results". */
  headline: string;
  /** Per affected slot, in slot order; null when the run did not record per-slot detail. */
  affected: StructuredOutputDisclosureModel[] | null;
}

const isNonNegInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string" && x.length > 0);

function readSlot(raw: unknown): StructuredOutputSlotV1 | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.modelId !== "string" || o.modelId.length === 0) return null;
  if (o.result !== "complete" && o.result !== "partial" && o.result !== "unavailable") return null;
  if (o.invalidFields !== undefined && !isStringArray(o.invalidFields)) return null;
  if (o.truncatedFields !== undefined && !isStringArray(o.truncatedFields)) return null;
  let droppedItems: Record<string, number> | undefined;
  if (o.droppedItems !== undefined) {
    if (!o.droppedItems || typeof o.droppedItems !== "object" || Array.isArray(o.droppedItems)) return null;
    const entries = Object.entries(o.droppedItems as Record<string, unknown>);
    if (!entries.every(([k, n]) => k.length > 0 && isNonNegInt(n) && n > 0)) return null;
    droppedItems = Object.fromEntries(entries) as Record<string, number>;
  }
  return {
    modelId: o.modelId as StructuredOutputSlotV1["modelId"],
    result: o.result,
    ...(o.invalidFields ? { invalidFields: o.invalidFields as string[] } : {}),
    ...(o.truncatedFields ? { truncatedFields: o.truncatedFields as string[] } : {}),
    ...(droppedItems ? { droppedItems } : {}),
  };
}

/** The persisted per-slot record, or null when absent or not exactly valid for this run's counts. */
export function readStructuredOutputRecord(meta: Partial<CommonResponseMeta> | null | undefined): StructuredOutputRecordV1 | null {
  const raw = (meta as { structuredOutput?: unknown } | null | undefined)?.structuredOutput;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (o.version !== 1 || !Array.isArray(o.slots)) return null;
  const slots: StructuredOutputSlotV1[] = [];
  for (const s of o.slots) {
    const slot = readSlot(s);
    if (!slot) return null;
    slots.push(slot);
  }
  const total = meta?.totalModels;
  const usable = meta?.modelsWithUsableOutput;
  if (!isNonNegInt(total) || slots.length !== total) return null;
  if (!isNonNegInt(usable) || slots.filter((s) => s.result !== "unavailable").length !== usable) return null;
  return { version: 1, slots };
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The disclosure for a run, or null when there is nothing to disclose (all selected models produced complete
 * structured output, or the run predates the counts).
 */
export function deriveStructuredOutputDisclosure(meta: Partial<CommonResponseMeta> | null | undefined): StructuredOutputDisclosure | null {
  const selected = meta?.totalModels;
  const usable = meta?.modelsWithUsableOutput;
  if (!isNonNegInt(selected) || !isNonNegInt(usable) || selected === 0 || usable > selected) return null;
  const record = readStructuredOutputRecord(meta);
  if (usable === selected && !record) return null;
  const affected: StructuredOutputDisclosureModel[] | null = record
    ? record.slots.flatMap((s): StructuredOutputDisclosureModel[] => {
        const fieldsShortened = s.truncatedFields?.length ?? 0;
        if (s.result === "complete" && fieldsShortened === 0) return [];
        const itemsDropped = Object.values(s.droppedItems ?? {}).reduce((a, b) => a + b, 0);
        return [
          {
            modelId: s.modelId,
            state: s.result === "unavailable" ? "unavailable" : s.result === "partial" ? "partial" : "shortened",
            fieldsNotRecovered: s.result === "partial" ? (s.invalidFields?.length ?? 0) : 0,
            itemsDropped: s.result === "partial" ? itemsDropped : 0,
            fieldsShortened: s.result === "unavailable" ? 0 : fieldsShortened,
          },
        ];
      })
    : null;
  if (affected && affected.length === 0) return null;
  return {
    selected,
    usable,
    headline: `${plural(selected, "model", "models")} selected · ${plural(usable, "usable structured result", "usable structured results")}`,
    affected,
  };
}

/** What happened to one affected model, without its name (the caller shows the name, e.g. as a model chip). */
export function describeAffectedState(m: StructuredOutputDisclosureModel): string {
  if (m.state === "unavailable") return "unavailable — no usable structured output";
  const parts: string[] = [];
  if (m.fieldsNotRecovered > 0) parts.push(`${plural(m.fieldsNotRecovered, "field", "fields")} not recovered`);
  if (m.itemsDropped > 0) parts.push(`${plural(m.itemsDropped, "item", "items")} discarded`);
  if (m.fieldsShortened > 0) parts.push(`${plural(m.fieldsShortened, "field", "fields")} shortened to fit limits`);
  return `${m.state === "partial" ? "partially used" : "used"} — ${parts.join("; ")}`;
}

/** Shown when the counts show a shortfall but the run did not record which models were affected. */
export const STRUCTURED_OUTPUT_DETAIL_NOT_RECORDED = "Which models were affected was not recorded for this run.";
