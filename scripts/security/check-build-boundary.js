#!/usr/bin/env node
/**
 * BUILD BOUNDARY CHECKER (PR #295, Layer B) — run AFTER `npm run build`.
 *
 * Independently verifies, from the production build's own artifacts, that no
 * deployed output resolves, bundles or traces the SYSTEM_ADMIN claim tool.
 * FAILS CLOSED: any missing, stale, malformed, incomplete or unrecognised
 * evidence is a failure, never a pass.
 *
 *   1. Plugin manifests (lib/security/buildBoundary.js): present for every
 *      Next compiler, stamped with THIS run's nonce, and complete — positive
 *      controls must appear — with every module type recognised.
 *   2. Every manifest resource and every external request: no canonical path
 *      is a forbidden module.
 *   3. Next.js server file traces (*.nft.json, Next's own tracer, independent
 *      of the plugin): no traced file's realpath is forbidden.
 *   4. Emitted JavaScript (server, edge, static, worker chunks): none contains
 *      a string literal unique to the claim tool (uniqueness re-verified
 *      against the source tree on every run).
 *
 * Usage: CP_BUILD_BOUNDARY_NONCE=<nonce used for the build> node scripts/security/check-build-boundary.js [--dist .next]
 * Exit 0 only when every check passes; 1 otherwise (with every reason printed).
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { forbiddenSet, isForbidden, FORBIDDEN_FILES } = require("../../lib/security/buildBoundary");

const ROOT = path.resolve(__dirname, "..", "..");

/** Required compilers: Next 14 always builds these three for this app (server routes, middleware, browser). */
const REQUIRED_COMPILERS = ["server", "edge-server", "client"];
/** Positive controls: modules that MUST be in each compiler's evidence, proving the manifests are real and complete. */
const POSITIVE_CONTROLS = {
  server: ["app/api/admin/access/route.ts", "lib/admin/privilegedAccess.ts", "lib/admin/auditLog.ts", "app/api/admin/set-role/route.ts"],
  "edge-server": ["middleware.ts"],
  client: ["components/AuthProvider.tsx"],
};
/**
 * Resource-less modules, classified from the REAL Next 14 build (anything else fails closed):
 *   - webpack runtime modules (module.type === "runtime");
 *   - CSS modules (mini-css-extract);
 *   - context modules, whose directory must not be forbidden;
 *   - NormalModules without a resource ONLY when every loader is one of Next's own ENTRY loaders: they
 *     generate entry code whose imports are resolved through the same NormalModuleFactory (Layer A).
 */
const NEXT_ENTRY_LOADERS = new Set(["next:next-app-loader", "next:next-flight-client-entry-loader", "next:next-client-pages-loader", "next:next-middleware-loader", "next:next-route-loader", "next:next-flight-action-entry-loader", "next:next-edge-app-route-loader", "next:next-edge-function-loader", "next:next-edge-ssr-loader", "next:next-flight-server-reference-proxy-loader"]);
function classifyResourceless(o) {
  if (o.moduleType === "runtime") return null;
  if (o.type === "CssModule") return null;
  if (o.type === "ContextModule") return o.context ? null : "context module without a directory";
  if (o.type === "NormalModule") {
    if (!Array.isArray(o.loaders) || o.loaders.length === 0) return "resource-less NormalModule with no loader";
    const bad = o.loaders.filter((l) => !NEXT_ENTRY_LOADERS.has(l));
    return bad.length ? `resource-less NormalModule via non-entry loader(s) ${bad.join(", ")}` : null;
  }
  return `unrecognised module type ${o.type}`;
}
const KNOWN_RESOURCELESS = NEXT_ENTRY_LOADERS;
/** String literals unique to the claim tool (string literals survive minification; identifiers do not). */
const TOOL_LITERALS = [
  "operator_clock_out_of_tolerance",
  "stored_cutoff_ahead",
  "pre_call_read_failed",
  "revocation_cutoff_lowered",
  "sessions_revoke_unverified",
  "firestore-commit-time:users/{uid}.role",
  "Refusing: Firebase reports the operator",
  "Claim write:    SKIPPED",
];
const NODE_BUILTINS = new Set(require("node:module").builtinModules.flatMap((m) => [m, `node:${m}`]));

