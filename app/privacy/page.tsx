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
      {/* OWNER/LEGAL VERIFY (checklist PP-02): the previous date (June 14, 2026) belongs to the old text and must not be shown on this one. Set the real revision date only when the corrected policy is approved for publication (D-12). */}
      <p className="text-sm text-cp-muted mb-10">Last updated: [REVISION DATE — OWNER VERIFY]</p>

      <div className="space-y-10">
        <section>
          <h2 className="text-xl font-semibold text-cp-text mb-3">1. Introduction</h2>
          <p className="text-cp-muted mb-3">
            ConvergePanel (&quot;we&quot;, &quot;our&quot;, &quot;us&quot;) is committed to protecting your privacy. This
            Privacy Policy explains how we collect, use, and protect your information when you use
            the ConvergePanel web application or the ConvergePanel Verify browser extension.
          </p>
          <p className="text-cp-muted mb-3">
            <strong className="text-cp-text">Who is responsible for your data.</strong> The ConvergePanel service
            is operated by [LEGAL ENTITY NAME — OWNER VERIFY], [REGISTERED ADDRESS — OWNER VERIFY], which is
            responsible for the personal information described in this policy. You can contact us at{" "}
            <a href="mailto:support@convergepanel.com" className="text-sky-600 hover:underline">
              support@convergepanel.com
            </a>.
          </p>
          {/* OWNER/LEGAL VERIFY: legal entity name, registered address and its role (e.g. controller) are not stated anywhere in the repo (Terms page names no entity). Counsel to confirm the entity, its role, and whether a representative or privacy contact must be named. */}
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
              email that includes the workspace name, their role and the invitation link
            </li>
            <li>
              <strong className="text-cp-text">Content You Submit and Your Results:</strong> The claims, questions
              and context you submit (including text read from files you attach), the video information you
              submit, and the results produced for them (see below)
            </li>
            <li><strong className="text-cp-text">Usage Data:</strong> Number of runs, which models you selected, token usage, plan limits and usage counters, and product-analytics events about how you use the app</li>
            <li><strong className="text-cp-text">Technical Data:</strong> IP address, browser type, device information, the addresses of the pages you visit, and error reports</li>
          </ul>
          {/* OWNER/LEGAL VERIFY: onboarding answers are stored on users/{uid} and sent to PostHog (app/onboarding/page.tsx:150-155). Stripe customer/subscription ids are stored on users/{uid}. Invitee data: lib/email/workspaceInvitations.ts (Resend); both callers pass inviterName: null, so the inviter's name is not sent today. */}
          <p className="text-cp-muted mb-3">
            <strong className="text-cp-text">What we store.</strong> When you run a Claim Verification, we store the claim you submit (up to 2,000 characters) and the structured results each
            AI model returns (its verdict, confidence, summary and the parts it found correct, incorrect or
            unverifiable), together with consensus scores and an audit record of the run. When you run Deep
            Research, we store your question, any context you provide, the answers the AI models return, the
            combined summary report and related analysis, and review and governance records for the run. If you
            export a research report, we may also store a snapshot of the exported content. For Video
            Verification, see Section 6. We use this to show your history, let you reopen results, and support
            review and governance features. For Claim Verification, we do not store the raw, unprocessed
            responses from AI providers.
          </p>
          {/* OWNER/LEGAL VERIFY: Deep Research storage confirmed in lib/firestore/runs.ts (question, questionContext, per-model answer text capped for storage, governance/review records) but was outside the scope of audit 01's end-to-end trace. Export snapshots: app/api/user/runs/[runId]/exports/route.ts + lib/firestore/adaptiveExports.ts, gated by ADAPTIVE_RESEARCH_EXPORT_ENABLED (Production value UNVERIFIED). */}
          <p className="text-cp-muted mb-3">
            On paid plans, when our governance checks evaluate a claim, research run or video verification, or a
            review decision is made on it, an entry is recorded in an audit log used for governance and
            administration. The entry contains an excerpt of the claim or question (up to its first 200
            characters; for a video, its file name, duration and resolution) and your account ID, and, for a video
            verification or a review decision, your account email. When our staff delete a stored claim or video
            verification, or change the review status of a stored claim, research run or video verification, an
            audit-log entry containing a similar excerpt and your account ID is recorded on any plan; it also
            contains your account email where that email is stored with the record, which today is the case only
            for video verifications. If your account belongs to a team, a copy of the content you run, together
            with your email address, is also kept for that team (see Section 8).
          </p>
          {/* Audit rows (R4o re-trace at cabbdbb): paid-plan evaluation lib/governance/evaluateAndStore.ts:52 (free -> skipped), :94-110 (question excerpt 200, runOwnerUid, runOwnerEmail = parent doc userEmail :120,:130); review decisions app/api/governance/review/route.ts:318-332 (owner email from record, else from users/{uid} profile), :366-380. Staff rows app/api/admin/runs/[runId]/route.ts — runOwnerEmail = prev.userEmail only (:176, :272); DELETE writes the excerpt for verifications/videoVerifications only; research deletions are written redacted (:262). PATCH governance override writes auditQuestionFromDoc for all three collections (:177). userEmail is stored only on video records (app/api/verify-video/route.ts:499; lib/firestore/teamVideoVerifications.ts:356), not on claim (lib/firestore/verifications.ts, teamClaimVerifications.ts) or research records (lib/firestore/runs.ts). Legacy team copy: lib/governance/teamGovernancePipeline.ts:105-107 (userEmail + query up to 5,000 chars). */}
          <p className="text-cp-muted mb-3">
            <strong className="text-cp-text">How long we keep it.</strong> We keep stored content and account data
            until it is deleted (see Section 11). We do not currently delete it automatically after a fixed
            period, on any plan. We may also delete stored content ourselves, for example as part of data
            cleanup.
          </p>
          {/* OWNER/LEGAL VERIFY: no TTL or scheduled purge exists for verifications, audit-log copies or team copies (audit 01 §C); admin purge-runs exists for research runs only. If the owner adopts a fixed retention period, it must be implemented before it is stated here (D-3). The Pricing page Free-plan line "Store recent sessions (last 7 days)" (lib/plans.ts:75 -> components/PricingSection.tsx) contradicts this; it is corrected in the coordinated pricing-copy draft PR (historyRetentionDays is never read). */}
          <p className="text-cp-muted">
            <strong className="text-cp-text">Logs.</strong> Our hosting and monitoring providers keep technical
            logs. These logs can include identifiers such as your account ID and, in some cases, short excerpts of
            what you submit or of AI model output. Retention periods for these logs, and for database backups,
            have not yet been confirmed.
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
          {/* OWNER/LEGAL VERIFY: no cookie/consent banner or analytics opt-out exists in code. PostHog persistence is the SDK default (cookie + localStorage), not set in code. Counsel to confirm whether consent is required for PostHog/Sentry storage in the jurisdictions served. */}
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
          {/* OWNER VERIFY (checklist PP-11): the app sends no receipt email. Whether Stripe emails receipts depends on Stripe account settings that were not inspected, so receipts are described only conditionally, in the Stripe entry of Section 7. */}
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
            does not upload, store, or retain your complete video files on our servers. Only extracted frame
            images and technical details read from the file are transmitted to our servers for the analysis
            request. These details include the file name, duration, resolution, codec, frame rate, file size,
            format, whether it has audio, and, where the file contains them, its creation date, encoding software
            and camera or device model. The frames and these technical details (but not the file name) are sent to
            OpenAI, Anthropic and Google for analysis, regardless of which models you select elsewhere, and are
            subject to their respective terms. After analysis is complete, frame images are discarded.
          </p>
          <p className="text-cp-muted mb-3">
            We store the analysis results, the model verdicts, the file name and the technical details above, and
            your account email with the verification. Video verification is available on paid plans only. As
            described in Section 2, audit-log entries about a video verification contain its file name, duration
            and resolution, your account ID and your account email. If you run it in a team workspace, it is stored
            in that workspace (see Section 8).
          </p>
          {/* R4o re-trace at cabbdbb (checklist PP-20): paid only (app/api/verify-video/route.ts:113; workspace route :362). Stored fields app/api/verify-video/route.ts:497-535 and lib/firestore/teamVideoVerifications.ts:354-370 = userId, userEmail, fileName, verdicts/scores, metadata (VideoMetadata lib/video/videoPure.ts:27-49), metadataAnalysis, trimmed per-model fields, agreement/disagreement points, frameCount, warnings, totalTokens, timestamp; no frames. Audit: evaluated entry question = "Video verification: <file> (<dur>s, <w>x<h>)" (route.ts:596; workspace :616) + runOwnerEmail from the record (evaluateAndStore.ts:130); review/staff rows use "Video: <file> (<dur>, <w>x<h>)". Owner still to confirm the end-to-end trace (audit 01 did not cover video). */}
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
              address and your ConvergePanel account ID, and handles your payment details directly. Depending on
              our Stripe account settings, Stripe may also email you payment receipts.{" "}
              <a href="https://stripe.com/privacy" target="_blank" rel="noopener noreferrer" className="text-sky-600 hover:underline">
                Stripe Privacy Policy
              </a>
            </li>
            <li>
              <strong className="text-cp-text">Resend:</strong> Delivery of team workspace invitation emails. Resend
              receives the invitee&apos;s email address, the workspace name, the role and the invitation link.{" "}
              <a href="https://resend.com/legal/privacy-policy" target="_blank" rel="noopener noreferrer" className="text-sky-600 hover:underline">
                Resend Privacy Policy
              </a>
            </li>
            {/* OWNER/LEGAL VERIFY: Resend is live only if RESEND_API_KEY is set in Production (UNVERIFIED, 10- A9). Confirm the Resend privacy-policy URL. */}
            <li>
              <strong className="text-cp-text">AI Model Providers:</strong> To produce results, the text you
              submit is sent to the AI providers whose models you select: OpenAI, Anthropic, Google (Gemini API),
              xAI (Grok) and Perplexity. Perplexity also runs a live web search based on the text you submit. Files
              you attach are read in your browser; the file itself is not uploaded, and the text read from it
              becomes part of the text you submit. For Deep Research, the text you submit is divided into a
              question and, optionally, context. The context is everything from the first line that starts with
              &quot;Context:&quot;. If you attach a file after typing a question, the app adds the file&apos;s
              text under such a line, so it becomes context. If there is no such line, for example when you attach
              a file while the question box is empty, the whole text, including any text from an attached file,
              is treated as the question. If your text begins with such a line, the whole text is treated both as
              the question and as context. The models you select receive both the question and any context. For
              Deep Research, your question and all the model answers may also be sent to Google (Gemini API) to
              classify the question, compare the answers, check for bias and coverage, and write the summary
              report, whether or not you selected a Google model. Text that is treated only as context is not
              sent in these steps, but the model answers can quote or summarize it. For Deep Research, your
              question, any context and the model answers may also be sent to OpenAI (or Anthropic, as a
              fallback) to produce a combined summary, whether or not you selected those models. Video data is sent as described in Section 6. We
              do not send your name, email address or account ID to these providers. Each provider handles the
              data it receives under its own terms and may log requests under its own policies.
              {/* Traced at cabbdbb (R4/R4o provider-input trace; pinned by app/privacy/__tests__/privacyPolicyProviderInputs.spec.tsx). Attach: lib/client/extractFileText.ts reads the file in the browser (no upload; pdf worker same-origin /vendor/pdfjs); app/page.tsx:3058-3069 research attach — non-empty box -> base + "\n\nContext:\n" + file text; EMPTY box -> file text alone (no Context: line); verify tab app/page.tsx:3086-3097 (claim text, max 2,000). Split: lib/questionContext.ts:13-33 — no "Context:" line -> whole text is the question (:17-19); text beginning with "Context:" -> question = whole text AND context = whole text (:28-31). Server limit 10,000 chars (lib/security/requestValidation.ts:12). Gemini auxiliary calls: lib/adaptiveSchema/classifier.ts:298, alignment.ts:217,376, biasDetection.ts:107, coverageAudit.ts:80, synthesisReport.ts:411 — every one passes context = null; inputs are the question (run-panel/route.ts:210 splits the "Context:" section off; orchestrate.ts:348; runPanelExecution.ts:730) plus model answers/claims. They run only when ADAPTIVE_SCHEMAS_ENABLED is true or the user is a canary uid (run-panel/route.ts:231). Production value UNVERIFIED (10- A5, checklist PP-12) — keep the sentence unless confirmed off. Synthesis: app/api/synthesize-panel/route.ts:822,835 -> lib/synthesis/authoritativeRunInputs.ts:70,96 -> composeSynthesisQuestion (lib/questionContext.ts:73-74) = question + persisted context; prompts route.ts:1213,1261,1664,1702; OpenAI route.ts:1391-1402 (+ retries :1746,:1974), Anthropic fallback route.ts:231-252 called at :1492,:1806,:1961. */}
              {" "}For Deep Research, where our fallback is enabled, if a selected model is temporarily unavailable,
              your question and any context may be sent to DeepSeek instead. DeepSeek states that it processes and
              stores data in the People&apos;s Republic of China.
              {/* OWNER/LEGAL VERIFY: DeepSeek fallback (lib/panel.ts) is active only when DEEPSEEK_API_KEY is set in Production — UNKNOWN (10- A5). Default slots are OpenAI/Anthropic/Google; PANEL_DEEPSEEK_FALLBACK_FOR can change them. Keep the sentence if the key is set; remove it if the fallback is disabled. DeepSeek is not reachable from Claim Verification. */}
              {/* OWNER/LEGAL VERIFY: no training, retention, region, ZDR or DPA statements are made here on purpose (03 Part C; 10- §4). Gemini paid/unpaid tier, OpenAI/Anthropic opt-in and feedback settings, xAI ZDR status and DPAs are unverified (10- A1-A3). Links below point to API/commercial documentation where an official page was identified in 10- §4; owner to confirm each is the governing document for our accounts. Perplexity's downstream search infrastructure is UNKNOWN (10- S14, §5). */}
              <ul className="list-disc list-inside ml-6 mt-2 space-y-1">
                <li><a href="https://developers.openai.com/api/docs/guides/your-data" target="_blank" rel="noopener noreferrer" className="text-sky-600 hover:underline">OpenAI API data controls</a></li>
                <li><a href="https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data" target="_blank" rel="noopener noreferrer" className="text-sky-600 hover:underline">Anthropic commercial data retention</a></li>
                <li><a href="https://ai.google.dev/gemini-api/terms" target="_blank" rel="noopener noreferrer" className="text-sky-600 hover:underline">Google Gemini API Terms</a></li>
                <li><a href="https://docs.x.ai/docs/faq/security" target="_blank" rel="noopener noreferrer" className="text-sky-600 hover:underline">xAI API security and data FAQ</a></li>
                <li><a href="https://www.perplexity.ai/hub/legal/perplexity-api-terms-of-service" target="_blank" rel="noopener noreferrer" className="text-sky-600 hover:underline">Perplexity API Terms of Service</a></li>
                <li><a href="https://cdn.deepseek.com/policies/en-US/deepseek-privacy-policy.html" target="_blank" rel="noopener noreferrer" className="text-sky-600 hover:underline">DeepSeek Privacy Policy</a></li>
              </ul>
            </li>
          </ul>
          {/* OWNER/LEGAL VERIFY: Sentry and PostHog are wired in code (instrumentation-client.ts, sentry.server.config.ts, components/PostHogProvider.tsx); whether each is live in Production depends on SENTRY_DSN / NEXT_PUBLIC_SENTRY_DSN / NEXT_PUBLIC_POSTHOG_KEY (10- A5-A7). Code comments claim PostHog is not configured in Production (app/signup/page.tsx ~365; app/api/user/email-verification-telemetry/route.ts:6) — unverified; keep the disclosure until A5/A6 confirm. Wording describes current code at cabbdbb (sendDefaultPii true, no Sentry setUser; replay 5% + 100% on error; Sentry.replayIntegration() is called with no options (instrumentation-client.ts:18), so @sentry/replay 10.75.2 defaults maskAllText/maskAllInputs/blockAllMedia = true apply (node_modules/@sentry/replay/build/npm/cjs/index.js:8167-8169); PostHog autocapture and session recording not disabled in code; full URLs incl. query). Do not narrow it until a fix (e.g. PR #329) is deployed to Production. */}
          <ul className="list-disc list-inside text-cp-muted space-y-2">
            <li>
              <strong className="text-cp-text">Sentry:</strong> Error monitoring, performance tracing for a sample of
              requests, and session replay for a sample of sessions and for sessions in which an error occurs. Sentry receives your IP address, technical
              details about errors, and the addresses of the pages you visit. Session replay records what happens
              on the page; with our current settings, text and form inputs are masked in these recordings.{" "}
              <a href="https://sentry.io/privacy/" target="_blank" rel="noopener noreferrer" className="text-sky-600 hover:underline">
                Sentry Privacy Policy
              </a>
            </li>
            <li>
              <strong className="text-cp-text">PostHog (United States):</strong> Product analytics. Requests to
              PostHog are routed through our own domain, and PostHog may receive your IP address. PostHog receives
              the pages you visit, including the full page address; your account ID, email address and, if you
              provide it at sign-up, your name; your onboarding answers; errors in the app; and events about how you
              interact with the app, which can include the text of buttons and items you click (such as the
              beginning of a claim or question shown in your history). A page address can include text you passed
              to ConvergePanel through a link or the browser extension. If session recording is enabled in our
              PostHog settings, PostHog may also record your sessions, including text shown on screen. Our servers
              may also send PostHog information about Deep Research question classification and subscription
              events (including subscription identifiers).{" "}
              <a href="https://posthog.com/privacy" target="_blank" rel="noopener noreferrer" className="text-sky-600 hover:underline">
                PostHog Privacy Policy
              </a>
            </li>
            {/* OWNER VERIFICATION REQUIRED: PostHog session recording is not disabled in code at cabbdbb (components/PostHogProvider.tsx:56-64); whether it is on depends on PostHog project settings (10- A6). PostHog default masking covers inputs, not page text. Do not state it is disabled because PR #329 proposes that. IP: /ingest rewrite to us.i.posthog.com (next.config.js:28-29); whether the client IP is forwarded/stored depends on proxy headers and the "Discard client IP data" setting (A6). Server-side PostHog events (lib/adaptiveSchema/analytics.ts; stripe webhook) are flag/env-gated. */}
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
            <li>Error monitoring (see Section 7)</li>
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
          <h2 className="text-xl font-semibold text-cp-text mb-3">9. International Transfers</h2>
          <p className="text-cp-muted">
            The providers listed in Section 7 may process your information in countries other than the one you
            live in, including the United States, and, where the Deep Research fallback is enabled, the
            People&apos;s Republic of China. These countries may have data protection laws that differ from those
            in your country. [TRANSFER SAFEGUARDS — OWNER/LEGAL VERIFY]
          </p>
          {/* OWNER/LEGAL VERIFY: no region pinning is used (Anthropic inference global; xAI api.x.ai global endpoint; Google "any country" with Google facilities; Firestore locationId UNVERIFIED; Vercel function region UNVERIFIED; Sentry region UNVERIFIED; PostHog US ingest; DeepSeek PRC) — 10- §2.2, §4. Transfer mechanisms (e.g. SCCs in signed DPAs) are UNVERIFIED (10- A3). Counsel to draft the safeguards sentence; do not name a mechanism until the agreement is located. */}
        </section>

        <section>
          <h2 className="text-xl font-semibold text-cp-text mb-3">10. Children</h2>
          <p className="text-cp-muted">
            ConvergePanel is not intended for children. You must be at least [MINIMUM AGE — OWNER/LEGAL VERIFY]
            to use the service. If you believe a child has provided us with personal information, contact us and
            we will review the request.
          </p>
          {/* OWNER/LEGAL VERIFY: no minimum age is stated in the Terms or enforced at sign-up in code. Counsel to set the minimum age and confirm the wording; align the Terms. */}
        </section>

        <section>
          <h2 className="text-xl font-semibold text-cp-text mb-3">11. Your Rights</h2>
          <p className="text-cp-muted mb-3">
            Depending on where you live, you may have rights over your personal information. You can ask us to:
          </p>
          <ul className="list-disc list-inside text-cp-muted space-y-1 mb-3">
            <li>Access your account data</li>
            <li>Correct information that is inaccurate</li>
            <li>Delete your account and associated data</li>
            <li>Provide a copy of your data</li>
            <li>Restrict or object to certain uses of your information</li>
            <li>Stop non-essential communications</li>
          </ul>
          {/* OWNER/LEGAL VERIFY: the list is phrased as requests, not as guaranteed statutory rights. Counsel to confirm which rights apply in the jurisdictions served and how each is fulfilled; correction, restriction and objection are manual today (no in-app mechanism). */}
          <p className="text-cp-muted mb-3">
            To make a request, contact us at{" "}
            <a href="mailto:support@convergepanel.com" className="text-sky-600 hover:underline">
              support@convergepanel.com
            </a>. If you are not satisfied with our response, you may have the right to complain to a data
            protection authority where you live. [SUPERVISORY AUTHORITY / COMPLAINT DETAILS — OWNER/LEGAL VERIFY]
          </p>
          {/* OWNER/LEGAL VERIFY: no supervisory authority, lead authority or representative is named; counsel to decide whether one must be. */}
          <p className="text-cp-muted">
            The app does not currently let you delete your account, your research or individual verifications yourself, so
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
          <h2 className="text-xl font-semibold text-cp-text mb-3">12. Changes to This Policy</h2>
          <p className="text-cp-muted">
            We may update this Privacy Policy at any time. When we make significant changes, we will update the
            &quot;Last updated&quot; date at the top of this page and may also tell you by email or by a notice on
            the service.
          </p>
        </section>

        <section>
          <h2 className="text-xl font-semibold text-cp-text mb-3">13. Contact</h2>
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
