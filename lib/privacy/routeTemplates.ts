/**
 * Structural telemetry hardening (private advisory GHSA-655j-5f43-92pw follow-up): the PATH half of the shared
 * telemetry URL sanitizer (lib/privacy/sanitizeUrl.ts handles origin, query and fragment).
 *
 * Contract: a path that leaves the app in telemetry is either
 *   1. the TEMPLATE of a route this deployment actually serves (lib/privacy/telemetryRouteManifest.generated.ts,
 *      generated from app/ and public/): static segments must match exactly; a dynamic segment's value is never
 *      emitted, only its `[name]`. The single exception is an enumerated SEO slug (exact membership in the slug
 *      allowlist, the same data those pages render; any other value is a 404);
 *   2. a build-artifact path (`/_next/static/...`, or a code file location in a stack frame), kept byte-for-byte
 *      only when every segment is in a narrow file-name alphabet and nothing in it is shaped like a credential;
 *   3. otherwise the fixed placeholder {@link UNMATCHED_PATH}. Nothing from an unmatched path is kept.
 *
 * Deterministic, dependency-free, never throws, never logs. Output is a fixed point (templating a template returns
 * it unchanged), so the sanitizer can run at several boundaries.
 */
import { TELEMETRY_ROUTE_PATTERNS, TELEMETRY_SLUG_ALLOWLIST } from "./telemetryRouteManifest.generated";

export const UNMATCHED_PATH = "/[unmatched]";
export const EXTERNAL_PATH = "/[external-path]";

const MAX_PATH_LENGTH = 2048;
const MAX_SEGMENTS = 32;

type Node = {
  statics: Map<string, Node>;
  dynamic?: { name: string; node: Node };
  catchAll?: { name: string; pattern: string };
  optionalCatchAll?: { name: string; pattern: string };
  pattern?: string;
};

const newNode = (): Node => ({ statics: new Map() });

function buildTrie(patterns: readonly string[]): Node {
  const root = newNode();
  for (const pattern of patterns) {
    const segments = pattern === "/" ? [] : pattern.slice(1).split("/");
    let node = root;
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const optCatch = /^\[\[\.\.\.([A-Za-z0-9_]+)\]\]$/.exec(seg);
      const catchAll = /^\[\.\.\.([A-Za-z0-9_]+)\]$/.exec(seg);
      const dynamic = /^\[([A-Za-z0-9_]+)\]$/.exec(seg);
      if (optCatch) {
        node.optionalCatchAll = { name: optCatch[1], pattern };
        node = newNode(); // nothing may follow a catch-all
        break;
      } else if (catchAll) {
        node.catchAll = { name: catchAll[1], pattern };
        node = newNode();
        break;
      } else if (dynamic) {
        if (!node.dynamic) node.dynamic = { name: dynamic[1], node: newNode() };
        node = node.dynamic.node;
      } else {
        let next = node.statics.get(seg);
        if (!next) node.statics.set(seg, (next = newNode()));
        node = next;
      }
      if (i === segments.length - 1) node.pattern = pattern;
    }
    if (segments.length === 0) root.pattern = "/";
  }
  return root;
}

const TRIE = buildTrie(TELEMETRY_ROUTE_PATTERNS);
const SLUGS: ReadonlyMap<string, ReadonlySet<string>> = new Map(
  Object.entries(TELEMETRY_SLUG_ALLOWLIST).map(([route, slugs]) => [route, new Set(slugs)])
);
const SLUG_SHAPE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Next.js precedence: static before dynamic before catch-all; first full match wins (depth-first). */
function match(node: Node, segments: string[], i: number, out: string[], prefixPattern: string[]): string[] | null {
  if (i === segments.length) {
    if (node.pattern !== undefined) return out;
    if (node.optionalCatchAll) return out.concat(`[[...${node.optionalCatchAll.name}]]`);
    return null;
  }
  const seg = segments[i];
  const exact = node.statics.get(seg);
  if (exact) {
    const r = match(exact, segments, i + 1, out.concat(seg), prefixPattern.concat(seg));
    if (r) return r;
  }
  if (node.dynamic) {
    const placeholder = `[${node.dynamic.name}]`;
    const r = match(node.dynamic.node, segments, i + 1, out.concat(placeholder), prefixPattern.concat(placeholder));
    if (r) {
      // Only an exact, enumerated SEO slug keeps its value (a public page name); everything else stays a placeholder.
      const routePattern = "/" + prefixPattern.concat(placeholder).join("/");
      const allowed = SLUGS.get(routePattern);
      if (allowed && i === segments.length - 1 && SLUG_SHAPE.test(seg) && allowed.has(seg)) r[i] = seg;
      return r;
    }
  }
  if (node.catchAll) return out.concat(`[...${node.catchAll.name}]`);
  if (node.optionalCatchAll) return out.concat(`[[...${node.optionalCatchAll.name}]]`);
  return null;
}

