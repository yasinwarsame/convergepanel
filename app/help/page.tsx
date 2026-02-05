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

