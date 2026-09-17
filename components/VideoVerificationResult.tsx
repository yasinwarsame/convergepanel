"use client";

/**
 * Video verification results UI — PERSONAL wrapper.
 *
 * TEAM-VERIFICATION-PARITY-R2: the stored-result presentation lives in the
 * shared, read-only `VideoVerificationResultView`. This wrapper keeps every
 * Personal-only behaviour and supplies it through the view's explicit slots:
 *   - the live Personal governance read (`/api/user/run-governance`) and the
 *     governance badge (which also reads the viewer's plan);
 *   - copy verdict, memo export, the audit-trail toggle with JSON copy/download;
 *   - Verify Another.
 * A Team caller must mount the view directly and never this wrapper.
 */

import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { GovernanceBadge } from "@/components/GovernanceBadge";
import { VerificationActions } from "@/components/VerificationActions";
import { downloadTextFile, generateVerificationMemo } from "@/lib/verification/generateMemo";
import type { VideoVerificationClientPayload } from "@/lib/verification/videoVerificationClientPayload";
import VideoVerificationResultView, {
  buildVideoVerdictClipboardText,
  supportPercent,
  VideoVerificationAuditTrailDetails,
} from "@/components/verification/VideoVerificationResultView";

const BUTTON_OUTLINE_SECONDARY =
  "rounded-lg border border-gray-500 px-4 py-2 text-sm font-medium text-gray-300 hover:bg-gray-700 transition-colors";

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

  const supportPct = supportPercent(data.supportRatio);

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

  const copyVerdict = useCallback((): Promise<void> => {
    return navigator.clipboard.writeText(buildVideoVerdictClipboardText(data));
  }, [data]);

  const handleExportMemo = useCallback(() => {
    const memo = generateVerificationMemo({
      type: "video",
      verdict: data.verdict,
      consensusScore: data.consensusScore,
      confidenceLabel: data.confidenceLabel,
      evidenceQuality: data.evidenceQuality,
      modelEvidence: data.modelEvidence.map((m) => ({
        modelId: m.modelId,
        modelName: m.modelName,
        verdict: m.verdict,
        confidence: m.confidence,
        summary: m.summary,
        manipulationSignals: m.manipulationSignals,
        authenticitySignals: m.authenticitySignals,
        productionSignals: m.productionSignals,
        deceptionIndicators: m.deceptionIndicators,
        compressionNotes: m.compressionNotes,
        limitations: m.limitations,
      })),
      agreementPoints: data.agreementPoints,
      disagreementPoints: data.disagreementPoints,
      contentType: data.contentType,
      fileName: data.fileName,
      videoMetadata: data.metadata,
      metadataFlags: data.metadataAnalysis?.flags,
      frameCount: data.frameCount,
      verificationId: data.verificationId ?? "",
    });
    const base = data.verificationId?.replace(/[^a-zA-Z0-9-_]+/g, "-").slice(0, 48) || String(Date.now());
    downloadTextFile(memo, `video-memo-${base}.txt`);
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
    <VideoVerificationResultView
      data={data}
      governanceSurface={
        <GovernanceBadge
          status={liveGov.status}
          theme="dark"
          reviewedBy={liveGov.reviewedByUid ?? undefined}
          reviewedAt={liveGov.reviewedAt ?? undefined}
          reviewComment={liveGov.comment ?? undefined}
          reviewerEmail={liveGov.reviewerEmail ?? undefined}
          viewerEmail={user?.email ?? undefined}
        />
      }
      actionsSurface={
        <>
          <VerificationActions
            type="video"
            onCopy={copyVerdict}
            onExportMemo={handleExportMemo}
            onViewAuditTrail={() => setAuditOpen((o) => !o)}
            showAuditTrail={auditOpen}
            onVerifyAnother={onVerifyAnother}
            copyLabel="Copy verdict"
            verifyAnotherLabel="Verify another video"
          />

          {auditOpen && (
            <div className="rounded-lg border border-slate-700 bg-slate-900 p-5 shadow-inner">
              <VideoVerificationAuditTrailDetails data={data} />
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
        </>
      }
    />
  );
}
