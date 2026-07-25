import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { PILLARS, getPillarBySlug } from "@/lib/solutions/pages";
import { LEARN_PAGES } from "@/lib/learn/pages";

export const dynamic = "force-static";

const BASE = "https://convergepanel.com";
const DEFAULT_OG_IMAGE = { path: "/claim-verification.png", width: 2004, height: 1842 };

export async function generateStaticParams() {
  return PILLARS.map((p) => ({ slug: p.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const page = getPillarBySlug(slug);
  if (!page) return {};
  return {
    title: { absolute: `${page.title} | ConvergePanel` },
    description: page.metaDescription,
    alternates: { canonical: `${BASE}/solutions/${slug}` },
    openGraph: {
      title: `${page.title} | ConvergePanel`,
      description: page.metaDescription,
      type: "website",
      url: `${BASE}/solutions/${slug}`,
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

function buildJsonLd(page: NonNullable<ReturnType<typeof getPillarBySlug>>, slug: string) {
  const softwareApp = {
    "@context": "https://schema.org",
    "@type": "SoftwareApplication",
    name: "ConvergePanel",
    applicationCategory: "BusinessApplication",
    operatingSystem: "Web",
    url: BASE,
    description: page.metaDescription,
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD",
      description: "Free plan: up to 8 panel runs per month, 2 models per run.",
    },
  };
  const breadcrumb = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: BASE },
      { "@type": "ListItem", position: 2, name: page.h1, item: `${BASE}/solutions/${slug}` },
    ],
  };
  return [softwareApp, breadcrumb];
}

export default async function SolutionPillarPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const page = getPillarBySlug(slug);
  if (!page) return notFound();

  const spokes = LEARN_PAGES.filter((s) => s.pillarSlug === slug);
  const jsonLdBlocks = buildJsonLd(page, slug);

  return (
    <>
      {jsonLdBlocks.map((block, i) => (
        <script
          key={i}
          type="application/ld+json"
          dangerouslySetInnerHTML={{ __html: JSON.stringify(block).replace(/</g, "\\u003c") }}
        />
      ))}

      <main className="mx-auto max-w-4xl px-4 py-10 sm:py-14">
        <nav aria-label="Breadcrumb" className="mb-6 text-xs text-cp-muted">
          <Link href="/" className="hover:text-cp-text transition-colors">Home</Link>
          <span className="mx-2">/</span>
          <span className="text-cp-text">{page.h1}</span>
        </nav>

        <article>
          <h1 className="mb-6 text-3xl font-bold leading-tight tracking-tight text-cp-text sm:text-4xl">
            {page.h1}
          </h1>

          <div className="space-y-5">
            {page.intro.map((para, i) => (
              <p key={i} className="text-lg leading-relaxed text-cp-text">{para}</p>
            ))}
          </div>

          {page.sections.map((section, i) => (
            <section key={i} className="mt-10">
              <h2 className="mb-3 text-2xl font-semibold text-cp-text">{section.heading}</h2>
              <div className="space-y-4">
                {section.paragraphs.map((para, j) => (
                  <p key={j} className="leading-relaxed text-cp-muted">{para}</p>
                ))}
              </div>
            </section>
          ))}

          {spokes.length > 0 && (
            <section className="mt-12 rounded-xl border border-cp-border bg-cp-raised px-6 py-6">
              <h2 className="mb-4 text-sm font-bold uppercase tracking-widest text-cp-muted">
                Explore this cluster
              </h2>
              <ul className="space-y-2">
                {spokes.map((s) => (
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

          <section className="mt-10">
            <h2 className="mb-3 text-xl font-bold text-cp-text">Limitations</h2>
            <ul className="space-y-2">
              {page.limitations.map((item, i) => (
                <li key={i} className="flex gap-2.5 text-base leading-relaxed text-cp-muted">
                  <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-cp-muted" />
                  {item}
                </li>
              ))}
            </ul>
          </section>

          <div className="mt-12 rounded-2xl bg-cp-raised px-8 py-10 text-center">
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
