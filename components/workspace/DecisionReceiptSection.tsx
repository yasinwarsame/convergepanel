"use client";

/**
 * Team Workspace Boundary Hardening follow-up (10C.4A-U2), presentation +
 * source enrichment in Phase 10D.1 — renders `governanceRecord.
 * decisionReceipt` plus the new `reviewOverview` derived paragraph, on the
 * Team Workspace review page. A deliberate narrow duplication of the
 * Personal review surface's own "Decision Receipt" presentation rather
 * than a shared extraction — the two surfaces have independent
 * authorization models and lifecycles; see Phase 10D.1's own Part L note
 * on whether to extend Personal review to match.
 *
 * Plain React text rendering only — `governanceRecord.decisionReceipt` and
 * `reviewOverview` are synthesized plain-text content; no Markdown
 * processing, no `dangerouslySetInnerHTML`.
 *
 * Section order (Phase 10D.1 Part I, frozen): Review Overview → Panel
 * Conclusion → Supporting Detail → Sources cited by the panel → decision
 * controls (rendered by the caller, always below this section).
 *
 * `sources` is already normalized server-side to genuine http(s) links
 * only (`normalizeSourceUrls()` in `reviewContext.ts`) — this component
 * never re-validates a URL, never fetches a title, and renders exactly
 * what it's given via safe `<a>` tags (never `dangerouslySetInnerHTML`).
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
export const NO_SOURCES_MESSAGE = "No source links were returned for this panel result.";
/** Part B/K terminology freeze — never implies independent verification, authority, or fact-checking. */
export const SOURCES_DISCLAIMER_MESSAGE = "Sources cited by panel responses — not independently verified.";

function SourcesSection({ sources }: { sources: ReviewContextDecisionReceiptInfo["sources"] }) {
  return (
    <div className="mt-4 border-t border-cp-border pt-3">
      <h3 className="text-sm font-semibold text-cp-text">Sources cited by the panel</h3>
      {sources.length === 0 ? (
        <p className="mt-2 text-sm text-cp-muted">{NO_SOURCES_MESSAGE}</p>
      ) : (
        <ul className="mt-2 space-y-1">
          {sources.map((source, i) => (
            <li key={i}>
              <a
                href={source.url}
                target="_blank"
                rel="noopener noreferrer"
                className="break-all text-sm text-cp-accent underline hover:no-underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-cp-accent"
              >
                {source.hostname}
              </a>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-xs text-cp-faint">{SOURCES_DISCLAIMER_MESSAGE}</p>
    </div>
  );
}

/**
 * `receipt` is untrusted wire data — never assume-cast. Renders the
 * unavailable state (never fabricated content) when it doesn't pass
 * `hasUsableDecisionReceipt()`. `reviewOverview` is trusted (server-derived
 * plain text, never fabricated on the client) — an empty string renders no
 * overview section rather than an empty heading.
 */
export default function DecisionReceiptSection({ receipt, reviewOverview }: { receipt: unknown; reviewOverview: string }) {
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

      {reviewOverview.length > 0 ? (
        <div className="mt-3">
          <h3 className="text-sm font-semibold text-cp-text">Review Overview</h3>
          <p className="mt-1 text-sm leading-relaxed text-cp-muted">{reviewOverview}</p>
        </div>
      ) : null}

      <div className="mt-4 border-t border-cp-border pt-3 first:mt-0 first:border-t-0 first:pt-0">
        <h3 className="text-sm font-semibold text-cp-text">Panel Conclusion</h3>
        <p className="mt-1 text-sm leading-relaxed text-cp-text">{receipt.conclusion}</p>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-cp-muted">
          <span>{receipt.sourceBacked ? "Source-backed" : "Not source-backed"}</span>
          <span aria-hidden>&middot;</span>
          <span>{receipt.humanReviewNeeded ? "Human review needed" : "Human review not flagged as needed"}</span>
        </div>
      </div>

      <div className="mt-4 space-y-3">
        <CollapsibleReceiptList title="Basis" items={receipt.basis} />
        <CollapsibleReceiptList title="Assumptions" items={receipt.assumptions} />
        <CollapsibleReceiptList title="Uncertainties" items={receipt.uncertainties} />
        <CollapsibleReceiptList title="Limitations" items={receipt.limitations} />
      </div>

      <SourcesSection sources={receipt.sources} />
    </section>
  );
}

export type { ReviewContextDecisionReceiptInfo };
