/**
 * Tests for Firestore Sanitization Utilities
 * ==========================================
 * 
 * Comprehensive tests verifying:
 * 1. Object field undefined is OMITTED (key removed)
 * 2. Array undefined becomes NULL (preserves indexes - Option B)
 * 3. Firestore special types are PRESERVED unchanged
 * 4. Date objects are PRESERVED unchanged
 * 5. Nested objects/arrays behave correctly
 * 6. Input is NOT mutated (immutability)
 * 7. Circular reference detection works
 * 8. Dev assertion helper works
 * 
 * @module lib/__tests__/firestore-sanitize.test
 */

import {
  sanitizeForFirestore,
  stripUndefined,
  prepareForFirestore,
  assertNoUndefinedDeep,
} from "../firestore/sanitize";

// =============================================================================
// MOCK FIRESTORE TYPES
// =============================================================================
// These mock classes mimic Firestore SDK types for testing without initialization

class MockTimestamp {
  constructor(public seconds: number, public nanoseconds: number) {}
  toDate() { return new Date(this.seconds * 1000); }
  toMillis() { return this.seconds * 1000; }
}

class MockGeoPoint {
  latitude: number;
  longitude: number;
  constructor(latitude: number, longitude: number) {
    this.latitude = latitude;
    this.longitude = longitude;
  }
}

class MockBytes {
  constructor(private data: Uint8Array) {}
  toBase64() { return "base64encoded"; }
  toUint8Array() { return this.data; }
}

// Mock FieldValue with _methodName (internal SDK marker)
class MockFieldValue {
  _methodName: string;
  constructor(methodName: string) {
    this._methodName = methodName;
  }
  static serverTimestamp() { return new MockFieldValue("serverTimestamp"); }
  static increment(n: number) { return new MockFieldValue("increment"); }
  static arrayUnion(...elements: unknown[]) { return new MockFieldValue("arrayUnion"); }
  static arrayRemove(...elements: unknown[]) { return new MockFieldValue("arrayRemove"); }
  static deleteField() { return new MockFieldValue("deleteField"); }
}

// Mock DocumentReference with required properties
class MockDocumentReference {
  id = "doc123";
  path = "users/doc123";
  parent = { id: "users", path: "users" };
  firestore = { app: { name: "test" } };
}

// =============================================================================
// TEST: PRIMITIVE VALUES
// =============================================================================

describe("sanitizeForFirestore - primitives", () => {
  it("should pass through strings unchanged", () => {
    expect(sanitizeForFirestore("hello")).toBe("hello");
    expect(sanitizeForFirestore("")).toBe("");
  });

  it("should pass through numbers unchanged", () => {
    expect(sanitizeForFirestore(42)).toBe(42);
    expect(sanitizeForFirestore(0)).toBe(0);
    expect(sanitizeForFirestore(-1)).toBe(-1);
    expect(sanitizeForFirestore(3.14159)).toBe(3.14159);
    expect(sanitizeForFirestore(Infinity)).toBe(Infinity);
    expect(sanitizeForFirestore(NaN)).toBeNaN();
  });

  it("should pass through booleans unchanged", () => {
    expect(sanitizeForFirestore(true)).toBe(true);
    expect(sanitizeForFirestore(false)).toBe(false);
  });

  it("should pass through null unchanged", () => {
    expect(sanitizeForFirestore(null)).toBe(null);
  });

  it("should return undefined for undefined input", () => {
    expect(sanitizeForFirestore(undefined)).toBe(undefined);
  });
});

// =============================================================================
// TEST: OBJECTS - UNDEFINED OMISSION
// =============================================================================

