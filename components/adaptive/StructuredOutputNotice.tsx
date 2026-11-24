"use client";

/**
 * Item 7A — the visible structured-output degradation notice. Renders nothing when every selected model produced
 * complete structured output. Wording and counts come only from structuredOutputDisclosure.ts.
 *
 * Prominent (amber note) unless the disclosure says every affected model has only an isolated, non-decision-critical
 * shortening; that case is still disclosed, collapsed in a details element, without a warning.
 */
import type { StructuredOutputDisclosure } from "@/lib/adaptiveSchema/structuredOutputDisclosure";
import { describeAffectedState, STRUCTURED_OUTPUT_DETAIL_NOT_RECORDED, STRUCTURED_OUTPUT_SECTION_HEADING } from "@/lib/adaptiveSchema/structuredOutputDisclosure";
import type { ModelId } from "@/lib/types";
import { SlotChip } from "./shared";

function AffectedList({ disclosure, tone }: { disclosure: StructuredOutputDisclosure; tone: string }) {
  if (disclosure.affected === null) return <p className={`mt-1 text-xs ${tone}`}>{STRUCTURED_OUTPUT_DETAIL_NOT_RECORDED}</p>;
  return (
    <ul className="mt-1 space-y-1">
      {disclosure.affected.map((m, i) => (
        <li key={`${m.modelId}-${i}`} data-testid="structured-output-affected" className={`flex flex-wrap items-center gap-1.5 text-xs ${tone}`}>
          <SlotChip modelId={m.modelId as ModelId} size="xs" />
          <span>
            {describeAffectedState(m)}
            {m.material ? null : " (not decision-critical)"}
          </span>
        </li>
      ))}
    </ul>
  );
}

export default function StructuredOutputNotice({ disclosure }: { disclosure: StructuredOutputDisclosure | null }) {
  if (!disclosure) return null;
  if (!disclosure.prominent) {
    return (
      <details data-testid="structured-output-details" className="rounded-lg border border-cp-border bg-cp-raised px-3 py-2">
        <summary className="cursor-pointer text-xs text-cp-muted">{STRUCTURED_OUTPUT_SECTION_HEADING}</summary>
        <p className="mt-1 text-xs text-cp-muted">{disclosure.headline}</p>
        {disclosure.callsLine ? <p className="mt-0.5 text-xs text-cp-muted">{disclosure.callsLine}</p> : null}
        <AffectedList disclosure={disclosure} tone="text-cp-muted" />
      </details>
    );
  }
  return (
    <div role="note" aria-label="Structured output completeness" data-testid="structured-output-notice" className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2">
      <p className="text-sm font-medium text-amber-900">{disclosure.headline}</p>
      {disclosure.callsLine ? <p className="mt-0.5 text-xs text-amber-900">{disclosure.callsLine}</p> : null}
      <AffectedList disclosure={disclosure} tone="text-amber-900" />
    </div>
  );
}
