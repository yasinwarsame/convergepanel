"use client";

/**
 * #290 Increment 1 — the readable layout's four trust signals (readable mode only).
 *
 * Each signal is its own labelled group: an h3 name (its accessible name), the value in words or counts (meaning is
 * never carried by colour alone — the panel uses no status colour at all), stored details, and a one-sentence plain
 * definition (its accessible description). The view model is lib/research/readableReport/trustSignals.ts; this component
 * only lays it out. The per-slot call status comes from RunSlotStatusContext, which ResultsDisplay provides.
 */

import { useId } from "react";
import type { AdaptiveGateResult, AdaptiveModelResult, AdaptiveSynthesisReport, AdaptiveTrustSummary, AlignedClaim, ResultSchema } from "@/lib/adaptiveSchema/types";
import { useRunSlotStatus } from "@/components/adaptive/RunSlotStatusContext";
import { buildTrustSignals, type TrustSignal } from "@/lib/research/readableReport/trustSignals";
import { READABLE_TRUST_COPY as C } from "@/lib/research/readableReport/copy";

export interface TrustSignalsPanelProps {
  schema: Pick<ResultSchema, "id" | "fields">;
  results: AdaptiveModelResult[];
  alignedClaims?: AlignedClaim[];
  gate?: AdaptiveGateResult;
  synthesisReport?: AdaptiveSynthesisReport;
  trustSummary?: AdaptiveTrustSummary;
}

export default function TrustSignalsPanel(props: TrustSignalsPanelProps) {
  const slotStatuses = useRunSlotStatus();
  const headingId = useId();
  const signals = buildTrustSignals({ ...props, slotStatuses });
  return (
    <section aria-labelledby={headingId} data-readable-tier="trust" className="rounded-xl border border-cp-border bg-cp-surface p-4">
      <h2 id={headingId} className="text-base font-semibold text-cp-text">
        {C.heading}
      </h2>
      <p className="mt-1 text-sm text-cp-muted">{C.intro}</p>
      <ul className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {signals.map((signal) => (
          <li key={signal.id}>
            <Signal signal={signal} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function Signal({ signal }: { signal: TrustSignal }) {
  const id = useId();
  const nameId = `${id}-name`;
  const definitionId = `${id}-definition`;
  return (
    <div role="group" aria-labelledby={nameId} aria-describedby={definitionId} data-trust-signal={signal.id} data-state={signal.state} className="h-full rounded-lg border border-cp-border-soft bg-cp-raised p-3">
      <h3 id={nameId} className="text-xs font-semibold uppercase tracking-wide text-cp-muted">
        {signal.name}
      </h3>
      <p data-trust-signal-value="" className="mt-1 text-sm font-semibold text-cp-text">
        {signal.value}
      </p>
      {signal.details.map((line) => (
        <p key={line} className="mt-1 text-xs text-cp-text">
          {line}
        </p>
      ))}
      <p id={definitionId} className="mt-2 text-xs text-cp-muted">
        {signal.definition}
      </p>
    </div>
  );
}
