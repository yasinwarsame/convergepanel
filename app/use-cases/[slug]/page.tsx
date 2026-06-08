import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { PAGES, CATEGORIES, getPageBySlug } from "@/lib/pseo/pages";

export const dynamic = "force-static";

const BASE = "https://convergepanel.com";

const OG_IMAGES = {
  "video-verification": { path: "/video-verification.png", width: 2002, height: 1684 },
  research:             { path: "/deep-research.png",       width: 1990, height: 1844 },
  governance:           { path: "/governance.png",          width: 2076, height: 1344 },
  default:              { path: "/claim-verification.png",  width: 2004, height: 1842 },
} as const;

function getOgImage(category: string, slug: string) {
  if (category === "video-verification") return OG_IMAGES["video-verification"];
  if (category === "research")           return OG_IMAGES["research"];
  if (category === "governance")         return OG_IMAGES["governance"];
  if (category === "how-to" && (slug.includes("video") || slug.includes("clip")))
    return OG_IMAGES["video-verification"];
  return OG_IMAGES["default"];
}

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
  const img = getOgImage(page.category, slug);
  return {
    title: { absolute: `${page.title} | ConvergePanel` },
    description: page.metaDescription,
    alternates: { canonical: `${BASE}/use-cases/${slug}` },
    openGraph: {
      title: `${page.title} | ConvergePanel`,
      description: page.metaDescription,
      type: "article",
      url: `${BASE}/use-cases/${slug}`,
      siteName: "ConvergePanel",
      images: [{ url: `${BASE}${img.path}`, width: img.width, height: img.height, alt: `${page.title} | ConvergePanel` }],
    },
  };
}

function buildJsonLd(page: ReturnType<typeof getPageBySlug>, slug: string) {
  if (!page) return null;
  const schemaType = page.schemaType ?? "Article";

  if (schemaType === "HowTo") {
    return {
      "@context": "https://schema.org",
      "@type": "HowTo",
      name: page.h1,
      description: page.metaDescription,
      step: page.workflow.map((text, i) => ({
        "@type": "HowToStep",
        position: i + 1,
        name: text.split(/\s+—\s+|:\s+/)[0].trim(),
        text,
      })),
    };
  }

  if (schemaType === "FAQPage" && page.faq && page.faq.length > 0) {
    return {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      mainEntity: page.faq.map(({ q, a }) => ({
        "@type": "Question",
        name: q,
        acceptedAnswer: { "@type": "Answer", text: a },
      })),
    };
  }

  const img = getOgImage(page.category, slug);
  const datePublished = page.publishedAt ?? "2026-05-28";
  return {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: page.h1,
    description: page.metaDescription,
    image: `${BASE}${img.path}`,
    datePublished,
    dateModified: datePublished,
    author: { "@type": "Organization", name: "ConvergePanel", url: BASE },
    publisher: {
      "@type": "Organization",
      name: "ConvergePanel",
      url: BASE,
      logo: { "@type": "ImageObject", url: `${BASE}/convergepanel-logo.png` },
    },
    mainEntityOfPage: `${BASE}/use-cases/${slug}`,
  };
}

