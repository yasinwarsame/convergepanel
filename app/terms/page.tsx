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

            <section className="mb-8 rounded-lg border border-slate-300 bg-slate-50 p-6">
              <h2 className="mb-4 text-xl font-semibold text-slate-900">8. Verification Services Disclaimer</h2>
              <p className="mb-4 text-sm font-semibold uppercase tracking-wide text-slate-800">
                Verification Services Disclaimer
              </p>
              <p className="mb-4 text-slate-700">
                ConvergePanel provides AI-assisted verification tools including multi-model research, claim
                verification, and video authenticity review. These services are provided for informational and
                decision-support purposes only.
              </p>
              <ol className="mb-4 list-decimal space-y-3 pl-5 text-slate-700">
                <li>
                  <strong>NOT FORENSIC ANALYSIS.</strong> ConvergePanel does not perform forensic analysis,
                  digital forensics, or expert examination of any kind. Our video verification, claim verification,
                  and research features use general-purpose AI language and vision models to provide indicators and
                  signals. They do not constitute forensic evidence, expert testimony, or scientific analysis.
                </li>
                <li>
                  <strong>NO GUARANTEE OF ACCURACY.</strong> AI models may produce incorrect, incomplete, or
                  misleading results. Results may include false positives (flagging authentic content as
                  manipulated) and false negatives (failing to detect manipulation in altered content).
                  ConvergePanel does not guarantee the accuracy, completeness, reliability, or fitness for any
                  particular purpose of any verification result.
                </li>
                <li>
                  <strong>NOT LEGAL EVIDENCE.</strong> Verification results from ConvergePanel must not be used as
                  evidence in legal proceedings, court filings, regulatory submissions, insurance claims,
                  employment decisions, or any context where forensic-grade analysis is required. Users who require
                  forensic analysis should engage qualified forensic analysts, certified digital forensics
                  examiners, or other appropriately credentialed professionals.
                </li>
                <li>
                  <strong>NOT A SUBSTITUTE FOR PROFESSIONAL JUDGMENT.</strong> Results are intended to inform
                  human judgment, not replace it. Users are solely responsible for any decisions made based on
                  ConvergePanel&apos;s output. No verification result should be the sole basis for any
                  consequential action.
                </li>
                <li>
                  <strong>AI MODEL LIMITATIONS.</strong> ConvergePanel queries third-party AI models (including but
                  not limited to OpenAI GPT, Anthropic Claude, Google Gemini, xAI Grok, and Perplexity). These
                  models have known limitations including hallucination, training data biases, inconsistent
                  reasoning, and variable performance across domains and content types. Model capabilities and
                  limitations change over time without notice.
                </li>
                <li>
                  <strong>VIDEO VERIFICATION SPECIFIC LIMITATIONS.</strong> Video verification analyzes static
                  frames extracted from video files. It cannot assess real-time motion, audio-visual
                  synchronization, or temporal artifacts that are only visible in continuous playback. Heavily
                  compressed video may produce unreliable results. The absence of manipulation indicators does not
                  confirm authenticity. The presence of manipulation indicators does not confirm forgery.
                </li>
                <li>
                  <strong>NO WARRANTY.</strong> ALL VERIFICATION SERVICES ARE PROVIDED &quot;AS IS&quot; AND
                  &quot;AS AVAILABLE&quot; WITHOUT WARRANTIES OF ANY KIND, EITHER EXPRESS OR IMPLIED, INCLUDING
                  BUT NOT LIMITED TO IMPLIED WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE,
                  ACCURACY, OR NON-INFRINGEMENT.
                </li>
              </ol>
            </section>

            <section className="mb-8 rounded-lg border border-slate-300 bg-slate-50 p-6">
              <h2 className="mb-4 text-xl font-semibold text-slate-900">9. Limitation of Liability</h2>
              <p className="mb-4 text-sm font-semibold uppercase tracking-wide text-slate-800">
                Limitation of Liability
              </p>
              <p className="mb-4 font-semibold text-slate-800">TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW:</p>
              <ol className="mb-4 list-decimal space-y-3 pl-5 text-slate-700">
                <li>
                  CONVERGEPANEL, ITS FOUNDERS, OFFICERS, EMPLOYEES, AGENTS, AND AFFILIATES SHALL NOT BE LIABLE FOR
                  ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, PUNITIVE, OR EXEMPLARY DAMAGES ARISING OUT OF OR
                  RELATED TO YOUR USE OF THE VERIFICATION SERVICES, INCLUDING BUT NOT LIMITED TO DAMAGES FOR LOSS
                  OF PROFITS, GOODWILL, REPUTATION, DATA, OR OTHER INTANGIBLE LOSSES.
                </li>
                <li>
                  CONVERGEPANEL&apos;S TOTAL AGGREGATE LIABILITY ARISING OUT OF OR RELATED TO THESE TERMS OR YOUR
                  USE OF THE SERVICES SHALL NOT EXCEED THE AMOUNTS PAID BY YOU TO CONVERGEPANEL IN THE TWELVE (12)
                  MONTHS PRECEDING THE CLAIM, OR ONE HUNDRED U.S. DOLLARS (USD $100) IF YOU HAVE NOT PAID FEES
                  DURING THAT PERIOD, WHICHEVER IS GREATER WHERE PERMITTED BY LAW.
                </li>
                <li>
                  CONVERGEPANEL SHALL NOT BE LIABLE FOR ANY ACTIONS TAKEN OR DECISIONS MADE BY YOU OR ANY THIRD
                  PARTY IN RELIANCE ON VERIFICATION RESULTS, INCLUDING BUT NOT LIMITED TO:
                  <ul className="mt-2 list-[lower-alpha] space-y-1 pl-5">
                    <li>Publishing or distributing content based on verification results</li>
                    <li>Accusations of fraud, forgery, or manipulation based on verification results</li>
                    <li>Legal, regulatory, or compliance actions taken based on verification results</li>
                    <li>Business, investment, or employment decisions based on verification results</li>
                    <li>Reputational harm to any party resulting from the interpretation of verification results</li>
                  </ul>
                </li>
                <li>
                  YOU ACKNOWLEDGE THAT AI VERIFICATION TOOLS ARE AN EMERGING TECHNOLOGY WITH INHERENT LIMITATIONS
                  AND THAT YOU ASSUME ALL RISK ASSOCIATED WITH RELYING ON SUCH TOOLS.
                </li>
              </ol>
              <p className="text-slate-700">
                Some jurisdictions do not allow certain limitations; in those jurisdictions, our liability is
                limited to the maximum extent permitted by law.
              </p>
            </section>

            <section className="mb-8 rounded-lg border border-slate-300 bg-slate-50 p-6">
              <h2 className="mb-4 text-xl font-semibold text-slate-900">10. Indemnification</h2>
              <p className="mb-4 text-sm font-semibold uppercase tracking-wide text-slate-800">Indemnification</p>
              <p className="mb-4 text-slate-700">
                To the fullest extent permitted by law, you agree to indemnify, defend, and hold harmless
                ConvergePanel, its founders, officers, employees, agents, and affiliates from and against any and
                all claims, damages, losses, liabilities, costs, and expenses (including reasonable attorneys&apos;
                fees) arising out of or related to:
              </p>
              <ol className="mb-4 list-decimal space-y-2 pl-5 text-slate-700">
                <li>Your use of the Service or any output</li>
                <li>Your violation of these Terms or applicable law</li>
                <li>Your violation of any third-party right, including intellectual property or privacy rights</li>
                <li>Your use of verification results in any legal, regulatory, or evidentiary context</li>
                <li>
                  Any claim by a third party that your use of verification results caused harm, including
                  reputational harm, financial harm, or violation of rights
                </li>
                <li>
                  Your misrepresentation of verification results as forensic analysis, expert testimony, or
                  definitive proof
                </li>
              </ol>
              <p className="text-slate-700">
                We may assume the exclusive defense and control of any matter subject to indemnification by you, at
                your expense.
              </p>
            </section>

            <section className="mb-8 rounded-lg border border-amber-200 bg-amber-50/80 p-6">
              <h2 className="mb-4 text-xl font-semibold text-slate-900">11. Acceptable Use (Verification)</h2>
              <p className="mb-4 text-sm font-semibold uppercase tracking-wide text-slate-800">Acceptable Use</p>
              <p className="mb-3 text-slate-800">You agree NOT to:</p>
              <ol className="list-decimal space-y-2 pl-5 text-slate-800">
                <li>
                  Represent ConvergePanel verification results as forensic analysis, expert opinion, or definitive
                  proof of authenticity or manipulation
                </li>
                <li>
                  Use verification results as the sole basis for legal action, public accusation, or defamatory
                  statements against any person or entity
                </li>
                <li>
                  Submit verification results as evidence in legal proceedings without clearly disclosing their
                  nature as AI-generated indicators, not forensic analysis
                </li>
                <li>Use the service to systematically discredit legitimate content or to support disinformation campaigns</li>
                <li>Remove, obscure, or modify disclaimers that accompany verification results</li>
              </ol>
            </section>

            <section className="mb-8">
              <h2 className="mb-3 text-xl font-semibold text-slate-900">12. Disclaimer of Warranties</h2>
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
              <h2 className="mb-3 text-xl font-semibold text-slate-900">13. Changes to These Terms</h2>
              <p className="text-slate-700">
                We may modify these Terms from time to time. We will post the updated Terms and update
                the &quot;Last updated&quot; date. Where required by law, we will provide additional
                notice. Your continued use of the Service after changes become effective constitutes
                your acceptance of the revised Terms, except where prohibited by law.
              </p>
            </section>

            <section className="mb-8">
              <h2 className="mb-3 text-xl font-semibold text-slate-900">14. Contact</h2>
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
