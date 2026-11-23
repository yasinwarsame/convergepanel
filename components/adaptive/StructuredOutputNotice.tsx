"use client";

/**
 * Item 7A — the visible structured-output degradation notice. Renders nothing when every selected model produced
 * complete structured output. Wording and counts come only from structuredOutputDisclosure.ts.
 */
import type { StructuredOutputDisclosure } from "@/lib/adaptiveSchema/structuredOutputDisclosure";
import { describeAffectedState, STRUCTURED_OUTPUT_DETAIL_NOT_RECORDED } from "@/lib/adaptiveSchema/structuredOutputDisclosure";
import type { ModelId } from "@/lib/types";
import { SlotChip } from "./shared";

export default function StructuredOutputNotice({ disclosure }: { disclosure: StructuredOutputDisclosure | null }) {
  if (!disclosure) return null;
  return (
    <div role="note" aria-label="Structured output completeness" data-testid="structured-output-notice" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
      <p className="text-sm font-medium text-amber-900">{disclosure.headline}</p>
      {disclosure.affected === null ? (
        <p className="mt-1 text-xs text-amber-900">{STRUCTURED_OUTPUT_DETAIL_NOT_RECORDED}</p>
      ) : (
        <ul className="mt-1 space-y-1">
          {disclosure.affected.map((m, i) => (
            <li key={`${m.modelId}-${i}`} data-testid="structured-output-affected" className="flex flex-wrap items-center gap-1.5 text-xs text-amber-900">
              <SlotChip modelId={m.modelId as ModelId} size="xs" />
              <span>{describeAffectedState(m)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
