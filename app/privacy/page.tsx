import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy Policy",
  description: "How ConvergePanel collects, uses, and protects your data.",
  alternates: { canonical: "/privacy" },
  openGraph: { url: "https://convergepanel.com/privacy", title: "Privacy Policy | ConvergePanel" },
};

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-10 sm:py-14">
      <h1 className="text-3xl font-semibold text-cp-text mb-2">Privacy Policy</h1>
      <p className="text-sm text-cp-muted mb-10">Last updated: June 14, 2026</p>

      <div className="space-y-10">
        <section>
          <h2 className="text-xl font-semibold text-cp-text mb-3">1. Introduction</h2>
          <p className="text-cp-muted mb-3">
            ConvergePanel (&quot;we&quot;, &quot;our&quot;, &quot;us&quot;) is committed to protecting your privacy. This
            Privacy Policy explains how we collect, use, and protect your information when you use
            the ConvergePanel web application or the ConvergePanel Verify browser extension.
          </p>
          <p className="text-cp-muted">
            This policy may be updated as we add features and improve our service.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-cp-text mb-3">2. Information We Collect</h2>
          <p className="text-cp-muted mb-3">We collect the following information:</p>
          <ul className="list-disc list-inside text-cp-muted space-y-1 mb-3">
            <li><strong className="text-cp-text">Account Information:</strong> Email address, display name (if provided)</li>
            <li><strong className="text-cp-text">Usage Data:</strong> Number of panel runs, selected models, question length (for analytics and quota management)</li>
            <li><strong className="text-cp-text">Technical Data:</strong> IP address, browser type, device information (for security and debugging)</li>
          </ul>
          <p className="text-cp-muted">
            We do <strong className="text-cp-text">not</strong> store the actual questions you ask or the AI responses
            you receive, except temporarily in server logs for debugging purposes (typically deleted within 7 days).
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-cp-text mb-3">3. How We Use Your Information</h2>
          <p className="text-cp-muted mb-3">We use your information to:</p>
          <ul className="list-disc list-inside text-cp-muted space-y-1 mb-3">
            <li>Provide and improve the ConvergePanel service</li>
            <li>Enforce usage quotas and plan limits</li>
            <li>Debug technical issues and improve reliability</li>
            <li>Send important service updates (via email)</li>
          </ul>
          <p className="text-cp-muted">
            We do <strong className="text-cp-text">not</strong> sell your data to third parties. We do{" "}
            <strong className="text-cp-text">not</strong> use your data for advertising or marketing purposes
            beyond essential service communications.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-cp-text mb-3">4. Chrome Extension — ConvergePanel Verify</h2>
          <p className="text-cp-muted mb-3">
            The ConvergePanel Verify browser extension lets you highlight text on any webpage,
            right-click, and open it in ConvergePanel for multi-model verification.
          </p>
          <ul className="list-disc list-inside text-cp-muted space-y-1 mb-3">
            <li>
              <strong className="text-cp-text">Selected text:</strong> When you trigger the context menu action,
              the highlighted text is passed as a URL parameter to convergepanel.com in a new tab.
              It is not sent anywhere else and is not stored by the extension itself.
            </li>
            <li>
              <strong className="text-cp-text">No background collection:</strong> The extension does not
              inject scripts into pages, does not monitor your browsing, and does not read page content
              unless you explicitly initiate a verification.
            </li>
            <li>
              <strong className="text-cp-text">Local storage:</strong> The extension temporarily stores
              the selected text and a timestamp in <code>chrome.storage.local</code> solely to prefill
              the verification form. This data is not transmitted to any server by the extension.
            </li>
          </ul>
          <p className="text-cp-muted">
            Once the verification tab opens, your use of the ConvergePanel web application is governed
            by the rest of this Privacy Policy.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-cp-text mb-3">5. Video Data</h2>
          <p className="text-cp-muted mb-3">
            When you use video verification, your video file is processed in your browser. ConvergePanel
            does not upload, store, or retain your complete video files on our servers. Only extracted
            frame images are transmitted to our servers for the duration of the analysis request. Frame
            data is sent to third-party AI model providers (including OpenAI, Anthropic, and Google) for
            analysis and is subject to their respective privacy policies. After analysis is complete,
            frame data is discarded. Only the analysis results, metadata, and model verdicts are stored
            in your account.
          </p>
          <p className="text-cp-muted">
            We do not share, sell, or use your video content or verification results for any purpose
            other than providing the verification service you requested.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-cp-text mb-3">6. Third-Party Services</h2>
          <p className="text-cp-muted mb-3">ConvergePanel uses the following third-party services:</p>
          <ul className="list-disc list-inside text-cp-muted space-y-2">
            <li>
              <strong className="text-cp-text">Firebase (Google):</strong> Authentication and database.{" "}
              <a href="https://firebase.google.com/support/privacy" target="_blank" rel="noopener noreferrer" className="text-sky-400 hover:underline">
                Firebase Privacy Policy
              </a>
            </li>
            <li>
              <strong className="text-cp-text">Stripe:</strong> Payment processing.{" "}
              <a href="https://stripe.com/privacy" target="_blank" rel="noopener noreferrer" className="text-sky-400 hover:underline">
                Stripe Privacy Policy
              </a>
            </li>
            <li>
              <strong className="text-cp-text">AI Model Providers:</strong> Your questions are sent to
              OpenAI, Anthropic, X.AI, and Perplexity. These providers may log requests per their own policies:
              <ul className="list-disc list-inside ml-6 mt-2 space-y-1">
                <li><a href="https://openai.com/policies/privacy-policy" target="_blank" rel="noopener noreferrer" className="text-sky-400 hover:underline">OpenAI Privacy Policy</a></li>
                <li><a href="https://www.anthropic.com/legal/privacy" target="_blank" rel="noopener noreferrer" className="text-sky-400 hover:underline">Anthropic Privacy Policy</a></li>
                <li><a href="https://x.ai/legal/privacy" target="_blank" rel="noopener noreferrer" className="text-sky-400 hover:underline">X.AI Privacy Policy</a></li>
                <li><a href="https://www.perplexity.ai/privacy" target="_blank" rel="noopener noreferrer" className="text-sky-400 hover:underline">Perplexity Privacy Policy</a></li>
              </ul>
            </li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-cp-text mb-3">7. Data Security</h2>
          <p className="text-cp-muted mb-3">We implement industry-standard security measures:</p>
          <ul className="list-disc list-inside text-cp-muted space-y-1 mb-3">
            <li>HTTPS encryption for all data in transit</li>
            <li>Firebase security rules to prevent unauthorized access</li>
            <li>Secure authentication via Firebase Auth</li>
            <li>Regular security updates and monitoring</li>
          </ul>
          <p className="text-cp-muted">
            No system is 100% secure. We cannot guarantee absolute security of your data.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-cp-text mb-3">8. Your Rights</h2>
          <p className="text-cp-muted mb-3">You have the right to:</p>
          <ul className="list-disc list-inside text-cp-muted space-y-1 mb-3">
            <li>Access your account data</li>
            <li>Delete your account and associated data</li>
            <li>Request a copy of your data</li>
            <li>Opt out of non-essential communications</li>
          </ul>
          <p className="text-cp-muted">
            To exercise these rights, contact us at{" "}
            <a href="mailto:support@convergepanel.com" className="text-sky-400 hover:underline">
              support@convergepanel.com
            </a>.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-cp-text mb-3">9. Changes to This Policy</h2>
          <p className="text-cp-muted">
            We may update this Privacy Policy at any time. We will notify you of significant changes
            via email or a notice on the service. The &quot;Last updated&quot; date at the top of this page
            reflects the most recent revision.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-cp-text mb-3">10. Contact</h2>
          <p className="text-cp-muted">
            Questions about this Privacy Policy? Contact us at{" "}
            <a href="mailto:support@convergepanel.com" className="text-sky-400 hover:underline">
              support@convergepanel.com
            </a>.
          </p>
        </section>
      </div>

      <div className="mt-12 pt-6 border-t border-cp-border">
        <Link href="/" className="text-sm text-sky-400 hover:underline font-medium">
          ← Back to ConvergePanel
        </Link>
      </div>
    </main>
  );
}
