/**
 * BUILD BOUNDARY (PR #295, owner-authorized architectural correction).
 *
 * The SYSTEM_ADMIN claim tool is OFFLINE OPERATOR CODE. S2-b's authority pins
 * exempt its `admin`-claim reads only because no deployed module can load it.
 * This module enforces that inside the REAL Next.js/webpack build:
 *
 *   Layer A — enforcement. A webpack plugin installed into every Next
 *   compiler (server, edge-server, client) and, through webpack's copying of
 *   these hooks, every child compilation (workers, etc.). It checks the
 *   resource webpack's OWN resolver produced — after aliases (incl. Next's
 *   private-next-* aliases), package.json main/exports fields, tsconfig
 *   baseUrl/paths/extends, symlinks, require.context / import.meta
 *   .webpackContext, `new Worker(new URL(...))` entries — canonicalised with
 *   realpath. A forbidden module fails the build.
 *
 *   Layer B evidence — the plugin writes one manifest per compilation listing
 *   every module it holds, stamped with CP_BUILD_BOUNDARY_NONCE, so the
 *   independent checker (scripts/security/check-build-boundary.js) can prove
 *   the evidence is complete and from THIS build.
 *
 * No runtime code imports this file; it runs only inside the build. It never
 * imports the claim tool: it names files by path.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const PLUGIN = "CpBuildBoundaryPlugin";
const VIOLATION = "CP_BUILD_BOUNDARY_VIOLATION";

/** Forbidden operator-tool files and directories, repo-relative. Exactly what S2-b's operator exemptions rely on. */
const FORBIDDEN_FILES = Object.freeze([
  "lib/admin/systemAdminClaimSafety.ts",
  "lib/admin/systemAdminClaimExecution.ts",
]);
const FORBIDDEN_DIRS = Object.freeze(["scripts/admin"]);

/** realpath; for a path that does not exist, the realpath of its nearest existing ancestor + the rest (never a non-canonical fallback). */
const real = (p) => {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync.native(abs);
  } catch {
    const parent = path.dirname(abs);
    if (parent === abs) return abs;
    return path.join(real(parent), path.basename(abs));
  }
};

/** Canonical forbidden set for a repository root (realpath; case-folded on case-insensitive volumes). */
function forbiddenSet(rawRoot) {
  const root = real(rawRoot);
  const fold = caseInsensitive(root) ? (s) => s.toLowerCase() : (s) => s;
  return {
    fold,
    files: new Set(FORBIDDEN_FILES.map((f) => fold(real(path.join(root, f))))),
    dirs: FORBIDDEN_DIRS.map((d) => fold(real(path.join(root, d))) + path.sep),
  };
}

function caseInsensitive(root) {
  try {
    const probe = path.join(root, "package.json");
    const swapped = path.join(root, "PACKAGE.JSON");
    return fs.existsSync(probe) && fs.existsSync(swapped) && fs.statSync(probe).ino === fs.statSync(swapped).ino;
  } catch {
    return false;
  }
}

