"use client";

/**
 * Adaptive Research Export — the export entry point on the Adaptive
 * Synthesis Report.
 *
 * Phase 1 shipped a single "Export PDF" button, no format menu. Phase 3
 * adds a format choice — but ONLY when
 * `NEXT_PUBLIC_ADAPTIVE_RESEARCH_DOCX_EXPORT_ENABLED` is on. With that
 * flag off (the default), this component renders the same single-button
 * UI Phase 1 shipped — identical text (aria-label, button label, loading
 * label), classes, and behavior. The button is now always wrapped in one
 * extra `<div className="flex items-center gap-1.5">` (it hosts the
 * conditional `<select>` sibling when the flag is on); with a single
 * child and the flag off that wrapper has no box-model effect, so this is
 * visually a no-op, not literal byte-for-byte DOM identity — Part 14's
 * "ships dark" requirement (zero visible change until DOCX is
 * deliberately turned on) still holds.
 *
 * A native `<select>` (not a custom dropdown/menu component — none exists
 * in this design system, and a native select is trivially keyboard-
 * operable and never overflows a narrow viewport) picks the format; a
 * single "Export" button submits whichever format is currently selected.
 * Both share the same `state`/`errorMessage` — only one export can be
 * in flight from this control at a time, so there is no realistic path to
 * a duplicate submission from the format menu itself (Part 19) — but the
 * loading/button label IS format-specific ("Generating PDF…" vs
 * "Generating Word document…"), matching Part 13's requirement without
 * needing separate state per format.
 *
 * Visibility is gated client-side by BOTH the public mirror of the release
 * flag(s) AND the same `advancedExportEnabled` plan-entitlement check the
 * server uses (`getPlanConfig`, lib/plans.ts — no "server-only" marker,
 * safe client-side) — but this is a UX convenience only. The POST endpoint
 * independently re-derives and re-checks both the flag and full
 * authorization (`canExportAdaptiveResearch`) server-side on every request
 * — a client-side check can never substitute for it (Part 6/15).
 */

import { useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { useUserPlan } from "@/hooks/useUserPlan";
import { getPlanConfig } from "@/lib/plans";
import { authedFetch } from "@/lib/client/authedFetch";
import { AdaptiveExportFormat } from "@/lib/adaptiveSchema/researchExport";

const EXPORT_FLAG_ENABLED = process.env.NEXT_PUBLIC_ADAPTIVE_RESEARCH_EXPORT_ENABLED === "true";
const DOCX_FLAG_ENABLED = process.env.NEXT_PUBLIC_ADAPTIVE_RESEARCH_DOCX_EXPORT_ENABLED === "true";

export interface AdaptiveExportButtonProps {
  runId?: string | null;
}

type ButtonState = "idle" | "loading" | "error";

const FORMAT_LOADING_LABEL: Record<AdaptiveExportFormat, string> = {
  pdf: "Generating PDF…",
  docx: "Generating Word document…",
};

export default function AdaptiveExportButton({ runId }: AdaptiveExportButtonProps) {
  const { user, authReady } = useAuth();
  const { plan, loading: planLoading } = useUserPlan();
  const [state, setState] = useState<ButtonState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [format, setFormat] = useState<AdaptiveExportFormat>("pdf");

  if (!EXPORT_FLAG_ENABLED) return null;
  if (!runId) return null;
  if (planLoading || !plan) return null;
  if (!getPlanConfig(plan).advancedExportEnabled) return null;

  async function handleExport() {
    setState("loading");
    setErrorMessage(null);
    try {
      const res = await authedFetch(`/api/user/runs/${encodeURIComponent(runId!)}/export`, {
        method: "POST",
        user,
        authReady,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ format }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setErrorMessage(body?.message || "Export failed. Please try again.");
        setState("error");
        return;
      }

      const blob = await res.blob();
      const disposition = res.headers.get("Content-Disposition") || "";
      const fileNameMatch = disposition.match(/filename="([^"]+)"/);
      const fileName = fileNameMatch?.[1] || `convergepanel-export-${runId}.${format}`;

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      setState("idle");
    } catch {
      setErrorMessage("Export failed. Please check your connection and try again.");
      setState("error");
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex items-center gap-1.5">
        {DOCX_FLAG_ENABLED && (
          <select
            aria-label="Export format"
            value={format}
            disabled={state === "loading"}
            onChange={(e) => setFormat(e.target.value as AdaptiveExportFormat)}
            className="rounded-lg border border-slate-200 bg-white px-1.5 py-1.5 text-xs font-medium text-slate-700 disabled:cursor-not-allowed disabled:opacity-60"
          >
            <option value="pdf">PDF</option>
            <option value="docx">Word (.docx)</option>
          </select>
        )}
        <button
          type="button"
          onClick={handleExport}
          disabled={state === "loading"}
          aria-busy={state === "loading"}
          aria-label={DOCX_FLAG_ENABLED ? `Export this report as ${format === "docx" ? "a Word document" : "a PDF"}` : "Export this report as a PDF"}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {state === "loading" ? (
            <>
              <span
                className="h-3 w-3 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600"
                aria-hidden="true"
              />
              {DOCX_FLAG_ENABLED ? FORMAT_LOADING_LABEL[format] : FORMAT_LOADING_LABEL.pdf}
            </>
          ) : DOCX_FLAG_ENABLED ? (
            "Export"
          ) : (
            "Export PDF"
          )}
        </button>
      </div>
      {state === "error" && errorMessage && (
        <p role="alert" className="max-w-[220px] text-right text-[11px] text-red-600">
          {errorMessage}
        </p>
      )}
    </div>
  );
}
