import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { PAGES, CATEGORIES, getPageBySlug } from "@/lib/pseo/pages";

export const dynamic = "force-static";

export async function generateStaticParams() {
  return PAGES.map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const page = getPageBySlug(slug);
  if (!page) return {};
  return {
    title: `${page.title} | ConvergePanel`,
    description: page.metaDescription,
    alternates: { canonical: `https://convergepanel.com/use-cases/${slug}` },
    openGraph: {
      title: `${page.title} | ConvergePanel`,
      description: page.metaDescription,
      type: "article",
      url: `https://convergepanel.com/use-cases/${slug}`,
      siteName: "ConvergePanel",
    },
  };
}

export default async function UseCasePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const page = getPageBySlug(slug);
  if (!page) notFound();

  const cat = CATEGORIES[page.category];

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: page.h1,
    description: page.metaDescription,
    author: { "@type": "Organization", name: "ConvergePanel" },
    publisher: {
      "@type": "Organization",
      name: "ConvergePanel",
      url: "https://convergepanel.com",
    },
    mainEntityOfPage: `https://convergepanel.com/use-cases/${slug}`,
  };

  return (
    <>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }}
      />

      <main className="mx-auto max-w-2xl px-4 py-12 sm:px-6 lg:py-16">
        {/* Category + breadcrumb */}
        <div className="mb-8 flex items-center gap-3">
          <Link
            href="/use-cases"
            className="text-xs font-medium text-slate-400 hover:text-slate-600 transition-colors"
          >
            Use cases
          </Link>
          <span className="text-slate-300">/</span>
          <span
            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold tracking-wide uppercase ${cat.tailwindText} ${cat.tailwindBg}`}
          >
            {cat.label}
          </span>
        </div>

        {/* H1 */}
        <h1 className="mb-4 text-3xl font-bold leading-tight tracking-tight text-slate-900 sm:text-4xl">
          {page.h1}
        </h1>

        {/* Lede */}
        <p className="mb-10 text-lg leading-relaxed text-slate-600">{page.metaDescription}</p>

        {/* Audience callout */}
        <div className={`mb-10 rounded-lg border px-5 py-4 ${cat.tailwindBg} ${cat.tailwindBorder}`}>
          <p className="text-xs font-bold uppercase tracking-widest text-slate-400 mb-1">
            Who this is for
          </p>
          <p className="text-sm text-slate-700 leading-relaxed">
            <span className="font-semibold">{page.audience}</span> — {page.audienceDetail}
          </p>
        </div>

        {/* Body sections */}
        <section className="mb-9">
          <h2 className="mb-3 text-xl font-bold text-slate-900">The problem</h2>
          <p className="text-base leading-relaxed text-slate-700">{page.problem}</p>
        </section>

        <section className="mb-9">
          <h2 className="mb-3 text-xl font-bold text-slate-900">How ConvergePanel helps</h2>
          <p className="text-base leading-relaxed text-slate-700">{page.solution}</p>
        </section>

        <section className="mb-9">
          <h2 className="mb-3 text-xl font-bold text-slate-900">How it works</h2>
          <ol className="space-y-3">
            {page.workflow.map((step, i) => (
              <li key={i} className="flex gap-3">
                <span
                  className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${cat.tailwindText} ${cat.tailwindBg}`}
                >
                  {i + 1}
                </span>
                <span className="text-base leading-relaxed text-slate-700">{step}</span>
              </li>
            ))}
          </ol>
        </section>

        <section className="mb-12">
          <h2 className="mb-3 text-xl font-bold text-slate-900">Use cases</h2>
          <ul className="space-y-2">
            {page.useCases.map((uc, i) => (
              <li key={i} className="flex gap-2.5 text-base leading-relaxed text-slate-700">
                <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${cat.tailwindDot}`} />
                {uc}
              </li>
            ))}
          </ul>
        </section>

        {/* CTA */}
        <div className="rounded-2xl bg-slate-900 px-8 py-10 text-center">
          <p className="mb-6 text-lg font-semibold text-white">{page.cta}</p>
          <Link
            href="/signup"
            className="inline-block rounded-lg bg-sky-500 px-7 py-3 text-sm font-bold text-white shadow-sm hover:bg-sky-400 transition-colors"
          >
            Get started →
          </Link>
          <p className="mt-4 text-xs text-slate-500">Free tier available. No credit card required.</p>
        </div>

        {/* Related category links */}
        <RelatedPages currentSlug={page.slug} category={page.category} />
      </main>
    </>
  );
}

function RelatedPages({ currentSlug, category }: { currentSlug: string; category: string }) {
  const related = PAGES.filter(
    (p) => p.category === category && p.slug !== currentSlug
  ).slice(0, 3);

  if (related.length === 0) return null;

  const cat = CATEGORIES[category];

  return (
    <div className="mt-14 border-t border-slate-100 pt-10">
      <h3 className="mb-5 text-sm font-bold uppercase tracking-widest text-slate-400">
        More in {cat.label}
      </h3>
      <div className="space-y-3">
        {related.map((p) => (
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
              <p className="mt-0.5 text-xs text-slate-500 line-clamp-1">{p.metaDescription}</p>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