export default async function UseCasePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const page = getPageBySlug(slug);
  if (!page) return notFound();

  const cat = CATEGORIES[page.category];
  const jsonLd = buildJsonLd(page, slug);
  const breadcrumbJsonLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Use cases", item: `${BASE}/use-cases` },
      { "@type": "ListItem", position: 2, name: page.title, item: `${BASE}/use-cases/${slug}` },
    ],
  };

  const problemParagraphs = page.problem.split("\n\n").filter(Boolean);
  const solutionParagraphs = page.solution.split("\n\n").filter(Boolean);

  return (
    <>
      {jsonLd && (
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }}
        />
      )}
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(breadcrumbJsonLd).replace(/</g, "\\u003c") }}
      />

      <main className="mx-auto max-w-2xl px-4 py-12 sm:px-6 lg:py-16">
        {/* Category + breadcrumb */}
        <div className="mb-8 flex items-center gap-3">
          <Link
            href="/use-cases"
            className="text-xs font-medium text-cp-muted hover:text-cp-text transition-colors"
          >
            Use cases
          </Link>
          <span className="text-cp-muted">/</span>
          <span
            className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold tracking-wide uppercase ${cat.tailwindText} ${cat.tailwindBg}`}
          >
            {cat.label}
          </span>
        </div>

        {/* H1 */}
        <h1 className="mb-4 text-3xl font-bold leading-tight tracking-tight text-cp-text sm:text-4xl">
          {page.h1}
        </h1>

        {/* Lede */}
        <p className="mb-10 text-lg leading-relaxed text-cp-muted">{page.metaDescription}</p>

        {/* Audience callout */}
        <div className={`mb-10 rounded-lg border px-5 py-4 ${cat.tailwindBg} ${cat.tailwindBorder}`}>
          <p className="text-xs font-bold uppercase tracking-widest text-cp-muted mb-1">
            Who this is for
          </p>
          <p className="text-sm text-cp-text leading-relaxed">
            <span className="font-semibold">{page.audience}</span> — {page.audienceDetail}
          </p>
        </div>

        {/* The problem */}
        <section className="mb-9">
          <h2 className="mb-3 text-xl font-bold text-cp-text">The problem</h2>
          <div className="space-y-4">
            {problemParagraphs.map((para, i) => (
              <p key={i} className="text-base leading-relaxed text-cp-text">{para}</p>
            ))}
          </div>
        </section>

        {/* How ConvergePanel helps */}
        <section className="mb-9">
          <h2 className="mb-3 text-xl font-bold text-cp-text">How ConvergePanel helps</h2>
          <div className="space-y-4">
            {solutionParagraphs.map((para, i) => (
              <p key={i} className="text-base leading-relaxed text-cp-text">{para}</p>
            ))}
          </div>
        </section>

        {/* Comparison table (optional) */}
        {page.comparisonTable && (
          <section className="mb-9">
            <h2 className="mb-3 text-xl font-bold text-cp-text">How they compare</h2>
            <div className="overflow-x-auto rounded-lg border border-cp-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className={`${cat.tailwindBg}`}>
                    {page.comparisonTable.headers.map((h, i) => (
                      <th
                        key={i}
                        className={`px-4 py-3 text-left text-xs font-bold uppercase tracking-wide ${cat.tailwindText}`}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {page.comparisonTable.rows.map((row, ri) => (
                    <tr key={ri} className={ri % 2 === 0 ? "bg-cp-surface" : "bg-cp-raised"}>
                      {row.map((cell, ci) => (
                        <td
                          key={ci}
                          className={`px-4 py-3 text-cp-text leading-relaxed${ci === 0 ? " font-medium text-cp-text" : ""}`}
                        >
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {/* How it works */}
        <section className="mb-9">
          <h2 className="mb-3 text-xl font-bold text-cp-text">How it works</h2>
          <ol className="space-y-3">
            {page.workflow.map((step, i) => (
              <li key={i} className="flex gap-3">
                <span
                  className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${cat.tailwindText} ${cat.tailwindBg}`}
                >
                  {i + 1}
                </span>
                <span className="text-base leading-relaxed text-cp-text">{step}</span>
              </li>
            ))}
          </ol>
        </section>

        {/* Use cases */}
        <section className="mb-12">
          <h2 className="mb-3 text-xl font-bold text-cp-text">Use cases</h2>
          <ul className="space-y-2">
            {page.useCases.map((uc, i) => (
              <li key={i} className="flex gap-2.5 text-base leading-relaxed text-cp-text">
                <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${cat.tailwindDot}`} />
                {uc}
              </li>
            ))}
          </ul>
        </section>

        {/* Body sections (optional custom H2 sections) */}
        {page.bodySections && page.bodySections.map((section, i) => (
          <section key={i} className="mb-9">
            <h2 className="mb-3 text-xl font-bold text-cp-text">{section.heading}</h2>
            {section.paragraphs && (
              <div className="space-y-4 mb-3">
                {section.paragraphs.map((para, j) => (
                  <p key={j} className="text-base leading-relaxed text-cp-text">{para}</p>
                ))}
              </div>
            )}
            {section.bullets && (
              <ul className="space-y-2">
                {section.bullets.map((item, j) => (
                  <li key={j} className="flex gap-2.5 text-base leading-relaxed text-cp-text">
                    <span className={`mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full ${cat.tailwindDot}`} />
                    {item}
                  </li>
                ))}
              </ul>
            )}
            {section.steps && (
              <ol className="space-y-3">
                {section.steps.map((step, j) => (
                  <li key={j} className="flex gap-3">
                    <span className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${cat.tailwindText} ${cat.tailwindBg}`}>
                      {j + 1}
                    </span>
                    <span className="text-base leading-relaxed text-cp-text">{step}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>
        ))}

        {/* FAQ (optional) */}
        {page.faq && page.faq.length > 0 && (
          <section className="mb-12">
            <h2 className="mb-5 text-xl font-bold text-cp-text">Frequently asked questions</h2>
            <div className="space-y-6">
              {page.faq.map(({ q, a }, i) => (
                <div key={i}>
                  <h3 className="mb-2 text-base font-semibold text-cp-text">{q}</h3>
                  <p className="text-base leading-relaxed text-cp-text">{a}</p>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Related pages (cross-cluster) */}
        {page.relatedLinks && page.relatedLinks.length > 0 && (
          <section className="mb-12 rounded-xl border border-cp-border bg-cp-raised px-6 py-5">
            <h2 className="mb-4 text-sm font-bold uppercase tracking-widest text-cp-muted">
              Explore related pages
            </h2>
            <ul className="space-y-2">
              {page.relatedLinks.map(({ label, href }, i) => (
                <li key={i}>
                  <Link
                    href={href}
                    className="group flex items-center gap-2 text-sm font-medium text-cp-text hover:text-sky-400 transition-colors"
                  >
                    <span className="text-cp-muted group-hover:text-sky-400 transition-colors">→</span>
                    {label}
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* CTA */}
        <div className="mb-10 rounded-2xl bg-cp-raised px-8 py-10 text-center">
          <p className="mb-6 text-lg font-semibold text-white">{page.cta}</p>
          <Link
            href="/signup"
            className="inline-block rounded-lg bg-sky-500 px-7 py-3 text-sm font-bold text-white shadow-sm hover:bg-sky-400 transition-colors"
          >
            Get started →
          </Link>
          <p className="mt-4 text-xs text-cp-muted">Free tier available. No credit card required.</p>
        </div>

        {/* Disclaimer */}
        <p className="mb-10 text-center text-xs text-cp-muted leading-relaxed">
          ConvergePanel provides AI-assisted verification for informational purposes only. Not forensic analysis. Not legal evidence.
        </p>

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
    <div className="mt-14 border-t border-cp-border pt-10">
      <h3 className="mb-5 text-sm font-bold uppercase tracking-widest text-cp-muted">
        More in {cat.label}
      </h3>
      <div className="space-y-3">
        {related.map((p) => (
          <Link
            key={p.slug}
            href={`/use-cases/${p.slug}`}
            className="group flex items-start gap-3 rounded-lg p-3 hover:bg-cp-raised transition-colors"
          >
            <span className={`mt-0.5 text-sm ${cat.tailwindText}`}>→</span>
            <div>
              <p className="text-sm font-semibold text-cp-text group-hover:text-sky-400 transition-colors">
                {p.title}
              </p>
              <p className="mt-0.5 text-xs text-cp-muted line-clamp-1">{p.metaDescription}</p>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
