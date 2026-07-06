import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Contact",
  description: "Get in touch with the ConvergePanel team.",
  alternates: { canonical: "/contact" },
  openGraph: { url: "https://convergepanel.com/contact", title: "Contact ConvergePanel" },
};

export default function ContactPage() {
  return (
    <main className="mx-auto max-w-4xl px-4 py-10 sm:py-14">
      <h1 className="mb-6 text-3xl font-bold text-cp-text">Contact</h1>

      <div className="space-y-8 text-cp-muted">
        <section>
          <p className="text-lg leading-relaxed text-cp-text">
            Have questions, feedback, or need support? We&apos;d love to hear from you.
          </p>
        </section>

        <section>
          <h2 className="mb-3 text-2xl font-semibold text-cp-text">Get in Touch</h2>
          <div className="rounded-lg border border-cp-border bg-cp-raised p-6">
            <p className="mb-2 text-cp-text">
              <strong>Email:</strong>{" "}
              <a
                href="mailto:support@convergepanel.com"
                className="text-sky-600 hover:underline"
              >
                support@convergepanel.com
              </a>
            </p>
            <p className="mt-4 text-sm text-cp-muted">
              We typically respond within 24–48 hours.
            </p>
          </div>
        </section>

        <section>
          <h2 className="mb-3 text-2xl font-semibold text-cp-text">Future Support</h2>
          <p className="leading-relaxed text-cp-muted">
            As ConvergePanel evolves, we plan to add:
          </p>
          <ul className="ml-4 mt-3 list-disc list-inside space-y-2 text-cp-muted">
            <li>In-app support chat</li>
            <li>Community forum for sharing insights</li>
            <li>API access for developers</li>
            <li>Enterprise features and custom integrations</li>
          </ul>
        </section>

        <section>
          <h2 className="mb-3 text-2xl font-semibold text-cp-text">Report Issues</h2>
          <p className="leading-relaxed text-cp-muted">
            If you encounter bugs, errors, or unexpected behavior, please include:
          </p>
          <ul className="ml-4 mt-3 list-disc list-inside space-y-2 text-cp-muted">
            <li>The question you asked</li>
            <li>Which models were selected</li>
            <li>Any error messages you saw</li>
            <li>Your browser and device information</li>
          </ul>
        </section>
      </div>

      <div className="mt-8 border-t border-cp-border pt-6">
        <Link href="/" className="inline-flex items-center font-medium text-sky-600 hover:text-sky-700">
          ← Back to Panel
        </Link>
      </div>
    </main>
  );
}
