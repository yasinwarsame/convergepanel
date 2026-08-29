"use client";

/**
 * Team Workspace Boundary Hardening follow-up (10C.4A-U2) — renders
 * `governanceRecord.decisionReceipt`, the same review-artifact summary the
 * Personal review surface (`PersonalReviewDetail.tsx`) already shows, on
 * the Team Workspace review page. A deliberate narrow duplication of that
 * page's own "Decision Receipt" presentation rather than a shared
 * extraction — the two surfaces have independent authorization models and
 * lifecycles, and reusing PersonalReviewDetail.tsx's own local, unexported
 * component would have meant either modifying an already-shipped surface
 * for no behavioral gain there, or a cross-cutting refactor out of scope
 * for a Tier-2-blocking fix. Recorded as accepted, non-blocking
 * duplication rather than solved via premature reuse.
 *
 * Plain React text rendering only — `governanceRecord.decisionReceipt` is
 * synthesized plain-text content (see `AdaptiveDecisionReceipt`); no
 * Markdown processing, no `dangerouslySetInnerHTML`, matching the source
 * Personal presentation exactly.
 *
 * `AdaptiveDecisionReceipt.sources` is not part of this section's props at
 * all (10C.4A-U2C) — the Team DTO deliberately never projects it, since
 * nothing here renders it and there was no concrete requirement to send
 * it to the browser unused. Out of scope for this fix either way, which
 * exists to surface the already-established review summary, not to build
 * a new evidence-navigation surface.
 */

import { useState } from "react";
import { hasUsableDecisionReceipt, type ReviewContextDecisionReceiptInfo } from "@/lib/client/workspaceReviewClient";

function CollapsibleReceiptList({ title, items }: { title: string; items: string[] }) {
  const [expanded, setExpanded] = useState(true);
  if (items.length === 0) return null;
  const sectionId = `workspace-review-receipt-${title.toLowerCase().replace(/\s+/g, "-")}`;
  return (
    <div className="border-t border-cp-border pt-3 first:border-t-0 first:pt-0">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        aria-controls={sectionId}
        className="flex w-full items-center justify-between text-left text-sm font-semibold text-cp-text focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent"
      >
        <span>
          {title} ({items.length})
        </span>
        <span aria-hidden>{expanded ? "−" : "+"}</span>
      </button>
      {expanded ? (
        <ul id={sectionId} className="mt-2 list-disc space-y-1 pl-5 text-sm text-cp-text">
          {items.map((text, i) => (
            <li key={i}>{text}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export const DECISION_RECEIPT_UNAVAILABLE_MESSAGE = "Review content is unavailable. A decision cannot be submitted until the review content is available.";

/**
 * `receipt` is untrusted wire data — never assume-cast. Renders the
 * unavailable state (never fabricated content) when it doesn't pass
 * `hasUsableDecisionReceipt()`.
 */
export default function DecisionReceiptSection({ receipt }: { receipt: unknown }) {
  if (!hasUsableDecisionReceipt(receipt)) {
    return (
      <section className="rounded-xl border border-cp-border bg-cp-surface p-5 shadow-sm">
        <h2 className="text-base font-bold text-cp-text">Decision Receipt</h2>
        <p className="mt-3 rounded-lg bg-cp-raised px-3 py-2 text-sm text-cp-muted">{DECISION_RECEIPT_UNAVAILABLE_MESSAGE}</p>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-cp-border bg-cp-surface p-5 shadow-sm">
      <h2 className="text-base font-bold text-cp-text">Decision Receipt</h2>
      <p className="mt-3 text-sm leading-relaxed text-cp-text">{receipt.conclusion}</p>
      <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-cp-muted">
        <span>{receipt.sourceBacked ? "Source-backed" : "Not source-backed"}</span>
        <span aria-hidden>&middot;</span>
        <span>{receipt.humanReviewNeeded ? "Human review needed" : "Human review not flagged as needed"}</span>
      </div>
      <div className="mt-4 space-y-3">
        <CollapsibleReceiptList title="Basis" items={receipt.basis} />
        <CollapsibleReceiptList title="Assumptions" items={receipt.assumptions} />
        <CollapsibleReceiptList title="Uncertainties" items={receipt.uncertainties} />
        <CollapsibleReceiptList title="Limitations" items={receipt.limitations} />
      </div>
    </section>
  );
}

export type { ReviewContextDecisionReceiptInfo };