describe("sanitizeForFirestore - objects (undefined → omitted)", () => {
  it("should OMIT keys with undefined values", () => {
    const input = { a: 1, b: undefined, c: "hello" };
    const result = sanitizeForFirestore(input);
    
    expect(result).toEqual({ a: 1, c: "hello" });
    expect("b" in (result as object)).toBe(false);
  });

  it("should PRESERVE keys with null values", () => {
    const input = { a: 1, b: null, c: "hello" };
    const result = sanitizeForFirestore(input);
    
    expect(result).toEqual({ a: 1, b: null, c: "hello" });
  });

  it("should PRESERVE keys with empty string values", () => {
    const input = { name: "", email: "test@test.com" };
    const result = sanitizeForFirestore(input);
    
    expect(result).toEqual({ name: "", email: "test@test.com" });
    expect((result as { name: string }).name).toBe("");
  });

  it("should PRESERVE keys with false values", () => {
    const input = { active: false, verified: true };
    const result = sanitizeForFirestore(input);
    
    expect(result).toEqual({ active: false, verified: true });
  });

  it("should PRESERVE keys with zero values", () => {
    const input = { count: 0, total: 100 };
    const result = sanitizeForFirestore(input);
    
    expect(result).toEqual({ count: 0, total: 100 });
  });

  it("should handle nested objects recursively", () => {
    const input = {
      user: {
        name: "John",
        bio: undefined,
        settings: {
          theme: "dark",
          notifications: undefined,
        },
      },
    };
    
    const result = sanitizeForFirestore(input);
    
    expect(result).toEqual({
      user: {
        name: "John",
        settings: {
          theme: "dark",
        },
      },
    });
  });

  it("should handle empty objects", () => {
    expect(sanitizeForFirestore({})).toEqual({});
  });

  it("should handle objects where ALL values are undefined", () => {
    const input = { a: undefined, b: undefined, c: undefined };
    const result = sanitizeForFirestore(input);
    
    expect(result).toEqual({});
  });
});

// =============================================================================
// TEST: ARRAYS - UNDEFINED → NULL (Option B)
// =============================================================================

describe("sanitizeForFirestore - arrays (undefined → null)", () => {
  it("should REPLACE undefined with null in arrays", () => {
    const input = [1, undefined, 2, undefined, 3];
    const result = sanitizeForFirestore(input);
    
    // Option B: undefined becomes null, preserving array length
    expect(result).toEqual([1, null, 2, null, 3]);
    expect((result as unknown[]).length).toBe(5);
  });

  it("should preserve null values in arrays unchanged", () => {
    const input = [1, null, 2, null, 3];
    const result = sanitizeForFirestore(input);
    
    expect(result).toEqual([1, null, 2, null, 3]);
  });

  it("should handle nested arrays with undefined → null", () => {
    const input = [1, [2, undefined, 3], [undefined, 4]];
    const result = sanitizeForFirestore(input);
    
    expect(result).toEqual([1, [2, null, 3], [null, 4]]);
  });

  it("should handle arrays of objects (omit undefined keys in objects)", () => {
    const input = [
      { a: 1, b: undefined },
      { c: undefined, d: 2 },
    ];
    const result = sanitizeForFirestore(input);
    
    // Objects still omit undefined keys
    expect(result).toEqual([{ a: 1 }, { d: 2 }]);
  });

  it("should handle empty arrays", () => {
    expect(sanitizeForFirestore([])).toEqual([]);
  });

  it("should handle arrays with only undefined values", () => {
    const input = [undefined, undefined, undefined];
    const result = sanitizeForFirestore(input);
    
    // All become null, preserving length
    expect(result).toEqual([null, null, null]);
    expect((result as unknown[]).length).toBe(3);
  });

  it("should preserve array index alignment for ordered data", () => {
    const input = ["first", undefined, "third", undefined, "fifth"];
    const result = sanitizeForFirestore(input) as string[];
    
    expect(result).toEqual(["first", null, "third", null, "fifth"]);
    expect(result[0]).toBe("first");
    expect(result[1]).toBe(null);
    expect(result[2]).toBe("third");
    expect(result[3]).toBe(null);
    expect(result[4]).toBe("fifth");
  });
});

// =============================================================================
// TEST: DATE HANDLING
// =============================================================================

describe("sanitizeForFirestore - Date objects", () => {
  it("should pass through Date objects unchanged", () => {
    const date = new Date("2024-01-15T12:00:00Z");
    const result = sanitizeForFirestore(date);
    
    expect(result).toBe(date); // Same reference
    expect(result).toBeInstanceOf(Date);
  });

  it("should preserve Date in nested objects", () => {
    const date = new Date();
    const input = { createdAt: date, name: "test" };
    const result = sanitizeForFirestore(input) as typeof input;
    
    expect(result.createdAt).toBe(date);
    expect(result.createdAt).toBeInstanceOf(Date);
  });

  it("should preserve Date in arrays", () => {
    const date = new Date();
    const input = [date, "text", 123];
    const result = sanitizeForFirestore(input);
    
    expect((result as unknown[])[0]).toBe(date);
  });
});

// =============================================================================
// TEST: FIRESTORE SPECIAL TYPES PRESERVATION
// =============================================================================

