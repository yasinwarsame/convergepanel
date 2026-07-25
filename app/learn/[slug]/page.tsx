import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { LEARN_PAGES, getLearnPageBySlug } from "@/lib/learn/pages";
import { getPillarBySlug } from "@/lib/solutions/pages";

export const dynamic = "force-static";

const BASE = "https://convergepanel.com";
const DEFAULT_OG_IMAGE = { path: "/claim-verification.png", width: 2004, height: 1842 };

export async function generateStaticParams() {
  return LEARN_PAGES.map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const page = getLearnPageBySlug(slug);
  if (!page) return {};
  return {
    title: { absolute: `${page.title} | ConvergePanel` },
    description: page.metaDescription,
    alternates: { canonical: `${BASE}/learn/${slug}` },
    openGraph: {
      title: `${page.title} | ConvergePanel`,
      description: page.metaDescription,
      type: "article",
      url: `${BASE}/learn/${slug}`,
      siteName: "ConvergePanel",
      images: [{ url: `${BASE}${DEFAULT_OG_IMAGE.path}`, width: DEFAULT_OG_IMAGE.width, height: DEFAULT_OG_IMAGE.height, alt: `${page.title} | ConvergePanel` }],
    },
    twitter: {
      card: "summary_large_image",
      title: `${page.title} | ConvergePanel`,
      description: page.metaDescription,
      images: [`${BASE}${DEFAULT_OG_IMAGE.path}`],
    },
  };
}

function buildJsonLd(
  page: NonNullable<ReturnType<typeof getLearnPageBySlug>>,
  slug: string,
  pillarH1: string,
  pillarSlug: string
) {
  const article = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: page.h1,
    description: page.metaDescription,
    image: `${BASE}${DEFAULT_OG_IMAGE.path}`,
    datePublished: page.publishedAt,
    dateModified: page.publishedAt,
    author: { "@type": "Organization", name: "ConvergePanel", url: BASE },
    publisher: {
      "@type": "Organization",
      name: "ConvergePanel",
      url: BASE,
      logo: { "@type": "ImageObject", url: `${BASE}/convergepanel-logo.png` },
    },
    mainEntityOfPage: `${BASE}/learn/${slug}`,
  };
  const faqPage = {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: page.faq.map(({ q, a }) => ({
      "@type": "Question",
      name: q,
      acceptedAnswer: { "@type": "Answer", text: a },
    })),
  };
  const breadcrumb = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: BASE },
      { "@type": "ListItem", position: 2, name: pillarH1, item: `${BASE}/solutions/${pillarSlug}` },
      { "@type": "ListItem", position: 3, name: page.h1, item: `${BASE}/learn/${slug}` },
    ],
  };
  return [article, faqPage, breadcrumb];
}

export default async function LearnSpokePage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const page = getLearnPageBySlug(slug);
  if (!page) return notFound();

  const pillar = getPillarBySlug(page.pillarSlug);
  const siblings = LEARN_PAGES.filter((s) => page.siblingSlugs.includes(s.slug));
  const jsonLdBlocks = buildJsonLd(page, slug, pillar?.h1 ?? "Solutions", page.pillarSlug);

  return (
    <>
      {jsonLdBlocks.map((block, i) => (
        <script
          key={i}
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(block).replace(/</g, "\\u003c") }}
        />
      ))}

      <main className="mx-auto max-w-2xl px-4 py-10 sm:py-14">
        <nav aria-label="Breadcrumb" className="mb-6 flex flex-wrap items-center gap-2 text-xs text-cp-muted">
          <Link href="/" className="hover:text-cp-text transition-colors">Home</Link>
          <span>/</span>
          {pillar && (
            <>
              <Link href={`/solutions/${pillar.slug}`} className="hover:text-cp-text transition-colors">
                {pillar.h1}
              </Link>
              <span>/</span>
            </>
          )}
          <span className="text-cp-text">{page.h1}</span>
        </nav>

        <article>
          <h1 className="mb-6 text-3xl font-bold leading-tight tracking-tight text-cp-text sm:text-4xl">
            {page.h1}
          </h1>

          <div className="space-y-4">
            {page.problem.map((para, i) => (
              <p key={i} className="text-lg leading-relaxed text-cp-text">{para}</p>
            ))}
          </div>

          <section className="mt-9">
            <h2 className="mb-3 text-xl font-bold text-cp-text">Why single-model AI creates this risk</h2>
            <div className="space-y-4">
              {page.singleModelRisk.map((para, i) => (
                <p key={i} className="leading-relaxed text-cp-text">{para}</p>
              ))}
            </div>
          </section>

          <section className="mt-9">
            <h2 className="mb-3 text-xl font-bold text-cp-text">How a multi-model panel addresses it</h2>
            <div className="space-y-4">
              {page.multiModelSolution.map((para, i) => (
                <p key={i} className="leading-relaxed text-cp-text">{para}</p>
              ))}
            </div>
          </section>

          <section className="mt-9">
            <h2 className="mb-3 text-xl font-bold text-cp-text">Worked example</h2>
            <div className="space-y-4">
              {page.workedExample.map((para, i) => (
                <p key={i} className="leading-relaxed text-cp-text">{para}</p>
              ))}
            </div>
          </section>

          <section className="mt-9">
            <h2 className="mb-3 text-xl font-bold text-cp-text">Considerations</h2>
            <ul className="space-y-2">
              {page.considerations.map((item, i) => (
                <li key={i} className="flex gap-2.5 text-base leading-relaxed text-cp-muted">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-cp-muted" />
                  {item}
                </li>
              ))}
            </ul>
          </section>

          <section className="mt-12">
            <h2 className="mb-5 text-xl font-bold text-cp-text">Frequently asked questions</h2>
            <div className="space-y-6">
              {page.faq.map(({ q, a }, i) => (
                <div key={i}>
                  <h3 className="mb-2 text-base font-semibold text-cp-text">{q}</h3>
                  <p className="leading-relaxed text-cp-text">{a}</p>
                </div>
              ))}
            </div>
          </section>

          {(pillar || siblings.length > 0) && (
            <section className="mt-12 rounded-xl border border-cp-border bg-cp-raised px-6 py-5">
              <h2 className="mb-4 text-sm font-bold uppercase tracking-widest text-cp-muted">
                Related
              </h2>
              <ul className="space-y-2">
                {pillar && (
                  <li>
                    <Link
                      href={`/solutions/${pillar.slug}`}
                      className="group flex items-center gap-2 text-sm font-medium text-cp-text hover:text-cp-primary transition-colors"
                    >
                      <span className="text-cp-muted group-hover:text-cp-primary transition-colors">→</span>
                      {pillar.h1}
                    </Link>
                  </li>
                )}
                {siblings.map((s) => (
                  <li key={s.slug}>
                    <Link
                      href={`/learn/${s.slug}`}
                      className="group flex items-center gap-2 text-sm font-medium text-cp-text hover:text-cp-primary transition-colors"
                    >
                      <span className="text-cp-muted group-hover:text-cp-primary transition-colors">→</span>
                      {s.h1}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <div className="mt-10 rounded-2xl bg-cp-raised px-8 py-10 text-center">
            <p className="mb-6 text-lg font-semibold text-cp-text">{page.cta}</p>
            <Link
              href="/signup"
              className="inline-block rounded-lg bg-sky-500 px-7 py-3 text-sm font-bold text-white shadow-sm hover:bg-sky-400 transition-colors"
            >
              Get started →
            </Link>
          </div>
        </article>
      </main>
    </>
  );
}
