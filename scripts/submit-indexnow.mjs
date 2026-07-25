// Submits pSEO + solutions/learn + static URLs to IndexNow (fans out to Bing,
// Yandex, Seznam, Naver) so pages get crawled promptly instead of waiting on
// each engine's own crawl schedule.
//
// Usage:
//   node scripts/submit-indexnow.mjs              # submit only new/changed pages since last run
//   node scripts/submit-indexnow.mjs --all         # submit every URL across all sources
//   node scripts/submit-indexnow.mjs slug-a slug-b # submit specific slugs (any source)
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

// Each source file's slug/publishedAt fields, mapped to its route prefix.
const SOURCES = [
  { file: "lib/pseo/pages.ts", prefix: "/use-cases" },
  { file: "lib/solutions/pages.ts", prefix: "/solutions" },
  { file: "lib/learn/pages.ts", prefix: "/learn" },
];

function parsePages(file, prefix) {
  const src = readFileSync(join(root, file), "utf8");
  const lines = src.split("\n");
  const pages = [];
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const slugMatch = lines[i].match(/^\s*slug:\s*"([^"]+)"/);
    if (slugMatch) {
      if (current) pages.push(current);
      current = { slug: slugMatch[1], publishedAt: null, prefix };
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

function loadAllPages() {
  return SOURCES.flatMap(({ file, prefix }) => parsePages(file, prefix));
}

function stateKey(p) {
  return `${p.prefix}/${p.slug}`;
}

function urlFor(p) {
  return `${BASE}${p.prefix}/${p.slug}`;
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
const pages = loadAllPages();

if (args.includes("--all")) {
  const urls = [...STATIC_URLS.map((p) => `${BASE}${p}`), ...pages.map(urlFor)];
  const ok = await submit(urls);
  if (ok) {
    const state = {};
    for (const p of pages) state[stateKey(p)] = p.publishedAt;
    saveState(state);
  }
} else if (args.length > 0) {
  const requested = new Set(args);
  const matched = pages.filter((p) => requested.has(p.slug));
  const missing = args.filter((slug) => !pages.some((p) => p.slug === slug));
  if (missing.length > 0) console.warn(`Warning: unknown slug(s), skipping: ${missing.join(", ")}`);
  const ok = await submit(matched.map(urlFor));
  if (ok) {
    const state = loadState();
    for (const p of matched) state[stateKey(p)] = p.publishedAt;
    saveState(state);
  }
} else {
  const state = loadState();
  const changed = pages.filter((p) => state[stateKey(p)] !== p.publishedAt);
  const ok = await submit(changed.map(urlFor));
  if (ok) {
    const newState = { ...state };
    for (const p of pages) newState[stateKey(p)] = p.publishedAt;
    saveState(newState);
  }
}
