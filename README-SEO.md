# SEO setup — ConvergePanel

This documents how to verify the site in Google Search Console and Bing
Webmaster Tools, submit the sitemap, and how IndexNow is wired for instant
indexing. It covers the whole site (pSEO `/use-cases/*` pages plus the
`/solutions/*` + `/learn/*` cluster).

## Cluster architecture

- `lib/pseo/pages.ts` → `/use-cases/[slug]`
- `lib/solutions/pages.ts` → `/solutions/[slug]` (pillar pages)
- `lib/learn/pages.ts` → `/learn/[slug]` (spoke pages, each tied to one pillar via `pillarSlug`)

All three feed `app/sitemap.ts` automatically — adding an entry to any of the
three arrays makes it appear in `/sitemap.xml` on the next build with no
other changes needed.

## Google Search Console

1. **Verify the property**: Search Console → Add property → Domain or URL-prefix
   for `https://convergepanel.com`. The fastest method here is the **HTML tag**
   option — copy the `content` value it gives you and set it as the
   `GOOGLE_SITE_VERIFICATION` environment variable in Vercel (Project →
   Settings → Environment Variables), then redeploy. `app/layout.tsx` renders
   the verification meta tag automatically once that env var is set — no code
   change needed for future re-verification.
2. **Submit the sitemap**: Search Console → Sitemaps → enter `sitemap.xml` →
   Submit. The full URL is `https://convergepanel.com/sitemap.xml`.
3. **Request indexing for the two pillar pages first**: URL Inspection →
   paste `https://convergepanel.com/solutions/ma-due-diligence` → Request
   Indexing. Repeat for `https://convergepanel.com/solutions/cre-due-diligence`
   once it exists. Pillars first because every spoke links to its pillar and
   back, so getting the pillar indexed and crawled tends to pull the linked
   spokes in faster than submitting them in an arbitrary order.

## Bing Webmaster Tools

1. **Verify the property**: two options —
   - Import directly from Google Search Console (Bing Webmaster Tools →
     Add a site → "Import from Google Search Console") if GSC is already
     verified — this is the fastest path and requires no new meta tag.
   - Or verify independently: Bing Webmaster Tools → add site → "Meta tag"
     option → copy the `content` value → set as `BING_SITE_VERIFICATION` in
     Vercel env vars → redeploy. `app/layout.tsx` renders it as
     `<meta name="msvalidate.01" content="...">` automatically once set.
2. **Submit the sitemap**: Bing Webmaster Tools → Sitemaps → submit
   `https://convergepanel.com/sitemap.xml`.
3. **IndexNow** (see below) already pings Bing on every submission — the
   sitemap submission above is the fallback discovery path, not the primary
   one.

## IndexNow (instant indexing)

Already implemented and live — this is not new infrastructure, it's the
same system used for the `/use-cases/*` pages, extended to also cover
`/solutions/*` and `/learn/*`.

- **Key file**: `public/97ce1cedaadd35047076e3cc65939bd8.txt`, served at
  `https://convergepanel.com/97ce1cedaadd35047076e3cc65939bd8.txt`. The key
  is a plain constant in `scripts/submit-indexnow.mjs` (not an env var) —
  it's not a secret (IndexNow keys are meant to be public; they only prove
  you control the domain), so there was no reason to move a working system
  behind an env var for this batch.
- **Submit script**: `scripts/submit-indexnow.mjs`. It reads
  `lib/pseo/pages.ts`, `lib/solutions/pages.ts`, and `lib/learn/pages.ts`,
  and tracks what's already been submitted in `scripts/.indexnow-state.json`
  (gitignored, local to each machine/CI runner).

  ```bash
  node scripts/submit-indexnow.mjs                 # only pages changed since last run
  node scripts/submit-indexnow.mjs --all           # every URL across all three sources
  node scripts/submit-indexnow.mjs some-slug       # one or more specific slugs, any source
  ```

  Run status is printed directly (HTTP 200 from `api.indexnow.org` means
  Bing/Yandex/Seznam/Naver all received the submission).

- **Wiring it to run post-deploy**: there's no CI provider hardcoded here by
  design — wire it to whatever you deploy with. Two common options:
  - **Vercel deploy hook**: add a step in your deploy pipeline (or a manual
    `npm run seo:indexnow` right after `vercel --prod` finishes) that runs
    `node scripts/submit-indexnow.mjs` with no args — it only submits
    slugs whose `publishedAt` changed since the last run, so it's safe to
    run after every deploy without re-submitting the whole site each time.
  - **Manual**: `npm run seo:indexnow` (already an npm script) any time
    after a content change, or `node scripts/submit-indexnow.mjs slug-a
    slug-b` right after editing specific pages.

## Content-change tracking caveat

The script's default (no-args) mode diffs each page's `publishedAt` field
against the last recorded submission — it does **not** diff title, meta
description, or body content. If you edit a page's copy without bumping
`publishedAt`, the default run won't pick it up as changed. Either bump
`publishedAt` on real content edits, or submit the slug explicitly:
`node scripts/submit-indexnow.mjs the-slug-you-edited`.

## Verifying it's working

- `curl -I https://convergepanel.com/97ce1cedaadd35047076e3cc65939bd8.txt`
  should return `200`.
- `curl https://convergepanel.com/sitemap.xml` should list every
  `/use-cases/*`, `/solutions/*`, and `/learn/*` URL.
- Bing Webmaster Tools → URL Inspection on any submitted URL will show
  "Discovered" shortly after submission, moving to "Crawled" / "Indexed" on
  Bing's own schedule — IndexNow accelerates discovery, it doesn't guarantee
  an instant crawl.
