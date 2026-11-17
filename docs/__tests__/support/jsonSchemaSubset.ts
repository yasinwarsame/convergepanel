/**
 * Purpose-built validator for EXACTLY the JSON Schema (2020-12) subset that the API-0 request
 * schemas use (Addendum 3, m6). It replaces the transitive Ajv 8 import that the request-contract
 * spec used to load from `ajv-formats/node_modules/ajv`; no package or lockfile change.
 *
 * Why not a declared validator: `zod` (declared, 4.x) `fromJSONSchema` counts `maxLength` in
 * UTF-16 units, ignores `maxProperties`, `propertyNames` and `uniqueItems`, and throws on `not`
 * (probe recorded in owner-decision-addendum-3.md §3, m6). It cannot validate these schemas.
 *
 * Fail-closed design: `compile` walks the whole schema first and THROWS on any keyword outside
 * the supported set, so a future schema keyword can never be silently ignored.
 *
 * Semantics follow JSON Schema 2020-12 as Ajv 8 implements it with `unicodeRegExp: true`:
 *   - `minLength` / `maxLength` count Unicode code points (not UTF-16 units);
 *   - `pattern` is an unanchored ECMAScript regular expression compiled with the `u` flag;
 *   - `discriminator` (OpenAPI) selects the `oneOf` branch whose `properties[tag].const` equals
 *     the tag; a missing or non-string tag, or a tag with no branch, is invalid;
 *   - `const`, `enum` and `uniqueItems` use JSON deep equality.
 * One vendor keyword is supported: `x-cp-max-total-code-points` on an object, bounding the sum of
 * the code points of every member name and every string member value (error-catalog.md §4.3).
 */

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type Schema = { [k: string]: unknown } | boolean;

export interface ValidationError {
  path: string;
  keyword: string;
}

const ANNOTATIONS = new Set([
  "description", "title", "summary", "default", "examples", "example", "$comment",
  "deprecated", "readOnly", "writeOnly",
]);
const SUPPORTED = new Set([
  "type", "const", "enum", "allOf", "oneOf", "anyOf", "not", "discriminator",
  "properties", "required", "additionalProperties", "propertyNames", "maxProperties", "minProperties",
  "minLength", "maxLength", "pattern", "items", "minItems", "maxItems", "uniqueItems",
  "minimum", "maximum", "x-cp-max-total-code-points",
]);
const JSON_TYPES = new Set(["null", "boolean", "object", "array", "number", "integer", "string"]);

function isObj(v: unknown): v is { [k: string]: unknown } {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function codePoints(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => jsonEqual(v, b[i]));
  }
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a).sort();
    const kb = Object.keys(b).sort();
    return jsonEqual(ka, kb) && ka.every((k) => jsonEqual(a[k], b[k]));
  }
  return false;
}

function jsonType(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  if (typeof v === "number") return Number.isInteger(v) ? "integer" : "number";
  return typeof v;
}

function typeMatches(v: unknown, t: string): boolean {
  const actual = jsonType(v);
  if (t === "number") return actual === "number" || actual === "integer";
  return actual === t;
}

/**
 * Returns the node at JSON Pointer `pointer` (default the root) with every internal `#/…` `$ref`
 * reachable from it resolved against `root`, recursively. Throws on a cycle, a miss, an external
 * reference, or a `$ref` with sibling keywords (none occur in the request schemas).
 */
export function dereference(root: unknown, pointer = "#"): unknown {
  const resolve = (ref: string): unknown => {
    if (!ref.startsWith("#/")) throw new Error(`external $ref not supported: ${ref}`);
    let node: unknown = root;
    for (const raw of ref.slice(2).split("/")) {
      const part = raw.replace(/~1/g, "/").replace(/~0/g, "~");
      if (!isObj(node) && !Array.isArray(node)) throw new Error(`unresolvable $ref: ${ref}`);
      node = (node as { [k: string]: unknown })[part];
      if (node === undefined) throw new Error(`unresolvable $ref: ${ref}`);
    }
    return node;
  };
  const walk = (node: unknown, stack: string[]): unknown => {
    if (Array.isArray(node)) return node.map((n) => walk(n, stack));
    if (!isObj(node)) return node;
    if (typeof node.$ref === "string") {
      const ref = node.$ref;
      if (stack.includes(ref)) throw new Error(`cyclic $ref: ${[...stack, ref].join(" -> ")}`);
      const siblings = Object.keys(node).filter((k) => k !== "$ref");
      if (siblings.length > 0) throw new Error(`$ref with siblings not supported: ${ref}`);
      return walk(resolve(ref), [...stack, ref]);
    }
    const out: { [k: string]: unknown } = {};
    for (const [k, v] of Object.entries(node)) out[k] = walk(v, stack);
    return out;
  };
  return walk(pointer === "#" ? root : resolve(pointer), []);
}

