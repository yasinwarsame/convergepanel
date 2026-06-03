# ConvergePanel — Technical SEO Audit

**Domain:** https://convergepanel.com
**Audited:** 2026-06-01 (Firecrawl crawl + source review)
**Stack:** Next.js App Router (SSG/SSR), deployed on Vercel
**Pages discovered:** 110 (8 core pages + 102 programmatic `/use-cases/*` pages)

> This report is written for Claude Code. Each issue lists **severity**, **evidence**, the **file(s) to edit**, and a **concrete fix**. Work top-down: P0 → P1 → P2.

---

## TL;DR

The programmatic `/use-cases/*` pages are **well optimized** (unique titles/descriptions, canonical, OpenGraph, Twitter Card, and Article/HowTo/FAQ JSON-LD all present). The biggest problems are on the **homepage and other static pages**, plus a **site-wide HTML semantics bug**:

1. **P0 — Homepage & static pages have no canonical, no OpenGraph, no Twitter Card, no structured data.** Sharing `convergepanel.com` produces a blank social preview.
2. **P0 — Site-wide duplicate `<h1>`:** the logo wordmark in the header is an `<h1>`, so *every* page has two `<h1>`s.
3. **P1 — `metadataBase` not set**, sitemap `lastmod` is fake (build time), `robots.txt` `Disallow` rules don't match Next.js routes.
4. **P2 — Missing `BreadcrumbList` schema, Organization/WebSite schema, sized favicons, and image-filename hygiene.**

---

## What's already good (don't touch)

- `robots.txt` is valid and references the sitemap.
- `sitemap.xml` is valid XML with all 110 URLs.
- Every `/use-cases/*` page has: unique `<title>`, unique meta description, `rel=canonical`, full OpenGraph, Twitter `summary_large_image`, and JSON-LD (`Article` / `HowTo` / `FAQPage`).
- Clean in-content heading hierarchy (`h1 → h2 → h3`), internal linking (breadcrumb + related pages), `lang="en"`, mobile viewport, HTTPS, `200` responses, `force-static` use-case pages.

---

## P0 — Critical

### 1. Homepage & static pages missing canonical, OpenGraph, Twitter, structured data

**Evidence (live `<head>` of `/`):** only `charset`, `viewport`, `<title>`, `meta description`, and icon links. No `og:*`, no `twitter:*`, no `rel=canonical`, no JSON-LD. Same gap applies to `/about`, `/pricing`, `/contact`, `/help`, `/terms`, `/privacy`.

**Root cause:** `app/page.tsx` is a `"use client"` component and exports **no** metadata, so the homepage inherits only the defaults in `app/layout.tsx` — and those defaults contain no `openGraph`, `twitter`, `metadataBase`, or `alternates`.

**Files:** `app/layout.tsx` (defaults) + each static page's `metadata` export.

**Fix A — add rich defaults + `metadataBase` in `app/layout.tsx`:**

```tsx
export const metadata: Metadata = {
  metadataBase: new URL("https://convergepanel.com"),
  title: {
    default: "ConvergePanel — Multi-model research & claim verification",
    template: "%s | ConvergePanel",
  },
  description:
    "Multi-model AI research, claim verification, video authenticity analysis (paid plans), and governance scoring — with audit trails.",
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    siteName: "ConvergePanel",
    url: "https://convergepanel.com",
    title: "ConvergePanel — Multi-model research & claim verification",
    description:
      "Don't trust one AI. Verify with five. Multi-model research, claim verification, video authenticity, and governance — with audit trails.",
    images: [{ url: "/Claim%20Verification.png", width: 2004, height: 1842, alt: "ConvergePanel" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "ConvergePanel — Multi-model research & claim verification",
    description:
      "Don't trust one AI. Verify with five. Multi-model research, claim verification, and video authenticity with audit trails.",
    images: ["/Claim%20Verification.png"],
  },
  icons: {
    icon: [{ url: "/convergepanel-logo.png", type: "image/png" }],
    shortcut: "/convergepanel-logo.png",
    apple: "/convergepanel-logo.png",
  },
};
```

