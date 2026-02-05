import Link from "next/link";
import { aboutCopy } from "@/lib/content/aboutCopy";
import { PANEL_MODELS, getPanelModelConfig } from "@/lib/panelModels";
import ModelChip from "@/components/ModelChip";

export default function AboutPage() {
  return (
    <main className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100 py-8 px-4">
        <div className="max-w-4xl mx-auto">
          <div className="bg-white rounded-lg shadow-lg p-8">
            <h1 className="text-3xl font-bold text-gray-900 mb-6">About ConvergePanel</h1>

            <div className="prose max-w-none space-y-6 text-gray-700">
              <section>
                <h2 className="text-2xl font-semibold text-gray-900 mb-3">
                  What is ConvergePanel?
                </h2>
                <p className="text-lg leading-relaxed">
                  {aboutCopy.detailedDescription}
                </p>
              </section>

              <section>
                <h2 className="text-2xl font-semibold text-gray-900 mb-3">
                  How ConvergePanel Works
                </h2>
                <p className="leading-relaxed mb-3">
                  ConvergePanel provides multiple ways to view and analyze model responses:
                </p>
                <ul className="list-disc list-inside space-y-2 ml-4">
                  <li>
                    <strong>Panel Responses:</strong> The app creates a panel response for each LLM, which you can view in <strong>List View</strong> (collapsible individual responses) or <strong>Compare View</strong> (side-by-side comparison).
                  </li>
                  <li>
                    <strong>Unified Synthesis:</strong> ConvergePanel also generates a unified synthesis built from all model responses. The synthesis highlights consensus, surfaces key disagreements and debates, flags possible bias and blind spots, and calls out single-model insights.
                  </li>
                </ul>
              </section>

              <section>
                <h2 className="text-xl sm:text-2xl font-semibold text-slate-900 mb-3">
                  How ConvergePanel interprets your expert panel
                </h2>
                <p className="text-sm text-slate-600 leading-relaxed mb-6">
                  Every panel run is broken into three key views that help you understand what to trust.
                </p>
                <div className="space-y-4 not-prose">
                  {/* Trust legend block - matches dashboard Trust Summary legend styles */}
                  {/* Strong consensus findings - matches ResultsDisplay.tsx line 777: text-emerald-600 */}
                  <div>
                    <h3 className="text-xs font-semibold text-emerald-600 uppercase tracking-wide mb-1 !text-emerald-600">
                      Strong consensus findings
                    </h3>
                    <p className="text-slate-600 text-sm">
                      Where multiple models independently converge on the same answer, so you can move faster with more confidence.
                    </p>
                  </div>

                  {/* Contested areas - matches ResultsDisplay.tsx line 789: text-amber-600 */}
                  <div>
                    <h3 className="text-xs font-semibold text-amber-600 uppercase tracking-wide mb-1 !text-amber-600">
                      Contested areas
                    </h3>
                    <p className="text-slate-600 text-sm">
                      Where models disagree on facts, numbers, or interpretations, flagging claims that deserve a closer look.
                    </p>
                  </div>

                  {/* Possible bias / blind spot - matches ResultsDisplay.tsx line 1098: text-amber-700 */}
                  <div>
                    <h3 className="text-xs font-medium text-amber-700 mb-1 !text-amber-700">
                      Possible bias / blind spot
                    </h3>
                    <p className="text-slate-600 text-sm">
                      Where model behavior looks skewed, incomplete, or overconfident, helping you spot missing perspectives.
                    </p>
                  </div>
                </div>
              </section>

              <section>
                <h2 className="text-2xl font-semibold text-gray-900 mb-3">
                  {aboutCopy.whyItMatters.title}
                </h2>
                <p className="leading-relaxed">
                  {aboutCopy.whyItMatters.description}
                </p>
                <ul className="list-disc list-inside space-y-2 ml-4">
                  {aboutCopy.whyItMatters.points.map((point, index) => (
                    <li key={index}>
                      <strong>{point.label}:</strong> {point.text}
                    </li>
                  ))}
                </ul>
              </section>

              <section>
                <h2 className="text-2xl font-semibold text-gray-900 mb-3">
                  {aboutCopy.models.title}
                </h2>
                <p className="leading-relaxed mb-3">
                  {aboutCopy.models.description}
                </p>
                <div className="space-y-3">
                  {/* Model descriptions block - uses centralized ModelChip component for consistent styling */}
                  {aboutCopy.models.list.map((model) => {
                    // Find the model ID by matching the display name
                    const modelConfig = PANEL_MODELS.find(m => m.label === model.name);
                    const modelId = modelConfig?.id || "chatgpt"; // Fallback to chatgpt if not found
                    
                    return (
                      <div key={model.name}>
                        {/* Model name - uses ModelChip component for consistent styling across the app */}
                        <div className="mb-1">
                          <ModelChip modelId={modelId} variant="outline" size="xs" />
                        </div>
                        {/* Model description - matches dashboard body text style from ResultsDisplay.tsx line 1727 */}
                        <p className="text-slate-600 text-sm ml-0 mt-1">
                          {model.description}
                        </p>
                      </div>
                    );
                  })}
                </div>
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

