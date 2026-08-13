/**
 * Resolves the `@/*` -> project-root path alias for scripts run via
 * `ts-node` outside Next.js's own bundler (which handles this alias via
 * webpack/tsconfig `paths` natively). `tsconfig-paths/register` cannot be
 * used here because it requires `compilerOptions.baseUrl` to be present in
 * the on-disk tsconfig.json, which this repository's tsconfig.json
 * deliberately does not set (Next.js resolves `@/*` without needing one).
 * Editing tsconfig.json to add one is out of scope and risks affecting the
 * Next.js build itself — this preload script achieves the same resolution
 * for CLI scripts only, without touching it.
 *
 * `server-only`-guarded modules (e.g. lib/firebase/admin.ts,
 * lib/workspaces/*.ts) are handled separately via Node's own official
 * `"react-server"` export condition (`server-only`'s package.json maps
 * that condition to a no-op `empty.js`) — invoke with
 * `node --conditions=react-server`, not a custom patch. See this
 * directory's `package.json` script for the full invocation.
 */
const path = require("path");
const Module = require("module");
const originalResolve = Module._resolveFilename;
const projectRoot = path.resolve(__dirname, "..", "..");

Module._resolveFilename = function (request, ...args) {
  if (request.startsWith("@/")) {
    const resolved = path.join(projectRoot, request.slice(2));
    return originalResolve.call(this, resolved, ...args);
  }
  return originalResolve.call(this, request, ...args);
};
