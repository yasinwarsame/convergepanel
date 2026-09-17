"use client";

/**
 * TEAM-VERIFICATION-PARITY-R2 — SHARED, READ-ONLY Video verification result
 * presentation.
 *
 * Renders a stored Video verification result only: disclaimers, verdict
 * banner, consensus metrics, file name, video details and metadata flags,
 * agreement digest, expandable per-model evidence, processing warnings and the
 * legal notice. It never needs the original video bytes. It owns NO auth, NO
 * network, NO governance lookup, NO export/download, NO execution and NO
 * application navigation; the only links are the static `/terms` legal links.
 *
 * Caller-specific surfaces arrive through explicit slots; an absent slot
 * renders nothing (never a Personal fallback):
 *   - `governanceSurface` at the end of the consensus card
 *   - `actionsSurface`    after processing warnings, before the legal notice
 *
 * `VideoVerificationResult` (the Personal wrapper) supplies today's Personal
 * governance fetch/badge, actions, audit trail and Verify Another.
 */

import { useState, type ReactNode } from "react";
import Link from "next/link";
import {
  CheckCircle,
  AlertTriangle,
  AlertCircle,
  HelpCircle,
  Film,
} from "lucide-react";
import type { VideoVerificationClientPayload } from "@/lib/verification/videoVerificationClientPayload";
import { VIDEO_VERDICT_CLIPBOARD_DISCLAIMER } from "@/lib/legal/clipboardDisclaimers";
import { VIDEO_VERIFICATION_DISCLAIMER } from "@/lib/legal/videoVerificationDisclaimer";

function formatDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

/** Stored support ratio as a whole percentage (0–1 fractions are scaled). */
export function supportPercent(score: number): number {
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
  authentic_captured: {
    icon: <CheckCircle className="w-8 h-8 shrink-0 text-green-400" aria-hidden />,
    className: "bg-green-900/30 border-l-4 border-green-500",
    title: "Authentic camera footage",
    subtitle: "Models found no manipulation indicators. Metadata consistent with a physical capture device.",
  },
  authentic_produced: {
    icon: <Film className="w-8 h-8 shrink-0 text-blue-400" aria-hidden />,
    className: "bg-blue-900/30 border-l-4 border-blue-500",
    title: "Legitimately produced content",
    subtitle:
      "This appears to be animation, motion graphics, or professional production — not deceptive manipulation.",
  },
  likely_manipulated: {
    icon: <AlertTriangle className="w-8 h-8 shrink-0 text-red-400" aria-hidden />,
    className: "bg-red-900/30 border-l-4 border-red-500",
    title: "Deceptive manipulation indicators detected",
    subtitle: "Multiple models detected signs that this content misrepresents reality. Review per-model evidence.",
  },
  inconclusive: {
    icon: <AlertCircle className="w-8 h-8 shrink-0 text-amber-400" aria-hidden />,
    className: "bg-amber-900/30 border-l-4 border-amber-500",
    title: "Models cannot determine with confidence",
    subtitle: "Mixed signals — human judgment required.",
  },
  insufficient: {
    icon: <HelpCircle className="w-8 h-8 shrink-0 text-gray-400" aria-hidden />,
    className: "bg-gray-800 border-l-4 border-gray-500",
    title: "Insufficient data for meaningful analysis",
    subtitle: "Video may be too short, low quality, or heavily compressed.",
  },
  authentic: {
    icon: <CheckCircle className="w-8 h-8 shrink-0 text-green-400" aria-hidden />,
    className: "bg-green-900/30 border-l-4 border-green-500",
    title: "No significant manipulation indicators detected",
    subtitle: "Models found no strong evidence of manipulation.",
  },
};

const contentTypeLabels: Record<string, string> = {
  camera_footage: "Camera Footage",
  animation: "Animation",
  screen_recording: "Screen Recording",
  ai_generated_creative: "AI-Generated (Creative/Non-Deceptive)",
  ai_generated_deceptive: "AI-Generated (Deceptive)",
  mixed: "Mixed Content",
  unknown: "Unknown",
};

function modelRowVerdictLabel(verdict: string): string {
  const map: Record<string, string> = {
    authentic_captured: "Authentic (camera)",
    authentic_produced: "Authentic (produced)",
    likely_manipulated: "Likely manipulated",
    inconclusive: "Inconclusive",
    insufficient: "Insufficient",
    authentic: "Authentic",
  };
  return map[verdict] ?? (verdict ? verdict.charAt(0).toUpperCase() + verdict.slice(1) : "—");
}