function walk(dir, pred, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, pred, out);
    else if (e.isFile() && pred(p)) out.push(p);
  }
  return out;
}

function sourceFilesOutside(root, exclude) {
  const SKIP = new Set(["node_modules", ".next", ".git", ".vercel", "coverage", "dist", "build", "out"]);
  const out = [];
  const rec = (rel) => {
    for (const e of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      if (rel === "" ? SKIP.has(e.name) : e.name === "node_modules" || e.name === ".git") continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) rec(r);
      else if (/\.(?:[cm]?[jt]sx?)$/.test(e.name) && !exclude(r)) out.push(r);
    }
  };
  rec("");
  return out;
}

/**
 * Pure check over a build directory. Returns { ok, failures[], summary }.
 * `opts.root` / `opts.dist` / `opts.nonce` are injectable for tests.
 */
function checkBuildBoundary(opts) {
  const root = opts.root || ROOT;
  const dist = path.resolve(root, opts.dist || ".next");
  const nonce = opts.nonce;
  const failures = [];
  const fail = (m) => failures.push(m);
  const set = forbiddenSet(root);
  const summary = { manifests: 0, compilers: {}, resources: 0, externals: 0, nftFiles: 0, nftEntries: 0, chunksScanned: 0 };

  if (!nonce) fail("no nonce: set CP_BUILD_BOUNDARY_NONCE to the value the build ran with (a missing nonce cannot prove the evidence is from this build)");
  if (!fs.existsSync(path.join(dist, "BUILD_ID"))) fail(`no production build at ${dist} (BUILD_ID missing): a skipped or failed build can never pass`);

  // 1-2. Manifests.
  const mdir = path.join(dist, "cp-build-boundary");
  const files = fs.existsSync(mdir) ? fs.readdirSync(mdir).filter((f) => f.endsWith(".json")) : [];
  if (files.length === 0) fail(`no build-boundary manifests in ${mdir}: the plugin did not run (next.config.js webpack hook missing?)`);
  const byCompiler = {};
  for (const f of files) {
    let m;
    try {
      m = JSON.parse(fs.readFileSync(path.join(mdir, f), "utf8"));
    } catch (e) {
      fail(`malformed manifest ${f}`);
      continue;
    }
    summary.manifests++;
    if (m.version !== 1 || !Array.isArray(m.resources) || !Array.isArray(m.externals) || !Array.isArray(m.other)) {
      fail(`manifest ${f} has an unexpected shape`);
      continue;
    }
    if (m.nonce !== nonce) fail(`manifest ${f} carries nonce ${JSON.stringify(m.nonce)}, expected ${JSON.stringify(nonce)} (stale or foreign evidence)`);
    const c = (byCompiler[m.compiler] = byCompiler[m.compiler] || { top: 0, child: 0, resources: new Set() });
    if (m.child) c.child++;
    else c.top++;
    for (const r of m.resources) {
      c.resources.add(r);
      summary.resources++;
      const abs = path.isAbsolute(r) ? r : path.join(root, r);
      if (isForbidden(abs, set)) fail(`FORBIDDEN module in ${m.compiler} evidence: ${r} (${f})`);
    }
    for (const o of m.other) {
      const why = classifyResourceless(o);
      if (why) fail(`${why} in ${m.compiler} (${f}): ${o.id} — fail closed until classified`);
      if (o.type === "ContextModule" && o.context && isForbidden(path.join(root, o.context, "__context_probe__"), set)) fail(`FORBIDDEN context directory ${o.context} in ${m.compiler} (${f})`);
    }
    for (const x of m.externals) {
      summary.externals++;
      const req = String(x.request || "").replace(/^(?:commonjs2?|module|node-commonjs|import|var|amd|umd|this|global|window|self|promise)\s+/, "");
      if (!req) {
        fail(`external with an empty request in ${m.compiler} (${f})`);
        continue;
      }
      if (NODE_BUILTINS.has(req)) continue;
      let resolved = null;
      if (path.isAbsolute(req)) resolved = req;
      else if (req.startsWith(".")) resolved = path.resolve(root, req);
      else {
        try {
          resolved = require.resolve(req, { paths: [root] });
        } catch {
          resolved = null; // a package not installed cannot load repo code at runtime
        }
      }
      if (resolved && isForbidden(resolved, set)) fail(`FORBIDDEN external in ${m.compiler}: ${x.request} -> ${path.relative(root, resolved)} (${f})`);
    }
  }
  for (const name of REQUIRED_COMPILERS) {
    const c = byCompiler[name];
    if (!c || c.top === 0) {
      fail(`no top-level manifest for the ${name} compiler: evidence incomplete`);
      continue;
    }
    for (const must of POSITIVE_CONTROLS[name]) if (!c.resources.has(must)) fail(`positive control ${must} missing from ${name} evidence: manifests incomplete`);
  }
  for (const [k, v] of Object.entries(byCompiler)) summary.compilers[k] = { top: v.top, child: v.child, resources: v.resources.size };

  // 3. Next.js server file traces.
  const nfts = walk(dist, (p) => p.endsWith(".nft.json"));
  summary.nftFiles = nfts.length;
  if (!nfts.some((p) => p.includes(`${path.sep}server${path.sep}app${path.sep}`))) fail("no server app .nft.json traces found: trace evidence incomplete");
  for (const n of nfts) {
    let j;
    try {
      j = JSON.parse(fs.readFileSync(n, "utf8"));
    } catch {
      fail(`malformed trace ${path.relative(root, n)}`);
      continue;
    }
    if (!j || !Array.isArray(j.files)) {
      fail(`trace ${path.relative(root, n)} has no files[]`);
      continue;
    }
    for (const f of j.files) {
      summary.nftEntries++;
      const abs = path.resolve(path.dirname(n), f);
      if (isForbidden(abs, set)) fail(`FORBIDDEN traced file ${path.relative(root, abs)} in ${path.relative(root, n)}`);
    }
  }

  // 4. Emitted JavaScript: no tool-unique literal.
  const toolSources = FORBIDDEN_FILES.map((f) => fs.readFileSync(path.join(root, f), "utf8")).join("\n");
  const deployedLike = sourceFilesOutside(root, (r) => FORBIDDEN_FILES.includes(r) || r.startsWith("scripts/") || /(^|\/)__tests__\//.test(r) || /\.(spec|test)\.[cm]?[jt]sx?$/.test(r) || r.startsWith("docs/"));
  const literals = [];
  for (const lit of TOOL_LITERALS) {
    if (!toolSources.includes(lit)) {
      fail(`tool literal ${JSON.stringify(lit)} no longer appears in the tool source: update TOOL_LITERALS`);
      continue;
    }
    const elsewhere = deployedLike.filter((r) => fs.readFileSync(path.join(root, r), "utf8").includes(lit));
    if (elsewhere.length) {
      fail(`tool literal ${JSON.stringify(lit)} is not unique (also in ${elsewhere.join(", ")}): the chunk scan would be ambiguous`);
      continue;
    }
    literals.push(lit);
  }
  if (literals.length === 0) fail("no usable tool literals: chunk scan cannot run");
  const chunks = walk(dist, (p) => /\.(?:m?js|cjs)$/.test(p) && !p.includes(`${path.sep}cache${path.sep}`));
  summary.chunksScanned = chunks.length;
  if (chunks.length === 0) fail("no emitted JavaScript found to scan");
  for (const ch of chunks) {
    const s = fs.readFileSync(ch, "utf8");
    for (const lit of literals) if (s.includes(lit)) fail(`FORBIDDEN tool literal ${JSON.stringify(lit)} emitted in ${path.relative(root, ch)}`);
  }

  return { ok: failures.length === 0, failures, summary };
}

if (require.main === module) {
  const i = process.argv.indexOf("--dist");
  const dist = i > 0 ? process.argv[i + 1] : ".next";
  const r = checkBuildBoundary({ dist, nonce: process.env.CP_BUILD_BOUNDARY_NONCE || null });
  console.log(JSON.stringify(r.summary));
  if (!r.ok) {
    for (const f of r.failures) console.error(`CP_BUILD_BOUNDARY_CHECK_FAILED: ${f}`);
    process.exit(1);
  }
  console.log("CP_BUILD_BOUNDARY_CHECK_PASSED");
}

module.exports = { checkBuildBoundary, classifyResourceless, TOOL_LITERALS, REQUIRED_COMPILERS, POSITIVE_CONTROLS, KNOWN_RESOURCELESS };
