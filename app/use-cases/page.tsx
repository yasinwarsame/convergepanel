import type { Metadata } from "next";
import Link from "next/link";
import { PAGES, CATEGORIES } from "@/lib/pseo/pages";

export const metadata: Metadata = {
  title: "Use Cases | ConvergePanel",
  description:
    "See how journalists, researchers, analysts, and enterprise teams use ConvergePanel's multi-model AI verification for claims, video, research, and governance.",
  alternates: { canonical: "https://convergepanel.com/use-cases" },
};

export default function UseCasesIndex() {
  const byCategory = Object.entries(CATEGORIES).map(([key, cat]) => ({
    key,
    cat,
    pages: PAGES.filter((p) => p.category === key),
  }));

  return (
    <main className="mx-auto max-w-3xl px-4 py-12 sm:px-6 lg:py-16">
      <div className="mb-10">
        <h1 className="mb-3 text-3xl font-bold tracking-tight text-slate-900 sm:text-4xl">
          Use Cases
        </h1>
        <p className="text-lg text-slate-600">
          How journalists, researchers, analysts, and enterprise teams use multi-model AI
          verification in practice.
        </p>
      </div>

      <div className="space-y-12">
        {byCategory.map(({ key, cat, pages }) => (
          <section key={key}>
            <div className="mb-4 flex items-center gap-2">
              <span
                className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide ${cat.tailwindText} ${cat.tailwindBg}`}
              >
                {cat.label}
              </span>
              <span className="text-xs text-slate-400">{pages.length} pages</span>
            </div>
            <div className="space-y-2">
              {pages.map((p) => (
                <Link
                  key={p.slug}
                  href={`/use-cases/${p.slug}`}
                  className="group flex items-start gap-3 rounded-lg p-3 hover:bg-slate-50 transition-colors"
                >
                  <span className={`mt-0.5 text-sm ${cat.tailwindText}`}>→</span>
                  <div>
                    <p className="text-sm font-semibold text-slate-800 group-hover:text-sky-700 transition-colors">
                      {p.title}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-500 line-clamp-2">{p.metaDescription}</p>
                  </div>
                </Link>
              ))}
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}
