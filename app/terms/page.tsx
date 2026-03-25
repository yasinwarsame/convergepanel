/**
 * Terms of Service Page
 *
 * Includes disclaimers regarding third-party AI outputs. Review with legal counsel before relying in production.
 */

import Link from "next/link";

export default function TermsPage() {
  return (
    <main className="min-h-screen bg-slate-50 px-4 py-10">
      <div className="mx-auto max-w-3xl">
        <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
          <h1 className="mb-6 text-3xl font-semibold text-slate-900">Terms of Service</h1>

          <div className="prose prose-slate max-w-none">
            <p className="mb-6 text-sm text-slate-600">
              <strong>Last updated:</strong> {new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}
            </p>

            <section className="mb-8">
              <h2 className="mb-3 text-xl font-semibold text-slate-900">1. Agreement</h2>
              <p className="mb-3 text-slate-700">
                These Terms of Service (&quot;Terms&quot;) are a binding agreement between you and
                ConvergePanel (&quot;ConvergePanel,&quot; &quot;we,&quot; &quot;us,&quot; or
                &quot;our&quot;) governing your access to and use of the ConvergePanel website,
                applications, and related services (collectively, the &quot;Service&quot;). By
                accessing or using the Service, you agree to these Terms. If you do not agree, do not
                use the Service.
              </p>
            </section>

            <section className="mb-8">
              <h2 className="mb-3 text-xl font-semibold text-slate-900">2. Description of the Service</h2>
              <p className="mb-3 text-slate-700">
                The Service allows you to submit questions, claims, or other inputs for processing by
                multiple third-party artificial intelligence (&quot;AI&quot;) or large language model
                (&quot;LLM&quot;) providers, and to receive aggregated, synthesized, or structured
                outputs (including scores, labels, summaries, and audit-style records). ConvergePanel
                does not operate those underlying models; it facilitates requests and presents
                results. Providers may include, without limitation, OpenAI, Anthropic, Google (Gemini),
                X.A.I (Grok), and Perplexity, and others we may add or change from time to time.
              </p>
              <p className="text-slate-700">
                The Service is a software tool only. It is not a substitute for professional,
                financial, legal, medical, or other specialized judgment, and it does not verify
                facts against primary sources on your behalf.
              </p>
            </section>

            <section className="mb-8 rounded-lg border border-amber-200 bg-amber-50/80 p-5">
              <h2 className="mb-3 text-xl font-semibold text-slate-900">
                3. Disclaimers Regarding AI-Generated Content
              </h2>
              <p className="mb-3 text-slate-800">
                <strong>
                  OUTPUTS FROM THE SERVICE (INCLUDING RAW MODEL RESPONSES, SYNTHESES, VERDICTS,
                  SCORES, LABELS, &quot;CONSENSUS&quot; OR &quot;CONFIDENCE&quot; INDICATORS, AND AUDIT
                  RECORDS) MAY BE INCORRECT, INCOMPLETE, MISLEADING, OUTDATED, BIASED, OR OTHERWISE
                  UNSUITABLE FOR YOUR PURPOSE.
                </strong>{" "}
                AI systems can produce content that appears authoritative while being wrong.
                ConvergePanel does not warrant, endorse, or guarantee the accuracy, reliability,
                timeliness, completeness, legality, or fitness for any particular purpose of any such
                content.
              </p>
              <p className="mb-3 text-slate-800">
                <strong>You acknowledge and agree that:</strong> (a) ConvergePanel is not responsible
                or liable for any errors, omissions, or inaccuracies in AI-generated or
                model-derived content; (b) if models or the Service provide wrong information,
                ConvergePanel bears no responsibility for any loss or harm arising from that
                information; (c) you bear sole responsibility to vet, verify, cross-check, and
                independently confirm any information before you rely on it for any decision,
                disclosure, publication, compliance filing, clinical, safety-critical, or
                high-stakes use; and (d) your use of any output is at your sole risk.
              </p>
              <p className="text-slate-800">
                Nothing in the Service constitutes legal, tax, investment, medical, or other
                professional advice. You should consult qualified professionals where appropriate.
              </p>
            </section>

            <section className="mb-8">
              <h2 className="mb-3 text-xl font-semibold text-slate-900">4. Usage Limits</h2>
              <p className="text-slate-700">
                Use of the Service may be subject to plan-based limits (e.g., runs per month, models
                per run). We may modify limits, features, or pricing with reasonable notice where
                required by law. Continued use after changes constitutes acceptance unless applicable
                law provides otherwise.
              </p>
            </section>

            <section className="mb-8">
              <h2 className="mb-3 text-xl font-semibold text-slate-900">5. Your Responsibilities</h2>
              <p className="mb-3 text-slate-700">You agree that you are solely responsible for:</p>
              <ul className="mb-3 list-inside list-disc space-y-1 text-slate-700">
                <li>
                  Evaluating the accuracy and appropriateness of all outputs before reliance,
                  reproduction, or distribution
                </li>
                <li>Maintaining the confidentiality and security of your account credentials</li>
                <li>Using the Service in compliance with applicable laws and regulations</li>
                <li>Not using the Service for unlawful, harmful, fraudulent, or abusive purposes</li>
                <li>Not attempting to circumvent technical or usage restrictions</li>
                <li>Ensuring your inputs and your use of outputs comply with third-party providers&apos; terms</li>
              </ul>
            </section>

            <section className="mb-8">
              <h2 className="mb-3 text-xl font-semibold text-slate-900">6. Third-Party Services and Providers</h2>
              <p className="mb-3 text-slate-700">
                The Service depends on third-party AI providers and infrastructure. Your use may be
                subject to their terms and privacy policies. We do not control and are not
                responsible for third-party services. Links to provider terms are provided for
                convenience only:
              </p>
              <ul className="mb-3 list-inside list-disc space-y-1 text-slate-700">
                <li>
                  <a
                    href="https://openai.com/policies/terms-of-use"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sky-600 hover:underline"
                  >
                    OpenAI Terms of Use
                  </a>
                </li>
                <li>
                  <a
                    href="https://www.anthropic.com/legal/terms"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sky-600 hover:underline"
                  >
                    Anthropic Terms of Service
                  </a>
                </li>
                <li>
                  <a
                    href="https://ai.google.dev/gemini-api/terms"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sky-600 hover:underline"
                  >
                    Google AI / Gemini terms
                  </a>{" "}
                  (as applicable)
                </li>
                <li>
                  <a
                    href="https://x.ai/legal/terms"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sky-600 hover:underline"
                  >
                    X.AI Terms of Service
                  </a>
                </li>
                <li>
                  <a
                    href="https://www.perplexity.ai/terms"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sky-600 hover:underline"
                  >
                    Perplexity Terms of Service
                  </a>
                </li>
              </ul>
            </section>

            <section className="mb-8">
              <h2 className="mb-3 text-xl font-semibold text-slate-900">
                7. Trust Indicators, Scores, and Similar Outputs
              </h2>
              <p className="mb-3 text-slate-700">
                The Service may display trust signals, verification-style labels, consensus or
                confidence scores, evidence-quality labels, audit-style summaries, and similar
                derived outputs (&quot;Indicators&quot;). Indicators are heuristic, rules-based, or
                statistical summaries derived from model outputs. They are provided for
                informational and decision-support purposes only.
              </p>
              <p className="mb-3 text-slate-700">
                Indicators do not constitute factual certification, legal approval, regulatory
                clearance, financial advice, medical guidance, or authorization to act. No Indicator
                is a guarantee of accuracy, completeness, or fitness for any purpose. ConvergePanel
                disclaims liability for any action taken or not taken in reliance on any Indicator.
              </p>
            </section>

            <section className="mb-8">
              <h2 className="mb-3 text-xl font-semibold text-slate-900">8. Disclaimer of Warranties</h2>
              <p className="mb-3 text-slate-700 uppercase">
                To the fullest extent permitted by applicable law, the Service is provided &quot;as
                is&quot; and &quot;as available&quot; without warranties of any kind, whether express,
                implied, statutory, or otherwise, including implied warranties of merchantability,
                fitness for a particular purpose, title, quiet enjoyment, accuracy, or non-infringement.
                ConvergePanel does not warrant that the Service will be uninterrupted, error-free,
                secure, or free of harmful components, or that any content or output will meet your
                requirements or expectations.
              </p>
              <p className="text-slate-700">
                Some jurisdictions do not allow certain warranty exclusions; in those jurisdictions,
                our warranties are limited to the minimum extent permitted by law.
              </p>
            </section>

            <section className="mb-8">
              <h2 className="mb-3 text-xl font-semibold text-slate-900">9. Limitation of Liability</h2>
              <p className="mb-3 text-slate-700 uppercase">
                To the fullest extent permitted by applicable law, in no event will ConvergePanel, its
                affiliates, or their respective directors, officers, employees, contractors, or
                licensors be liable for any indirect, incidental, special, consequential, exemplary,
                or punitive damages, or any loss of profits, revenues, data, goodwill, or other
                intangible losses, arising out of or related to your access to or use of (or inability
                to use) the Service, any content or output obtained through the Service, or any
                reliance placed on such content or output, whether based on warranty, contract, tort
                (including negligence), strict liability, or any other legal theory, even if advised of
                the possibility of such damages.
              </p>
              <p className="mb-3 text-slate-700">
                To the fullest extent permitted by applicable law, ConvergePanel&apos;s aggregate
                liability for any claims arising out of or relating to the Service or these Terms
                shall not exceed the greater of (a) the amounts you paid ConvergePanel for the Service
                in the twelve (12) months preceding the claim, or (b) one hundred U.S. dollars (USD
                $100), if you have not paid fees during that period.
              </p>
              <p className="text-slate-700">
                The limitations in this section apply whether the alleged liability is based in
                contract, tort, negligence, strict liability, or any other theory, and even if a
                limited remedy fails of its essential purpose. Some jurisdictions do not allow certain
                limitations; in those jurisdictions, our liability is limited to the maximum extent
                permitted by law.
              </p>
            </section>

            <section className="mb-8">
              <h2 className="mb-3 text-xl font-semibold text-slate-900">10. Indemnification</h2>
              <p className="text-slate-700">
                To the fullest extent permitted by law, you agree to defend, indemnify, and hold
                harmless ConvergePanel and its affiliates and their respective officers, directors,
                employees, and agents from and against any claims, damages, obligations, losses,
                liabilities, costs, and expenses (including reasonable attorneys&apos; fees) arising
                from: (a) your use of the Service or any output; (b) your violation of these Terms or
                applicable law; or (c) your violation of any third-party right, including intellectual
                property or privacy rights. We may assume the exclusive defense and control of any
                matter subject to indemnification by you, at your expense.
              </p>
            </section>

            <section className="mb-8">
              <h2 className="mb-3 text-xl font-semibold text-slate-900">11. Changes to These Terms</h2>
              <p className="text-slate-700">
                We may modify these Terms from time to time. We will post the updated Terms and update
                the &quot;Last updated&quot; date. Where required by law, we will provide additional
                notice. Your continued use of the Service after changes become effective constitutes
                your acceptance of the revised Terms, except where prohibited by law.
              </p>
            </section>

            <section className="mb-8">
              <h2 className="mb-3 text-xl font-semibold text-slate-900">12. Contact</h2>
              <p className="text-slate-700">
                For questions about these Terms, contact{" "}
                <a href="mailto:support@convergepanel.com" className="text-sky-600 hover:underline">
                  support@convergepanel.com
                </a>
                .
              </p>
            </section>
          </div>

          <div className="mt-8 border-t border-slate-200 pt-6">
            <Link href="/" className="text-sm font-medium text-sky-600 hover:text-sky-700">
              ← Back to ConvergePanel
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
