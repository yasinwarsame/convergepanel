"use client";

/**
 * TEAM-VERIFICATION-PARITY-R2 — SHARED, READ-ONLY Claim verification result
 * presentation.
 *
 * Renders a stored Claim verification result only: disclaimer, aggregate
 * verdict banner, consensus metrics, claim text, agreement digest, per-model
 * evidence and the legal disclaimer. It owns NO auth, NO network, NO governance
 * lookup, NO export/download, NO execution and NO application navigation. The
 * only links are the static `/terms` legal links that are part of the
 * disclaimers.
 *
 * Everything caller-specific arrives through explicit slots; an absent slot
 * renders nothing (never a Personal fallback):
 *   - `noticeSurface`     between the disclaimer header and the verdict banner
 *   - `governanceSurface` at the end of the consensus card
 *   - `actionsSurface`    after the claim text
 *
 * `ClaimVerificationResult` (the Personal wrapper) supplies today's Personal
 * governance fetch/badge, create-response policy notice, actions, audit trail
 * and Verify Another. A future Team durable detail page supplies its own.
 */

import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { HelpCircle, CheckCircle, AlertTriangle, AlertCircle } from "lucide-react";
import { runModelFamilyName } from "@/lib/panel/runModelIdentity";
import type { ModelId } from "@/lib/types";
import type {
  ClaimVerificationClientPayload,
  ClaimVerdictUi,
} from "@/lib/verification/claimVerificationClientPayload";
import { CLAIM_VERDICT_CLIPBOARD_DISCLAIMER } from "@/lib/legal/clipboardDisclaimers";
import {
  claimConsensusDisplay,
  claimVerdictQualifier,
  CLAIM_NOT_INDEPENDENT_AGREE_HEADING,
  CLAIM_NOT_INDEPENDENT_DISAGREE_HEADING,
  CLAIM_SINGLE_MODEL_BANNER_SUBTITLE,
  CLAIM_UNVERIFIED_BANNER_SUBTITLE,
} from "@/lib/verification/claimConsensusPresentation";
import { claimPresentedIndependence, claimRowsExecutionIdentity } from "@/lib/panel/storedVerificationIndependence";
import {
  independentModelsAmong,
  rendersAsIndependent,
  runSlotStatement,
  type RunExecutionIdentity,
} from "@/lib/panel/executionIdentity";

function verdictBadgeClass(verdict: string): string {
  const v = verdict.toLowerCase();
  if (v === "accurate") return "bg-emerald-50 text-emerald-700 border-emerald-200";
  if (v === "inaccurate") return "bg-rose-50 text-rose-700 border-rose-200";
  if (v === "partially_accurate") return "bg-amber-50 text-amber-700 border-amber-200";
  if (v === "unverifiable" || v === "parse_error" || v === "failed") {
    return "bg-cp-raised text-cp-muted border-cp-border";
  }
  return "bg-cp-raised text-cp-muted border-cp-border";
}

function formatVerdictLabel(verdict: string): string {
  if (verdict === "partially_accurate") return "Partially accurate";
  if (verdict === "parse_error") return "Parse error";
  return verdict.charAt(0).toUpperCase() + verdict.slice(1);
}

function aggregateVerdictLabel(verdict: ClaimVerdictUi): string {
  switch (verdict) {
    case "confirmed":
      return "Confirmed";
    case "disputed":
      return "Disputed";
    case "partially_true":
      return "Partially true";
    default:
      return "Unverifiable";
  }
}

function aggregateVerdictTextClass(verdict: ClaimVerdictUi): string {
  switch (verdict) {
    case "confirmed":
      return "text-emerald-700 font-semibold";
    case "disputed":
      return "text-rose-700 font-semibold";
    case "partially_true":
      return "text-amber-700 font-semibold";
    default:
      return "text-cp-muted font-semibold";
  }
}

