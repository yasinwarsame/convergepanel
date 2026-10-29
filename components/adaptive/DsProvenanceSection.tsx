"use client";

/**
 * Order 6 / S-2a — the collapsed "Provenance and review details" section for a Decision Support report (OD-1, OD-6).
 *
 * Renders only a display model produced by `readDsProvenanceForPage` from the view the page's own route returned; it
 * reads nothing else and makes no request. Every string is an owner-approved constant (dsProvenanceDisplayText.ts)
 * except the entries the data supplies: model-listed sources and reviewer conditions, rendered as plain text nodes
 * (React escapes them; never HTML, never a link). Collapsed by default. The collapsed state is presentation only: the
 * route has already removed anything this viewer may not see.
 *
 * The D-9 grouping disclosure is not repeated here: the page already shows it where grouped options appear (Q1/OD-3).
 */

import { useId, useState } from "react";
import type { DsProvenanceDisplay } from "@/lib/research/dsProvenanceClientView";
import {
  DS_NO_SOURCES_LISTED,
  DS_NOT_A_CERTAINTY_MEASURE,
  DS_NOT_FLAGGED_FOR_REVIEW,
  DS_PROVENANCE_CONDITIONS_LABEL,
  DS_PROVENANCE_COUNTS_LABEL,
  DS_PROVENANCE_EMPTY,
  DS_PROVENANCE_FLAGGED_FOR_REVIEW,
  DS_PROVENANCE_HEADING,
  DS_PROVENANCE_NOT_AUTHORIZED_FOR_USE,
  DS_PROVENANCE_REVIEW_LABEL,
  DS_PROVENANCE_REVIEW_RECORDED,
  DS_PROVENANCE_REVIEWED_AT_LABEL,
  DS_PROVENANCE_SOURCES_LABEL,
  DS_PROVENANCE_STRENGTH_LABEL,
  DS_PROVENANCE_SUMMARY,
  DS_PROVENANCE_UNKNOWN,
  DS_PROVENANCE_USE_LABEL,
  DS_SOURCES_LISTED,
  DS_STRENGTH_CAPTION,
} from "@/lib/adaptiveSchema/dsProvenanceDisplayText";

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-cp-muted">{label}</h4>
      <div className="mt-1 space-y-1 text-sm text-cp-text">{children}</div>
    </div>
  );
}

export default function DsProvenanceSection({ display }: { display: DsProvenanceDisplay }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const panelId = `${id}-panel`;

  const groups: React.ReactNode[] = [];
  if (display.sources) {
    groups.push(
      <Group key="sources" label={DS_PROVENANCE_SOURCES_LABEL}>
        {display.sources.kind === "listed" ? (
          <>
            <p>{DS_SOURCES_LISTED}</p>
            <ul className="list-disc space-y-0.5 pl-5 text-cp-muted">
              {display.sources.items.map((s, i) => (
                <li key={i} className="break-words">
                  {s}
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p>{display.sources.kind === "none" ? DS_NO_SOURCES_LISTED : DS_PROVENANCE_UNKNOWN}</p>
        )}
      </Group>,
    );
  }
  if (display.strength) {
    groups.push(
      <Group key="strength" label={DS_PROVENANCE_STRENGTH_LABEL}>
        <p>{DS_STRENGTH_CAPTION}</p>
      </Group>,
    );
  }
  if (display.counts) {
    groups.push(
      <Group key="counts" label={DS_PROVENANCE_COUNTS_LABEL}>
        <p>{display.counts}</p>
        <p className="text-cp-muted">{DS_NOT_A_CERTAINTY_MEASURE}</p>
      </Group>,
    );
  }
  if (display.reviewNeeded || display.reviewRecorded || display.reviewedAt || display.conditions.length > 0) {
    groups.push(
      <Group key="review" label={DS_PROVENANCE_REVIEW_LABEL}>
        {display.reviewNeeded ? <p>{display.reviewNeeded === "flagged" ? DS_PROVENANCE_FLAGGED_FOR_REVIEW : DS_NOT_FLAGGED_FOR_REVIEW}</p> : null}
        {display.reviewRecorded ? <p>{DS_PROVENANCE_REVIEW_RECORDED}</p> : null}
        {display.reviewedAt ? (
          <p>
            <span className="text-cp-muted">{DS_PROVENANCE_REVIEWED_AT_LABEL}</span> {display.reviewedAt}
          </p>
        ) : null}
        {display.conditions.length > 0 ? (
          <>
            <p className="text-cp-muted">{DS_PROVENANCE_CONDITIONS_LABEL}</p>
            <ul className="list-disc space-y-0.5 pl-5">
              {display.conditions.map((c, i) => (
                <li key={i} className="break-words">
                  {c}
                </li>
              ))}
            </ul>
          </>
        ) : null}
      </Group>,
    );
  }
  if (display.notAuthorizedForUse) {
    groups.push(
      <Group key="use" label={DS_PROVENANCE_USE_LABEL}>
        <p>{DS_PROVENANCE_NOT_AUTHORIZED_FOR_USE}</p>
      </Group>,
    );
  }

  return (
    <section data-ds-provenance-section="" aria-labelledby={`${id}-heading`} className="rounded-xl border border-cp-border bg-cp-surface px-4 py-3">
      <h3 className="m-0">
        <button
          type="button"
          id={`${id}-heading`}
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((v) => !v)}
          className="flex w-full items-center justify-between gap-2 rounded text-left text-xs font-semibold uppercase tracking-wide text-cp-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cp-accent"
        >
          <span>{DS_PROVENANCE_HEADING}</span>
          <span aria-hidden="true">{open ? "−" : "+"}</span>
        </button>
      </h3>
      <p className="mt-1 text-xs text-cp-muted">{DS_PROVENANCE_SUMMARY}</p>
      <div id={panelId} role="region" aria-labelledby={`${id}-heading`} hidden={!open} className="mt-3 space-y-3">
        {groups.length > 0 ? groups : <p className="text-sm text-cp-muted">{DS_PROVENANCE_EMPTY}</p>}
      </div>
    </section>
  );
}
