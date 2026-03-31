/**
 * TypeScript Type Definitions
 * 
 * Central type definitions for the ConvergePanel application.
 * These types are used throughout the codebase to ensure type safety.
 */

import { Timestamp } from "firebase/firestore";
import { BillingInterval } from "@/lib/plans";

// Re-export panel schemas for convenience
export type { PanelResultPublic, PanelForSynthesis } from "@/lib/panel/schemas";
export type { TokenUsageNormalized } from "@/lib/panel/normalizeTokens";

/**
 * Structured Synthesis Report Type
 * 
 * Used for the Synthesis tab - represents a structured JSON synthesis report
 * that avoids HTML and provides clean, renderable data.
 */
export interface StructuredSynthesisReport {
  version: "1.0";
  unifiedSynthesis: string; // Markdown allowed, but no HTML tags
  keyConsensus: Array<{
    claim: string;
    confidence: "high" | "medium" | "low" | "mixed";
    models: string[]; // Model display names or labels (Alpha, Beta, etc.)
    whyItMatters?: string;
  }>;
  keyDisagreements: Array<{
    topic: string; // Short label
    summary: string; // 1-2 sentence synthesis of the disagreement
    models: string[];
    confidence: "high" | "medium" | "low" | "mixed";
  }>;
  weakOrSingleModel: Array<{
    claim: string;
    model: string; // Model label (Alpha, Beta, etc.)
    confidence: "high" | "medium" | "low" | "mixed";
    caution?: string; // Why it might be weak
  }>;
  biasBlindSpots?: Array<{
    risk: string; // What bias/blind spot is present
    impact: string; // How it may skew conclusions
    mitigation: string; // What user should do
  }>;
}

/**
 * User Profile Interface
 * 
 * Represents a user's profile data stored in Firestore users/{uid} collection.
 * This includes authentication info, plan details, onboarding responses, and usage tracking.
 * 
 * Note: Firestore Timestamp types are used for createdAt/updatedAt, but can also be
 * represented as strings when reading from Firestore in some contexts.
 */
export interface UserProfile {
  // Authentication & basic info
  email: string;
  name?: string; // Optional full name (can be edited on Profile page)
  phone?: string; // Optional phone number (can be edited on Profile page)
  
  // Address (structured fields, all optional)
  address?: {
    line1?: string;
    line2?: string;
    city?: string;
    state?: string;
    postalCode?: string;
    country?: string;
  };
  
  // Plan & usage
  plan?: "free" | "lite" | "full";
  runsThisMonth?: number; // Usage tracking for quota enforcement
  /** Video verifications used in the current usage month (paid plans). */
  videoRunsThisMonth?: number;
  usageMonth?: string; // YYYY-MM format for monthly reset tracking
  totalRuns?: number; // Lifetime total of panel runs (never resets)
  // Token usage tracking (denormalized for fast Admin queries)
  tokensUsedCurrentPeriod?: number; // Tokens used in current subscription billing period (uses billingCycleStart)
  // Subscription plan limits (set by Stripe webhook)
  monthlyLimit?: number; // Maximum runs per month for current plan
  maxModelsPerRun?: number; // Maximum models allowed per run for current plan
  
  // Stripe subscription fields
  stripeCustomerId?: string; // Stripe customer ID (set when user subscribes)
  stripeSubscriptionId?: string; // Active Stripe subscription ID
  subscriptionStatus?: string; // Stripe subscription status (e.g., "active", "canceled", "past_due", etc.)
  billingInterval?: BillingInterval; // Monthly or annual billing
  billingCycleStart?: Timestamp | string; // Start of current billing period (for usage reset)
  
  // Onboarding responses (captured on /onboarding page, can be edited on Profile page)
  // These fields are set during the onboarding flow after signup
  onboardingRole?: "founder_operator" | "analyst_consultant" | "student_researcher" | "engineer_datascientist" | "other";
  primaryUseCase?: "market_research" | "strategy_decisions" | "academic_research" | "compare_models" | "other";
  expectedUsage?: "few_per_month" | "few_per_week" | "daily";
  referralSource?: "friend" | "social" | "search" | "community" | "other";
  