function ModelEvidenceCard({ model }: { model: VideoVerificationClientPayload["modelEvidence"][number] }) {
  const [expanded, setExpanded] = useState(false);

  const verdictColor =
    model.verdict === "authentic_captured" || model.verdict === "authentic"
      ? "bg-green-100 text-green-800"
      : model.verdict === "authentic_produced"
        ? "bg-blue-100 text-blue-800"
        : model.verdict === "likely_manipulated"
          ? "bg-red-100 text-red-800"
          : model.verdict === "inconclusive"
            ? "bg-amber-100 text-amber-800"
            : "bg-gray-100 text-gray-800";

  const statusBadgeEl =
    model.status === "ok" ? null : model.status === "refused" ? (
      <span className="text-xs px-2 py-0.5 rounded-full shrink-0 bg-amber-100 text-amber-800">
        Declined
      </span>
    ) : model.status === "parse_error" ? (
      <span className="text-xs px-2 py-0.5 rounded-full shrink-0 bg-gray-100 text-gray-800">
        Parse error
      </span>
    ) : (
      <span className="text-xs px-2 py-0.5 rounded-full shrink-0 bg-red-100 text-red-800">
        Error
      </span>
    );

  const verdictLabel = modelRowVerdictLabel(model.verdict);

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
          {statusBadgeEl}
        </div>
        <span className="text-slate-500 shrink-0">{expanded ? "▲" : "▼"}</span>
      </button>

      {expanded && (
        <div className="p-4 border-t border-slate-700 text-sm space-y-3">
          {model.status === "refused" && (
            <p className="text-sm text-amber-600 italic">
              This model declined to analyze the video due to its content policy. This is not a reflection on the
              video&apos;s authenticity — some models have restrictions on certain visual content.
            </p>
          )}
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

          {model.productionSignals && model.productionSignals.length > 0 && (
            <div>
              <h5 className="font-medium text-blue-600 mb-1">Production signals</h5>
              <ul className="list-disc list-inside space-y-0.5">
                {model.productionSignals.map((s, j) => (
                  <li key={j} className="text-blue-700">
                    {s}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {model.deceptionIndicators && model.deceptionIndicators.length > 0 && (
            <div>
              <h5 className="font-medium text-red-600 mb-1">Deception indicators</h5>
              <ul className="list-disc list-inside space-y-0.5">
                {model.deceptionIndicators.map((s, j) => (
                  <li key={j} className="text-red-700">
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

/** Pure text for "Copy verdict". Formatting only — the caller decides whether and how to write it anywhere. */
export function buildVideoVerdictClipboardText(data: VideoVerificationClientPayload): string {
  const verdictText: Record<string, string> = {
    authentic_captured: "Authentic — Camera footage with no manipulation indicators",
    authentic_produced: "Authentic — Legitimately produced content (not deceptive)",
    likely_manipulated: "Likely Manipulated — Deceptive manipulation indicators detected",
    inconclusive: "Inconclusive — Human judgment required",
    insufficient: "Insufficient — Not enough data for analysis",
    authentic: "Authentic — Legacy summary (camera-style authenticity)",
  };
  const ct =
    data.contentType && data.contentType !== "unknown"
      ? contentTypeLabels[data.contentType] || data.contentType
      : null;
  return [
    `VIDEO VERIFICATION RESULT`,
    `Verdict: ${verdictText[data.verdict] || data.verdict}`,
    ...(ct ? [`Content type: ${ct}`] : []),
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
}

/**
 * Intrinsic audit-trail DETAILS derived from the stored result (verification
 * id, timestamp, file, verdict, consensus, per-model status). Presentation
 * only: the surrounding panel, its toggle and any JSON copy/download stay with
 * the caller.
 */
export function VideoVerificationAuditTrailDetails({ data }: { data: VideoVerificationClientPayload }) {
  return (
    <>
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
    </>
  );
}

export type VideoVerificationResultViewProps = {
  data: VideoVerificationClientPayload;
  governanceSurface?: ReactNode;
  actionsSurface?: ReactNode;
};

export default function VideoVerificationResultView({
  data,
  governanceSurface,
  actionsSurface,
}: VideoVerificationResultViewProps) {
  const config = verdictConfig[data.verdict] ?? verdictConfig.inconclusive;
  const supportPct = supportPercent(data.supportRatio);
  const evidenceQ = data.evidenceQuality;

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
            <div className="min-w-0 flex-1">
              <h2 className="text-xl font-bold text-slate-50">{config.title}</h2>
              <p className="text-sm text-slate-200/90 mt-1">{config.subtitle}</p>
              {data.contentType && data.contentType !== "unknown" && (
                <span className="mt-3 inline-block text-sm px-3 py-1 rounded-full bg-gray-100 text-gray-700">
                  Content type: {contentTypeLabels[data.contentType] || data.contentType}
                </span>
              )}
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
          {data.modelEvidence.some((m) => m.status === "refused") && (
            <p className="text-xs text-slate-500 mt-2">
              Note: {data.modelEvidence.filter((m) => m.status === "refused").length} model(s) declined to analyze due
              to content policy. Consensus is based on {data.modelEvidence.filter((m) => m.status === "ok").length}{" "}
              responding model(s).
            </p>
          )}
          {governanceSurface}
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

        {actionsSurface}

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
