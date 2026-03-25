#!/usr/bin/env node
/**
 * One-off / maintenance script: prepends a concise block-comment file header to TypeScript
 * sources under lib/, app/, components/, hooks/ when the file does not already start
 * with a block comment. Keeps "use client" as the very first line when present.
 *
 * Usage: node scripts/ensure-file-headers.mjs
 *        node scripts/ensure-file-headers.mjs --dry-run
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DRY = process.argv.includes("--dry-run");

const SCAN_DIRS = ["lib", "app", "components", "hooks", "prisma"];
const ROOT_FILES = ["middleware.ts"];

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const name of fs.readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) walk(full, acc);
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts")) acc.push(full);
  }
  return acc;
}

function hasLeadingBlockComment(s) {
  let t = s.trimStart();
  if (t.startsWith('"use client"')) {
    const nl = t.indexOf("\n");
    if (nl === -1) return false;
    t = t.slice(nl + 1).trimStart();
  }
  return t.startsWith("/*") || t.startsWith("//");
}

function describeFile(rel) {
  const norm = rel.split(path.sep).join("/");
  if (norm === "middleware.ts") {
    return "Next.js middleware: auth gating, redirects, and request guards at the edge.";
  }
  if (norm.startsWith("app/api/") && norm.endsWith("/route.ts")) {
    const p = norm.replace(/^app\/api\//, "").replace(/\/route\.ts$/, "");
    return `HTTP API route (${p}): server handler, auth, and JSON responses.`;
  }
  if (norm.startsWith("app/") && norm.endsWith("/page.tsx")) {
    return `App Router page (${norm.replace(/^app\//, "").replace(/\/page\.tsx$/, "")}): UI route entry.`;
  }
  if (norm === "app/layout.tsx") {
    return "Root layout: global HTML shell, fonts, providers, and metadata.";
  }
  if (norm === "app/error.tsx" || norm === "app/global-error.tsx") {
    return "Next.js error UI boundary for this segment or the whole app.";
  }
  if (norm.startsWith("components/")) {
    const base = path.basename(norm, path.extname(norm));
    return `React component (${base}): UI for the main app or marketing shell.`;
  }
  if (norm.startsWith("lib/connectors/")) {
    return `LLM connector adapter: provider-specific HTTP, auth, and response shaping.`;
  }
  if (norm.startsWith("lib/firestore/")) {
    return `Firestore persistence: typed reads/writes and helpers for server-side data.`;
  }
  if (norm.startsWith("lib/verification/")) {
    return `Claim verification pipeline: parsing, scoring, audit bundles, and prompts.`;
  }
  if (norm.startsWith("lib/synthesis/")) {
    return `Synthesis layer: structured report schema, evidence packing, and transforms.`;
  }
  if (norm.startsWith("lib/governance/")) {
    return `Team governance: policies, consensus thresholds, and review workflows.`;
  }
  if (norm.startsWith("lib/teams/")) {
    return `Teams API helpers: auth context, policy validation, and membership rules.`;
  }
  if (norm.startsWith("lib/user/")) {
    return `User-facing server utilities: history payloads and cross-feature mappers.`;
  }
  if (norm.startsWith("lib/firebase/")) {
    return `Firebase client or Admin SDK setup, auth helpers, and shared config.`;
  }
  if (norm.startsWith("lib/")) {
    return `Shared library module (${path.basename(norm)}): domain logic used by API routes and UI.`;
  }
  if (norm === "prisma/seed.ts") {
    return "Prisma seed script: optional dev/test data (run via prisma db seed).";
  }
  return `ConvergePanel source file (${norm}).`;
}

function buildHeader(rel) {
  const body = describeFile(rel);
  return `/**\n * ${body}\n */\n\n`;
}

function processFile(absPath) {
  const rel = path.relative(ROOT, absPath);
  if (rel.includes(`${path.sep}__tests__${path.sep}`) || rel.includes("/__tests__/")) return;

  let raw = fs.readFileSync(absPath, "utf8");
  if (hasLeadingBlockComment(raw)) return;

  const header = buildHeader(rel.split(path.sep).join("/"));
  let out;

  if (raw.startsWith('"use client"')) {
    const nl = raw.indexOf("\n");
    const first = raw.slice(0, nl + 1);
    const rest = raw.slice(nl + 1);
    out = first + "\n" + header + rest.replace(/^\n+/, "");
  } else {
    out = header + raw;
  }

  if (DRY) {
    console.log("[dry-run] would update:", rel);
    return;
  }
  fs.writeFileSync(absPath, out, "utf8");
  console.log("updated:", rel);
}

let count = 0;
for (const d of SCAN_DIRS) {
  const base = path.join(ROOT, d);
  for (const f of walk(base)) {
    processFile(f);
    count++;
  }
}
for (const rf of ROOT_FILES) {
  const abs = path.join(ROOT, rf);
  if (fs.existsSync(abs)) processFile(abs);
}

console.log(DRY ? `Dry run scanned (files touched only listed above).` : `Done.`);
