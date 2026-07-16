import type { Metadata } from "next";
import Link from "next/link";
import { PAGES } from "@/lib/pseo/pages";

export const metadata: Metadata = {
  title: "AI Verification Use Cases | ConvergePanel",
  description:
    "Explore how creators, journalists, researchers, analysts, and teams use ConvergePanel to verify claims, fact-check AI answers, review video, build audit trails, and compare AI models.",
  alternates: { canonical: "https://convergepanel.com/use-cases" },
};

interface HubGroup {
  id: string;
  label: string;
  description: string;
  tailwindText: string;
  tailwindBg: string;
  tailwindBorder: string;
  slugs: string[];
}

const HUB_GROUPS: HubGroup[] = [
  {
    id: "claim-verification",
    label: "Claim Verification",
    description: "Verify specific claims, quotes, and statistics across five AI models before publishing or acting.",
    tailwindText: "text-blue-600",
    tailwindBg: "bg-cp-raised",
    tailwindBorder: "border-cp-border",
    slugs: [
      "ai-claim-verification",
      "verify-ai-content-now",
      "ai-claim-verification-for-content-creators",
      "claim-verification-for-journalists",
      "claim-verification-for-researchers",
      "claim-verification-for-analysts",
      "ai-claim-verification-for-finance-teams",
      "ai-claim-verification-for-policy-teams",
      "ai-claim-verification-for-founders",
      "ai-claim-verification-for-newsrooms",
      "ai-claim-verification-for-educators",
      "ai-claim-verification-for-investigators",
      "ai-claim-verification-for-knowledge-workers",
      "how-to-verify-a-viral-claim-with-ai",
      "how-to-verify-a-viral-claim-before-sharing-it",
      "how-to-verify-a-viral-health-claim",
      "how-to-verify-a-viral-finance-claim",
      "how-to-verify-a-viral-political-claim",
      "how-to-verify-a-viral-ai-claim",
      "how-to-verify-a-viral-climate-claim",
    ],
  },
  {
    id: "ai-answer-verification",
    label: "AI Answer Verification",
    description: "Fact-check ChatGPT and other AI outputs for hallucinations, weak sources, missing context, and blind spots.",
    tailwindText: "text-indigo-600",
    tailwindBg: "bg-cp-raised",
    tailwindBorder: "border-cp-border",
    slugs: [
      "how-to-fact-check-chatgpt-responses",
      "how-to-pressure-test-an-ai-response",
      "how-to-verify-sources-from-ai-answers",
      "how-to-identify-blind-spots-in-ai-answers",
      "how-to-check-if-chatgpt-is-wrong",
      "how-to-verify-an-ai-answer",
      "how-to-check-if-ai-hallucinated",
      "how-to-check-if-ai-research-is-biased",
      "how-to-validate-ai-generated-research",
      "how-to-check-if-ai-missed-important-context",
      "why-not-trust-one-ai-model-for-serious-decisions",
      "single-model-vs-multi-model-verification",
      "single-ai-model-vs-multi-model-verification",
      "ai-search-vs-ai-verification",
      "ai-fact-checking-vs-claim-verification",
    ],
  },
  {
    id: "consensus-disagreement",
    label: "Consensus & Disagreement",
    description: "Compare model agreement, surface disagreement, and understand what AI splits mean for your decisions.",
    tailwindText: "text-rose-600",
    tailwindBg: "bg-cp-raised",
    tailwindBorder: "border-cp-border",
    slugs: [
      "what-is-a-consensus-score",
      "ai-disagreement-analysis-tool",
      "ai-model-consensus-tool",
      "ai-second-opinion-tool",
      "multi-model-decision-support-tool",
      "how-to-compare-ai-model-outputs-side-by-side",
      "ai-expert-panel-tool",
      "multi-llm-answer-comparison",
      "best-multi-model-ai-tool-for-research",
      "ask-multiple-ai-models-one-question",
      "how-to-compare-ai-answers-before-deciding",
    ],
  },
  {
    id: "video-verification",
    label: "Video Verification",
    description: "Review suspicious or viral videos with three vision models. Surface manipulation signals, compare model assessments, and produce an advisory review record before acting on or publishing a clip.",
    tailwindText: "text-violet-600",
    tailwindBg: "bg-cp-raised",
    tailwindBorder: "border-cp-border",
    slugs: [
      "ai-video-verification",
      "video-authenticity-review-for-fact-checkers",
      "video-authenticity-review-for-researchers",
      "ai-video-review-for-media-teams",
      "ai-video-verification-for-journalists",
      "how-to-review-a-suspicious-video-with-ai",
      "how-to-check-if-a-viral-video-might-be-manipulated",
      "how-to-sanity-check-a-viral-clip",
      "how-to-verify-a-clip-before-publishing",
      "how-journalists-can-verify-viral-clips",
      "ai-video-verification-checklist",
    ],
  },
  {
    id: "governance-audit-trails",
    label: "AI Audit Trails & Governance",
    description: "Workflows for reviewing AI-assisted decisions, identifying risk signals, documenting disagreement, and creating audit trails or decision receipts for high-stakes work.",
    tailwindText: "text-amber-600",
    tailwindBg: "bg-cp-raised",
    tailwindBorder: "border-cp-border",
    slugs: [
      "how-to-create-an-ai-audit-trail",
      "ai-audit-trail-software",
      "ai-decision-audit-trail",
      "how-to-prove-an-ai-decision-was-reviewed",
      "ai-governance-workflow-for-enterprise-teams",
      "ai-governance-for-small-teams",
      "ai-peer-review-for-high-stakes-workflows",
      "ai-accountability-workflow",
      "ai-review-process-for-teams",
      "how-to-document-an-ai-assisted-research-decision",
      "how-to-document-model-disagreement",
      "how-to-track-ai-decision-making",
      "ai-risk-review-tool",
      "how-to-review-ai-generated-recommendations",
      "how-to-check-if-a-decision-is-based-on-weak-information",
      "how-to-identify-risks-before-deciding",
    ],
  },
  {
    id: "decision-receipts",
    label: "Decision Receipts & Trust",
    description: "Document AI-assisted decisions with structured receipts, confidence scores, and evidence records.",
    tailwindText: "text-teal-600",
    tailwindBg: "bg-cp-raised",
    tailwindBorder: "border-cp-border",
    slugs: [
      "what-is-a-decision-receipt",
      "what-is-a-verification-gate",
      "what-is-a-panel-verdict",
      "what-is-source-grounding-in-ai",
      "ai-trust-dashboard-for-decision-support",
      "why-teams-need-to-slow-down-ai-decisions",
    ],
  },
  {
    id: "creator-workflows",
    label: "Creator Workflows",
    description: "Fact-checking and source verification for YouTubers, podcasters, and content teams before publishing.",
    tailwindText: "text-pink-600",
    tailwindBg: "bg-cp-raised",
    tailwindBorder: "border-cp-border",
    slugs: [
      "ai-claim-verification-for-content-creators",
      "how-creators-can-fact-check-videos",
      "how-to-verify-information-for-a-video-script",
      "ai-research-tool-for-youtubers",
      "how-to-fact-check-a-reaction-video",
      "how-to-check-sources-for-creator-content",
      "ai-video-verification-for-content-creators",
      "how-to-sanity-check-a-viral-clip",
    ],
  },
  {
    id: "journalist-workflows",
    label: "Journalist & Newsroom Workflows",
    description: "Verification workflows built for newsrooms, deadlines, editorial standards, and accountability.",
    tailwindText: "text-sky-600",
    tailwindBg: "bg-cp-raised",
    tailwindBorder: "border-cp-border",
    slugs: [
      "newsroom-ai-verification-workflow",
      "verification-checklist-for-journalists",
      "ai-tools-for-investigative-journalists",
      "how-to-fact-check-breaking-news-claims",
      "how-to-verify-user-generated-content",
      "how-to-verify-public-statements-quickly",
    ],
  },
  {
    id: "founder-decision-support",
    label: "Founder & Decision Support",
    description: "Pressure-test business assumptions, pitch claims, and market research with multi-model AI.",
    tailwindText: "text-orange-600",
    tailwindBg: "bg-cp-raised",
    tailwindBorder: "border-cp-border",
    slugs: [
      "how-to-validate-a-business-idea-with-ai",
      "how-to-pressure-test-a-startup-idea",
      "how-to-test-business-assumptions-with-ai",
      "how-to-pressure-test-investor-pitch-claims",
      "how-to-validate-market-assumptions",
      "how-to-get-multiple-ai-perspectives-on-a-startup-idea",
      "ai-decision-support-for-founders",
      "ai-research-for-decision-making-teams",
    ],
  },
  {
    id: "research-quality",
    label: "Deep Research & Verification",
    description: "Run multi-model research, verify claims and sources, surface disagreement, and produce a documented synthesis. Generate and verify in one workflow — not two separate tools.",
    tailwindText: "text-emerald-600",
    tailwindBg: "bg-cp-raised",
    tailwindBorder: "border-cp-border",
    slugs: [
      "deep-research-and-ai-verification",
      "deep-research-with-multiple-ai-models",
      "how-to-compare-chatgpt-claude-gemini-grok-perplexity-for-research",
      "chatgpt-vs-claude-vs-gemini-for-research",
      "ai-summarizer-vs-multi-model-research-panel",
      "perplexity-vs-multi-model-panel-for-research",
      "how-to-compare-ai-answers-before-deciding",
      "multi-model-decision-support-tool",
    ],
  },
  {
    id: "competitive-intelligence",
    label: "Competitive Intelligence",
    description: "Verify competitor claims, pressure-test market research, compare trend analysis, and review pricing intelligence across AI models.",
    tailwindText: "text-cyan-600",
    tailwindBg: "bg-cp-raised",
    tailwindBorder: "border-cp-border",
    slugs: [
      "ai-verification-for-competitive-intelligence",
      "how-to-verify-competitor-claims-with-ai",
      "market-research-with-multiple-ai-models",
      "ai-consensus-for-competitive-intelligence",
      "compare-market-trends-across-ai-models",
      "should-analysts-trust-one-ai-model",
      "multi-model-research-for-market-sizing",
      "competitor-pricing-claim-check-with-ai",
    ],
  },
  {
    id: "procurement-vendor-due-diligence",
    label: "Procurement & Vendor Due Diligence",
    description: "Verify vendor claims, certifications, and capabilities using multiple AI models before committing to contracts or software purchases.",
    tailwindText: "text-yellow-600",
    tailwindBg: "bg-cp-raised",
    tailwindBorder: "border-cp-border",
    slugs: [
      "ai-vendor-due-diligence-with-multiple-models",
      "verify-vendor-claims-with-ai-consensus",
      "multi-model-research-for-software-procurement",
      "vendor-risk-review-checklist-using-ai",
      "procurement-risk-assessment-with-ai-models",
      "compare-vendor-security-claims-with-ai",
      "how-to-verify-saas-vendor-features-with-ai",
      "ai-due-diligence-for-technology-purchases",
      "consensus-scoring-for-vendor-evaluation",
      "should-procurement-teams-trust-one-ai-answer",
    ],
  },
  {
    id: "compliance-risk-operations",
    label: "Compliance & Risk Operations",
    description: "Review compliance claims, interpret policies, and check regulatory evidence using multiple AI models before expert sign-off.",
    tailwindText: "text-red-600",
    tailwindBg: "bg-cp-raised",
    tailwindBorder: "border-cp-border",
    slugs: [
      "compliance-claim-verification-with-ai",
      "multi-model-ai-for-policy-interpretation",
      "compliance-evidence-checking-with-multiple-ai",
      "regulated-workflow-ai-verification-tools",
      "risk-ops-research-panel-for-regulated-teams",
      "ai-consensus-for-risk-assessments",
      "policy-exception-review-with-ai-models",
      "trustworthy-ai-for-compliance-operations",
      "should-compliance-teams-trust-one-llm",
    ],
  },
  {
    id: "internal-audit-controls",
    label: "Internal Audit & Controls",
    description: "Accelerate audit research, review control narratives, and check evidence sufficiency using multiple AI models.",
    tailwindText: "text-lime-600",
    tailwindBg: "bg-cp-raised",
    tailwindBorder: "border-cp-border",
    slugs: [
      "internal-audit-ai-research-assistant",
      "audit-evidence-review-with-ai-models",
      "verify-control-narratives-with-ai",
      "should-auditors-use-one-ai-model",
      "multi-model-consensus-for-audit-planning",
      "ai-panel-for-internal-controls-testing",
      "control-exception-analysis-with-ai-consensus",
      "audit-walkthrough-documentation-with-ai",
      "trustworthy-ai-for-audit-teams",
      "research-panel-for-assurance-workflows",
    ],
  },
  {
    id: "cybersecurity-threat-intelligence",
    label: "Cybersecurity & Threat Intelligence",
    description: "Review cyber threat claims, fact-check threat reports, and validate security advisories using multiple AI models.",
    tailwindText: "text-fuchsia-600",
    tailwindBg: "bg-cp-raised",
    tailwindBorder: "border-cp-border",
    slugs: [
      "verify-cyber-threat-claims-with-ai",
      "multi-model-research-for-threat-intelligence",
      "threat-report-fact-checking-with-ai-models",
      "security-advisory-validation-using-ai",
      "ai-consensus-for-security-incident-analysis",
      "should-security-teams-trust-one-ai-answer",
      "malware-report-analysis-with-multiple-ai-models",
      "phishing-report-verification-with-ai",
      "trustworthy-ai-for-soc-teams",
      "incident-response-research-panel",
    ],
  },
  {
    id: "product-management-roadmap",
    label: "Product Management & Roadmap",
    description: "Verify product requirements, check user feedback themes, and pressure-test roadmap prioritization with multi-model AI.",
    tailwindText: "text-purple-600",
    tailwindBg: "bg-cp-raised",
    tailwindBorder: "border-cp-border",
    slugs: [
      "product-requirement-verification-with-ai",
      "verify-user-feedback-themes-with-multiple-ai-models",
      "ai-consensus-for-roadmap-prioritization",
      "product-discovery-research-with-ai-panel",
      "multi-model-research-for-product-strategy",
      "product-assumptions-check-with-ai",
      "should-product-managers-trust-one-ai-answer",
      "validate-feature-ideas-with-ai-models",
      "trustworthy-ai-for-product-teams",
      "research-panel-for-roadmap-decisions",
    ],
  },
  {
    id: "customer-support-knowledge-base",
    label: "Customer Support & Knowledge Base",
    description: "Verify help center answers, audit knowledge base articles, and fact-check support content for accuracy using multiple AI models.",
    tailwindText: "text-green-600",
    tailwindBg: "bg-cp-raised",
    tailwindBorder: "border-cp-border",
    slugs: [
      "verify-help-center-answers-with-ai",
      "knowledge-base-validation-tool-with-ai",
      "support-article-fact-check-with-multiple-ai-models",
      "verify-troubleshooting-steps-with-ai",
      "multi-model-support-response-checker",
      "ai-consensus-for-knowledge-base-accuracy",
      "should-support-teams-trust-one-ai-model",
      "customer-service-script-verification-with-ai",
      "trustworthy-ai-for-support-operations",
      "ai-research-panel-for-escalation-handling",
    ],
  },
  {
    id: "sales-enablement-account-research",
    label: "Sales Enablement & Account Research",
    description: "Fact-check battlecards, verify account research, and pressure-test competitive claims before they reach a prospect.",
    tailwindText: "text-rose-600",
    tailwindBg: "bg-cp-raised",
    tailwindBorder: "border-cp-border",
    slugs: [
      "verify-account-research-with-ai",
      "sales-battlecard-fact-check-with-ai",
      "multi-model-research-for-sales-prospecting",
      "ai-consensus-for-sales-call-prep",
      "prospect-claim-verification-with-ai",
      "should-sales-teams-trust-one-ai-answer",
      "account-intelligence-validation-with-multiple-ai-models",
      "trustworthy-ai-for-revenue-teams",
      "research-panel-for-account-planning",
      "verify-company-background-with-ai-models",
    ],
  },
  {
    id: "finance-operations-fpa",
    label: "Finance Operations & FP&A",
    description: "Verify financial model assumptions and review finance memo claims using multi-model AI research.",
    tailwindText: "text-amber-600",
    tailwindBg: "bg-cp-raised",
    tailwindBorder: "border-cp-border",
    slugs: [
      "verify-financial-assumptions-with-ai",
      "finance-memo-review-with-ai-consensus",
      "finance-ops-research-with-multiple-ai-models",
      "ai-consensus-for-budgeting-decisions",
      "should-finance-teams-trust-one-ai-model",
      "forecast-narrative-verification-with-ai",
      "trustworthy-ai-for-fpa-teams",
      "investor-update-fact-check-with-ai-models",
      "financial-analysis-validation-with-ai",
    ],
  },
  {
    id: "public-sector-policy",
    label: "Public Sector & Policy",
    description: "Verify public statements, official claims, and policy positions using multiple AI models before publishing or acting.",
    tailwindText: "text-stone-600",
    tailwindBg: "bg-cp-raised",
    tailwindBorder: "border-cp-border",
    slugs: [
      "verify-public-statements-with-ai-models",
    ],
  },
  {
    id: "expert-knowledge-workflows",
    label: "Expert Knowledge Workflows",
    description: "Use ConvergePanel to compare expert-level AI responses, pressure-test complex explanations, synthesize multiple perspectives, and document review paths for serious knowledge work.",
    tailwindText: "text-indigo-600",
    tailwindBg: "bg-cp-raised",
    tailwindBorder: "border-cp-border",
    slugs: [
      "multi-model-research-for-complex-decisions",
      "trustworthy-ai-for-analysts-and-consultants",
      "deep-research-panel-for-technical-questions",
      "compare-expert-interpretations-across-ai-models",
      "research-synthesis-for-knowledge-workers",
      "validate-complex-explanations-with-ai",
      "panel-based-research-for-decision-support",
    ],
  },
  {
    id: "government-public-sector-research",
    label: "Government & Public Sector Research",
    description: "Use ConvergePanel to review policy claims, public program information, agency research, civic workflows, and government analysis with multiple AI models and documented review.",
    tailwindText: "text-slate-600",
    tailwindBg: "bg-cp-raised",
    tailwindBorder: "border-cp-border",
    slugs: [
      "public-sector-research-with-multiple-ai-models",
      "verify-policy-claims-with-ai-models",
      "ai-consensus-for-government-analysis",
      "should-public-sector-teams-trust-one-ai-answer",
      "trustworthy-ai-for-civic-workflows",
      "multi-model-research-for-agency-decisions",
      "public-program-fact-checking-with-ai",
      "administrative-research-panel-for-government",
    ],
  },
  {
    id: "higher-ed-administration",
    label: "Higher Ed Administration & Academic Operations",
    description: "Use ConvergePanel to review university policy summaries, program information, student services research, and administrative knowledge before publishing or relying on it.",
    tailwindText: "text-sky-600",
    tailwindBg: "bg-cp-raised",
    tailwindBorder: "border-cp-border",
    slugs: [
      "university-admin-research-with-ai-models",
      "verify-policy-summaries-with-multiple-ai-models",
      "campus-policy-explanation-with-ai-verification",
      "verify-program-information-with-ai-models",
      "education-administration-knowledge-validation",
      "should-administrators-trust-one-ai-answer",
      "multi-model-research-for-student-services",
    ],
  },
  {
    id: "supply-chain-operations-planning",
    label: "Supply Chain & Operations Planning",
    description: "Use ConvergePanel to review logistics claims, operational assumptions, supply chain research, shipping risks, and planning decisions with multiple AI models.",
    tailwindText: "text-orange-600",
    tailwindBg: "bg-cp-raised",
    tailwindBorder: "border-cp-border",
    slugs: [
      "supply-chain-research-with-multiple-ai-models",
      "verify-logistics-claims-with-ai",
      "ai-consensus-for-operations-planning",
      "vendor-and-shipping-risk-analysis-with-ai",
      "operational-assumptions-check-with-ai",
      "logistics-planning-verification-with-ai-models",
      "should-ops-teams-trust-one-ai-model",
      "multi-model-research-for-inventory-decisions",
    ],
  },
  {
    id: "translation-localization-content-qa",
    label: "Translation, Localization & Content QA",
    description: "Use ConvergePanel to compare multilingual content, translation quality, cultural context, and localization risks across multiple AI models.",
    tailwindText: "text-teal-600",
    tailwindBg: "bg-cp-raised",
    tailwindBorder: "border-cp-border",
    slugs: [
      "verify-translated-content-with-ai-models",
      "multi-model-language-quality-review",
      "product-copy-verification-across-languages",
      "multilingual-content-review-with-ai-panel",
      "ai-consensus-for-localization-qa",
    ],
  },
  {
    id: "legal-operations-contract-review",
    label: "Legal Operations & Contract Review",
    description:
      "Use ConvergePanel to compare how multiple AI models summarize contracts, explain clauses, and research matter background, so legal teams can spot disagreement before relying on a single answer. ConvergePanel does not provide legal advice.",
    tailwindText: "text-indigo-600",
    tailwindBg: "bg-cp-raised",
    tailwindBorder: "border-cp-border",
    slugs: [
      "legal-ops-research-with-multiple-ai-models",
      "verify-contract-summary-claims-with-ai",
      "ai-consensus-for-clause-explanation",
      "should-legal-teams-trust-one-ai-model",
      "legal-intake-research-panel",
      "matter-background-research-with-ai",
      "multi-model-review-for-legal-ops-workflows",
      "legal-document-grounding-with-ai",
    ],
  },
  {
    id: "insurance-claims-document-review",
    label: "Insurance & Claims Document Review",
    description:
      "Use ConvergePanel to compare how multiple AI models read claims and policy documents, so insurance teams can flag disagreement for human review. ConvergePanel does not make coverage or claims decisions.",
    tailwindText: "text-rose-600",
    tailwindBg: "bg-cp-raised",
    tailwindBorder: "border-cp-border",
    slugs: [
      "claims-document-grounding-with-ai",
      "insurance-policy-research-with-ai",
    ],
  },
  {
    id: "trust-disagreement-review",
    label: "AI Trust, Disagreement & Human Review",
    description:
      "Explore what model agreement, disagreement, weak sources, hidden assumptions, and human review reveal about whether an AI answer can be trusted.",
    tailwindText: "text-sky-600",
    tailwindBg: "bg-cp-raised",
    tailwindBorder: "border-cp-border",
    slugs: [
      "when-ai-models-agree-but-are-wrong",
      "what-ai-disagreement-reveals-about-risk",
      "ai-confidence-vs-evidence",
      "when-ai-models-cite-the-same-weak-source",
      "find-the-weakest-claim-in-an-ai-answer",
      "turn-ai-disagreement-into-a-research-plan",
      "build-a-defensible-answer-from-conflicting-ai-outputs",
      "find-hidden-assumptions-in-ai-answers",
      "does-the-video-prove-the-caption",
      "when-video-verification-models-disagree",
    ],
  },
  {
    id: "journalist-verification-cluster",
    label: "AI Verification for Journalists & Fact-Checkers",
    description:
      "Review AI-generated claims, quotes, timelines, sources, summaries, and allegations before publication — and document why the newsroom accepted or rejected them.",
    tailwindText: "text-rose-600",
    tailwindBg: "bg-cp-raised",
    tailwindBorder: "border-cp-border",
    slugs: [
      "ai-source-laundering",
      "ai-context-collapse",
      "ai-quote-verification",
      "ai-timeline-verification",
      "ai-correction-check",
      "check-if-ai-merged-two-events",
      "verify-names-dates-locations-in-ai-summary",
      "audit-ai-summary-against-original-document",
      "verify-ai-generated-allegation-before-publication",
      "document-why-newsroom-rejected-ai-claim",
    ],
  },
  {
    id: "enterprise-ai-assurance-review",
    label: "Enterprise AI Assurance and Review",
    description:
      "Evaluate whether AI-assisted conclusions were supported by sufficient evidence, meaningfully challenged, independently reviewed, and appropriately approved.",
    tailwindText: "text-blue-600",
    tailwindBg: "bg-cp-raised",
    tailwindBorder: "border-cp-border",
    slugs: [
      "ai-evidence-sufficiency",
      "ai-decision-defensibility",
      "ai-challenge-record",
      "ai-reviewer-independence",
      "ai-approval-drift",
      "document-ai-human-reviewer-disagreement",
      "test-ai-approval-control-effectiveness",
      "review-ai-evidence-before-approval",
      "ai-override-documentation",
      "create-ai-decision-assurance-record",
    ],
  },
  {
    id: "high-stakes-research-verification",
    label: "High-Stakes Research Verification",
    description:
      "Review the assumptions, evidence, source quality, omissions, and conflicting interpretations behind AI-generated financial and scientific research.",
    tailwindText: "text-emerald-600",
    tailwindBg: "bg-cp-raised",
    tailwindBorder: "border-cp-border",
    slugs: [
      "ai-thesis-fragility",
      "ai-downside-omission",
      "ai-comparable-company-mismatch",
      "ai-valuation-assumption-check",
      "check-if-ai-mixed-gaap-and-non-gaap-metrics",
      "verify-ai-interpretation-of-management-guidance",
      "check-if-ai-ignored-liquidity-risk",
      "validate-ai-generated-scenario-analysis",
      "ai-clinical-evidence-hierarchy",
      "ai-endpoint-interpretation",
      "check-if-ai-generalized-animal-research-to-humans",
      "verify-ai-summary-of-clinical-trial-results",
      "check-if-ai-ignored-adverse-events",
      "check-if-ai-treated-preprint-as-peer-reviewed",
      "verify-ai-synthesis-of-conflicting-studies",
      "ai-literature-coverage-gap",
      "ai-related-party-blind-spot",
      "check-if-ai-confused-parent-company-with-subsidiary",
    ],
  },
  {
    id: "editorial-judgment-evidence-review",
    label: "AI Editorial Judgment & Evidence Review",
    description:
      "Review how AI changes certainty, framing, source selection, statistics, and causal claims — and how to document what's still unresolved before you publish.",
    tailwindText: "text-amber-600",
    tailwindBg: "bg-cp-raised",
    tailwindBorder: "border-cp-border",
    slugs: [
      "ai-claim-drift",
      "check-if-ai-turned-speculation-into-fact",
      "ai-false-balance",
      "compare-ai-framing-of-the-same-story",
      "check-if-ai-cherry-picked-sources",
      "verify-statistics-generated-by-ai",
      "check-if-ai-confused-correlation-with-causation",
      "check-if-ai-used-wrong-document-version",
      "document-unresolved-facts-before-publication",
    ],
  },
];

