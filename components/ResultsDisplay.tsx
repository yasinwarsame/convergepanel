"use client";

/**
 * Results Display Component
 * 
 * Displays the results of a panel run in three sections:
 * 1. Unified Answer - Synthesized consensus report
 * 2. Agreement/Disagreement Map - Visual breakdown of consensus vs conflicts
 * 3. Panel Responses - Expandable raw responses from each model
 * 
 * Runtime note: previously crashed due to duplicate state declarations and mis-nested JSX.
 * 
 * Special handling:
 * - If only 1 model responded: Shows warning banner (no synthesis)
 * - If ≥2 models responded: Shows full synthesis and analysis
 * - Failed models are shown separately with error details
 * 
 * Trust Summary rendering uses consensusAnalysis from synthesizeReport (single source of truth for consensus/contested/single-model).
 */

import { useEffect, useState, useMemo, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  ModelResult,
  SynthesizedReport,
  ModelId,
} from "@/lib/types";
import { getPanelModelConfig, PanelModelId, getModelDisplayNameSafe } from "@/lib/panelModels";
import { normalizeBullets } from "@/lib/normalizeBullets";
import { normalizeList } from "@/lib/normalizeList";
import {
  extractAllSections,
  mergeDuplicateSections,
  sortSections,
} from "@/lib/sectionUtils";
import { PanelSection } from "@/components/PanelSection";
import PanelSynthesisView from "@/components/PanelSynthesisView";
import ModelChip from "@/components/ModelChip";
import { sanitizeModelText, truncateForSynthesis, MAX_CHARS_SYNTHESIS_PER_MODEL } from "@/lib/panel/sanitizeText";
import { classifyClusterType, isAnalysisReady } from "@/lib/synthesis/trustSummary";
import { useAuth } from "@/components/AuthProvider";

/**
 * Deduplicate claims by modelId and text
 * 
 * Removes duplicate claims where the same model says the same thing multiple times.
 * This prevents redundant display of identical statements from the same model.
 * 
 * @param claims - Array of claims to deduplicate
 * @returns Array of unique claims (same model + same text = only one entry)
 */
function deduplicateClaims<T extends { modelId: string; text: string; id?: string }>(
  claims: T[]
): T[] {
  const seen = new Map<string, T>();
  
  for (const claim of claims) {
    // Create a unique key from modelId and normalized text
    // Normalize text by trimming and lowercasing for comparison
    const normalizedText = claim.text.trim().toLowerCase();
    const key = `${claim.modelId}:${normalizedText}`;
    
    // Only keep the first occurrence of each unique model+text combination
    if (!seen.has(key)) {
      seen.set(key, claim);
    }
  }
  
  return Array.from(seen.values());
}

/**
 * Centralized Trust Summary color system
 * 
 * Used consistently across Trust Summary sections and Agreement/Disagreement Map
 * to ensure visual consistency for agreement, contested, and uncertain items.
 */
const TRUST_STYLES = {
  agree: {
    container: "bg-green-50 border border-green-200",
    accentBar: "bg-green-400",
    title: "text-green-800",
    body: "text-green-700", // Light green for agreement text
    meta: "text-green-600",
  },
  contested: {
    container: "bg-orange-50 border border-orange-200",
    accentBar: "bg-orange-400",
    title: "text-orange-800",
    body: "text-orange-800",
    meta: "text-orange-600",
  },
  uncertain: {
    container: "bg-blue-50 border border-blue-200",
    accentBar: "bg-blue-400",
    title: "text-blue-800",
    body: "text-slate-900",
    meta: "text-slate-600",
  },
} as const;

/**
 * Component to render HTML unified answer with colored section dividers and styled headings
 * 
 * This component processes the unified answer HTML and adds:
 * - Colored dividers for major sections (Agreement = green, Disagreement = amber, Uncertain = sky)
 * - Styled section headings with colored accents matching the Trust Summary pills
 * - Consistent typography for all headings
 * - Styled card containers for list items in each section
 * 
 * Color mapping (matches Trust Summary pills):
 * - Areas of Agreement → emerald/green (matches Strong Consensus pill)
 * - Model Split / Disagreements → amber/orange (matches Contested Areas pill)
 * - Uncertain Points / Open Questions → sky/blue (matches Uncertain Points pill)
 */
/**
 * Component to render HTML unified answer content
 * 
 * NOTE: This component removes all duplicate sections that are already shown in Trust Summary.
 * Agreement/disagreement sections are removed to prevent duplication - Trust Summary is the
 * canonical location for consensus/disagreement content.
 * 
 * This component only renders non-duplicate content such as:
 * - Bias & Blind Spots
 * - Open Questions  
 * - Methodology
 * - Other structured synthesis sections
 */
function CollapsibleUnifiedAnswer({ html }: { html: string }) {
  // Process HTML to remove duplicate sections that are already shown in Trust Summary
  // These sections should NOT appear in "Overall Synthesis" since they're already displayed as cards in Trust Summary above.
  let processedHtml = html;
  
  // Pattern helper to remove entire sections (heading + all content until next heading or end)
  const removeSectionPattern = (sectionNames: string[]) => {
    const escapedNames = sectionNames.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    return new RegExp(
      `<h[234][^>]*>(?:${escapedNames.join('|')})[^<]*<\\/h[234]>[\\s\\S]*?(?=<h[234][^>]*>|$)`,
      'gi'
    );
  };
  
  // Remove all agreement/consensus sections - already shown in Trust Summary
  processedHtml = processedHtml.replace(
    removeSectionPattern([
      'Strong Consensus',
      'Where the models agree',
      'Areas of Agreement',
      'Areas of agreement'
    ]),
    ''
  );
  
  // Remove all disagreement/contested sections - already shown in Trust Summary
  processedHtml = processedHtml.replace(
    removeSectionPattern([
      'Contested Areas',
      'Where the models disagree',
      'Model Split / Disagreements',
      'Model Split',
      'Disagreements',
      'Arguments.*Disagreements'
    ]),
    ''
  );
  
  // Remove "Uncertain Points" and "What is uncertain" sections - already covered in Trust Summary
  processedHtml = processedHtml.replace(
    removeSectionPattern([
      'Uncertain Points',
      'What is uncertain',
      'What is uncertain or weakly supported',
      'Single-model',
      'Weakly supported'
    ]),
    ''
  );
  
  // Clean up any remaining "Trust Summary" or "Overall Synthesis" headings that might appear in the HTML
  processedHtml = processedHtml.replace(/<h[23]>\s*Trust Summary\s*<\/h[23]>/gi, '');
  processedHtml = processedHtml.replace(/<h[23]>\s*Overall Synthesis\s*<\/h[23]>/gi, '');
  
  // Remove duplicate "Unified Answer" heading - we already have the section title
  processedHtml = processedHtml.replace(/<h2>\s*Unified Answer\s*<\/h2>/gi, '');
  
  // After all removals, check if there's any meaningful content left
  // Strip HTML tags to check for actual text content
  const textContent = processedHtml.replace(/<[^>]+>/g, '').trim();
  const hasContent = textContent.length > 0;
  
  // If no content remains after removing duplicates, return nothing
  if (!hasContent) {
    return null;
  }
  
  // Style remaining headings consistently (for bias, open questions, methodology, etc.)
  processedHtml = processedHtml.replace(
    /<h2(?![^>]*class=)([^>]*)>([^<]+)<\/h2>/g,
    '<h2 class="text-base md:text-lg font-semibold tracking-tight text-slate-900 mb-2 mt-6"$1>$2</h2>'
  );
  
  processedHtml = processedHtml.replace(
    /<h3(?![^>]*class=)([^>]*)>([^<]+)<\/h3>/g,
    '<h3 class="text-base md:text-lg font-semibold tracking-tight text-slate-900 mb-2 mt-6"$1>$2</h3>'
  );
  
  processedHtml = processedHtml.replace(
    /<h4(?![^>]*class=)([^>]*)>([^<]+)<\/h4>/g,
    '<h4 class="text-base md:text-lg font-semibold tracking-tight text-slate-900 mb-2 mt-4"$1>$2</h4>'
  );
  
  // CSP compliance: Remove inline style attributes from HTML content
  // This prevents CSP violations from LLM-generated HTML that might contain style="..."
  processedHtml = processedHtml.replace(/\s+style\s*=\s*["'][^"']*["']/gi, '');
  
  // CSP compliance: Remove any <script> tags (defense in depth)
  processedHtml = processedHtml.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '');
  
  // Render the cleaned HTML with only non-duplicate content (bias, methodology, etc.)
  // Agreement/disagreement sections have been removed to avoid duplication with Trust Summary above.
  return (
    <div
      className="prose max-w-none prose-slate prose-headings:text-slate-900 prose-p:text-slate-800 prose-strong:text-slate-900"
      dangerouslySetInnerHTML={{
        __html: processedHtml,
      }}
    />
  );
}


/**
 * Component to render markdown content with proper section structure
 * 
 * Extracts all sections, merges duplicates, and renders them uniformly.
 * Uses shared PanelSection component for consistent styling across:
 * - ChatGPT, Claude, Grok, Perplexity
 * - List view and Compare view
 * 
 * Only three sections use bullets:
 * - KEY METRICS AND QUANTITATIVE ESTIMATES
 * - KEY CLAIMS
 * - SUGGESTED FOLLOW-UP QUESTIONS
 * 
 * All other sections are rendered as paragraph blocks.
 * All section headings are uppercase.
 */
