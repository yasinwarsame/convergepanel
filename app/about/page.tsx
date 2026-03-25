/**
 * App Router page (about): UI route entry.
 */

import Link from "next/link";
import { PANEL_MODELS } from "@/lib/panelModels";
import ModelChip from "@/components/ModelChip";

const MODEL_NOTES: Record<string, string> = {
  chatgpt: "Broad knowledge and reasoning.",
  claude: "Long-form analysis and careful phrasing.",
  grok: "Strong on timely and open-web context.",
  perplexity: "Research-style answers with citations when available.",
  gemini: "Multimodal and general reasoning.",
};

export default function AboutPage() {
  return (
    <main className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100 px-4 py-8">
      <div className="mx-auto max-w-4xl">
        <div className="rounded-lg bg-white p-8 shadow-lg">
          <h1 className="mb-6 text-3xl font-bold text-gray-900">Why ConvergePanel exists</h1>

          <div className="prose max-w-none space-y-8 text-gray-700">
            <p className="text-lg leading-relaxed">
              Every major AI model — GPT, Claude, Gemini, Grok, Perplexity — produces confident answers.
              But confidence is not accuracy. The same model can contradict itself in one session. Different
              models disagree on basic facts. None of them reliably tell you when they are uncertain.
              ConvergePanel was built to address that gap.
            </p>

            <section>
              <h2 className="text-2xl font-semibold text-gray-900">What we do</h2>
              <p className="mt-3 leading-relaxed">
                ConvergePanel is a multi-model research and claims tool. It runs your questions and
                claims through five leading models at once and synthesizes the results into structured output:
                consensus, disagreements, bias signals, and evidence quality. Instead of one AI voice, you see
                the shape of agreement and disagreement — then you decide.
              </p>
            </section>

            <section>
              <h2 className="text-2xl font-semibold text-gray-900">How it works</h2>
              <p className="mt-3 leading-relaxed">
                <strong className="text-gray-900">Research mode</strong> — Ask a complex question. Five
                models answer independently. ConvergePanel builds a structured brief with key findings,
                disagreements, bias signals, and open questions. Findings show which models align and where
                they split.
              </p>
              <p className="mt-3 leading-relaxed">
                <strong className="text-gray-900">Claim verification mode</strong> — Paste a specific claim.
                Five models rate it as accurate, partially accurate, inaccurate, or unverifiable. You get an
                aggregate verdict, a consensus score (0–100), per-model evidence (including correct and
                incorrect parts where parsing succeeds), and a compact audit trail.
              </p>
              <p className="mt-3 leading-relaxed">
                Both flows expose a consensus score and supporting labels (confidence, evidence quality)
                so you can see how defensible the outcome is. Audit bundles record what was run and the
                structured signals — not full raw model text — for a practical compliance footprint.
              </p>
            </section>

            <section>
              <h2 className="text-2xl font-semibold text-gray-900">Who built this</h2>
              <p className="mt-3 leading-relaxed">
                ConvergePanel is built by Mike Warsame. It started from a simple observation: the strongest
                decisions with AI rarely come from trusting a single model — they come from comparing several
                and reading the disagreement.
              </p>
            </section>

            <section>
              <h2 className="text-2xl font-semibold text-gray-900">What&apos;s next</h2>
              <p className="mt-3 leading-relaxed">
                We are building team governance features — policy rules, shared activity views, and richer
                audit exports for compliance. Some pieces exist in early form; fuller team workflows are
                rolling out over time. For early access or questions, email{" "}
                <a href="mailto:contact@convergepanel.com" className="text-sky-600 hover:underline">
                  contact@convergepanel.com
                </a>
                .
              </p>
            </section>

            <section>
              <h2 className="text-2xl font-semibold text-gray-900">Models</h2>
              <p className="mt-3 leading-relaxed">ConvergePanel supports five models in the full panel:</p>
              <div className="not-prose mt-4 space-y-3">
                {PANEL_MODELS.map((m) => (
                  <div key={m.id}>
                    <ModelChip modelId={m.id} variant="outline" size="xs" />
                    <p className="ml-0 mt-1 text-sm text-slate-600">{MODEL_NOTES[m.id]}</p>
                  </div>
                ))}
              </div>
            </section>

            <section>
              <h2 className="text-2xl font-semibold text-gray-900">Decision support</h2>
              <p className="mt-3 leading-relaxed">
                ConvergePanel supports decisions; it does not replace professional judgment. Scores and
                labels are computed from model outputs and heuristics — use them as signals, not as proof.
              </p>
            </section>
          </div>

          <div className="mt-8 border-t border-gray-200 pt-6">
            <Link href="/" className="inline-flex items-center font-medium text-sky-600 hover:text-sky-700">
              ← Back to panel
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
