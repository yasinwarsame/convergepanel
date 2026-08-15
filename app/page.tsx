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

import { useState, useEffect, Suspense, lazy, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import Image from "next/image";
import dynamic from "next/dynamic";
import { BookOpen, Film } from "lucide-react";
import { useAuth } from "@/components/AuthProvider";
import { ModelId, ModelResult, ModelStatus, SynthesizedReport, RunPanelApiResponse, ConnectorStatus } from "@/lib/types";
import { coerceStatus } from "@/lib/panel/normalize";
import { isUsableResult } from "@/lib/panel/publicize";
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
import { getPlanConfigById } from "@/lib/billing/planConfig";
import { normalizeSelectedModels, getDefaultModelSelection } from "@/lib/utils/normalizeSelectedModels";
import { perf, trackSlowLoad } from "@/lib/utils/performance";
import ClaimVerificationResult from "@/components/ClaimVerificationResult";
import VideoUploader from "@/components/VideoUploader";
import VideoVerificationResult from "@/components/VideoVerificationResult";
import FileAttachButton from "@/components/FileAttachButton";
import type { ClaimVerificationClientPayload } from "@/lib/verification/claimVerificationClientPayload";
import type { VideoVerificationClientPayload } from "@/lib/verification/videoVerificationClientPayload";
import type { PanelHistoryGovernanceStatus, PanelHistoryItem } from "@/lib/user/panelHistory";
import { GovernanceChip } from "@/components/shared/GovernanceChip";
import type { TeamGovernanceBannerProps, AdaptivePanelPayload } from "@/components/ResultsDisplay";
import type { PersistedAdaptiveOutput, PersistedLegacyAdaptiveOutputV1 } from "@/lib/adaptiveSchema/persistedOutput";
import type { ReportStatusInput } from "@/lib/adaptiveSchema/reportStatus";
import { adaptPersistedOutputToPanelPayload, adaptPersistedLegacyOutputToPanelPayload } from "@/lib/user/adaptivePersistedOutputAdapter";
import type { SynthesisConsensusSummaryDetail } from "@/lib/verification/consensusScoring";

// Lazy load heavy components - defer until after first paint
const ResultsDisplay = dynamic(() => import("@/components/ResultsDisplay"), {
  loading: () => (
    <div className="bg-cp-surface rounded-2xl shadow-sm border border-cp-border p-8">
      <div className="animate-pulse space-y-4">
        <div className="h-8 bg-cp-border rounded w-1/3" />
        <div className="h-32 bg-cp-border rounded" />
        <div className="h-24 bg-cp-border rounded" />
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

const HISTORY_STORAGE_KEY = "convergePanelHistoryV1";
const MAX_CLAIM_CHARS = 2000;
const HISTORY_PAGE_SIZE = 30;
const MAX_HISTORY_LOCAL_STORAGE = 50;

function panelHistoryStorageKey(uid: string) {
  return `${HISTORY_STORAGE_KEY}:${uid}`;
}

function truncateHistoryTitle(text: string, max = 88): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

function formatHistoryVerdictLabel(v: string): string {
  const x = v.toLowerCase();
  if (x === "partially_true") return "Partially true";
  if (x === "confirmed") return "Confirmed";
  if (x === "disputed") return "Disputed";
  if (x === "unverifiable") return "Unverifiable";
  if (x === "likely_manipulated") return "Likely manipulated";
  if (x === "authentic_captured") return "Camera footage";
  if (x === "authentic_produced") return "Produced content";
  if (x === "authentic") return "Authentic";
  if (x === "inconclusive") return "Inconclusive";
  if (x === "insufficient") return "Insufficient";
  return v ? v.charAt(0).toUpperCase() + v.slice(1) : "—";
}

const HISTORY_VIDEO_VERDICT_BADGE: Record<string, { label: string; className: string }> = {
  authentic_captured: { label: "Camera Footage", className: "bg-green-100 text-green-800" },
  authentic_produced: { label: "Produced Content", className: "bg-blue-100 text-blue-800" },
  likely_manipulated: { label: "Manipulated", className: "bg-red-100 text-red-800" },
  inconclusive: { label: "Inconclusive", className: "bg-amber-100 text-amber-800" },
  insufficient: { label: "Insufficient", className: "bg-gray-100 text-gray-800" },
  authentic: { label: "Authentic", className: "bg-green-100 text-green-800" },
};

function historyVideoVerdictBadge(verdict: string | undefined): { label: string; className: string } | null {
  if (verdict == null || verdict === "") return null;
  const k = verdict.toLowerCase().replace(/\s+/g, "_");
  return HISTORY_VIDEO_VERDICT_BADGE[k] ?? null;
}

function formatHistoryVideoDuration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

function panelApiItemToHistoryItem(row: PanelHistoryItem): HistoryItem {
  if (row.type === "research") {
    const q = row.question.trim();
    return {
      id: row.id,
      type: "research",
      title: truncateHistoryTitle(q),
      at: row.at,
      question: q,
      selectedModels: row.selectedModels,
      researchStatus: row.status,
      modelsOk: row.modelsOk,
      modelsTotal: row.modelsTotal,
      synthesisConsensusScore: row.synthesisConsensusScore,
      governanceStatus: row.governanceStatus,
    };
  }
  if (row.type === "video_verification") {
    const fn = row.fileName.trim() || "Uploaded video";
    const line = `Video: ${fn} (${formatHistoryVideoDuration(row.durationSeconds)})`;
    return {
      id: row.id,
      type: "video_verification",
      title: truncateHistoryTitle(line),
      at: row.at,
      fileName: row.fileName,
      durationSeconds: row.durationSeconds,
      verdict: row.verdict,
      consensusScore: row.consensusScore,
      governanceStatus: row.governanceStatus,
    };
  }
  const c = row.claim.trim();
  return {
    id: row.id,
    type: "verification",
    title: truncateHistoryTitle(c),
    at: row.at,
    claim: c,
    verdict: row.verdict,
    consensusScore: row.consensusScore,
    governanceStatus: row.governanceStatus,
  };
}

function sortHistoryDesc(items: HistoryItem[]): HistoryItem[] {
  return [...items].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}

function mergeHistoryById(existing: HistoryItem[], incoming: HistoryItem[]): HistoryItem[] {
  const map = new Map<string, HistoryItem>();
  for (const it of existing) {
    map.set(it.id, it);
  }
  for (const it of incoming) {
    const prev = map.get(it.id);
    if (!prev) {
      map.set(it.id, it);
      continue;
    }
    if (it.type === "verification" && prev.type === "verification") {
      const payload = it.payload ?? prev.payload;
      map.set(it.id, {
        ...prev,
        ...it,
        payload: payload ?? undefined,
        governanceStatus: it.governanceStatus ?? prev.governanceStatus,
      });
    } else if (it.type === "research" && prev.type === "research") {
      const pick = new Date(it.at) >= new Date(prev.at) ? it : prev;
      const other = new Date(it.at) >= new Date(prev.at) ? prev : it;
      map.set(it.id, {
        ...pick,
        synthesisConsensusScore: pick.synthesisConsensusScore ?? other.synthesisConsensusScore,
        governanceStatus: pick.governanceStatus ?? other.governanceStatus,
      });
    } else if (it.type === "video_verification" && prev.type === "video_verification") {
      map.set(it.id, {
        ...prev,
        ...it,
        governanceStatus: it.governanceStatus ?? prev.governanceStatus,
      });
    } else {
      map.set(it.id, new Date(it.at) >= new Date(prev.at) ? it : prev);
    }
  }
  return sortHistoryDesc(Array.from(map.values()));
}

type HistoryItem =
  | {
      id: string;
      type: "research";
      title: string;
      at: string;
      question: string;
      selectedModels: ModelId[];
      researchStatus?: string;
      modelsOk?: number;
      modelsTotal?: number;
      synthesisConsensusScore?: number;
      governanceStatus?: PanelHistoryGovernanceStatus;
    }
  | {
      id: string;
      type: "verification";
      title: string;
      at: string;
      claim?: string;
      verdict?: string;
      consensusScore?: number;
      payload?: ClaimVerificationClientPayload | null;
      governanceStatus?: PanelHistoryGovernanceStatus;
    }
  | {
      id: string;
      type: "video_verification";
      title: string;
      at: string;
      fileName?: string;
      durationSeconds?: number;
      verdict?: string;
      consensusScore?: number;
      governanceStatus?: PanelHistoryGovernanceStatus;
    };

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
  const openHistoryItemRef = useRef<((item: HistoryItem) => Promise<void>) | null>(null);
  const governanceDeepLinkHandled = useRef<string | null>(null);
  const { user, loading: authLoading, authReady } = useAuth();
  
  // Track auth resolution
  useEffect(() => {
    if (!authLoading) {
      perf.mark('auth_resolved');
      perf.measure('time_to_auth', 'app_start', 'auth_resolved');
    }
  }, [authLoading]);

  // useUserPlan hook - handles its own loading/error states internally
  const {
    plan,
    runsThisMonth,
    monthlyLimit,
    videoLimit,
    videoRunsThisMonth,
    refresh: refreshUsage,
    loading: planLoading,
    error: planError,
  } = useUserPlan();

  // Resolve plan id and config (single source of truth in planConfig)
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

  // Attached file names for the Research and Verify tabs (display only — text already injected)
  const [researchAttachedFile, setResearchAttachedFile] = useState<string | null>(null);
  const [claimAttachedFile, setClaimAttachedFile] = useState<string | null>(null);

  /** Single nav: Research | Verify Claim | Verify Video | History */
  const [panelTab, setPanelTab] = useState<"research" | "verify" | "video" | "history">("research");
  const [claimInput, setClaimInput] = useState("");
  const [verifyRunning, setVerifyRunning] = useState(false);
  const [verificationPayload, setVerificationPayload] = useState<ClaimVerificationClientPayload | null>(
    null
  );
  const [videoVerificationPayload, setVideoVerificationPayload] = useState<VideoVerificationClientPayload | null>(
    null
  );
  const [historyItems, setHistoryItems] = useState<HistoryItem[]>([]);
  const [historyHydrated, setHistoryHydrated] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyHasMore, setHistoryHasMore] = useState(false);
  const [historyPage, setHistoryPage] = useState(1);
  const [historyDetailLoadingId, setHistoryDetailLoadingId] = useState<string | null>(null);
  /** When set, Research tab shows saved run results instead of the composer (loaded from Firestore). */
  const [viewingHistoryRunId, setViewingHistoryRunId] = useState<string | null>(null);
  const historyLoadSeq = useRef(0);

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
    Record<ModelId, "queued" | "thinking" | ModelStatus>
  >({} as Record<ModelId, "queued" | "thinking" | ModelStatus>);
  
  // Raw results from each model (after panel completes)
  const [results, setResults] = useState<ModelResult[]>([]);

  // Adaptive Result Schema System payload (flag-gated; null on legacy runs)
  const [adaptivePanel, setAdaptivePanel] = useState<AdaptivePanelPayload | null>(null);
  // Query-Routing Redesign, Phase 1 — non-destructive notice shown when a
  // reloaded run's persisted adaptive envelope is malformed or from an
  // unsupported version. Never shown for "absent" (the normal, expected
  // case for pre-Phase-1 runs and legacy-active schemas) — that's just the
  // existing legacy raw-model rendering path, unchanged.
  const [adaptiveRestoreNotice, setAdaptiveRestoreNotice] = useState<string | null>(null);

  // Synthesized consensus report (only generated if ≥2 models respond successfully)
  const [synthesizedReport, setSynthesizedReport] =
    useState<SynthesizedReport | null>(null);
  
  // Synthesis report state (for Synthesis tab)
  const [synthesisStatus, setSynthesisStatus] = useState<"idle" | "loading" | "complete" | "error">("idle");
  const [synthesisReport, setSynthesisReport] = useState<string | any | null>(null); // Can be string (legacy), SynthesisReportV2, or StructuredSynthesisReport
  const [synthesisError, setSynthesisError] = useState<string | null>(null);
  const [synthesisGeneratedForRunId, setSynthesisGeneratedForRunId] = useState<string | null>(null);
  const [synthesisGovernance, setSynthesisGovernance] = useState<TeamGovernanceBannerProps>(null);
  /** Org-wide governance evaluation chip (paid plans); from run API / history. */
  const [orgGovernanceStatus, setOrgGovernanceStatus] = useState<
    "approved" | "needs_review" | "blocked" | null
  >(null);
  const [synthesisConsensusSummary, setSynthesisConsensusSummary] =
    useState<SynthesisConsensusSummaryDetail | null>(null);
  
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

  const EXAMPLE_CLAIM =
    "GPT-4 has a 78% accuracy rate on medical diagnosis tasks according to a 2025 Stanford study.";

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

  // Per-user local history cache (avoids showing another account's items from shared browser storage).
  useEffect(() => {
    if (!user?.uid) {
      setHistoryItems([]);
      setHistoryHydrated(false);
      setHistoryPage(1);
      setHistoryHasMore(false);
      return;
    }
    try {
      const raw = localStorage.getItem(panelHistoryStorageKey(user.uid));
      if (raw) {
        const parsed = JSON.parse(raw) as HistoryItem[];
        if (Array.isArray(parsed)) setHistoryItems(parsed);
        else setHistoryItems([]);
      } else {
        setHistoryItems([]);
      }
    } catch {
      setHistoryItems([]);
    }
    setHistoryHydrated(true);
    setHistoryPage(1);
    setHistoryHasMore(false);
  }, [user?.uid]);

  useEffect(() => {
    if (!historyHydrated || !user?.uid) return;
    try {
      localStorage.setItem(
        panelHistoryStorageKey(user.uid),
        JSON.stringify(historyItems.slice(0, MAX_HISTORY_LOCAL_STORAGE))
      );
    } catch {
      /* ignore */
    }
  }, [historyItems, historyHydrated, user?.uid]);

  const loadHistoryPage = useCallback(
    async (pageNum: number) => {
      if (!user || !authReady) return;
      const seq = ++historyLoadSeq.current;
      setHistoryLoading(true);
      setHistoryError(null);
      try {
        const { authedFetch } = await import("@/lib/client/authedFetch");
        const res = await authedFetch(
          `/api/user/panel-history?page=${pageNum}&limit=${HISTORY_PAGE_SIZE}`,
          { user, authReady, method: "GET" }
        );
        const data = (await res.json()) as {
          ok?: boolean;
          items?: PanelHistoryItem[];
          hasMore?: boolean;
          message?: string;
        };
        if (seq !== historyLoadSeq.current) return;
        if (!data.ok) {
          setHistoryError(typeof data.message === "string" ? data.message : "Could not load history");
          setHistoryHasMore(false);
          return;
        }
        const converted = (data.items ?? []).map(panelApiItemToHistoryItem);
        setHistoryItems((prev) => mergeHistoryById(prev, converted));
        setHistoryPage(pageNum);
        setHistoryHasMore(Boolean(data.hasMore));
      } catch (e: unknown) {
        if (seq !== historyLoadSeq.current) return;
        const err = e as { name?: string; message?: string };
        if (err?.name === "NotSignedInError") return;
        setHistoryError(err?.message || "Could not load history");
        setHistoryHasMore(false);
      } finally {
        if (seq === historyLoadSeq.current) setHistoryLoading(false);
      }
    },
    [user, authReady]
  );

  useEffect(() => {
    if (panelTab !== "history" || !historyHydrated || !user || !authReady) return;
    void loadHistoryPage(1);
  }, [panelTab, historyHydrated, user, authReady, loadHistoryPage]);

  // Floating scroll navigation: show up/down arrows when user has scrolled down
  useEffect(() => {
    // Only show scroll nav when results are present and user has scrolled
    if (
      (panelTab === "research" && runStatus === "complete" && results.length > 0) ||
      (panelTab === "verify" && verificationPayload) ||
      (panelTab === "video" && videoVerificationPayload)
    ) {
      const onScroll = () => {
        setShowScrollNav(window.scrollY > 400);
      };
      window.addEventListener("scroll", onScroll);
      return () => window.removeEventListener("scroll", onScroll);
    } else {
      setShowScrollNav(false);
    }
  }, [panelTab, runStatus, results.length, verificationPayload, videoVerificationPayload]);

  const exitHistoryResearchView = useCallback(() => {
    setViewingHistoryRunId(null);
    setResults([]);
    setSynthesizedReport(null);
    setRunStatus("idle");
    setCurrentRunId(null);
    setSynthesisStatus("idle");
    setSynthesisReport(null);
    setSynthesisError(null);
    setSynthesisConsensusSummary(null);
    setSynthesisGeneratedForRunId(null);
    setSynthesisGovernance(null);
    setOrgGovernanceStatus(null);
    setModelStatuses({} as Record<ModelId, "queued" | "thinking" | ModelStatus>);
    setQuestion("");
  }, []);

  useEffect(() => {
    if (panelTab !== "research" && viewingHistoryRunId) {
      exitHistoryResearchView();
    }
  }, [panelTab, viewingHistoryRunId, exitHistoryResearchView]);

  useEffect(() => {
    if (onboardingError && user) {
      console.warn("[app/page.tsx] Onboarding check failed but allowing access:", onboardingError);
    }
  }, [onboardingError, user]);

  useEffect(() => {
    if (planError && user) {
      console.warn("[app/page.tsx] Plan loading failed but allowing access:", planError);
    }
  }, [planError, user]);

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
    setVerificationPayload(null);
    setViewingHistoryRunId(null);
    setError(null);
    setRunStatus("running");
    setResults([]);
    setAdaptivePanel(null);
    setAdaptiveRestoreNotice(null);
    setSynthesizedReport(null);
    setResearchAttachedFile(null);
    // Reset synthesis state for new run
    setSynthesisStatus("idle");
    setSynthesisReport(null);
    setSynthesisError(null);
    setSynthesisGeneratedForRunId(null);
    setSynthesisGovernance(null);
    setOrgGovernanceStatus(null);
    setSynthesisConsensusSummary(null);
    setCurrentRunId(null);

    // Initialize all selected models with "queued" status
    // This shows in the UI immediately when panel starts
    const initialStatuses = {} as Record<
      ModelId,
      "queued" | "thinking" | ModelStatus
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
        setModelStatuses({} as Record<ModelId, "queued" | "thinking" | ModelStatus>);
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
        setModelStatuses({} as Record<ModelId, "queued" | "thinking" | ModelStatus>);
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
        setModelStatuses({} as Record<ModelId, "queued" | "thinking" | ModelStatus>);
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
        setModelStatuses({} as Record<ModelId, "queued" | "thinking" | ModelStatus>);
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
        setModelStatuses({} as Record<ModelId, "queued" | "thinking" | ModelStatus>);
        
        // Refresh usage data if we hit a limit
        if (normalizedErrorCode === "RUN_LIMIT_REACHED" || data.errorCode === "PLAN_MODEL_LIMIT_REACHED") {
          refreshUsage();
          if (normalizedErrorCode === "RUN_LIMIT_REACHED") {
            trackEvent("run_limit_reached", { plan: plan || "unknown", tab: panelTab });
          }
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

      const gs = data.governanceStatus;
      if (gs === "approved" || gs === "needs_review" || gs === "blocked") {
        setOrgGovernanceStatus(gs);
      } else {
        setOrgGovernanceStatus(null);
      }
      
      setResults(data.results);
      setAdaptivePanel((data as any).adaptive ?? null);

      // Update final statuses for each model
      // Status can be: ok, error, timeout, or refused
      // Add defensive error handling to prevent crashes from malformed results
      const finalStatuses = {} as Record<
        ModelId,
        "queued" | "thinking" | ModelStatus
      >;
      try {
      data.results.forEach((result: ModelResult) => {
          if (result && result.modelId && result.status) {
        finalStatuses[result.modelId] = coerceStatus(result.status);
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

      if (successfulCount >= 2 && !(data as any).adaptive) {
        // Run consensus engine to analyze responses
        // This extracts claims, clusters them, and identifies agreements/disagreements
        // Add defensive error handling so synthesis failures don't crash the UI
        // Skipped entirely for adaptive runs — AdaptiveResultsView is the sole
        // comparison surface there, and this engine expects the fixed markdown
        // template, not typed JSON.
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

      setHistoryItems((h) =>
        [
          {
            id: data.runId || `r-${Date.now()}`,
            type: "research" as const,
            title:
              question.trim().slice(0, 88) + (question.trim().length > 88 ? "…" : ""),
            at: new Date().toISOString(),
            question: question.trim(),
            selectedModels: [...selectedModels],
            governanceStatus:
              gs === "approved" || gs === "needs_review" || gs === "blocked" ? gs : undefined,
          },
          ...h,
        ].slice(0, MAX_HISTORY_LOCAL_STORAGE)
      );

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
      // Query-Routing Redesign, Phase 2A, Step 6 — mirrors the SAME
      // !(data as any).adaptive guard the client-side synthesizeReport()
      // call above already uses (it was previously missing here, letting
      // a Milestone-2 run's structured JSON output reach legacy
      // claims-matrix synthesis; see docs/governance-decision-receipts-design.md
      // §14.4/§16). The server (/api/synthesize-panel) now also rejects
      // this defensively, independent of this client guard.
      if (data.runId && successfulCount >= 2 && !(data as any).adaptive) {
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
      setModelStatuses({} as Record<ModelId, "queued" | "thinking" | ModelStatus>);
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
            setSynthesisConsensusSummary(cacheData.consensusSummary ?? null);
            setSynthesisError(null);
            setSynthesisGovernance(
              cacheData.governanceReviewRequired ||
                cacheData.blockedByPolicy ||
                (Array.isArray(cacheData.policyFlags) && cacheData.policyFlags.length > 0)
                ? {
                    governanceReviewRequired: !!cacheData.governanceReviewRequired,
                    blockedByPolicy: !!cacheData.blockedByPolicy,
                    policyBlockMessage: cacheData.policyBlockMessage,
                    policyFlags: cacheData.policyFlags,
                  }
                : null
            );
            return; // Success - exit early
          }
        }
      } catch (cacheError: any) {
        // Cache check failed - continue to generation (non-fatal)
        console.log("[auto-synthesis] Cache check failed, proceeding with generation:", cacheError?.message);
      }

      // Cache miss - generate synthesis (POST request)
      const okResults = panelResults.filter(
        (r) => isUsableResult(r) && ((r as any).rawTextFull?.trim()?.length > 0 || (r as any).rawText?.trim()?.length > 0 || (r as any).text?.trim()?.length > 0)
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
        setSynthesisConsensusSummary(data.consensusSummary ?? null);
        setSynthesisError(null);
        setSynthesisGovernance(
          data.governanceReviewRequired ||
            data.blockedByPolicy ||
            (Array.isArray(data.policyFlags) && data.policyFlags.length > 0)
            ? {
                governanceReviewRequired: !!data.governanceReviewRequired,
                blockedByPolicy: !!data.blockedByPolicy,
                policyBlockMessage: data.policyBlockMessage,
                policyFlags: data.policyFlags,
              }
            : null
        );
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
   * Verify claim across selected models (uses /api/verify-claim)
   */
  const handleVerifyClaim = async () => {
    setViewingHistoryRunId(null);
    if (!authReady || !user) {
      setError("Please sign in to verify a claim");
      return;
    }
    if (selectedModels.length < 2) {
      setError("Please select at least 2 models");
      return;
    }
    const claim = claimInput.trim();
    if (!claim) {
      setError("Please paste a claim to verify");
      return;
    }
    if (claim.length > MAX_CLAIM_CHARS) {
      setError(`Claim must be at most ${MAX_CLAIM_CHARS} characters`);
      return;
    }

    setError(null);
    setVerifyRunning(true);
    setVerificationPayload(null);
    setRunStatus("idle");
    setResults([]);
    setSynthesizedReport(null);
    setClaimAttachedFile(null);

    const initialStatuses = {} as Record<ModelId, "queued" | "thinking" | ModelStatus>;
    selectedModels.forEach((id) => {
      initialStatuses[id] = "queued";
    });
    setModelStatuses(initialStatuses);

    setTimeout(() => {
      setModelStatuses((prev) => {
        const updated = { ...prev };
        selectedModels.forEach((id) => {
          if (updated[id] === "queued") updated[id] = "thinking";
        });
        return updated;
      });
    }, 100);

    try {
      const { authedFetch } = await import("@/lib/client/authedFetch");
      let response = await authedFetch("/api/verify-claim", {
        user,
        authReady,
        method: "POST",
        body: JSON.stringify({ claim, models: selectedModels }),
      });
      if (response.status === 401 && user) {
        response = await authedFetch("/api/verify-claim", {
          user,
          authReady,
          forceTokenRefresh: true,
          method: "POST",
          body: JSON.stringify({ claim, models: selectedModels }),
        });
      }

      const responseText = await response.text();
      const contentType = response.headers.get("content-type");
      if (!contentType || !contentType.includes("application/json")) {
        setError(`Server error (${response.status}). Please try again.`);
        setVerifyRunning(false);
        setModelStatuses({} as Record<ModelId, "queued" | "thinking" | ModelStatus>);
        return;
      }

      let data: any;
      try {
        data = JSON.parse(responseText);
      } catch {
        setError("Invalid response from server.");
        setVerifyRunning(false);
        setModelStatuses({} as Record<ModelId, "queued" | "thinking" | ModelStatus>);
        return;
      }

      if (!data.ok) {
        const errorCode = data.errorCode || data.error;
        let errorMessage = data.message || "Could not complete your claim.";
        if (errorCode === "RUN_LIMIT_REACHED") {
          const runsUsed = data.runsUsed ?? 0;
          const runsLimit = data.runsLimit ?? data.maxRunsPerMonth ?? 0;
          errorMessage = `You've reached your monthly run limit (${runsUsed} / ${runsLimit}). Resets ${data.resetsAt ? new Date(data.resetsAt).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : "next month"}.`;
        }
        if (errorCode === "PLAN_MODEL_LIMIT_REACHED") {
          errorMessage = data.message || errorMessage;
        }
        setErrorCode(errorCode === "RUN_LIMIT_REACHED" ? "RUN_LIMIT_REACHED" : errorCode || null);
        setError(errorMessage);
        if (errorCode === "RUN_LIMIT_REACHED") {
          refreshUsage();
          trackEvent("run_limit_reached", { plan: plan || "unknown", tab: panelTab });
        }
        setVerifyRunning(false);
        setModelStatuses({} as Record<ModelId, "queued" | "thinking" | ModelStatus>);
        return;
      }

      const payload: ClaimVerificationClientPayload = {
        verificationId: data.verificationId,
        claim: data.claim || claim,
        verdict: data.verdict,
        consensusScore: data.consensusScore,
        confidenceLabel: data.confidenceLabel,
        evidenceQuality: data.evidenceQuality,
        supportRatio: data.supportRatio,
        modelEvidence: data.modelEvidence,
        aggregateSummary: data.aggregateSummary,
        whereModelsAgree: data.whereModelsAgree || [],
        whereModelsDisagree: data.whereModelsDisagree || [],
        auditBundle: data.auditBundle,
        accurateAmongUsable: data.accurateAmongUsable,
        usableModelCount: data.usableModelCount,
        governanceReviewRequired: data.governanceReviewRequired,
        blockedByPolicy: data.blockedByPolicy,
        policyBlockMessage: data.policyBlockMessage,
        policyFlags: data.policyFlags,
        governanceStatus:
          data.governanceStatus === "approved" ||
          data.governanceStatus === "needs_review" ||
          data.governanceStatus === "blocked"
            ? data.governanceStatus
            : undefined,
      };

      setErrorCode(null);
      setVerificationPayload(payload);
      setHistoryItems((h) => {
        const itemId = data.verificationId || `v-${Date.now()}`;
        const newItem: HistoryItem = {
          id: itemId,
          type: "verification" as const,
          title: claim.slice(0, 88) + (claim.length > 88 ? "…" : ""),
          at: new Date().toISOString(),
          claim: claim.trim(),
          verdict: data.verdict,
          consensusScore: data.consensusScore,
          payload,
          governanceStatus: payload.governanceStatus,
        };
        const deduped = h.filter((x) => x.id !== itemId);
        return [newItem, ...deduped].slice(0, MAX_HISTORY_LOCAL_STORAGE);
      });

      const finalStatuses = {} as Record<ModelId, "queued" | "thinking" | ModelStatus>;
      data.modelEvidence?.forEach((row: { modelId: ModelId; status?: string }) => {
        if (row?.modelId) {
          finalStatuses[row.modelId] =
            row.status === "failed" || row.status === "parse_error" ? "failed" : "ok";
        }
      });
      setModelStatuses(finalStatuses);
      await refreshUsage();
      trackEvent("claim_verification", { models: selectedModels, plan: plan || "unknown" });
    } catch (e: any) {
      console.error("[verify-claim]", e);
      setError("Network error. Please try again.");
      setModelStatuses({} as Record<ModelId, "queued" | "thinking" | ModelStatus>);
    } finally {
      setVerifyRunning(false);
    }
  };

  const openHistoryItem = async (item: HistoryItem) => {
    if (item.type === "research") {
      setPanelTab("research");
      setVerificationPayload(null);
      setVideoVerificationPayload(null);
      setError(null);
      setViewingHistoryRunId(null);
      setHistoryDetailLoadingId(item.id);
      if (!authReady || !user) {
        setHistoryDetailLoadingId(null);
        setError("Sign in to load saved research results from your account.");
        setQuestion(item.question);
        setSelectedModels(item.selectedModels);
        return;
      }
      try {
        const { authedFetch } = await import("@/lib/client/authedFetch");
        const res = await authedFetch(`/api/user/runs/${encodeURIComponent(item.id)}`, {
          user,
          authReady,
          method: "GET",
        });
        const data = (await res.json()) as {
          ok?: boolean;
          message?: string;
          runId?: string;
          question?: string;
          selectedModels?: ModelId[];
          results?: ModelResult[];
          synthesisCache?: {
            report?: unknown;
            consensusSummary?: SynthesisConsensusSummaryDetail | null;
            synthesizedBy?: string;
          } | null;
          governance?: TeamGovernanceBannerProps;
          governanceStatus?: "approved" | "needs_review" | "blocked" | null;
          adaptive?: {
            status: string;
            output: PersistedAdaptiveOutput | null;
            humanReview?: ReportStatusInput["humanReview"];
            reviewRouting?: ReportStatusInput["reviewRouting"];
          };
          /**
           * Phase 2 pilot history-reload fix — a SEPARATE signal from
           * `adaptive` above, for `procedural` runs only (see
           * persistedOutput.ts's PersistedLegacyAdaptiveOutputV1 doc).
           * `adaptive.status === "absent"` alone is NOT proof a run is
           * legacy/non-adaptive — it's also the (correct, by-design)
           * status for every procedural run, which never populates that
           * envelope. `legacyAdaptive` is the true signal for "was this a
           * schema-routed run whose structured result can be restored."
           */
          legacyAdaptive?: {
            status: string;
            output: PersistedLegacyAdaptiveOutputV1 | null;
          };
        };
        if (!res.ok || !data.ok || !data.results?.length) {
          throw new Error(typeof data.message === "string" ? data.message : "Could not load this run.");
        }
        setQuestion(data.question ?? item.question);

        // Query-Routing Redesign, Phase 1 / Phase 2 pilot history-reload fix
        // — restore the persisted adaptive envelope through the SAME
        // renderer routing a live run uses. Never reclassifies the old
        // question and never invokes the model panel. Two independent
        // envelopes are checked, in order: the Milestone-2 `adaptive`
        // envelope (9 dedicated schemas) first, then the procedural-only
        // `legacyAdaptive` envelope — never both, a run only ever
        // populates one or the other. Both "absent" (no envelope was ever
        // persisted for this run — true for every schema-routed run made
        // before this fix shipped, and for every non-procedural
        // legacy-active schema always) silently falls back to the
        // existing legacy rendering below, exactly as it already did
        // before Phase 1; only "malformed"/"unsupported_version" on
        // either envelope gets a non-destructive notice.
        if (data.adaptive?.status === "valid" && data.adaptive.output) {
          setAdaptivePanel(
            adaptPersistedOutputToPanelPayload(data.adaptive.output, {
              humanReview: data.adaptive.humanReview,
              reviewRouting: data.adaptive.reviewRouting,
            })
          );
          setAdaptiveRestoreNotice(null);
        } else if (data.legacyAdaptive?.status === "valid" && data.legacyAdaptive.output) {
          // procedural has no GovernanceRecordV1 (Milestone-2 only) — no
          // humanReview/reviewRouting to thread through, exactly matching
          // live rendering, where this schema never has either.
          setAdaptivePanel(adaptPersistedLegacyOutputToPanelPayload(data.legacyAdaptive.output));
          setAdaptiveRestoreNotice(null);
        } else {
          setAdaptivePanel(null);
          setAdaptiveRestoreNotice(
            data.adaptive?.status === "malformed" || data.legacyAdaptive?.status === "malformed"
              ? "This run's structured result couldn't be restored — showing the raw model responses instead."
              : data.adaptive?.status === "unsupported_version" || data.legacyAdaptive?.status === "unsupported_version"
                ? "This run's structured result was saved by a newer version of ConvergePanel — showing the raw model responses instead."
                : null
          );
        }
        setSelectedModels(
          Array.isArray(data.selectedModels) && data.selectedModels.length > 0
            ? data.selectedModels
            : item.selectedModels
        );
        setResults(data.results as ModelResult[]);
        setCurrentRunId(data.runId ?? item.id);
        setRunStatus("complete");
        setViewingHistoryRunId(data.runId ?? item.id);

        const og = data.governanceStatus;
        setOrgGovernanceStatus(
          og === "approved" || og === "needs_review" || og === "blocked" ? og : null
        );

        const st = {} as Record<ModelId, "queued" | "thinking" | ModelStatus>;
        for (const r of data.results) {
          const id = r.modelId as ModelId;
          st[id] = isUsableResult(r) ? "ok" : "failed";
        }
        setModelStatuses(st);

        let consensusForSynthesis: SynthesizedReport | null = null;
        // Query-Routing Redesign, Phase 2A, Step 6 — this call site had no
        // adaptive guard at all (unlike the live-run synthesizeReport()
        // call, which already checks !(data as any).adaptive). The history
        // response shape is different here (`data.adaptive?.status`, not a
        // truthy/falsy adaptive payload object — `data.adaptive` is an
        // object even when status is "absent", so a naive `!data.adaptive`
        // check would incorrectly treat every history reload as adaptive).
        // Only a genuinely "absent" adaptiveOutput marker runs legacy
        // client-side synthesis; "valid"/"malformed"/"unsupported_version"
        // all skip it — a malformed/unsupported marker is not proof the
        // run is legacy (see docs/governance-decision-receipts-design.md §14.4/§16).
        //
        // Phase 2 pilot history-reload fix — this is the exact bug fix:
        // `data.adaptive?.status === "absent"` is ALSO true for every
        // procedural run (that envelope never applies to it — see
        // orchestrate.ts's attachAdaptiveEnvelope), so the check above
        // alone previously misrouted every procedural history reload into
        // this prose-oriented synthesizer, which has no notion of the
        // structured JSON procedural models emit — the literal cause of
        // the JSON-leak bug this fix addresses. `legacyAdaptive` is the
        // true "was this a schema-routed run" signal for that family;
        // only run legacy synthesis when BOTH envelopes are genuinely
        // absent (this run predates BOTH persistence paths, or is a
        // non-procedural legacy-active schema that was never routed
        // through either — both correctly fall through here unchanged).
        const legacyAdaptiveAbsent = !data.legacyAdaptive || data.legacyAdaptive.status === "absent";
        if ((data.adaptive?.status === "absent" || !data.adaptive) && legacyAdaptiveAbsent) {
          try {
            consensusForSynthesis = synthesizeReport(data.results as ModelResult[]);
            setSynthesizedReport(consensusForSynthesis);
          } catch {
            consensusForSynthesis = null;
            setSynthesizedReport(null);
          }
        } else {
          setSynthesizedReport(null);
        }

        if (data.synthesisCache?.report) {
          setSynthesisStatus("complete");
          setSynthesisReport(data.synthesisCache.report);
          setSynthesisConsensusSummary(data.synthesisCache.consensusSummary ?? null);
          setSynthesisError(null);
          setSynthesisGeneratedForRunId(data.runId ?? item.id);
          const g = data.governance;
          setSynthesisGovernance(
            g &&
              (g.governanceReviewRequired ||
                g.blockedByPolicy ||
                (Array.isArray(g.policyFlags) && g.policyFlags.length > 0))
              ? {
                  governanceReviewRequired: !!g.governanceReviewRequired,
                  blockedByPolicy: !!g.blockedByPolicy,
                  policyBlockMessage: g.policyBlockMessage,
                  policyFlags: g.policyFlags,
                }
              : null
          );
        } else {
          setSynthesisStatus("idle");
          setSynthesisReport(null);
          setSynthesisError(null);
          setSynthesisConsensusSummary(null);
          setSynthesisGeneratedForRunId(null);
          setSynthesisGovernance(null);
          // Query-Routing Redesign, Phase 2A, Step 6 — same guard as the
          // synthesizeReport() call above: only a genuinely "absent"
          // adaptiveOutput marker triggers legacy auto-synthesis here.
          if (
            data.runId &&
            (data.results as ModelResult[]).filter((r) => isUsableResult(r)).length >= 2 &&
            (data.adaptive?.status === "absent" || !data.adaptive)
          ) {
            void generateSynthesisAutomatically(
              data.runId,
              data.question ?? item.question,
              data.results as ModelResult[],
              consensusForSynthesis
            );
          }
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Could not load this run.";
        setError(msg);
        setViewingHistoryRunId(null);
        setResults([]);
        setRunStatus("idle");
        setCurrentRunId(null);
        setSynthesizedReport(null);
        setSynthesisStatus("idle");
        setSynthesisReport(null);
        setSynthesisConsensusSummary(null);
        setSynthesisGeneratedForRunId(null);
        setOrgGovernanceStatus(null);
        setQuestion(item.question);
        setSelectedModels(item.selectedModels);
      } finally {
        setHistoryDetailLoadingId(null);
      }
      return;
    }
    if (item.type === "video_verification") {
      setPanelTab("video");
      setVerificationPayload(null);
      setViewingHistoryRunId(null);
      setVideoVerificationPayload(null);
      setError(null);
      setErrorCode(null);
      if (!user || !authReady) {
        setHistoryDetailLoadingId(null);
        return;
      }
      setHistoryDetailLoadingId(item.id);
      try {
        const { authedFetch } = await import("@/lib/client/authedFetch");
        const url = `/api/user/verifications/${encodeURIComponent(item.id)}?collection=videoVerifications`;
        const res = await authedFetch(url, { user, authReady, method: "GET" });
        const data = (await res.json()) as { ok?: boolean; payload?: VideoVerificationClientPayload };
        if (data.ok && data.payload) {
          setVideoVerificationPayload(data.payload);
          setHistoryItems((prev) =>
            prev.map((h) =>
              h.id === item.id && h.type === "video_verification"
                ? { ...h, governanceStatus: data.payload!.governanceStatus ?? h.governanceStatus }
                : h
            )
          );
        } else {
          setVideoVerificationPayload(null);
          setError("Could not load this video verification.");
        }
      } catch {
        setVideoVerificationPayload(null);
        setError("Could not load this video verification.");
      } finally {
        setHistoryDetailLoadingId(null);
      }
      return;
    }
    setPanelTab("verify");
    setVideoVerificationPayload(null);
    setViewingHistoryRunId(null);
    if (item.payload) {
      setVerificationPayload({
        ...item.payload,
        verificationId: item.payload.verificationId ?? item.id,
      });
      setClaimInput(item.payload.claim);
      return;
    }
    const fallbackClaim = item.claim ?? item.title;
    setClaimInput(fallbackClaim);
    if (!user || !authReady) {
      setVerificationPayload(null);
      return;
    }
    setHistoryDetailLoadingId(item.id);
    try {
      const { authedFetch } = await import("@/lib/client/authedFetch");
      const res = await authedFetch(`/api/user/verifications/${encodeURIComponent(item.id)}`, {
        user,
        authReady,
        method: "GET",
      });
      const data = (await res.json()) as { ok?: boolean; payload?: ClaimVerificationClientPayload };
      if (data.ok && data.payload) {
        setVerificationPayload(data.payload);
        setClaimInput(data.payload.claim);
        setHistoryItems((prev) =>
          prev.map((h) =>
            h.id === item.id && h.type === "verification"
              ? {
                  ...h,
                  payload: data.payload!,
                  governanceStatus: data.payload!.governanceStatus ?? h.governanceStatus,
                }
              : h
          )
        );
      } else {
        setVerificationPayload(null);
      }
    } catch {
      setVerificationPayload(null);
    } finally {
      setHistoryDetailLoadingId(null);
    }
  };

  openHistoryItemRef.current = openHistoryItem;

  useEffect(() => {
    if (!authReady || !user) return;
    const params = new URLSearchParams(window.location.search);
    const r = params.get("openResearchRun");
    const v = params.get("openVerification");
    const vid = params.get("openVideoVerification");
    if (!r && !v && !vid) {
      governanceDeepLinkHandled.current = null;
      return;
    }
    const token = r ? `r:${r}` : v ? `v:${v}` : `vid:${vid!}`;
    if (governanceDeepLinkHandled.current === token) return;
    governanceDeepLinkHandled.current = token;
    const handle = openHistoryItemRef.current;
    if (!handle) return;
    if (r) {
      void handle({
        type: "research",
        id: r,
        title: "",
        at: new Date().toISOString(),
        question: "",
        selectedModels: [] as ModelId[],
      });
    } else if (v) {
      void handle({
        type: "verification",
        id: v,
        title: "",
        at: new Date().toISOString(),
      });
    } else if (vid) {
      void handle({
        type: "video_verification",
        id: vid,
        title: "",
        at: new Date().toISOString(),
      });
    }
    router.replace("/", { scroll: false });
  }, [authReady, user, router]);

  // Handle ?tab=verify&claim=... or ?tab=research&q=... from /verify page (extension flow)
  useEffect(() => {
    if (!authReady || !user) return;
    const params = new URLSearchParams(window.location.search);
    const tab = params.get("tab");
    if (tab === "verify") {
      setPanelTab("verify");
      const claim = params.get("claim");
      if (claim) setClaimInput(decodeURIComponent(claim));
      router.replace("/", { scroll: false });
    } else if (tab === "research") {
      setPanelTab("research");
      const q = params.get("q");
      if (q) setQuestion(decodeURIComponent(q));
      router.replace("/", { scroll: false });
    }
  }, [authReady, user, router]);

  /**
   * Re-run the same panel with same question and models
   */
  const handleRerun = () => {
    handleRunPanel();
  };

  /**
   * Synthesis Report's Bias & Blind Spots Tier 2 "Run follow-up" action —
   * pre-fills the question box with a coverage-gap follow-up question and
   * scrolls it into view. Deliberately does NOT auto-submit: the user should
   * see and confirm the question before spending a panel run on it.
   */
  const handleRunFollowUp = (followUpQuestion: string) => {
    setQuestion(followUpQuestion);
    const el = document.getElementById("question");
    el?.scrollIntoView({ behavior: "smooth", block: "center" });
    if (el instanceof HTMLTextAreaElement) el.focus();
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
  const canRunResearch = !!user && selectedModels.length >= 2 && question.trim().length > 0;
  const canRunVerify =
    !!user &&
    selectedModels.length >= 2 &&
    claimInput.trim().length > 0 &&
    claimInput.trim().length <= MAX_CLAIM_CHARS;
  const canRun =
    panelTab === "research"
      ? canRunResearch
      : panelTab === "verify"
        ? canRunVerify
        : false;
  const panelBusy =
    panelTab === "research"
      ? runStatus === "running"
      : panelTab === "verify"
        ? verifyRunning
        : false;

  /** Low-runs hint near Run button only (not blocking; limit enforcement unchanged). */
  const effectiveMonthlyLimit =
    monthlyLimit != null && monthlyLimit !== undefined ? monthlyLimit : null;
  const effectiveRunsThisMonth = runsThisMonth ?? 0;
  const remainingRuns =
    effectiveMonthlyLimit != null
      ? Math.max(0, effectiveMonthlyLimit - effectiveRunsThisMonth)
      : 0;
  const LOW_REMAINING_THRESHOLD =
    effectiveMonthlyLimit != null && effectiveMonthlyLimit > 0
      ? Math.max(3, Math.floor(effectiveMonthlyLimit * 0.1))
      : 3;
  const showLowRunsRemaining =
    !!user &&
    effectiveMonthlyLimit != null &&
    remainingRuns > 0 &&
    remainingRuns <= LOW_REMAINING_THRESHOLD;

  /** Only after usage has loaded — avoids "Upgrade plan" flashing for paid users (stale free default). */
  const showHeaderUpgradePlan =
    !!user && !planLoading && normalizedPlan === "free";

  const showSavedResearchBanner =
    panelTab === "research" && (!!viewingHistoryRunId || !!historyDetailLoadingId);
  const showVerifyLoadingBanner =
    panelTab === "verify" && !!historyDetailLoadingId && !verificationPayload;
  const showVideoHistoryLoadingBanner =
    panelTab === "video" && !!historyDetailLoadingId && !videoVerificationPayload;
  const showMainComposer =
    (panelTab === "research" && !viewingHistoryRunId && !historyDetailLoadingId) ||
    (panelTab === "verify" && !verificationPayload && !historyDetailLoadingId);
  const showMainVideoComposer =
    panelTab === "video" && !videoVerificationPayload && !historyDetailLoadingId;

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

  if (!authLoading && !user) {
    return <LandingPage />;
  }

  if (onboardingCompleted === false && !checkingOnboarding) {
    return (
      <main className="max-w-4xl mx-auto px-4 py-10">
        <div className="bg-cp-surface rounded-2xl shadow-sm border border-cp-border px-6 py-8 text-center">
          <div className="h-6 w-6 animate-spin rounded-full border-2 border-cp-accent border-t-transparent mx-auto mb-4" />
          <p className="text-sm text-cp-muted">Redirecting to onboarding…</p>
        </div>
      </main>
    );
  }

  return (
    <main className="max-w-6xl mx-auto px-4 py-10">
      <section>
        {/* Header + tabs share the left column with the composer; Panel setup (right column) is
            aligned via items-start so its top matches the header and its bottom lands near the
            question box, not the full-height left column. Grid only applies for Research/Verify. */}
        <div className={showMainComposer ? "lg:grid lg:grid-cols-[1fr_336px] lg:items-start lg:gap-6" : undefined}>
        <div>
        {/* Header: title + meta tags (plan/usage lives on Profile & Billing) */}
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div className="flex-1 min-w-0">
            {/* Logo + Title */}
            <div className="flex items-center gap-3">
              <span className="relative flex h-11 w-11 shrink-0 items-center justify-center">
                <Image src="/logo-mark.png" alt="" width={44} height={44} className="h-11 w-11" priority />
              </span>
              <h1 className="text-3xl md:text-4xl font-semibold tracking-tight text-cp-text">
                Ask your expert panel
              </h1>
            </div>

            <p className="mt-3 max-w-2xl text-sm text-cp-muted md:text-base">
              Run a multi-LLM panel and get back one synthesized, source-checked brief — with
              consensus, disagreements, biases, and blind spots called out.
            </p>

            {/* Subtitle with improved styling */}
            <div className="mt-3 flex flex-wrap items-center gap-2 text-sm md:text-base">
              <span className="inline-flex items-center rounded-full bg-cp-primary-soft px-3 py-1 text-sm font-semibold text-cp-accent">
                Deep research
              </span>
              <span className="text-cp-faint">·</span>
              <span className="text-cp-muted">Multi-LLM expert panel</span>
              <span className="text-cp-faint">·</span>
              <span className="text-cp-muted">Trust-focused answers</span>
              {user && videoLimit > 0 && (
                <>
                  <span className="text-cp-faint">·</span>
                  <span className="text-cp-muted">
                    Video: {videoRunsThisMonth}/{videoLimit} this month
                  </span>
                </>
              )}
            </div>
          </div>
          {showHeaderUpgradePlan && (
            <div className="md:shrink-0 md:pt-1">
              <button
                type="button"
                onClick={() => router.push("/billing")}
                className="text-sm font-medium text-cp-accent hover:text-blue-700 hover:underline transition-colors"
              >
                Upgrade plan
              </button>
            </div>
          )}
        </div>

        {/* Divider between header and question area */}
        <div className="border-b border-cp-border-soft mt-6 mb-6"></div>

        <div
          className="mb-8 inline-flex flex-col gap-1 rounded-[11px] bg-[#ECEBE6] p-1 sm:flex-row"
          role="tablist"
          aria-label="Panel navigation"
        >
          <button
            type="button"
            role="tab"
            aria-selected={panelTab === "research"}
            onClick={() => setPanelTab("research")}
            className={`inline-flex items-center justify-center gap-2 rounded-[9px] px-4 py-2.5 text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent focus-visible:ring-offset-2 ${
              panelTab === "research"
                ? "bg-cp-surface text-cp-text shadow-sm"
                : "text-cp-muted hover:text-cp-text"
            }`}
          >
            <BookOpen
              className={`h-4 w-4 shrink-0 ${panelTab === "research" ? "text-cp-primary" : "text-cp-faint"}`}
              aria-hidden
            />
            Research
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={panelTab === "verify"}
            onClick={() => setPanelTab("verify")}
            className={`inline-flex items-center justify-center gap-2 rounded-[9px] px-4 py-2.5 text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent focus-visible:ring-offset-2 ${
              panelTab === "verify"
                ? "bg-cp-surface text-cp-text shadow-sm"
                : "text-cp-muted hover:text-cp-text"
            }`}
          >
            <svg
              className={`h-4 w-4 shrink-0 ${panelTab === "verify" ? "text-cp-primary" : "text-cp-faint"}`}
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden
            >
              <path
                d="M12 3l7 4v5c0 5-3.5 9-7 10-3.5-1-7-5-7-10V7l7-4z"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinejoin="round"
              />
              <path
                d="M9 12l2 2 4-4"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Verify Claim
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={panelTab === "video"}
            onClick={() => setPanelTab("video")}
            className={`inline-flex items-center justify-center gap-2 rounded-[9px] px-4 py-2.5 text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent focus-visible:ring-offset-2 ${
              panelTab === "video"
                ? "bg-cp-surface text-cp-text shadow-sm"
                : "text-cp-muted hover:text-cp-text"
            }`}
          >
            <Film
              className={`h-4 w-4 shrink-0 ${panelTab === "video" ? "text-cp-primary" : "text-cp-faint"}`}
              aria-hidden
            />
            Verify Video
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={panelTab === "history"}
            onClick={() => setPanelTab("history")}
            className={`inline-flex items-center justify-center gap-2 rounded-[9px] px-4 py-2.5 text-sm font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-cp-accent focus-visible:ring-offset-2 ${
              panelTab === "history"
                ? "bg-cp-surface text-cp-text shadow-sm"
                : "text-cp-muted hover:text-cp-text"
            }`}
          >
            <svg
              className={`h-4 w-4 shrink-0 ${panelTab === "history" ? "text-cp-primary" : "text-cp-faint"}`}
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden
            >
              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
              <path d="M12 7v5l3 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            History
          </button>
        </div>

        {panelTab === "history" ? (
          <div className="rounded-2xl border border-cp-border bg-cp-surface p-4 md:p-6">
            <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-lg font-semibold text-cp-text">Activity history</h2>
              {historyLoading && (
                <span className="inline-flex items-center gap-2 text-sm text-cp-faint">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-cp-accent border-t-transparent" />
                  Syncing…
                </span>
              )}
            </div>
            {historyError && (
              <p className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
                {historyError}
              </p>
            )}
            {historyItems.length === 0 && !historyLoading ? (
              <p className="text-sm text-cp-faint">
                No runs yet. Complete a research panel, claim verification, or video verification to see it here. When
                you&apos;re signed in, past runs from this account load automatically (up to {HISTORY_PAGE_SIZE} per
                page).
              </p>
            ) : historyItems.length === 0 && historyLoading ? (
              <p className="text-sm text-cp-faint">Loading your history…</p>
            ) : (
              <>
                <ul className="space-y-2">
                  {historyItems.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        disabled={historyDetailLoadingId === item.id}
                        onClick={() => void openHistoryItem(item)}
                        className="flex w-full items-start gap-3 rounded-xl border-2 border-cp-border bg-cp-raised px-3 py-3 text-left transition-colors hover:border-cp-accent hover:bg-cp-primary-soft disabled:cursor-wait disabled:opacity-70"
                      >
                        <span className="mt-0.5 shrink-0" aria-hidden>
                          {item.type === "video_verification" ? (
                            <Film className="h-5 w-5 text-indigo-500" aria-hidden />
                          ) : item.type === "verification" ? (
                            <span className="text-lg">🛡</span>
                          ) : (
                            <span className="text-lg">📖</span>
                          )}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-center gap-2">
                            <span
                              className={`rounded-md px-2 py-0.5 text-[10px] font-extrabold uppercase tracking-wider ${
                                item.type === "video_verification"
                                  ? "bg-indigo-100 text-indigo-800 ring-1 ring-indigo-300/70"
                                  : item.type === "verification"
                                    ? "bg-violet-200 text-violet-900 ring-1 ring-violet-400/60"
                                    : "bg-sky-200 text-sky-900 ring-1 ring-sky-400/60"
                              }`}
                            >
                              {item.type === "video_verification"
                                ? "VIDEO"
                                : item.type === "verification"
                                  ? "CLAIM"
                                  : "RESEARCH"}
                            </span>
                            <span className="text-xs font-medium text-cp-faint">
                              {new Date(item.at).toLocaleString()}
                            </span>
                          </span>
                          <span className="mt-1 block text-sm font-medium text-cp-text line-clamp-2">
                            {item.title}
                          </span>
                          <span className="mt-1 block text-xs text-cp-muted">
                            {item.type === "research" ? (
                              <>
                                {item.modelsOk != null && item.modelsTotal != null ? (
                                  <span>
                                    {item.modelsOk}/{item.modelsTotal} model responses
                                    {item.researchStatus && item.researchStatus !== "complete"
                                      ? ` · ${item.researchStatus}`
                                      : ""}
                                  </span>
                                ) : item.researchStatus === "error" ? (
                                  <span>Run ended with an error</span>
                                ) : (
                                  <span>Research panel</span>
                                )}
                                {item.synthesisConsensusScore != null && (
                                  <span> · Synthesis {item.synthesisConsensusScore}/100</span>
                                )}
                              </>
                            ) : item.type === "video_verification" ? (
                              <span className="inline-flex flex-wrap items-center gap-2">
                                {(() => {
                                  const vb = historyVideoVerdictBadge(item.verdict);
                                  if (vb) {
                                    return (
                                      <span
                                        className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${vb.className}`}
                                      >
                                        {vb.label}
                                      </span>
                                    );
                                  }
                                  if (item.verdict != null && item.verdict !== "") {
                                    return <span>{formatHistoryVerdictLabel(item.verdict)}</span>;
                                  }
                                  return <span>Video</span>;
                                })()}
                                {item.consensusScore != null && item.consensusScore !== undefined
                                  ? ` · ${item.consensusScore} consensus`
                                  : ""}
                                {item.fileName ? ` · ${item.fileName}` : ""}
                                {item.durationSeconds != null
                                  ? ` · ${formatHistoryVideoDuration(item.durationSeconds)}`
                                  : ""}
                              </span>
                            ) : (
                              <span>
                                {item.verdict != null && item.verdict !== ""
                                  ? `${formatHistoryVerdictLabel(item.verdict)}`
                                  : "Claim"}
                                {item.consensusScore != null && item.consensusScore !== undefined
                                  ? ` · ${item.consensusScore} consensus`
                                  : ""}
                              </span>
                            )}
                          </span>
                        </span>
                        <GovernanceChip status={item.governanceStatus} />
                      </button>
                    </li>
                  ))}
                </ul>
                {historyHasMore && (
                  <div className="mt-4 flex justify-center">
                    <button
                      type="button"
                      disabled={historyLoading}
                      onClick={() => void loadHistoryPage(historyPage + 1)}
                      className="rounded-xl border-2 border-cp-border bg-cp-surface px-5 py-2.5 text-sm font-semibold text-cp-muted shadow-sm transition-colors hover:border-cp-accent hover:bg-cp-primary-soft disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {historyLoading ? "Loading…" : "Load more"}
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        ) : (
          <>
        {(showSavedResearchBanner || showVerifyLoadingBanner || showVideoHistoryLoadingBanner) && (
          <div className="mb-6 rounded-2xl border-2 border-cp-accent/20 bg-cp-primary-soft px-4 py-4 shadow-sm">
            {showSavedResearchBanner && historyDetailLoadingId && (
              <div className="flex items-center gap-2 text-sm text-cp-muted">
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-cp-accent border-t-transparent" />
                Loading saved research run…
              </div>
            )}
            {showSavedResearchBanner && viewingHistoryRunId && !historyDetailLoadingId && (
              <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-sm text-cp-muted">
                  <span className="font-semibold text-cp-text">Saved run</span> — panel responses and synthesis
                  below match what you saw when this run finished.
                </p>
                <button
                  type="button"
                  onClick={() => exitHistoryResearchView()}
                  className="shrink-0 rounded-xl bg-cp-accent px-4 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-blue-700"
                >
                  Back to research
                </button>
              </div>
            )}
            {showVerifyLoadingBanner && (
              <div className="flex items-center gap-2 text-sm text-cp-muted">
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-violet-600 border-t-transparent" />
                Loading saved claim…
              </div>
            )}
            {showVideoHistoryLoadingBanner && (
              <div className="flex items-center gap-2 text-sm text-cp-muted">
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-indigo-600 border-t-transparent" />
                Loading saved video verification…
              </div>
            )}
          </div>
        )}

        {showMainComposer && (
        <>
        {/* Question card: label + textarea + helper text */}
        <div className="bg-cp-raised rounded-2xl p-6 md:p-8">
          <div className="rounded-2xl bg-cp-surface shadow-sm border border-cp-border focus-within:ring-2 focus-within:ring-cp-accent focus-within:border-cp-accent transition-all">
            <label
              htmlFor={panelTab === "research" ? "question" : "claim"}
              className="block text-xs font-semibold text-cp-muted uppercase tracking-wide mb-1 px-6 pt-5"
            >
              {panelTab === "research" ? "Question" : "Paste a claim to verify"}
            </label>

            {panelTab === "research" ? (
              <textarea
                id="question"
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    if (canRun && !panelBusy) handleRunPanel();
                  }
                }}
                placeholder={
                  "Example: Question: How do economists explain the persistence of inflation after 2021?\nContext: Paste any relevant excerpts, notes, or data here. (Optional)"
                }
                className="w-full border-none outline-none bg-transparent resize-none text-base md:text-lg leading-relaxed text-cp-text px-6 pb-4"
                rows={4}
                disabled={panelBusy}
              />
            ) : (
              <textarea
                id="claim"
                value={claimInput}
                maxLength={MAX_CLAIM_CHARS}
                onChange={(e) => setClaimInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    if (canRun && !panelBusy) void handleVerifyClaim();
                  }
                }}
                placeholder={`e.g., ${EXAMPLE_CLAIM}`}
                className="w-full border-none outline-none bg-transparent resize-none text-base md:text-lg leading-relaxed text-cp-text px-6 pb-4"
                rows={4}
                disabled={panelBusy}
              />
            )}

            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 px-6 pb-5 border-t border-cp-border-soft pt-3">
              {panelTab === "research" ? (
                <p className="text-xs text-cp-muted">
                  Tip: Start with <span className="font-semibold">Question:</span> and, if needed, add an optional{" "}
                  <span className="font-semibold">Context:</span> section underneath. Anything after{" "}
                  <span className="font-mono">Context:</span> will be treated as source material for the panel.
                </p>
              ) : (
                <p className="text-xs text-cp-muted">
                  One sentence or multiple paragraphs — max {MAX_CLAIM_CHARS.toLocaleString()} characters (
                  {claimInput.length}/{MAX_CLAIM_CHARS}).
                </p>
              )}
              {/* File attach — Research tab */}
              {panelTab === "research" && (
                <FileAttachButton
                  disabled={panelBusy}
                  attachedFileName={researchAttachedFile ?? undefined}
                  onExtracted={(text, fileName) => {
                    const MAX_FILE_CHARS = 12000;
                    const trimmed = text.length > MAX_FILE_CHARS ? text.slice(0, MAX_FILE_CHARS) : text;
                    setQuestion((prev) => {
                      const base = prev.trim();
                      if (base) {
                        // Strip any leading "Context:" the file may already have to avoid doubling
                        const fileBody = trimmed.replace(/^context:\s*/i, "").trimStart();
                        return `${base}\n\nContext:\n${fileBody}`;
                      }
                      return trimmed;
                    });
                    setResearchAttachedFile(fileName);
                    if (text.length > MAX_FILE_CHARS) {
                      setError(`File truncated to ${MAX_FILE_CHARS.toLocaleString()} characters.`);
                    }
                  }}
                  onError={(msg) => setError(msg)}
                  onClear={() => {
                    setResearchAttachedFile(null);
                  }}
                />
              )}
              {/* File attach — Verify tab */}
              {panelTab === "verify" && (
                <FileAttachButton
                  disabled={panelBusy}
                  attachedFileName={claimAttachedFile ?? undefined}
                  onExtracted={(text, fileName) => {
                    const MAX_FILE_CHARS = 12000;
                    const trimmed = text.length > MAX_FILE_CHARS ? text.slice(0, MAX_FILE_CHARS) : text;
                    setClaimInput((prev) => {
                      const base = prev.trim();
                      if (base) {
                        const fileBody = trimmed.replace(/^context:\s*/i, "").trimStart();
                        const combined = `${base}\n\nContext:\n${fileBody}`;
                        return combined.length > MAX_CLAIM_CHARS ? combined.slice(0, MAX_CLAIM_CHARS) : combined;
                      }
                      return trimmed.length > MAX_CLAIM_CHARS ? trimmed.slice(0, MAX_CLAIM_CHARS) : trimmed;
                    });
                    setClaimAttachedFile(fileName);
                    if (text.length > MAX_FILE_CHARS) {
                      setError(`File truncated to ${MAX_FILE_CHARS.toLocaleString()} characters.`);
                    }
                  }}
                  onError={(msg) => setError(msg)}
                  onClear={() => {
                    setClaimAttachedFile(null);
                  }}
                />
              )}
            </div>
          </div>
        </div>

        <p className="text-sm text-cp-muted mt-3">
          Press <span className="font-semibold font-mono">Cmd/Ctrl + Enter</span> to{" "}
          {panelTab === "research" ? "run the panel" : "verify the claim"}.
        </p>

        {panelTab === "research" && (
          <div className="mt-4 flex flex-wrap gap-2 text-xs">
            <span className="text-cp-faint">Try one:</span>
            {EXAMPLE_QUESTIONS.map((q) => (
              <button
                key={q}
                type="button"
                onClick={() => setQuestion(q)}
                className="rounded-full border border-cp-border bg-cp-surface px-3 py-1 text-cp-muted hover:border-cp-accent hover:text-cp-accent transition-colors"
              >
                {q}
              </button>
            ))}
          </div>
        )}
        </>
        )}
        {showMainVideoComposer && (
          <VideoUploader
            plan={normalizedPlan}
            videoLimit={videoLimit}
            videoRunsThisMonth={videoRunsThisMonth}
            onSuccess={(p) => {
              setVideoVerificationPayload(p);
              void refreshUsage();
              setHistoryItems((h) => {
                const newItem: HistoryItem = {
                  id: p.verificationId,
                  type: "video_verification" as const,
                  title: truncateHistoryTitle(
                    `Video: ${p.fileName} (${formatHistoryVideoDuration(p.metadata.duration)})`
                  ),
                  at: new Date().toISOString(),
                  fileName: p.fileName,
                  durationSeconds: p.metadata.duration,
                  verdict: p.verdict,
                  consensusScore: p.consensusScore,
                  governanceStatus: p.governanceStatus ?? undefined,
                };
                const deduped = h.filter(
                  (x) => x.id !== p.verificationId
                );
                return [newItem, ...deduped].slice(0, MAX_HISTORY_LOCAL_STORAGE);
              });
              trackEvent("video_verification", { plan: normalizedPlan });
            }}
            onUsageRefresh={() => void refreshUsage()}
          />
        )}
          </>
        )}
        </div>

        {showMainComposer && (
        <div className="mt-6 lg:mt-0 rounded-2xl border border-cp-border bg-cp-surface shadow-sm p-6">
          <h2 className="text-[15px] font-bold text-cp-text">Panel setup</h2>
          <p className="mt-1 mb-5 text-sm text-cp-muted">Choose a preset or pick models.</p>

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

            <div className="flex flex-col items-center gap-2">
                {/* Visually distinguish the "running" state so users can tell when the panel is
                    thinking vs. when results are ready. */}
                <button
                type="button"
                  onClick={panelTab === "research" ? handleRunPanel : () => void handleVerifyClaim()}
                disabled={panelBusy || !canRun}
                aria-busy={panelBusy}
                className={`inline-flex w-full items-center justify-center gap-2 rounded-xl px-6 py-3 text-sm font-semibold shadow-sm transition-colors ${
                  panelBusy
                    ? "bg-cp-muted text-white cursor-wait animate-pulse"
                    : !canRun
                    ? "bg-cp-faint text-white cursor-not-allowed opacity-50"
                    : "bg-cp-accent text-white hover:bg-blue-700"
                }`}
              >
                {panelBusy ? (
                  <svg
                    className="h-4 w-4 shrink-0 animate-spin"
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
                ) : (
                  <svg className="h-3.5 w-3.5 shrink-0" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                    <path d="M8 5v14l11-7z" />
                  </svg>
                )}
                {panelBusy
                  ? panelTab === "research"
                    ? "Running panel…"
                    : "Verifying claim…"
                  : panelTab === "research"
                    ? "Run panel"
                    : "Verify claim"}
                </button>
              <p className="text-xs text-cp-faint">
                or press <span className="font-semibold">⌘ Enter</span>
              </p>
            </div>
            {showLowRunsRemaining && (
              <p className="flex items-center gap-1.5 text-xs text-amber-800/90">
                <svg
                  className="h-3.5 w-3.5 shrink-0 text-amber-600"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                  aria-hidden
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
                  />
                </svg>
                <span>
                  Low runs remaining: {remainingRuns} left this month
                </span>
              </p>
            )}

            {/* Model Status Chips While Running */}
            {panelBusy && (
              <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-cp-faint">
                <span className="font-medium text-cp-muted">Querying models:</span>
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
                    You&apos;ve reached your monthly run limit
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
                    onClick={() => router.push("/billing")}
                    className="font-semibold underline hover:text-amber-900"
                  >
                    Upgrade Plan
                  </button>{" "}
                  or try again next month.
                </p>
            </div>
            )}
          </div>
        </div>
        )}
        </div>
      </section>

      {/* Status Pills (Legacy - for larger status display) */}
        {panelBusy && (
        <div className="bg-cp-surface rounded-2xl shadow-sm border border-cp-border p-6">
          <h2 className="text-lg font-semibold mb-4 text-cp-text">Panel Status</h2>
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
        {verificationPayload && panelTab === "verify" && (
          <div className="mx-auto mt-8 w-full max-w-[900px]">
            <div className="mb-4 flex flex-col gap-3 rounded-2xl border-2 border-violet-200 bg-violet-50/90 px-4 py-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-cp-muted">
                <span className="font-semibold text-cp-text">Claim result</span>
                {" — "}
                Saved to your history. Start another check from the button below, or return to the claim composer.
              </p>
              <button
                type="button"
                onClick={() => setVerificationPayload(null)}
                className="shrink-0 rounded-xl border-2 border-cp-border bg-cp-surface px-4 py-2.5 text-sm font-semibold text-cp-muted shadow-sm transition-colors hover:border-violet-300 hover:bg-violet-50/80"
              >
                Back to verify claim
              </button>
            </div>
            <ClaimVerificationResult
              data={verificationPayload}
              onVerifyAnother={() => {
                setVerificationPayload(null);
                setClaimInput("");
                setPanelTab("verify");
              }}
            />
          </div>
        )}

        {videoVerificationPayload && panelTab === "video" && (
          <div className="mx-auto mt-8 w-full max-w-[900px]">
            <div className="mb-4 flex flex-col gap-3 rounded-2xl border-2 border-indigo-200 bg-indigo-50/90 px-4 py-4 shadow-sm sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-cp-muted">
                <span className="font-semibold text-cp-text">Video result</span>
                {" — "}
                Saved to your history. Verify another file below, or return to the upload screen.
              </p>
              <button
                type="button"
                onClick={() => setVideoVerificationPayload(null)}
                className="shrink-0 rounded-xl border-2 border-cp-border bg-cp-surface px-4 py-2.5 text-sm font-semibold text-cp-muted shadow-sm transition-colors hover:border-indigo-300 hover:bg-indigo-50/80"
              >
                Back to verify video
              </button>
            </div>
            <VideoVerificationResult
              data={videoVerificationPayload}
              onVerifyAnother={() => {
                setVideoVerificationPayload(null);
                setPanelTab("video");
              }}
            />
          </div>
        )}

        {!verificationPayload && panelTab === "research" && runStatus === "complete" && adaptiveRestoreNotice && (
          <div className="mx-auto mt-8 w-full max-w-[900px] rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
            {adaptiveRestoreNotice}
          </div>
        )}

        {!verificationPayload &&
          panelTab === "research" &&
          runStatus === "complete" &&
          results.length > 0 && (
          <Suspense
            fallback={
              <div className="mx-auto mt-8 w-full max-w-[900px] bg-cp-surface rounded-2xl shadow-sm border border-cp-border p-8">
                <div className="animate-pulse space-y-4">
                  <div className="h-8 bg-cp-border rounded w-1/3" />
                  <div className="h-32 bg-cp-border rounded" />
                  <div className="h-24 bg-cp-border rounded" />
                </div>
              </div>
            }
          >
            <div className="mx-auto mt-8 w-full max-w-[900px] bg-cp-surface rounded-2xl shadow-sm border border-cp-border p-8">
              <ResultsDisplay
                results={results}
                synthesizedReport={synthesizedReport}
                onRerun={handleRerun}
                onAddModel={handleAddModel}
                question={question}
                synthesisStatus={synthesisStatus}
                synthesisReport={synthesisReport}
                synthesisConsensusSummary={synthesisConsensusSummary}
                synthesisError={synthesisError}
                runId={currentRunId}
                teamGovernance={synthesisGovernance}
                orgGovernanceStatus={orgGovernanceStatus}
                adaptive={adaptivePanel}
                onRunFollowUp={handleRunFollowUp}
              />
            </div>
          </Suspense>
        )}

      {/* Note: Error display is shown inline within the main card above
          We removed the duplicate large error state section to avoid showing errors twice */}

      {/* Floating up/down arrows let users quickly jump to the top or bottom
          of long results instead of manually scrolling. */}
      {showScrollNav &&
        ((verificationPayload && panelTab === "verify") ||
          (videoVerificationPayload && panelTab === "video") ||
          (panelTab === "research" && runStatus === "complete" && results.length > 0)) && (
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