/** True when `resource` (a resolved path, query/fragment allowed) is a forbidden operator module. */
function isForbidden(resource, set) {
  if (typeof resource !== "string" || resource === "") return false;
  const bare = resource.replace(/[?#].*$/, "");
  if (!path.isAbsolute(bare)) return false;
  const c = set.fold(real(bare));
  return set.files.has(c) || set.dirs.some((d) => c.startsWith(d));
}

class CpBuildBoundaryPlugin {
  /** @param {{ root: string, compilerName: string, distDir: string, nonce: string|null, writeManifests: boolean }} opts */
  constructor(opts) {
    this.root = real(opts.root); // canonical: a symlinked root (e.g. /var -> /private/var) must not skew relative paths
    this.compilerName = opts.compilerName;
    this.distDir = opts.distDir;
    this.nonce = opts.nonce || null;
    this.writeManifests = opts.writeManifests;
    this.set = forbiddenSet(opts.root);
    this.seq = 0;
  }

  rel(p) {
    return path.relative(this.root, real(p.replace(/[?#].*$/, ""))).split(path.sep).join("/");
  }

  violation(resource, via) {
    return new Error(`${VIOLATION}: the ${this.compilerName} compilation resolved forbidden operator module ${this.rel(resource)} (request ${JSON.stringify(via || "")}). The SYSTEM_ADMIN claim tool must never be reachable from deployed code (lib/security/buildBoundary.js).`);
  }

  apply(compiler) {
    // Layer A: the resolver's own answer, before the module is built.
    compiler.hooks.normalModuleFactory.tap(PLUGIN, (nmf) => {
      nmf.hooks.afterResolve.tap(PLUGIN, (resolveData) => {
        const cd = resolveData && resolveData.createData ? resolveData.createData : {};
        if (isForbidden(cd.resource, this.set)) throw this.violation(cd.resource, resolveData.request);
        return undefined;
      });
    });
    compiler.hooks.contextModuleFactory.tap(PLUGIN, (cmf) => {
      cmf.hooks.afterResolve.tap(PLUGIN, (data) => {
        // A context over a forbidden DIRECTORY (require.context / import.meta.webpackContext).
        if (data && typeof data.resource === "string") {
          const dir = this.set.fold(real(data.resource)) + path.sep;
          if (this.set.dirs.some((d) => dir.startsWith(d))) throw this.violation(data.resource, data.request);
        }
        return undefined;
      });
    });

    // Second check + Layer B evidence: every module the compilation (or child compilation) holds.
    compiler.hooks.compilation.tap(PLUGIN, (compilation) => {
      compilation.hooks.finishModules.tap(PLUGIN, (modules) => {
        const resources = [];
        const externals = [];
        const other = [];
        for (const m of modules) {
          const type = m && m.constructor ? m.constructor.name : typeof m;
          if (typeof m.resource === "string" && m.resource) {
            if (isForbidden(m.resource, this.set)) compilation.errors.push(this.violation(m.resource, m.rawRequest || m.userRequest));
            resources.push(path.isAbsolute(m.resource.replace(/[?#].*$/, "")) ? this.rel(m.resource) : m.resource);
          } else if (type === "ExternalModule") {
            externals.push({ request: typeof m.request === "string" ? m.request : JSON.stringify(m.request), externalType: m.externalType || null });
          } else {
            const loaders = Array.isArray(m.loaders)
              ? m.loaders.map((l) => {
                  const lp = typeof l === "string" ? l : l && l.loader;
                  const mm = /[\\/]next[\\/]dist[\\/]build[\\/]webpack[\\/]loaders[\\/]([\w-]+)/.exec(String(lp || ""));
                  return mm ? `next:${mm[1]}` : `other:${String(lp || "").slice(-120)}`;
                })
              : [];
            const context = type === "ContextModule" && typeof m.context === "string" ? m.context : null;
            if (context) {
              const dir = this.set.fold(real(context)) + path.sep;
              if (this.set.dirs.some((d) => dir.startsWith(d))) compilation.errors.push(this.violation(context, m.identifier && m.identifier()));
            }
            other.push({
              type,
              moduleType: typeof m.type === "string" ? m.type : null,
              loaders,
              context: context ? this.rel(context) : null,
              id: typeof m.identifier === "function" ? String(m.identifier()).slice(0, 200) : null,
            });
          }
        }
        if (!this.writeManifests) return;
        const dir = path.join(this.distDir, "cp-build-boundary");
        fs.mkdirSync(dir, { recursive: true });
        const parent = compilation.compiler && compilation.compiler.parentCompilation;
        const file = path.join(dir, `${this.compilerName}.${process.pid}.${++this.seq}.json`);
        fs.writeFileSync(file, JSON.stringify({
          version: 1,
          nonce: this.nonce,
          compiler: this.compilerName,
          compilationName: compilation.name || null,
          child: Boolean(parent),
          moduleCount: modules.size !== undefined ? modules.size : resources.length + externals.length + other.length,
          resources: [...new Set(resources)].sort(),
          externals,
          other,
        }));
      });
    });
  }
}

/** next.config.js `webpack` hook: install the plugin on every Next compiler. */
function withBuildBoundary(config, ctx) {
  const root = ctx.dir;
  const distDir = path.join(root, (ctx.config && ctx.config.distDir) || ".next");
  const compilerName = ctx.nextRuntime === "edge" ? "edge-server" : ctx.isServer ? "server" : "client";
  config.plugins = config.plugins || [];
  config.plugins.push(new CpBuildBoundaryPlugin({
    root,
    compilerName,
    distDir,
    nonce: process.env.CP_BUILD_BOUNDARY_NONCE || null,
    writeManifests: !ctx.dev,
  }));
  return config;
}

module.exports = { CpBuildBoundaryPlugin, withBuildBoundary, isForbidden, forbiddenSet, FORBIDDEN_FILES, FORBIDDEN_DIRS, VIOLATION };
