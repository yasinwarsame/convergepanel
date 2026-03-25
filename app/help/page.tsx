/**
 * App Router page (help): UI route entry.
 */

import type { ReactNode } from "react";
import Link from "next/link";

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
                Yes for individual runs via copy and JSON download in the UI. Broader team exports with date
                filters and CSV are planned; team governance and shared workspaces are rolling out over
                time.
              </FaqA>
            </section>

            <section>
              <h2 className="text-xl font-semibold text-gray-900">Plans &amp; limits</h2>

              <FaqQ>What&apos;s included in the free plan?</FaqQ>
              <FaqA>
                Eight runs per calendar month and up to two models per run. Both research and claim
                runs count as one run each. Audit trail views and JSON copy/download are included
                where the product exposes them for your results.
              </FaqA>

              <FaqQ>What do paid plans add?</FaqQ>
              <FaqA>
                More models per run (up to five on the full plan), higher monthly run limits, and longer
                history retention on paid tiers. See the{" "}
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