function checkSchema(s: unknown, at: string): void {
  if (typeof s === "boolean") return;
  if (!isObj(s)) throw new Error(`schema at ${at} is not an object or boolean`);
  for (const [k, v] of Object.entries(s)) {
    if (ANNOTATIONS.has(k)) continue;
    if (k.startsWith("x-") && k !== "x-cp-max-total-code-points") continue;
    if (!SUPPORTED.has(k)) throw new Error(`unsupported keyword "${k}" at ${at}`);
    const here = `${at}/${k}`;
    switch (k) {
      case "type": {
        const ts = Array.isArray(v) ? v : [v];
        for (const t of ts) if (typeof t !== "string" || !JSON_TYPES.has(t)) throw new Error(`bad type at ${here}`);
        break;
      }
      case "allOf": case "oneOf": case "anyOf":
        if (!Array.isArray(v) || v.length === 0) throw new Error(`bad ${k} at ${here}`);
        v.forEach((sub, i) => checkSchema(sub, `${here}/${i}`));
        break;
      case "not": case "additionalProperties": case "propertyNames": case "items":
        checkSchema(v, here);
        break;
      case "properties":
        if (!isObj(v)) throw new Error(`bad properties at ${here}`);
        for (const [p, sub] of Object.entries(v)) checkSchema(sub, `${here}/${p}`);
        break;
      case "required": case "enum":
        if (!Array.isArray(v)) throw new Error(`bad ${k} at ${here}`);
        break;
      case "pattern":
        if (typeof v !== "string") throw new Error(`bad pattern at ${here}`);
        new RegExp(v, "u"); // throws on an invalid Unicode-mode pattern
        break;
      case "discriminator":
        if (!isObj(v) || typeof v.propertyName !== "string") throw new Error(`bad discriminator at ${here}`);
        if (!Array.isArray(s.oneOf)) throw new Error(`discriminator without oneOf at ${here}`);
        for (const [i, b] of (s.oneOf as unknown[]).entries()) {
          const props = isObj(b) && isObj(b.properties) ? b.properties : undefined;
          const tag = props && isObj(props[v.propertyName]) ? (props[v.propertyName] as { [k: string]: unknown }).const : undefined;
          if (typeof tag !== "string") throw new Error(`discriminator branch ${i} has no string const tag at ${here}`);
        }
        break;
      case "const":
        break;
      default:
        if (typeof v !== "number" && typeof v !== "boolean") throw new Error(`bad ${k} at ${here}`);
    }
  }
}