> Note: a default `alternates.canonical: "/"` in the layout is inherited by every page that doesn't set its own. The `/use-cases/*` pages already override it (good). **You must add a per-page `alternates.canonical` to the other static pages** (Fix B) so they don't all canonicalize to `/`.

**Fix B — add a `metadata` export with a self-referencing canonical to each static page** (`app/about/page.tsx`, `app/pricing/page.tsx`, `app/contact/page.tsx`, `app/help/page.tsx`, `app/terms/page.tsx`, `app/privacy/page.tsx`). Example for `/about`:

```tsx
export const metadata: Metadata = {
  title: "About",
  description: "What ConvergePanel is and why multi-model verification matters.",
  alternates: { canonical: "/about" },
  openGraph: { url: "https://convergepanel.com/about", title: "About ConvergePanel" },
};
```

**Fix C — homepage canonical.** Because `app/page.tsx` is a client component it cannot export `metadata`. Either:
- (preferred) the layout default `alternates.canonical: "/"` covers it, **or**
- extract the landing markup into a server component and add `export const metadata = { alternates: { canonical: "/" } }`.

---

### 2. Site-wide duplicate `<h1>` (logo wordmark is an `<h1>`)

**Evidence:** every page (homepage and all use-case pages) renders **two** `<h1>`s — the header logo "ConvergePanel" **and** the page's real `<h1>`. Two `<h1>`s dilute the page's primary heading signal.

**File:** `components/TopNav.tsx`, lines ~106–109.

**Fix:** the logo is branding, not the page heading. Demote it to a non-heading element:

```tsx
{/* was <h1> — branding only, must not compete with the page heading */}
<span className="text-2xl md:text-3xl font-semibold tracking-tight">
  <span className="text-slate-900">Converge</span>
  <span className="text-sky-600">Panel</span>
</span>
```

This leaves exactly one `<h1>` per page (the hero `<h1>` on `/`, the `page.h1` on use-case pages).

---

## P1 — High

### 3. Sitemap `lastModified` is the build timestamp for every URL

**Evidence:** all 110 entries share an identical `<lastmod>` (`2026-05-31T22:42:09Z`) because the code uses `new Date()` at build time. Identical/always-changing `lastmod` is ignored by Google and wastes the signal.

**File:** `app/sitemap.ts`.

**Fix:** use real content dates. Use-case pages already carry `publishedAt` in `lib/pseo/pages.ts`; static routes can use a stable constant per route.

```tsx
const useCaseEntries = PAGES.map((page) => ({
  url: `${BASE}/use-cases/${page.slug}`,
  lastModified: new Date(page.publishedAt ?? "2026-05-28"),
  changeFrequency: "monthly" as const,
  priority: 0.7,
}));
```

