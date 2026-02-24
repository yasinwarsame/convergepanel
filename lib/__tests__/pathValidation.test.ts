/**
 * Path Validation Tests
 * 
 * Ensures CodeCheck path validation correctly rejects invalid paths
 * like src/ (which doesn't exist in ConvergePanel) and accepts
 * valid paths under app/, components/, lib/, etc.
 * 
 * Run with: npm test -- lib/__tests__/pathValidation.test.ts
 */

import {
  normalizePath,
  getTopLevelDir,
  validatePath,
  validatePathForPatching,
  validateFilePlanPaths,
  validateSpecPaths,
  extractPathsFromDiff,
  validatePatchPaths,
  validateDiffPaths,
  validatePlanPatchIntegrity,
  buildPathValidationError,
  hasPathTraversal,
  isReadOnlyRootFile,
  ALLOWED_TOP_LEVEL_DIRS,
  FORBIDDEN_PREFIXES,
  PATH_ERROR_HINT,
} from "@/lib/codecheck/pathValidation";
import type { CodeCheckFilePlanEntry, CodeCheckSpec, CodeCheckDiff } from "@/lib/codecheck/types";

describe("Path Validation", () => {
  describe("normalizePath", () => {
    it("should remove leading slashes", () => {
      expect(normalizePath("/app/page.tsx")).toBe("app/page.tsx");
      expect(normalizePath("///app/page.tsx")).toBe("app/page.tsx");
    });

    it("should remove leading ./", () => {
      expect(normalizePath("./app/page.tsx")).toBe("app/page.tsx");
      expect(normalizePath("././app/page.tsx")).toBe("app/page.tsx");
    });

    it("should trim whitespace", () => {
      expect(normalizePath("  app/page.tsx  ")).toBe("app/page.tsx");
    });

    it("should handle combinations", () => {
      expect(normalizePath("  /./app/page.tsx  ")).toBe("app/page.tsx");
    });
  });

  describe("getTopLevelDir", () => {
    it("should extract top-level directory", () => {
      expect(getTopLevelDir("app/page.tsx")).toBe("app");
      expect(getTopLevelDir("components/Button.tsx")).toBe("components");
      expect(getTopLevelDir("lib/utils/helpers.ts")).toBe("lib");
    });

    it("should return null for root-level files", () => {
      expect(getTopLevelDir("package.json")).toBeNull();
      expect(getTopLevelDir("tsconfig.json")).toBeNull();
    });

    it("should handle paths with leading slashes", () => {
      expect(getTopLevelDir("/app/page.tsx")).toBe("app");
    });
  });

  describe("validatePath", () => {
    describe("valid paths", () => {
      it("should accept app/ paths", () => {
        expect(validatePath("app/page.tsx")).toBeNull();
        expect(validatePath("app/api/route.ts")).toBeNull();
        expect(validatePath("app/dashboard/layout.tsx")).toBeNull();
      });

      it("should accept components/ paths", () => {
        expect(validatePath("components/Button.tsx")).toBeNull();
        expect(validatePath("components/ui/Card.tsx")).toBeNull();
      });

      it("should accept lib/ paths", () => {
        expect(validatePath("lib/utils.ts")).toBeNull();
        expect(validatePath("lib/codecheck/types.ts")).toBeNull();
      });

      it("should accept other allowed directories", () => {
        expect(validatePath("prisma/schema.prisma")).toBeNull();
        expect(validatePath("public/favicon.ico")).toBeNull();
        expect(validatePath("scripts/build.js")).toBeNull();
        expect(validatePath("hooks/useAuth.ts")).toBeNull();
      });

      it("should accept root-level config files", () => {
        expect(validatePath("package.json")).toBeNull();
        expect(validatePath("tsconfig.json")).toBeNull();
        expect(validatePath("next.config.js")).toBeNull();
      });
    });

    describe("invalid paths - src/", () => {
      it("should reject src/ paths", () => {
        const result = validatePath("src/components/Button.tsx");
        expect(result).not.toBeNull();
        expect(result?.reason).toContain("src/");
        expect(result?.suggestion).toBe("components/Button.tsx");
      });

      it("should suggest correct path for src/lib/", () => {
        const result = validatePath("src/lib/utils.ts");
        expect(result).not.toBeNull();
        expect(result?.suggestion).toBe("lib/utils.ts");
      });

      it("should suggest correct path for src/app/", () => {
        const result = validatePath("src/app/page.tsx");
        expect(result).not.toBeNull();
        expect(result?.suggestion).toBe("app/page.tsx");
      });

      it("should suggest lib/ for generic src/ files", () => {
        const result = validatePath("src/helpers.ts");
        expect(result).not.toBeNull();
        expect(result?.suggestion).toBe("lib/helpers.ts");
      });
    });

    describe("invalid paths - other forbidden prefixes", () => {
      it("should reject pages/ paths", () => {
        const result = validatePath("pages/index.tsx");
        expect(result).not.toBeNull();
        expect(result?.reason).toContain("pages/");
      });

      it("should reject api/ without app/ prefix", () => {
        const result = validatePath("api/users.ts");
        expect(result).not.toBeNull();
        expect(result?.reason).toContain("api/");
        expect(result?.suggestion).toBe("app/api/users.ts");
      });

      it("should reject utils/ as top-level", () => {
        const result = validatePath("utils/helpers.ts");
        expect(result).not.toBeNull();
        expect(result?.reason).toContain("utils/");
        expect(result?.suggestion).toBe("lib/helpers.ts");
      });
    });

    describe("invalid paths - unknown directories", () => {
      it("should reject unknown top-level directories", () => {
        const result = validatePath("foo/bar.ts");
        expect(result).not.toBeNull();
        expect(result?.reason).toContain("not allowed");
      });
    });
  });

  describe("validateFilePlanPaths", () => {
    it("should validate valid file plan", () => {
      const filePlan: CodeCheckFilePlanEntry[] = [
        { path: "app/page.tsx", purpose: "Main page", action: "modify" },
        { path: "lib/utils.ts", purpose: "Utilities", action: "create" },
      ];
      const result = validateFilePlanPaths(filePlan);
      expect(result.valid).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it("should reject file plan with src/ paths", () => {
      const filePlan: CodeCheckFilePlanEntry[] = [
        { path: "src/components/Button.tsx", purpose: "Button", action: "create" },
        { path: "app/page.tsx", purpose: "Page", action: "modify" },
      ];
      const result = validateFilePlanPaths(filePlan);
      expect(result.valid).toBe(false);
      expect(result.violations).toHaveLength(1);
      expect(result.violations[0].path).toBe("src/components/Button.tsx");
    });

    it("should report all violations", () => {
      const filePlan: CodeCheckFilePlanEntry[] = [
        { path: "src/utils.ts", purpose: "Utils", action: "create" },
        { path: "pages/index.tsx", purpose: "Page", action: "create" },
      ];
      const result = validateFilePlanPaths(filePlan);
      expect(result.valid).toBe(false);
      expect(result.violations).toHaveLength(2);
    });
  });

  describe("validateSpecPaths", () => {
    it("should validate both file plan and task filesTouched", () => {
      const spec: CodeCheckSpec = {
        summary: ["Test"],
        architecture: "Test",
        filePlan: [
          { path: "src/foo.ts", purpose: "Bad", action: "create" },
        ],
        tasks: [
          {
            id: "1",
            goal: "Test",
            filesTouched: ["src/bar.ts"],
            acceptanceCriteria: [],
            verificationCommands: [],
          },
        ],
        assumptions: [],
        contestedAreas: [],
      };
      const result = validateSpecPaths(spec);
      expect(result.valid).toBe(false);
      expect(result.violations).toHaveLength(2);
    });
  });

  describe("extractPathsFromDiff", () => {
    it("should extract paths from +++ lines", () => {
      const diff = `--- a/app/page.tsx
+++ b/app/page.tsx
@@ -1,5 +1,5 @@
 import React from 'react';
`;
      const paths = extractPathsFromDiff(diff);
      expect(paths).toContain("app/page.tsx");
    });

    it("should handle paths without b/ prefix", () => {
      const diff = `--- /dev/null
+++ components/Button.tsx
@@ -0,0 +1,10 @@
`;
      const paths = extractPathsFromDiff(diff);
      expect(paths).toContain("components/Button.tsx");
    });

    it("should skip /dev/null", () => {
      const diff = `--- a/old.ts
+++ /dev/null
`;
      const paths = extractPathsFromDiff(diff);
      expect(paths).not.toContain("/dev/null");
    });

    it("should deduplicate paths", () => {
      const diff = `--- a/app/page.tsx
+++ b/app/page.tsx
--- a/app/page.tsx
+++ b/app/page.tsx
`;
      const paths = extractPathsFromDiff(diff);
      const pageCount = paths.filter(p => p === "app/page.tsx").length;
      expect(pageCount).toBe(1);
    });
  });

  describe("validatePatchPaths", () => {
    it("should validate valid patch", () => {
      const diff = `--- /dev/null
+++ b/lib/newFile.ts
@@ -0,0 +1,5 @@
+export function foo() {}
`;
      const result = validatePatchPaths(diff);
      expect(result.valid).toBe(true);
    });

    it("should reject patch with src/ paths", () => {
      const diff = `--- /dev/null
+++ b/src/utils.ts
@@ -0,0 +1,5 @@
+export function foo() {}
`;
      const result = validatePatchPaths(diff);
      expect(result.valid).toBe(false);
      expect(result.violations[0].path).toBe("src/utils.ts");
    });
  });

  describe("validateDiffPaths", () => {
    it("should validate both filesTouched and diff content", () => {
      const diffObj: CodeCheckDiff = {
        taskId: "1",
        filesTouched: ["src/bad.ts"],
        diff: `--- /dev/null
+++ b/app/good.ts
@@ -0,0 +1 @@
+test
`,
      };
      const result = validateDiffPaths(diffObj);
      expect(result.valid).toBe(false);
      expect(result.violations.some(v => v.path === "src/bad.ts")).toBe(true);
    });
  });

  describe("hasPathTraversal", () => {
    it("should detect path traversal", () => {
      expect(hasPathTraversal("../secrets.env")).toBe(true);
      expect(hasPathTraversal("foo/../bar.ts")).toBe(true);
      expect(hasPathTraversal("../../etc/passwd")).toBe(true);
    });

    it("should allow normal paths", () => {
      expect(hasPathTraversal("lib/utils.ts")).toBe(false);
      expect(hasPathTraversal("app/api/route.ts")).toBe(false);
    });
  });

  describe("isReadOnlyRootFile", () => {
    it("should identify read-only root files", () => {
      expect(isReadOnlyRootFile("package.json")).toBe(true);
      expect(isReadOnlyRootFile("tsconfig.json")).toBe(true);
      expect(isReadOnlyRootFile("next.config.js")).toBe(true);
    });

    it("should not flag non-root files", () => {
      expect(isReadOnlyRootFile("lib/utils.ts")).toBe(false);
    });
  });

  describe("validatePath - path traversal", () => {
    it("should reject path traversal attempts", () => {
      const result = validatePath("../secrets.env");
      expect(result).not.toBeNull();
      expect(result?.reason).toContain("Path traversal");
    });
  });

  describe("validatePath - additional forbidden", () => {
    it("should reject node_modules/", () => {
      const result = validatePath("node_modules/some-package/index.js");
      expect(result).not.toBeNull();
      expect(result?.reason).toContain("node_modules/");
    });

    it("should reject .next/", () => {
      const result = validatePath(".next/server/pages.js");
      expect(result).not.toBeNull();
      expect(result?.reason).toContain(".next/");
    });

    it("should reject .git/", () => {
      const result = validatePath(".git/config");
      expect(result).not.toBeNull();
      expect(result?.reason).toContain(".git/");
    });
  });

  describe("validatePathForPatching", () => {
    it("should reject read-only root files", () => {
      const result = validatePathForPatching("package.json");
      expect(result).not.toBeNull();
      expect(result?.reason).toContain("read-only");
    });

    it("should allow patchable paths", () => {
      expect(validatePathForPatching("lib/utils.ts")).toBeNull();
      expect(validatePathForPatching("app/api/route.ts")).toBeNull();
    });
  });

  describe("validatePlanPatchIntegrity", () => {
    it("should pass when all patch paths are in plan", () => {
      const filePlan: CodeCheckFilePlanEntry[] = [
        { path: "lib/utils.ts", purpose: "Utils", action: "modify" },
      ];
      const diff = `--- a/lib/utils.ts
+++ b/lib/utils.ts
@@ -1,1 +1,1 @@
`;
      const result = validatePlanPatchIntegrity(filePlan, diff);
      expect(result.valid).toBe(true);
    });

    it("should fail when patch path not in plan", () => {
      const filePlan: CodeCheckFilePlanEntry[] = [
        { path: "lib/utils.ts", purpose: "Utils", action: "modify" },
      ];
      const diff = `--- a/lib/other.ts
+++ b/lib/other.ts
@@ -1,1 +1,1 @@
`;
      const result = validatePlanPatchIntegrity(filePlan, diff);
      expect(result.valid).toBe(false);
      expect(result.missingFromPlan).toContain("lib/other.ts");
    });

    it("should fail for create action with invalid path", () => {
      const filePlan: CodeCheckFilePlanEntry[] = [
        { path: "src/utils.ts", purpose: "Utils", action: "create" },
      ];
      const result = validatePlanPatchIntegrity(filePlan, "");
      expect(result.valid).toBe(false);
      expect(result.invalidCreatePaths.length).toBeGreaterThan(0);
    });
  });

  describe("buildPathValidationError", () => {
    it("should build structured error with hint", () => {
      const pathResult = {
        valid: false,
        violations: [{ path: "src/utils.ts", reason: "forbidden" }],
        message: "test",
      };
      const error = buildPathValidationError(pathResult);
      expect(error.code).toBe("invalid_file_paths");
      expect(error.hint).toBe(PATH_ERROR_HINT);
      expect(error.details.length).toBeGreaterThan(0);
    });
  });

  describe("Constants", () => {
    it("should have app in allowed directories", () => {
      expect(ALLOWED_TOP_LEVEL_DIRS).toContain("app");
    });

    it("should have src in forbidden prefixes", () => {
      expect(FORBIDDEN_PREFIXES).toContain("src/");
    });

    it("should have node_modules in forbidden prefixes", () => {
      expect(FORBIDDEN_PREFIXES).toContain("node_modules/");
    });

    it("should have PATH_ERROR_HINT defined", () => {
      expect(PATH_ERROR_HINT).toContain("lib/firestore/sanitize.ts");
    });
  });
});