// A credential-shaped run: 32+ base64url characters containing both letter cases (invitation tokens are 43).
// Build artifacts use lowercase hex hashes and short ids, so this only fails closed on token-like file names.
const CREDENTIAL_RUN = /[A-Za-z0-9_-]{32,}/g;
function hasCredentialShapedRun(s: string): boolean {
  for (const m of s.match(CREDENTIAL_RUN) ?? []) if (/[a-z]/.test(m) && /[A-Z]/.test(m)) return true;
  return false;
}

const SAFE_FILE_SEGMENT = /^[A-Za-z0-9._~@()[\]+-]{1,200}$/;
const ALLOWED_ESCAPES = /%(5B|5D|28|29|40)/gi; // `[`, `]`, `(`, `)`, `@` (Next.js chunk names for dynamic routes)
const STATIC_ASSET = /\.(?:m?js|cjs|css|map|json|txt|woff2?|ttf|otf|png|jpe?g|gif|svg|webp|avif|ico|wasm)$/i;
const CODE_FILE = /\.(?:m?js|cjs|jsx?|tsx?|map)$/i;
const LINE_COL = /(?::\d{1,7}){1,2}$/;

/** Every segment is a plain file name (after the few escapes Next.js uses) and nothing is credential-shaped. */
function isSafeFilePath(path: string, fileName: RegExp): boolean {
  if (path.length > 512 || !path.startsWith("/")) return false;
  const segments = path.slice(1).split("/");
  if (segments.length > 24) return false;
  for (const seg of segments) {
    const unescaped = seg.replace(ALLOWED_ESCAPES, "_");
    if (!SAFE_FILE_SEGMENT.test(unescaped) || unescaped === "." || unescaped === "..") return false;
  }
  if (hasCredentialShapedRun(path)) return false;
  return fileName.test(segments[segments.length - 1]);
}

function splitLineCol(path: string): [string, string] {
  const m = LINE_COL.exec(path);
  return m ? [path.slice(0, m.index), m[0]] : [path, ""];
}

/** `/_next/static/...` build assets (served by this deployment; file names are build output, not user data). */
export function isSafeStaticAssetPath(path: string): boolean {
  const [file] = splitLineCol(path);
  return file.startsWith("/_next/static/") && isSafeFilePath(file, STATIC_ASSET);
}

/** A code file location as it appears in a stack frame (`/var/task/.next/server/...js:12:3`, `/_next/static/...js`). */
export function isSafeCodeFilePath(path: string): boolean {
  const [file] = splitLineCol(path);
  return isSafeFilePath(file, CODE_FILE) || isSafeStaticAssetPath(path);
}

/** The route template for a known route, or null. `path` is the raw path (no query, no fragment). */
export function matchRouteTemplate(path: string): string | null {
  if (typeof path !== "string" || !path.startsWith("/") || path.length > MAX_PATH_LENGTH) return null;
  let p = path;
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1); // Next.js redirects `/x/` to `/x`
  if (p === "/") return TRIE.pattern !== undefined ? "/" : null;
  const segments = p.slice(1).split("/");
  if (segments.length > MAX_SEGMENTS || segments.some((s) => s === "")) return null;
  const out = match(TRIE, segments, 0, [], []);
  return out ? "/" + out.join("/") : null;
}

/**
 * Templates one first-party path. Known route -> its template; safe `/_next/static/` asset -> kept; with
 * `codeLocation` (a stack-frame file name or debug image, never a page URL) a safe code-file path is kept too;
 * anything else -> {@link UNMATCHED_PATH}. Never returns any part of an unmatched input.
 */
export function templatePath(path: string, options: { codeLocation?: boolean } = {}): string {
  const route = matchRouteTemplate(path);
  if (route !== null) return route;
  if (typeof path === "string") {
    if (isSafeStaticAssetPath(path)) return path;
    if (options.codeLocation && isSafeCodeFilePath(path)) return path;
  }
  return UNMATCHED_PATH;
}
