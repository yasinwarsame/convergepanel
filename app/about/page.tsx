import type { Metadata } from "next";
import Link from "next/link";
import { PANEL_MODELS } from "@/lib/panelModels";
import ModelChip from "@/components/ModelChip";

export const metadata: Metadata = {
  title: "About",
  description: "What ConvergePanel is and why multi-model verification matters.",
  alternates: { canonical: "/about" },
  openGraph: { url: "https://convergepanel.com/about", title: "About ConvergePanel" },
};

const MODEL_NOTES: Record<string, string> = {
  chatgpt: "Broad knowledge and reasoning.",
  claude: "Long-form analysis and careful phrasing.",
  grok: "Strong on timely and open-web context.",
  perplexity: "Research-style answers with citations when available.",
  gemini: "Multimodal and general reasoning.",
};

export default function AboutPage() {
  return (
    <main className="mx-auto max-w-4xl px-4 py-10 sm:py-14">
      <h1 className="mb-6 text-3xl font-bold text-cp-text">Why ConvergePanel exists</h1>

      <div className="prose max-w-none space-y-8">
        <p className="text-lg leading-relaxed text-cp-text">
          Every major AI model — GPT, Claude, Gemini, Grok, Perplexity — produces confident answers.
          But confidence is not accuracy. The same model can contradict itself in one session. Different
          models disagree on basic facts. None of them reliably tell you when they are uncertain.
          ConvergePanel was built to address that gap.
        </p>

        <section>
          <h2 className="text-2xl font-semibold text-cp-text">What we do</h2>
          <p className="mt-3 leading-relaxed text-cp-muted">
            ConvergePanel is a multi-model research and claims tool. It runs your questions and
            claims through five leading models at once and synthesizes the results into structured output:
            consensus, disagreements, bias signals, and evidence quality. Instead of one AI voice, you see
            the shape of agreement and disagreement — then you decide.
          </p>
        </section>

        <section>
          <h2 className="text-2xl font-semibold text-cp-text">How it works</h2>
          <p className="mt-3 leading-relaxed text-cp-muted">
            <strong className="text-cp-text">Research mode</strong> — Ask a complex question. Five
            models answer independently. ConvergePanel builds a structured brief with key findings,
            disagreements, bias signals, and open questions. Findings show which models align and where
            they split.
          </p>
          <p className="mt-3 leading-relaxed text-cp-muted">
            <strong className="text-cp-text">Claim verification mode</strong> — Paste a specific claim.
            Five models rate it as accurate, partially accurate, inaccurate, or unverifiable. You get an
            aggregate verdict, a consensus score (0–100), per-model evidence (including correct and
            incorrect parts where parsing succeeds), and a compact audit trail.
          </p>
          <p className="mt-3 leading-relaxed text-cp-muted">
            <strong className="text-cp-text">Video verification</strong> — Upload a video up to 60
            seconds. Three vision-capable AI models — GPT-4o, Claude, and Gemini — independently review
            extracted frames and metadata for signs of AI generation, synthetic-looking artifacts, and
            manipulation indicators. You receive a verdict, consensus score, and per-model evidence with
            manipulation signals, authenticity signals, and compression notes. The same consensus scoring
            and governance pipeline can apply to video results on eligible plans. This is an
            AI-assisted review tool — not forensic analysis.
          </p>
          <p className="mt-3 leading-relaxed text-cp-muted">
            These modes expose a consensus score and supporting labels (confidence, evidence quality)
            so you can see how defensible the outcome is. Audit bundles record what was run and the
            structured signals — not full raw model text — for a practical compliance footprint.
          </p>
        </section>

        <section>
          <h2 className="text-2xl font-semibold text-cp-text">What makes ConvergePanel different</h2>
          <p className="mt-3 leading-relaxed text-cp-muted">
            Few products combine multi-model text research, claim verification, and video authenticity
            review with governance scoring and audit trails in one workflow.
          </p>
        </section>

        <section>
          <h2 className="text-2xl font-semibold text-cp-text">Governance &amp; peer review</h2>
          <p className="mt-3 leading-relaxed text-cp-muted">
            Every run — research, claim verification, or video verification — is checked against configurable governance
            policies. If the consensus score is below your threshold, evidence quality looks weak, or a
            sensitive topic is detected, the result can be flagged for review.
          </p>
          <p className="mt-3 leading-relaxed text-cp-muted">
            On the 5-Model plan, you can assign a peer reviewer. Flagged items appear in their governance
            dashboard where they approve, block, or request changes. Each decision is recorded in an
            audit log with who reviewed it, what they chose, and their note.
          </p>
          <p className="mt-3 leading-relaxed text-cp-muted">
            This is structured review at the point of verification — before you rely on the result —
            not paperwork added after the fact.
          </p>
        </section>

        <section>
          <h2 className="text-2xl font-semibold text-cp-text">Who built this</h2>
          <p className="mt-3 leading-relaxed text-cp-muted">
            ConvergePanel is built by Mike Warsame. It started from a simple observation: the strongest
            decisions with AI rarely come from trusting a single model — they come from comparing several
            and reading the disagreement.
          </p>
        </section>

        <section>
          <h2 className="text-2xl font-semibold text-cp-text">What&apos;s next</h2>
          <p className="mt-3 leading-relaxed text-cp-muted">
            We keep improving structured review, policies, and audit visibility based on feedback.
            For questions or early-access conversations, email{" "}
            <a href="mailto:contact@convergepanel.com" className="text-sky-600 hover:underline">
              contact@convergepanel.com
            </a>
            .
          </p>
        </section>

        <section>
          <h2 className="text-2xl font-semibold text-cp-text">Models</h2>
          <p className="mt-3 leading-relaxed text-cp-muted">ConvergePanel supports five models in the full panel:</p>
          <div className="mt-4 space-y-3">
            {PANEL_MODELS.map((m) => (
              <div key={m.id}>
                <ModelChip modelId={m.id} variant="outline" size="xs" />
                <p className="ml-0 mt-1 text-sm text-cp-muted">{MODEL_NOTES[m.id]}</p>
              </div>
            ))}
          </div>
        </section>

        <section>
          <h2 className="text-2xl font-semibold text-cp-text">Decision support</h2>
          <p className="mt-3 leading-relaxed text-cp-muted">
            ConvergePanel supports decisions; it does not replace professional judgment. Scores and
            labels are computed from model outputs and heuristics — use them as signals, not as a sole
            basis for high-stakes calls.
          </p>
        </section>

        <section>
          <h2 className="text-2xl font-semibold text-cp-text">See it in practice</h2>
          <p className="mt-3 leading-relaxed text-cp-muted">
            Detailed use-case guides covering claim verification, video authenticity, AI audit trails,
            governance workflows, and more:
          </p>
          <ul className="mt-4 space-y-2">
            {[
              { label: "AI Audit Trail Software", href: "/use-cases/ai-audit-trail-software" },
              { label: "What Is a Decision Receipt?", href: "/use-cases/what-is-a-decision-receipt" },
              { label: "AI Governance for Small Teams", href: "/use-cases/ai-governance-for-small-teams" },
              { label: "Claim Verification for Journalists", href: "/use-cases/claim-verification-for-journalists" },
              { label: "Video Authenticity Review for Fact-Checkers", href: "/use-cases/video-authenticity-review-for-fact-checkers" },
              { label: "How to Check if AI Hallucinated", href: "/use-cases/how-to-check-if-ai-hallucinated" },
              { label: "AI Model Consensus Tool", href: "/use-cases/ai-model-consensus-tool" },
              { label: "How to Prove an AI Decision Was Reviewed", href: "/use-cases/how-to-prove-an-ai-decision-was-reviewed" },
            ].map(({ label, href }) => (
              <li key={href}>
                <Link href={href} className="text-sm text-sky-600 hover:underline">
                  {label} →
                </Link>
              </li>
            ))}
            <li>
              <Link href="/use-cases" className="text-sm font-semibold text-sky-600 hover:underline">
                Browse all 100 use cases →
              </Link>
            </li>
          </ul>
        </section>
      </div>

      <div className="mt-8 border-t border-cp-border pt-6">
        <Link href="/" className="inline-flex items-center font-medium text-sky-600 hover:text-sky-700">
          ← Back to panel
        </Link>
      </div>
    </main>
  );
}
