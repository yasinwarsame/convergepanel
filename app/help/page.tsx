import Link from "next/link";

export default function HelpPage() {
  return (
    <main className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100 py-8 px-4">
        <div className="max-w-4xl mx-auto">
          <div className="bg-white rounded-lg shadow-lg p-8">
            <h1 className="text-3xl font-bold text-gray-900 mb-6">Help & Guide</h1>

            <div className="prose max-w-none space-y-6 text-gray-700">
              <section>
                <h2 className="text-2xl font-semibold text-gray-900 mb-3">
                  How to Ask Good Questions
                </h2>
                <p className="leading-relaxed mb-3">
                  To get the best results from ConvergePanel, frame your questions
                  clearly and specifically:
                </p>
                <ul className="list-disc list-inside space-y-2 ml-4">
                  <li>
                    <strong>Be specific:</strong> Instead of &quot;Tell me about
                    climate change,&quot; try &quot;What are the key factors affecting
                    climate change, and what is the scientific consensus on each?&quot;
                  </li>
                  <li>
                    <strong>Ask for analysis:</strong> Questions that require comparison,
                    evaluation, or synthesis work best with multiple models.
                  </li>
                  <li>
                    <strong>Request numbers when relevant:</strong> Models may provide
                    different statistics, which helps identify areas of uncertainty.
                  </li>
                  <li>
                    <strong>Include context:</strong> Provide background information if
                    your question is about a specific domain or recent event.
                  </li>
                </ul>
              </section>

              <section>
                <h2 className="text-2xl font-semibold text-gray-900 mb-3">
                  Understanding Consensus and Disagreement
                </h2>
                <div className="space-y-4">
                  <div className="bg-green-50 p-4 rounded-lg border border-green-200">
                    <h3 className="font-semibold text-green-900 mb-2">
                      ✓ Strong Consensus
                    </h3>
                    <p className="text-green-800 text-sm">
                      When multiple models agree on a claim or fact, it appears in the
                      &quot;Areas of Agreement&quot; section. This indicates higher
                      confidence in the answer.
                    </p>
                  </div>
                  <div className="bg-yellow-50 p-4 rounded-lg border border-yellow-200">
                    <h3 className="font-semibold text-yellow-900 mb-2">
                      ⚠️ Contested Areas
                    </h3>
                    <p className="text-yellow-800 text-sm">
                      When models provide different perspectives or conflicting
                      information, these appear in the &quot;Model Split&quot; section.
                      This highlights areas where the answer is uncertain or where
                      different viewpoints exist.
                    </p>
                  </div>
                  <div className="bg-red-50 p-4 rounded-lg border border-red-200">
                    <h3 className="font-semibold text-red-900 mb-2">
                      🔢 Numeric Conflicts
                    </h3>
                    <p className="text-red-800 text-sm">
                      When models provide different numbers, percentages, or statistics
                      for the same claim, ConvergePanel flags this as a numeric conflict.
                      Review both values and consider the source or context.
                    </p>
                  </div>
                </div>
              </section>

              <section>
                <h2 className="text-2xl font-semibold text-gray-900 mb-3">
                  Why Minimum 2 Models Required?
                </h2>
                <p className="leading-relaxed">
                  Convergence analysis requires at least two models to compare responses.
                  With only one model, there&apos;s no basis for:
                </p>
                <ul className="list-disc list-inside space-y-2 ml-4 mt-3">
                  <li>Identifying consensus or disagreement</li>
                  <li>Detecting numeric conflicts</li>
                  <li>Validating claims across different perspectives</li>
                  <li>Generating a meaningful unified synthesis</li>
                </ul>
                <p className="leading-relaxed mt-4">
                  If only one model responds successfully, ConvergePanel will show the raw
                  response but will not generate a synthesis report. You&apos;ll be
                  prompted to re-run with additional models.
                </p>
              </section>

              <section>
                <h2 className="text-2xl font-semibold text-gray-900 mb-3">
                  Verification Gate
                </h2>
                <p className="leading-relaxed mb-4">
                  After every panel synthesis, ConvergePanel displays a Verification Gate at
                  the top of the report. It gives you an at-a-glance decision-readiness signal
                  based on how much the models agreed, where they diverged, and what evidence
                  may be missing.
                </p>
                <div className="space-y-4">
                  <div className="bg-emerald-50 p-4 rounded-lg border border-emerald-200">
                    <h3 className="font-semibold text-emerald-900 mb-2">
                      Broadly consistent
                    </h3>
                    <p className="text-emerald-800 text-sm">
                      Models show broad agreement with supporting evidence and no major
                      disagreements. Suitable for exploratory use &mdash; but always
                      cross-check key claims with primary sources before acting on them.
                    </p>
                  </div>
                  <div className="bg-amber-50 p-4 rounded-lg border border-amber-200">
                    <h3 className="font-semibold text-amber-900 mb-2">
                      Needs human review
                    </h3>
                    <p className="text-amber-800 text-sm">
                      The analysis detected model disagreements, a significant number of
                      contested claims, or a combination of bias signals and uncertainty.
                      Review the flagged areas and verify disputed premises independently
                      before relying on the conclusions.
                    </p>
                  </div>
                  <div className="bg-red-50 p-4 rounded-lg border border-red-200">
                    <h3 className="font-semibold text-red-900 mb-2">
                      Low confidence &mdash; review required
                    </h3>
                    <p className="text-red-800 text-sm">
                      Key findings lack source citations and models disagree or show low
                      confidence. Treat the output as a starting hypothesis only. Request
                      sources, narrow your question, and do not use for automated action
                      until claims are independently verified.
                    </p>
                  </div>
                </div>
                <div className="mt-4 space-y-3">
                  <h3 className="font-semibold text-gray-900">What signals does it use?</h3>
                  <p className="text-sm leading-relaxed">
                    The Verification Gate is computed from signals already present in your
                    synthesis &mdash; no additional model calls are made. It checks for:
                  </p>
                  <ul className="list-disc list-inside space-y-1 ml-4 text-sm">
                    <li>Model disagreements on core conclusions</li>
                    <li>Number of contested claims</li>
                    <li>Missing sources or citations on key findings</li>
                    <li>Bias and blind spot flags</li>
                    <li>High uncertainty signals (low-confidence findings + open questions)</li>
                  </ul>
                  <p className="text-sm leading-relaxed">
                    Along with the status badge, the gate shows <strong>why</strong> it
                    reached its assessment (listing only the signals that triggered) and
                    provides <strong>recommended next steps</strong> tailored to the specific
                    issues detected.
                  </p>
                  <p className="text-xs text-slate-500 mt-2">
                    The Verification Gate is an advisory signal derived from model comparison.
                    It does not constitute factual certification and is not a substitute for
                    independent professional review.
                  </p>
                </div>
              </section>

              <section>
                <h2 className="text-2xl font-semibold text-gray-900 mb-3">
                  Claim Severity Tags
                </h2>
                <p className="leading-relaxed mb-4">
                  Not every claim in a synthesis carries the same weight. Claim Severity
                  Tags label each finding, disagreement, and bias flag with one of three
                  impact levels so you can focus your review where it matters most.
                </p>
                <div className="space-y-4">
                  <div className="bg-slate-50 p-4 rounded-lg border border-slate-200">
                    <h3 className="font-semibold text-slate-900 mb-2">
                      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-600 mr-2">
                        <span className="h-1.5 w-1.5 rounded-full bg-slate-400"></span>Low stakes
                      </span>
                    </h3>
                    <p className="text-slate-700 text-sm">
                      Supporting context, secondary framing, or low-impact observations.
                      Useful background but unlikely to change a decision.
                    </p>
                  </div>
                  <div className="bg-amber-50 p-4 rounded-lg border border-amber-200">
                    <h3 className="font-semibold text-amber-900 mb-2">
                      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-700 mr-2">
                        <span className="h-1.5 w-1.5 rounded-full bg-amber-400"></span>Important
                      </span>
                    </h3>
                    <p className="text-amber-800 text-sm">
                      Claims that materially shape interpretation, prioritization, or
                      follow-up. Worth verifying before relying on them.
                    </p>
                  </div>
                  <div className="bg-rose-50 p-4 rounded-lg border border-rose-200">
                    <h3 className="font-semibold text-rose-900 mb-2">
                      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium bg-rose-50 text-rose-700 mr-2">
                        <span className="h-1.5 w-1.5 rounded-full bg-rose-500"></span>Decision-critical
                      </span>
                    </h3>
                    <p className="text-rose-800 text-sm">
                      Claims that affect action, compliance, legal exposure, financial
                      exposure, safety, or strategic recommendations. Treat these with the
                      highest scrutiny.
                    </p>
                  </div>
                </div>
                <p className="text-xs text-slate-500 mt-3">
                  Severity is estimated from the text content using lightweight
                  heuristics. It reflects potential impact on downstream decisions, not
                  model confidence alone.
                </p>
              </section>

              <section>
                <h2 className="text-2xl font-semibold text-gray-900 mb-3">
                  Source-Grounding Flags
                </h2>
                <p className="leading-relaxed mb-4">
                  Source-Grounding Flags indicate whether a claim appears to be backed by
                  cited evidence, based on model inference, or a mix of both. They help
                  you gauge how much independent verification a conclusion might need.
                </p>
                <div className="space-y-4">
                  <div className="bg-sky-50 p-4 rounded-lg border border-sky-200">
                    <h3 className="font-semibold text-sky-900 mb-2">
                      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium bg-sky-50 text-sky-700 mr-2">Source-backed</span>
                    </h3>
                    <p className="text-sky-800 text-sm">
                      The claim references explicit citations, studies, institutions, or
                      external evidence. Still verify the cited sources independently.
                    </p>
                  </div>
                  <div className="bg-violet-50 p-4 rounded-lg border border-violet-200">
                    <h3 className="font-semibold text-violet-900 mb-2">
                      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium bg-violet-50 text-violet-700 mr-2">Model-reasoned</span>
                    </h3>
                    <p className="text-violet-800 text-sm">
                      The claim appears based primarily on model inference and reasoning
                      with little or no cited evidence. Exercise extra caution.
                    </p>
                  </div>
                  <div className="bg-slate-50 p-4 rounded-lg border border-slate-200">
                    <h3 className="font-semibold text-slate-900 mb-2">
                      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-600 mr-2">Mixed / unclear</span>
                    </h3>
                    <p className="text-slate-700 text-sm">
                      The grounding is ambiguous &mdash; the claim blends sourced and inferred
                      reasoning, or there is not enough signal to classify it clearly.
                    </p>
                  </div>
                </div>
                <p className="text-xs text-slate-500 mt-3">
                  Grounding flags are informational signals estimated from text patterns.
                  They do not guarantee that cited sources are accurate or that
                  model-reasoned claims are incorrect.
                </p>
              </section>

              <section>
                <h2 className="text-2xl font-semibold text-gray-900 mb-3">
                  Panel Verdict Card
                </h2>
                <p className="leading-relaxed mb-4">
                  At the bottom of every synthesis report, ConvergePanel generates a
                  compact <strong>Panel Verdict</strong> &mdash; a shareable decision
                  artifact that captures the essentials of the analysis in one card.
                </p>
                <p className="leading-relaxed mb-3">
                  The card includes:
                </p>
                <ul className="list-disc list-inside space-y-2 ml-4 mb-4">
                  <li>The original question</li>
                  <li>The top consensus point</li>
                  <li>The top disagreement (if any)</li>
                  <li>Verification Gate result</li>
                  <li>Source-grounding signal</li>
                  <li>One key caveat or blind spot</li>
                </ul>
                <p className="leading-relaxed mb-3">
                  Use the <strong>Copy for LinkedIn</strong> button for a professional post, or <strong>Copy as Markdown</strong> for research notes. The <strong>Copy for X</strong> button produces a thread-ready version for X/Twitter.
                </p>
                <p className="text-xs text-slate-500 mt-3">
                  The Panel Verdict is auto-generated from multi-model synthesis and is
                  provided for informational purposes only.
                </p>
              </section>

              <section>
                <h2 className="text-2xl font-semibold text-gray-900 mb-3">
                  Panel Presets
                </h2>
                <ul className="list-disc list-inside space-y-2 ml-4">
                  <li>
                    <strong>Quick Panel (2 models):</strong> Fastest results, good for
                    simple questions.
                  </li>
                  <li>
                    <strong>Balanced Panel (3 models):</strong> Good balance of speed and
                    coverage.
                  </li>
                  <li>
                    <strong>Deep Panel (5 models):</strong> Most comprehensive analysis,
                    best for complex or important questions.
                  </li>
                </ul>
              </section>
            </div>

            <div className="mt-8 pt-6 border-t border-gray-200">
              <Link
                href="/"
                className="inline-flex items-center text-primary-600 hover:text-primary-700 font-medium"
              >
                ← Back to Panel
              </Link>
            </div>
          </div>
        </div>
      </main>
  );
}

