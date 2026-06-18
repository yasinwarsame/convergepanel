// Validates the pSEO use-case dataset for SEO integrity:
// - duplicate slugs / titles / h1s / meta descriptions
// - cross-page duplicate FAQ questions
// - relatedLinks pointing at /use-cases/<slug> that do not exist
// - hub (app/use-cases/page.tsx) referencing slugs that do not exist
// - pages missing from the hub
// Exits non-zero on hard failures so it can gate CI or a pre-deploy check.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pagesSrc = readFileSync(join(root, "lib/pseo/pages.ts"), "utf8");
const hubSrc = readFileSync(join(root, "app/use-cases/page.tsx"), "utf8");

const lines = pagesSrc.split("\n");
const firstString = (line) => {
  const m = line.match(/"((?:[^"\\]|\\.)*)"/);
  return m ? m[1] : null;
};
// Some records wrap a field value onto the next line(s). Given a line and its
// index, return the string value on that line, else look ahead a few lines.
const valueAt = (i) => {
  const here = firstString(lines[i]);
  if (here) return here;
  for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
    const v = firstString(lines[j]);
    if (v) return v;
  }
  return null;
};

const slugs = [];
const titles = [];
const h1s = [];
const metas = [];
const faqs = []; // { q, slug }
const relatedHrefs = []; // { slug (source), target }

let currentSlug = null;
let inFaq = false;
for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const t = line.trim();
  if (t.startsWith("slug:")) {
    currentSlug = firstString(line);
    if (currentSlug) slugs.push(currentSlug);
    inFaq = false;
  } else if (t.startsWith("title:")) {
    const v = valueAt(i);
    if (v) titles.push(v);
  } else if (t.startsWith("h1:")) {
    const v = valueAt(i);
    if (v) h1s.push(v);
  } else if (t.startsWith("metaDescription:")) {
    const v = valueAt(i);
    if (v) metas.push(v);
  } else if (t.startsWith("faq:")) {
    inFaq = true;
  } else if (t.startsWith("relatedLinks:") || t.startsWith("bodySections:")) {
    inFaq = false;
  } else if (inFaq && t.startsWith("q:")) {
    const v = valueAt(i);
    if (v) faqs.push({ q: v, slug: currentSlug });
  }
  const hrefMatch = line.match(/href:\s*"\/use-cases\/([a-z0-9-]+)"/);
  if (hrefMatch) relatedHrefs.push({ slug: currentSlug, target: hrefMatch[1] });
}

const slugSet = new Set(slugs);

const findDupes = (arr) => {
  const seen = new Map();
  const dupes = [];
  for (const v of arr) {
    const key = v.toLowerCase();
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  for (const [k, n] of seen) if (n > 1) dupes.push({ value: k, count: n });
  return dupes;
};

// Hub slugs: only parse the contents of `slugs: [ ... ]` blocks.
const hubStart = hubSrc.indexOf("const HUB_GROUPS");
const hubEnd = hubSrc.indexOf("export default", hubStart);
const hubRegion = hubSrc.slice(hubStart, hubEnd);
const hubSlugs = [];
const slugBlockRe = /slugs:\s*\[([\s\S]*?)\]/g;
let blk;
while ((blk = slugBlockRe.exec(hubRegion)) !== null) {
  for (const m of blk[1].matchAll(/"([a-z0-9-]+)"/g)) hubSlugs.push(m[1]);
}
const hubSlugSet = new Set(hubSlugs);

const errors = [];
const warnings = [];

const dupSlugs = findDupes(slugs);
if (dupSlugs.length) errors.push(`Duplicate slugs: ${JSON.stringify(dupSlugs)}`);

const dupTitles = findDupes(titles);
if (dupTitles.length) errors.push(`Duplicate titles: ${JSON.stringify(dupTitles)}`);

const dupH1 = findDupes(h1s);
if (dupH1.length) errors.push(`Duplicate H1s: ${JSON.stringify(dupH1)}`);

const dupMeta = findDupes(metas);
if (dupMeta.length) errors.push(`Duplicate meta descriptions: ${JSON.stringify(dupMeta)}`);

const dupFaq = findDupes(faqs.map((f) => f.q));
if (dupFaq.length) warnings.push(`Cross-page duplicate FAQ questions: ${JSON.stringify(dupFaq)}`);

const brokenRelated = relatedHrefs.filter((r) => !slugSet.has(r.target));
if (brokenRelated.length) {
  errors.push(
    `Broken relatedLinks (target slug missing): ${JSON.stringify(
      brokenRelated.map((r) => `${r.slug} -> ${r.target}`)
    )}`
  );
}

const brokenHub = [...hubSlugSet].filter((s) => !slugSet.has(s));
if (brokenHub.length) errors.push(`Hub references missing slugs: ${JSON.stringify(brokenHub)}`);

const missingFromHub = slugs.filter((s) => !hubSlugSet.has(s));
if (missingFromHub.length) warnings.push(`Pages not linked from hub (${missingFromHub.length}): ${JSON.stringify(missingFromHub)}`);

console.log(`pSEO validation`);
console.log(`  pages:            ${slugs.length}`);
console.log(`  titles:           ${titles.length}`);
console.log(`  h1s:              ${h1s.length}`);
console.log(`  meta descriptions:${metas.length}`);
console.log(`  faq questions:    ${faqs.length}`);
console.log(`  relatedLinks:     ${relatedHrefs.length}`);
console.log(`  hub slugs:        ${hubSlugSet.size}`);
console.log("");

if (warnings.length) {
  console.log("WARNINGS:");
  for (const w of warnings) console.log("  - " + w);
  console.log("");
}

if (errors.length) {
  console.log("ERRORS:");
  for (const e of errors) console.log("  - " + e);
  process.exit(1);
}

console.log("OK: no hard errors.");
