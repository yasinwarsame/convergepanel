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
import type { SourcePublisherClass } from "@/lib/sourceAuthority/types";

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

/**
 * Order 4 — descriptive publisher-type badges (present only when the server
 * attached `publisher`). Unordered categories: no score, rank or quality word.
 */
export const PUBLISHER_CLASS_LABELS: Record<SourcePublisherClass, string> = {
  GOVERNMENT: "Government domain",
  INTERGOVERNMENTAL_ORGANIZATION: "Intergovernmental domain",
  ACADEMIC_INSTITUTION: "Academic institution domain",
  OPEN_CONTRIBUTION_PLATFORM: "Open-contribution platform",
  UNCLASSIFIED: "Unclassified domain",
};
export const PUBLISHER_CLASS_DISCLAIMER_MESSAGE =
  "Publisher type is inferred from the cited web address only — it does not mean the page exists, supports the panel's claim, or is accurate.";

function publisherLabel(source: ReviewContextDecisionReceiptInfo["sources"][number]): string | null {
  const cls = source.publisher?.publisherClass;
  return cls !== undefined && Object.prototype.hasOwnProperty.call(PUBLISHER_CLASS_LABELS, cls) ? PUBLISHER_CLASS_LABELS[cls] : null;
}

/**
 * Order 4 Slice 2b — Workspace Source Standing presentation. Present only when
 * the server attached `standing` (server flag on AND this Workspace recorded a
 * standing for that exact document). A recorded Workspace decision, current
 * state only — never a quality score, verification or fact-check. All four
 * states share one neutral visual treatment.
 */
export const SOURCE_STANDING_LABELS = Object.freeze({
  ACCEPTED: "Accepted by this Workspace",
  DISPUTED: "Disputed in this Workspace",
  SUPERSEDED: "Superseded in this Workspace",
  UNRESOLVED: "Workspace standing unavailable",
} as const);
export const SOURCE_STANDING_DISCLAIMER_MESSAGE =
  "Workspace standing reflects a recorded decision within this Workspace. It does not mean the page exists, supports the panel's claim, or is accurate.";
export const SOURCE_STANDING_UPDATED_PREFIX = "Workspace standing updated";

export type RenderableStanding =
  | { status: "ACCEPTED" | "DISPUTED" | "SUPERSEDED"; label: string; asOf: string }
  | { status: "UNRESOLVED"; label: string };

const ownProp = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
/** Exactly the server's `toISOString()` shape — anything else is not a trusted standing timestamp. */
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** Fixed locale + UTC: deterministic for every viewer and test machine; date only, no fabricated time zone label. */
const STANDING_DATE_FORMAT = new Intl.DateTimeFormat("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });

/** The display date for a trusted standing timestamp, or null — never "Invalid Date", never today's date. */
export function formatStandingDate(asOf: string): string | null {
  if (!ISO_UTC.test(asOf)) return null;
  const ms = Date.parse(asOf);
  if (Number.isNaN(ms) || new Date(ms).toISOString() !== asOf) return null;
  return STANDING_DATE_FORMAT.format(new Date(ms));
}

/**
 * Validate the untrusted wire `standing` (own properties only; prototype names
 * never map to a label). A malformed ACCEPTED/DISPUTED/SUPERSEDED renders
 * NOTHING — it is never relabelled UNRESOLVED, which only the server asserts.
 * Only status/label/asOf survive: successor, actor, reason or revision fields
 * are never read.
 */
export function toRenderableStanding(raw: unknown): RenderableStanding | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw) || !ownProp(raw, "status")) return null;
  const status = (raw as { status: unknown }).status;
  if (typeof status !== "string" || !ownProp(SOURCE_STANDING_LABELS, status)) return null;
  const known = status as keyof typeof SOURCE_STANDING_LABELS;
  if (known === "UNRESOLVED") return { status: "UNRESOLVED", label: SOURCE_STANDING_LABELS.UNRESOLVED };
  if (!ownProp(raw, "asOf")) return null;
  const asOf = (raw as { asOf: unknown }).asOf;
  if (typeof asOf !== "string" || formatStandingDate(asOf) === null) return null;
  return { status: known, label: SOURCE_STANDING_LABELS[known], asOf };
}

function SourcesSection({ sources }: { sources: ReviewContextDecisionReceiptInfo["sources"] }) {
  const showsPublisherTypes = sources.some((source) => publisherLabel(source) !== null);
  const standings = sources.map((source) => toRenderableStanding((source as { standing?: unknown }).standing));
  const showsStanding = standings.some((standing) => standing !== null);
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
              {publisherLabel(source) !== null && (
                <span data-testid="source-publisher-class" className="ml-2 rounded border border-cp-border bg-cp-raised px-1.5 py-0.5 text-xs text-cp-muted">
                  {publisherLabel(source)}
                </span>
              )}
              {standings[i] !== null && (
                <span data-testid="source-standing" className="ml-2 rounded border border-cp-border bg-cp-raised px-1.5 py-0.5 text-xs text-cp-muted">
                  {standings[i]!.label}
                </span>
              )}
              {standings[i] !== null && standings[i]!.status !== "UNRESOLVED" && (
                <span data-testid="source-standing-updated" className="ml-2 text-xs text-cp-faint">
                  {SOURCE_STANDING_UPDATED_PREFIX} {formatStandingDate((standings[i] as { asOf: string }).asOf)}
                </span>
              )}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-xs text-cp-faint">{SOURCES_DISCLAIMER_MESSAGE}</p>
      {showsPublisherTypes && (
        <p data-testid="source-publisher-disclaimer" className="mt-1 text-xs text-cp-faint">
          {PUBLISHER_CLASS_DISCLAIMER_MESSAGE}
        </p>
      )}
      {showsStanding && (
        <p data-testid="source-standing-disclaimer" className="mt-1 text-xs text-cp-faint">
          {SOURCE_STANDING_DISCLAIMER_MESSAGE}
        </p>
      )}
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
          <p className="mt-1 break-all text-sm leading-relaxed text-cp-muted">{reviewOverview}</p>
        </div>
      ) : null}

      <div className="mt-4 border-t border-cp-border pt-3 first:mt-0 first:border-t-0 first:pt-0">
        <h3 className="text-sm font-semibold text-cp-text">Panel Conclusion</h3>
        <p className="mt-1 break-all text-sm leading-relaxed text-cp-text">{receipt.conclusion}</p>
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
