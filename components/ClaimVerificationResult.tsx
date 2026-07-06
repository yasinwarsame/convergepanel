"use client";

/**
 * Claim verification results UI: aggregate verdict banner, consensus metrics, per-model
 * evidence rows, agreement digest, and optional policy / audit sections.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { HelpCircle, CheckCircle, AlertTriangle, AlertCircle } from "lucide-react";
import { getModelDisplayName } from "@/lib/modelInfo";
import type { ModelId } from "@/lib/types";
import type {
  ClaimVerificationClientPayload,
  ClaimVerdictUi,
} from "@/lib/verification/claimVerificationClientPayload";
import { useAuth } from "@/components/AuthProvider";
import { GovernanceBadge } from "@/components/GovernanceBadge";
import { VerificationActions } from "@/components/VerificationActions";
import { downloadTextFile, generateVerificationMemo } from "@/lib/verification/generateMemo";
import { CLAIM_VERDICT_CLIPBOARD_DISCLAIMER } from "@/lib/legal/clipboardDisclaimers";

export type { ClaimVerificationClientPayload, ClaimVerdictUi };

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

/** When automatic phrase extraction finds nothing, explain counts from model verdicts. */
function agreementSectionFallbackCopy(data: ClaimVerificationClientPayload): string {
  const rows = data.modelEvidence;
  if (rows.length === 0) {
    return "No strong cross-model agreement phrases detected automatically.";
  }

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
      `${notVerified.length} of ${total} model${total === 1 ? "" : "s"} could not verify this claim.`
    );
  }

  const describeVerdictGroup = (
    models: typeof accurate,
    singularLabel: string,
    pluralLabel: string
  ) => {
    if (models.length === 0) return;
    const names = models.map((m) => getModelDisplayName(m.modelId as ModelId));
    const namePhrase =
      names.length === 1
        ? names[0]
        : names.length === 2
          ? `${names[0]} and ${names[1]}`
          : `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;
    if (models.length === 1) {
      sentences.push(`1 model (${namePhrase}) rated it as ${singularLabel}.`);
    } else {
      sentences.push(`${models.length} models (${namePhrase}) rated it as ${pluralLabel}.`);
    }
  };

  describeVerdictGroup(accurate, "accurate", "accurate");
  describeVerdictGroup(partial, "partially accurate", "partially accurate");
  describeVerdictGroup(inaccurate, "inaccurate", "inaccurate");

  if (sentences.length === 0) {
    return "No strong cross-model agreement phrases detected automatically.";
  }
  return sentences.join(" ");
}

export default function ClaimVerificationResult({
  data,
  onVerifyAnother,
}: {
  data: ClaimVerificationClientPayload;
  onVerifyAnother: () => void;
}) {
  const { user, authReady } = useAuth();
  const [auditOpen, setAuditOpen] = useState(false);
  const [openModels, setOpenModels] = useState<Record<string, boolean>>({});

  const [liveGov, setLiveGov] = useState<{
    status: ClaimVerificationClientPayload["governanceStatus"] | null;
    reviewedByUid: string | null;
    reviewerEmail: string | null;
    reviewedAt: string | null;
    comment: string | null;
  }>(() => ({
    status: data.governanceStatus ?? null,
    reviewedByUid: null,
    reviewerEmail: null,
    reviewedAt: null,
    comment: null,
  }));

  useEffect(() => {
    setLiveGov({
      status: data.governanceStatus ?? null,
      reviewedByUid: null,
      reviewerEmail: null,
      reviewedAt: null,
      comment: null,
    });
  }, [data.verificationId, data.governanceStatus]);

  useEffect(() => {
    const vid = data.verificationId?.trim();
    if (!vid || !user || !authReady) return;
    let cancelled = false;
    (async () => {
      try {
        const { authedFetch } = await import("@/lib/client/authedFetch");
        const qs = new URLSearchParams({ runId: vid, collection: "verifications" });
        const res = await authedFetch(`/api/user/run-governance?${qs}`, {
          user,
          authReady,
          method: "GET",
          cache: "no-store",
        });
        const body = (await res.json()) as {
          ok?: boolean;
          governanceStatus?: string | null;
          governanceReviewedBy?: string | null;
          governanceReviewerEmail?: string | null;
          governanceReviewedAt?: string | null;
          governanceReviewComment?: string | null;
        };
        if (cancelled || !body?.ok) return;
        const gs = body.governanceStatus;
        setLiveGov({
          status:
            gs === "approved" || gs === "needs_review" || gs === "blocked"
              ? gs
              : null,
          reviewedByUid: body.governanceReviewedBy ?? null,
          reviewerEmail: body.governanceReviewerEmail ?? null,
          reviewedAt: body.governanceReviewedAt ?? null,
          comment: body.governanceReviewComment ?? null,
        });
      } catch {
        /* keep cached props */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [data.verificationId, user, authReady]);

  const banner = useMemo((): {
    className: string;
    icon: ReactNode;
    title: string;
    subtitle: string;
  } => {
    const u = data.usableModelCount ?? data.modelEvidence.filter((m) => m.status === "ok").length;
    const a = data.accurateAmongUsable ?? data.modelEvidence.filter((m) => m.status === "ok" && m.verdict === "accurate").length;

    const v: ClaimVerdictUi =
      data.verdict === "confirmed" ||
      data.verdict === "disputed" ||
      data.verdict === "partially_true" ||
      data.verdict === "unverifiable"
        ? data.verdict
        : "unverifiable";
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
  }, [data]);

  const bundle = data.auditBundle;
  const evidenceQ = data.evidenceQuality ?? bundle.evidenceQuality;

  const copyVerdict = useCallback((): Promise<void> => {
    const lines: string[] = [];
    lines.push(`ConvergePanel — Claim result`);
    lines.push(`Claim: ${data.claim}`);
    lines.push(`Aggregate verdict: ${data.verdict}`);
    lines.push(`Consensus score: ${data.consensusScore} (${data.confidenceLabel} confidence)`);
    lines.push("");
    lines.push("Per model:");
    for (const m of data.modelEvidence) {
      lines.push(`- ${getModelDisplayName(m.modelId as ModelId)}: ${formatVerdictLabel(m.verdict)} — ${m.summary}`);
    }
    if (data.whereModelsAgree.length) {
      lines.push("");
      lines.push("Where models agree:");
      data.whereModelsAgree.forEach((x) => lines.push(`• ${x}`));
    }
    if (data.whereModelsDisagree.length) {
      lines.push("");
      lines.push("Where models disagree:");
      data.whereModelsDisagree.forEach((x) => lines.push(`• ${x.point} [${x.models.join(", ")}]`));
    }
    lines.push(CLAIM_VERDICT_CLIPBOARD_DISCLAIMER.trimEnd());
    return navigator.clipboard.writeText(lines.join("\n"));
  }, [data]);

  const handleExportMemo = useCallback(() => {
    const memo = generateVerificationMemo({
      type: "claim",
      claim: data.claim,
      verdict: data.verdict,
      consensusScore: data.consensusScore,
      confidenceLabel: data.confidenceLabel,
      evidenceQuality: typeof evidenceQ === "string" ? evidenceQ : "mixed",
      modelEvidence: data.modelEvidence.map((m) => ({
        modelId: m.modelId,
        status: m.status,
        verdict: m.verdict,
        confidence: m.confidence,
        summary: m.summary,
        correctParts: m.correctParts,
        incorrectParts: m.incorrectParts,
        unverifiableParts: m.unverifiableParts,
      })),
      agreementPoints: data.whereModelsAgree,
      disagreementPoints: data.whereModelsDisagree.map((d) => d.point),
      verificationId: data.verificationId ?? "",
    });
    const base = data.verificationId?.replace(/[^a-zA-Z0-9-_]+/g, "-").slice(0, 48) || String(Date.now());
    downloadTextFile(memo, `claim-memo-${base}.txt`);
  }, [data, evidenceQ]);

  const showGov =
    data.governanceReviewRequired ||
    data.blockedByPolicy ||
    (data.policyFlags && data.policyFlags.length > 0);

  const copyAuditJson = useCallback(() => {
    void navigator.clipboard.writeText(JSON.stringify(bundle, null, 2));
  }, [bundle]);

  const downloadAuditJson = useCallback(() => {
    const base =
      data.verificationId?.replace(/[^a-zA-Z0-9-_]+/g, "-").slice(0, 48) || `audit-${Date.now()}`;
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `claim-verification-audit-${base}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [bundle, data.verificationId]);

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
      {showGov && (
        <div
          className={`border-b px-5 py-4 md:px-8 ${
            data.blockedByPolicy
              ? "bg-rose-50 border-rose-200 text-rose-900"
              : "bg-amber-50 border-amber-200 text-amber-900"
          }`}
          role="alert"
        >
          <p className="font-semibold text-sm">
            {data.blockedByPolicy ? "Blocked by team policy" : "Team governance review"}
          </p>
          <p className="text-sm mt-1 opacity-95">
            {data.policyBlockMessage ||
              "This result was flagged by your team's governance policy. Human review may be required before acting on it."}
          </p>
          {data.policyFlags && data.policyFlags.length > 0 && (
            <ul className="mt-2 list-disc pl-5 text-xs opacity-90">
              {data.policyFlags.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          )}
        </div>
      )}
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
          <div className="mt-2 flex flex-wrap items-end gap-4">
            <div>
              <p className="text-3xl font-bold text-cp-text">{data.consensusScore}</p>
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
          <GovernanceBadge
            status={liveGov.status}
            theme="light"
            reviewedBy={liveGov.reviewedByUid ?? undefined}
            reviewedAt={liveGov.reviewedAt ?? undefined}
            reviewComment={liveGov.comment ?? undefined}
            reviewerEmail={liveGov.reviewerEmail ?? undefined}
            viewerEmail={user?.email ?? undefined}
          />
        </div>

        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-cp-faint mb-1">Claim</p>
          <p className="text-sm md:text-base text-cp-text leading-relaxed whitespace-pre-wrap">{data.claim}</p>
        </div>

        <VerificationActions
          type="claim"
          onCopy={copyVerdict}
          onExportMemo={handleExportMemo}
          onViewAuditTrail={() => setAuditOpen((o) => !o)}
          showAuditTrail={auditOpen}
          onVerifyAnother={onVerifyAnother}
          copyLabel="Copy verdict"
          verifyAnotherLabel="Verify another claim"
        />

        {auditOpen && (
          <div className="rounded-lg border border-cp-border bg-cp-raised p-5">
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
                <dd className="text-cp-text font-semibold tabular-nums">{bundle.consensusScore}/100</dd>
                <dt className="text-cp-faint shrink-0">Confidence</dt>
                <dd className={confidenceLabelTextClass(bundle.confidenceLabel)}>{bundle.confidenceLabel}</dd>
                <dt className="text-cp-faint shrink-0">Evidence</dt>
                <dd className={evidenceQualityTextClass(evidenceQ)}>{evidenceQ}</dd>
              </div>
            </dl>

            <p className="mt-5 text-xs font-semibold uppercase tracking-wide text-cp-faint">
              Models ({bundle.perModel.length})
            </p>
            <ul className="mt-2 space-y-1.5 text-sm">
              {bundle.perModel.map((row) => {
                const ok = row.pipelineStatus === "ok";
                const icon = ok ? "✓" : "✗";
                const name = getModelDisplayName(row.modelId as ModelId);
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

            <div className="mt-5 flex flex-wrap gap-2 border-t border-cp-border pt-4">
              <button
                type="button"
                onClick={copyAuditJson}
                className="rounded-[10px] border border-cp-border px-4 py-2 text-xs font-medium text-cp-muted hover:bg-cp-surface transition-colors"
              >
                Copy as JSON
              </button>
              <button
                type="button"
                onClick={downloadAuditJson}
                className="rounded-[10px] border border-cp-border px-4 py-2 text-xs font-medium text-cp-muted hover:bg-cp-surface transition-colors"
              >
                Download .json
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="px-5 py-5 md:px-8 space-y-4 border-b border-cp-border-soft">
        <h3 className="text-sm font-semibold text-cp-text">Agreement &amp; disagreement</h3>
        {data.whereModelsAgree.length > 0 ? (
          <div>
            <p className="text-xs font-medium text-emerald-700 mb-2">Where models agree</p>
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
            <p className="text-xs font-medium text-rose-700 mb-2">Where models disagree</p>
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
                      {getModelDisplayName(m.modelId as ModelId)}
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
