// Submits PSEO + static URLs to IndexNow (fans out to Bing, Yandex, Seznam, Naver)
// so pages get crawled promptly instead of waiting on Bing's own crawl schedule.
//
// Usage:
//   node scripts/submit-indexnow.mjs              # submit only new/changed use-case pages since last run
//   node scripts/submit-indexnow.mjs --all         # submit every URL in the sitemap
//   node scripts/submit-indexnow.mjs slug-a slug-b # submit specific use-case slugs
//
// Key file: public/<key>.txt must match INDEXNOW_KEY below (served at
// https://convergepanel.com/<key>.txt for protocol verification).

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "https://convergepanel.com";
const INDEXNOW_KEY = "97ce1cedaadd35047076e3cc65939bd8";
const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";
const STATE_FILE = join(root, "scripts", ".indexnow-state.json");

const STATIC_URLS = [
  "", "/pricing", "/about", "/contact", "/help", "/use-cases", "/terms", "/privacy",
];

function parsePages() {
  const src = readFileSync(join(root, "lib/pseo/pages.ts"), "utf8");
  const lines = src.split("\n");
  const pages = [];
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const slugMatch = lines[i].match(/^\s*slug:\s*"([^"]+)"/);
    if (slugMatch) {
      if (current) pages.push(current);
      current = { slug: slugMatch[1], publishedAt: null };
      continue;
    }
    if (current) {
      const pubMatch = lines[i].match(/^\s*publishedAt:\s*"([^"]+)"/);
      if (pubMatch) current.publishedAt = pubMatch[1];
    }
  }
  if (current) pages.push(current);
  return pages;
}

function loadState() {
  if (!existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {};
  }
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + "\n");
}

async function submit(urls) {
  if (urls.length === 0) {
    console.log("Nothing to submit.");
    return true;
  }
  console.log(`Submitting ${urls.length} URL(s) to IndexNow:\n  ${urls.join("\n  ")}`);
  const res = await fetch(INDEXNOW_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({
      host: "convergepanel.com",
      key: INDEXNOW_KEY,
      keyLocation: `${BASE}/${INDEXNOW_KEY}.txt`,
      urlList: urls,
    }),
  });
  if (!res.ok) {
    console.error(`IndexNow submission failed: ${res.status} ${await res.text()}`);
    process.exitCode = 1;
    return false;
  }
  console.log(`IndexNow accepted submission (${res.status}).`);
  return true;
}

const args = process.argv.slice(2);
const pages = parsePages();

if (args.includes("--all")) {
  const urls = [...STATIC_URLS.map((p) => `${BASE}${p}`), ...pages.map((p) => `${BASE}/use-cases/${p.slug}`)];
  const ok = await submit(urls);
  if (ok) {
    const state = {};
    for (const p of pages) state[p.slug] = p.publishedAt;
    saveState(state);
  }
} else if (args.length > 0) {
  const requested = new Set(args);
  const matched = pages.filter((p) => requested.has(p.slug));
  const missing = args.filter((slug) => !pages.some((p) => p.slug === slug));
  if (missing.length > 0) console.warn(`Warning: unknown slug(s), skipping: ${missing.join(", ")}`);
  const ok = await submit(matched.map((p) => `${BASE}/use-cases/${p.slug}`));
  if (ok) {
    const state = loadState();
    for (const p of matched) state[p.slug] = p.publishedAt;
    saveState(state);
  }
} else {
  const state = loadState();
  const changed = pages.filter((p) => state[p.slug] !== p.publishedAt);
  const ok = await submit(changed.map((p) => `${BASE}/use-cases/${p.slug}`));
  if (ok) {
    const newState = { ...state };
    for (const p of pages) newState[p.slug] = p.publishedAt;
    saveState(newState);
  }
}
