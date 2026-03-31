"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import {
  CheckCircle,
  AlertTriangle,
  AlertCircle,
  HelpCircle,
} from "lucide-react";
import { useAuth } from "@/components/AuthProvider";
import { GovernanceBadge } from "@/components/GovernanceBadge";
import type { VideoVerificationClientPayload } from "@/lib/verification/videoVerificationClientPayload";
import { VIDEO_VERDICT_CLIPBOARD_DISCLAIMER } from "@/lib/legal/clipboardDisclaimers";
import { VIDEO_VERIFICATION_DISCLAIMER } from "@/lib/legal/videoVerificationDisclaimer";

const BUTTON_OUTLINE_SECONDARY =
  "rounded-lg border border-gray-500 px-4 py-2 text-sm font-medium text-gray-300 hover:bg-gray-700 transition-colors";

const BUTTON_AUDIT_TRAIL_ACTIVE =
  "rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors";

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

function supportPercent(score: number): number {
  if (score <= 1 && score > 0) return Math.round(score * 100);
  return Math.round(score);
}

function truncateId(id: string): string {
  const t = id.trim();
  if (t.length <= 12) return t;
  return `${t.slice(0, 12)}…`;
}

function formatAuditTimestamp(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString();
}

const verdictConfig: Record<
  string,
  {
    icon: ReactNode;
    className: string;
    title: string;
    subtitle: string;
  }
> = {
  authentic: {
    icon: <CheckCircle className="w-8 h-8 shrink-0 text-green-400" aria-hidden />,
    className: "bg-green-900/30 border-l-4 border-green-500",
    title: "No significant manipulation indicators detected",
    subtitle: "Models found no strong evidence of AI generation or manipulation",
  },
  likely_manipulated: {
    icon: <AlertTriangle className="w-8 h-8 shrink-0 text-red-400" aria-hidden />,
    className: "bg-red-900/30 border-l-4 border-red-500",
    title: "Multiple models detected manipulation indicators",
    subtitle: "Review the per-model evidence below for details",
  },
  inconclusive: {
    icon: <AlertCircle className="w-8 h-8 shrink-0 text-amber-400" aria-hidden />,
    className: "bg-amber-900/30 border-l-4 border-amber-500",
    title: "Models cannot determine authenticity with confidence",
    subtitle: "Mixed signals — human judgment required",
  },
  insufficient: {
    icon: <HelpCircle className="w-8 h-8 shrink-0 text-gray-400" aria-hidden />,
    className: "bg-gray-800 border-l-4 border-gray-500",
    title: "Insufficient data for meaningful analysis",
    subtitle: "Video may be too short, low quality, or heavily compressed",
  },
};

