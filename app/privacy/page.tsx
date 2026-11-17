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
      {/* OWNER/LEGAL VERIFY: date intentionally left unchanged in this draft. Set the real revision date only when the corrected policy is approved for publication (D-12). */}
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
            <li>
              <strong className="text-cp-text">Account Information:</strong> Email address, display name (if
              provided), the answers you give during onboarding (such as your role, use case, how often you
              expect to use the app and how you heard about us), your plan and subscription status, the
              identifiers our payment processor assigns to you, and your team and workspace memberships
            </li>
            <li>
              <strong className="text-cp-text">Invitations:</strong> If you invite someone to a team workspace, we
              store the invitee&apos;s email address and the invitation details, and we send them an invitation
              email that includes your name and the workspace name
            </li>
            <li>
              <strong className="text-cp-text">Content You Submit and Your Results:</strong> The claims, questions,
              context and video information you submit, and the results produced for them (see below)
            </li>
            <li><strong className="text-cp-text">Usage Data:</strong> Number of runs, which models you selected, token usage, plan limits and usage counters, and product-analytics events about how you use the app</li>
            <li><strong className="text-cp-text">Technical Data:</strong> IP address, browser type, device information, the addresses of the pages you visit, and error reports</li>
          </ul>
          {/* OWNER/LEGAL VERIFY: onboarding answers are stored on users/{uid} and sent to PostHog (app/onboarding/page.tsx:150-155). Stripe customer/subscription ids are stored on users/{uid}. Invitee data: lib/email/workspaceInvitations.ts (Resend). */}
          <p className="text-cp-muted mb-3">
            <strong className="text-cp-text">What we store.</strong> When you are signed in and run a Claim
            Verification, we store the claim you submit (up to 2,000 characters) and the structured results each
            AI model returns (its verdict, confidence, summary and the parts it found correct, incorrect or
            unverifiable), together with consensus scores and an audit record of the run. When you run Deep
            Research, we store your question, any context you provide, the answers the AI models return, the
            combined summary report and related analysis, and review and governance records for the run. For
            Video Verification, see Section 6. We use this to show your history, let you reopen results, and
            support review and governance features. For Claim Verification, we do not store the raw, unprocessed
            responses from AI providers.
          </p>
          {/* OWNER/LEGAL VERIFY: Deep Research storage confirmed in lib/firestore/runs.ts (question, questionContext, per-model answer text capped for storage, governance/review records) but was outside the scope of audit 01's end-to-end trace. */}
          <p className="text-cp-muted mb-3">
            On paid plans, an excerpt of each claim or question (up to its first 200 characters) is also recorded
            in an audit log used for governance and administration, together with your account ID or email
            address. If your account belongs to a team, a copy of the content you run is also kept for that team
            (see Section 8).
          </p>
          <p className="text-cp-muted mb-3">
            <strong className="text-cp-text">How long we keep it.</strong> We keep stored content and account data
            until it is deleted (see Section 9). We do not currently delete it automatically after a fixed period.
            We may also delete stored content ourselves, for example as part of data cleanup.
          </p>
          {/* OWNER/LEGAL VERIFY: no TTL or scheduled purge exists for verifications, audit-log copies or team copies (audit 01 §C); admin purge-runs exists for research runs only. If the owner adopts a fixed retention period, it must be implemented before it is stated here (D-3). */}
          <p className="text-cp-muted">
            <strong className="text-cp-text">Logs.</strong> Our hosting and monitoring providers keep technical
            logs. These logs can include identifiers such as your account ID and, in some cases, short excerpts of
            what you submit or of AI model output. Retention periods for these logs, and for database backups, are
            being established, and we will update this policy when they are set.
          </p>
          {/* OWNER/LEGAL VERIFY: log and backup retention are UNKNOWN (10- A4/A5; 01 U1-U3, U6-U7). Do not publish a number until confirmed. */}
        </section>

        <section>
          <h2 className="text-xl font-semibold text-cp-text mb-3">3. Cookies and Browser Storage</h2>
          <p className="text-cp-muted mb-3">The app uses cookies and browser storage on your device:</p>
          <ul className="list-disc list-inside text-cp-muted space-y-1 mb-3">
            <li>
              <strong className="text-cp-text">Sign-in (essential):</strong> a secure, HTTP-only session cookie,
              and the sign-in state that Firebase Authentication keeps in your browser
            </li>
            <li>
              <strong className="text-cp-text">History cache:</strong> to load your history faster, the app keeps a
              copy of your recent results, including the claims and questions you submitted, in your
              browser&apos;s local storage on that device. This copy stays after you sign out
            </li>
            <li>
              <strong className="text-cp-text">App settings:</strong> small values such as your plan information
              for the current tab and whether you have acknowledged the video upload notice
            </li>
            <li>
              <strong className="text-cp-text">Analytics and monitoring (not essential):</strong> PostHog stores an
              identifier in a cookie and in local storage, and Sentry stores a session identifier for session
              replay (see Section 7)
            </li>
          </ul>
          <p className="text-cp-muted">
            You can remove all of these by clearing this site&apos;s data in your browser. The app does not
            currently offer a setting to turn off analytics or monitoring.
          </p>
          {/* OWNER/LEGAL VERIFY: no cookie/consent banner or analytics opt-out exists in code. PostHog persistence is the SDK default (cookie + localStorage), not set in code. Counsel to confirm whether consent is required for PostHog/Sentry storage in the jurisdictions served (ePrivacy / UK PECR). */}
        </section>

        <section>
          <h2 className="text-xl font-semibold text-cp-text mb-3">4. How We Use Your Information</h2>
          <p className="text-cp-muted mb-3">We use your information to:</p>
          <ul className="list-disc list-inside text-cp-muted space-y-1 mb-3">
            <li>Provide and improve the ConvergePanel service</li>
            <li>Show your history and let you reopen your results</li>
            <li>Support team, review, governance and audit features</li>
            <li>Enforce usage quotas and plan limits, and process payments</li>
            <li>Debug technical issues, monitor errors and improve reliability</li>
            <li>Understand how the product is used (product analytics)</li>
            <li>
              Send essential service emails, such as email verification, password reset and team workspace
              invitations
            </li>
          </ul>
          <p className="text-cp-muted">
            Essential service emails are part of providing the service. Product analytics are not required to
            provide the service. We do <strong className="text-cp-text">not</strong> sell your data to third
            parties. We do <strong className="text-cp-text">not</strong> use your data for advertising or
            marketing purposes beyond essential service communications.
          </p>
          {/* OWNER/LEGAL VERIFY: counsel to confirm lawful basis / purpose statements for each use, including product analytics (R-D6). */}
        </section>

        <section>
          <h2 className="text-xl font-semibold text-cp-text mb-3">5. Chrome Extension — ConvergePanel Verify</h2>
          <p className="text-cp-muted mb-3">
            The ConvergePanel Verify browser extension lets you highlight text on any webpage,
            right-click, and open it in ConvergePanel for multi-model verification.
          </p>
          <ul className="list-disc list-inside text-cp-muted space-y-1 mb-3">
            <li>
              <strong className="text-cp-text">Selected text:</strong> When you trigger the context menu action,
              the highlighted text is passed as a URL parameter to convergepanel.com in a new tab. The extension
              does not send it anywhere else. Because the text is part of the address of the ConvergePanel page
              that opens, it is handled as described in this policy, including by our hosting logs, error
              monitoring and analytics (see Section 7).
            </li>
            <li>
              <strong className="text-cp-text">No background collection:</strong> The extension does not
              inject scripts into pages, does not monitor your browsing, and does not read page content
              unless you explicitly initiate a verification.
            </li>
            <li>
              <strong className="text-cp-text">Local storage:</strong> The extension keeps the most recently
              selected text and a timestamp in <code>chrome.storage.local</code> to prefill the verification
              form, until you select new text or remove the extension. The extension does not transmit this
              stored data to any server.
            </li>
          </ul>
          <p className="text-cp-muted">
            Once the verification tab opens, your use of the ConvergePanel web application is governed
            by the rest of this Privacy Policy.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-cp-text mb-3">6. Video Data</h2>
          <p className="text-cp-muted mb-3">
            When you use video verification, your video file is processed in your browser. ConvergePanel
            does not upload, store, or retain your complete video files on our servers. Only extracted
            frame images, together with the file name and basic technical details of the video (such as its
            duration, dimensions and format), are transmitted to our servers for the analysis request. The frames
            and these details are sent to OpenAI, Anthropic and Google for analysis, regardless of which models
            you select elsewhere, and are subject to their respective terms. After analysis is complete, frame
            images are discarded.
          </p>
          <p className="text-cp-muted mb-3">
            We store the analysis results, the model verdicts, the file name and video details, and your account
            email with the verification. As with other content, an audit-log entry (which can include the file
            name) may be recorded on paid plans, and a copy is kept for your team if you run it in a team
            workspace.
          </p>
          {/* OWNER/LEGAL VERIFY: video path from independent review R1 (app/api/verify-video/route.ts:242,320-349; lib/video/videoVerificationPrompt.ts:21-30; lib/video/visionCalls.ts) — not traced end to end in audit 01. Confirm stored fields in videoVerifications and audit-log contents. */}
          <p className="text-cp-muted">
            We do not sell your video content or verification results or use them for advertising. They are
            accessed and shared only as described in this policy (see Sections 7 and 8).
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-cp-text mb-3">7. Third-Party Services</h2>
          <p className="text-cp-muted mb-3">
            ConvergePanel uses the following third-party services. The first group is needed to provide the
            service; the second group is used for monitoring and analytics.
          </p>
          <ul className="list-disc list-inside text-cp-muted space-y-2 mb-4">
            <li>
              <strong className="text-cp-text">Firebase (Google):</strong> Authentication, sign-in emails (such as
              email verification and password reset) and database. The content and account data described in
              Section 2 are stored here.{" "}
              <a href="https://firebase.google.com/support/privacy" target="_blank" rel="noopener noreferrer" className="text-sky-600 hover:underline">
                Firebase Privacy Policy
              </a>
            </li>
            <li>
              <strong className="text-cp-text">Vercel:</strong> Hosting and server logs. Vercel receives the
              requests your browser makes to ConvergePanel, including page addresses, and our server logs.{" "}
              <a href="https://vercel.com/legal/privacy-policy" target="_blank" rel="noopener noreferrer" className="text-sky-600 hover:underline">
                Vercel Privacy Policy
              </a>
            </li>
            <li>
              <strong className="text-cp-text">Stripe:</strong> Payment processing. Stripe receives your email
              address and your ConvergePanel account ID, and handles your payment details directly.{" "}
              <a href="https://stripe.com/privacy" target="_blank" rel="noopener noreferrer" className="text-sky-600 hover:underline">
                Stripe Privacy Policy
              </a>
            </li>
            <li>
              <strong className="text-cp-text">Resend:</strong> Delivery of team workspace invitation emails. Resend
              receives the invitee&apos;s email address, the inviter&apos;s name, the workspace name, the role and
              the invitation link.{" "}
              <a href="https://resend.com/legal/privacy-policy" target="_blank" rel="noopener noreferrer" className="text-sky-600 hover:underline">
                Resend Privacy Policy
              </a>
            </li>
            {/* OWNER/LEGAL VERIFY: Resend is live only if RESEND_API_KEY is set in Production (UNVERIFIED, 10- A9). Confirm the Resend privacy-policy URL. */}
            <li>
              <strong className="text-cp-text">AI Model Providers:</strong> To produce results, the text you
              submit is sent to the AI providers whose models you select: OpenAI, Anthropic, Google (Gemini API),
              xAI (Grok) and Perplexity. Perplexity also runs a live web search based on the text you submit.
              For Deep Research, your question and context, and all the model answers, are also sent to Google
              (Gemini API) to classify the question, compare the answers, check for bias and coverage, and write
              the summary report, whether or not you selected a Google model. Deep Research answers may also be
              sent to OpenAI (or Anthropic, as a fallback) to produce a combined summary. Video frames are sent as
              described in Section 6. We do not send your name, email address or account ID to these providers.
              Each provider handles the data it receives under its own terms and may log requests under its own
              policies.
              {/* OWNER/LEGAL VERIFY: Gemini auxiliary calls (classifier.ts, alignment.ts, biasDetection.ts, coverageAudit.ts, synthesisReport.ts via orchestrate.ts) run only when ADAPTIVE_SCHEMAS_ENABLED is true or the user is a canary uid (env.ts:74,92). Production value UNVERIFIED (10- A5). Keep this sentence unless confirmed off. */}
              {" "}For Deep Research, where our fallback is enabled, if a selected model is temporarily unavailable,
              your question and context may be sent to DeepSeek instead. DeepSeek states that it processes and
              stores data in the People&apos;s Republic of China.
              {/* OWNER/LEGAL VERIFY: DeepSeek fallback (lib/panel.ts) is active only when DEEPSEEK_API_KEY is set in Production — UNKNOWN (10- A5). Default slots are OpenAI/Anthropic/Google; PANEL_DEEPSEEK_FALLBACK_FOR can change them. Keep the sentence if the key is set; remove it if the fallback is disabled. DeepSeek is not reachable from Claim Verification. */}
              {/* OWNER/LEGAL VERIFY: no training, retention, region, ZDR or DPA statements are made here on purpose (03 Part C; 10- §4). Gemini paid/unpaid tier, OpenAI/Anthropic opt-in and feedback settings, xAI ZDR status and DPAs are unverified (10- A1-A3). Counsel to decide whether provider-level detail is required. */}
              <ul className="list-disc list-inside ml-6 mt-2 space-y-1">
                <li><a href="https://openai.com/policies/privacy-policy" target="_blank" rel="noopener noreferrer" className="text-sky-600 hover:underline">OpenAI Privacy Policy</a></li>
                <li><a href="https://www.anthropic.com/legal/privacy" target="_blank" rel="noopener noreferrer" className="text-sky-600 hover:underline">Anthropic Privacy Policy</a></li>
                <li><a href="https://ai.google.dev/gemini-api/terms" target="_blank" rel="noopener noreferrer" className="text-sky-600 hover:underline">Google Gemini API Terms</a></li>
                <li><a href="https://x.ai/legal/privacy" target="_blank" rel="noopener noreferrer" className="text-sky-600 hover:underline">xAI Privacy Policy</a></li>
                <li><a href="https://www.perplexity.ai/hub/legal/perplexity-api-terms-of-service" target="_blank" rel="noopener noreferrer" className="text-sky-600 hover:underline">Perplexity API Terms of Service</a></li>
                <li><a href="https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html" target="_blank" rel="noopener noreferrer" className="text-sky-600 hover:underline">DeepSeek Privacy Policy</a></li>
              </ul>
            </li>
          </ul>
          {/* OWNER/LEGAL VERIFY: Sentry and PostHog are wired in code (instrumentation-client.ts, sentry.server.config.ts, components/PostHogProvider.tsx); whether each is live in Production depends on SENTRY_DSN / NEXT_PUBLIC_SENTRY_DSN / NEXT_PUBLIC_POSTHOG_KEY (10- A5-A7). Wording describes current code at cabbdbb (sendDefaultPii true; replay 5% + 100% on error; PostHog autocapture and session recording not disabled in code; full URLs incl. query). Do not narrow it until a fix (e.g. PR #329) is deployed to Production. */}
          <ul className="list-disc list-inside text-cp-muted space-y-2">
            <li>
              <strong className="text-cp-text">Sentry:</strong> Error monitoring, and session replay for a sample of
              sessions and for sessions in which an error occurs. Sentry receives your IP address, user and
              technical details about errors, and the addresses of the pages you visit. Session replay records
              what happens on the page.{" "}
              <a href="https://sentry.io/privacy/" target="_blank" rel="noopener noreferrer" className="text-sky-600 hover:underline">
                Sentry Privacy Policy
              </a>
            </li>
            <li>
              <strong className="text-cp-text">PostHog (United States):</strong> Product analytics. PostHog
              receives the pages you visit, including the full page address; your account ID, email address and,
              if you provide it at sign-up, your name; your onboarding answers; errors in the app; and events about
              how you interact with the app, which can include the text of buttons and items you click (such as the
              beginning of a claim or question shown in your history). A page address can include text you passed
              to ConvergePanel through a link or the browser extension. Our servers also send PostHog information
              about Deep Research question classification and subscription events (including subscription
              identifiers).{" "}
              <a href="https://posthog.com/privacy" target="_blank" rel="noopener noreferrer" className="text-sky-600 hover:underline">
                PostHog Privacy Policy
              </a>
            </li>
          </ul>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-cp-text mb-3">8. Data Security and Access</h2>
          <p className="text-cp-muted mb-3">We implement industry-standard security measures:</p>
          {/* OWNER/LEGAL VERIFY: "Firebase security rules" reflects the repo firestore.rules; deployed rules have drifted before (01 U5 / 10- A4). Confirm the live ruleset. */}
          <ul className="list-disc list-inside text-cp-muted space-y-1 mb-3">
            <li>HTTPS encryption for all data in transit</li>
            <li>Firebase security rules to prevent unauthorized access</li>
            <li>Secure authentication via Firebase Auth</li>
            <li>Regular security updates and monitoring</li>
          </ul>
          <p className="text-cp-muted mb-3">
            <strong className="text-cp-text">Who can see your content.</strong> Authorized ConvergePanel staff can
            access stored content, together with the account email it belongs to, to operate, support and secure
            the service. If you work in a Team or Team Workspace, or your account belongs to a team, the content
            you create there is visible to that team&apos;s administrators and, where applicable, its members and
            the reviewers they appoint.
          </p>
          {/* OWNER/LEGAL VERIFY: staff access = ADMIN_PORTAL tier (ADMIN_EMAILS allowlist) can list all users' claims with email (app/api/admin/runs). Legacy team admins see every member's teamRuns rows incl. claim + email. Owner accepts this disclosure or narrows access first (R-C4) (D-7). */}
          <p className="text-cp-muted">
            No system is 100% secure. We cannot guarantee absolute security of your data.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-cp-text mb-3">9. Your Rights</h2>
          <p className="text-cp-muted mb-3">You have the right to:</p>
          <ul className="list-disc list-inside text-cp-muted space-y-1 mb-3">
            <li>Access your account data</li>
            <li>Ask us to delete your account and associated data</li>
            <li>Request a copy of your data</li>
            <li>Opt out of non-essential communications</li>
          </ul>
          <p className="text-cp-muted mb-3">
            To exercise these rights, contact us at{" "}
            <a href="mailto:support@convergepanel.com" className="text-sky-600 hover:underline">
              support@convergepanel.com
            </a>.
          </p>
          <p className="text-cp-muted">
            The app does not currently let you delete your account or individual verifications yourself, so
            deletion requests are handled by email. Our current account deletion removes your sign-in account and
            profile. Other stored records, such as verifications, research, audit-log entries and team copies, are
            not removed automatically by that step, and copies may remain in backups, in logs, in our analytics
            and monitoring tools, and in our providers&apos; systems under their terms. We cannot currently
            guarantee complete deletion. You can remove the copy kept on your own device by clearing this
            site&apos;s data in your browser.
          </p>
          {/* OWNER/LEGAL VERIFY: accurate to current code (app/api/admin/users/[uid]/route.ts removes only the Auth user and users/{uid}; no user DELETE route). Owner decides whether to commit to manual deletion of remaining records; counsel confirms adequacy. A tested deletion workflow (R-B1/R-B2) is recommended before any stronger promise. Data copies are a manual job; no response time is promised (D-6, D-11). Analytics/monitoring vendor deletion is manual (10- S16-S18). */}
        </section>

        <section>
          <h2 className="text-xl font-semibold text-cp-text mb-3">10. Changes to This Policy</h2>
          <p className="text-cp-muted">
            We may update this Privacy Policy at any time. When we make significant changes, we will update the
            &quot;Last updated&quot; date at the top of this page and may also tell you by email or by a notice on
            the service.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-cp-text mb-3">11. Contact</h2>
          <p className="text-cp-muted">
            Questions about this Privacy Policy? Contact us at{" "}
            <a href="mailto:support@convergepanel.com" className="text-sky-600 hover:underline">
              support@convergepanel.com
            </a>.
          </p>
        </section>
      </div>

      <div className="mt-12 pt-6 border-t border-cp-border">
        <Link href="/" className="text-sm text-sky-600 hover:underline font-medium">
          ← Back to ConvergePanel
        </Link>
      </div>
    </main>
  );
}