describe("sanitizeForFirestore - Firestore special types", () => {
  it("should preserve Timestamp-like objects unchanged", () => {
    const timestamp = new MockTimestamp(1704067200, 500000);
    const input = { createdAt: timestamp, name: "test" };
    const result = sanitizeForFirestore(input) as typeof input;
    
    expect(result.createdAt).toBe(timestamp); // Same reference
    expect(result.createdAt.seconds).toBe(1704067200);
  });

  it("should preserve serverTimestamp() FieldValue", () => {
    const fieldValue = MockFieldValue.serverTimestamp();
    const input = { updatedAt: fieldValue, name: "test" };
    const result = sanitizeForFirestore(input) as typeof input;
    
    expect(result.updatedAt).toBe(fieldValue);
    expect((result.updatedAt as MockFieldValue)._methodName).toBe("serverTimestamp");
  });

  it("should preserve increment() FieldValue", () => {
    const fieldValue = MockFieldValue.increment(1);
    const input = { count: fieldValue };
    const result = sanitizeForFirestore(input);
    
    expect((result as { count: MockFieldValue }).count).toBe(fieldValue);
  });

  it("should preserve arrayUnion() FieldValue", () => {
    const fieldValue = MockFieldValue.arrayUnion("tag1", "tag2");
    const input = { tags: fieldValue };
    const result = sanitizeForFirestore(input);
    
    expect((result as { tags: MockFieldValue }).tags).toBe(fieldValue);
  });

  it("should preserve arrayRemove() FieldValue", () => {
    const fieldValue = MockFieldValue.arrayRemove("oldTag");
    const input = { tags: fieldValue };
    const result = sanitizeForFirestore(input);
    
    expect((result as { tags: MockFieldValue }).tags).toBe(fieldValue);
  });

  it("should preserve deleteField() FieldValue", () => {
    const fieldValue = MockFieldValue.deleteField();
    const input = { obsoleteField: fieldValue };
    const result = sanitizeForFirestore(input);
    
    expect((result as { obsoleteField: MockFieldValue }).obsoleteField).toBe(fieldValue);
  });

  it("should preserve GeoPoint-like objects unchanged", () => {
    const geoPoint = new MockGeoPoint(37.7749, -122.4194);
    const input = { location: geoPoint, name: "San Francisco" };
    const result = sanitizeForFirestore(input) as typeof input;
    
    expect(result.location).toBe(geoPoint);
    expect(result.location.latitude).toBe(37.7749);
  });

  it("should preserve Bytes-like objects unchanged", () => {
    const bytes = new MockBytes(new Uint8Array([1, 2, 3]));
    const input = { data: bytes };
    const result = sanitizeForFirestore(input);
    
    expect((result as { data: MockBytes }).data).toBe(bytes);
  });

  it("should preserve DocumentReference-like objects unchanged", () => {
    const docRef = new MockDocumentReference();
    const input = { userRef: docRef, name: "test" };
    const result = sanitizeForFirestore(input) as typeof input;
    
    expect(result.userRef).toBe(docRef);
    expect(result.userRef.path).toBe("users/doc123");
  });
});

// =============================================================================
// TEST: POLICY COMPLIANCE - EXACT CASES
// =============================================================================

describe("sanitizeForFirestore - policy compliance", () => {
  it("arrays: should convert undefined to null (preserve indices)", () => {
    const input = [1, undefined, 3];
    const result = sanitizeForFirestore(input);
    expect(result).toEqual([1, null, 3]);
    expect((result as unknown[]).length).toBe(3);
  });

  it("objects: should omit keys with undefined values", () => {
    const input = { a: 1, b: undefined };
    const result = sanitizeForFirestore(input);
    expect(result).toEqual({ a: 1 });
    expect("b" in (result as object)).toBe(false);
  });

  it("nested mix: {x:[undefined,{y:undefined,z:0}]} -> {x:[null,{z:0}]}", () => {
    const input = { x: [undefined, { y: undefined, z: 0 }] };
    const result = sanitizeForFirestore(input);
    expect(result).toEqual({ x: [null, { z: 0 }] });
  });

  it("Date: should preserve unchanged", () => {
    const date = new Date("2024-01-15T12:00:00Z");
    const input = { createdAt: date };
    const result = sanitizeForFirestore(input) as typeof input;
    expect(result.createdAt).toBe(date); // Same reference
    expect(result.createdAt).toBeInstanceOf(Date);
  });

  it("Firestore Timestamp: should preserve unchanged", () => {
    const timestamp = new MockTimestamp(1704067200, 500000);
    const input = { updatedAt: timestamp };
    const result = sanitizeForFirestore(input) as typeof input;
    expect(result.updatedAt).toBe(timestamp); // Same reference
    expect(result.updatedAt.seconds).toBe(1704067200);
  });
});

