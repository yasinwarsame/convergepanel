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
    tailwindText: "text-blue-400",
    tailwindBg: "bg-cp-raised",
    tailwindBorder: "border-cp-border",
    slugs: [
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
    tailwindText: "text-indigo-400",
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
    tailwindText: "text-rose-400",
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
    description: "Review video clips for AI-generation signals and manipulation indicators using three vision models.",
    tailwindText: "text-violet-400",
    tailwindBg: "bg-cp-raised",
    tailwindBorder: "border-cp-border",
    slugs: [
      "video-authenticity-review-for-fact-checkers",
      "video-authenticity-review-for-researchers",
      "ai-video-review-for-media-teams",
      "ai-video-verification-for-journalists",
      "how-to-review-a-suspicious-video-with-ai",
      "how-to-check-if-a-viral-video-might-be-manipulated",
      "how-to-sanity-check-a-viral-clip",
      "how-to-verify-a-clip-before-publishing",
      "how-journalists-can-verify-viral-clips",
    ],
  },
  {
    id: "governance-audit-trails",
    label: "AI Audit Trails & Governance",
    description: "Build compliance-ready audit trails, peer review workflows, and AI accountability documentation.",
    tailwindText: "text-amber-400",
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
    tailwindText: "text-teal-400",
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
    tailwindText: "text-pink-400",
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
    tailwindText: "text-sky-400",
    tailwindBg: "bg-cp-raised",
    tailwindBorder: "border-cp-border",
    slugs: [
      "newsroom-ai-verification-workflow",
      "ai-tools-for-investigative-journalists",
      "how-to-verify-public-statements-quickly",
      "verification-checklist-for-journalists",
      "how-to-verify-user-generated-content",
      "how-to-fact-check-breaking-news-claims",
    ],
  },
  {
    id: "founder-decision-support",
    label: "Founder & Decision Support",
    description: "Pressure-test business assumptions, pitch claims, and market research with multi-model AI.",
    tailwindText: "text-orange-400",
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
    label: "Research & Analyst Workflows",
    description: "Get structured multi-model research briefs that surface disagreements, bias signals, and source gaps.",
    tailwindText: "text-emerald-400",
    tailwindBg: "bg-cp-raised",
    tailwindBorder: "border-cp-border",
    slugs: [
      "deep-research-with-multiple-ai-models",
      "how-to-compare-chatgpt-claude-gemini-grok-perplexity-for-research",
      "chatgpt-vs-claude-vs-gemini-for-research",
      "ai-summarizer-vs-multi-model-research-panel",
      "perplexity-vs-multi-model-panel-for-research",
      "how-to-compare-ai-answers-before-deciding",
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
        <p className="mb-2 text-lg font-semibold text-white">
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
