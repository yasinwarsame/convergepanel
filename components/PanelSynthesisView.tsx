"use client";

/**
 * Panel Synthesis View Component
 * 
 * Displays a unified synthesis report generated from model responses using real model names.
 * 
 * Lifecycle:
 * 1. Component mounts → checks for pre-generated synthesis (from Firestore cache)
 * 2. If cached synthesis exists → renders immediately (no API call)
 * 3. If no cache → shows empty state with "Generate Synthesis" button
 * 4. User clicks generate → calls /api/synthesize-panel with 5-minute timeout
 * 5. On success → stores report in state, renders structured sections
 * 6. On error → shows error UI with retry button
 * 
 * State Machine:
 * - idle: Initial state, no synthesis requested yet
 * - loading: API request in progress (show spinner)
 * - success: Synthesis received and validated (render report)
 * - error: Request failed or validation failed (show error + retry)
 * 
 * Retry Semantics:
 * - User can retry failed requests by clicking "Retry" button
 * - Each retry creates a new request (does not reuse previous request)
 * - AbortController ensures only one request is active at a time
 * 
 * Features:
 * - Loading state while generating synthesis
 * - Error handling for API failures (timeout, abort, validation, network)
 * - Structured JSON rendering of the synthesized report
 * - Handles partial responses gracefully (works with 2-5 responses)
 * - Non-blocking: shows cached synthesis while generating new version in background
 */

import { useState, useEffect, useRef, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ModelResult, SynthesizedReport } from "@/lib/types";
import { StructuredSynthesis } from "@/lib/synthesis/structuredSchema";
import { getModelDisplayNameSafe } from "@/lib/panelModels";
import { fetchWithTimeout, FetchError } from "@/lib/client/fetchWithTimeout";
import { useAuth } from "@/components/AuthProvider";
import {
  computeVerificationGate,
  VerificationGateResult,
  VerificationGateInput,
} from "@/lib/verificationGate/verificationGate";
import { classifyClaimSeverity, ClaimSeverityResult } from "@/lib/verificationGate/claimSeverity";
import { classifyGrounding, GroundingResult } from "@/lib/verificationGate/sourceGrounding";
import {
  buildPanelVerdict,
  formatVerdictText,
  buildCopyForXThread,
  PanelVerdict,
} from "@/lib/verificationGate/panelVerdict";

interface PanelSynthesisViewProps {
  results: ModelResult[];
  question: string;
  runId?: string; // Required runId for caching synthesis in Firestore
  onError?: (error: string) => void;
  preGeneratedStatus?: "idle" | "loading" | "complete" | "error";
  preGeneratedReport?: StructuredSynthesis | null; // Cached structured synthesis from Firestore
  preGeneratedError?: string | null;
  synthesizedReport?: SynthesizedReport | null; // The main synthesized report with consensusAnalysis (for cluster data)
}

interface SynthesisState {
  status: "idle" | "loading" | "success" | "error";
  report: StructuredSynthesis | null;
  error: string | null;
  errorDetails?: any;
}

const GATE_STYLES: Record<string, { border: string; bg: string; badge: string; badgeBg: string; icon: string }> = {
  SAFE_TO_EXPLORE: {
    border: "border-emerald-300",
    bg: "bg-emerald-50",
    badge: "text-emerald-800",
    badgeBg: "bg-emerald-100",
    icon: "text-emerald-600",
  },
  NEEDS_HUMAN_REVIEW: {
    border: "border-amber-300",
    bg: "bg-amber-50",
    badge: "text-amber-800",
    badgeBg: "bg-amber-100",
    icon: "text-amber-600",
  },
  DO_NOT_RELY_YET: {
    border: "border-red-300",
    bg: "bg-red-50",
    badge: "text-red-800",
    badgeBg: "bg-red-100",
    icon: "text-red-600",
  },
};