// =============================================================================
// TEST: COMPLEX NESTED STRUCTURES
// =============================================================================

describe("sanitizeForFirestore - complex structures", () => {
  it("should handle real-world user document structure", () => {
    const serverTs = MockFieldValue.serverTimestamp();
    const input = {
      uid: "user123",
      email: "test@example.com",
      name: undefined, // Should be OMITTED
      profile: {
        displayName: "Test User",
        bio: undefined, // Should be OMITTED
        settings: {
          theme: "dark",
          notifications: undefined, // Should be OMITTED
        },
      },
      roles: ["user", undefined, "admin"], // undefined → null
      metadata: {
        lastLogin: new Date(),
        loginCount: 5,
      },
      createdAt: serverTs,
    };

    const result = sanitizeForFirestore(input);
    const typed = result as typeof input;

    expect(typed.uid).toBe("user123");
    expect(typed.email).toBe("test@example.com");
    expect("name" in typed).toBe(false); // Omitted
    expect((typed.profile as Record<string, unknown>).displayName).toBe("Test User");
    expect("bio" in (typed.profile as object)).toBe(false); // Omitted
    expect(typed.roles).toEqual(["user", null, "admin"]); // undefined → null
    expect(typed.createdAt).toBe(serverTs); // Preserved
  });

  it("should handle the EXACT signup crash scenario", () => {
    // This is the case that caused the original crash
    const input = {
      uid: "user123",
      email: "test@example.com",
      name: undefined, // User left name blank
      role: "user",
      plan: "free",
      runsThisMonth: 0,
      createdAt: MockFieldValue.serverTimestamp(),
    };

    const result = sanitizeForFirestore(input);

    // name key should NOT exist
    expect("name" in result).toBe(false);
    // All other fields preserved
    expect((result as Record<string, unknown>).uid).toBe("user123");
    expect((result as Record<string, unknown>).email).toBe("test@example.com");
    expect((result as Record<string, unknown>).role).toBe("user");
    expect((result as Record<string, unknown>).plan).toBe("free");
    expect((result as Record<string, unknown>).runsThisMonth).toBe(0);
    // serverTimestamp preserved
    expect((result as Record<string, unknown>).createdAt).toBe(input.createdAt);
  });
});

// =============================================================================
// TEST: IMMUTABILITY
// =============================================================================

describe("sanitizeForFirestore - immutability", () => {
  it("should NOT mutate the input object", () => {
    const input = {
      a: 1,
      b: undefined,
      nested: { c: 2, d: undefined },
    };
    const inputCopy = JSON.parse(JSON.stringify(input));
    
    sanitizeForFirestore(input);
    
    // Original should be unchanged
    expect(input.a).toBe(1);
    expect(input.b).toBe(undefined);
    expect(input.nested.c).toBe(2);
    expect(input.nested.d).toBe(undefined);
    expect(JSON.stringify(input)).toBe(JSON.stringify(inputCopy));
  });

  it("should NOT mutate the input array", () => {
    const input = [1, undefined, { a: undefined }];
    const originalLength = input.length;
    
    sanitizeForFirestore(input);
    
    expect(input.length).toBe(originalLength);
    expect(input[1]).toBe(undefined); // Still undefined in original
  });

  it("should return a NEW object, not the same reference", () => {
    const input = { a: 1, b: 2 };
    const result = sanitizeForFirestore(input);
    
    expect(result).not.toBe(input);
    expect(result).toEqual(input);
  });
});

// =============================================================================
// TEST: CIRCULAR REFERENCE DETECTION
// =============================================================================

describe("sanitizeForFirestore - circular references", () => {
  it("should throw on self-referencing object", () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj; // Circular reference
    
    expect(() => sanitizeForFirestore(obj)).toThrow(/Circular reference detected/);
  });

  it("should throw on indirect circular reference", () => {
    const a: Record<string, unknown> = { name: "a" };
    const b: Record<string, unknown> = { name: "b", ref: a };
    a.ref = b; // a → b → a
    
    expect(() => sanitizeForFirestore(a)).toThrow(/Circular reference detected/);
  });

  it("should include path in circular reference error", () => {
    const obj: Record<string, unknown> = { nested: {} };
    (obj.nested as Record<string, unknown>).circular = obj;
    
    expect(() => sanitizeForFirestore(obj)).toThrow(/path/);
  });

  it("should handle non-circular shared references (same object in multiple places)", () => {
    const shared = { value: 42 };
    const input = {
      first: shared,
      second: shared,
    };
    
    // This should NOT throw because it's not truly circular
    // Note: after first visit, WeakSet prevents re-processing but doesn't error
    // The expected behavior is the first reference gets processed, second is skipped
    expect(() => sanitizeForFirestore(input)).not.toThrow();
  });
});