  // Onboarding completion flag
  // If false or missing, user will be redirected to /onboarding
  onboardingCompleted?: boolean;
  
  // Metadata
  uid?: string; // User ID (Firebase Auth UID)
  /** Legacy app role; governance dashboard access uses peer reviewer assignment (see governanceReviewerFor). */
  role?: "user" | "admin" | "reviewer";

  /** Self-service governance: user is available for others to assign as reviewer (5-model plan). */
  governanceReviewerEnabled?: boolean;
  /** UIDs of assigners this user reviews for (maintained when assigners pick this user). */
  governanceReviewerFor?: string[];
  /** Assigner's chosen reviewer (exactly one at a time). */
  governanceReviewerEmail?: string;
  governanceReviewerUid?: string;
  governanceReviewerAssignedAt?: string;

  /** Team workspace (optional; enterprise governance) */
  teamId?: string;
  teamRole?: "owner" | "admin" | "member";
  createdAt?: Timestamp | string;
  updatedAt?: Timestamp | string;
  lastLoginAt?: Timestamp | string;
  isDisabled?: boolean;
}

/**
 * Supported model identifiers
 * These are the only models supported in the MVP
 */
export type ModelId = "chatgpt" | "claude" | "grok" | "perplexity" | "gemini";

/**
 * Public model execution status (the only values exposed to UI / API consumers)
 * - ok: Successfully received response from the primary model
 * - substituted: Primary model failed, DeepSeek fallback succeeded
 * - failed: Both primary and fallback failed (or fallback not allowed)
 */
export type ModelStatus = "ok" | "substituted" | "failed";

/**
 * Internal connector status — connectors may return these granular values,
 * but the orchestrator normalizes them to ModelStatus before exposing publicly.
 */
export type ConnectorStatus = ModelStatus | "error" | "timeout" | "refused" | "rate_limited";

/**
 * Result from a single model execution
 * 
 * Contains the model's response along with metadata about the execution.
 * Connectors may set status to any ConnectorStatus; the orchestrator
 * normalizes it to ModelStatus ("ok" | "substituted" | "failed") before
 * returning results to the API layer.
 */
export interface ModelResult {
  modelId: ModelId;
  status: ConnectorStatus;
  rawText: string | null;
  errorMessage?: string;
  latencyMs: number;
  tokenUsage?: {
    totalTokens: number;
    promptTokens: number | null;
    completionTokens: number | null;
  };
  rawResponse?: any;
  hasUsageMetadata?: boolean;
  wasTruncated?: boolean;

  // Per-slot metadata (always populated by panel orchestration)
  requestedModel?: string;
  provider?: string;
  actualModel?: string;

  // Substitution metadata (only when status === "substituted")
  substitutedFrom?: string;
  substitutionReason?: string;
}

/**
 * Request payload for running a panel
 * 
 * Sent from client to /api/run-panel endpoint.
 */
export interface RunPanelRequest {
  question: string; // User's question to ask all models
  selectedModels: ModelId[]; // Which models to query (minimum 2 required)
}

/**
 * Response from panel execution API
 * 
 * Contains results from all selected models.
 * Note: Results are returned in public format (no rawResponse) for security and size reasons.
 */
export interface RunPanelResponse {
  results: ModelResult[]; // Note: In practice, these are PanelResultPublic (no rawResponse)
}

/**
 * Model Connector Interface
 * 
 * All model connectors must implement this interface.
 * This allows the system to treat all models uniformly.
 */
export interface ModelConnector {
  id: ModelId;
  displayName: string;
  sendPrompt(
    question: string,
    systemWrapper: string
  ): Promise<{
    status: ConnectorStatus;
    rawText: string | null;
    latencyMs: number;
  }>;
}

/**
 * A claim extracted from a model's response
 * 
 * Claims are sentence-level or paragraph-level statements that can be
 * compared across models to find consensus or disagreement.
 */
export interface Claim {
  text: string; // The claim text
  modelId: ModelId; // Which model made this claim
  originalIndex: number; // Original position in the response (for reference)
}