function VerificationGateCard({ gate }: { gate: VerificationGateResult }) {
  const style = GATE_STYLES[gate.status] ?? GATE_STYLES.NEEDS_HUMAN_REVIEW;

  return (
    <div className={`rounded-xl border-2 ${style.border} ${style.bg} p-5 md:p-6`}>
      {/* Header row */}
      <div className="flex items-center gap-3 mb-4">
        <div className={`flex-shrink-0 ${style.icon}`}>
          {gate.status === "SAFE_TO_EXPLORE" && (
            <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          )}
          {gate.status === "NEEDS_HUMAN_REVIEW" && (
            <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          )}
          {gate.status === "DO_NOT_RELY_YET" && (
            <svg className="w-8 h-8" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
            </svg>
          )}
        </div>
        <div>
          <span className="text-base font-bold text-slate-900">Verification Gate</span>
          <span className={`ml-2.5 inline-flex items-center px-3 py-0.5 rounded-full text-sm font-semibold ${style.badgeBg} ${style.badge}`}>
            {gate.label}
          </span>
        </div>
      </div>

      {/* Reasons */}
      {gate.reasons.length > 0 && (
        <div className="mb-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">Why</p>
          <ul className="space-y-1">
            {gate.reasons.map((r, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-slate-700">
                <span className="mt-1 block h-1.5 w-1.5 flex-shrink-0 rounded-full bg-slate-400" />
                {r}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Recommended next steps */}
      <div>
        <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 mb-2">Recommended next steps</p>
        <ul className="space-y-1">
          {gate.recommendedNextSteps.map((s, i) => (
            <li key={i} className="flex items-start gap-2 text-sm text-slate-700">
              <span className="mt-1 block h-1.5 w-1.5 flex-shrink-0 rounded-full bg-slate-400" />
              {s}
            </li>
          ))}
        </ul>
      </div>

      {/* Advisory disclosure */}
      <p className="mt-4 pt-3 border-t border-slate-200/60 text-[11px] leading-relaxed text-slate-400">
        This indicator is an advisory signal derived from model comparison and analysis. It does not constitute factual certification or approval and is not a substitute for independent professional review.
      </p>
    </div>
  );
}

/* ─── Severity Badge ─── */

const SEVERITY_COLORS: Record<string, { bg: string; text: string; dot: string }> = {
  low: { bg: "bg-slate-100", text: "text-slate-600", dot: "bg-slate-400" },
  important: { bg: "bg-amber-50", text: "text-amber-700", dot: "bg-amber-400" },
  "decision-critical": { bg: "bg-rose-50", text: "text-rose-700", dot: "bg-rose-500" },
};

function SeverityBadge({ result }: { result: ClaimSeverityResult }) {
  const c = SEVERITY_COLORS[result.severity] ?? SEVERITY_COLORS.low;
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium ${c.bg} ${c.text}`}
      title={
        result.severity === "decision-critical"
          ? "May affect action, compliance, safety, or strategic decisions"
          : result.severity === "important"
          ? "Materially shapes interpretation or follow-up"
          : "Supporting context or low-impact observation"
      }
    >
      <span className={`h-1.5 w-1.5 rounded-full ${c.dot}`} />
      {result.label}
    </span>
  );
}

/* ─── Source-Grounding Badge ─── */

const GROUNDING_COLORS: Record<string, { bg: string; text: string; icon: string }> = {
  "source-backed": { bg: "bg-sky-50", text: "text-sky-700", icon: "text-sky-500" },
  "model-reasoned": { bg: "bg-violet-50", text: "text-violet-700", icon: "text-violet-500" },
  mixed: { bg: "bg-slate-100", text: "text-slate-600", icon: "text-slate-400" },
};

function GroundingBadge({ result }: { result: GroundingResult }) {
  const c = GROUNDING_COLORS[result.level] ?? GROUNDING_COLORS.mixed;
  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium ${c.bg} ${c.text}`}
      title={
        result.level === "source-backed"
          ? "Claim appears grounded in cited evidence or external sources"
          : result.level === "model-reasoned"
          ? "Claim appears based on model inference without explicit sources"
          : "Grounding is unclear — may blend sourced and inferred reasoning"
      }
    >
      {result.level === "source-backed" && (
        <svg className={`w-3 h-3 ${c.icon}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M10.172 13.828a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.102 1.101" />
        </svg>
      )}
      {result.level === "model-reasoned" && (
        <svg className={`w-3 h-3 ${c.icon}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
        </svg>
      )}
      {result.level === "mixed" && (
        <svg className={`w-3 h-3 ${c.icon}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      )}
      {result.label}
    </span>
  );
}

/* ─── Panel Verdict Summary Card ─── */

function PanelVerdictCard({
  verdict,
  gate,
}: {
  verdict: PanelVerdict;
  gate: VerificationGateResult;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied-summary" | "copied-x">("idle");
  const [showFullCaveat, setShowFullCaveat] = useState(false);
  const gateStyle = GATE_STYLES[gate.status] ?? GATE_STYLES.NEEDS_HUMAN_REVIEW;
  const xThread = buildCopyForXThread(verdict);
  const xLabel = xThread.length <= 1 ? "Copy for X" : `Copy for X (thread · ${xThread.length})`;

  const copyToClipboard = useCallback(
    (text: string, label: "copied-summary" | "copied-x") => {
      navigator.clipboard.writeText(text).then(() => {
        setCopyState(label);
        setTimeout(() => setCopyState("idle"), 2000);
      });
    },
    []
  );

  const caveatIsLong = (verdict.keyBlindSpot?.length ?? 0) > 120;

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
      {/* Top accent bar */}
      <div
        className={`h-1 ${
          gate.status === "SAFE_TO_EXPLORE"
            ? "bg-emerald-400"
            : gate.status === "NEEDS_HUMAN_REVIEW"
            ? "bg-amber-400"
            : "bg-red-400"
        }`}
      />

      <div className="p-5 md:p-6 space-y-5">
        {/* ── A) Decision header row ── */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div className="flex items-center gap-2.5 flex-wrap">
            <h3 className="text-base font-extrabold uppercase tracking-wide text-slate-700">
              Panel Verdict
            </h3>
            <span
              className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold ${gateStyle.badgeBg} ${gateStyle.badge}`}
            >
              {gate.label}
            </span>
          </div>
          <GroundingBadge result={verdict.grounding} />
        </div>

        {/* Question */}
        <p className="text-base font-semibold text-slate-900 leading-snug">
          {verdict.question}
        </p>

        {/* ── B) Two-column grid: Consensus + Disagreement ── */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Left: Top consensus */}
          <div className="bg-slate-50 border border-slate-200 rounded-xl p-4">
            <span className="text-xs font-medium text-slate-500 uppercase tracking-wide">
              Top consensus
            </span>
            <ul className="mt-2 space-y-1.5">
              <li className="flex items-start gap-2 text-sm text-slate-800 leading-relaxed">
                <span className="mt-1.5 block h-1.5 w-1.5 flex-shrink-0 rounded-full bg-emerald-400" />
                <span className="whitespace-normal break-words">{verdict.topConsensus}</span>
              </li>
            </ul>
            {verdict.consensusModelCount > 0 && (
              <p className="mt-2 text-[11px] text-slate-400">
                Agreed by {verdict.consensusModelCount} model{verdict.consensusModelCount !== 1 ? "s" : ""}
              </p>
            )}
          </div>

          {/* Right: Key disagreement */}
          <div className="bg-slate-50 border border-slate-200 rounded-xl p-4">
            <span className="text-xs font-medium text-slate-500 uppercase tracking-wide">
              Key disagreement
            </span>
            {verdict.topDisagreement ? (
              <>
                <ul className="mt-2 space-y-1.5">
                  <li className="flex items-start gap-2 text-sm text-orange-800 leading-relaxed">
                    <span className="mt-1.5 block h-1.5 w-1.5 flex-shrink-0 rounded-full bg-orange-400" />
                    <span className="whitespace-normal break-words">{verdict.topDisagreement}</span>
                  </li>
                  {verdict.disagreementDetail && (
                    <li className="flex items-start gap-2 text-sm text-slate-600 leading-relaxed">
                      <span className="mt-1.5 block h-1.5 w-1.5 flex-shrink-0 rounded-full bg-slate-300" />
                      <span className="whitespace-normal break-words">{verdict.disagreementDetail}</span>
                    </li>
                  )}
                </ul>
                {verdict.disagreementModelCount > 0 && (
                  <p className="mt-2 text-[11px] text-slate-400">
                    {verdict.disagreementModelCount} model{verdict.disagreementModelCount !== 1 ? "s" : ""} split
                  </p>
                )}
              </>
            ) : (
              <p className="mt-2 text-sm text-slate-400 italic">No major disagreements detected.</p>
            )}
          </div>
        </div>

        {/* ── C) Caveat / blind spot with show more/less ── */}
        {verdict.keyBlindSpot && (
          <div>
            <span className="text-xs font-medium text-slate-500 uppercase tracking-wide">
              Caveat
            </span>
            <p
              className={`mt-1 text-sm text-slate-600 leading-relaxed whitespace-normal break-words ${
                !showFullCaveat && caveatIsLong ? "line-clamp-2" : ""
              }`}
            >
              {verdict.keyBlindSpot}
            </p>
            {caveatIsLong && (
              <button
                onClick={() => setShowFullCaveat((v) => !v)}
                className="mt-1 text-xs font-medium text-sky-600 hover:text-sky-800 transition-colors"
              >
                {showFullCaveat ? "Show less" : "Show more"}
              </button>
            )}
          </div>
        )}

        {/* ── D) Recommended next steps ── */}
        {verdict.recommendedNextSteps.length > 0 && (
          <div>
            <span className="text-xs font-medium text-slate-500 uppercase tracking-wide">
              Recommended next steps
            </span>
            <ul className="mt-2 space-y-1">
              {verdict.recommendedNextSteps.slice(0, 3).map((step, i) => (
                <li key={i} className="flex items-start gap-2 text-sm text-slate-700">
                  <span className="mt-1.5 block h-1.5 w-1.5 flex-shrink-0 rounded-full bg-slate-400" />
                  <span>{step}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Copy actions */}
        <div className="flex items-center gap-2 pt-3 border-t border-slate-100 flex-wrap">
          <button
            onClick={() => copyToClipboard(formatVerdictText(verdict, "linkedin"), "copied-summary")}
            className="text-xs font-medium text-sky-600 hover:text-sky-800 transition-colors px-2 py-1 rounded hover:bg-sky-50"
          >
            {copyState === "copied-summary" ? "Copied" : "Copy summary"}
          </button>
          <span className="text-slate-300">|</span>
          <button
            onClick={() => copyToClipboard(xThread.join("\n\n"), "copied-x")}
            className="text-xs font-medium text-slate-500 hover:text-slate-700 transition-colors px-2 py-1 rounded hover:bg-slate-50"
          >
            {copyState === "copied-x" ? "Copied" : xLabel}
          </button>
        </div>

        {/* Disclaimer */}
        <p className="text-[10px] leading-relaxed text-slate-400">
          This summary is auto-generated from multi-model synthesis and is provided for informational purposes only.
        </p>
      </div>
    </div>
  );
}

export default function PanelSynthesisView({
  results,
  question,
  runId,
  onError,
  preGeneratedStatus = "idle",
  preGeneratedReport = null,
  preGeneratedError = null,
  synthesizedReport = null,
}: PanelSynthesisViewProps) {
  const { user, authReady } = useAuth();
  const [synthesisState, setSynthesisState] = useState<SynthesisState>({
    status: "idle",
    report: null,
    error: null,
  });
  const reqInFlightRef = useRef(false); // Prevent duplicate in-flight requests
  const abortControllerRef = useRef<AbortController | null>(null); // For cleanup on unmount/new request
  const triggeredRunIdsRef = useRef<Set<string>>(new Set()); // Track which runIds have had synthesis triggered
  
  // Timeout: 5 minutes (300000ms) for synthesis API call
  // This matches the server-side timeout (300s) to prevent client aborting before server completes
  // Synthesis can take 1-3 minutes for large inputs, so 5 minutes provides reasonable buffer
  const SYNTHESIS_TIMEOUT_MS = 300000;

  // Use pre-generated synthesis if available (from Firestore cache)
  const hasPreGenerated = preGeneratedStatus === "complete" && preGeneratedReport;
  const isPreGenerating = preGeneratedStatus === "loading";
  const hasPreGeneratedError = preGeneratedStatus === "error" && preGeneratedError;

  // Helper to check if report is structured synthesis format
  const isStructuredSynthesis = (report: any): report is StructuredSynthesis => {
    return (
      typeof report === "object" &&
      report !== null &&
      typeof report.executiveSummary === "string" &&
      Array.isArray(report.keyFindings) &&
      Array.isArray(report.disagreements) &&
      Array.isArray(report.biasAndBlindSpots) &&
      Array.isArray(report.openQuestions) &&
      typeof report.methodology === "string"
    );
  };

  // Helper to check if report is structured JSON V1 (legacy) - kept for backward compatibility but not used
  const isV1Report = (report: any): boolean => {
    return (
      typeof report === "object" &&
      report !== null &&
      report.version === "1.0" &&
      typeof report.unifiedSynthesis === "string" &&
      Array.isArray(report.keyConsensus) &&
      Array.isArray(report.keyDisagreements) &&
      Array.isArray(report.weakOrSingleModel)
    );
  };

  // Safe text getter
  const getModelText = (r: any): string => 
    (r as any).rawTextFull ?? (r as any).rawText ?? (r as any).text ?? "";

  // Cleanup: abort ongoing request on component unmount
  useEffect(() => {
    return () => {
      // Abort on component unmount to prevent memory leaks
      if (abortControllerRef.current) {
        abortControllerRef.current.abort("Component unmounting");
        abortControllerRef.current = null;
      }
    };
  }, []);

  // Generate synthesis report on demand (e.g., when user clicks "Regenerate Synthesis")
  // Wrapped in useCallback to prevent infinite loops in useEffect
  // OPTIMIZATION: First check cache with GET, then generate with POST if needed
  const generateSynthesis = useCallback(async () => {
    // Guard: prevent duplicate requests (same runId or already in flight)
    if (reqInFlightRef.current) {
      console.log("[PanelSynthesisView] Request already in flight, skipping");
      return; // Prevent duplicate requests
    }

    // Guard: prevent triggering synthesis multiple times for the same runId
    if (runId && triggeredRunIdsRef.current.has(runId)) {
      console.log("[PanelSynthesisView] Synthesis already triggered for this runId, skipping:", runId);
      return;
    }

    // Mark this runId as triggered
    if (runId) {
      triggeredRunIdsRef.current.add(runId);
    }

    reqInFlightRef.current = true;
    setSynthesisState(prev => ({ ...prev, status: "loading", error: null }));

    try {
      // STEP 1: Check cache first (GET request) - instant response if cached
      if (runId) {
        try {
          // Get auth headers
          const headers: Record<string, string> = {};
          if (user) {
            try {
              const idToken = await user.getIdToken();
              headers["Authorization"] = `Bearer ${idToken}`;
            } catch (tokenError: any) {
              console.warn("[PanelSynthesisView] Failed to get ID token for cache check:", tokenError);
            }
          }
          
          const cacheResponse = await fetchWithTimeout(
            `/api/synthesize-panel?runId=${encodeURIComponent(runId)}&mode=cache`,
            {
              method: "GET",
              headers,
              credentials: "include",
            },
            5000, // 5 second timeout for cache check
            undefined // No abort signal for cache check
          );
          
          if (cacheResponse.ok) {
            const cacheData = await cacheResponse.json();
            if (cacheData.ok && cacheData.report) {
              console.log("[PanelSynthesisView] Cache hit - loaded synthesis instantly", {
                cached: cacheData.cached,
              });
              
              setSynthesisState({
                status: "success",
                report: cacheData.report,
                error: null,
              });
              
              reqInFlightRef.current = false;
              return; // Success - exit early
            }
          }
          
          // Cache miss - continue to generation
          console.log("[PanelSynthesisView] Cache miss - generating synthesis");
        } catch (cacheError: any) {
          // Cache check failed - continue to generation (non-fatal)
          console.warn("[PanelSynthesisView] Cache check failed, proceeding with generation:", cacheError?.message);
        }
      }
      
      // STEP 2: Generate synthesis (POST request)
      // Update loading state with progress indicators
      setSynthesisState(prev => ({ 
        ...prev, 
        status: "loading", 
        error: null,
        progress: "Preparing sources...",
      }));
      // Filter to only successful results with non-empty text
      const okResults = results.filter(
        (r) => r.status === "ok" && getModelText(r).trim().length > 0
      );

      if (okResults.length < 2) {
        throw new Error("Synthesis requires at least 2 successful model responses.");
      }

      // Update progress
      setSynthesisState(prev => ({ ...prev, progress: "Building consensus map..." }));

      // Build payload with exact contract: runId, question, results[{modelId, text}]
      const resultsPayload = okResults.map((result) => ({
        modelId: result.modelId,
        text: getModelText(result),
      }));

      // Include clusters if available (from synthesizedReport), but not required
      // The API can work with just results array if clusters aren't available
      const agreementClusters = synthesizedReport?.consensusAnalysis?.agreementClusters || [];
      const clusters = synthesizedReport?.consensusAnalysis?.clusters || [];
      
      // Update progress
      setSynthesisState(prev => ({ ...prev, progress: "Writing synthesis..." }));

      console.log("[PanelSynthesisView] Synthesis payload", {
        runId,
        questionLength: question.trim().length,
        resultsCount: resultsPayload.length,
        modelIds: resultsPayload.map(r => r.modelId),
        hasClusters: agreementClusters.length > 0,
        clusterCount: agreementClusters.length,
      });

      // Abort previous request if any (ensure only one request at a time)
      if (abortControllerRef.current) {
        abortControllerRef.current.abort("New request started");
      }
      
      // Create new abort controller for this request
      const controller = new AbortController();
      abortControllerRef.current = controller;

      // Call synthesis API using shared fetch wrapper
      // Timeout: 5 minutes (300000ms) - matches server-side timeout
      // IMPORTANT: Include authentication headers (same as run-panel)
      let response: Response;
      
      // Show "long wait" hint after 8 seconds
      const longWaitTimer = setTimeout(() => {
        setSynthesisState(prev => ({
          ...prev,
          progress: "Large panels can take longer. You can switch tabs; synthesis will appear when ready.",
        }));
      }, 8000);
      
      try {
        // Import authedFetch helper
        const { prepareAuthedHeaders } = await import("@/lib/client/authedFetch");
        
        // Prepare authenticated headers using proper Headers API
        const baseHeaders = new Headers({
          "Content-Type": "application/json",
        });
        const authHeaders = await prepareAuthedHeaders(user, baseHeaders);
        
        response = await fetchWithTimeout(
          "/api/synthesize-panel",
          {
            method: "POST",
            headers: authHeaders,
            body: JSON.stringify({
              runId,
              question: question.trim(),
              results: resultsPayload,
              // Include clusters if available (optional - API works without them)
              ...(agreementClusters.length > 0 && { agreementClusters }),
              ...(clusters.length > 0 && { clusters }),
            }),
            credentials: "include", // Include session cookies (same as run-panel)
          },
          SYNTHESIS_TIMEOUT_MS, // 5 minute timeout
          controller.signal // Pass abort signal for cleanup on unmount
        );
        
        clearTimeout(longWaitTimer);

        console.log("[PanelSynthesisView] API response received", {
          status: response.status,
          ok: response.ok,
          statusText: response.statusText,
        });
      } catch (fetchError: unknown) {
        // fetchWithTimeout throws FetchError with normalized shape
        // Check if it was an abort (timeout or user abort)
        const isFetchError = (err: unknown): err is FetchError => {
          return typeof err === 'object' && err !== null && 'name' in err && 'wasAborted' in err;
        };
        
        if (isFetchError(fetchError)) {
          console.error("[PanelSynthesisView] Fetch error (normalized):", {
            message: fetchError.message,
            name: fetchError.name,
            wasAborted: fetchError.wasAborted,
            wasTimeout: fetchError.wasTimeout,
            statusCode: fetchError.statusCode,
            requestId: fetchError.requestId,
          });
          
          // Re-throw as-is (FetchError is already normalized)
          throw fetchError;
        } else {
          // Unexpected error shape - wrap it
          console.error("[PanelSynthesisView] Unexpected fetch error shape:", fetchError);
          const wrappedError: FetchError = {
            message: fetchError instanceof Error ? fetchError.message : "Network request failed",
            name: "NetworkError",
            wasAborted: false,
            wasTimeout: false,
            cause: fetchError,
          };
          throw wrappedError;
        }
      } finally {
        // Clear abort controller ref if this is still the current request
        if (abortControllerRef.current === controller) {
          abortControllerRef.current = null;
        }
      }

      // Handle non-OK responses (4xx, 5xx)
      // Standardized error format: { errorCode, message, requestId?, details? }
        if (!response.ok) {
        const statusCode = response.status;
        let errorMessage = `API error: ${statusCode}`;
        let errorCode: string | undefined;
        let errorDetails: any = null;
        let requestId: string | undefined;
        
        try {
          const responseText = await response.text();
          if (responseText) {
            try {
              const errorData = JSON.parse(responseText);
              // Handle standardized error format
              if (errorData.errorCode) {
                errorCode = errorData.errorCode;
                errorMessage = errorData.message || errorMessage;
                errorDetails = errorData.details || null;
                requestId = errorData.requestId;
              } else if (errorData.error) {
                // Legacy format: { error: { code, message, details } }
                errorCode = errorData.error.code || errorData.errorCode;
                errorMessage = errorData.error.message || errorData.message || errorMessage;
                errorDetails = errorData.error.details || errorData.details || null;
              } else {
                // Fallback: try to extract message
                errorMessage = errorData.message || errorMessage;
              }
              
              // Log full error details for debugging
              console.error("[PanelSynthesisView] API error response:", {
                statusCode,
                errorCode,
                message: errorMessage,
                requestId,
                details: errorDetails,
              });
            } catch {
              // Not JSON - use raw text as message
              errorMessage = responseText.substring(0, 200) || errorMessage;
            }
          }
        } catch (textError: any) {
          console.error("[PanelSynthesisView] Failed to read error response:", {
            error: textError?.message || textError,
          });
        }
        
        // Special handling for auth errors (401/403)
        if (statusCode === 401) {
          errorMessage = "Session expired. Please sign in again.";
          errorCode = errorCode || "UNAUTHORIZED";
          // Redirect to login after a brief delay
          setTimeout(() => {
            window.location.href = "/login";
          }, 1500);
        } else if (statusCode === 403) {
          errorMessage = "You don't have access to this run.";
          errorCode = errorCode || "FORBIDDEN";
        }
        
        // Create normalized error for consistent handling
        const apiError: FetchError = {
          message: errorMessage,
          name: statusCode >= 500 ? "HttpError" : statusCode === 401 || statusCode === 403 ? "HttpError" : "HttpError",
          statusCode,
          wasAborted: false,
          wasTimeout: false,
          requestId,
        };
        
        // Attach details for diagnostics
        if (errorDetails) {
          (apiError as any).details = errorDetails;
        }
        if (errorCode) {
          (apiError as any).errorCode = errorCode;
        }
        
        throw apiError;
      }

      // Parse JSON response
      let data: any;
      let responseText = "";
      try {
        responseText = await response.text();
        data = JSON.parse(responseText);
        console.log("[PanelSynthesisView] Parsed response keys:", Object.keys(data));
      } catch (parseError: any) {
        console.error("[PanelSynthesisView] JSON parse error:", {
          error: parseError?.message || parseError,
          name: parseError?.name,
          stack: parseError?.stack,
          responsePreview: responseText.substring(0, 500),
        });
        throw new Error(`Failed to parse server response: ${parseError.message}`);
      }

      // Validate response structure
      if (!data.ok) {
        const errorMsg = data.error?.message || data.message || data.error || "Synthesis generation failed";
        const errorDetails = data.error?.details;
        const apiError: any = new Error(errorMsg);
        apiError.statusCode = response?.status;
        apiError.details = errorDetails;
        throw apiError;
      }

      // API now returns report in new format
      const structuredReport = data.report;
      if (!structuredReport || !isStructuredSynthesis(structuredReport)) {
        console.error("[PanelSynthesisView] Invalid structured synthesis:", {
          hasReport: !!structuredReport,
          reportKeys: structuredReport ? Object.keys(structuredReport) : [],
          isValid: structuredReport ? isStructuredSynthesis(structuredReport) : false,
        });
        throw new Error("Invalid response from synthesis API: missing or invalid structured synthesis");
      }

        console.log("[PanelSynthesisView] Structured synthesis received from server", {
        keyFindingsCount: structuredReport.keyFindings.length,
        disagreementsCount: structuredReport.disagreements.length,
        biasAndBlindSpotsCount: structuredReport.biasAndBlindSpots.length,
        openQuestionsCount: structuredReport.openQuestions.length,
        hasExecutiveSummary: !!structuredReport.executiveSummary,
        hasMethodology: !!structuredReport.methodology,
        schemaVersion: data.schemaVersion,
        synthesizedBy: data.synthesizedBy,
        cached: data.cached || false,
      });

      // Set the structured report
        setSynthesisState({
          status: "success",
        report: structuredReport,
          error: null,
        });
      
      console.log("[PanelSynthesisView] ✅ Successfully generated structured synthesis", {
        keyFindingsCount: structuredReport.keyFindings.length,
        disagreementsCount: structuredReport.disagreements.length,
        cached: data.cached || false,
        });
      } catch (error: unknown) {
        // Error handling: fetchWithTimeout throws FetchError with normalized shape
        // Check if it's a FetchError (from fetch wrapper) or unexpected error
        const isFetchError = (err: unknown): err is FetchError => {
          return typeof err === 'object' && err !== null && 'name' in err && 'wasAborted' in err;
        };
        
        let errorMessage = "Failed to generate synthesis report";
        let errorDetails: any = null;
        let requestId: string | undefined;
        
        if (isFetchError(error)) {
          // Normalized FetchError from fetchWithTimeout
          console.error("[PanelSynthesisView] Synthesis error (normalized):", {
            message: error.message,
            name: error.name,
            wasAborted: error.wasAborted,
            wasTimeout: error.wasTimeout,
            statusCode: error.statusCode,
            requestId: error.requestId,
            details: (error as any).details,
          });
          
          // Extract message and details from normalized error
          errorMessage = error.message;
          requestId = error.requestId;
          
          // Handle specific error types
          if (error.wasTimeout) {
            errorMessage = "Synthesis request timed out after 5 minutes. Please try again.";
          } else if (error.wasAborted && error.message.includes("New request started")) {
            errorMessage = "A new synthesis request was started. The previous request was cancelled.";
          } else if (error.statusCode === 401) {
            // 401: Unauthorized - redirect to login
            errorMessage = "Session expired. Please sign in again.";
            // Redirect to login after a brief delay (allow error message to be seen)
            setTimeout(() => {
              window.location.href = "/login";
            }, 1500);
          } else if (error.statusCode === 403) {
            // 403: Forbidden - ownership check failed
            errorMessage = "You don't have access to this run.";
          } else if (error.statusCode === 400 && (error as any).details) {
            errorMessage = error.message || "Synthesis request validation failed";
            errorDetails = (error as any).details;
          } else if (error.statusCode === 502) {
            // Check for EMPTY_MODEL_OUTPUT error code
            const errorCode = (error as any).errorCode || (errorDetails as any)?.errorCode;
            if (errorCode === "EMPTY_MODEL_OUTPUT" || error.message.includes("truncated") || error.message.includes("no content")) {
              errorMessage = "Synthesis output was truncated or empty. Try again with a shorter question or fewer models.";
            } else {
              errorMessage = "Synthesis generation failed: AI model returned no usable content. Please try again.";
            }
          } else if (error.statusCode === 504) {
            errorMessage = "Synthesis request timed out on server. Please try again.";
          }
          
          // Extract details if present
          if ((error as any).details) {
            errorDetails = (error as any).details;
          }
        } else if (error instanceof Error) {
          // Unexpected error shape - use error message
          console.error("[PanelSynthesisView] Unexpected error shape:", {
            message: error.message,
            name: error.name,
            stack: error.stack,
          });
          errorMessage = error.message || "Failed to generate synthesis report";
        } else {
          // Unknown error type
          console.error("[PanelSynthesisView] Unknown error type:", error);
          errorMessage = "Failed to generate synthesis report";
        }

        // Always set error state - never leave in loading
        // CRITICAL: Always clear loading state here (setLoading(false) equivalent)
        reqInFlightRef.current = false;
        setSynthesisState({
          status: "error",
          report: null,
          error: errorMessage,
          errorDetails: errorDetails || null,
        });
      
        if (onError) {
          onError(errorMessage);
        }
        
        // Log error details if available (especially for 400 validation errors)
        if (errorDetails) {
          console.error("[PanelSynthesisView] Error details:", errorDetails);
        }
      } finally {
        // Always clear loading state, even on error or abort
        // This ensures we never have an infinite spinner
        reqInFlightRef.current = false;
        
        // Ensure status is explicitly set to error if it's still loading
        setSynthesisState(prev => {
          if (prev.status === "loading") {
            return { ...prev, status: "error", error: prev.error || "Request failed" };
          }
          return prev;
        });
      }
  }, [results, question, runId, onError, synthesizedReport]); // Dependencies for generateSynthesis

  // Reset triggered runIds when runId changes (new panel run)
  useEffect(() => {
    triggeredRunIdsRef.current.clear();
  }, [runId]);

  // Initialize state from pre-generated synthesis (from Firestore cache or auto-generation)
  useEffect(() => {
    if (hasPreGenerated && preGeneratedReport && isStructuredSynthesis(preGeneratedReport)) {
      setSynthesisState({
        status: "success",
        report: preGeneratedReport,
        error: null,
      });
    } else if (hasPreGeneratedError) {
      setSynthesisState({
        status: "error",
        report: null,
        error: preGeneratedError,
      });
    } else if (isPreGenerating) {
      setSynthesisState(prev => ({
        ...prev,
        status: "loading",
      }));
    } else if (preGeneratedStatus === "idle" && runId && results.length >= 2) {
      // AUTO-START: If synthesis is idle but we have results and runId, auto-start generation
      // This handles cases where auto-generation hasn't completed yet or was missed
      // Only trigger once per runId (guarded by triggeredRunIdsRef)
      if (!triggeredRunIdsRef.current.has(runId)) {
        console.log("[PanelSynthesisView] Auto-starting synthesis generation for runId:", runId);
        // Delay slightly to avoid race conditions with parent component state updates
        const timer = setTimeout(() => {
          void generateSynthesis();
        }, 100);
        return () => clearTimeout(timer);
      }
    }
  }, [hasPreGenerated, preGeneratedReport, hasPreGeneratedError, preGeneratedError, isPreGenerating, preGeneratedStatus, runId, results.length, generateSynthesis]);

  // Loading state - show when generating
  if (synthesisState.status === "loading" && !synthesisState.report) {
    return (
      <div className="flex flex-col items-center justify-center py-12 px-6">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-sky-600 mb-4"></div>
        <p className="text-sm text-slate-600">Generating synthesis report...</p>
        <p className="text-xs text-slate-500 mt-2">This may take a few moments</p>
      </div>
    );
  }

  // Error state with retry button - show when there's an error AND no content to display
  if (synthesisState.status === "error" && !synthesisState.report) {
    const isAuthError = synthesisState.error?.includes("Session expired") || 
                       synthesisState.error?.includes("sign in");
    const isForbiddenError = synthesisState.error?.includes("don't have access");
    
    const handleRetry = () => {
      // Don't retry auth errors - user needs to sign in first
      if (isAuthError) {
        return;
      }
      setSynthesisState(prev => ({ ...prev, status: "loading", error: null }));
      void generateSynthesis();
    };

    // Special UI for auth errors - show message, redirect will happen automatically
    if (isAuthError) {
      return (
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-6">
          <div className="flex items-start gap-3">
            <div className="flex-shrink-0">
              <svg
                className="h-5 w-5 text-amber-600"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                />
              </svg>
            </div>
            <div className="flex-1">
              <h3 className="text-sm font-semibold text-amber-800 mb-1">
                Session Expired
              </h3>
              <p className="text-sm text-amber-700">
                {synthesisState.error || "Your session has expired. Redirecting to sign in..."}
              </p>
            </div>
          </div>
        </div>
      );
    }

    // Regular error UI with retry button
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-6">
        <div className="flex items-start gap-3">
          <div className="flex-shrink-0">
            <svg
              className="h-5 w-5 text-red-600"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
              />
            </svg>
          </div>
          <div className="flex-1">
            <h3 className="text-sm font-semibold text-red-800 mb-1">
              Synthesis Generation Failed
            </h3>
            <p className="text-sm text-red-700 mb-4">
              {synthesisState.error || "Failed to generate synthesis report. Please try again."}
            </p>
            {/* Show diagnostics for validation errors (400, 502, etc.) */}
            {synthesisState.errorDetails && (
              <details className="mb-4 text-xs">
                <summary className="text-red-600 cursor-pointer hover:text-red-700 font-medium">
                  View Diagnostics
                </summary>
                <pre className="mt-2 p-2 bg-red-50 rounded border border-red-200 text-red-800 overflow-auto max-h-64">
                  {JSON.stringify(synthesisState.errorDetails, null, 2)}
                </pre>
              </details>
            )}
            
            {/* Show request ID for correlation if available */}
            {synthesisState.errorDetails && typeof synthesisState.errorDetails === 'object' && 'requestId' in synthesisState.errorDetails && (
              <p className="text-xs text-red-600 mt-2">
                Request ID: <code className="bg-red-100 px-1 rounded">{synthesisState.errorDetails.requestId as string}</code>
              </p>
            )}
            <button
              onClick={handleRetry}
              disabled={reqInFlightRef.current}
              className="px-4 py-2 bg-red-600 text-white text-sm font-medium rounded-md hover:bg-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {reqInFlightRef.current ? "Retrying..." : "Retry"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Render structured synthesis if available
  if (synthesisState.status === "success" && synthesisState.report && isStructuredSynthesis(synthesisState.report)) {
    const report = synthesisState.report;
      
      // Show non-blocking notice if we're also pre-generating a new version in the background
      const showLoadingNotice = isPreGenerating;

      // Compute Verification Gate from existing synthesis signals
      const gateInput: VerificationGateInput = {
        keyFindings: report.keyFindings,
        disagreements: report.disagreements,
        biasAndBlindSpots: report.biasAndBlindSpots,
        openQuestions: report.openQuestions,
        trustSummary: synthesizedReport?.consensusAnalysis?.trustSummary,
      };
      const gate = computeVerificationGate(gateInput);

    return (
        <div className="space-y-6">
          {/* Non-blocking loading notice (if generating new version in background) */}
          {showLoadingNotice && (
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 flex items-center gap-2">
              <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-600"></div>
              <p className="text-sm text-blue-700">Generating updated synthesis in the background...</p>
            </div>
          )}

          {/* Verification Gate */}
          <VerificationGateCard gate={gate} />

          {/* Executive Summary */}
          {report.executiveSummary && (
            <div className="bg-white rounded-lg border border-gray-200 p-6 md:p-8">
              <h2 className="text-xl font-semibold text-slate-900 mb-4">Executive Summary</h2>
      <div className="prose prose-slate max-w-none">
                <ReactMarkdown remarkPlugins={[remarkGfm]}>
                  {report.executiveSummary}
          </ReactMarkdown>
        </div>
            </div>
          )}

          {/* Key Findings (green cards) */}
          {report.keyFindings && report.keyFindings.length > 0 && (
            <div>
              <h2 className="text-lg font-semibold text-slate-900 mb-4">Key Findings</h2>
              <div className="space-y-3">
                {report.keyFindings.map((finding, idx) => {
                  const severity = classifyClaimSeverity(
                    finding.claim,
                    finding.confidence,
                    finding.modelsSupporting?.length
                  );
                  const grounding = classifyGrounding(finding.claim, finding.evidenceRefs);
                  return (
                    <div
                      key={idx}
                      className="relative rounded-lg bg-green-50 border border-green-200 p-4"
                    >
                      <div className="absolute left-0 top-0 h-full w-1 rounded-l-lg bg-green-400"></div>
                      <div className="pl-5">
                        <div className="flex flex-wrap items-center gap-2 mb-2">
                          <SeverityBadge result={severity} />
                          <GroundingBadge result={grounding} />
                        </div>
                        <p className="text-green-800 mb-2">{finding.claim}</p>
                        {finding.evidenceRefs && finding.evidenceRefs.length > 0 && (
                          <ul className="text-sm text-green-700 mb-2 list-disc list-inside">
                            {finding.evidenceRefs.map((ref, refIdx) => (
                              <li key={refIdx}>{ref}</li>
                            ))}
                          </ul>
                        )}
                        <div className="flex items-center gap-2 mt-2">
                          <span className="text-xs font-medium text-green-700">
                            {finding.modelsSupporting.length} model{finding.modelsSupporting.length !== 1 ? "s" : ""}: {finding.modelsSupporting.map(getModelDisplayNameSafe).join(", ")}
                          </span>
                          <span className="text-xs text-green-600">•</span>
                          <span className="text-xs text-green-600">{finding.confidence} confidence</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Disagreements (orange cards) */}
          {report.disagreements && report.disagreements.length > 0 && (
            <div>
              <h2 className="text-lg font-semibold text-slate-900 mb-4">Disagreements</h2>
              <div className="space-y-3">
                {report.disagreements.map((disagreement, idx) => {
                  const severity = classifyClaimSeverity(
                    disagreement.topic + " " + disagreement.whyTheyDiffer,
                    undefined,
                    undefined,
                    true
                  );
                  const positions = Object.values(disagreement.positionsByModel).join(" ");
                  const grounding = classifyGrounding(
                    disagreement.topic,
                    undefined,
                    positions
                  );
                  return (
                    <div
                      key={idx}
                      className="relative rounded-lg bg-orange-50 border border-orange-200 p-4"
                    >
                      <div className="absolute left-0 top-0 h-full w-1 rounded-l-lg bg-orange-400"></div>
                      <div className="pl-5">
                        <div className="flex flex-wrap items-center gap-2 mb-2">
                          <SeverityBadge result={severity} />
                          <GroundingBadge result={grounding} />
                        </div>
                        <h3 className="text-orange-900 font-semibold mb-2">{disagreement.topic}</h3>
                        <p className="text-orange-800 mb-3">{disagreement.whyTheyDiffer}</p>
                        <div className="space-y-2 mt-3">
                          {Object.entries(disagreement.positionsByModel).map(([modelId, position], posIdx) => (
                            <div key={posIdx} className="pl-3 border-l-2 border-orange-300">
                              <div className="flex items-center gap-2 mb-1">
                                <span className="text-sm font-medium text-orange-900">{getModelDisplayNameSafe(modelId)}:</span>
                              </div>
                              <p className="text-sm text-orange-800">{position}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Bias & Blind Spots */}
          {report.biasAndBlindSpots && report.biasAndBlindSpots.length > 0 ? (
            <div>
              <h2 className="text-lg font-semibold text-slate-900 mb-4">Bias & Blind Spots</h2>
              <div className="space-y-4">
                {report.biasAndBlindSpots.map((bias, idx) => {
                  // Support both old format (string[]) and new format (object[])
                  const biasItem = typeof bias === "string" 
                    ? { 
                        description: bias, 
                        biasType: "General Bias", 
                        modelsImplicated: [], 
                        evidence: [], 
                        likelyCauses: [], 
                        impact: "", 
                        mitigationSteps: [] 
                      }
                    : bias;

                  const biasSeverity = classifyClaimSeverity(
                    biasItem.description + " " + (biasItem.impact || "")
                  );

                  return (
                    <div
                      key={idx}
                      className="relative rounded-lg bg-slate-50 border border-slate-300 p-5"
                    >
                      <div className="absolute left-0 top-0 h-full w-1 rounded-l-lg bg-amber-400"></div>
                      <div className="pl-5">
                        <div className="flex flex-wrap items-center gap-2 mb-2">
                          <h3 className="text-slate-900 font-semibold">{biasItem.biasType}</h3>
                          <SeverityBadge result={biasSeverity} />
                        </div>
                        
                        {/* Description */}
                        <p className="text-slate-700 mb-3">{biasItem.description}</p>

                        {/* Models Implicated */}
                        {biasItem.modelsImplicated && biasItem.modelsImplicated.length > 0 && (
                          <div className="mb-3">
                            <span className="text-sm font-medium text-slate-600 uppercase tracking-wide">Models Implicated:</span>
                            <div className="flex flex-wrap gap-2 mt-1">
                              {biasItem.modelsImplicated.map((modelId) => (
                                <span
                                  key={modelId}
                                  className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-amber-100 text-amber-800 border border-amber-200"
                                >
                                  {getModelDisplayNameSafe(modelId)}
                                </span>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Evidence */}
                        {biasItem.evidence && biasItem.evidence.length > 0 && (
                          <div className="mb-3">
                            <span className="text-sm font-medium text-slate-600 uppercase tracking-wide block mb-2">Evidence:</span>
                            <div className="space-y-2">
                              {biasItem.evidence.map((ev, evIdx) => (
                                <div key={evIdx} className="bg-white rounded border border-slate-200 p-3">
                                  <div className="flex items-start gap-2 mb-1">
                                    <span className="text-sm font-medium text-slate-700">{getModelDisplayNameSafe(ev.modelId)}:</span>
                                    <span className="text-sm text-slate-600 italic flex-1">"{ev.excerpt}"</span>
                                  </div>
                                  <p className="text-sm text-slate-600 ml-0 mt-1">{ev.rationale}</p>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Likely Causes */}
                        {biasItem.likelyCauses && biasItem.likelyCauses.length > 0 && (
                          <div className="mb-3">
                            <span className="text-sm font-medium text-slate-600 uppercase tracking-wide block mb-1">Likely Causes:</span>
                            <ul className="list-disc list-inside space-y-1">
                              {biasItem.likelyCauses.map((cause, causeIdx) => (
                                <li key={causeIdx} className="text-sm text-slate-700">{cause}</li>
                              ))}
                            </ul>
                          </div>
                        )}

                        {/* Impact */}
                        {biasItem.impact && (
                          <div className="mb-3">
                            <span className="text-sm font-medium text-slate-600 uppercase tracking-wide block mb-1">Impact:</span>
                            <p className="text-slate-700">{biasItem.impact}</p>
                          </div>
                        )}

                        {/* Mitigation Steps */}
                        {biasItem.mitigationSteps && biasItem.mitigationSteps.length > 0 && (
                          <div>
                            <span className="text-sm font-medium text-slate-600 uppercase tracking-wide block mb-1">Mitigation Steps:</span>
                            <ul className="list-disc list-inside space-y-1">
                              {biasItem.mitigationSteps.map((step, stepIdx) => (
                                <li key={stepIdx} className="text-sm text-slate-700">{step}</li>
                              ))}
                            </ul>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            // Show neutral message when no biases detected
            <div>
              <h2 className="text-lg font-semibold text-slate-900 mb-4">Bias & Blind Spots</h2>
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-4">
                <p className="text-sm text-slate-600">
                  No model-specific bias signals were confidently attributable from this run. Consider adding constraints or counter-sources.
                </p>
              </div>
            </div>
          )}

          {/* Open Questions */}
          {report.openQuestions && report.openQuestions.length > 0 && (
            <div>
              <h2 className="text-lg font-semibold text-slate-900 mb-4">Open Questions</h2>
              <ul className="space-y-2">
                {report.openQuestions.map((question, idx) => (
                  <li key={idx} className="flex items-start gap-2">
                    <span className="text-slate-400 mt-1">•</span>
                    <span className="text-slate-700">{question}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* Methodology */}
          {report.methodology && (
            <div className="bg-white rounded-lg border border-gray-200 p-6">
              <h2 className="text-lg font-semibold text-slate-900 mb-4">Methodology</h2>
              <p className="text-slate-700">{report.methodology}</p>
            </div>
          )}

          {/* Panel Verdict Summary Card */}
          {(() => {
            const verdict = buildPanelVerdict(question, report, gate);
            return <PanelVerdictCard verdict={verdict} gate={gate} />;
          })()}
      </div>
    );
  }


  // Empty state - no synthesis available
  return (
    <div className="bg-slate-50 border border-slate-200 rounded-lg p-6">
      <div className="text-center">
        <h3 className="text-sm font-semibold text-slate-800 mb-2">
          No Synthesis Available Yet
        </h3>
        <p className="text-sm text-slate-600 mb-4">
          {results.filter(r => r.status === "ok").length >= 2
            ? "Click the button below to generate a synthesis report."
            : "At least 2 successful model responses are required for synthesis."}
        </p>
        {results.filter(r => r.status === "ok").length >= 2 && runId && (
          <button
            onClick={() => {
              setSynthesisState(prev => ({ ...prev, status: "loading", error: null }));
              void generateSynthesis();
            }}
            className="px-4 py-2 bg-sky-600 text-white text-sm font-medium rounded-md hover:bg-sky-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            disabled={synthesisState.status === "loading" || reqInFlightRef.current}
          >
            {synthesisState.status === "loading" ? "Generating..." : "Generate Synthesis"}
          </button>
        )}
      </div>
    </div>
  );
}