Add an explicit `lastModified` per static route too (don't recompute `now` on every build).

### 4. `robots.txt` `Disallow` rules don't match Next.js routes

**Evidence:** `robots.txt` disallows `/login/`, `/admin/`, `/profile/`, `/billing/`, `/onboarding/`, `/api/`. Next.js serves these **without** a trailing slash (`/login`, `/admin`, …). A `Disallow: /login/` rule does **not** block `/login`. The crawl confirmed `/login` is reachable/indexable.

**File:** `app/robots.ts`.

**Fix:** drop the trailing slashes so the prefix matches both forms:

```ts
disallow: ["/admin", "/api", "/profile", "/billing", "/onboarding", "/login"],
```

(Keep `/signup` crawlable as decided.) Re-verify the rendered `/robots.txt` after deploy.

### 5. `/signup` is crawlable but absent from the sitemap

**Decision needed:** if `/signup` has indexable, public-facing content (it was intentionally left out of `robots` `Disallow`), add it to `STATIC_ROUTES` in `app/sitemap.ts` so it's discoverable. If it's a bare auth form, instead add `/signup` to `robots` `Disallow` and a `robots: { index: false }` metadata. Pick one and be consistent.

---

## P2 — Medium / Polish

### 6. Add `BreadcrumbList` JSON-LD to use-case pages

**Evidence:** use-case pages render a visible breadcrumb ("Use cases / {Category}") but emit no `BreadcrumbList` schema.

**File:** `app/use-cases/[slug]/page.tsx` (`buildJsonLd`). Emit a second `<script type="application/ld+json">` (or a `@graph`) with:

```json
{
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  "itemListElement": [
    { "@type": "ListItem", "position": 1, "name": "Use cases", "item": "https://convergepanel.com/use-cases" },
    { "@type": "ListItem", "position": 2, "name": "{page.title}", "item": "https://convergepanel.com/use-cases/{slug}" }
  ]
}
```

### 7. Add Organization + WebSite structured data on the homepage

**File:** `app/layout.tsx` (or a server homepage). Add `Organization` (name, url, logo, sameAs social profiles) and `WebSite` JSON-LD. This strengthens brand/entity signals and Knowledge Panel eligibility.

### 8. `Article` `dateModified` always equals `datePublished`

**File:** `app/use-cases/[slug]/page.tsx` (`buildJsonLd`, line ~94). Track a real `updatedAt` in `lib/pseo/pages.ts` and use it for `dateModified`; keep `datePublished` separate.

### 9. Social-image filenames contain spaces

**Evidence:** OG/Twitter images are `/Claim%20Verification.png`, `/Deep%20Research.png`, etc. URL-encoded spaces work but are fragile across scrapers/CDNs.

**Files:** `public/*.png` + `OG_IMAGES` map in `app/use-cases/[slug]/page.tsx`. Rename to hyphenated (`claim-verification.png`, `deep-research.png`, …) and update references.

### 10. Provide proper sized favicons

**Evidence:** `icon`, `shortcut`, and `apple-touch-icon` all point to the full-resolution `convergepanel-logo.png`. Browsers downscale a large PNG for the tab icon.

**Fix:** add `app/icon.png` (32×32) and `app/apple-icon.png` (180×180) (Next.js file-based metadata) or a real `favicon.ico`. Remove the manual `icons` overrides once added.

### 11. Homepage hero image has empty `alt`

**File:** `components/LandingPage.tsx` (hero `<Image>` with `alt=""`). If decorative this is acceptable; otherwise give it a descriptive `alt` (e.g., "ConvergePanel multi-model research panel") for image SEO.

### 12. Optional: `theme-color` meta

Add `themeColor` to layout metadata for mobile browser chrome polish (low impact).

---

## Suggested execution order for Claude Code

1. `components/TopNav.tsx` — demote logo `<h1>` → `<span>` (issue #2).
2. `app/layout.tsx` — add `metadataBase`, default `openGraph`, `twitter`, title template, `alternates.canonical: "/"` (issue #1A, #7).
3. Static pages (`about`, `pricing`, `contact`, `help`, `terms`, `privacy`) — add `metadata` with self-canonical (issue #1B).
4. `app/robots.ts` — strip trailing slashes (issue #4).
5. `app/sitemap.ts` — real `lastModified` + decide on `/signup` (issues #3, #5).
6. `app/use-cases/[slug]/page.tsx` — add `BreadcrumbList`, real `dateModified` (issues #6, #8).
7. Image/favicon hygiene (issues #9, #10, #11).

After deploy, validate:
- View source of `/`, `/about`, `/pricing` → confirm one `<h1>`, canonical, OG, Twitter tags.
- https://search.google.com/test/rich-results on a use-case URL (Article + Breadcrumb).
- Re-fetch `/robots.txt` and `/sitemap.xml` to confirm rule/format changes.