const AGGREGATE_VERDICT_ICONS: Record<ClaimVerdictUi, ReactNode> = {
  confirmed: <CheckCircle className="h-8 w-8 shrink-0 text-emerald-600" aria-hidden />,
  disputed: <AlertTriangle className="h-8 w-8 shrink-0 text-rose-600" aria-hidden />,
  partially_true: <AlertCircle className="h-8 w-8 shrink-0 text-amber-600" aria-hidden />,
  unverifiable: <HelpCircle className="h-8 w-8 shrink-0 text-cp-faint" aria-hidden />,
};

function aggregateVerdictBadgeClass(verdict: ClaimVerdictUi): string {
  switch (verdict) {
    case "confirmed":
      return "inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2.5 py-0.5 text-xs font-semibold text-emerald-700";
    case "disputed":
      return "inline-flex items-center rounded-full border border-rose-200 bg-rose-50 px-2.5 py-0.5 text-xs font-semibold text-rose-700";
    case "partially_true":
      return "inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2.5 py-0.5 text-xs font-semibold text-amber-700";
    default:
      return "inline-flex items-center rounded-full border border-cp-border bg-cp-raised px-2.5 py-0.5 text-xs font-semibold text-cp-muted";
  }
}

function confidenceLabelTextClass(label: "High" | "Medium" | "Low"): string {
  if (label === "High") return "text-emerald-700 font-semibold";
  if (label === "Medium") return "text-amber-700 font-semibold";
  return "text-cp-faint font-semibold";
}

function evidenceQualityTextClass(q: "strong" | "mixed" | "weak"): string {
  if (q === "strong") return "text-emerald-700 font-semibold capitalize";
  if (q === "mixed") return "text-amber-700 font-semibold capitalize";
  return "text-cp-faint font-semibold capitalize";
}

function truncateRunId(id: string): string {
  const t = id.trim();
  if (t.length <= 12) return t;
  return `${t.slice(0, 12)}…`;
}

function truncateClaimForAudit(claim: string, maxLen = 100): string {
  const t = claim.trim();
  if (t.length <= maxLen) return `"${t}"`;
  return `"${t.slice(0, maxLen - 1).trimEnd()}…"`;
}

function formatAuditTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

/** Semantic color for per-model verdict words in the audit list. */
function perModelAuditVerdictClass(verdictOrStatus: string): string {
  const v = verdictOrStatus.toLowerCase();
  if (v === "accurate") return "text-emerald-700";
  if (v === "inaccurate") return "text-rose-700";
  if (v === "partially_accurate") return "text-amber-700";
  if (v === "parse_error" || v === "failed") return "text-rose-700";
  return "text-cp-muted";
}

/**
 * The independence a claim view presents (C-b CB-06..CB-09): the server's `modelIndependence`, confirmed by the shared
 * gate over the payload's rows (`claimPresentedIndependence`), and the gate's identity of those rows.
 */
export function claimViewIndependence(data: Pick<ClaimVerificationClientPayload, "modelIndependence" | "modelEvidence">): {
  independence: ReturnType<typeof claimPresentedIndependence>;
  identity: RunExecutionIdentity;
} {
  return {
    independence: claimPresentedIndependence(data.modelIndependence, data.modelEvidence),
    identity: claimRowsExecutionIdentity(data.modelEvidence),
  };
}

/** True when the view's counts of rows are counts of independent executing models (verified, every answering slot its own model). */
function slotCountsAreModelCounts(view: ReturnType<typeof claimViewIndependence>): boolean {
  return view.independence === "independent" && view.identity.verified && rendersAsIndependent(view.identity);
}

/** C-b CB-07: what the slot counts of a qualified claim are (stated once, after the counts). */
export function claimSlotCountsNote(view: ReturnType<typeof claimViewIndependence>): string {
  // Never more than the presented independence states: an "unverified" claim states no K, whatever its rows hold.
  const statement =
    view.independence === "unverified"
      ? "model independence unverified"
      : view.identity.verified
        ? runSlotStatement(view.identity)
        : "fewer than two independent models answered";
  return `These counts are of panel slots (${statement}), not of agreeing models.`;
}

