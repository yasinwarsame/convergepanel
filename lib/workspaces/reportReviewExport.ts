/**
 * Order B, Stage B3 — the Report Review RECORD export (JSON and a printable HTML document). Pure: no I/O.
 *
 * WHY A SEPARATE EXPORT. The existing research exports (PDF / DOCX / JSON) are frozen byte-for-byte by the Order 6
 * boundary suites (dsExportBoundaries, dsProvenanceUiBoundaries, dsExportRendered): their routes, snapshot builder and
 * import list, JSON schema, render dispatchers, persistence and audit. Adding a section to them would invalidate that
 * evidence, which this stage may not do. This export therefore lives beside them and changes none of them: governed
 * exports are untouched, and this one is only reachable for a run that has a report review.
 *
 * WHAT IT CONTAINS.
 *   - The saved research content exactly as the canonical Team research read returns it (`buildRunReadPayload`): the
 *     question, each model's saved response, and the saved synthesis / legacy structured result when (and only when)
 *     they exist. Nothing is generated or re-derived; an absent analysis is stated as "not present", never filled in.
 *   - The review: purpose (code, label, note), current cycle and status, the decision timestamp and conditions.
 *   - The decision history: every archived cycle (write-once, validated contiguous 1..n-1) and the current one.
 *   - The fixed disclaimer.
 *   - Content drift (review M-2): research content is the run AS SAVED NOW, while each cycle's scope was frozen at its
 *     submission. Any analysis saved after the current cycle was submitted is listed in `changedSinceSubmission` and marked
 *     in the document as NOT covered by the review decision; each history entry carries its own `scopeAtSubmission`.
 *   - Reviewer identity and the reviewer's private comment are WITHHELD, the same boundary as the governed Team export
 *     (E1-S6b: an export never carries reviewer identity or private reviewer text the canonical research read does not).
 *
 * HTML is built only from escaped text (`escapeHtml`) inside a fixed template with no script and no external resource.
 */
import { REPORT_REVIEW_ANALYSIS_LABELS, REPORT_REVIEW_DISCLAIMER, reportReviewPurposeLabel, reportReviewStatusLabel } from "@/lib/governance/reportReviewCopy";
import type { ReportReviewAnalysis, ReportReviewRecordV1, ReportReviewScope } from "@/lib/governance/reportReview";
import type { ReportReviewContentFingerprint } from "@/lib/governance/reportReviewContent";
import type { RunReadPayload } from "@/lib/runs/runReadPayload";

export const REPORT_REVIEW_EXPORT_FORMAT = "convergepanel.report-review-record";
export const REPORT_REVIEW_EXPORT_VERSION = 1;

export interface ReportReviewExportCycle {
  cycle: number;
  status: string;
  statusLabel: string;
  purposeCode: string;
  purposeLabel: string;
  submittedAt: string;
  decidedAt: string | null;
  conditions: string[];
  current: boolean;
  scopeAtSubmission: ReportReviewScope;
  /** Order A: the fingerprint of the exact content this cycle was submitted (and, if decided, decided) on. */
  contentFingerprint: ReportReviewContentFingerprint | null;
}

export interface ReportReviewExportV1 {
  format: typeof REPORT_REVIEW_EXPORT_FORMAT;
  version: typeof REPORT_REVIEW_EXPORT_VERSION;
  generatedAt: string;
  disclaimer: string;
  research: {
    runId: string;
    question: string;
    selectedModels: string[];
    responses: unknown[];
    synthesis: unknown | null;
    structuredResult: unknown | null;
  };
  /** What the saved run contains NOW, what the current cycle was submitted with, and what was added in between. */
  analysisPresence: {
    unifiedAnswer: "present" | "absent";
    synthesis: "present" | "absent";
    consensus: "present" | "absent";
    respondedModels: number;
    requestedModels: number;
    atSubmission: ReportReviewScope;
    changedSinceSubmission: ReportReviewAnalysis[];
  };
  contentNote: string;
  review: {
    kind: "report_review";
    currentCycle: number;
    status: string;
    statusLabel: string;
    purpose: { code: string; label: string; note: string | null };
    submittedAt: string;
    decidedAt: string | null;
    conditions: string[];
    reviewer: "withheld";
    contentFingerprint: ReportReviewContentFingerprint | null;
    /**
     * Order A: "matches" — the research content below IS the content this cycle was submitted with; "changed" — it is
     * NOT (the content below is the current research, and this cycle's status does not apply to it); "unverifiable" —
     * the cycle has no usable fingerprint.
     */
    contentIntegrity: "matches" | "changed" | "unverifiable";
  };
  decisionHistory: ReportReviewExportCycle[];
}

export type ReportReviewArchiveCheck = { ok: true; cycles: ReportReviewRecordV1[] } | { ok: false };

/**
 * Historical-cycle integrity: archives must be exactly cycles 1..current-1, each a valid record whose own `cycle` matches
 * its archive. Anything else (a gap, a duplicate, a malformed archive) fails the export closed rather than presenting a
 * history that is incomplete or out of order.
 */
