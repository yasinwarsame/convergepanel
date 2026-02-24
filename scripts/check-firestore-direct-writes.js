#!/usr/bin/env node

/**
 * Firestore Direct Write Checker
 * ===============================
 * 
 * This script scans the codebase for direct imports of setDoc, updateDoc, or addDoc
 * from "firebase/firestore" that are NOT in the allowed files.
 * 
 * PURPOSE:
 * Enforce that all Firestore writes go through lib/firestore/safeWrite.ts
 * to ensure undefined values are sanitized and Firestore special types are preserved.
 * 
 * ALLOWED FILES (where direct imports are permitted):
 * - lib/firestore/safeWrite.ts (the wrapper implementation)
 * - lib/firestore/sanitize.ts (the sanitizer implementation)
 * - lib/__tests__/*.ts (test files)
 * 
 * USAGE:
 *   node scripts/check-firestore-direct-writes.js
 *   npm run check:firestore-writes
 * 
 * EXIT CODES:
 *   0 - No violations found
 *   1 - Violations found (direct imports outside allowed files)
 */

const fs = require("fs");
const path = require("path");

// Configuration
const ROOT_DIR = path.resolve(__dirname, "..");
const EXTENSIONS = [".ts", ".tsx"];
const IGNORE_DIRS = ["node_modules", ".next", ".git", "dist", "build", ".cursor"];

// Files where direct imports are allowed
const ALLOWED_FILES = [
  "lib/firestore/safeWrite.ts",
  "lib/firestore/sanitize.ts",
];

// Patterns to allow (test files)
const ALLOWED_PATTERNS = [
  /lib\/__tests__\//,
  /\.test\.ts$/,
  /\.spec\.ts$/,
];

// Pattern to detect direct imports of write operations from firebase/firestore
// Matches: import { setDoc } from "firebase/firestore"
// Matches: import { setDoc, updateDoc } from "firebase/firestore"
// Matches: const { setDoc } = await import("firebase/firestore")
const IMPORT_PATTERN = /(?:import\s*\{[^}]*(?:setDoc|updateDoc|addDoc)[^}]*\}\s*from\s*["']firebase\/firestore["'])|(?:(?:const|let|var)\s*\{[^}]*(?:setDoc|updateDoc|addDoc)[^}]*\}\s*=\s*await\s+import\s*\(\s*["']firebase\/firestore["']\s*\))/g;

// Extract which operations are imported
const OPERATIONS = ["setDoc", "updateDoc", "addDoc"];

function isAllowedFile(filePath) {
  const relativePath = path.relative(ROOT_DIR, filePath).replace(/\\/g, "/");
  
  // Check exact allowed files
  if (ALLOWED_FILES.some(allowed => relativePath.endsWith(allowed))) {
    return true;
  }
  
  // Check allowed patterns (test files)
  if (ALLOWED_PATTERNS.some(pattern => pattern.test(relativePath))) {
    return true;
  }
  
  return false;
}

function scanFile(filePath) {
  const violations = [];
  
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const matches = line.match(IMPORT_PATTERN);
      
      if (matches) {
        // Extract which operations are in this import
        const foundOps = OPERATIONS.filter(op => line.includes(op));
        
        violations.push({
          file: filePath,
          line: i + 1,
          code: line.trim(),
          operations: foundOps,
        });
      }
    }
  } catch (err) {
    // Ignore read errors (binary files, permission issues)
  }
  
  return violations;
}

function scanDirectory(dirPath) {
  const violations = [];
  
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      
      if (entry.isDirectory()) {
        // Skip ignored directories
        if (IGNORE_DIRS.includes(entry.name)) {
          continue;
        }
        violations.push(...scanDirectory(fullPath));
      } else if (entry.isFile()) {
        // Check file extension
        const ext = path.extname(entry.name);
        if (!EXTENSIONS.includes(ext)) {
          continue;
        }
        
        // Skip allowed files
        if (isAllowedFile(fullPath)) {
          continue;
        }
        
        violations.push(...scanFile(fullPath));
      }
    }
  } catch (err) {
    console.error(`Error scanning ${dirPath}:`, err.message);
  }
  
  return violations;
}

function main() {
  console.log("🔍 Checking for direct Firestore write imports...\n");
  
  const violations = scanDirectory(ROOT_DIR);
  
  if (violations.length === 0) {
    console.log("✅ No direct Firestore write imports found outside allowed files.");
    console.log("\nAll Firestore writes are going through lib/firestore/safeWrite.ts");
    process.exit(0);
  }
  
  console.log(`❌ Found ${violations.length} violation(s):\n`);
  
  for (const v of violations) {
    const relativePath = path.relative(ROOT_DIR, v.file);
    console.log(`  ${relativePath}:${v.line}`);
    console.log(`    Operations: ${v.operations.join(", ")}`);
    console.log(`    Code: ${v.code}`);
    console.log("");
  }
  
  console.log("─".repeat(60));
  console.log("\n📝 HOW TO FIX:");
  console.log("   Replace direct imports with safe wrappers:\n");
  console.log("   BEFORE:");
  console.log('   import { setDoc, updateDoc } from "firebase/firestore";');
  console.log("");
  console.log("   AFTER:");
  console.log('   import { safeSetDoc, safeUpdateDoc } from "@/lib/firestore/safeWrite";');
  console.log("\n   The safe wrappers automatically sanitize data to prevent");
  console.log("   'Unsupported field value: undefined' errors while preserving");
  console.log("   Firestore special types (Timestamp, FieldValue, etc.).\n");
  
  process.exit(1);
}

main();