export default function UseCasesIndex() {
  const pageMap = new Map(PAGES.map((p) => [p.slug, p]));

  const groups = HUB_GROUPS.map((group) => ({
    ...group,
    pages: group.slugs
      .map((slug) => pageMap.get(slug))
      .filter((p): p is NonNullable<typeof p> => p !== undefined),
  }));

  return (
    <main className="mx-auto max-w-4xl px-4 py-12 sm:px-6 lg:py-16">
      {/* Header */}
      <div className="mb-12">
        <h1 className="mb-3 text-3xl font-bold tracking-tight text-cp-text sm:text-4xl">
          AI Verification Use Cases
        </h1>
        <p className="text-lg text-cp-muted">
          How creators, journalists, researchers, analysts, founders, and teams use ConvergePanel
          to verify claims, fact-check AI answers, review video, build audit trails, and surface
          model disagreement before acting on AI output.
        </p>
      </div>

      {/* Jump-to nav */}
      <nav className="mb-12 flex flex-wrap gap-2" aria-label="Jump to section">
        {groups.map((group) => (
          <a
            key={group.id}
            href={`#${group.id}`}
            className={`inline-flex items-center rounded-full px-3 py-1 text-xs font-semibold uppercase tracking-wide transition-colors hover:opacity-80 ${group.tailwindText} ${group.tailwindBg}`}
          >
            {group.label}
          </a>
        ))}
      </nav>

      {/* Groups */}
      <div className="space-y-14">
        {groups.map((group) => (
          <section key={group.id} id={group.id} className="scroll-mt-8">
            {/* Group header */}
            <div className={`mb-5 rounded-xl border px-5 py-4 ${group.tailwindBg} ${group.tailwindBorder}`}>
              <div className="flex items-center gap-3">
                <span
                  className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-bold uppercase tracking-widest ${group.tailwindText} ${group.tailwindBg}`}
                >
                  {group.label}
                </span>
                <span className="text-xs text-cp-muted">{group.pages.length} pages</span>
              </div>
              <p className={`mt-1.5 text-sm ${group.tailwindText}`}>{group.description}</p>
            </div>

            {/* Page list */}
            <div className="grid gap-px bg-cp-border sm:grid-cols-2 rounded-lg overflow-hidden">
              {group.pages.map((p) => (
                <Link
                  key={p.slug}
                  href={`/use-cases/${p.slug}`}
                  className="group flex flex-col gap-0.5 bg-cp-surface px-4 py-3 hover:bg-cp-raised transition-colors"
                >
                  <span className={`text-sm font-semibold group-hover:${group.tailwindText} transition-colors text-cp-text`}>
                    {p.title}
                  </span>
                  <span className="text-xs text-cp-muted line-clamp-1">{p.metaDescription}</span>
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>

      {/* Footer CTA */}
      <div className="mt-16 rounded-2xl bg-cp-raised px-8 py-10 text-center">
        <p className="mb-2 text-lg font-semibold text-cp-text">
          Compare AI models, surface disagreement, and verify before you act
        </p>
        <p className="mb-6 text-sm text-cp-muted">
          Claim verification, AI answer fact-checking, video review, audit trails, and multi-model research. Free tier available.
        </p>
        <Link
          href="/signup"
          className="inline-block rounded-lg bg-sky-500 px-7 py-3 text-sm font-bold text-white shadow-sm hover:bg-sky-400 transition-colors"
        >
          Get started →
        </Link>
      </div>
    </main>
  );
}
