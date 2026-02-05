/**
 * Privacy Policy Page
 * 
 * Basic privacy policy for ConvergePanel.
 * This is a draft that should be reviewed by legal counsel before production launch.
 */

import Link from "next/link";

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-slate-50 py-10 px-4">
      <div className="max-w-3xl mx-auto">
        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-8">
          <h1 className="text-3xl font-semibold text-slate-900 mb-6">Privacy Policy</h1>
          
          <div className="prose prose-slate max-w-none">
            <p className="text-sm text-slate-600 mb-6">
              <strong>Last updated:</strong> {new Date().toLocaleDateString()}
            </p>

            <section className="mb-8">
              <h2 className="text-xl font-semibold text-slate-900 mb-3">1. Introduction</h2>
              <p className="text-slate-700 mb-3">
                ConvergePanel ("we", "our", "us") is committed to protecting your privacy. This
                Privacy Policy explains how we collect, use, and protect your information.
              </p>
              <p className="text-slate-700">
                This is an early-stage product. This policy may be updated as we add features and
                improve our service.
              </p>
            </section>

            <section className="mb-8">
              <h2 className="text-xl font-semibold text-slate-900 mb-3">2. Information We Collect</h2>
              <p className="text-slate-700 mb-3">
                We collect the following information:
              </p>
              <ul className="list-disc list-inside text-slate-700 mb-3 space-y-1">
                <li><strong>Account Information:</strong> Email address, display name (if provided)</li>
                <li><strong>Usage Data:</strong> Number of panel runs, selected models, question length (for analytics and quota management)</li>
                <li><strong>Technical Data:</strong> IP address, browser type, device information (for security and debugging)</li>
              </ul>
              <p className="text-slate-700">
                We do <strong>not</strong> store the actual questions you ask or the AI responses
                you receive, except temporarily in server logs for debugging purposes (typically
                deleted within 7 days).
              </p>
            </section>

            <section className="mb-8">
              <h2 className="text-xl font-semibold text-slate-900 mb-3">3. How We Use Your Information</h2>
              <p className="text-slate-700 mb-3">
                We use your information to:
              </p>
              <ul className="list-disc list-inside text-slate-700 mb-3 space-y-1">
                <li>Provide and improve the ConvergePanel service</li>
                <li>Enforce usage quotas and plan limits</li>
                <li>Debug technical issues and improve reliability</li>
                <li>Send important service updates (via email)</li>
              </ul>
              <p className="text-slate-700">
                We do <strong>not</strong> sell your data to third parties. We do <strong>not</strong> use
                your data for advertising or marketing purposes beyond essential service communications.
              </p>
            </section>

            <section className="mb-8">
              <h2 className="text-xl font-semibold text-slate-900 mb-3">4. Third-Party Services</h2>
              <p className="text-slate-700 mb-3">
                ConvergePanel uses the following third-party services:
              </p>
              <ul className="list-disc list-inside text-slate-700 mb-3 space-y-1">
                <li><strong>Firebase (Google):</strong> Authentication and database services. See{" "}
                  <a href="https://firebase.google.com/support/privacy" target="_blank" rel="noopener noreferrer" className="text-sky-600 hover:underline">
                    Firebase Privacy Policy
                  </a>
                </li>
                <li><strong>AI Model Providers:</strong> Your questions are sent to OpenAI, Anthropic,
                  X.AI, and Perplexity. These providers may log your requests according to their
                  own privacy policies. We recommend reviewing their policies:
                </li>
                <ul className="list-disc list-inside ml-6 mt-2 space-y-1">
                  <li><a href="https://openai.com/policies/privacy-policy" target="_blank" rel="noopener noreferrer" className="text-sky-600 hover:underline">OpenAI Privacy Policy</a></li>
                  <li><a href="https://www.anthropic.com/legal/privacy" target="_blank" rel="noopener noreferrer" className="text-sky-600 hover:underline">Anthropic Privacy Policy</a></li>
                  <li><a href="https://x.ai/legal/privacy" target="_blank" rel="noopener noreferrer" className="text-sky-600 hover:underline">X.AI Privacy Policy</a></li>
                  <li><a href="https://www.perplexity.ai/privacy" target="_blank" rel="noopener noreferrer" className="text-sky-600 hover:underline">Perplexity Privacy Policy</a></li>
                </ul>
              </ul>
            </section>

            <section className="mb-8">
              <h2 className="text-xl font-semibold text-slate-900 mb-3">5. Data Security</h2>
              <p className="text-slate-700 mb-3">
                We implement industry-standard security measures to protect your data:
              </p>
              <ul className="list-disc list-inside text-slate-700 mb-3 space-y-1">
                <li>HTTPS encryption for all data in transit</li>
                <li>Firebase security rules to prevent unauthorized access</li>
                <li>Secure authentication via Firebase Auth</li>
                <li>Regular security updates and monitoring</li>
              </ul>
              <p className="text-slate-700">
                However, no system is 100% secure. We cannot guarantee absolute security of your data.
              </p>
            </section>

            <section className="mb-8">
              <h2 className="text-xl font-semibold text-slate-900 mb-3">6. Your Rights</h2>
              <p className="text-slate-700 mb-3">
                You have the right to:
              </p>
              <ul className="list-disc list-inside text-slate-700 mb-3 space-y-1">
                <li>Access your account data</li>
                <li>Delete your account and associated data</li>
                <li>Request a copy of your data</li>
                <li>Opt out of non-essential communications</li>
              </ul>
              <p className="text-slate-700">
                To exercise these rights, contact us at{" "}
                <a href="mailto:support@convergepanel.com" className="text-sky-600 hover:underline">
                  support@convergepanel.com
                </a>.
              </p>
            </section>

            <section className="mb-8">
              <h2 className="text-xl font-semibold text-slate-900 mb-3">7. Changes to This Policy</h2>
              <p className="text-slate-700">
                We may update this Privacy Policy at any time. We will notify you of significant
                changes via email or a notice on the service.
              </p>
            </section>

            <section className="mb-8">
              <h2 className="text-xl font-semibold text-slate-900 mb-3">8. Contact</h2>
              <p className="text-slate-700">
                If you have questions about this Privacy Policy, please contact us at{" "}
                <a href="mailto:support@convergepanel.com" className="text-sky-600 hover:underline">
                  support@convergepanel.com
                </a>.
              </p>
            </section>
          </div>

          <div className="mt-8 pt-6 border-t border-slate-200">
            <Link
              href="/"
              className="text-sm text-sky-600 hover:text-sky-700 font-medium"
            >
              ← Back to ConvergePanel
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}