// =============================================================================
// TEST: ASSERTION HELPER
// =============================================================================

describe("assertNoUndefinedDeep", () => {
  it("should throw when undefined found in object", () => {
    const input = { name: "test", value: undefined };
    
    expect(() => assertNoUndefinedDeep(input)).toThrow(/Found undefined at path/);
    expect(() => assertNoUndefinedDeep(input)).toThrow(/root\.value/);
  });

  it("should throw when undefined found in nested object", () => {
    const input = { user: { profile: { bio: undefined } } };
    
    expect(() => assertNoUndefinedDeep(input)).toThrow(/root\.user\.profile\.bio/);
  });

  it("should throw when undefined found in array", () => {
    const input = [1, 2, undefined, 4];
    
    expect(() => assertNoUndefinedDeep(input)).toThrow(/root\[2\]/);
  });

  it("should NOT throw for valid data", () => {
    const input = {
      name: "test",
      count: 0,
      active: false,
      data: null,
      items: [1, 2, 3],
    };
    
    expect(() => assertNoUndefinedDeep(input)).not.toThrow();
  });

  it("should use custom root path", () => {
    const input = { value: undefined };
    
    expect(() => assertNoUndefinedDeep(input, "myData")).toThrow(/myData\.value/);
  });
});

// =============================================================================
// TEST: HELPER FUNCTIONS
// =============================================================================

describe("stripUndefined", () => {
  it("should strip only top-level undefined values", () => {
    const input = { a: 1, b: undefined, c: { d: undefined } };
    const result = stripUndefined(input);
    
    expect(result).toEqual({ a: 1, c: { d: undefined } });
    expect("b" in result).toBe(false);
    // Note: nested undefined is NOT stripped (non-recursive)
    expect("d" in (result.c as object)).toBe(true);
  });

  it("should preserve falsy but valid values", () => {
    const input = { a: 0, b: false, c: "", d: null, e: undefined };
    const result = stripUndefined(input);
    
    expect(result).toEqual({ a: 0, b: false, c: "", d: null });
    expect("e" in result).toBe(false);
  });
});

describe("prepareForFirestore", () => {
  it("should be a convenience wrapper for sanitizeForFirestore", () => {
    const input = { a: 1, b: undefined, c: "test" };
    const result = prepareForFirestore(input);
    
    expect(result).toEqual({ a: 1, c: "test" });
  });
});

// =============================================================================
// TEST: REGRESSION - LOGIC ERROR DETECTION
// =============================================================================

describe("regression tests - logic errors", () => {
  it("should NOT map undefined to any default value like 'consensus'", () => {
    // Catches bugs like: if (typeof value === "string") return "consensus";
    const input = { label: undefined };
    const result = sanitizeForFirestore(input);
    
    expect("label" in result).toBe(false);
    expect((result as Record<string, unknown>).label).not.toBe("consensus");
    expect((result as Record<string, unknown>).label).not.toBe("");
    expect((result as Record<string, unknown>).label).not.toBe(null);
  });

  it("should distinguish arrays from objects correctly", () => {
    const arrayInput = [undefined];
    const objectInput = { key: undefined };
    
    const arrayResult = sanitizeForFirestore(arrayInput);
    const objectResult = sanitizeForFirestore(objectInput);
    
    // Array: undefined → null
    expect(arrayResult).toEqual([null]);
    // Object: undefined key omitted
    expect(objectResult).toEqual({});
  });

  it("should handle empty string differently from undefined", () => {
    const input = { name: "", description: undefined };
    const result = sanitizeForFirestore(input);
    
    // Empty string IS included
    expect("name" in result).toBe(true);
    expect((result as Record<string, unknown>).name).toBe("");
    // undefined IS omitted
    expect("description" in result).toBe(false);
  });

  it("should not corrupt class instances", () => {
    class CustomClass {
      constructor(public value: number) {}
      getValue() { return this.value; }
    }
    
    const instance = new CustomClass(42);
    const input = { custom: instance };
    const result = sanitizeForFirestore(input);
    
    // Should pass through unchanged (not converted to plain object)
    expect((result as { custom: CustomClass }).custom).toBe(instance);
    expect((result as { custom: CustomClass }).custom.getValue()).toBe(42);
  });
});
