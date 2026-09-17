"use client";

/**
 * Claim verification results UI — PERSONAL wrapper.
 *
 * TEAM-VERIFICATION-PARITY-R2: the stored-result presentation lives in the
 * shared, read-only `ClaimVerificationResultView`. This wrapper keeps every
 * Personal-only behaviour and supplies it through the view's explicit slots:
 *   - the live Personal governance read (`/api/user/run-governance`) and the
 *     governance badge (which also reads the viewer's plan);
 *   - the create-response team-policy notice;
 *   - copy verdict, memo export, the audit-trail toggle with JSON copy/download;
 *   - Verify Another.
 * A Team caller must mount the view directly and never this wrapper.
 */

import { useCallback, useEffect, useState } from "react";
import type {
  ClaimVerificationClientPayload,
  ClaimVerdictUi,
} from "@/lib/verification/claimVerificationClientPayload";
import { useAuth } from "@/components/AuthProvider";
import { GovernanceBadge } from "@/components/GovernanceBadge";
import { VerificationActions } from "@/components/VerificationActions";
import { downloadTextFile, generateVerificationMemo } from "@/lib/verification/generateMemo";
import ClaimVerificationResultView, {
  buildClaimVerdictClipboardText,
  ClaimVerificationAuditTrailDetails,
} from "@/components/verification/ClaimVerificationResultView";

export type { ClaimVerificationClientPayload, ClaimVerdictUi };

export default function ClaimVerificationResult({
  data,
  onVerifyAnother,
}: {
  data: ClaimVerificationClientPayload;
  onVerifyAnother: () => void;
}) {
  const { user, authReady } = useAuth();
  const [auditOpen, setAuditOpen] = useState(false);

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

  const bundle = data.auditBundle;
  const evidenceQ = data.evidenceQuality ?? bundle.evidenceQuality;

  const copyVerdict = useCallback((): Promise<void> => {
    return navigator.clipboard.writeText(buildClaimVerdictClipboardText(data));
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
    <ClaimVerificationResultView
      data={data}
      noticeSurface={
        showGov ? (
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
        ) : null
      }
      governanceSurface={
        <GovernanceBadge
          status={liveGov.status}
          theme="light"
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
              <ClaimVerificationAuditTrailDetails data={data} />

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
        </>
      }
    />
  );
}
