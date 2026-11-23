/**
 * Item 7A (owner-authorized 2026-11-23) — controlled test exception for comparisons against HISTORICAL evidence
 * (records, digests and goldens frozen before Item 7A).
 *
 * Item 7A adds exactly one thing to a freshly built run's persisted output: `meta.structuredOutput`, written ONLY when
 * a selected slot was not complete (see commonResponseMeta.ts buildStructuredOutputRecord). Historical evidence never
 * holds it. (Export renderers derive their disclosure from it at render time; the snapshot itself is unchanged.)
 *
 * `withoutItem7aRecord` is the exact inverse, applied ONLY to the fresh side of a historical comparison:
 *  - it removes `structuredOutput` only from an object shaped like CommonResponseMeta, and only when the value is a
 *    record readStructuredOutputRecord accepts for that meta's own counts (a malformed record is never hidden);
 *  - every removal is reported, so each spec asserts the exception's exact scope.
 * The input is never modified.
 */
import { readStructuredOutputRecord } from "@/lib/adaptiveSchema/structuredOutputDisclosure";

export interface Item7aRemoval {
  kind: "meta";
  modelIds: string[];
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function withoutItem7aRecord<T>(value: T, removed: Item7aRemoval[] = []): T {
  const copy = structuredClone(value);
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const x of v) visit(x);
      return;
    }
    if (!isObj(v)) return;
    if ("structuredOutput" in v && typeof v.totalModels === "number" && typeof v.modelsWithUsableOutput === "number") {
      const record = readStructuredOutputRecord(v as never);
      if (record) {
        delete v.structuredOutput;
        removed.push({ kind: "meta", modelIds: record.slots.map((s) => String(s.modelId)) });
      }
    }
    for (const x of Object.values(v)) visit(x);
  };
  visit(copy);
  return copy;
}

/** How many CommonResponseMeta-shaped objects in `value` carry a `structuredOutput` key at all (valid or not). */
export function countItem7aRecords(value: unknown): number {
  let n = 0;
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) return v.forEach(visit);
    if (!isObj(v)) return;
    if ("structuredOutput" in v && typeof v.totalModels === "number" && typeof v.modelsWithUsableOutput === "number") n++;
    Object.values(v).forEach(visit);
  };
  visit(value);
  return n;
}
