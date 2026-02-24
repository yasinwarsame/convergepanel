import { slugify } from "../lib/utils/slugify.ts";

let passed = 0;
let failed = 0;

function assert(actual, expected, label) {
  if (actual === expected) {
    console.log(`  PASS: ${label}`);
    passed++;
  } else {
    console.error(`  FAIL: ${label} — expected "${expected}", got "${actual}"`);
    failed++;
  }
}

console.log("Verifying slugify utility...\n");

assert(slugify(""), "", "empty string");
assert(slugify("Hello World"), "hello-world", "basic spaces");
assert(slugify("  Hello  World  "), "hello-world", "multiple spaces");
assert(slugify("foo--bar"), "foo-bar", "consecutive dashes");
assert(slugify("--foo--"), "foo", "leading/trailing dashes");
assert(slugify("Hello, World!"), "hello-world", "removes punctuation");
assert(slugify("foo@bar#baz"), "foobarbaz", "removes special chars");
assert(slugify("ABC 123"), "abc-123", "alphanumeric mix");
assert(
  slugify("Creme Brulee"),
  "creme-brulee",
  "plain ascii"
);
assert(
  slugify("Cr\u00e8me Br\u00fbl\u00e9e"),
  "creme-brulee",
  "unicode diacritics (Crème Brûlée)"
);
assert(slugify("\u00fc\u00f6\u00e4"), "uoa", "german umlauts");
assert(slugify("  - - -  "), "", "only spaces and dashes");
assert(slugify("a"), "a", "single char");
assert(slugify("---a---b---"), "a-b", "dashes between chars");
assert(slugify("Version 2.0 Release"), "version-20-release", "dot removal (not hyphen)");
assert(slugify("foo@bar!baz"), "foobarbaz", "special chars removed (not replaced)");
assert(slugify("hello_world"), "hello-world", "underscores to hyphens");
assert(slugify("foo__bar__baz"), "foo-bar-baz", "consecutive underscores collapse");
assert(slugify("   "), "", "whitespace only");
assert(slugify("mixed_spaces and-dashes"), "mixed-spaces-and-dashes", "mixed separators");

console.log(`\nResults: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  process.exit(1);
}
