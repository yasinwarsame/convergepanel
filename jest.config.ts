import type { Config } from "jest";

const config: Config = {
  preset: "ts-jest",
  testEnvironment: "node",
  moduleNameMapper: {
    // "server-only"'s package.json only remaps to its no-op empty.js under the
    // "react-server" export condition (set by Next's webpack build). Jest has
    // no such condition, so without this it unconditionally throws on import
    // for every server-only-guarded module (lib/logger.ts, lib/adaptiveSchema/*, etc.).
    "^server-only$": "<rootDir>/node_modules/server-only/empty.js",
    "^@/(.*)$": "<rootDir>/$1",
  },
  transform: {
    // jsx: "react-jsx" overrides tsconfig.json's "preserve" (needed by Next's
    // own build pipeline) — ts-jest compiles straight to executable JS with
    // no bundler afterward, so JSX must be transformed here, not left as-is.
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: { module: "commonjs", jsx: "react-jsx" } }],
  },
  testMatch: ["**/__tests__/**/*.spec.ts", "**/__tests__/**/*.test.ts", "**/__tests__/**/*.spec.tsx", "**/synthesis/**/*.test.ts"],
  testPathIgnorePatterns: ["lib/__tests__/agreementMap.test.ts", "<rootDir>/firestore-rules-tests/"],
};

export default config;