function validateNode(s: Schema, v: unknown, path: string, errors: ValidationError[]): void {
  if (s === true) return;
  if (s === false) {
    errors.push({ path, keyword: "false" });
    return;
  }
  const fail = (keyword: string, p = path): void => {
    errors.push({ path: p, keyword });
  };
  const sub = (schema: unknown, value: unknown, p: string): ValidationError[] => {
    const e: ValidationError[] = [];
    validateNode(schema as Schema, value, p, e);
    return e;
  };

  if (s.type !== undefined) {
    const ts = (Array.isArray(s.type) ? s.type : [s.type]) as string[];
    if (!ts.some((t) => typeMatches(v, t))) {
      fail("type");
      return; // as Ajv: a type mismatch makes the type-specific keywords meaningless
    }
  }
  if ("const" in s && !jsonEqual(v, s.const)) fail("const");
  if (Array.isArray(s.enum) && !s.enum.some((e) => jsonEqual(v, e))) fail("enum");

  if (Array.isArray(s.allOf)) for (const a of s.allOf) errors.push(...sub(a, v, path));
  if (Array.isArray(s.anyOf) && !s.anyOf.some((a) => sub(a, v, path).length === 0)) fail("anyOf");
  if (s.not !== undefined && sub(s.not, v, path).length === 0) fail("not");

  const disc = isObj(s.discriminator) ? (s.discriminator.propertyName as string) : undefined;
  if (Array.isArray(s.oneOf)) {
    if (disc !== undefined && isObj(v)) {
      const tag = v[disc];
      if (tag === undefined) fail("discriminator", `${path}/${disc}`);
      else if (typeof tag !== "string") fail("discriminator", `${path}/${disc}`);
      else {
        const branch = s.oneOf.find((b) => {
          const props = isObj(b) && isObj(b.properties) ? b.properties : {};
          return isObj(props[disc]) && (props[disc] as { [k: string]: unknown }).const === tag;
        });
        if (branch === undefined) fail("discriminator", `${path}/${disc}`);
        else errors.push(...sub(branch, v, path));
      }
    } else {
      const passing = s.oneOf.filter((b) => sub(b, v, path).length === 0).length;
      if (passing !== 1) fail("oneOf");
    }
  }

  if (typeof v === "string") {
    const n = codePoints(v);
    if (typeof s.minLength === "number" && n < s.minLength) fail("minLength");
    if (typeof s.maxLength === "number" && n > s.maxLength) fail("maxLength");
    if (typeof s.pattern === "string" && !new RegExp(s.pattern, "u").test(v)) fail("pattern");
  }
  if (typeof v === "number") {
    if (typeof s.minimum === "number" && v < s.minimum) fail("minimum");
    if (typeof s.maximum === "number" && v > s.maximum) fail("maximum");
  }
  if (Array.isArray(v)) {
    if (typeof s.minItems === "number" && v.length < s.minItems) fail("minItems");
    if (typeof s.maxItems === "number" && v.length > s.maxItems) fail("maxItems");
    if (s.uniqueItems === true) {
      for (let i = 0; i < v.length; i++) {
        for (let j = i + 1; j < v.length; j++) if (jsonEqual(v[i], v[j])) fail("uniqueItems", `${path}/${j}`);
      }
    }
    if (s.items !== undefined) v.forEach((item, i) => errors.push(...sub(s.items, item, `${path}/${i}`)));
  }
  if (isObj(v)) {
    const keys = Object.keys(v);
    if (typeof s.maxProperties === "number" && keys.length > s.maxProperties) fail("maxProperties");
    if (typeof s.minProperties === "number" && keys.length < s.minProperties) fail("minProperties");
    if (Array.isArray(s.required)) {
      for (const r of s.required as string[]) if (!Object.prototype.hasOwnProperty.call(v, r)) fail("required", `${path}/${r}`);
    }
    const props = isObj(s.properties) ? s.properties : {};
    for (const k of keys) {
      if (s.propertyNames !== undefined) errors.push(...sub(s.propertyNames, k, `${path}/${k}`).map((e) => ({ ...e, keyword: `propertyNames.${e.keyword}` })));
      if (Object.prototype.hasOwnProperty.call(props, k)) errors.push(...sub(props[k], v[k], `${path}/${k}`));
      else if (s.additionalProperties !== undefined) {
        if (s.additionalProperties === false) fail("additionalProperties", `${path}/${k}`);
        else errors.push(...sub(s.additionalProperties, v[k], `${path}/${k}`));
      }
    }
    const total = s["x-cp-max-total-code-points"];
    if (typeof total === "number") {
      let sum = 0;
      for (const k of keys) {
        sum += codePoints(k);
        const val = v[k];
        if (typeof val === "string") sum += codePoints(val);
      }
      if (sum > total) fail("x-cp-max-total-code-points");
    }
  }
}

export interface CompiledValidator {
  (value: unknown): boolean;
  errors: (value: unknown) => ValidationError[];
}

/** Compiles a dereferenced schema. Throws if the schema uses anything outside the subset. */
export function compile(schema: unknown): CompiledValidator {
  checkSchema(schema, "#");
  const s = schema as Schema;
  const errors = (value: unknown): ValidationError[] => {
    const e: ValidationError[] = [];
    validateNode(s, value, "", e);
    return e;
  };
  const fn = ((value: unknown) => errors(value).length === 0) as CompiledValidator;
  fn.errors = errors;
  return fn;
}
