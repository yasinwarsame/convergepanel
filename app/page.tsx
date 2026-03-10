"use client";

/**
 * Home Page Component - Main Panel Interface
 * 
 * This is the primary user interface for ConvergePanel. It allows users to:
 * - Enter a question to ask multiple AI models
 * - Select which models to query (minimum 2 required)
 * - View real-time status of each model's response
 * - See synthesized consensus report with agreement/disagreement analysis
 * 
 * The component manages the entire panel execution flow:
 * 1. User enters question and selects models
 * 2. Validates input (minimum 2 models required)
 * 3. Sends request to /api/run-panel endpoint
 * 4. Displays real-time status updates
 * 5. Processes results and generates consensus report
 * 6. Displays unified answer, agreement map, and raw responses
 * 
 * SECURITY: This page requires authentication. Unauthenticated users are
 * redirected to the login page.
 */

import { useState, useEffect, Suspense, lazy, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import dynamic from "next/dynamic";
import { useAuth } from "@/components/AuthProvider";
import { ModelId, ModelResult, SynthesizedReport, RunPanelApiResponse } from "@/lib/types";
import { synthesizeReport } from "@/lib/consensus";
import { getModelDisplayNameSafe } from "@/lib/panelModels";
import ModelPicker from "@/components/ModelPicker";
import StatusPill from "@/components/StatusPill";
import StatusChip from "@/components/StatusChip";
import { getModelDisplayName } from "@/lib/modelInfo";
import { useUserPlan } from "@/hooks/useUserPlan";
import { trackEvent } from "@/lib/analytics";
import LandingPage from "@/components/LandingPage";
import { doc, getDoc } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { UserProfile } from "@/lib/types";
import { PLAN_CONFIG, getPlanConfigById } from "@/lib/billing/planConfig";
import { normalizeSelectedModels, getDefaultModelSelection } from "@/lib/utils/normalizeSelectedModels";
import { perf, trackSlowLoad } from "@/lib/utils/performance"; "@/lib/utils/performance";

// Lazy load heavy components - defer until after first paint
const ResultsDisplay = dynamic(() => import("@/components/ResultsDisplay"), {
  loading: () => (
    <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8">
      <div className="animate-pulse space-y-4">
        <div className="h-8 bg-slate-200 rounded w-1/3" />
        <div className="h-32 bg-slate-200 rounded" />
        <div className="h-24 bg-slate-200 rounded" />
      </div>
    </div>
  ),
  ssr: false, // Don't SSR heavy components
});

/**
 * Panel execution status
 * - idle: No panel run in progress
 * - running: Panel is currently executing
 * - complete: Panel finished successfully
 * - error: Panel execution failed
 */
type RunStatus = "idle" | "running" | "complete" | "error";

export default function Home() {
  // Performance: Mark app start
  useEffect(() => {
    perf.mark('app_start');
    if (typeof window !== 'undefined') {
      perf.mark('shell_rendered');
      perf.measure('time_to_shell', 'app_start', 'shell_rendered');
      
      // Log metrics after a delay to allow async work to complete
      setTimeout(() => {
        perf.logMetrics();
      }, 1000);
    }
  }, []);

  const router = useRouter();
  const { user, loading: authLoading, authReady } = useAuth();
  
  // Track auth resolution
  useEffect(() => {
    if (!authLoading) {
      perf.mark('auth_resolved');
      perf.measure('time_to_auth', 'app_start', 'auth_resolved');
    }
  }, [authLoading]);

  // useUserPlan hook - handles its own loading/error states internally
  const { plan, runsThisMonth, monthlyLimit, refresh: refreshUsage, loading: planLoading, error: planError } = useUserPlan();

  // Get plan label from PLAN_CONFIG (single source of truth)
  // Handle both PlanId ("free" | "lite" | "full") and legacy UserPlan ("solo" | "pro") values
  const planStr = (plan as string) || "free";
  const normalizedPlan = 
    planStr === "solo" ? "lite" :
    planStr === "pro" ? "full" :
    planStr === "free" || planStr === "lite" || planStr === "full" ? planStr :
    "free";
  
  // Defensive: Get plan config with fallback to free if plan is invalid
  let planConfig;
  try {
    planConfig = getPlanConfigById(normalizedPlan);
  } catch (configError: any) {
    console.error("[app/page] Invalid plan, falling back to free:", {
      plan: normalizedPlan,
      error: configError?.message,
    });
    planConfig = getPlanConfigById("free");
  }
  
  const planLabel = planConfig.label;
  
  // Defensive: Ensure monthlyLimit is valid (never null, never 400 for full plan)
  if (monthlyLimit !== null && monthlyLimit !== undefined) {
    // Verify monthlyLimit matches plan config (catch stale values)
    const expectedLimit = planConfig.monthlyLimit;
    if (monthlyLimit !== expectedLimit) {
      console.warn("[app/page] ⚠️ monthlyLimit mismatch - UI may show incorrect limit:", {
        plan: normalizedPlan,
        monthlyLimitFromAPI: monthlyLimit,
        expectedFromConfig: expectedLimit,
      });
      // Use plan config value instead (more reliable than API value)
      // Note: We can't directly modify monthlyLimit here since it comes from useUserPlan hook
      // But we log the warning so developers can identify when API returns stale values
    }
    
    // Safety check: Never allow 400 to be displayed for full plan
    if (normalizedPlan === "full" && monthlyLimit === 400) {
      console.error("[app/page] ⚠️ CRITICAL: Full plan showing 400 limit (stale value detected), should be 150");
      // In this case, we'd want to refresh or show correct value, but since monthlyLimit comes from hook,
      // we log the error so it can be investigated
    }
  }

  // User's question/prompt to send to models
  const [question, setQuestion] = useState("");
  
  // Models selected for this panel run
  // Start with empty selection - users will choose their models
  // For 3-model plans (free/lite), users can select 2-3 models
  // For 5-model plans (full), users can select 2-5 models
  const [selectedModels, setSelectedModels] = useState<ModelId[]>([]);
  
  // Set default selection based on plan when plan is available
  // Plans: Free=2, Lite=3, Full=5
  // Use normalization to ensure Free users always get exactly 2 models
  useEffect(() => {
    if (planConfig) {
      const maxModels = planConfig.maxModels;
      
      // If no models selected yet, set default based on plan
      if (selectedModels.length === 0) {
        const defaultSelection = getDefaultModelSelection(maxModels);
        setSelectedModels(defaultSelection);
      } else {
        // If models are already selected, normalize them to respect plan limits
        // This handles cases where plan changes or models were set before plan loaded
        const normalized = normalizeSelectedModels(selectedModels, maxModels);
        if (JSON.stringify(normalized.sort()) !== JSON.stringify(selectedModels.sort())) {
          setSelectedModels(normalized);
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planConfig?.maxModels]); // Only run when plan config changes
  
  // Current execution status of the panel
  const [runStatus, setRunStatus] = useState<RunStatus>("idle");
  
  // Real-time status of each model (queued -> thinking -> done/error)
  // Used to show status pills during execution
  const [modelStatuses, setModelStatuses] = useState<
    Record<ModelId, "queued" | "thinking" | "ok" | "error" | "timeout" | "refused">
  >({} as Record<ModelId, "queued" | "thinking" | "ok" | "error" | "timeout" | "refused">);
  
  // Raw results from each model (after panel completes)
  const [results, setResults] = useState<ModelResult[]>([]);
  
  // Synthesized consensus report (only generated if ≥2 models respond successfully)
  const [synthesizedReport, setSynthesizedReport] =
    useState<SynthesizedReport | null>(null);
  
  // Synthesis report state (for Synthesis tab)
  const [synthesisStatus, setSynthesisStatus] = useState<"idle" | "loading" | "complete" | "error">("idle");
  const [synthesisReport, setSynthesisReport] = useState<string | any | null>(null); // Can be string (legacy), SynthesisReportV2, or StructuredSynthesisReport
  const [synthesisError, setSynthesisError] = useState<string | null>(null);
  const [synthesisGeneratedForRunId, setSynthesisGeneratedForRunId] = useState<string | null>(null);
  
  // Current run ID for associating synthesis reports with runs
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  
  // Error message if something goes wrong
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);

  // Floating scroll navigation: show up/down arrows when user has scrolled down
  const [showScrollNav, setShowScrollNav] = useState(false);
  
  // TEMPORARY MVP: No plan-based model limiting
  // TODO: Re-enable this effect after MVP validation
  // useEffect(() => {
  //   if (plan === "free" && selectedModels.length > 2) {
  //     setSelectedModels(selectedModels.slice(0, 2));
  //   }
  // }, [plan, selectedModels.length]);

  // Example questions for quick start
  const EXAMPLE_QUESTIONS = [
    "What are the main causes of inflation in the US, and where do economists disagree?",
    "Compare the pros and cons of remote-first vs hybrid workplaces.",
    "How effective are carbon taxes compared to other climate policies?",
  ];

  // State to track onboarding check (deferred - doesn't block initial render)
  const [checkingOnboarding, setCheckingOnboarding] = useState(false);
  const [onboardingError, setOnboardingError] = useState<string | null>(null);
  const [onboardingCompleted, setOnboardingCompleted] = useState<boolean | null>(null);
  const [onboardingCheckStarted, setOnboardingCheckStarted] = useState(false);

  /**
   * Check if user has completed onboarding (DEFERRED - runs after first paint)
   * 
   * PERFORMANCE: This check is deferred until after the shell renders.
   * It runs in requestIdleCallback (or setTimeout fallback) to avoid blocking.
   * 
   * If the user has signed up but not completed onboarding,
   * send them to /onboarding before they can use the main app.
   */
  useEffect(() => {
    // Don't check onboarding if already checked or if auth is still loading
    if (onboardingCheckStarted || authLoading || !user) {
        return;
      }

    // Defer onboarding check until after first paint
    // Use requestIdleCallback for better performance, fallback to setTimeout
    const scheduleCheck = () => {
      setOnboardingCheckStarted(true);
      setCheckingOnboarding(true);

      async function checkOnboarding() {
        if (!user) return; // Guard: user must exist
        try {
          // Fetch user profile from Firestore to check onboardingCompleted flag
          const userDocRef = doc(db, "users", user.uid);
        const userDoc = await getDoc(userDocRef);

        if (userDoc.exists()) {
          const userData = userDoc.data() as UserProfile;
          const completed = userData.onboardingCompleted === true;
          setOnboardingCompleted(completed);
          setOnboardingError(null);

          // If onboarding not completed, redirect to onboarding page
          if (!completed) {
            router.push("/onboarding");
            return;
          }
        } else {
            // User doc doesn't exist yet - redirect to onboarding to create the profile
          router.push("/onboarding");
          return;
        }
      } catch (err) {
        // Log error for debugging but don't block the user
        console.error("[app/page.tsx] Error checking onboarding status:", err);
        const errorMessage = err instanceof Error ? err.message : "Unknown error";
        setOnboardingError(errorMessage);
        // On error, allow access (don't block user) - assume onboarding is done
        setOnboardingCompleted(true);
      } finally {
          // Always set checkingOnboarding to false
        setCheckingOnboarding(false);
      }
    }

      // Add timeout safety
      const timeoutId = setTimeout(() => {
        console.warn("[app/page.tsx] Onboarding check timeout - allowing access");
        setOnboardingCompleted(true);
        setCheckingOnboarding(false);
      }, 5000);

      checkOnboarding().finally(() => {
        clearTimeout(timeoutId);
      });
    };

    // Defer until after first paint
    if (typeof window !== 'undefined' && 'requestIdleCallback' in window) {
      (window as any).requestIdleCallback(scheduleCheck, { timeout: 1000 });
    } else {
      setTimeout(scheduleCheck, 100);
    }
  }, [user, authLoading, onboardingCheckStarted, router]);

  // Slow load detector: log pending states after 3 seconds
  useEffect(() => {
    const timeoutId = setTimeout(() => {
      trackSlowLoad({
        authLoading,
        checkingOnboarding,
        planLoading,
        onboardingCompleted: onboardingCompleted === null,
      });
    }, 3000);

    return () => clearTimeout(timeoutId);
  }, [authLoading, checkingOnboarding, planLoading, onboardingCompleted]);

  // Floating scroll navigation: show up/down arrows when user has scrolled down
  useEffect(() => {
    // Only show scroll nav when results are present and user has scrolled
    if (runStatus === "complete" && results.length > 0) {
      const onScroll = () => {
        setShowScrollNav(window.scrollY > 400);
      };
      window.addEventListener("scroll", onScroll);
      return () => window.removeEventListener("scroll", onScroll);
    } else {
      setShowScrollNav(false);
    }
  }, [runStatus, results.length]);

  // PERFORMANCE: Show shell immediately, don't block on auth/onboarding
  // Show landing page for logged-out users (only if auth resolved and no user)
  if (!authLoading && !user) {
    return <LandingPage />;
  }

  // If onboarding not completed and we've checked, redirect (non-blocking)
  // Show inline message while redirect happens instead of blocking entire page
  if (onboardingCompleted === false && !checkingOnboarding) {
    return (
      <main className="max-w-4xl mx-auto px-4 py-10">
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 px-6 py-8 text-center">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-sky-400 border-t-transparent mx-auto mb-4" />
          <p className="text-sm text-slate-600">Redirecting to onboarding…</p>
        </div>
      </main>
    );
  }

  // Show error state if onboarding check failed (but still allow access)
  if (onboardingError && user) {
    console.warn("[app/page.tsx] Onboarding check failed but allowing access:", onboardingError);
  }

  // PERFORMANCE: Render shell immediately even if data is still loading
  // Show inline loading states instead of blocking the entire page

  // Show error state if plan loading failed (but still allow panel usage)
  // This prevents silent failures and helps with debugging
  // Don't block rendering - show the panel UI even if plan loading failed
  if (planError && user) {
    console.warn("[app/page.tsx] Plan loading failed but allowing access:", planError);
  }


  // Removed: generateAnonymizedSynthesis function - anonymization no longer used

  /**
   * Handle panel execution
   * 
   * This function:
   * 1. Validates input (minimum 2 models, non-empty question)
   * 2. Resets state for new run
   * 3. Shows initial "queued" status for all models
   * 4. Updates to "thinking" status after brief delay (for UX)
   * 5. Calls API endpoint to run panel in parallel
   * 6. Updates statuses based on results
   * 7. Generates consensus report if ≥2 models succeeded
   * 
   * ERROR HANDLING STRATEGY:
   * - We intentionally avoid throwing errors to prevent Next.js error boundary from appearing
   * - All errors are handled locally by setting error state (setError, setErrorCode)
   * - Network errors, API errors, and parsing errors all set error state and return early
   * - The outer try/catch is a safety net for truly unexpected errors
   * - Users see friendly inline alerts, not the Next.js error overlay
   */
  const handleRunPanel = async () => {
    // Validation: Wait for auth to be ready and user to be signed in
    if (!authReady || !user) {
      setError("Please sign in to run a panel");
      return;
    }

    // Validation: Enforce minimum 2 models rule
    if (selectedModels.length < 2) {
      setError("Please select at least 2 models");
      return;
    }

    // Validation: Question must not be empty
    if (!question.trim()) {
      setError("Please enter a question");
      return;
    }

    // Reset state for new panel run
    setError(null);
    setRunStatus("running");
    setResults([]);
    setSynthesizedReport(null);
    // Reset synthesis state for new run
    setSynthesisStatus("idle");
    setSynthesisReport(null);
    setSynthesisError(null);
    setSynthesisGeneratedForRunId(null);
    setCurrentRunId(null);

    // Initialize all selected models with "queued" status
    // This shows in the UI immediately when panel starts
    const initialStatuses = {} as Record<
      ModelId,
      "queued" | "thinking" | "ok" | "error" | "timeout" | "refused"
    >;
    selectedModels.forEach((id) => {
      initialStatuses[id] = "queued";
    });
    setModelStatuses(initialStatuses);

    try {
      // Update status to "thinking" after brief delay
      // This provides visual feedback that requests are being processed
      setTimeout(() => {
        setModelStatuses((prev) => {
          const updated = { ...prev };
          selectedModels.forEach((id) => {
            if (updated[id] === "queued") {
              updated[id] = "thinking";
            }
          });
          return updated;
        });
      }, 100);

      // Call API endpoint to execute panel
      // The API runs all model requests in parallel on the server
      // We handle all errors locally without throwing to prevent Next.js error boundary from appearing
      let response: Response;
      try {
        // Import authedFetch helper
        const { authedFetch } = await import("@/lib/client/authedFetch");

        response = await authedFetch("/api/run-panel", {
          user,
          authReady,
          method: "POST",
          body: JSON.stringify({
            question: question.trim(),
            selectedModels,
          }),
        });

        // Retry with force token refresh if we get 401 (stale token edge case)
        if (response.status === 401 && user) {
          if (process.env.NODE_ENV !== "production") {
            console.warn("[handleRunPanel] Got 401, retrying with force token refresh");
          }
          response = await authedFetch("/api/run-panel", {
            user,
            authReady,
            forceTokenRefresh: true,
            method: "POST",
            body: JSON.stringify({
              question: question.trim(),
              selectedModels,
            }),
          });
        }
      } catch (fetchError: any) {
        // Network error or auth error (fetch failed) - don't throw, set error state instead
        if (process.env.NODE_ENV !== "production") {
          console.error("Error when calling /api/run-panel:", fetchError);
        }
        setError("Network error. Please check your connection and try again.");
        setErrorCode(null);
        setRunStatus("error");
        setModelStatuses({} as Record<ModelId, "queued" | "thinking" | "ok" | "error" | "timeout" | "refused">);
        return;
      }

      // Read response text once (can only be read once)
      // Then check if it's JSON and parse it
      let responseText: string;
      try {
        responseText = await response.text();
      } catch (textError: any) {
        // Failed to read response text - don't throw, set error state instead
        console.error("[panel] Failed to read response text:", textError);
        setError("Invalid response from server. Please try again.");
        setErrorCode(null);
        setRunStatus("error");
        setModelStatuses({} as Record<ModelId, "queued" | "thinking" | "ok" | "error" | "timeout" | "refused">);
        return;
      }

      // Check if response is JSON (not HTML error page)
      // If server returns non-JSON, handle gracefully without throwing
      const contentType = response.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
        // Server returned HTML (likely an error page)
        // Don't throw - set error state instead to avoid triggering Next.js error boundary
        console.error("[panel] Non-JSON response from server:", {
          status: response.status,
          statusText: response.statusText,
          contentType,
          responseText: responseText.substring(0, 500),
        });
        setError(
          `Server error (${response.status}). The server returned an unexpected response. Please try again or contact support.`
        );
        setErrorCode(null);
        setRunStatus("error");
        setModelStatuses({} as Record<ModelId, "queued" | "thinking" | "ok" | "error" | "timeout" | "refused">);
        return;
      }

      // Parse JSON response
      // If parsing fails, handle gracefully without throwing
      let data: RunPanelApiResponse;
      try {
        console.log("[panel] Raw API response (first 500 chars):", responseText.substring(0, 500)); // Log for debugging
        data = JSON.parse(responseText);
      } catch (jsonError: any) {
        // JSON parsing failed - log the raw response for debugging
        console.error("[panel] Failed to parse JSON response:", {
          error: jsonError,
          responseText: responseText.substring(0, 1000), // First 1000 chars
          status: response.status,
          statusText: response.statusText,
        });
        setError("Invalid response from server. Please try again.");
        setErrorCode(null);
        setRunStatus("error");
        setModelStatuses({} as Record<ModelId, "queued" | "thinking" | "ok" | "error" | "timeout" | "refused">);
        return;
      }

      // Handle API errors using standardized response format
      // We read errorCode and message from the JSON response and set local error state
      // This ensures we never throw errors that would trigger Next.js error boundary
      // Network/API errors are surfaced via errorMessage state only - we never throw
      if (!data.ok) {
        // Always log error details in development (check both NODE_ENV and if we're not in production build)
        // devDetails is only included in non-production environments and helps with debugging
        // This should NOT be shown to users - it's for developer console inspection only
        const isDev = process.env.NODE_ENV !== "production" || typeof window !== "undefined";
        if ((data as any).devDetails) {
          console.error("[panel] ERROR from /api/run-panel:", {
            errorCode: data.errorCode,
            message: data.message,
            devDetails: (data as any).devDetails,
            fullResponse: data,
          });
        } else {
          // Even if no devDetails, log the error for debugging
          console.error("[panel] ERROR from /api/run-panel (no devDetails):", {
            errorCode: data.errorCode,
            message: data.message,
            fullResponse: data,
          });
        }
        
        // Handle specific error codes with user-friendly messages
        let errorMessage = data.message || "Server error. Please try again.";
        
        // Handle standardized error codes (both old and new formats for backward compatibility)
        // Type assertion needed because RunPanelApiResponse type doesn't include all error fields
        const errorData = data as any;
        const errorCode = errorData.error?.code || errorData.errorCode || errorData.error;
        const errorMessageFromResponse = errorData.error?.message || data.message;
        
        if (errorCode === "PLAN_MODEL_LIMIT_REACHED" || errorCode === "MODEL_LIMIT" || errorCode === "MODEL_LIMIT_REACHED") {
          // Use the error message from server (already plan-aware)
          errorMessage = errorMessageFromResponse || `Your plan allows up to ${errorData.maxModelsPerRun} models per run.`;
        } else if (errorCode === "PLAN_RUN_LIMIT_REACHED" || errorCode === "RUN_LIMIT_REACHED") {
          // Standardized RUN_LIMIT_REACHED error format
          // Server returns: { error: "RUN_LIMIT_REACHED", runsUsed, runsLimit, resetsAt, plan }
          const runsUsed = errorData.runsUsed ?? errorData.runsThisMonth ?? 0;
          const runsLimit = errorData.runsLimit ?? errorData.maxRunsPerMonth ?? 8;
          errorMessage = `You've reached your monthly run limit (${runsUsed} / ${runsLimit}). Your limit resets on ${errorData.resetsAt ? new Date(errorData.resetsAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }) : 'the first of next month'}.`;
        } else if (errorCode === "unauthorized") {
          errorMessage = "Please sign in to run a panel.";
        }
        
        // Set error code and message from API response
        // errorCode allows us to show specific UI for different error types (e.g. quota_exceeded, RUN_LIMIT_REACHED)
        // Use standardized error code if available, otherwise fall back to errorCode
        const normalizedErrorCode = errorCode === "RUN_LIMIT_REACHED" || errorCode === "PLAN_RUN_LIMIT_REACHED"
          ? "RUN_LIMIT_REACHED"
          : errorCode || null;
        setErrorCode(normalizedErrorCode);
        setError(errorMessage);
        setRunStatus("error");
        setModelStatuses({} as Record<ModelId, "queued" | "thinking" | "ok" | "error" | "timeout" | "refused">);
        
        // Refresh usage data if we hit a limit
        if (normalizedErrorCode === "RUN_LIMIT_REACHED" || data.errorCode === "PLAN_MODEL_LIMIT_REACHED") {
          refreshUsage();
        }
        return;
      }

      // Validate response structure (should have results array)
      if (!data.results || !Array.isArray(data.results)) {
        console.error("Invalid response structure:", data);
        setError("Invalid response format from server. Please try again.");
        setRunStatus("error");
        return;
      }
      
      // TEMPORARY DEBUG LOG: Log the raw results from API to verify all models are present
      // This helps diagnose why some models might not appear in the UI
      console.log("[panel] Raw results from API:", data.results);
      console.log("[panel] Results count:", data.results.length);
      console.log("[panel] Results model IDs:", data.results.map((r: ModelResult) => r.modelId));
      console.log("[panel] Results statuses:", data.results.map((r: ModelResult) => ({ modelId: r.modelId, status: r.status })));
      
      // Capture runId from API response for associating synthesis reports with runs
      if (data.runId) {
        setCurrentRunId(data.runId);
      }
      
      setResults(data.results);

      // Update final statuses for each model
      // Status can be: ok, error, timeout, or refused
      // Add defensive error handling to prevent crashes from malformed results
      const finalStatuses = {} as Record<
        ModelId,
        "queued" | "thinking" | "ok" | "error" | "timeout" | "refused"
      >;
      try {
      data.results.forEach((result: ModelResult) => {
          // Defensive check: ensure result has required fields
          if (result && result.modelId && result.status) {
        finalStatuses[result.modelId] = result.status;
          } else {
            console.warn("[panel] Skipping malformed result:", result);
          }
      });
      } catch (statusError: any) {
        // If status mapping fails, log but don't crash - continue with empty statuses
        console.error("[panel] Error mapping model statuses:", statusError);
      }
      setModelStatuses(finalStatuses);

      // Refresh usage data after successful run
      if (data.usage) {
        // Update local state immediately for instant UI feedback
        refreshUsage();
        
        // Log for debugging
        console.log("[panel] Usage updated:", {
          runsThisMonth: data.usage.runsThisMonth,
          maxRunsPerMonth: data.usage.maxRunsPerMonth,
        });
      }

      // Generate consensus report only if ≥2 models responded successfully
      // This is a core requirement: convergence needs multiple perspectives
      const successfulCount = data.results.filter(
        (r: ModelResult) => r.status === "ok"
      ).length;

      if (successfulCount >= 2) {
        // Run consensus engine to analyze responses
        // This extracts claims, clusters them, and identifies agreements/disagreements
        // Add defensive error handling so synthesis failures don't crash the UI
        try {
        const report = synthesizeReport(data.results);
        setSynthesizedReport(report);
        } catch (synthesisError: any) {
          // Log synthesis error but don't crash - user can still see individual model responses
          console.error("[panel] Error synthesizing report:", synthesisError);
          // Continue without synthesized report - ResultsDisplay will show individual responses
          // Don't set error state here since we still have valid model results to display
        }
      }
      // If only 1 model succeeded, ResultsDisplay will show a warning banner
      // and skip synthesis (handled in ResultsDisplay component)

      setRunStatus("complete");
      
      // Refresh usage data after successful run
      await refreshUsage();
      
      // Track analytics event
      trackEvent("panel_run", {
        models: selectedModels,
        plan: plan || "unknown",
        questionLength: question.trim().length,
      });
      
      // AUTO-GENERATE SYNTHESIS: Start synthesis generation in background immediately after panel completes
      // This ensures synthesis is ready when user clicks "Generate Synthesis" button
      // Only auto-generate if we have >=2 successful results and a runId
      if (data.runId && successfulCount >= 2) {
        // Trigger synthesis generation in background (non-blocking)
        // Use void to explicitly ignore the promise - we don't want to block or handle errors here
        void generateSynthesisAutomatically(data.runId, question, data.results, synthesizedReport);
      }
    } catch (err: any) {
      // Handle any unexpected errors during execution
      // This catch block should rarely be hit now since we handle most errors above without throwing
      // Log detailed error to console for debugging, but show friendly message to user
      // We intentionally avoid throwing here to prevent Next.js error boundary from showing
      console.error("Panel execution error:", err);
      
      // Provide user-friendly error messages
      // Internal error details stay in logs, users see generic message
      let errorMessage = "Something went wrong running the panel. Please try again. If this keeps happening, contact support.";
      
      if (err instanceof TypeError && err.message.includes("fetch")) {
        errorMessage = "Network error. Please check your connection and try again.";
      } else if (err instanceof SyntaxError) {
        errorMessage = "Server response error. Please try again or contact support.";
      }
      
      // Set error state instead of throwing - this prevents Next.js error boundary from appearing
      setError(errorMessage);
      setErrorCode(null);
      setRunStatus("error");
      
      // Reset model statuses on error
      setModelStatuses({} as Record<ModelId, "queued" | "thinking" | "ok" | "error" | "timeout" | "refused">);
    }
  };

  /**
   * Automatically generate synthesis report in background after panel completes
   * This runs asynchronously and updates synthesis state without blocking UI
   */
  const generateSynthesisAutomatically = async (
    runId: string,
    questionText: string,
    panelResults: ModelResult[],
    consensusReport: SynthesizedReport | null
  ) => {
    // Guard: Don't generate if already generated for this runId
    if (synthesisGeneratedForRunId === runId) {
      console.log("[auto-synthesis] Synthesis already generated for this runId, skipping:", runId);
      return;
    }

    // Guard: Don't generate if already generating
    if (synthesisStatus === "loading") {
      console.log("[auto-synthesis] Synthesis already in progress, skipping");
      return;
    }

    // Set loading state
    setSynthesisStatus("loading");
    setSynthesisError(null);
    setSynthesisGeneratedForRunId(runId);

    try {
      // Check cache first (GET request) - instant response if cached
      const headers: Record<string, string> = {};
      if (user) {
        try {
          const idToken = await user.getIdToken();
          headers["Authorization"] = `Bearer ${idToken}`;
        } catch (tokenError: any) {
          console.warn("[auto-synthesis] Failed to get ID token for cache check:", tokenError);
        }
      }

      // Try cache first
      try {
        const cacheResponse = await fetch(
          `/api/synthesize-panel?runId=${encodeURIComponent(runId)}&mode=cache`,
          {
            method: "GET",
            headers,
            credentials: "include",
          }
        );

        if (cacheResponse.ok) {
          const cacheData = await cacheResponse.json();
          if (cacheData.ok && cacheData.report) {
            console.log("[auto-synthesis] Cache hit - synthesis ready instantly");
            setSynthesisStatus("complete");
            setSynthesisReport(cacheData.report);
            setSynthesisError(null);
            return; // Success - exit early
          }
        }
      } catch (cacheError: any) {
        // Cache check failed - continue to generation (non-fatal)
        console.log("[auto-synthesis] Cache check failed, proceeding with generation:", cacheError?.message);
      }

      // Cache miss - generate synthesis (POST request)
      // Filter to only successful results with non-empty text
      const okResults = panelResults.filter(
        (r) => r.status === "ok" && ((r as any).rawTextFull?.trim()?.length > 0 || (r as any).rawText?.trim()?.length > 0 || (r as any).text?.trim()?.length > 0)
      );

      if (okResults.length < 2) {
        throw new Error("Synthesis requires at least 2 successful model responses.");
      }

      // Build payload
      const resultsPayload = okResults.map((result) => ({
        modelId: result.modelId,
        text: (result as any).rawTextFull || (result as any).rawText || (result as any).text || "",
      }));

      // Include clusters if available (from consensus report)
      const agreementClusters = consensusReport?.consensusAnalysis?.agreementClusters || [];
      const clusters = consensusReport?.consensusAnalysis?.clusters || [];

      // Get auth token for generation
      if (user) {
        try {
          const idToken = await user.getIdToken();
          headers["Authorization"] = `Bearer ${idToken}`;
        } catch (tokenError: any) {
          console.warn("[auto-synthesis] Failed to get ID token:", tokenError);
        }
      }

      // Call synthesis API (non-blocking, 5-minute timeout)
      const response = await fetch("/api/synthesize-panel", {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          runId,
          question: questionText.trim(),
          results: resultsPayload,
          ...(agreementClusters.length > 0 && { agreementClusters }),
          ...(clusters.length > 0 && { clusters }),
        }),
        credentials: "include",
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || `Synthesis failed: ${response.status} ${response.statusText}`);
      }

      const data = await response.json();

      if (data.ok && data.report) {
        console.log("[auto-synthesis] ✅ Synthesis generated successfully in background");
        setSynthesisStatus("complete");
        setSynthesisReport(data.report);
        setSynthesisError(null);
      } else {
        throw new Error(data.error?.message || "Synthesis returned invalid response");
      }
    } catch (error: any) {
      console.error("[auto-synthesis] Failed to generate synthesis automatically:", error);
      // Set error state but don't block UI - user can still manually generate later
      setSynthesisStatus("error");
      setSynthesisError(error.message || "Failed to generate synthesis automatically");
      // Don't clear synthesisGeneratedForRunId - allow manual retry
    }
  };

  /**
   * Re-run the same panel with same question and models
   */
  const handleRerun = () => {
    handleRunPanel();
  };

  /**
   * Handle "Add another model" action
   * 
   * Currently just re-runs the panel. In a future enhancement, this could
   * open the model picker to add additional models before re-running.
   */
  const handleAddModel = () => {
    // This would ideally open the model picker, but for now just rerun
    handleRunPanel();
  };

  /**
   * Determine if panel can be run
   * 
   * Requirements:
   * - User must be authenticated (client-side gating)
   * - At least 2 models selected (enforced by core rule)
   * - Question is not empty
   */
  const canRun = !!user && selectedModels.length >= 2 && question.trim().length > 0;

  // Helper to translate errors to user-friendly messages
  // Internal error details stay in logs, users see friendly text
  const getUserFriendlyError = (err: string | null): string | null => {
    if (!err) return null;
    
    // Internal errors that should be hidden
    if (err.includes("contestedClusters") || err.includes("is not defined")) {
      return "Something went wrong running the panel. Please try again. If this keeps happening, contact support.";
    }
    
    // Network errors
    if (err.includes("Network") || err.includes("fetch")) {
      return "Network error. Please check your connection and try again.";
    }
    
    // Server errors
    if (err.includes("Server error") || err.includes("500")) {
      return "Server error. Please try again. If this keeps happening, contact support.";
    }
    
    // Return original error if it's user-friendly
    return err;
  };

  return (
    <main className="max-w-4xl mx-auto px-4 py-10">
      <section className="bg-white rounded-2xl shadow-sm border border-slate-200 px-6 py-5 md:px-8 md:py-6">
        {/* Header: title + meta tags + plan badge */}
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            {/* Title */}
            <h1 className="text-3xl md:text-4xl font-semibold tracking-tight text-slate-900">
              Ask your expert panel
            </h1>
            
            {/* Subtitle with improved styling */}
            <div className="mt-3 flex flex-wrap items-center gap-2 text-sm md:text-base">
              <span className="inline-flex items-center rounded-full bg-sky-50 px-3 py-1 text-sm font-semibold text-sky-700">
                Deep research
              </span>
              <span className="text-slate-300">·</span>
              <span className="text-slate-500">Multi-LLM expert panel</span>
              <span className="text-slate-300">·</span>
              <span className="text-slate-500">Trust-focused answers</span>
            </div>
          </div>
          
          {/* Plan badge - right-aligned on desktop */}
          {user && monthlyLimit != null && (
            <div className="mt-1 md:mt-0 flex items-center gap-3 flex-wrap sm:justify-end">
              <div className="inline-flex items-center rounded-full bg-blue-50 px-4 py-1.5">
                <span className="text-sm font-semibold text-sky-700">
                  {planLabel.replace(" Plan", " plan").replace(" Panel", " panel")}
                </span>
                <span className="mx-1 text-slate-400">·</span>
                <span
                  className={
                    runsThisMonth >= monthlyLimit
                      ? "text-sm text-amber-600"
                      : "text-sm text-slate-700"
                  }
                >
                  {runsThisMonth} / {monthlyLimit}
                </span>
                <span className="ml-1 text-xs text-slate-500">runs used</span>
              </div>
              {/* Upgrade link for free plan users */}
              {planStr === "free" && (
                <button
                  onClick={() => router.push("/billing")}
                  className="text-sm font-medium text-sky-700 hover:text-sky-800 hover:underline transition-colors"
                >
                  Upgrade plan
                </button>
              )}
            </div>
          )}
        </div>

        {/* Divider between header and question area */}
        <div className="border-b border-slate-100 mt-6 mb-6"></div>

        {/* Question card: label + textarea + helper text */}
        <div className="bg-slate-100 rounded-2xl p-6 md:p-8">
          <div className="rounded-2xl bg-white shadow-sm border border-slate-200 focus-within:ring-2 focus-within:ring-sky-400 focus-within:border-sky-300 transition-all">
            {/* Question label */}
            <label htmlFor="question" className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1 px-6 pt-5">
              Question
              </label>
            
            {/* Textarea */}
              <textarea
                id="question"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    if (canRun && runStatus !== "running") {
                      handleRunPanel();
                    }
                  }
                }}
              // Encourage users to supply optional Context: block in the same textarea.
              placeholder={"Example: Question: How do economists explain the persistence of inflation after 2021?\nContext: Paste any relevant excerpts, notes, or data here. (Optional)"}
              className="w-full border-none outline-none bg-transparent resize-none text-base md:text-lg leading-relaxed text-slate-900 px-6 pb-4"
                rows={4}
                disabled={runStatus === "running"}
              />
            
            {/* Helper row under textarea */}
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 px-6 pb-5 border-t border-slate-100 pt-3">
              <p className="text-xs text-slate-500">
                {/* Explain the Question / Context convention so users know how parsing works */}
                Tip: Start with <span className="font-semibold">Question:</span> and, if needed, add an optional <span className="font-semibold">Context:</span> section underneath. Anything after <span className="font-mono">Context:</span> will be treated as source material (excerpts, notes, or copied documents) for the panel to analyze.
              </p>
              {/* Placeholder for future character count or "long-form friendly" note */}
              {/* <span className="text-xs text-slate-400">Long-form friendly</span> */}
            </div>
          </div>
        </div>

        {/* Keyboard shortcut hint + deep research description */}
        <p className="text-sm text-slate-500 mt-3">
          Press <span className="font-semibold font-mono">Cmd/Ctrl + Enter</span> to run the panel.
        </p>
        <p className="text-sm text-slate-500 leading-relaxed mt-1">
          Ask serious, research-level questions. ConvergePanel will run a multi-LLM panel, then return a synthesized deep-research brief with consensus, disagreements, biases, and blind spots.
        </p>

            {/* Model Picker */}
          {/* NOTE: For MVP testing, all five models (GPT 5.2, Claude Opus 4.5, Grok 4, Perplexity Pro, Gemini 3 Pro)
              are fully enabled regardless of plan. Gating will be reintroduced later. */}
            <ModelPicker
              selectedModels={selectedModels}
              onSelectionChange={(models) => {
                // Normalize selection when user changes models to ensure it respects plan limits
                const maxModels = planConfig?.maxModels ?? 2;
                const normalized = normalizeSelectedModels(models, maxModels);
                setSelectedModels(normalized);
              }}
              plan={normalizedPlan as any}
            />

          {/* TEMPORARY MVP: No plan-based notices shown */}
          {/* TODO: Re-enable plan-based notices after MVP validation */}

          {/* Run Button & Status */}
            <div className="space-y-3">
              {!user && !authLoading && (
              <div className="flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                <span className="mt-0.5">⚠️</span>
                <p>
                  Please <Link href="/login" className="font-medium underline">sign in</Link> to run ConvergePanel.
                  </p>
                </div>
              )}
              
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                {/* Visually distinguish the "running" state so users can tell when the panel is
                    thinking vs. when results are ready. */}
                <button
                type="button"
                  onClick={handleRunPanel}
                disabled={runStatus === "running" || !canRun}
                aria-busy={runStatus === "running"}
                className={`inline-flex w-full sm:w-auto items-center justify-center rounded-xl px-6 py-2.5 text-sm font-semibold shadow-sm transition-colors ${
                  runStatus === "running"
                    ? "bg-slate-400 text-white cursor-wait animate-pulse"
                    : !canRun
                    ? "bg-slate-300 text-white cursor-not-allowed opacity-50"
                    : "bg-sky-600 text-white hover:bg-sky-700"
                }`}
              >
                {runStatus === "running" && (
                  <svg
                    className="mr-2 h-4 w-4 animate-spin"
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
                  >
                    <circle
                      className="opacity-25"
                      cx="12"
                      cy="12"
                      r="10"
                      stroke="currentColor"
                      strokeWidth="4"
                    />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
                    />
                  </svg>
                )}
                {runStatus === "running" ? "Running panel…" : "Run Panel"}
                </button>
              <p className="text-xs text-slate-500">
                You can also press <span className="font-semibold">Cmd/Ctrl + Enter</span>.
              </p>
            </div>

            {/* Model Status Chips While Running */}
            {runStatus === "running" && (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-500">
                <span className="font-medium text-slate-700">Querying models:</span>
                {selectedModels.map((modelId) => {
                  const status = modelStatuses[modelId] || "queued";
                  return (
                    <StatusChip
                      key={modelId}
                      label={getModelDisplayName(modelId)}
                      status={status}
                      modelId={modelId} // Pass modelId so chips use model-specific colors
                    />
                  );
                })}
              </div>
            )}

            {/* Error Display */}
            {/* Network/API errors are surfaced via errorMessage state only - we never throw to avoid Next.js error boundary */}
            {/* Show general error message (but not if it's quota_exceeded or RUN_LIMIT_REACHED, which have their own displays) */}
            {error && errorCode !== "quota_exceeded" && errorCode !== "RUN_LIMIT_REACHED" && (
              <div className="mt-4 flex items-start gap-2 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
                <span className="mt-0.5">⚠️</span>
                <p>{getUserFriendlyError(error) || error}</p>
              </div>
            )}
            
            {/* RUN_LIMIT_REACHED Error (Special Handling) */}
            {/* This errorCode gets special UI treatment with reset date and upgrade button */}
            {errorCode === "RUN_LIMIT_REACHED" && (
              <div className="mt-4 flex items-start gap-2 rounded-xl border border-orange-200 bg-orange-50 px-4 py-3 text-sm">
                <span className="mt-0.5 text-orange-600">⛔</span>
                <div className="flex-1">
                  <p className="font-semibold text-orange-900 mb-1">
                    You've reached your monthly run limit
                  </p>
                  <p className="text-orange-800 mb-2">
                    {error || "Your monthly limit has been reached. Your limit resets on the first of next month."}
                  </p>
                  <div className="flex items-center gap-3 mt-3">
                    <button
                      type="button"
                      onClick={() => {
                        router.push("/billing");
                      }}
                      className="rounded-lg bg-orange-600 px-4 py-2 text-sm font-medium text-white hover:bg-orange-700 transition-colors"
                    >
                      Upgrade Plan
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        router.push("/billing");
                      }}
                      className="text-sm font-medium text-orange-800 underline hover:text-orange-900"
                    >
                      View Usage
                    </button>
                  </div>
                </div>
              </div>
            )}
            
            {/* Quota Exceeded Error (Special Handling) */}
            {/* This errorCode gets special UI treatment with upgrade button */}
            {errorCode === "quota_exceeded" && (
              <div className="mt-4 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                <span className="mt-0.5">⚠️</span>
                <p>
                  {error || "You've used your free panel runs for this month."}{" "}
                  <button
                    type="button"
                    onClick={() => {
                      // TODO: Navigate to upgrade page when Stripe is integrated
                      alert("Upgrade feature coming soon!");
                    }}
                    className="font-semibold underline hover:text-amber-900"
                  >
                    Upgrade (coming soon)
                  </button>{" "}
                  or try again next month.
                </p>
            </div>
            )}
          </div>

          {/* Example Questions */}
          <div className="mt-4 flex flex-wrap gap-2 text-xs">
            <span className="text-slate-500">Try one:</span>
            {EXAMPLE_QUESTIONS.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => setQuestion(q)}
                className="rounded-full border border-slate-200 bg-white px-3 py-1 text-slate-600 hover:border-sky-300 hover:text-sky-700 transition-colors"
              >
                {q}
              </button>
            ))}
        </div>
      </section>

      {/* Status Pills (Legacy - for larger status display) */}
        {runStatus === "running" && (
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-6">
          <h2 className="text-lg font-semibold mb-4 text-slate-900">Panel Status</h2>
            <div className="flex flex-wrap gap-3">
              {selectedModels.map((modelId) => {
                const status = modelStatuses[modelId] || "queued";
                return (
                  <StatusPill
                    key={modelId}
                    status={status}
                    modelName={getModelDisplayName(modelId)}
                  />
                );
              })}
            </div>
          </div>
        )}

        {/* Results - Wrapped in Suspense to defer heavy rendering */}
        {/* Panel Responses area is intentionally sized to feel like a "full research reading pane"
            similar to ChatGPT's answer area (~750-900px width) for comfortable document-style reading.
            This makes deep research answers easier to scan and digest. */}
        {runStatus === "complete" && results.length > 0 && (
          <Suspense
            fallback={
              <div className="mx-auto mt-8 w-full max-w-[900px] bg-white rounded-2xl shadow-sm border border-slate-200 p-8">
                <div className="animate-pulse space-y-4">
                  <div className="h-8 bg-slate-200 rounded w-1/3" />
                  <div className="h-32 bg-slate-200 rounded" />
                  <div className="h-24 bg-slate-200 rounded" />
                </div>
              </div>
            }
          >
            <div className="mx-auto mt-8 w-full max-w-[900px] bg-white rounded-2xl shadow-sm border border-slate-200 p-8">
              <ResultsDisplay
                results={results}
                synthesizedReport={synthesizedReport}
                onRerun={handleRerun}
                onAddModel={handleAddModel}
                question={question}
                synthesisStatus={synthesisStatus}
                synthesisReport={synthesisReport}
                synthesisError={synthesisError}
                runId={currentRunId}
              />
            </div>
          </Suspense>
        )}

      {/* Note: Error display is shown inline within the main card above
          We removed the duplicate large error state section to avoid showing errors twice */}

      {/* Floating up/down arrows let users quickly jump to the top or bottom
          of long results instead of manually scrolling. */}
      {showScrollNav && runStatus === "complete" && results.length > 0 && (
          <div className="fixed bottom-6 right-6 flex flex-col gap-2 z-50">
            <button
              type="button"
              onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
              className="rounded-full bg-slate-800/90 p-2 text-white shadow-lg hover:bg-slate-900 transition-colors"
              aria-label="Scroll to top"
            >
              <svg
                className="h-5 w-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M5 15l7-7 7 7"
                />
              </svg>
            </button>
            <button
              type="button"
              onClick={() =>
                window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" })
              }
              className="rounded-full bg-slate-800/90 p-2 text-white shadow-lg hover:bg-slate-900 transition-colors"
              aria-label="Scroll to bottom"
            >
              <svg
                className="h-5 w-5"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
                xmlns="http://www.w3.org/2000/svg"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M19 9l-7 7-7-7"
                />
              </svg>
            </button>
          </div>
        )}
    </main>
  );
}

