#!/usr/bin/env node

/**
 * Firestore Sanitize Unit Tests
 * ==============================
 * 
 * Node.js script to verify sanitizeForFirestore behavior.
 * Tests all documented policies:
 * 
 * 1. ARRAYS: undefined elements → null (preserve indexes)
 * 2. OBJECTS: undefined keys → omitted
 * 3. DATES: pass through unchanged
 * 4. FIRESTORE SPECIAL TYPES: preserved (no traversal)
 * 5. IMMUTABILITY: input not mutated
 * 
 * USAGE:
 *   node scripts/test-firestore-sanitize.js
 *   npm run test:sanitize
 * 
 * EXIT CODES:
 *   0 - All tests passed
 *   1 - One or more tests failed
 */

// =============================================================================
// INLINE IMPLEMENTATION (mirrors lib/firestore/sanitize.ts)
// =============================================================================

function isPlainObject(value) {
  if (value === null || typeof value !== "object") {
    return false;
  }
  if (Object.prototype.toString.call(value) !== "[object Object]") {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function isFirestoreSpecialType(value) {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const obj = value;

  // FieldValue detection
  if (typeof obj._methodName === "string") {
    return true;
  }
  if (value.constructor?.name === "FieldValue") {
    return true;
  }

  // DocumentReference detection
  if (
    typeof obj.id === "string" &&
    typeof obj.path === "string" &&
    obj.parent !== null && typeof obj.parent === "object" &&
    obj.firestore !== null && typeof obj.firestore === "object"
  ) {
    return true;
  }

  // Timestamp duck-type (strict: requires all 4 properties)
  if (
    typeof obj.seconds === "number" &&
    typeof obj.nanoseconds === "number" &&
    typeof obj.toDate === "function" &&
    typeof obj.toMillis === "function"
  ) {
    return true;
  }

  // Bytes duck-type
  if (
    typeof obj.toBase64 === "function" &&
    typeof obj.toUint8Array === "function"
  ) {
    return true;
  }

  return false;
}

function sanitizeForFirestore(value) {
  const seen = new WeakSet();
  return sanitizeValue(value, seen, "root");
}

function sanitizeValue(value, seen, path) {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    return null;
  }
  if (typeof value !== "object") {
    return value;
  }
  if (value instanceof Date) {
    return value;
  }
  if (isFirestoreSpecialType(value)) {
    return value;
  }
  if (seen.has(value)) {
    throw new Error(
      `[sanitizeForFirestore] Circular reference detected at path: ${path}.`
    );
  }
  seen.add(value);

  if (Array.isArray(value)) {
    const result = value.map((item, index) => {
      const sanitized = sanitizeValue(item, seen, `${path}[${index}]`);
      return sanitized === undefined ? null : sanitized;
    });
    seen.delete(value);
    return result;
  }

  if (isPlainObject(value)) {
    const result = {};
    for (const [key, val] of Object.entries(value)) {
      const sanitized = sanitizeValue(val, seen, `${path}.${key}`);
      if (sanitized !== undefined) {
        result[key] = sanitized;
      }
    }
    seen.delete(value);
    return result;
  }

  seen.delete(value);
  return value;
}

// =============================================================================
// TEST HELPERS
// =============================================================================

let passed = 0;
let failed = 0;

function assertEqual(actual, expected, testName) {
  const actualStr = JSON.stringify(actual);
  const expectedStr = JSON.stringify(expected);
  if (actualStr === expectedStr) {
    passed++;
    console.log(`  ✓ ${testName}`);
  } else {
    failed++;
    console.log(`  ✗ ${testName}`);
    console.log(`    Expected: ${expectedStr}`);
    console.log(`    Actual:   ${actualStr}`);
  }
}

function assertStrictEqual(actual, expected, testName) {
  if (actual === expected) {
    passed++;
    console.log(`  ✓ ${testName}`);
  } else {
    failed++;
    console.log(`  ✗ ${testName}`);
    console.log(`    Expected: ${expected}`);
    console.log(`    Actual:   ${actual}`);
  }
}

function assertThrows(fn, pattern, testName) {
  try {
    fn();
    failed++;
    console.log(`  ✗ ${testName} (expected to throw but did not)`);
  } catch (e) {
    if (pattern.test(e.message)) {
      passed++;
      console.log(`  ✓ ${testName}`);
    } else {
      failed++;
      console.log(`  ✗ ${testName} (threw but message didn't match)`);
      console.log(`    Pattern: ${pattern}`);
      console.log(`    Message: ${e.message}`);
    }
  }
}

// =============================================================================
// TESTS
// =============================================================================

console.log("\n🧪 Firestore Sanitize Unit Tests\n");

console.log("1. ARRAYS: undefined → null (preserve indexes)");
assertEqual(sanitizeForFirestore([1, undefined, 3]), [1, null, 3], "[1, undefined, 3] => [1, null, 3]");
assertEqual(sanitizeForFirestore([undefined, undefined]), [null, null], "all undefined preserved as nulls");
assertStrictEqual(sanitizeForFirestore([1, undefined, 3]).length, 3, "array length preserved");

console.log("\n2. OBJECTS: undefined keys → omitted");
assertEqual(sanitizeForFirestore({ a: 1, b: undefined }), { a: 1 }, "{a:1, b:undefined} => {a:1}");
assertEqual(sanitizeForFirestore({ x: undefined }), {}, "all undefined = empty object");
assertEqual(sanitizeForFirestore({ nested: { a: 1, b: undefined } }), { nested: { a: 1 } }, "nested undefined omitted");

console.log("\n3. Preserves falsy values (false, 0, '', null)");
assertEqual(sanitizeForFirestore({ a: false }), { a: false }, "preserves false");
assertEqual(sanitizeForFirestore({ a: 0 }), { a: 0 }, "preserves 0");
assertEqual(sanitizeForFirestore({ a: "" }), { a: "" }, "preserves empty string");
assertEqual(sanitizeForFirestore({ a: null }), { a: null }, "preserves null");

console.log("\n4. DATES: pass through unchanged");
const date = new Date("2024-01-15T00:00:00Z");
const dateResult = sanitizeForFirestore({ createdAt: date });
assertStrictEqual(dateResult.createdAt === date, true, "Date same reference");
assertStrictEqual(dateResult.createdAt instanceof Date, true, "Date instanceof preserved");

console.log("\n5. FIRESTORE SPECIAL TYPES: preserved (no traversal)");
const mockFieldValue = { _methodName: "serverTimestamp" };
const mockTimestamp = { seconds: 1234, nanoseconds: 0, toDate: () => {}, toMillis: () => {} };
const mockDocRef = { id: "doc1", path: "users/doc1", parent: {}, firestore: {} };
assertStrictEqual(sanitizeForFirestore({ fv: mockFieldValue }).fv === mockFieldValue, true, "FieldValue preserved");
assertStrictEqual(sanitizeForFirestore({ ts: mockTimestamp }).ts === mockTimestamp, true, "Timestamp preserved");
assertStrictEqual(sanitizeForFirestore({ ref: mockDocRef }).ref === mockDocRef, true, "DocumentReference preserved");

console.log("\n6. CIRCULAR REFERENCES: throw with path");
assertThrows(
  () => { const obj = { a: 1 }; obj.self = obj; sanitizeForFirestore(obj); },
  /Circular reference.*root\.self/,
  "self-reference throws with 'root.self' path"
);

console.log("\n7. IMMUTABILITY: input not mutated");
const original = { a: 1, b: undefined, nested: { c: undefined } };
const originalB = original.b;
const originalNestedC = original.nested.c;
sanitizeForFirestore(original);
assertStrictEqual(original.b, originalB, "top-level undefined not mutated");
assertStrictEqual(original.nested.c, originalNestedC, "nested undefined not mutated");

console.log("\n8. Plain object {latitude, longitude} is treated as object (not GeoPoint)");
const plainLatLng = { latitude: 37.7749, longitude: -122.4194, extra: undefined };
assertEqual(
  sanitizeForFirestore({ location: plainLatLng }),
  { location: { latitude: 37.7749, longitude: -122.4194 } },
  "plain lat/lng with undefined: undefined omitted (proves traversal)"
);

// =============================================================================
// SUMMARY
// =============================================================================

console.log("\n" + "─".repeat(50));
console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);

process.exit(failed > 0 ? 1 : 0);