function ModelEvidenceCard({ model }: { model: VideoVerificationClientPayload["modelEvidence"][number] }) {
  const [expanded, setExpanded] = useState(false);

  const verdictColor =
    model.verdict === "authentic"
      ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300"
      : model.verdict === "likely_manipulated"
        ? "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300"
        : model.verdict === "inconclusive"
          ? "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300"
          : "bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300";

  const statusBadge =
    model.status === "ok"
      ? null
      : model.status === "parse_error"
        ? "bg-gray-500 text-white"
        : "bg-red-500 text-white";

  const verdictLabel =
    model.verdict === "likely_manipulated"
      ? "Likely manipulated"
      : model.verdict
        ? model.verdict.charAt(0).toUpperCase() + model.verdict.slice(1)
        : "—";

  return (
    <div className="border border-slate-700 rounded-lg mb-2 overflow-hidden bg-slate-900/40">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between gap-2 p-3 hover:bg-slate-800/60 text-left"
      >
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <span className="font-medium text-slate-100 truncate">{model.modelName || model.modelId}</span>
          <span className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${verdictColor}`}>{verdictLabel}</span>
          {model.confidence && (
            <span className="text-xs text-slate-400 shrink-0">({model.confidence} confidence)</span>
          )}
          {statusBadge && (
            <span className={`text-xs px-2 py-0.5 rounded-full shrink-0 ${statusBadge}`}>{model.status}</span>
          )}
        </div>
        <span className="text-slate-500 shrink-0">{expanded ? "▲" : "▼"}</span>
      </button>

      {expanded && (
        <div className="p-4 border-t border-slate-700 text-sm space-y-3">
          {model.summary && <p className="text-slate-300">{model.summary}</p>}

          {model.manipulationSignals?.length > 0 && (
            <div>
              <h5 className="font-medium text-red-400 mb-1">Manipulation signals</h5>
              <ul className="list-disc list-inside space-y-0.5">
                {model.manipulationSignals.map((s, j) => (
                  <li key={j} className="text-red-200">
                    {s}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {model.authenticitySignals?.length > 0 && (
            <div>
              <h5 className="font-medium text-green-400 mb-1">Authenticity signals</h5>
              <ul className="list-disc list-inside space-y-0.5">
                {model.authenticitySignals.map((s, j) => (
                  <li key={j} className="text-green-200">
                    {s}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {model.visualIndicators?.length > 0 && (
            <div>
              <h5 className="font-medium text-slate-200 mb-1">Visual observations</h5>
              <ul className="list-disc list-inside space-y-0.5 text-slate-400">
                {model.visualIndicators.map((s, j) => (
                  <li key={j}>{s}</li>
                ))}
              </ul>
            </div>
          )}

          {model.metadataIndicators?.length > 0 && (
            <div>
              <h5 className="font-medium text-slate-200 mb-1">Metadata indicators</h5>
              <ul className="list-disc list-inside space-y-0.5 text-slate-400">
                {model.metadataIndicators.map((s, j) => (
                  <li key={j}>{s}</li>
                ))}
              </ul>
            </div>
          )}

          {model.compressionNotes?.length > 0 && (
            <div>
              <h5 className="font-medium text-slate-500 mb-1">Compression notes</h5>
              <ul className="list-disc list-inside space-y-0.5 text-slate-500 italic">
                {model.compressionNotes.map((s, j) => (
                  <li key={j}>{s}</li>
                ))}
              </ul>
            </div>
          )}

          {model.limitations?.length > 0 && (
            <div>
              <h5 className="font-medium text-slate-500 mb-1">Limitations</h5>
              <ul className="list-disc list-inside space-y-0.5 text-slate-400">
                {model.limitations.map((s, j) => (
                  <li key={j}>{s}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Renders a completed video verification: disclaimers above the verdict banner, consensus summary, metadata,
 * expandable per-model evidence, governance badge, copy/download audit helpers, and “verify another” reset.
 */
export default function VideoVerificationResult({
  data,
  onVerifyAnother,
}: {
  data: VideoVerificationClientPayload;
  onVerifyAnother: () => void;
}) {
  const { user, authReady } = useAuth();
  const [auditOpen, setAuditOpen] = useState(false);
  const [verdictCopied, setVerdictCopied] = useState(false);
  const verdictCopyResetRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [liveGov, setLiveGov] = useState<{
    status: "approved" | "needs_review" | "blocked" | null;
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
        const qs = new URLSearchParams({ runId: vid, collection: "videoVerifications" });
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
        /* keep cached */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [data.verificationId, user, authReady]);

  useEffect(() => {
    return () => {
      if (verdictCopyResetRef.current) clearTimeout(verdictCopyResetRef.current);
    };
  }, []);

  const config = verdictConfig[data.verdict] ?? verdictConfig.inconclusive;
  const supportPct = supportPercent(data.supportRatio);
  const evidenceQ = data.evidenceQuality;

  const buildAuditSnapshot = useCallback(() => {
    return {
      verificationId: data.verificationId,
      generatedAt: data.timestampIso ?? new Date().toISOString(),
      fileName: data.fileName,
      verdict: data.verdict,
      consensusScore: data.consensusScore,
      confidenceLabel: data.confidenceLabel,
      evidenceQuality: data.evidenceQuality,
      supportRatioPercent: supportPct,
      frameCount: data.frameCount,
      modelEvidence: data.modelEvidence.map((m) => ({
        modelId: m.modelId,
        modelName: m.modelName,
        status: m.status,
        verdict: m.verdict,
        confidence: m.confidence,
      })),
    };
  }, [data, supportPct]);

  const copyVerdict = useCallback(() => {
    const verdictLabels: Record<string, string> = {
      authentic: "Authentic",
      likely_manipulated: "Likely Manipulated",
      inconclusive: "Inconclusive",
      insufficient: "Insufficient for Analysis",
    };
    const text = [
      `VIDEO VERIFICATION RESULT`,
      `Verdict: ${verdictLabels[data.verdict] || data.verdict}`,
      `Consensus: ${data.consensusScore}/100 (${data.confidenceLabel})`,
      `Evidence quality: ${data.evidenceQuality}`,
      ``,
      `Video: ${data.metadata.duration}s, ${data.metadata.width}x${data.metadata.height}, ${data.metadata.format}`,
      `Frames analyzed: ${data.frameCount}`,
      ``,
      `Models:`,
      ...data.modelEvidence.map(
        (m) => `  ${m.modelName}: ${m.verdict} (${m.confidence} confidence) — ${m.summary}`
      ),
      ``,
      `⚠️ AI-assisted authenticity review — use as signals, not final authority.`,
      `Verified via ConvergePanel — convergepanel.com`,
      VIDEO_VERDICT_CLIPBOARD_DISCLAIMER.trimEnd(),
    ].join("\n");

    void navigator.clipboard.writeText(text).then(
      () => {
        setVerdictCopied(true);
        if (verdictCopyResetRef.current) clearTimeout(verdictCopyResetRef.current);
        verdictCopyResetRef.current = setTimeout(() => setVerdictCopied(false), 2000);
      },
      () => setVerdictCopied(false)
    );
  }, [data]);

  const bundle = buildAuditSnapshot();
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
    a.download = `video-verification-audit-${base}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [bundle, data.verificationId]);

  return (
    <div className="rounded-2xl border border-slate-700 bg-slate-950 text-slate-100 shadow-xl overflow-hidden">
      <div className="border-b border-sky-900/50 bg-sky-950/50 px-4 py-2.5 md:px-8">
        <p className="text-center text-[11px] leading-relaxed text-sky-200/95 md:text-left">
          <span className="mr-1" aria-hidden>
            ℹ️
          </span>
          ConvergePanel is an AI-assisted verification tool, not a forensic service. Results inform judgment —
          they don&apos;t replace it.{" "}
          <Link href="/terms" className="font-medium text-sky-300 underline-offset-2 hover:text-white hover:underline">
            Terms
          </Link>
        </p>
      </div>
      <div className="px-5 py-5 md:px-8 md:py-6 space-y-6 border-b border-slate-800">
        <div className="p-3 rounded-lg bg-amber-950/50 border border-amber-700/60">
          <p className="text-sm text-amber-100">
            ⚠️ {VIDEO_VERIFICATION_DISCLAIMER} Not a substitute for specialized lab or legal-grade analysis.
          </p>
        </div>

        <div className={`p-6 rounded-lg ${config.className}`}>
          <div className="flex items-start gap-4">
            {config.icon}
            <div>
              <h2 className="text-xl font-bold text-slate-50">{config.title}</h2>
              <p className="text-sm text-slate-200/90 mt-1">{config.subtitle}</p>
            </div>
          </div>
        </div>

        <div className="rounded-xl border border-slate-700 bg-slate-900/60 p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">Consensus</p>
          <div className="mt-2 flex flex-wrap items-end gap-4">
            <div>
              <p className="text-3xl font-bold text-white">{data.consensusScore}</p>
              <p className="text-xs text-slate-400">Consensus score</p>
            </div>
            <div>
              <p className="text-lg font-semibold text-sky-300">{data.confidenceLabel}</p>
              <p className="text-xs text-slate-400">Confidence</p>
            </div>
            <div>
              <p className="text-lg font-semibold text-slate-200 capitalize">{evidenceQ}</p>
              <p className="text-xs text-slate-400">Evidence quality</p>
            </div>
            <div>
              <p className="text-lg font-semibold text-slate-200">{supportPct}%</p>
              <p className="text-xs text-slate-400">Support ratio</p>
            </div>
          </div>
          <GovernanceBadge
            status={liveGov.status}
            theme="dark"
            reviewedBy={liveGov.reviewedByUid ?? undefined}
            reviewedAt={liveGov.reviewedAt ?? undefined}
            reviewComment={liveGov.comment ?? undefined}
            reviewerEmail={liveGov.reviewerEmail ?? undefined}
          />
        </div>

        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400 mb-1">File</p>
          <p className="text-sm text-slate-200">{data.fileName}</p>
        </div>

        <div className="rounded-xl border border-slate-700 bg-slate-900/40 p-4">
          <h3 className="font-semibold mb-3 text-slate-100">Video details</h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 text-sm mb-4">
            <div>
              <span className="text-slate-500">Duration:</span>{" "}
              <span className="font-medium text-slate-100">{formatDuration(data.metadata.duration)}</span>
            </div>
            <div>
              <span className="text-slate-500">Resolution:</span>{" "}
              <span className="font-medium text-slate-100">
                {data.metadata.width}x{data.metadata.height}
              </span>
            </div>
            <div>
              <span className="text-slate-500">Codec:</span>{" "}
              <span className="font-medium text-slate-100">
                {data.metadata.codec !== "unknown" && data.metadata.codec !== "—"
                  ? data.metadata.codec
                  : "N/A"}
              </span>
            </div>
            <div>
              <span className="text-slate-500">Frame rate:</span>{" "}
              <span className="font-medium text-slate-100">
                {data.metadata.frameRate > 0 ? `${data.metadata.frameRate}fps` : "N/A"}
              </span>
            </div>
            <div>
              <span className="text-slate-500">File size:</span>{" "}
              <span className="font-medium text-slate-100">
                {(data.metadata.fileSize / 1024 / 1024).toFixed(1)}MB
              </span>
            </div>
            <div>
              <span className="text-slate-500">Creation date:</span>{" "}
              <span className="font-medium text-slate-100">
                {data.metadata.createdAt?.trim() ? data.metadata.createdAt : "N/A"}
              </span>
            </div>
            <div>
              <span className="text-slate-500">Encoding software:</span>{" "}
              <span className="font-medium text-slate-100">
                {data.metadata.encodingSoftware?.trim() ? data.metadata.encodingSoftware : "N/A"}
              </span>
            </div>
            <div>
              <span className="text-slate-500">Has audio:</span>{" "}
              <span className="font-medium text-slate-100">
                {data.metadata.hasAudio ? "Yes" : "No"}
              </span>
            </div>
            <div>
              <span className="text-slate-500">Camera / device:</span>{" "}
              <span className="font-medium text-slate-100">
                {data.metadata.cameraModel?.trim() ? data.metadata.cameraModel : "N/A"}
              </span>
            </div>
            <div>
              <span className="text-slate-500">Frames analyzed:</span>{" "}
              <span className="font-medium text-slate-100">{data.frameCount}</span>
            </div>
          </div>

          {data.metadataAnalysis.flags.length > 0 && (
            <div className="border-t border-slate-700 pt-3 mt-3">
              <h4 className="text-sm font-medium text-slate-200 mb-2">Metadata flags</h4>
              {data.metadataAnalysis.flags.map((flag, i) => (
                <div key={i} className="flex items-start gap-2 text-sm mb-1">
                  <span
                    className={
                      flag.severity === "suspicious"
                        ? "text-red-400"
                        : flag.severity === "warning"
                          ? "text-amber-400"
                          : "text-slate-500"
                    }
                  >
                    {flag.severity === "suspicious" ? "🔴" : flag.severity === "warning" ? "⚠️" : "ℹ️"}
                  </span>
                  <span className="text-slate-300">
                    <span className="font-medium">{flag.field}:</span> {flag.observation}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        {(data.agreementPoints.length > 0 || data.disagreementPoints.length > 0) && (
          <div>
            <h3 className="font-semibold mb-3 text-slate-100">Agreement &amp; disagreement</h3>
            {data.agreementPoints.length > 0 && (
              <div className="mb-3">
                <h4 className="text-sm font-medium text-green-400 mb-1">Where models agree</h4>
                <ul className="list-disc list-inside text-sm text-slate-300 space-y-1">
                  {data.agreementPoints.map((point, i) => (
                    <li key={i}>{point}</li>
                  ))}
                </ul>
              </div>
            )}
            {data.disagreementPoints.length > 0 && (
              <div>
                <h4 className="text-sm font-medium text-red-400 mb-1">Where models disagree</h4>
                <ul className="list-disc list-inside text-sm text-slate-300 space-y-1">
                  {data.disagreementPoints.map((point, i) => (
                    <li key={i}>{point}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        <div>
          <h3 className="font-semibold mb-3 text-slate-100">Per-model evidence</h3>
          {data.modelEvidence.map((model) => (
            <ModelEvidenceCard key={`${model.modelId}-${model.status}`} model={model} />
          ))}
        </div>

        {data.warnings?.length > 0 && (
          <div className="p-3 rounded-lg bg-amber-950/40 border border-amber-800/50">
            <h4 className="text-sm font-medium text-amber-200 mb-1">Processing warnings</h4>
            <ul className="text-xs text-amber-100/90 list-disc list-inside">
              {data.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="flex flex-col sm:flex-row flex-wrap gap-2 sm:gap-3">
          <div className="relative inline-flex">
            <button type="button" onClick={copyVerdict} className={BUTTON_OUTLINE_SECONDARY}>
              Copy verdict
            </button>
            {verdictCopied ? (
              <span
                role="status"
                className="pointer-events-none absolute left-1/2 top-full z-10 mt-1.5 -translate-x-1/2 whitespace-nowrap rounded-md bg-slate-700 px-2.5 py-1 text-xs font-medium text-slate-100 shadow-lg ring-1 ring-slate-500/80"
              >
                Copied
              </span>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => setAuditOpen((o) => !o)}
            aria-pressed={auditOpen}
            className={auditOpen ? BUTTON_AUDIT_TRAIL_ACTIVE : BUTTON_OUTLINE_SECONDARY}
          >
            {auditOpen ? "Hide audit trail" : "View audit trail"}
          </button>
          <button type="button" onClick={onVerifyAnother} className={BUTTON_OUTLINE_SECONDARY}>
            Verify another video
          </button>
        </div>

        {auditOpen && (
          <div className="rounded-lg border border-slate-700 bg-slate-900 p-5 shadow-inner">
            <h3 className="text-sm font-semibold text-slate-100 tracking-tight">Audit trail</h3>
            <dl className="mt-4 space-y-2.5 text-sm">
              <div className="grid grid-cols-[7.5rem_1fr] gap-x-3 gap-y-1 items-baseline">
                <dt className="text-slate-500 shrink-0">Verification ID</dt>
                <dd className="text-slate-200 font-mono text-xs break-all">
                  {data.verificationId ? truncateId(data.verificationId) : "—"}
                </dd>
                <dt className="text-slate-500 shrink-0">Timestamp</dt>
                <dd className="text-slate-200">{formatAuditTimestamp(data.timestampIso)}</dd>
                <dt className="text-slate-500 shrink-0">File</dt>
                <dd className="text-slate-200 break-all">{data.fileName}</dd>
                <dt className="text-slate-500 shrink-0">Verdict</dt>
                <dd className="text-slate-200">{data.verdict}</dd>
                <dt className="text-slate-500 shrink-0">Consensus</dt>
                <dd className="text-white font-semibold tabular-nums">{data.consensusScore}/100</dd>
              </div>
            </dl>
            <p className="mt-5 text-xs font-semibold uppercase tracking-wide text-slate-500">
              Models ({data.modelEvidence.length})
            </p>
            <ul className="mt-2 space-y-1.5 text-sm text-slate-300">
              {data.modelEvidence.map((m) => (
                <li key={m.modelId}>
                  {m.modelName} — {m.verdict} ({m.status})
                </li>
              ))}
            </ul>
            <div className="mt-5 flex flex-wrap gap-2 border-t border-slate-700 pt-4">
              <button type="button" onClick={copyAuditJson} className={BUTTON_OUTLINE_SECONDARY}>
                Copy as JSON
              </button>
              <button type="button" onClick={downloadAuditJson} className={BUTTON_OUTLINE_SECONDARY}>
                Download .json
              </button>
            </div>
          </div>
        )}

        <div className="mt-8 space-y-2 rounded-lg border border-slate-600 bg-slate-900/50 p-4 text-xs text-slate-400">
          <p className="font-semibold text-slate-300">Important Legal Notice</p>
          <p>
            This analysis was generated by general-purpose AI vision models and does not constitute forensic
            analysis, expert examination, or legal evidence. Results may contain false positives or false
            negatives. The absence of manipulation indicators does not confirm authenticity. The presence of
            manipulation indicators does not confirm forgery.
          </p>
          <p>
            Do not use these results as evidence in legal proceedings, regulatory filings, insurance claims,
            employment decisions, or public accusations. If you require forensic-grade analysis, consult a
            certified digital forensics professional.
          </p>
          <p>
            By using this feature, you agree to ConvergePanel&apos;s{" "}
            <Link href="/terms" className="text-sky-400 underline-offset-2 hover:text-sky-300 hover:underline">
              Terms of Service
            </Link>{" "}
            and accept full responsibility for any actions taken based on these results.
          </p>
        </div>
      </div>
    </div>
  );
}
