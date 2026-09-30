#!/usr/bin/env node
/**
 * R-16 — materialize the pdf.js worker as a same-origin static asset.
 *
 * The browser used to load the worker from cdn.jsdelivr.net. The CSP never
 * allowed that module under `script-src-elem`, so both the real worker and
 * pdf.js's fake-worker fallback were blocked and PDF extraction failed in
 * Production. The fix is to serve the worker from our own origin, copied from
 * the exact pdfjs-dist package that `npm ci` installed from the lockfile.
 *
 *   node scripts/pdfjs-worker/materialize.js           # copy + verify (build/dev)
 *   node scripts/pdfjs-worker/materialize.js --verify  # verify only, no writes
 *
 * Served at /vendor/pdfjs/<version>/pdf.worker.min.mjs. The version is in the
 * path so a pdfjs-dist bump can never be answered by a cached older worker,
 * and so the client (which builds the URL from the bundled `pdfjsLib.version`)
 * gets a 404 rather than a mismatched worker if the two ever diverge.
 *
 * Nothing here touches the network. Every check fails closed: the process
 * exits non-zero, which fails `npm run build` and therefore the deployment.
 */
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

/** URL prefix the client uses; `lib/client/extractFileText.ts` must agree. */
const PUBLIC_URL_BASE = "/vendor/pdfjs";
const WORKER_FILE = "pdf.worker.min.mjs";
const PACKAGE = "pdfjs-dist";

function sha256(bytes) {
  return crypto.createHash("sha256").update(bytes).digest("hex");
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function fail(message) {
  const err = new Error(`[pdfjs-worker] ${message}`);
  err.pdfjsWorker = true;
  throw err;
}

/** Output directory that owns every materialized worker (wiped on each run). */
function vendorDir(projectRoot) {
  return path.join(projectRoot, "public", ...PUBLIC_URL_BASE.split("/").filter(Boolean));
}

function servedWorkerPath(projectRoot, version) {
  return path.join(vendorDir(projectRoot), version, WORKER_FILE);
}

function servedWorkerUrl(version) {
  return `${PUBLIC_URL_BASE}/${version}/${WORKER_FILE}`;
}

/**
 * Establish what the lockfile says, what is installed, and the source bytes.
 * Three independent sources must agree on the version: the lockfile entry, the
 * installed package.json, and the version string compiled into the worker
 * itself (pdf.js's own API/worker handshake compares against that constant).
 */
function resolveSource(projectRoot) {
  const lockFile = path.join(projectRoot, "package-lock.json");
  if (!fs.existsSync(lockFile)) fail(`package-lock.json not found at ${lockFile}`);
  const lockEntry = readJson(lockFile).packages?.[`node_modules/${PACKAGE}`];
  const lockedVersion = lockEntry?.version;
  if (typeof lockedVersion !== "string" || !lockedVersion) {
    fail(`package-lock.json has no node_modules/${PACKAGE} version`);
  }

  const pkgDir = path.join(projectRoot, "node_modules", PACKAGE);
  const pkgJson = path.join(pkgDir, "package.json");
  if (!fs.existsSync(pkgJson)) fail(`${PACKAGE} is not installed (${pkgJson} missing)`);
  const installedVersion = readJson(pkgJson).version;
  if (installedVersion !== lockedVersion) {
    fail(
      `installed ${PACKAGE} ${installedVersion} does not match the lockfile ${lockedVersion}; run npm ci`
    );
  }
  if (!/^\d+\.\d+\.\d+$/.test(installedVersion)) {
    fail(`unexpected ${PACKAGE} version format ${JSON.stringify(installedVersion)}`);
  }

  const sourcePath = path.join(pkgDir, "build", WORKER_FILE);
  let stat;
  try {
    stat = fs.lstatSync(sourcePath);
  } catch {
    fail(`worker source missing: ${sourcePath}`);
  }
  if (!stat.isFile()) fail(`worker source is not a regular file: ${sourcePath}`);

  const bytes = fs.readFileSync(sourcePath);
  if (bytes.length === 0) fail(`worker source is empty: ${sourcePath}`);
  if (!bytes.includes(Buffer.from(`"${installedVersion}"`))) {
    fail(`worker source does not embed version "${installedVersion}" — package contents do not match its version`);
  }

  return { version: installedVersion, sourcePath, sha256: sha256(bytes) };
}

/**
 * Prove the served artifact is byte-identical to the installed source and that
 * it is the ONLY worker served. Recomputes everything; trusts no prior output.
 */
function verify(projectRoot) {
  const source = resolveSource(projectRoot);
  const served = servedWorkerPath(projectRoot, source.version);
  if (!fs.existsSync(served)) fail(`served worker missing: ${served}`);
  const servedSha = sha256(fs.readFileSync(served));
  if (servedSha !== source.sha256) {
    fail(`served worker sha256 ${servedSha} != installed source ${source.sha256}`);
  }

  const dir = vendorDir(projectRoot);
  const entries = fs.readdirSync(dir);
  if (entries.length !== 1 || entries[0] !== source.version) {
    fail(`stale entries in ${dir}: expected only [${source.version}], found [${entries.join(", ")}]`);
  }
  const versionEntries = fs.readdirSync(path.join(dir, source.version));
  if (versionEntries.length !== 1 || versionEntries[0] !== WORKER_FILE) {
    fail(`unexpected files next to the worker: [${versionEntries.join(", ")}]`);
  }

  return { ...source, servedPath: served, url: servedWorkerUrl(source.version) };
}

/** Wipe the vendor dir, copy exactly one file, then verify from scratch. */
function materialize(projectRoot) {
  const source = resolveSource(projectRoot);
  const dir = vendorDir(projectRoot);
  fs.rmSync(dir, { recursive: true, force: true });
  const served = servedWorkerPath(projectRoot, source.version);
  fs.mkdirSync(path.dirname(served), { recursive: true });
  fs.copyFileSync(source.sourcePath, served);
  return verify(projectRoot);
}

module.exports = {
  PUBLIC_URL_BASE,
  WORKER_FILE,
  resolveSource,
  verify,
  materialize,
  servedWorkerPath,
  servedWorkerUrl,
  vendorDir,
};

if (require.main === module) {
  const projectRoot = path.resolve(__dirname, "..", "..");
  const verifyOnly = process.argv.includes("--verify");
  try {
    const r = verifyOnly ? verify(projectRoot) : materialize(projectRoot);
    process.stdout.write(
      `[pdfjs-worker] ${verifyOnly ? "verified" : "materialized"} ${PACKAGE}@${r.version} -> ${r.url} sha256=${r.sha256}\n`
    );
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
