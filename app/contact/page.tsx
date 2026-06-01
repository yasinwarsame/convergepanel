/**
 * App Router page (contact): UI route entry.
 */

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
    <main className="min-h-screen bg-gradient-to-br from-gray-50 to-gray-100 py-8 px-4">
        <div className="max-w-4xl mx-auto">
          <div className="bg-white rounded-lg shadow-lg p-8">
            <h1 className="text-3xl font-bold text-gray-900 mb-6">Contact</h1>

            <div className="prose max-w-none space-y-6 text-gray-700">
              <section>
                <p className="leading-relaxed text-lg">
                  Have questions, feedback, or need support? We&apos;d love to hear from
                  you.
                </p>
              </section>

              <section>
                <h2 className="text-2xl font-semibold text-gray-900 mb-3">
                  Get in Touch
                </h2>
                <div className="bg-primary-50 p-6 rounded-lg border border-primary-200">
                  <p className="text-primary-900 mb-2">
                    <strong>Email:</strong>{" "}
                    <a
                      href="mailto:support@convergepanel.com"
                      className="text-primary-600 hover:underline"
                    >
                      support@convergepanel.com
                    </a>
                  </p>
                  <p className="text-primary-800 text-sm mt-4">
                    We typically respond within 24-48 hours.
                  </p>
                </div>
              </section>

              <section>
                <h2 className="text-2xl font-semibold text-gray-900 mb-3">
                  Future Support
                </h2>
                <p className="leading-relaxed">
                  As ConvergePanel evolves, we plan to add:
                </p>
                <ul className="list-disc list-inside space-y-2 ml-4">
                  <li>In-app support chat</li>
                  <li>Community forum for sharing insights</li>
                  <li>API access for developers</li>
                  <li>Enterprise features and custom integrations</li>
                </ul>
              </section>

              <section>
                <h2 className="text-2xl font-semibold text-gray-900 mb-3">
                  Report Issues
                </h2>
                <p className="leading-relaxed">
                  If you encounter bugs, errors, or unexpected behavior, please include:
                </p>
                <ul className="list-disc list-inside space-y-2 ml-4">
                  <li>The question you asked</li>
                  <li>Which models were selected</li>
                  <li>Any error messages you saw</li>
                  <li>Your browser and device information</li>
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

