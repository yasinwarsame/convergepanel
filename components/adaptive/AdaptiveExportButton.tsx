"use client";

/**
 * Adaptive Research Export, Phase 1 — the export entry point on the
 * Adaptive Synthesis Report. Smallest appropriate UI (Part 15): a single
 * "Export PDF" button, no format menu (DOCX/JSON/CSV don't exist yet and
 * are never advertised).
 *
 * Visibility is gated client-side by BOTH the public mirror of the release
 * flag (`NEXT_PUBLIC_ADAPTIVE_RESEARCH_EXPORT_ENABLED`) AND the same
 * `advancedExportEnabled` plan-entitlement check the server uses
 * (`getPlanConfig`, lib/plans.ts — no "server-only" marker, safe
 * client-side) — but this is a UX convenience only. The POST endpoint
 * independently re-derives and re-checks both the flag and full
 * authorization (`canExportAdaptiveResearch`) server-side on every request
 * — a client-side check can never substitute for it (Part 6/15).
 */

import { useState } from "react";
import { useAuth } from "@/components/AuthProvider";
import { useUserPlan } from "@/hooks/useUserPlan";
import { getPlanConfig } from "@/lib/plans";
import { authedFetch } from "@/lib/client/authedFetch";

const EXPORT_FLAG_ENABLED = process.env.NEXT_PUBLIC_ADAPTIVE_RESEARCH_EXPORT_ENABLED === "true";

export interface AdaptiveExportButtonProps {
  runId?: string | null;
}

type ButtonState = "idle" | "loading" | "error";

export default function AdaptiveExportButton({ runId }: AdaptiveExportButtonProps) {
  const { user, authReady } = useAuth();
  const { plan, loading: planLoading } = useUserPlan();
  const [state, setState] = useState<ButtonState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

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
        body: JSON.stringify({ format: "pdf" }),
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
      const fileName = fileNameMatch?.[1] || `convergepanel-export-${runId}.pdf`;

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
      <button
        type="button"
        onClick={handleExport}
        disabled={state === "loading"}
        aria-busy={state === "loading"}
        aria-label="Export this report as a PDF"
        className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {state === "loading" ? (
          <>
            <span
              className="h-3 w-3 animate-spin rounded-full border-2 border-slate-300 border-t-slate-600"
              aria-hidden="true"
            />
            Generating PDF…
          </>
        ) : (
          "Export PDF"
        )}
      </button>
      {state === "error" && errorMessage && (
        <p role="alert" className="max-w-[220px] text-right text-[11px] text-red-600">
          {errorMessage}
        </p>
      )}
    </div>
  );
}
