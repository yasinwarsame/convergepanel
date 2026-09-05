/**
 * Phase FIRESTORE-AUTHZ-P0.1 — a SEPARATE Jest project for Firestore Rules.
 *
 * These specs drive a real Firestore emulator against the real
 * `firestore.rules`, so they cannot run in the ordinary unit suite, which has
 * no emulator and must stay hermetic. `npm run test:rules` starts the emulator
 * around them; `jest.config.ts` ignores this directory.
 *
 * The module mapping mirrors the main config: `server-only` throws on import
 * outside a React Server Component, and the entitlement resolver these tests
 * deliberately exercise is guarded by it.
 */
module.exports = {
  testEnvironment: "node",
  moduleNameMapper: {
    "^server-only$": "<rootDir>/node_modules/server-only/empty.js",
    "^@/(.*)$": "<rootDir>/$1",
  },
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: { module: "commonjs", jsx: "react-jsx" } }],
  },
  testMatch: ["<rootDir>/firestore-rules-tests/**/*.rules.spec.ts"],
  testTimeout: 30000,
};