function ModelResponseBody({ content }: { content: string }) {
  // Extract all sections from markdown
  const rawSections = extractAllSections(content);

  // Merge duplicate sections (same title, case-insensitive)
  const mergedSections = mergeDuplicateSections(rawSections);

  // Sort sections according to standard order
  const orderedSections = sortSections(mergedSections);

  return (
    <div className="space-y-4">
      {orderedSections.map((section, index) => (
        <PanelSection
          key={`${section.title}-${index}`}
          title={section.title}
          content={section.content}
          className=""
        />
      ))}
    </div>
  );
}

/**
 * Component to render markdown text with collapsible bias/contention sections
 * 
 * Bias / contention details are collapsed by default to keep the panel clean.
 * Users can expand them when they want to inspect potential biases.
 * 
 * In Compare View, sections are always visible (no collapse) so users can compare
 * models side-by-side without extra clicks.
 * 
 * NOTE: This component now uses ModelResponseBody which handles all section extraction,
 * deduplication, and uniform rendering. This component only adds collapsible UI for
 * bias/contention sections in List View.
 */
function CollapsibleMarkdown({ 
  text, 
  alwaysExpanded = false 
}: { 
  text: string;
  alwaysExpanded?: boolean; // If true, bias/contention sections are always visible (no collapse)
}) {
  // In Compare View (alwaysExpanded=true), render all content directly without collapsible UI
  // ModelResponseBody handles all section extraction, deduplication, and uniform rendering
  if (alwaysExpanded) {
    return <ModelResponseBody content={text} />;
  }

  // In List View, identify bias/contention sections for collapsible UI
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());

  // Extract and merge sections to identify which ones should be collapsible
  const rawSections = extractAllSections(text);
  const mergedSections = mergeDuplicateSections(rawSections);
  const orderedSections = sortSections(mergedSections);

  // Identify collapsible sections (bias/contention)
  const collapsibleSectionKeys = new Set<string>();
  for (const section of orderedSections) {
    const titleLower = section.title.toLowerCase();
    if (
      titleLower.includes("potential biases") ||
      titleLower.includes("biases") ||
      titleLower.includes("blind spots") ||
      titleLower.includes("uncertainties") ||
      titleLower.includes("disagreements") ||
      titleLower.includes("contested")
    ) {
      collapsibleSectionKeys.add(section.title.toLowerCase());
    }
  }

  // If no collapsible sections, render normally
  if (collapsibleSectionKeys.size === 0) {
    return <ModelResponseBody content={text} />;
  }

  const toggleSection = (title: string) => {
    const key = title.toLowerCase();
    const newExpanded = new Set(expandedSections);
    if (newExpanded.has(key)) {
      newExpanded.delete(key);
    } else {
      newExpanded.add(key);
    }
    setExpandedSections(newExpanded);
  };

  // Render sections with collapsible UI for bias/contention sections
  return (
    <div className="space-y-2">
      {orderedSections.map((section, index) => {
        const isCollapsible = collapsibleSectionKeys.has(section.title.toLowerCase());
        const isExpanded = expandedSections.has(section.title.toLowerCase());

        if (!isCollapsible) {
          // Render normal sections directly
          return (
            <PanelSection
              key={`${section.title}-${index}`}
              title={section.title}
              content={section.content}
              className=""
            />
          );
        }

        // Render collapsible sections with collapse UI
        return (
          <div key={`${section.title}-${index}`} className="border border-slate-200 rounded-md overflow-hidden">
            <button
              type="button"
              onClick={() => toggleSection(section.title)}
              className="flex w-full items-center justify-between rounded-md bg-slate-50 px-3 py-2 text-sm font-medium text-slate-800 hover:bg-slate-100 transition-colors"
            >
              <span>{section.title}</span>
              <svg
                className={`h-4 w-4 transition-transform ${isExpanded ? "rotate-180" : ""}`}
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
            {isExpanded && (
              <div className="mt-2 px-3 pb-3">
                <PanelSection
                  title={section.title}
                  content={section.content}
                  className=""
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

interface ResultsDisplayProps {
  results: ModelResult[];
  synthesizedReport: SynthesizedReport | null;
  onRerun: () => void;
  onAddModel: () => void;
  question: string;
  synthesisStatus?: "idle" | "loading" | "complete" | "error";
  synthesisReport?: string | null | any; // Can be string (legacy), StructuredSynthesisReport (V1), or SynthesisReportV2
  synthesisError?: string | null;
  runId?: string | null; // Optional runId for storing V2 reports in Firestore
}

/**
 * Safe text getter - handles both rawTextFull and rawText fields
 * This ensures backward compatibility and prevents missing text issues
 * Always returns a string, never undefined or null
 */
function getModelText(result: any): string {
  const text =
    result?.rawTextFull ??
    result?.rawText ??
    result?.text ??
    result?.outputText ??
    result?.output ??
    "";
  return typeof text === "string" ? text : String(text ?? "");
}

export default function ResultsDisplay({
  results,
  synthesizedReport,
  onRerun,
  onAddModel,
  question,
  synthesisStatus = "idle",
  synthesisReport: preGeneratedSynthesisReport,
  synthesisError: preGeneratedSynthesisError,
  runId,
}: ResultsDisplayProps) {
  const { user, authReady } = useAuth();
  // Defensive check: handle empty or malformed results gracefully
  if (!results || results.length === 0) {
    return (
      <div className="bg-white rounded-lg border border-gray-200 p-6">
        <p className="text-sm text-slate-500">
          No panel results to display yet. Run a panel to see the analysis.
        </p>
      </div>
    );
  }

  // TEMPORARY DEBUG LOG: Log results received by ResultsDisplay component
  // This helps diagnose why some models might not appear in the UI
  console.log("[ResultsDisplay] Received results:", results);
  console.log("[ResultsDisplay] Results count:", results.length);
  console.log("[ResultsDisplay] Results model IDs:", results.map(r => r.modelId));
  console.log("[ResultsDisplay] Results statuses:", results.map(r => ({ modelId: r.modelId, status: r.status })));

  // Track which model responses are expanded (for collapsible raw responses)
  const [expandedModels, setExpandedModels] = useState<Set<ModelId>>(
    new Set()
  );
  const [panelViewMode, setPanelViewMode] = useState<"list" | "compare" | "synthesis">(
    "list"
  );
  
  // Arguments / Disagreements section is collapsed by default to reduce noise.
  // Users can expand it when they want to inspect contested points.
  const [expandedDisagreementClusters, setExpandedDisagreementClusters] = useState<Set<string>>(
    new Set()
  );

  // Trust Summary collapsible sections (default to expanded/open)
  const [expandedStrongConsensus, setExpandedStrongConsensus] = useState(true);
  const [expandedContestedAreas, setExpandedContestedAreas] = useState(true);
  
  // Agreement / Disagreement Map accordion (collapsed by default)
  const [isAgreementMapOpen, setIsAgreementMapOpen] = useState(false);

  // CANONICAL DATA: Extract clusters array (same source used for Agreement Map rendering)
  // This is the single source of truth for both rendering and counting
  const canonicalClusters = useMemo(() => {
    if (!synthesizedReport?.consensusAnalysis) {
      return [];
    }
    const ca = synthesizedReport.consensusAnalysis;
    // Use agreementClusters if available (preferred), otherwise fall back to legacy clusters format
    const rawClusters =
      ca.agreementClusters ||
      (ca.clusters?.map((c: any) => {
        // Extract ALL model IDs from claims - no filtering by model ID
        const uniqueModels = Array.from(new Set(c.claims.map((cl: any) => cl.modelId)));

        // Legacy fallback labeling: allow contested when numericConflicts exist
        let label: "consensus" | "single" | "disagreement" = "single";
        if (Array.isArray(c.numericConflicts) && c.numericConflicts.length > 0) {
          label = "disagreement";
        } else if (uniqueModels.length >= 2) {
          label = "consensus";
        } else {
          label = "single";
        }

        return {
          id: c.id,
          representativeText: c.claims[0]?.text || "",
          modelIds: uniqueModels, // Preserve ALL model IDs - no filtering
          label,
          claims: c.claims.map((cl: any) => ({
            id: `${cl.modelId}-${cl.originalIndex || 0}`,
            modelId: cl.modelId,
            text: cl.text,
          })),
        };
      }) || []);

    // Deduplicate once and reuse for counts + cards
    const seen = new Set<string>();
    const deduped: any[] = [];
    for (const cluster of rawClusters) {
      const modelIds = Array.isArray(cluster.modelIds)
        ? cluster.modelIds
        : Array.from(new Set(cluster.claims?.map((cl: any) => cl.modelId) || []));
      const representativeText =
        cluster.representativeText || cluster.claims?.[0]?.text || "";
      const key =
        cluster.id || `${representativeText}|${[...modelIds].sort().join(",")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push({
        ...cluster,
        modelIds,
        representativeText,
      });
    }

    return deduped;
  }, [synthesizedReport]);

  // CANONICAL COUNTS: Group clusters by type using the same classification logic as rendering
  // These arrays are the EXACT arrays used for rendering cards in Agreement Map
  const { consensusClusters, contestedClusters, singleModelClusters } = useMemo(() => {
    const consensus: any[] = [];
    const contested: any[] = [];
    const single: any[] = [];

    for (const cluster of canonicalClusters) {
      const clusterType = classifyClusterType(cluster);
      if (clusterType === "consensus") {
        consensus.push(cluster);
      } else if (clusterType === "contested") {
        contested.push(cluster);
      } else {
        single.push(cluster);
      }
    }

    return {
      consensusClusters: consensus,
      contestedClusters: contested,
      singleModelClusters: single,
    };
  }, [canonicalClusters]);

  // CANONICAL COUNTS: Trust Summary counts derived from exact same arrays used for rendering
  const trustCounts = useMemo(() => ({
    strongConsensus: consensusClusters.length,
    contestedAreas: contestedClusters.length,
    singleModelOrUncertain: singleModelClusters.length,
  }), [consensusClusters.length, contestedClusters.length, singleModelClusters.length]);

  // Analysis ready check (moved to top-level to fix hooks violation)
  const analysisReady = useMemo(() => {
    return isAnalysisReady(synthesizedReport, preGeneratedSynthesisReport);
  }, [synthesizedReport, preGeneratedSynthesisReport]);

  // Trust items derived from the same canonical arrays used for KPI counts and cards
  const trustItems = useMemo(() => {
    if (!analysisReady) {
      return {
        strongConsensusItems: [],
        contestedItems: [],
        uncertainCount: 0,
      };
    }

    return {
      strongConsensusItems: consensusClusters.map((cluster: any, idx: number) => ({
        id: cluster.id || `consensus-${idx}`,
        text: cluster.representativeText || cluster.claims?.[0]?.text || "",
        confidence: cluster.confidence,
        models: cluster.modelIds || [],
        refs: cluster.refs,
      })),
      contestedItems: contestedClusters.map((cluster: any, idx: number) => ({
        id: cluster.id || `contested-${idx}`,
        text: cluster.representativeText || cluster.claims?.[0]?.text || "",
        models: cluster.modelIds || [],
        refs: cluster.refs,
      })),
      uncertainCount: singleModelClusters.length,
    };
  }, [analysisReady, consensusClusters, contestedClusters, singleModelClusters.length]);

  // Dev-only validation: Log counts to verify they match rendered cards
  if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
    console.debug('[trustCounts-check]', {
      consensus: trustCounts.strongConsensus,
      contested: trustCounts.contestedAreas,
      single: trustCounts.singleModelOrUncertain,
      totalClusters: canonicalClusters.length,
      consensusClusters: consensusClusters.length,
      contestedClusters: contestedClusters.length,
      singleModelClusters: singleModelClusters.length,
    });
  }

  // Panel Responses accordion (collapsed by default)
  const [isPanelResponsesOpen, setIsPanelResponsesOpen] = useState(false);

  // Compare View accordion (collapsed by default)
  const [isCompareViewOpen, setIsCompareViewOpen] = useState(false);

  // Track which models have expanded "View synthesis input" toggle
  const [expandedSynthesisInputs, setExpandedSynthesisInputs] = useState<Set<ModelId>>(
    new Set()
  );

  // Track which models are expanded in Compare View (collapsed by default)
  const [expandedCompareModels, setExpandedCompareModels] = useState<Set<ModelId>>(
    new Set()
  );

  // Compute synthesis input text for each model (truncated version used for synthesis)
  // This allows users to see exactly what text was sent to the synthesis step
  const synthesisInputsByModel = useMemo(() => {
    const inputs: Partial<Record<ModelId, { text: string; wasTruncated: boolean; truncatedAt: number }>> = {};
    for (const result of results) {
      if (result.status === "ok" || result.status === "substituted") {
        const fullText = getModelText(result);
        const sanitized = sanitizeModelText(fullText);
        const { text, wasTruncated } = truncateForSynthesis(sanitized, MAX_CHARS_SYNTHESIS_PER_MODEL);
        inputs[result.modelId] = {
          text,
          wasTruncated,
          truncatedAt: wasTruncated ? MAX_CHARS_SYNTHESIS_PER_MODEL : fullText.length,
        };
      }
    }
    return inputs;
  }, [results]);

  // Check if any model was truncated for synthesis
  const hasAnySynthesisTruncation = useMemo(() => {
    return results.some(r => (r as any).wasTruncatedForSynthesis === true);
  }, [results]);

  const modelMetaMap = results.reduce<Record<ModelId, ModelResult>>(
    (acc, result) => {
      acc[result.modelId] = result;
      return acc;
    },
    {} as Record<ModelId, ModelResult>
  );
  
  // TEMPORARY DEBUG LOG: Log modelMetaMap to verify all models are in the map
  console.log("[ResultsDisplay] modelMetaMap keys:", Object.keys(modelMetaMap));

  // Compare View is enabled whenever at least two models have OK answers and
  // structured comparison data, regardless of which specific models they are.
  // This is now fully dynamic and will include Grok (and any future models) automatically.
  const canCompare = (synthesizedReport?.rawResponses?.length ?? 0) >= 2;

  useEffect(() => {
    if (!canCompare && panelViewMode === "compare") {
      setPanelViewMode("list");
    }
  }, [canCompare, panelViewMode]);

  // Auto-trigger structured synthesis generation when results are ready
  const autoTriggeredRunIdsRef = useRef<Set<string>>(new Set());
  
  useEffect(() => {
    // Only trigger once per runId if:
    // 1. We have at least 2 successful results
    // 2. We have a runId (required for caching)
    // 3. Synthesis is not already complete or loading
    // 4. We haven't already triggered it for this runId
    const okResults = results.filter(r => (r.status === "ok" || r.status === "substituted") && getModelText(r).trim().length > 0);
    
    if (
      okResults.length >= 2 &&
      runId &&
      !autoTriggeredRunIdsRef.current.has(runId) &&
      synthesisStatus === "idle" &&
      !preGeneratedSynthesisReport
    ) {
      console.log("[ResultsDisplay] Auto-triggering structured synthesis generation", {
        runId,
        okResultsCount: okResults.length,
        modelIds: okResults.map(r => r.modelId),
      });
      
      autoTriggeredRunIdsRef.current.add(runId);
      
      const resultsPayload = okResults.map((result) => ({
        modelId: result.modelId,
        text: getModelText(result),
        ...(result.status === "substituted" ? {
          substitutedFrom: (result as any).substitutedFrom,
          substitutionReason: (result as any).substitutionReason,
          actualModel: (result as any).actualModel,
          requestedModel: (result as any).requestedModel,
          provider: (result as any).provider,
          status: result.status,
        } : {}),
      }));
      
      // Trigger synthesis generation in background (non-blocking)
      // Import authedFetch helper
      // Note: Only trigger if auth is ready and user exists
      if (authReady && user) {
        import("@/lib/client/authedFetch")
          .then(({ authedFetch }) => {
            return authedFetch("/api/synthesize-panel", {
              user,
              authReady,
              method: "POST",
              body: JSON.stringify({
                runId,
                question,
                results: resultsPayload,
              }),
            });
          })
          .catch((error) => {
            console.error("[ResultsDisplay] Auto-synthesis generation failed:", error);
            // Remove from set so it can retry if needed
            autoTriggeredRunIdsRef.current.delete(runId);
            // Don't show error to user - synthesis can be manually triggered later
          });
      }
    }
  }, [results, runId, synthesisStatus, preGeneratedSynthesisReport, question]);

  const statusStyles: Record<
    string,
    { container: string; label: string }
  > = {
    ok: {
      container: "bg-green-100 text-green-800",
      label: "OK",
    },
    substituted: {
      container: "bg-amber-100 text-amber-800",
      label: "Substituted",
    },
    failed: {
      container: "bg-red-100 text-red-800",
      label: "Failed",
    },
  };

  const renderStatusPill = (status: string) => {
    const styles = statusStyles[status] ?? statusStyles.failed;
    return (
      <span
        className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wide ${styles.container}`}
      >
        {styles.label}
      </span>
    );
  };

  const formatLatency = (latencyMs?: number) => {
    if (typeof latencyMs !== "number" || Number.isNaN(latencyMs)) {
      return null;
    }
    if (latencyMs >= 1000) {
      return `${(latencyMs / 1000).toFixed(1)} s`;
    }
    return `${latencyMs} ms`;
  };

  const isMockResponse = (text?: string | null) =>
    (text || "").toLowerCase().includes("mock response");

  // Separate successful and failed results for different display handling
  const successfulResults = results.filter((r) => r.status === "ok" || r.status === "substituted");
  const failedResults = results.filter((r) => r.status !== "ok" && r.status !== "substituted");

  /**
   * Toggle expansion of a model's raw response
   * 
   * Raw responses are collapsed by default to keep the UI clean.
   * Users can expand to see the full text from each model.
   */
  const toggleExpand = (modelId: ModelId) => {
    const newExpanded = new Set(expandedModels);
    if (newExpanded.has(modelId)) {
      newExpanded.delete(modelId);
    } else {
      newExpanded.add(modelId);
    }
    setExpandedModels(newExpanded);
  };

  /**
   * Core Rule: Single Response Handling
   * 
   * If only 1 model responded successfully, we cannot generate a synthesis.
   * Show a warning banner with options to re-run or add another model.
   * 
   * This enforces the principle that convergence requires multiple perspectives.
   */
  if (successfulResults.length === 1) {
    return (
      <div className="space-y-6">
        <div className="bg-yellow-50 border-2 border-yellow-200 rounded-lg p-6">
          <h3 className="text-lg font-semibold text-yellow-900 mb-2">
            ⚠️ Only One Model Responded
          </h3>
          <p className="text-yellow-800 mb-4">
            Convergence needs at least two models. Please re-run or add another
            model.
          </p>
          <div className="flex gap-3">
            <button
              onClick={onRerun}
              className="px-4 py-2 bg-primary-600 text-white rounded-md hover:bg-primary-700 transition-colors"
            >
              Re-run Same Panel
            </button>
            <button
              onClick={onAddModel}
              className="px-4 py-2 bg-primary-600 text-white rounded-md hover:bg-primary-700 transition-colors"
            >
              Add Another Model + Re-run
            </button>
          </div>
        </div>

        <div className="bg-white rounded-lg border border-gray-200 p-6">
          <h3 className="text-lg font-semibold mb-4">Raw Response</h3>
          {successfulResults.map((result) => {
            return (
              <div key={result.modelId} className="mb-4">
                <h4 className="font-medium text-gray-900 mb-2">
                  {/* Use safe helper so unknown/missing model IDs never crash the UI. */}
                  {getModelDisplayNameSafe(result.modelId)}
                </h4>
                <div className="bg-gray-50 rounded p-4 text-sm text-gray-700 whitespace-pre-wrap">
                  {getModelText(result) || "No response"}
                </div>
              </div>
            );
          })}
        </div>

        {failedResults.length > 0 && (
          <div className="bg-red-50 rounded-lg border border-red-200 p-6">
            <h3 className="text-lg font-semibold text-red-900 mb-2">
              Failed Models
            </h3>
            <ul className="space-y-2">
            {failedResults.map((result) => {
              return (
                <li key={result.modelId} className="text-red-800">
                  {/* Use safe helper so unknown/missing model IDs never crash the UI. */}
                  {getModelDisplayNameSafe(result.modelId)}: {result.status}
                </li>
              );
            })}
            </ul>
          </div>
        )}
      </div>
    );
  }

  // Determine whether we have enough data to render the unified answer.
  // We require at least one successful model result with non-empty rawText.
  // Timeouts/errors should NOT block rendering; they will be shown with badges.
  const okResults =
    results?.filter(
      (r) => (r.status === "ok" || r.status === "substituted") && getModelText(r).trim().length > 0
    ) ?? [];
  
  // Check both synthesizedReport (from consensus engine) and preGeneratedSynthesisReport (from API)
  // The API-generated synthesis report should be used if synthesizedReport is not available
  const unifiedHtml = synthesizedReport?.unifiedAnswer || null;
  const hasUnifiedAnswer = !!unifiedHtml && okResults.length > 0;
  const hasPreGeneratedReport = !!preGeneratedSynthesisReport && okResults.length > 0;

  // Fallback if no usable unified answer yet (check both sources)
  if (!hasUnifiedAnswer && !hasPreGeneratedReport) {
    return (
      <section className="rounded-xl border border-slate-200 bg-white px-6 py-8 text-sm text-slate-600">
        <h3 className="text-sm font-semibold text-slate-900">No unified answer yet</h3>
        <p className="mt-1">
          Run the panel to generate the trust summary, Agreement / Disagreement Map, and panel responses.
        </p>
      </section>
    );
  }

  // Show full results when a synthesized report is available
    return (
      <div className="space-y-6">
        {/* Main Unified Answer section */}
      {/* Heading hierarchy: H2 (Unified Answer) to H3 (Trust Summary) to H3 (Overall Synthesis) to H4s (Areas of Agreement, etc.) */}
        {/* Trust metrics are presented as visual pills for quick scanning.
            The layout uses a two-column approach on desktop to avoid wasted whitespace,
            with headings on the left and metrics on the right. */}
        <div className="bg-white border border-slate-200 shadow-sm rounded-2xl px-6 py-5 md:px-8 md:py-6">
          {/* Header section with title and trust metrics */}
          <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-6 mb-6">
            {/* Left column: Headings */}
            <div className="flex-1">
              {/* Main section title - H2 level */}
              <h2 className="text-2xl md:text-3xl font-semibold text-slate-900 mb-4">Unified Answer</h2>
              {/* Trust Summary subheading - H3 level */}
              <h3 className="text-xl font-semibold text-slate-800">Trust Summary</h3>
            </div>
            
            {/* Right column: Trust metrics as visual pills for quick scanning */}
            <div className="flex gap-3 flex-wrap md:justify-end">
              {(() => {
                // Use top-level analysisReady (moved from IIFE to fix hooks violation)
                
                // Use canonical counts derived from exact same arrays used for rendering
                const strongConsensusCount = trustCounts.strongConsensus;
                const contestedCount = trustCounts.contestedAreas;
                const singleModelCount = trustCounts.singleModelOrUncertain;
                
                // Dev-only validation: Verify counts match rendered cards
                if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
                  console.log("[TrustSummary KPI] Validation:", {
                    strongConsensusCountKPI: strongConsensusCount,
                    contestedCountKPI: contestedCount,
                    singleModelCountKPI: singleModelCount,
                    renderedConsensusCards: consensusClusters.length,
                    renderedContestedCards: contestedClusters.length,
                    renderedSingleModelCards: singleModelClusters.length,
                    countsMatch: 
                      strongConsensusCount === consensusClusters.length &&
                      contestedCount === contestedClusters.length &&
                      singleModelCount === singleModelClusters.length,
                    totalClusters: canonicalClusters.length,
                  });
                }
                
                // Show placeholder if analysis isn't ready yet (prevents showing incorrect counts)
                const displayCount = (count: number) => analysisReady ? count : "—";
                
                return (
                  <>
              {/* Strong Consensus metric pill - use green to match Agreements/Key Findings */}
              <div
                className="inline-flex items-center gap-2.5 px-4 py-2.5 rounded-xl bg-green-50 border border-green-200 shadow-sm"
                aria-label="Strong consensus: claims that all selected models agree on with similar wording and confidence."
              >
                <span className="text-xl">✅</span>
                <div className="flex flex-col leading-tight">
                  <span className="text-xs font-semibold text-green-600 uppercase tracking-wide">Strong consensus</span>
                  <span className={`text-xl font-bold text-green-700 ${!analysisReady ? 'opacity-50' : ''}`}>
                    {displayCount(strongConsensusCount)}
                  </span>
                </div>
              </div>
              
              {/* Contested Areas metric pill - use orange to match Disagreements */}
              <div
                className="inline-flex items-center gap-2.5 px-4 py-2.5 rounded-xl bg-orange-50 border border-orange-200 shadow-sm"
                aria-label="Contested areas: claims where models disagree on facts, mechanisms, or direction of impact."
              >
                <span className="text-xl">⚠️</span>
                <div className="flex flex-col leading-tight">
                  <span className="text-xs font-semibold text-orange-600 uppercase tracking-wide">Contested areas</span>
                  <span className={`text-xl font-bold text-orange-700 ${!analysisReady ? 'opacity-50' : ''}`}>
                    {displayCount(contestedCount)}
                  </span>
                </div>
              </div>
              
              {/* Uncertain Points metric pill */}
              <div
                className="inline-flex items-center gap-2.5 px-4 py-2.5 rounded-xl bg-blue-50 border border-blue-200 shadow-sm"
                aria-label="Single-model / uncertain points: claims mentioned by only one model or backed by weak or mixed evidence."
              >
                <span className="text-xl">💡</span>
                <div className="flex flex-col leading-tight">
                  <span className="text-xs font-semibold text-blue-600 uppercase tracking-wide">Single-model / uncertain points</span>
                  <span className={`text-xl font-bold text-blue-700 ${!analysisReady ? 'opacity-50' : ''}`}>
                    {displayCount(singleModelCount)}
                  </span>
                </div>
              </div>
                  </>
                );
              })()}
            </div>
          </div>
          
          {/* Trust Summary body: render consensus and contested cards */}
          {analysisReady ? (
              (() => {
                const ca = synthesizedReport?.consensusAnalysis;
                const modelCount = results.length;

                // Temporary debug logs (dev-only)
                if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
                  console.log("[TrustSummary] Debug:", {
                    strongConsensusCount: trustItems.strongConsensusItems.length,
                    contestedCount: trustItems.contestedItems.length,
                    uncertainCount: trustItems.uncertainCount,
                    hasConsensusAnalysis: !!ca,
                    hasPreGeneratedReport: !!preGeneratedSynthesisReport,
                    agreementClustersLength: ca?.agreementClusters?.length ?? 0,
                    clustersLength: ca?.clusters?.length ?? 0,
                    keyFindingsLength: preGeneratedSynthesisReport?.keyFindings?.length ?? 0,
                    disagreementsLength: preGeneratedSynthesisReport?.disagreements?.length ?? 0,
                    trustSummaryStrongConsensus: ca?.trustSummary?.strongConsensus,
                    trustSummaryContestedAreas: ca?.trustSummary?.contestedAreas,
                  });
                }

                return (
              <div className="mt-4 space-y-6">
                {/* Summary text - uses same counts as KPI pills */}
                    <p className="text-slate-600 text-sm">
                      This panel compared {modelCount} model{modelCount === 1 ? "" : "s"} and found{" "}
                  <span className="font-semibold">{trustItems.strongConsensusItems.length}</span> strong consensus finding{trustItems.strongConsensusItems.length === 1 ? "" : "s"},{" "}
                  <span className="font-semibold">{trustItems.contestedItems.length}</span> contested area{trustItems.contestedItems.length === 1 ? "" : "s"},{" "}
                  and <span className="font-semibold">{trustItems.uncertainCount}</span> single-model or uncertain points.
                </p>

                {/* Strong Consensus Cards - Collapsible */}
                {trustItems.strongConsensusItems.length > 0 && (
                  <div className="border border-slate-200 rounded-lg overflow-hidden">
                    <button
                      type="button"
                      onClick={() => setExpandedStrongConsensus((prev) => !prev)}
                      className="flex w-full items-center justify-between bg-green-50 border-b border-green-200 px-4 py-3 hover:bg-green-100 transition-colors"
                    >
                      <h4 className="text-base font-semibold text-slate-900">Strong Consensus</h4>
                      <svg
                        className={`h-5 w-5 text-slate-600 transition-transform ${expandedStrongConsensus ? "rotate-180" : ""}`}
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
                    {expandedStrongConsensus && (
                      <div className="p-4 space-y-3">
                        {trustItems.strongConsensusItems.map((item) => (
                          <div
                            key={item.id}
                            className="relative rounded-lg bg-green-50 border border-green-200 p-4"
                          >
                            <div className="absolute left-0 top-0 h-full w-1 rounded-l-lg bg-green-400"></div>
                            <div className="pl-5">
                              <p className="text-green-800 mb-2">{item.text}</p>
                              {item.refs && item.refs.length > 0 && (
                                <ul className="text-sm text-green-700 mb-2 list-disc list-inside">
                                  {item.refs.map((ref: string, refIdx: number) => (
                                    <li key={refIdx}>{ref}</li>
                                  ))}
                                </ul>
                              )}
                              <div className="flex items-center gap-2 mt-2 flex-wrap">
                                <span className="text-xs font-medium text-green-700">
                                  Agreed by {item.models.length} model{item.models.length !== 1 ? "s" : ""}:{" "}
                                </span>
                                <div className="flex flex-wrap gap-1.5">
                                  {item.models.map((modelId: string) => (
                                    <span
                                      key={modelId}
                                      className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-green-100 text-green-800 border border-green-200"
                                    >
                                      {getModelDisplayNameSafe(modelId)}
                                    </span>
                                  ))}
                                </div>
                                {item.confidence && (
                                  <>
                                    <span className="text-xs text-green-600">•</span>
                                    <span className="text-xs text-green-600">{item.confidence} confidence</span>
                                  </>
                                )}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Contested Areas Cards - Collapsible */}
                {trustItems.contestedItems.length > 0 ? (
                  <div className="border border-slate-200 rounded-lg overflow-hidden">
                    <button
                      type="button"
                      onClick={() => setExpandedContestedAreas((prev) => !prev)}
                      className="flex w-full items-center justify-between bg-orange-50 border-b border-orange-200 px-4 py-3 hover:bg-orange-100 transition-colors"
                    >
                      <h4 className="text-base font-semibold text-slate-900">Contested Areas</h4>
                      <svg
                        className={`h-5 w-5 text-slate-600 transition-transform ${expandedContestedAreas ? "rotate-180" : ""}`}
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
                    {expandedContestedAreas && (
                      <div className="p-4 space-y-3">
                        {trustItems.contestedItems.map((item) => (
                          <div
                            key={item.id}
                            className="relative rounded-lg bg-orange-50 border border-orange-200 p-4"
                          >
                            <div className="absolute left-0 top-0 h-full w-1 rounded-l-lg bg-orange-400"></div>
                            <div className="pl-5">
                              <p className="text-orange-800 mb-2">{item.text}</p>
                              <div className="flex items-center gap-2 mt-2 flex-wrap">
                                <span className="text-xs font-medium text-orange-700">
                                  Different perspectives from:{" "}
                                </span>
                                <div className="flex flex-wrap gap-1.5">
                                  {item.models.map((modelId: string) => (
                                    <span
                                      key={modelId}
                                      className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-orange-100 text-orange-800 border border-orange-200"
                                    >
                                      {getModelDisplayNameSafe(modelId)}
                                    </span>
                                  ))}
                                </div>
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                ) : (
                  // Show "No contested areas" message when count is 0
                  (ca?.trustSummary?.contestedAreas === 0 || trustItems.contestedItems.length === 0) && (
                    <div className="bg-slate-50 border border-slate-200 rounded-lg p-4">
                      <p className="text-sm text-slate-600">
                        No contested areas were identified in this run.
                      </p>
                    </div>
                  )
                )}

                {/* Link to Agreement & Disagreement Map */}
                    <p className="text-xs text-slate-500">
                  Use the Agreement &amp; Disagreement Map below to explore the underlying claims by model.
                    </p>
              </div>
                );
              })()
          ) : null}

          {/* Separator between trust summary and synthesis body */}
          <div className="border-t border-slate-100 mt-4 pt-5 space-y-4">
            {/* Cross-reference note: Consensus and disagreements are shown in Trust Summary above */}
            {synthesizedReport?.consensusAnalysis && (
              <div className="mb-4 p-3 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-600">
                <p>
                  <span className="font-medium">Note:</span> Consensus and disagreements are summarized above in{" "}
                  <span className="font-medium text-slate-900">Trust Summary</span>.
                  The sections below provide additional synthesis, bias analysis, and methodology.
                </p>
              </div>
            )}
            {/* Synthesis body content (with trust summary removed from HTML since we display it as visual pills above) */}
            {/* Heading hierarchy: H2 (Unified Answer) → H3 (Trust Summary) → H3 (Overall Synthesis) → H4s (Bias, Open Questions, Methodology, etc.) */}
            <div className="text-[15px] leading-relaxed text-slate-800">
              <CollapsibleUnifiedAnswer 
                html={synthesizedReport?.unifiedAnswer || ""
                  // Remove duplicate "Trust Summary" sections - already shown above as cards
                  // Remove entire Trust Summary section including any "What is uncertain" subsections
                  .replace(/<h[23]>\s*Trust Summary\s*<\/h[23]>[\s\S]*?(?=<h[23]|$)/gi, '')
                  .replace(/<h[234]>\s*What is uncertain[^<]*<\/h[234]>[\s\S]*?(?=<h[234]|$)/gi, '')
                  // Remove any "Overall Synthesis" heading from HTML (we'll add it if needed)
                  // But keep content after it
                  .replace(/<h[23]>\s*Overall Synthesis\s*<\/h[23]>\s*/gi, '')
                  // Remove any residual "Unique or Uncertain Claims" section to avoid duplication
                  .replace(/<h[234]>\s*Unique or Uncertain Claims[^<]*<\/h[234]>[\s\S]*?(?=<h[234]|$)/gi, "")
                  // Convert any remaining "Unified Answer" H2 - but don't add Overall Synthesis heading
                  .replace(/<h2>\s*Unified Answer\s*<\/h2>\s*/gi, '')
                } 
              />
            </div>
          </div>
        </div>

        {/* Agreement / Disagreement Map (accordion, collapsed by default) */}
        <section className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <button
            type="button"
            onClick={() => setIsAgreementMapOpen((v) => !v)}
            className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-slate-50 transition-colors"
            aria-expanded={isAgreementMapOpen}
          >
            <h2 className="text-lg font-semibold text-slate-900">
              Agreement / Disagreement Map
            </h2>
            <svg
              className={`h-5 w-5 text-slate-500 transition-transform ${isAgreementMapOpen ? "rotate-180" : ""}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 9l-7 7-7-7"
              />
            </svg>
          </button>
          <div className={`${isAgreementMapOpen ? "" : "hidden"} border-t border-slate-200 px-4 pb-4 pt-2`}>
            <p className="text-xs text-slate-500 mb-4">
              Orange cards highlight <span className="font-medium">contested areas and disagreements</span>, while green cards show <span className="font-medium">strong consensus</span> points.
            </p>
          <div className="space-y-4">
            {/* Agreement / Disagreement Map now supports any modelId in the analysis output,
                including "grok" and "perplexity". We don't special-case any models.
                We preserve all model IDs present in modelIds arrays (chatgpt, claude, grok, perplexity, etc.)
                so that the Agreement / Disagreement Map supports any number of models.
                Include Perplexity as a full panel member in clustering / agreement analysis. */}
            {(() => {
              // Client-side debug logging to diagnose schema mismatches
              if (typeof window !== "undefined" && process.env.NODE_ENV !== "production") {
                console.log("[ResultsDisplay] synthesizedReport keys:", Object.keys(synthesizedReport || {}));
                console.log("[ResultsDisplay] consensusAnalysis:", synthesizedReport?.consensusAnalysis);
                console.log("[ResultsDisplay] agreementClusters:", synthesizedReport?.consensusAnalysis?.agreementClusters);
                console.log("[ResultsDisplay] clusters:", synthesizedReport?.consensusAnalysis?.clusters);
              }
              
              // Use agreementClusters if available (preferred), otherwise fall back to legacy clusters format
              // agreementClusters already has the correct structure with modelIds array
              // Null guard: ensure consensusAnalysis exists before accessing
              if (!synthesizedReport?.consensusAnalysis) {
                return (
                  <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-6 text-center">
                    <p className="text-sm text-slate-600">
                      No claims were extracted for this run, so there is nothing to map yet.
                    </p>
                    {process.env.NODE_ENV !== "production" && (
                      <p className="mt-2 text-xs text-slate-500">
                        Check claim extraction logs in the console.
                      </p>
                    )}
                  </div>
                );
              }
              // Use canonical clusters (computed once at component level, same source for counts)
              const clusters = canonicalClusters;
              
              // Debug log: Verify agreement clusters include all models (including Grok)
              console.log("[AgreementMap] clusters:", clusters);
              console.log("[AgreementMap] Model IDs across all clusters:", Array.from(new Set(clusters.flatMap((c: any) => c.modelIds || []))));
              
              // Empty state: Show explicit message when no clusters
              if (!clusters || clusters.length === 0) {
                return (
                  <div className="rounded-lg border border-slate-200 bg-slate-50 px-4 py-6 text-center">
                    <p className="text-sm text-slate-600">
                      No claims were extracted for this run, so there is nothing to map yet.
                    </p>
                    {process.env.NODE_ENV !== "production" && (
                      <p className="mt-2 text-xs text-slate-500">
                        Check claim extraction logs in the console.
                      </p>
                    )}
                  </div>
                );
              }
              
              return (clusters || []).map((cluster: any) => {
              const getLabelConfig = (label: string) => {
                switch (label) {
                  case "consensus":
                    return {
                      icon: "✅",
                      text: "Consensus",
                      bgColor: "bg-green-50",
                      borderColor: "border-green-200",
                      textColor: "text-green-800",
                      iconColor: "text-green-700",
                    };
                  case "single":
                    return {
                      icon: "💡",
                      text: "Single-model insight",
                      bgColor: "bg-blue-50",
                      borderColor: "border-blue-100",
                      textColor: "text-blue-800",
                      iconColor: "text-blue-700",
                    };
                  case "disagreement":
                    // TODO: Only show disagreement when we detect actual conflicting claims
                    // For now, this should rarely/never appear since single-model claims are "single"
                    return {
                      icon: "⚠️",
                      text: "Disagreement",
                      bgColor: "bg-orange-50",
                      borderColor: "border-orange-200",
                      textColor: "text-orange-800",
                      iconColor: "text-orange-700",
                    };
                  default:
                    return {
                      icon: "💡",
                      text: "Single-model insight",
                      bgColor: "bg-blue-50",
                      borderColor: "border-blue-100",
                      textColor: "text-blue-800",
                      iconColor: "text-blue-700",
                    };
                }
              };

              // Use canonical classification helper to determine cluster type
              // This ensures the rendering matches the Trust Summary counting logic
              const clusterType = classifyClusterType(cluster);
              const effectiveLabel = clusterType === "contested" ? "disagreement" : 
                                    clusterType === "single" ? "single" : 
                                    clusterType === "consensus" ? "consensus" :
                                    cluster.label || "single"; // Fallback to cluster.label, default to "single"
              
              const config = getLabelConfig(effectiveLabel);
              
              // Check if any claim in this cluster is bias-related
              // Bias-related claims are visually highlighted so users can quickly spot where models
              // may be one-sided, value-laden, or missing perspectives.
              const hasBiasClaim = cluster.claims.some((claim: any) => (claim as any).isBiasRelated === true);
              
              // Arguments / Disagreements section is collapsed by default to reduce noise.
              // Users can expand it when they want to inspect contested points.
              const isDisagreement = effectiveLabel === "disagreement";
              const isExpanded = expandedDisagreementClusters.has(cluster.id);
              const toggleDisagreement = () => {
                setExpandedDisagreementClusters((prev) => {
                  const newSet = new Set(prev);
                  if (newSet.has(cluster.id)) {
                    newSet.delete(cluster.id);
                  } else {
                    newSet.add(cluster.id);
                  }
                  return newSet;
                });
              };

              // For disagreement clusters, render as collapsible
              if (isDisagreement) {
                return (
                  <div
                    key={cluster.id}
                    className={`rounded-xl border shadow-sm overflow-hidden ${
                      hasBiasClaim
                        ? "border-orange-300"
                        : "border-gray-200"
                    }`}
                  >
                    <button
                      type="button"
                      onClick={toggleDisagreement}
                      className={`flex w-full items-center justify-between px-4 py-3 text-left ${config.bgColor} border-b ${config.borderColor} hover:opacity-90 transition-opacity`}
                    >
                      <div className="flex items-center gap-2 font-semibold text-sm">
                        <span className={`text-base ${config.iconColor}`}>
                          {config.icon}
                        </span>
                        <span className={config.textColor}>{config.text}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <div className="flex flex-wrap gap-2">
                          {/* Use the same PanelModelConfig as the Run Panel buttons so colors and labels always match.
                              Always attach the canonical PanelModelId so the frontend can color and label consistently. */}
                          {cluster.modelIds.map((id: string) => {
                            // Ensure we have a valid PanelModelId
                            const modelId = id as PanelModelId;
                            const config = getPanelModelConfig(modelId);
                            return (
                              <span
                                key={`${cluster.id}-${id}`}
                                className={`text-xs font-semibold px-2 py-1 rounded-full ${config.colorClasses}`}
                              >
                                {config.label}
                              </span>
                            );
                          })}
                        </div>
                        <svg
                          className={`h-4 w-4 text-slate-500 transition-transform ${isExpanded ? "rotate-180" : ""}`}
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
                      </div>
                    </button>
                    {isExpanded && (
                      <div className={`px-4 py-3 ${
                        hasBiasClaim
                          ? "bg-orange-50"
                          : "bg-white"
                      }`}>
                        {hasBiasClaim && (
                          <div className="mb-2 inline-flex items-center gap-1 text-xs font-medium text-orange-700">
                            <span className="h-1.5 w-1.5 rounded-full bg-orange-500" />
                            Possible bias / blind spot
                          </div>
                        )}
                        <p className="text-gray-700 text-sm leading-relaxed">
                          {cluster.representativeText || cluster.claims[0]?.text || "No claim text"}
                        </p>
                        {(() => {
                          // Deduplicate claims to remove redundant entries from the same model
                          const uniqueClaims = deduplicateClaims(cluster.claims);
                          return uniqueClaims.length > 1 && (
                            <details className="mt-3">
                              <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-700">
                                View all model wordings ({uniqueClaims.length})
                              </summary>
                              <div className="mt-2 space-y-2 pl-4 border-l-2 border-gray-200">
                                {uniqueClaims.map((claim) => (
                                  <div
                                    key={claim.id || `${claim.modelId}-${claim.text.substring(0, 20)}`}
                                    className={`text-xs ${
                                      (claim as any).isBiasRelated
                                        ? "text-orange-800 bg-orange-50 rounded px-2 py-1"
                                        : "text-gray-600"
                                    }`}
                                  >
                                    <span className="font-semibold text-gray-700">
                                      {/* Use safe helper so unknown/missing model IDs never crash the UI. */}
                                      {getModelDisplayNameSafe(claim.modelId)}:
                                    </span>{" "}
                                    {claim.text}
                                  </div>
                                ))}
                              </div>
                            </details>
                          );
                        })()}
                      </div>
                    )}
                  </div>
                );
              }

              // For consensus and single-model insights, render normally (always expanded)
              return (
                <div
                  key={cluster.id}
                  className={`rounded-xl border shadow-sm overflow-hidden ${
                    hasBiasClaim
                        ? "border-orange-300"
                      : "border-gray-200"
                  }`}
                >
                  <div
                    className={`flex flex-col gap-3 md:flex-row md:items-center md:justify-between px-4 py-3 ${config.bgColor} border-b ${config.borderColor}`}
                  >
                    <div className="flex items-center gap-2 font-semibold text-sm">
                      <span className={`text-base ${config.iconColor}`}>
                        {config.icon}
                      </span>
                      <span className={config.textColor}>{config.text}</span>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {/* Render ALL model chips - no filtering or limiting to specific models
                          This ensures Grok (and any future models) appear when they participate in a cluster */}
                      {/* Use the same PanelModelConfig as the Run Panel buttons so colors and labels always match.
                          Always attach the canonical PanelModelId so the frontend can color and label consistently. */}
                      {cluster.modelIds.map((id: string) => {
                        // Ensure we have a valid PanelModelId
                        const modelId = id as PanelModelId;
                        const config = getPanelModelConfig(modelId);
                        return (
                          <span
                            key={`${cluster.id}-${id}`}
                            className={`text-xs font-semibold px-2 py-1 rounded-full ${config.colorClasses}`}
                          >
                            {config.label}
                      </span>
                        );
                      })}
                    </div>
                  </div>
                  <div className={`px-4 py-3 ${
                    hasBiasClaim
                      ? "bg-orange-50"
                      : "bg-white"
                  }`}>
                    {hasBiasClaim && (
                      <div className="mb-2 inline-flex items-center gap-1 text-xs font-medium text-orange-700">
                        <span className="h-1.5 w-1.5 rounded-full bg-orange-500" />
                        Possible bias / blind spot
                      </div>
                    )}
                    <p className="text-gray-700 text-sm leading-relaxed">
                      {cluster.representativeText || cluster.claims[0]?.text || "No claim text"}
                    </p>
                    {(() => {
                      // Deduplicate claims to remove redundant entries from the same model
                      const uniqueClaims = deduplicateClaims(cluster.claims);
                      return uniqueClaims.length > 1 && (
                        <details className="mt-3">
                          <summary className="text-xs text-gray-500 cursor-pointer hover:text-gray-700">
                            View all model wordings ({uniqueClaims.length})
                          </summary>
                          <div className="mt-2 space-y-2 pl-4 border-l-2 border-gray-200">
                            {uniqueClaims.map((claim) => (
                              <div
                                key={claim.id || `${claim.modelId}-${claim.text.substring(0, 20)}`}
                                className={`text-xs ${
                                  (claim as any).isBiasRelated
                                    ? "text-amber-800 bg-amber-50 rounded px-2 py-1"
                                    : "text-gray-600"
                                }`}
                              >
                                <span className="font-semibold text-gray-700">
                                  {/* Use safe helper so unknown/missing model IDs never crash the UI. */}
                                  {getModelDisplayNameSafe(claim.modelId)}:
                                </span>{" "}
                                {claim.text}
                              </div>
                            ))}
                          </div>
                        </details>
                      );
                    })()}
                  </div>
                </div>
              );
            });
            })()}
          </div>
        </div>
        </section>

        {/* Panel Responses accordion (collapsed by default) */}
        <section className="rounded-xl border border-slate-200 bg-white overflow-hidden">
          <button
            type="button"
            onClick={() => setIsPanelResponsesOpen((v) => !v)}
            className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-slate-50 transition-colors"
            aria-expanded={isPanelResponsesOpen}
          >
            <h2 className="text-lg font-semibold text-slate-900">Panel Responses</h2>
            <svg
              className={`h-5 w-5 text-slate-500 transition-transform ${isPanelResponsesOpen ? "rotate-180" : ""}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
              xmlns="http://www.w3.org/2000/svg"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M19 9l-7 7-7-7"
              />
            </svg>
          </button>
          <div className={`${isPanelResponsesOpen ? "" : "hidden"} border-t border-slate-200`}>
        <div className="bg-white rounded-lg border border-gray-200 px-6 py-5 space-y-5">
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div>
              <h2 className="text-2xl font-bold">Panel Responses</h2>
              <p className="text-sm text-gray-500">
                {panelViewMode === "synthesis" ? (
                  "View a unified synthesis built from all model responses. ConvergePanel highlights consensus, surfaces key disagreements and debates, flags possible bias and blind spots, and calls out single-model insights."
                ) : (
                  "See how each model answered in full. Each response includes structured sections covering summary, key claims, evidence, uncertainties, biases, metrics, methodology, alternative perspectives, gaps, implications, and follow-up questions."
                )}
              </p>
            </div>
            {/* Make the List / Compare view toggle visually prominent so users immediately see
                that they can switch response display modes. */}
            {/* Ensure the List / Compare toggle has enough width so "Compare view" is never clipped. */}
            <div className="inline-flex items-center rounded-full border border-slate-200 bg-white p-1 shadow-sm">
              <button
                type="button"
                onClick={() => setPanelViewMode("list")}
                className={`relative z-10 inline-flex items-center justify-center rounded-full px-4 py-2 text-sm font-semibold tracking-wide transition whitespace-nowrap min-w-[108px] ${
                  panelViewMode === "list"
                    ? "bg-sky-600 text-white shadow-sm"
                    : "text-slate-500 hover:text-slate-900"
                }`}
              >
                List view
              </button>
              <button
                type="button"
                onClick={() => canCompare && setPanelViewMode("compare")}
                className={`relative z-10 inline-flex items-center justify-center rounded-full px-4 py-2 text-sm font-semibold tracking-wide transition whitespace-nowrap min-w-[128px] ${
                  panelViewMode === "compare" && canCompare
                    ? "bg-sky-600 text-white shadow-sm"
                    : "text-slate-500 hover:text-slate-900"
                } ${!canCompare ? "opacity-40 cursor-not-allowed" : ""}`}
                disabled={!canCompare}
              >
                Compare view
              </button>
              <button
                type="button"
                onClick={() => setPanelViewMode("synthesis")}
                className={`relative z-10 inline-flex items-center justify-center rounded-full px-4 py-2 text-sm font-semibold tracking-wide transition whitespace-nowrap min-w-[108px] ${
                  panelViewMode === "synthesis"
                    ? "bg-sky-600 text-white shadow-sm"
                    : "text-slate-500 hover:text-slate-900"
                }`}
              >
                Synthesis
              </button>
            </div>
          </div>
          </div>

          {panelViewMode === "synthesis" ? (
            <PanelSynthesisView
              results={results}
              question={question}
              runId={runId || undefined}
              preGeneratedStatus={synthesisStatus}
              preGeneratedReport={preGeneratedSynthesisReport}
              preGeneratedError={preGeneratedSynthesisError}
              synthesizedReport={synthesizedReport}
            />
          ) : panelViewMode === "compare" && canCompare ? (
            <div className="border-t border-slate-200">
              <button
                type="button"
                onClick={() => setIsCompareViewOpen((v) => !v)}
                className="flex w-full items-center justify-between px-4 py-3 text-left hover:bg-slate-50 transition-colors"
                aria-expanded={isCompareViewOpen}
                aria-controls="compare-view-panel"
              >
                <h3 className="text-lg font-semibold text-slate-900">Compare View</h3>
                <svg
                  className={`h-5 w-5 text-slate-500 transition-transform ${isCompareViewOpen ? "rotate-180" : ""}`}
                  fill="none"
                  stroke="currentColor"
                  viewBox="0 0 24 24"
                  xmlns="http://www.w3.org/2000/svg"
                  aria-hidden="true"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    strokeWidth={2}
                    d="M19 9l-7 7-7-7"
                  />
                </svg>
              </button>
              {!isCompareViewOpen && (
                <div className="px-4 pb-3">
                  <p className="text-xs text-slate-500">Click to compare each model's response.</p>
                </div>
              )}
              <div id="compare-view-panel" className={`${isCompareViewOpen ? "" : "hidden"} px-4 pb-4 pt-2`}>
            <div className="grid grid-cols-1 gap-8 xl:grid-cols-2 xl:gap-10">
              {/* Compare View: Two columns with comfortable text width for side-by-side reading.
                  Each column has min-w-[360px] to ensure readable line lengths, and the grid
                  uses gap-10 for clear separation between model responses. */}
              {/* Show all results in compare view, not just successful ones
                  This ensures every selected model appears, even if it failed
                  IMPORTANT: We intentionally render all models, including failures */}
              {results.map((result) => {
                const status = result.status;
                const latencyLabel = formatLatency(result.latencyMs);
                const mock = isMockResponse(getModelText(result));
                // Check if this result is in the synthesized report (successful response)
                const synthesizedResponse = synthesizedReport?.rawResponses?.find(
                  (r) => r.modelId === result.modelId
                );
                // Use safe text getter for all model text access
                const modelText = getModelText(result);
                const displayText = (status === "failed") 
                  ? (result.errorMessage || modelText || "This model failed to return a response.")
                  : (modelText || "No response provided.");

                const modelConfig = getPanelModelConfig(result.modelId as PanelModelId);

              return (
                <div
                    key={`compare-${result.modelId}`}
                    className="xl:min-w-[360px] rounded-2xl border border-gray-200 shadow-sm bg-white flex flex-col"
                  >
                    <div className="border-b border-gray-100 px-5 py-4 flex flex-col gap-2">
                      <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2">
                          <ModelChip modelId={result.modelId as PanelModelId} variant="outline" size="xs" />
                        </div>
                        <div className="flex items-center gap-3">
                          {renderStatusPill(status)}
                          {latencyLabel && (
                            <span className="text-xs text-gray-500">
                              {latencyLabel}
                            </span>
                          )}
                        </div>
                      </div>
                      {result.status === "substituted" && (
                        <div className="flex items-center gap-1.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-1" title={(result as any).substitutionReason || ""}>
                          <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                          <span>Substituted: DeepSeek</span>
                        </div>
                      )}
                    </div>
                    {/* Increased padding (px-6 py-5) for comfortable reading in Compare View */}
                    {/* Compare View: Full text display without height constraints - allow natural scrolling */}
                    {/* CRITICAL: Remove max-height to ensure full Perplexity responses are visible */}
                    <div className="px-6 py-5 space-y-4">
                      {status === "failed" && (() => {
                        let errorMsg = result.errorMessage || getModelText(result) || "This model failed to return a response.";
                        
                        const sentences = errorMsg.split(/[.!?]\s+/).filter(s => s.trim().length > 0);
                        if (sentences.length >= 2) {
                          const firstSentence = sentences[0].trim();
                          const allSame = sentences.every(s => s.trim() === firstSentence);
                          if (allSame && sentences.length > 1) {
                            errorMsg = firstSentence;
                          } else {
                            const trimmed = errorMsg.trim();
                            const midPoint = Math.floor(trimmed.length / 2);
                            if (midPoint > 10) {
                              const firstPart = trimmed.substring(0, midPoint).trim();
                              const secondPart = trimmed.substring(midPoint).trim();
                              // If second part starts with first part (allowing for punctuation), it's a duplicate
                              if (secondPart.startsWith(firstPart) || 
                                  secondPart.replace(/^[.!?\s]+/, '') === firstPart.replace(/[.!?\s]+$/, '')) {
                                errorMsg = firstPart;
                              }
                            }
                          }
                        }
                        
                        // Clean up error message: remove "Error:" prefix if it's already in the message
                        // This prevents showing "Error: Error: ..." in the UI
                        if (errorMsg.toLowerCase().startsWith("error:")) {
                          errorMsg = errorMsg.substring(6).trim();
                        }
                        
                        return (
                          <div className="space-y-1 text-sm text-rose-700">
                            <div className="font-semibold">This model encountered an error.</div>
                            {errorMsg && (
                              <div className="text-xs">{errorMsg}</div>
                            )}
                          </div>
                        );
                      })()}
                      {mock && (status === "ok" || status === "substituted") && (
                        <div className="flex items-center gap-2 text-sm text-blue-700 bg-blue-50 border border-blue-100 rounded-lg px-3 py-2">
                          <span>ℹ</span>
                          <span>Demo output – no API key configured.</span>
                        </div>
                      )}
                      {(status === "ok" || status === "substituted") && (result as any).wasTruncated && (
                        <div className="flex items-start gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-3">
                          <span className="mt-0.5">⚠️</span>
                          <div>
                            <strong>Response truncated:</strong> This response hit the output token limit and may be cut off mid-sentence. 
                            Consider increasing the output token limit or simplifying the question.
                          </div>
                        </div>
                      )}
                      {/* Only show displayText for successful responses - error messages are shown in the error alert above */}
                      {/* In Compare View, Agreement/Disagreement and Bias sections are always visible
                          (no collapse) so users can compare models side-by-side without extra clicks. */}
                      {/* Show warning for suspiciously short responses (status is ok but errorMessage indicates warning) */}
                      {/* Show warning if response was truncated by API (finish_reason === 'length') */}
                      {(status === "ok" || status === "substituted") && (
                        <>
                          {((result as any)?.wasTruncated || (result as any)?.finishReason === "length") && (
                            <div className="mb-3 px-3 py-2 bg-amber-50 border border-amber-200 rounded text-xs text-amber-800">
                              <strong>Note:</strong> This response was truncated by the model's token limit. Some sections may be missing.
                            </div>
                          )}
                          {/* Show other errorMessage warnings (non-truncation) */}
                          {result.errorMessage && !(result as any).wasTruncated && (result as any)?.finishReason !== "length" && (
                            <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2 mb-3">
                              <strong>Note:</strong> {result.errorMessage}
                            </div>
                          )}
                        </>
                      )}
                      {status !== "failed" && (
                        <div className="space-y-3">
                          <div className="leading-relaxed text-sm text-gray-800">
                            <CollapsibleMarkdown text={displayText} alwaysExpanded={true} />
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {/* Show ALL results (both successful and failed) to ensure no model is silently missing
                  This ensures every selected model appears in the UI, either with OK status or Error status
                  IMPORTANT: We intentionally render all models, including failures, so users can see
                  which models succeeded and which failed, rather than having models silently disappear */}
              {results.map((result) => {
                const isExpanded = expandedModels.has(result.modelId);
                const status = result.status;
                const latencyLabel = formatLatency(result.latencyMs);
                const mock = isMockResponse(getModelText(result));
                // Check if this result is in the synthesized report (successful response)
                const synthesizedResponse = synthesizedReport?.rawResponses?.find(
                  (r) => r.modelId === result.modelId
                );
                // Use safe text getter for all model text access
                const modelText = getModelText(result);
                const displayText = (status === "failed") 
                  ? (result.errorMessage || modelText || "This model failed to return a response.")
                  : (modelText || "No response provided.");

                const modelConfig = getPanelModelConfig(result.modelId as PanelModelId);

                return (
                  <div
                    key={result.modelId}
                    className="rounded-2xl border border-gray-200 shadow-sm overflow-hidden bg-white transition-shadow hover:shadow-md"
                  >
                    <button
                      onClick={() => toggleExpand(result.modelId)}
                      className="w-full px-6 py-5 flex flex-col gap-2 text-left bg-gray-50 hover:bg-gray-100 transition-colors"
                    >
                      <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between w-full">
                        <div className="flex items-center gap-3">
                          <ModelChip modelId={result.modelId as PanelModelId} variant="outline" size="xs" />
                        </div>
                        <div className="flex items-center gap-3 text-sm">
                          {renderStatusPill(status)}
                          {latencyLabel && (
                            <span className="text-xs text-gray-500">
                              {latencyLabel}
                            </span>
                          )}
                          <span className="text-gray-500 md:ml-2">
                            {status === "ok" || status === "substituted"
                              ? (isExpanded ? "Hide answer ▲" : "Show answer ▼")
                              : (isExpanded ? "Hide error ▲" : "Show error ▼")
                            }
                          </span>
                        </div>
                      </div>
                      {result.status === "substituted" && (
                        <div className="flex items-center gap-1.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-2.5 py-1" title={(result as any).substitutionReason || ""}>
                          <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                          <span>Substituted: DeepSeek</span>
                        </div>
                      )}
                  </button>
                  {isExpanded && (
                      <div className="px-6 py-5 space-y-4 bg-white border-t border-gray-100 max-h-[600px] overflow-y-auto overflow-x-hidden">
                        {status === "failed" && (() => {
                          let errorMsg = result.errorMessage || getModelText(result) || "This model failed to return a response.";
                          
                          // Remove duplicate text if the entire message is repeated (e.g., "X. X.")
                          // Split by sentence boundaries and check for repetition
                          const sentences = errorMsg.split(/[.!?]\s+/).filter(s => s.trim().length > 0);
                          if (sentences.length >= 2) {
                            // Check if the message is just the same sentence repeated
                            const firstSentence = sentences[0].trim();
                            const allSame = sentences.every(s => s.trim() === firstSentence);
                            if (allSame && sentences.length > 1) {
                              errorMsg = firstSentence;
                            } else {
                              // Check if the message is the same text repeated twice
                              const trimmed = errorMsg.trim();
                              const midPoint = Math.floor(trimmed.length / 2);
                              if (midPoint > 10) {
                                const firstPart = trimmed.substring(0, midPoint).trim();
                                const secondPart = trimmed.substring(midPoint).trim();
                                // If second part starts with first part (allowing for punctuation), it's a duplicate
                                if (secondPart.startsWith(firstPart) || 
                                    secondPart.replace(/^[.!?\s]+/, '') === firstPart.replace(/[.!?\s]+$/, '')) {
                                  errorMsg = firstPart;
                                }
                              }
                            }
                          }
                          
                          // Clean up error message: remove "Error:" prefix if it's already in the message
                          // This prevents showing "Error: Error: ..." in the UI
                          if (errorMsg.toLowerCase().startsWith("error:")) {
                            errorMsg = errorMsg.substring(6).trim();
                          }
                          
                          return (
                            <div className="space-y-2 text-sm text-rose-700">
                              <div className="font-semibold">This model encountered an error.</div>
                              {/* Display the real error message from API so users can see what went wrong */}
                              {errorMsg && (
                                <div className="text-sm font-mono bg-rose-50 border border-rose-200 rounded px-3 py-2">
                                  {errorMsg}
                                </div>
                              )}
                            </div>
                          );
                        })()}
                        {mock && (status === "ok" || status === "substituted") && (
                          <div className="flex items-center gap-2 text-sm text-blue-700 bg-blue-50 border border-blue-100 rounded-lg px-3 py-2">
                            <span>ℹ</span>
                            <span>Demo output – no API key configured.</span>
                          </div>
                        )}
                        {(status === "ok" || status === "substituted") && (result as any).wasTruncated && (
                          <div className="flex items-start gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mb-3">
                            <span className="mt-0.5">⚠️</span>
                      <div>
                              <strong>Response truncated:</strong> This response hit the output token limit and may be cut off mid-sentence. 
                              Consider increasing the output token limit or simplifying the question.
                        </div>
                      </div>
                        )}
                        {/* Show warning for suspiciously short responses (status is ok but errorMessage indicates warning) */}
                        {(status === "ok" || status === "substituted") && result.errorMessage && !(result as any).wasTruncated && (
                          <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded px-3 py-2 mb-3">
                            <strong>Note:</strong> {result.errorMessage}
                          </div>
                        )}
                        {status !== "failed" && (
                          <div className="space-y-3">
                            <div className="leading-relaxed text-sm text-gray-800">
                                <CollapsibleMarkdown text={displayText} />
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
        </div>
      </section>
    </div>
  );
}