/**
 * A cluster of similar claims
 * 
 * Claims that are similar (talking about the same thing) are grouped
 * into clusters. The cluster tracks whether there's consensus and any
 * numeric conflicts.
 */
export interface ClaimCluster {
  id: string; // Unique cluster identifier
  claims: Claim[]; // All claims in this cluster
  consensus: boolean; // True if ≥2 models agree (have claims in this cluster)
  numericConflicts: Array<{
    claim1: Claim;
    claim2: Claim;
    values: string[]; // The conflicting numeric values
  }>;
}

/**
 * Consensus analysis results
 * 
 * Contains all claim clusters and a summary of consensus/disagreement.
 */
export interface ConsensusAnalysis {
  clusters: ClaimCluster[];
  trustSummary: {
    strongConsensus: number; // Number of clusters with consensus
    contestedAreas: number; // Number of clusters with disagreement
    uncertainPoints: number; // Number of clusters with only one model
  };
  // New agreement map clusters (with proper labeling)
  agreementClusters?: Array<{
    id: string;
    representativeText: string;
    modelIds: ModelId[];
    claims: Array<{ id: string; modelId: ModelId; text: string }>;
    label: "consensus" | "single" | "disagreement";
  }>;
  // Optional detailed findings for Trust Summary rendering
  consensusFindings?: Array<{ text: string; modelIds: ModelId[] }>;
  contestedFindings?: Array<{ text: string; modelIds: ModelId[] }>;
  singleModelInsightsCount?: number;
}

/**
 * Synthesized report combining all model responses
 * 
 * This is the final output that shows:
 * - Unified answer with consensus and disagreements
 * - Agreement/disagreement map
 * - Raw responses from each model
 */
export interface SynthesizedReport {
  unifiedAnswer: string; // HTML-formatted unified report
  consensusAnalysis: ConsensusAnalysis; // Detailed analysis
  rawResponses: Array<{
    modelId: ModelId;
    text: string;
    status: ConnectorStatus;
  }>;
}

/**
 * User subscription plan types
 * 
 * Matches PlanId from @/lib/plans for consistency.
 * - "free": Free plan (2 models, 8 runs/month)
 * - "lite": Research Lite plan (3 models, 80 runs/month)
 * - "full": Full Panel plan (5 models, 150 runs/month)
 */
export type UserPlan = "free" | "lite" | "full";

/**
 * User usage tracking for monthly quotas
 * 
 * Stored in Firestore at users/{uid}:
 * - plan: Current subscription plan (defaults to "free")
 * - runsThisMonth: Number of panel runs in the current month
 * - usageMonth: YYYY-MM format string (e.g., "2025-11") for tracking which month
 * 
 * The usageMonth field allows automatic reset when a new month begins.
 */
export interface UserUsage {
  plan: UserPlan;
  runsThisMonth: number;
  usageMonth: string; // Format: "YYYY-MM" (e.g., "2025-11")
}

/**
 * API response shape for /api/run-panel
 * 
 * Standardized response format that always includes:
 * - ok: Whether the request succeeded
 * - results: Array of model results (only present if ok === true)
 * - errorCode: Specific error code for client-side handling (only present if ok === false)
 * - message: Human-readable error message (only present if ok === false)
 * - usage: Usage information (only present if ok === true)
 * - maxModelsPerRun: Maximum models allowed per run (only present in error responses)
 * - maxRunsPerMonth: Maximum runs allowed per month (only present in error responses)
 */
export interface RunPanelApiResponse {
  ok: boolean;
  results?: ModelResult[];
  runId?: string; // Run ID for associating synthesis reports with runs
  /** Org governance evaluation (paid plans only). */
  governanceStatus?: "approved" | "needs_review" | "blocked";
  errorCode?: string;
  message?: string;
  usage?: {
    runsThisMonth: number;
    maxRunsPerMonth: number;
    maxModelsPerRun: number;
  };
  maxModelsPerRun?: number;
  maxRunsPerMonth?: number;
}


