/**
 * App Router page (help): UI route entry.
 */

import type { Metadata } from "next";
import type { ReactNode } from "react";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Help — ConvergePanel",
  description:
    "How to use research mode, claim verification, video verification FAQ, governance, plans, and troubleshooting.",
};

function FaqQ({ children }: { children: ReactNode }) {
  return <h3 className="mt-6 text-base font-semibold text-gray-900 first:mt-0">{children}</h3>;
}

function FaqA({ children }: { children: ReactNode }) {
  return <p className="mt-2 text-sm leading-relaxed text-gray-700">{children}</p>;
}

export default function HelpPage() {
  return (
    <main className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100 px-4 py-8">
      <div className="mx-auto max-w-4xl">
        <div className="rounded-lg bg-white p-8 shadow-lg">
          <h1 className="mb-2 text-3xl font-bold text-gray-900">How to use ConvergePanel</h1>
          <p className="text-sm text-gray-600">
            Research mode and claim verification share the same idea: compare models before you trust an
            answer.
          </p>

          <div className="mt-8 space-y-10 text-gray-700">
            <section>
              <h2 className="text-xl font-semibold text-gray-900">Getting started</h2>

              <FaqQ>How do I run my first research panel?</FaqQ>
              <FaqA>
                Sign in, open the <strong>Research</strong> tab, enter your question, choose at least two
                models (free plan: up to two per run; paid plans: up to five), and run the panel. You will
                see each model&apos;s answer, then a synthesized report with agreement and disagreement
                mapped across models. Typical wall time is roughly 15–45 seconds; complex prompts can run
                longer.
              </FaqA>

              <FaqQ>How do I verify a claim?</FaqQ>
              <FaqA>
                Open the <strong>Verify claim</strong> tab, paste a claim (a sentence or short passage),
                select your models, and run verification. Each model returns a structured evaluation when
                parsing succeeds. ConvergePanel aggregates those into an overall verdict (confirmed,
                disputed, partially true, or unverifiable), a consensus score, per-model summaries, and an
                audit trail you can copy as JSON.
              </FaqA>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-gray-900">Video verification</h2>
              <p className="mt-2 rounded-lg border border-amber-200/80 bg-amber-50/80 px-3 py-2 text-xs leading-relaxed text-amber-950/90">
                ⚠️ AI-assisted authenticity review — not forensic analysis. This is an AI-assisted video
                authenticity review; results should inform human judgment, not replace it.
              </p>

              <FaqQ>How does video verification work?</FaqQ>
              <FaqA>
                Upload a video file (MP4, MOV, or WebM, up to 60 seconds and 50MB). ConvergePanel extracts
                frames at regular intervals and sends them with video metadata to three vision-capable AI
                models (GPT-4o, Claude, and Gemini). Each model independently reviews the frames for signs
                of AI generation, synthetic-looking edits, and manipulation indicators. You receive a verdict
                with consensus scoring and per-model evidence.
              </FaqA>

              <FaqQ>What do the video verdicts mean?</FaqQ>
              <FaqA>
                <strong>Authentic:</strong> Models reported no strong manipulation indicators. That does not
                mean the clip is necessarily genuine — it means no major red flags showed up in this pass.{" "}
                <strong>Likely manipulated:</strong> Multiple models flagged inconsistencies suggesting AI
                generation or digital editing; open the per-model evidence for specifics.{" "}
                <strong>Inconclusive:</strong> Models split or lacked confidence — human review is
                appropriate. <strong>Insufficient:</strong> The clip is too short, low resolution, or too
                compressed for a meaningful read.
              </FaqA>

              <FaqQ>Can I rely on this as legal or lab-grade evidence?</FaqQ>
              <FaqA>
                No. ConvergePanel uses general-purpose AI vision models, not dedicated authenticity-lab
                suites. Treat outputs as indicators for your judgment, not as standalone evidence in legal
                or compliance settings.
              </FaqA>

              <FaqQ>What does metadata review cover?</FaqQ>
              <FaqA>
                We read file metadata such as creation time, encoding software, resolution, frame rate, and
                codec. The product can flag markers like software names associated with AI video tools,
                missing creation dates, implausible timestamps, or unusual technical mixes — always as hints,
                not as definitive labels.
              </FaqA>

              <FaqQ>What about heavy compression?</FaqQ>
              <FaqA>
                Social and mobile video is often heavily compressed; compression can look like tampering.
                Models are guided to separate compression artifacts from manipulation indicators and to call
                out ambiguity. Very low quality may land in Inconclusive or Insufficient.
              </FaqA>

              <FaqQ>How many video verifications do I get?</FaqQ>
              <FaqA>
                Free plan: not available. 3-Model plan: 5 per calendar month. 5-Model plan: 20 per calendar
                month. Each video verification also consumes one run from your monthly panel run allowance.
              </FaqA>

              <FaqQ>What formats are supported, and is my video kept?</FaqQ>
              <FaqA>
                MP4, MOV, and WebM; max 50MB and 60 seconds. The file is processed in memory and not stored
                as media — only analysis results and structured metadata are saved. Extracted frames are
                discarded after the models finish.
              </FaqA>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-gray-900">Understanding results</h2>

              <FaqQ>What is the consensus score?</FaqQ>
              <FaqA>
                A number from 0 to 100. For claim verification it is computed from how models voted, how
                many returned usable parsed results, and related signals (for example low-confidence rows or
                parse errors). Higher generally means more support and healthier participation; lower means
                more disagreement, missing models, or weak evidence. Use it together with the confidence
                label and evidence quality — not as a single yes/no.
              </FaqA>

              <FaqQ>What do the confidence labels mean?</FaqQ>
              <FaqA>
                You will see <strong>High</strong>, <strong>Medium</strong>, or <strong>Low</strong> next
                to the score. High indicates a stronger score with enough models successfully contributing;
                Low flags a weak score and/or too few usable model rows. Medium is everything in between.
                Exact thresholds are fixed in the product logic so the same inputs yield the same label.
              </FaqA>

              <FaqQ>What is evidence quality?</FaqQ>
              <FaqA>
                <strong>Strong</strong>, <strong>mixed</strong>, or <strong>weak</strong> summarizes how
                tight the model evidence looks relative to agreement and low-confidence counts. Strong
                suggests aligned, higher-confidence evidence; weak suggests splits or many low-confidence /
                failed parses.
              </FaqA>

              <FaqQ>What do the verdicts mean in claim verification?</FaqQ>
              <FaqA>
                <strong>Confirmed</strong> — a large majority of models with usable verdicts rate the claim
                as accurate. <strong>Disputed</strong> — material disagreement (for example both accurate and
                inaccurate votes among usable models). <strong>Partially true</strong> — enough partial or
                qualified agreement that the core idea may hold but details need correction.{" "}
                <strong>Unverifiable</strong> — too many unknowns, too many unverifiable votes, or not
                enough usable model output to call the claim confirmed or disputed with confidence.
              </FaqA>

              <FaqQ>Why do some models say &quot;unverifiable&quot; while others say &quot;accurate&quot;?</FaqQ>
              <FaqA>
                Models differ in training data, tools, and recency. One may have live or web-backed context;
                another may refuse or hedge on the same text. That split is itself informative: it often
                means the claim depends on time-sensitive or source-specific facts not all models can see
                the same way.
              </FaqA>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-gray-900">Audit trail</h2>

              <FaqQ>What is the audit trail?</FaqQ>
              <FaqA>
                A compact record of a claim (or research metadata where exposed): which models ran,
                structured verdict signals, consensus score, timestamps, and lengths — designed so you can
                show what was checked without storing full raw completions in the bundle. In the app, open{" "}
                <strong>View audit trail</strong> on a claim result; use <strong>Copy audit as JSON</strong>{" "}
                or <strong>Download</strong> for your files.
              </FaqA>

              <FaqQ>Can I export audit trails?</FaqQ>
              <FaqA>
                Yes for individual runs via copy and JSON download in the UI. Bulk export across many runs
                is not available yet.
              </FaqA>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-gray-900">Governance &amp; review</h2>

              <FaqQ>What is the Governance Dashboard?</FaqQ>
              <FaqA>
                On the 5-Model plan, the Governance Dashboard is where you set trust thresholds, assign a
                peer reviewer, and keep an audit trail of review decisions. When a claim verification or
                research run falls below your configured threshold, it can be flagged for review
                automatically.
              </FaqA>

              <FaqQ>How do I assign a reviewer?</FaqQ>
              <FaqA>
                Open <strong>Profile</strong> → <strong>Governance Settings</strong>. Turn on{" "}
                <strong>Available as reviewer</strong> if you want others to assign you. To choose your own
                reviewer, enter their email — they need the 5-Model plan with reviewer availability on.
                Assignment applies right away.
              </FaqA>

              <FaqQ>What can a reviewer do?</FaqQ>
              <FaqA>
                Reviewers open <strong>Governance</strong> → <strong>Review Queue</strong>. Each flagged run
                shows the claim or question, consensus score, model verdicts, where models agree or disagree,
                and governance reasons. They can approve, block with a comment, or request changes.
              </FaqA>

              <FaqQ>What is the Audit Log?</FaqQ>
              <FaqA>
                The Audit Log lists your own review actions: who approved or blocked a run, when, and the
                comment. Run owners see the outcome on their History view when you complete a review.
              </FaqA>

              <FaqQ>What triggers a review?</FaqQ>
              <FaqA>
                Your governance policy decides. Typical flags include consensus below a threshold, weak
                evidence quality, model failures, sensitive-domain detection (legal, medical, financial), and
                certain claim verdicts (e.g. disputed or unverifiable). Thresholds are configurable where your
                account has policy access.
              </FaqA>

              <FaqQ>Do I need a reviewer to use ConvergePanel?</FaqQ>
              <FaqA>
                No. Reviewer assignment is optional. All plans get consensus scoring and governance status
                on results. Peer review and the full governance dashboard are on the 5-Model plan if you want
                that workflow.
              </FaqA>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-gray-900">Plans &amp; limits</h2>

              <FaqQ>What&apos;s included in the free plan?</FaqQ>
              <FaqA>
                Eight runs per calendar month and up to two models per run. Both research and claim
                runs count as one run each. Video verification is not included on free. Audit trail views
                and JSON copy/download are included where the product exposes them for your results.
              </FaqA>

              <FaqQ>What do paid plans add?</FaqQ>
              <FaqA>
                More models per run (up to five on the full plan), higher monthly run limits, video
                verification with its own monthly allowance (each video also uses one panel run), and longer
                history retention on paid tiers. The 5-Model plan adds governance dashboards, peer review,
                and the review audit log. See the{" "}
                <Link href="/pricing" className="font-medium text-sky-600 hover:text-sky-700">
                  pricing page
                </Link>{" "}
                for current numbers.
              </FaqA>

              <FaqQ>Do claims count against my monthly limit?</FaqQ>
              <FaqA>Yes. Each claim run increments usage the same way a research panel run does.</FaqA>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-gray-900">Troubleshooting</h2>

              <FaqQ>A model shows &quot;parse error&quot; — what happened?</FaqQ>
              <FaqA>
                Sometimes a model returns text we cannot parse into the expected JSON shape (for example
                extra prose or markdown around the payload). That model is marked as a parse error; other
                models still count. The consensus score reflects the reduced usable set.
              </FaqA>

              <FaqQ>My results seem slow — is that normal?</FaqQ>
              <FaqA>
                Yes. Each run fans out to multiple providers in parallel. Most complete in roughly 15–45
                seconds; heavy prompts or slow endpoints can approach a minute.
              </FaqA>
            </section>
          </div>

          <div className="mt-10 border-t border-gray-200 pt-6">
            <Link href="/" className="inline-flex items-center font-medium text-sky-600 hover:text-sky-700">
              ← Back to panel
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