export function checkArchivedCycles(current: ReportReviewRecordV1, archived: { cycle: unknown; record: ReportReviewRecordV1 | null }[]): ReportReviewArchiveCheck {
  const sorted = [...archived].sort((a, b) => Number(a.cycle) - Number(b.cycle));
  if (sorted.length !== current.cycle - 1) return { ok: false };
  const out: ReportReviewRecordV1[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    if (a.cycle !== i + 1 || a.record === null || a.record.cycle !== i + 1) return { ok: false };
    out.push(a.record);
  }
  return { ok: true, cycles: out };
}

function cycleEntry(r: ReportReviewRecordV1, current: boolean): ReportReviewExportCycle {
  return {
    cycle: r.cycle,
    status: r.humanReview.status,
    statusLabel: reportReviewStatusLabel(r.humanReview.status),
    purposeCode: r.purpose.code,
    purposeLabel: reportReviewPurposeLabel(r.purpose.code),
    submittedAt: r.submittedAt,
    decidedAt: r.humanReview.reviewedAt ?? null,
    conditions: r.humanReview.conditions ? [...r.humanReview.conditions] : [],
    current,
    scopeAtSubmission: { ...r.scope },
    contentFingerprint: r.contentFingerprint ? { ...r.contentFingerprint } : null,
  };
}

export const REPORT_REVIEW_CONTENT_NOTE =
  "Research content is the run as it is saved now. Each review cycle records what the report contained when it was submitted; anything added after the current cycle was submitted is not covered by its decision.";