/**
 * When automatic phrase extraction finds nothing, explain counts from the stored verdicts. The counts are of models
 * only when every answering slot is its own verified executing model (C-b CB-07); otherwise they are stated as panel
 * slots, with what the shared gate establishes about them. Slots with no usable verdict are never counted as rating it.
 */
function agreementSectionFallbackCopy(data: ClaimVerificationClientPayload): string {
  const rows = data.modelEvidence;
  if (rows.length === 0) {
    return "No strong cross-model agreement phrases detected automatically.";
  }
  const view = claimViewIndependence(data);
  const asModels = slotCountsAreModelCounts(view);
  const unit = (n: number) => (asModels ? `model${n === 1 ? "" : "s"}` : `panel slot${n === 1 ? "" : "s"}`);

  const notVerified = rows.filter(
    (m) =>
      m.verdict === "unverifiable" ||
      m.verdict === "parse_error" ||
      m.verdict === "failed"
  );
  const accurate = rows.filter((m) => m.status === "ok" && m.verdict === "accurate");
  const partial = rows.filter((m) => m.status === "ok" && m.verdict === "partially_accurate");
  const inaccurate = rows.filter((m) => m.status === "ok" && m.verdict === "inaccurate");

  const sentences: string[] = [];
  const total = rows.length;

  if (notVerified.length > 0) {
    sentences.push(
      `${notVerified.length} of ${total} ${unit(total)} could not verify this claim.`
    );
  }

  const describeVerdictGroup = (
    models: typeof accurate,
    singularLabel: string,
    pluralLabel: string
  ) => {
    if (models.length === 0) return;
    const names = models.map((m) => runModelFamilyName(m.modelId as ModelId));
    const namePhrase =
      names.length === 1
        ? names[0]
        : names.length === 2
          ? `${names[0]} and ${names[1]}`
          : `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
    if (models.length === 1) {
      sentences.push(`1 ${unit(1)} (${namePhrase}) rated it as ${singularLabel}.`);
    } else {
      sentences.push(`${models.length} ${unit(models.length)} (${namePhrase}) rated it as ${pluralLabel}.`);
    }
  };

  describeVerdictGroup(accurate, "accurate", "accurate");
  describeVerdictGroup(partial, "partially accurate", "partially accurate");
  describeVerdictGroup(inaccurate, "inaccurate", "inaccurate");

  if (sentences.length === 0) {
    return "No strong cross-model agreement phrases detected automatically.";
  }
  if (!asModels) sentences.push(claimSlotCountsNote(view));
  return sentences.join(" ");
}

/** Pure text for "Copy verdict". Formatting only — the caller decides whether and how to write it anywhere. */
export function buildClaimVerdictClipboardText(data: ClaimVerificationClientPayload): string {
  const lines: string[] = [];
  lines.push(`ConvergePanel — Claim result`);
  lines.push(`Claim: ${data.claim}`);
  lines.push(`Aggregate verdict: ${data.verdict}`);
  // A multi-model consensus score only with >= 2 independent executing models (claimConsensusPresentation), confirmed
  // by the shared gate over the payload's rows (C-b CB-08).
  const { independence } = claimViewIndependence(data);
  const consensus = claimConsensusDisplay(data.consensusScore, independence);
  const qualifier = claimVerdictQualifier(independence);
  if (consensus.kind === "score") {
    lines.push(`Consensus score: ${consensus.score} (${data.confidenceLabel} confidence)`);
  } else {
    lines.push(`Verdict basis: ${qualifier}`);
    lines.push(`Consensus score: ${consensus.text}`);
  }
  lines.push("");
  lines.push("Per model:");
  for (const m of data.modelEvidence) {
    lines.push(`- ${runModelFamilyName(m.modelId as ModelId)}: ${formatVerdictLabel(m.verdict)} — ${m.summary}`);
  }
  if (data.whereModelsAgree.length) {
    lines.push("");
    lines.push(consensus.kind === "score" ? "Where models agree:" : `${CLAIM_NOT_INDEPENDENT_AGREE_HEADING}:`);
    data.whereModelsAgree.forEach((x) => lines.push(`• ${x}`));
  }
  if (data.whereModelsDisagree.length) {
    lines.push("");
    lines.push(consensus.kind === "score" ? "Where models disagree:" : `${CLAIM_NOT_INDEPENDENT_DISAGREE_HEADING}:`);
    data.whereModelsDisagree.forEach((x) => lines.push(`• ${x.point} [${x.models.join(", ")}]`));
  }
  lines.push(CLAIM_VERDICT_CLIPBOARD_DISCLAIMER.trimEnd());
  return lines.join("\n");
}

/**
 * Intrinsic audit-trail DETAILS derived from the stored audit bundle (run id,
 * timestamp, verdict, consensus, per-model pipeline status). Presentation only:
 * the surrounding panel, its toggle and any JSON copy/download stay with the
 * caller.
 */
export function ClaimVerificationAuditTrailDetails({ data }: { data: ClaimVerificationClientPayload }) {
  const bundle = data.auditBundle;
  const evidenceQ = data.evidenceQuality ?? bundle.evidenceQuality;
  // The stored bundle is shown as recorded, except that its cross-model figures (consensus, and the confidence and
  // evidence quality derived with it) are not presented as a consensus below two independent models.
  const view = claimViewIndependence(data);
  const consensus = claimConsensusDisplay(bundle.consensusScore, view.independence);
  return (
    <>
      <h3 className="text-sm font-semibold text-cp-text tracking-tight">Audit trail</h3>
      <dl className="mt-4 space-y-2.5 text-sm">
        <div className="grid grid-cols-[7.5rem_1fr] gap-x-3 gap-y-1 items-baseline">
          <dt className="text-cp-faint shrink-0">Run ID</dt>
          <dd className="text-cp-text font-mono text-xs break-all">
            {data.verificationId ? truncateRunId(data.verificationId) : "—"}
          </dd>
          <dt className="text-cp-faint shrink-0">Timestamp</dt>
          <dd className="text-cp-text">{formatAuditTimestamp(bundle.generatedAt)}</dd>
          <dt className="text-cp-faint shrink-0">Claim</dt>
          <dd className="text-cp-text leading-snug">{truncateClaimForAudit(data.claim)}</dd>
          <dt className="text-cp-faint shrink-0">Verdict</dt>
          <dd>
            <span className={aggregateVerdictBadgeClass(data.verdict)}>
              {aggregateVerdictLabel(data.verdict)}
            </span>
          </dd>
          <dt className="text-cp-faint shrink-0">Consensus</dt>
          {consensus.kind === "score" ? (
            <dd className="text-cp-text font-semibold tabular-nums">{consensus.score}/100</dd>
          ) : (
            <dd className="text-cp-muted" data-testid="claim-audit-consensus-withheld">{consensus.text}</dd>
          )}
          {consensus.kind === "score" ? (
            <>
              <dt className="text-cp-faint shrink-0">Confidence</dt>
              <dd className={confidenceLabelTextClass(bundle.confidenceLabel)}>{bundle.confidenceLabel}</dd>
              <dt className="text-cp-faint shrink-0">Evidence</dt>
              <dd className={evidenceQualityTextClass(evidenceQ)}>{evidenceQ}</dd>
            </>
          ) : null}
        </div>
      </dl>

      <p className="mt-5 text-xs font-semibold uppercase tracking-wide text-cp-faint">
        {/* C-b CB-09: the stored bundle's rows are panel slots; they are model counts only for a verified run in which
            every answering slot is its own executing model. The bundle itself is shown as recorded. */}
        {slotCountsAreModelCounts(view) ? "Models" : "Panel slots"} ({bundle.perModel.length})
      </p>
      <ul className="mt-2 space-y-1.5 text-sm">
        {bundle.perModel.map((row) => {
          const ok = row.pipelineStatus === "ok";
          const icon = ok ? "✓" : "✗";
          const name = runModelFamilyName(row.modelId as ModelId);
          let verdictKey: string;
          let verdictDisplay: string;
          if (ok && row.verdictLabel) {
            verdictKey = row.verdictLabel;
            verdictDisplay = formatVerdictLabel(row.verdictLabel);
          } else if (row.pipelineStatus === "parse_error") {
            verdictKey = "parse_error";
            verdictDisplay = "Parse error";
          } else {
            verdictKey = "failed";
            verdictDisplay = "Failed";
          }
          return (
            <li key={row.modelId} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
              <span
                className={`w-4 shrink-0 text-center font-mono ${ok ? "text-emerald-600" : "text-rose-600"}`}
                aria-hidden
              >
                {icon}
              </span>
              <span className="text-cp-text font-medium">{name}</span>
              <span className="text-cp-faint">—</span>
              <span className={perModelAuditVerdictClass(verdictKey)}>{verdictDisplay}</span>
            </li>
          );
        })}
      </ul>
    </>
  );
}

export type ClaimVerificationResultViewProps = {
  data: ClaimVerificationClientPayload;
  noticeSurface?: ReactNode;
  governanceSurface?: ReactNode;
  actionsSurface?: ReactNode;
};

export default function ClaimVerificationResultView({
  data,
  noticeSurface,
  governanceSurface,
  actionsSurface,
}: ClaimVerificationResultViewProps) {
  const [openModels, setOpenModels] = useState<Record<string, boolean>>({});

  // C-b CB-06: the server's independence confirmed by the shared gate over the rows; counts come from the gate.
  const view = useMemo(() => claimViewIndependence(data), [data]);
  const independence = view.independence;
  const consensus = claimConsensusDisplay(data.consensusScore, independence);

  const banner = useMemo((): {
    className: string;
    icon: ReactNode;
    title: string;
    subtitle: string;
  } => {
    const v: ClaimVerdictUi =
      data.verdict === "confirmed" ||
      data.verdict === "disputed" ||
      data.verdict === "partially_true" ||
      data.verdict === "unverifiable"
        ? data.verdict
        : "unverifiable";
    if (independence !== "independent") {
      // Fewer than two independent executing models (or unknown execution): the verdict is not agreement between models.
      const tone = {
        confirmed: "bg-emerald-50 border-emerald-200 text-emerald-900",
        disputed: "bg-rose-50 border-rose-200 text-rose-900",
        partially_true: "bg-amber-50 border-amber-200 text-amber-900",
        unverifiable: "bg-cp-raised border-cp-border text-cp-text",
      }[v];
      return {
        className: tone,
        icon: AGGREGATE_VERDICT_ICONS[v],
        title: `${aggregateVerdictLabel(v)} — ${claimVerdictQualifier(independence)}`,
        subtitle: independence === "insufficient" ? CLAIM_SINGLE_MODEL_BANNER_SUBTITLE : CLAIM_UNVERIFIED_BANNER_SUBTITLE,
      };
    }
    // Independent executing models (the shared gate's K) and how many of them rated it accurate — never slot counts:
    // a failed slot is not an answer and a substitute model that answered several slots counts once.
    const u = view.identity.independentModels ?? 0;
    const a = independentModelsAmong(
      view.identity,
      data.modelEvidence.filter((m) => m.status === "ok" && m.verdict === "accurate").map((m) => m.modelId)
    );
    switch (v) {
      case "confirmed":
        return {
          className: "bg-emerald-50 border-emerald-200 text-emerald-900",
          icon: AGGREGATE_VERDICT_ICONS.confirmed,
          title: `This claim is supported by ${a}/${u} models`,
          subtitle: "Majority agreement: accurate",
        };
      case "disputed":
        return {
          className: "bg-rose-50 border-rose-200 text-rose-900",
          icon: AGGREGATE_VERDICT_ICONS.disputed,
          title: "Models disagree on this claim",
          subtitle: "Review per-model evidence below",
        };
      case "partially_true":
        return {
          className: "bg-amber-50 border-amber-200 text-amber-900",
          icon: AGGREGATE_VERDICT_ICONS.partially_true,
          title: "Core claim may hold — details need correction",
          subtitle: "Partial agreement across models",
        };
      case "unverifiable":
      default:
        return {
          className: "bg-cp-raised border-cp-border text-cp-text",
          icon: AGGREGATE_VERDICT_ICONS.unverifiable,
          title: "Models cannot verify this claim with sufficient confidence",
          subtitle: "Insufficient agreement or too many unknowns",
        };
    }
  }, [data, independence, view]);

  return (
    <div className="rounded-2xl border border-cp-border bg-cp-surface text-cp-text shadow-sm overflow-hidden">
      <div className="border-b border-cp-border bg-cp-primary-tint px-4 py-2.5 md:px-8">
        <p className="text-center text-[11px] leading-relaxed text-cp-muted md:text-left">
          <span className="mr-1" aria-hidden>
            ℹ️
          </span>
          ConvergePanel is an AI-assisted verification tool, not a forensic service. Results inform judgment —
          they don&apos;t replace it.{" "}
          <Link href="/terms" className="font-medium text-cp-accent underline-offset-2 hover:underline">
            Terms
          </Link>
        </p>
      </div>
      {noticeSurface}
      <div className={`border-b px-5 py-6 md:px-8 md:py-8 ${banner.className}`}>
        <div className="flex items-start gap-3">
          <span className="flex shrink-0 items-center justify-center pt-0.5">{banner.icon}</span>
          <div>
            <h2 className="text-xl md:text-2xl font-semibold tracking-tight">{banner.title}</h2>
            <p className="mt-1 text-sm opacity-90">{banner.subtitle}</p>
          </div>
        </div>
      </div>

      <div className="px-5 py-5 md:px-8 space-y-6 border-b border-cp-border-soft">
        <div className="rounded-xl border border-cp-border bg-cp-raised p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-cp-faint">Consensus</p>
          {consensus.kind === "withheld" ? (
            <div className="mt-2" data-testid="claim-consensus-withheld">
              <p className="text-base font-semibold text-cp-text">{consensus.text}</p>
              <p className="mt-1 text-xs text-cp-faint">{claimVerdictQualifier(independence)}</p>
            </div>
          ) : (
          <div className="mt-2 flex flex-wrap items-end gap-4">
            <div>
              <p className="text-3xl font-bold text-cp-text">{consensus.score}</p>
              <p className="text-xs text-cp-faint">Consensus score</p>
            </div>
            <div>
              <p className="text-lg font-semibold text-cp-accent">{data.confidenceLabel}</p>
              <p className="text-xs text-cp-faint">Confidence</p>
            </div>
            {data.evidenceQuality && (
              <div>
                <p className="text-lg font-semibold text-cp-text capitalize">{data.evidenceQuality}</p>
                <p className="text-xs text-cp-faint">Evidence quality</p>
              </div>
            )}
            {data.supportRatio != null && (
              <div>
                <p className="text-lg font-semibold text-cp-text">{Math.round(data.supportRatio * 100)}%</p>
                <p className="text-xs text-cp-faint">Support ratio</p>
              </div>
            )}
          </div>
          )}
          {governanceSurface}
        </div>

        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-cp-faint mb-1">Claim</p>
          <p className="text-sm md:text-base text-cp-text leading-relaxed whitespace-pre-wrap">{data.claim}</p>
        </div>

        {actionsSurface}
      </div>

      <div className="px-5 py-5 md:px-8 space-y-4 border-b border-cp-border-soft">
        <h3 className="text-sm font-semibold text-cp-text">Agreement &amp; disagreement</h3>
        {data.whereModelsAgree.length > 0 ? (
          <div>
            <p className="text-xs font-medium text-emerald-700 mb-2">
              {consensus.kind === "score" ? "Where models agree" : CLAIM_NOT_INDEPENDENT_AGREE_HEADING}
            </p>
            <ul className="list-disc pl-5 text-sm text-cp-text space-y-1">
              {data.whereModelsAgree.map((x, i) => (
                <li key={i}>{x}</li>
              ))}
            </ul>
          </div>
        ) : (
          <p className="text-sm text-cp-muted leading-relaxed">{agreementSectionFallbackCopy(data)}</p>
        )}
        {data.whereModelsDisagree.length > 0 && (
          <div>
            <p className="text-xs font-medium text-rose-700 mb-2">
              {consensus.kind === "score" ? "Where models disagree" : CLAIM_NOT_INDEPENDENT_DISAGREE_HEADING}
            </p>
            <ul className="list-disc pl-5 text-sm text-cp-text space-y-1">
              {data.whereModelsDisagree.map((x, i) => (
                <li key={i}>
                  {x.point}
                  {x.models?.length ? (
                    <span className="text-cp-faint"> — {x.models.join(", ")}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="px-5 py-5 md:px-8">
        <h3 className="text-sm font-semibold text-cp-text mb-3">Per-model evidence</h3>
        <div className="space-y-3">
          {data.modelEvidence.map((m) => {
            const open = openModels[m.modelId] ?? false;
            return (
              <div key={m.modelId} className="rounded-xl border border-cp-border bg-cp-surface overflow-hidden">
                <button
                  type="button"
                  onClick={() => setOpenModels((s) => ({ ...s, [m.modelId]: !open }))}
                  className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left hover:bg-cp-raised transition-colors"
                >
                  <div className="flex flex-wrap items-center gap-2 min-w-0">
                    <span className="font-medium text-cp-text truncate">
                      {runModelFamilyName(m.modelId as ModelId)}
                    </span>
                    <span
                      className={`shrink-0 rounded-full border px-2 py-0.5 text-xs font-medium ${verdictBadgeClass(m.verdict)}`}
                    >
                      {formatVerdictLabel(m.verdict)}
                    </span>
                    {m.status && m.status !== "ok" && (
                      <span className="text-xs text-cp-faint">({m.status})</span>
                    )}
                  </div>
                  <span className="text-cp-faint text-sm">{open ? "▲" : "▼"}</span>
                </button>
                {open && (
                  <div className="px-4 pb-4 pt-0 space-y-3 border-t border-cp-border-soft">
                    <p className="text-sm text-cp-text mt-3">{m.summary}</p>
                    {m.correctParts.length > 0 && (
                      <div>
                        <p className="text-xs font-semibold text-emerald-700 mb-1">Correct parts</p>
                        <ul className="list-disc pl-5 text-sm text-cp-text space-y-1">
                          {m.correctParts.map((c, i) => (
                            <li key={i}>{c}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {m.incorrectParts.length > 0 && (
                      <div>
                        <p className="text-xs font-semibold text-rose-700 mb-1">Incorrect / misleading</p>
                        <ul className="list-disc pl-5 text-sm text-cp-text space-y-1">
                          {m.incorrectParts.map((c, i) => (
                            <li key={i}>{c}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {m.unverifiableParts.length > 0 && (
                      <div>
                        <p className="text-xs font-semibold text-cp-faint mb-1">Unverifiable</p>
                        <ul className="list-disc pl-5 text-sm text-cp-muted space-y-1">
                          {m.unverifiableParts.map((c, i) => (
                            <li key={i}>{c}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="border-t border-cp-border-soft px-5 py-5 md:px-8">
        <div className="space-y-2 rounded-lg border border-cp-border bg-cp-raised p-4 text-xs text-cp-muted">
          <p className="font-semibold text-cp-text">Disclaimer</p>
          <p>
            Claim verification results are generated by multiple AI language models and reflect their training data
            and reasoning capabilities at the time of the query. Results do not constitute fact-checking by human
            experts, journalistic verification, or legal determination of truth. AI models may hallucinate, reason
            incorrectly, or lack access to current information.
          </p>
          <p>
            Do not use these results as the sole basis for publishing claims, making business decisions, or taking
            legal action. Always verify important claims through authoritative primary sources.
          </p>
          <p>
            <Link href="/terms" className="text-cp-accent underline-offset-2 hover:underline">
              Terms of Service
            </Link>
          </p>
        </div>
      </div>
    </div>
  );
}