export function buildReportReviewExport(args: {
  generatedAt: string;
  runId: string;
  payload: RunReadPayload;
  record: ReportReviewRecordV1;
  archivedCycles: ReportReviewRecordV1[];
  /** compareReportReviewScope(record.scope, run): the run's analyses now, and those added since submission. */
  drift: { current: ReportReviewScope; changedSinceSubmission: ReportReviewAnalysis[] };
  /** Order A: the route's comparison of the run's current fingerprint with the cycle's (server-computed). */
  contentIntegrity: "matches" | "changed" | "unverifiable";
}): ReportReviewExportV1 {
  const { payload, record, drift } = args;
  const hr = record.humanReview;
  return {
    format: REPORT_REVIEW_EXPORT_FORMAT,
    version: REPORT_REVIEW_EXPORT_VERSION,
    generatedAt: args.generatedAt,
    disclaimer: REPORT_REVIEW_DISCLAIMER,
    research: {
      runId: args.runId,
      question: payload.question,
      selectedModels: [...payload.selectedModels],
      responses: payload.results as unknown[],
      synthesis: payload.synthesisCache ? payload.synthesisCache.report : null,
      structuredResult: payload.legacyAdaptive.status === "valid" ? payload.legacyAdaptive.output : null,
    },
    analysisPresence: {
      unifiedAnswer: drift.current.unifiedAnswer,
      synthesis: drift.current.synthesis,
      consensus: drift.current.consensus,
      respondedModels: drift.current.respondedModels,
      requestedModels: drift.current.requestedModels,
      atSubmission: { ...record.scope },
      changedSinceSubmission: [...drift.changedSinceSubmission],
    },
    contentNote: REPORT_REVIEW_CONTENT_NOTE,
    review: {
      kind: "report_review",
      currentCycle: record.cycle,
      status: hr.status,
      statusLabel: reportReviewStatusLabel(hr.status),
      purpose: { code: record.purpose.code, label: reportReviewPurposeLabel(record.purpose.code), note: record.purpose.note },
      submittedAt: record.submittedAt,
      decidedAt: hr.reviewedAt ?? null,
      conditions: hr.conditions ? [...hr.conditions] : [],
      reviewer: "withheld",
      contentFingerprint: record.contentFingerprint ? { ...record.contentFingerprint } : null,
      contentIntegrity: args.contentIntegrity,
    },
    decisionHistory: [...args.archivedCycles.map((c) => cycleEntry(c, false)), cycleEntry(record, true)],
  };
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function responseText(r: unknown): { model: string; status: string; text: string } {
  const o = (r ?? {}) as Record<string, unknown>;
  const text = typeof o.rawTextFull === "string" ? o.rawTextFull : typeof o.rawText === "string" ? o.rawText : "";
  return { model: typeof o.modelId === "string" ? o.modelId : "unknown model", status: typeof o.status === "string" ? o.status : "unknown", text };
}

/** A self-contained, printable document. Every interpolated value passes through escapeHtml. No script, no remote resource. */
export function renderReportReviewExportHtml(doc: ReportReviewExportV1): string {
  const e = escapeHtml;
  const p = doc.analysisPresence;
  const order: ReportReviewAnalysis[] = ["unifiedAnswer", "consensus", "synthesis"];
  const absent = order.filter((a) => p[a] === "absent").map((a) => REPORT_REVIEW_ANALYSIS_LABELS[a]);
  const added = order.filter((a) => p.changedSinceSubmission.includes(a)).map((a) => REPORT_REVIEW_ANALYSIS_LABELS[a]);
  const notReviewed = " <strong>(added or regenerated after this report was submitted for review — not covered by the decision)</strong>";
  const rows = doc.decisionHistory
    .map(
      (c) =>
        `<tr><td>${c.cycle}${c.current ? " (current)" : ""}</td><td>${e(c.statusLabel)}</td><td>${e(c.purposeLabel)}</td><td>${e(c.submittedAt)}</td><td>${e(c.decidedAt ?? "—")}</td><td>${c.conditions.length ? `<ul>${c.conditions.map((x) => `<li>${e(x)}</li>`).join("")}</ul>` : "—"}</td></tr>`
    )
    .join("");
  const responses = doc.research.responses
    .map(responseText)
    .map((r) => `<section class="resp"><h3>${e(r.model)} <span class="muted">(${e(r.status)})</span></h3><pre>${e(r.text)}</pre></section>`)
    .join("");
  const synthesis = doc.research.synthesis !== null ? `<h2>Saved synthesis${p.changedSinceSubmission.includes("synthesis") ? notReviewed : ""}</h2><pre>${e(JSON.stringify(doc.research.synthesis, null, 2))}</pre>` : "";
  // Review M-1: the saved structured result (the legacy Adaptive Schema report the reviewer read) is part of the record.
  const structured = doc.research.structuredResult !== null ? `<h2>Saved structured result</h2><pre>${e(JSON.stringify(doc.research.structuredResult, null, 2))}</pre>` : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Report review record — ${e(doc.research.question || "Untitled research")}</title>
<style>body{font-family:system-ui,sans-serif;max-width:860px;margin:2rem auto;padding:0 1rem;color:#18181B;background:#fff}h1{font-size:1.4rem}h2{font-size:1.1rem;margin-top:2rem}.muted{color:#65656E;font-weight:normal}.disclaimer{border:1px solid #E4E3DD;background:#FBFBF9;padding:.75rem 1rem;border-radius:8px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #E4E3DD;padding:.4rem;text-align:left;vertical-align:top;font-size:.9rem}pre{white-space:pre-wrap;word-break:break-word;background:#FBFBF9;border:1px solid #EFEEE9;padding:.75rem;border-radius:6px;font-size:.85rem}</style>
</head><body>
<h1>Report review record</h1>
<p class="disclaimer">${e(doc.disclaimer)}</p>
${
  doc.review.contentIntegrity === "matches"
    ? `<p class="muted">The research below is exactly the content review cycle ${doc.review.currentCycle} was submitted with (fingerprint ${e(doc.review.contentFingerprint!.algorithm)}:${e(doc.review.contentFingerprint!.digest)}).</p>`
    : `<p class="disclaimer"><strong>${
        doc.review.contentIntegrity === "changed"
          ? `The research has changed since review cycle ${doc.review.currentCycle} was submitted. The content below is the CURRENT research, NOT the version that was reviewed, and this cycle's status does not apply to it.`
          : `The content submitted for review cycle ${doc.review.currentCycle} cannot be verified. The content below is the current research and this cycle's status does not apply to it.`
      }</strong></p>`
}
<h2>Review</h2>
<table><tbody>
<tr><th>Status</th><td>${e(doc.review.statusLabel)}</td></tr>
<tr><th>Review cycle</th><td>${doc.review.currentCycle}</td></tr>
<tr><th>Purpose</th><td>${e(doc.review.purpose.label)}${doc.review.purpose.note ? `<br><span class="muted">${e(doc.review.purpose.note)}</span>` : ""}</td></tr>
<tr><th>Submitted</th><td>${e(doc.review.submittedAt)}</td></tr>
<tr><th>Decided</th><td>${e(doc.review.decidedAt ?? "Not yet decided")}</td></tr>
<tr><th>Reviewer</th><td>Withheld from exports</td></tr>
</tbody></table>
<h2>Decision history</h2>
<table><thead><tr><th>Cycle</th><th>Status</th><th>Purpose</th><th>Submitted</th><th>Decided</th><th>Conditions</th></tr></thead><tbody>${rows}</tbody></table>
<h2>Research</h2>
<p><strong>${e(doc.research.question || "Untitled research")}</strong></p>
<p class="muted">${p.respondedModels} of ${p.requestedModels} models responded.${absent.length ? ` This report does not contain ${e(absent.join(", "))}; none was generated or verified.` : ""}</p>
${added.length ? `<p class="disclaimer">Added or regenerated after this report was submitted for review, and not covered by the decision: ${e(added.join(", "))}.</p>` : ""}
<p class="muted">${e(doc.contentNote)}</p>
${structured}
${synthesis}
<h2>Saved model responses</h2>
${responses || '<p class="muted">No saved model responses.</p>'}
<p class="muted">Generated ${e(doc.generatedAt)}. Format ${e(doc.format)} v${doc.version}.</p>
</body></html>
`;
}
