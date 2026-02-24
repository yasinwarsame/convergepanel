/**
 * CodeCheck API Route
 * 
 * Single endpoint handling all CodeCheck actions:
 * - plan: Generate spec + task list from requirements
 * - implement: Generate unified diff for a task
 * - verify: Analyze logs and suggest fixes
 * 
 * Authentication required (uses existing session cookie / Bearer token pattern).
 */

import { NextRequest, NextResponse } from "next/server";
import { verifySessionCookie } from "@/lib/firebase/auth-helpers";
import { verifyIdToken } from "@/lib/firebase/auth";
import { ANTHROPIC_API_KEY } from "@/lib/env";
import { readFileSync, existsSync } from "fs";
import path from "path";
import {
  CodeCheckApiRequest,
  CodeCheckApiResponse,
  CodeCheckIntake,
  CodeCheckImplementRequest,
  CodeCheckVerifyRequest,
  CodeCheckMultiModel,
} from "@/lib/codecheck/types";
import {
  runPlanner,
  runImplementer,
  runVerifier,
  runClaudeReview,
  CODECHECK_MODEL_ID,
  didLastCallUseFallback,
} from "@/lib/codecheck/orchestrate";
import {
  validateSpecPaths,
  validateDiffPaths,
  validatePlanPatchIntegrity,
  buildPathValidationError,
  autoCorrectSpecPaths,
  autoCorrectDiffPaths,
  PATH_ERROR_HINT,
} from "@/lib/codecheck/pathValidation";
import { enforceDependencyPolicy, enforceSensitiveFilePolicy } from "@/lib/codecheck/patchPolicies";
import { createImplementEvidence, createVerifyEvidence } from "@/lib/codecheck/evidence";
import { buildRepoContext } from "@/lib/codecheck/repoContext";

// Ensure Node.js runtime (required for Firebase Admin)
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Check if we're in development mode for detailed logging
const IS_DEV = process.env.NODE_ENV === "development";

// Project root directory for auto-reading files
const PROJECT_ROOT = process.cwd();

/**
 * Auto-read files from the project filesystem.
 * Cleans up model-generated path strings ("paste the content of X" → "X").
 * Only reads files that exist and are within the project root.
 */
function autoReadProjectFiles(
  requestedPaths: string[],
  existingContents: Array<{ path: string; content: string }>
): Array<{ path: string; content: string }> {
  const alreadyProvided = new Set(existingContents.map((f) => f.path));
  const result = [...existingContents];

  for (const raw of requestedPaths) {
    // Clean up model output like "paste the content of app/api/echo/route.ts"
    const cleanPath = raw
      .replace(/^paste\s+(the\s+)?content\s+of\s+/i, "")
      .replace(/\s*\(.*\)\s*$/, "")
      .trim();

    if (!cleanPath || alreadyProvided.has(cleanPath)) continue;

    // Security: only allow reading within project root, no path traversal
    const fullPath = path.resolve(PROJECT_ROOT, cleanPath);
    if (!fullPath.startsWith(PROJECT_ROOT)) {
      if (IS_DEV) console.warn("[CodeCheck] Skipping path outside project:", cleanPath);
      continue;
    }

    try {
      if (existsSync(fullPath)) {
        const content = readFileSync(fullPath, "utf-8");
        result.push({ path: cleanPath, content });
        alreadyProvided.add(cleanPath);
        if (IS_DEV) console.log(`[CodeCheck] Auto-read file: ${cleanPath} (${content.length} chars)`);
      } else {
        if (IS_DEV) console.log(`[CodeCheck] File not found, skipping: ${cleanPath}`);
      }
    } catch (err) {
      if (IS_DEV) console.warn(`[CodeCheck] Failed to read ${cleanPath}:`, err);
    }
  }

  return result;
}

/**
 * POST /api/codecheck
 * 
 * Request body:
 * {
 *   action: "plan" | "implement" | "verify",
 *   intake?: CodeCheckIntake,        // for "plan"
 *   implementRequest?: {...},        // for "implement"
 *   verifyRequest?: {...}            // for "verify"
 * }
 */
export async function POST(req: NextRequest): Promise<NextResponse<CodeCheckApiResponse>> {
  try {
    // ============================================
    // AUTHENTICATION
    // ============================================
    
    let uid: string;
    try {
      const auth = await verifySessionCookie(req);
      
      if (auth) {
        uid = auth.uid;
      } else {
        // Fallback to Bearer token
        const authHeader = req.headers.get("authorization");
        if (!authHeader?.startsWith("Bearer ")) {
          return NextResponse.json(
            {
              ok: false,
              error: {
                code: "unauthorized",
                message: "Please sign in to use CodeCheck.",
              },
            },
            { status: 401 }
          );
        }
        const token = authHeader.split("Bearer ")[1];
        const decodedToken = await verifyIdToken(token);
        uid = decodedToken.uid;
      }
    } catch (authError) {
      console.error("[CodeCheck API] Auth error:", authError);
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: "unauthorized",
            message: "Authentication failed. Please sign in again.",
          },
        },
        { status: 401 }
      );
    }

    // ============================================
    // CHECK API KEY
    // ============================================
    
    if (!ANTHROPIC_API_KEY) {
      console.error("[CodeCheck API] ANTHROPIC_API_KEY not configured");
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: "config_error",
            message: "CodeCheck is not configured. Please contact support.",
          },
        },
        { status: 500 }
      );
    }

    // ============================================
    // PARSE REQUEST
    // ============================================
    
    let body: CodeCheckApiRequest;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: "invalid_request",
            message: "Invalid JSON in request body.",
          },
        },
        { status: 400 }
      );
    }

    const { action } = body;

    if (!action || !["plan", "implement", "verify"].includes(action)) {
      return NextResponse.json(
        {
          ok: false,
          error: {
            code: "invalid_action",
            message: "Action must be one of: plan, implement, verify.",
          },
        },
        { status: 400 }
      );
    }

    // ============================================
    // HANDLE ACTIONS
    // ============================================

    console.log(`[CodeCheck API] User ${uid} requested action: ${action}`);

    switch (action) {
      case "plan": {
        const intake = body.intake;
        if (!intake || !isValidIntake(intake)) {
          return NextResponse.json(
            {
              ok: false,
              error: {
                code: "invalid_intake",
                message: "Missing or invalid intake data. Required: requirements, stack, constraints.",
              },
            },
            { status: 400 }
          );
        }

        let result = await runPlanner(intake, ANTHROPIC_API_KEY);

        if (!result.ok) {
          const httpStatus = mapProviderErrorToStatus(result.error);
          return NextResponse.json(
            {
              ok: false,
              error: {
                code: extractProviderCode(result.error) || "planner_error",
                message: result.error || "Planner failed to generate spec.",
              },
            },
            { status: httpStatus }
          );
        }

        // Check that parsed output exists (JSON parsing may have failed)
        if (!result.parsed) {
          console.error("[CodeCheck API] Planner returned invalid JSON. Raw content:", result.content?.substring(0, 500));
          return NextResponse.json(
            {
              ok: false,
              error: {
                code: "planner_parse_error",
                message: "Planner response could not be parsed. The model may have returned invalid JSON.",
              },
            },
            { status: 500 }
          );
        }

        // ============================================
        // PATH VALIDATION - Auto-correct invalid paths (e.g. tests/ → lib/__tests__/)
        // ============================================
        let specForValidation = result.parsed as CodeCheckApiResponse["spec"];
        if (specForValidation) {
          const pathValidation = validateSpecPaths(specForValidation);
          if (!pathValidation.valid) {
            if (IS_DEV) {
              console.warn("[CodeCheck API] Planner proposed invalid paths, auto-correcting:", pathValidation.message);
            }
            // Auto-correct the paths using suggestions
            const correctedSpec = autoCorrectSpecPaths(specForValidation, pathValidation.violations);

            // Validate the corrected spec
            const recheck = validateSpecPaths(correctedSpec);
            if (recheck.valid) {
              // Apply the corrected spec
              result = { ...result, parsed: correctedSpec };
              specForValidation = correctedSpec;
              if (IS_DEV) {
                console.log("[CodeCheck API] Planner paths auto-corrected successfully");
              }
            } else {
              // Corrections weren't enough — return error to user
              console.error("[CodeCheck API] Planner paths still invalid after auto-correction:", recheck.message);
              const errorInfo = buildPathValidationError(recheck);
              return NextResponse.json(
                {
                  ok: false,
                  error: {
                    code: errorInfo.code,
                    message: errorInfo.message,
                    details: errorInfo.details,
                    hint: errorInfo.hint,
                  },
                },
                { status: 400 }
              );
            }
          }
        }

        // Build multi-model result
        const multiModel: CodeCheckMultiModel = {
          primary: {
            model: CODECHECK_MODEL_ID,
            latencyMs: result.latencyMs,
          },
        };

        // Run Claude Opus review on the plan (non-blocking - don't fail if review fails)
        try {
          const planSummary = JSON.stringify(result.parsed, null, 2);
          const claudeReview = await runClaudeReview(
            intake.requirements,
            planSummary,
            `Stack: ${intake.stack}\nConstraints: ${intake.constraints}`,
            ANTHROPIC_API_KEY
          );

          if (claudeReview.ok && claudeReview.review) {
            multiModel.claudeReview = claudeReview.review;
          } else {
            multiModel.claudeReviewSkipped = claudeReview.error || "Claude review unavailable";
            console.log("[codecheck] Claude review skipped:", claudeReview.error);
          }
        } catch (reviewError) {
          console.error("[codecheck] Claude review failed:", reviewError);
          multiModel.claudeReviewSkipped = "Claude review failed unexpectedly";
        }

        return NextResponse.json({
          ok: true,
          spec: result.parsed as CodeCheckApiResponse["spec"],
          multiModel,
        });
      }

      case "implement": {
        const implementRequest = body.implementRequest;
        
        // Detailed validation with specific error messages
        const validation = validateImplementRequestDetailed(implementRequest);
        if (!validation.valid) {
          if (IS_DEV) {
            console.log("[CodeCheck API] Implement validation failed:", {
              hasImplementRequest: !!implementRequest,
              hasTask: !!implementRequest?.task,
              hasFileContents: !!implementRequest?.fileContents,
              missing: validation.missing,
            });
          }
          return NextResponse.json(
            {
              ok: false,
              error: {
                code: "invalid_implement_request",
                message: validation.message,
              },
            },
            { status: 400 }
          );
        }

        // At this point, implementRequest is guaranteed valid
        let validatedRequest = implementRequest as CodeCheckImplementRequest;

        // Diagnostic logging (dev only, no sensitive data)
        if (IS_DEV) {
          console.log("[CodeCheck API] Implement request validated:", {
            taskId: validatedRequest.task.id,
            taskGoal: validatedRequest.task.goal.substring(0, 50),
            filesTouched: validatedRequest.task.filesTouched.length,
            fileContentsProvided: validatedRequest.fileContents.length,
            hasVerificationCommands: validatedRequest.task.verificationCommands?.length > 0,
            priorTasksCount: validatedRequest.priorTasks?.length ?? 0,
            priorTaskIds: validatedRequest.priorTasks?.map(pt => pt.taskId) ?? [],
          });
        }

        // ============================================
        // PRE-READ: Auto-read filesTouched from project so the
        // implementer has context without needing a round-trip
        // ============================================
        const preReadFiles = autoReadProjectFiles(
          validatedRequest.task.filesTouched,
          validatedRequest.fileContents
        );
        if (preReadFiles.length > validatedRequest.fileContents.length) {
          const autoCount = preReadFiles.length - validatedRequest.fileContents.length;
          if (IS_DEV) {
            console.log(`[CodeCheck] Pre-read ${autoCount} file(s) from filesTouched`);
          }
          validatedRequest = { ...validatedRequest, fileContents: preReadFiles };
        }

        try {
          let result = await runImplementer(validatedRequest, ANTHROPIC_API_KEY);

          if (!result.ok) {
            const httpStatus = mapProviderErrorToStatus(result.error);
            return NextResponse.json(
              {
                ok: false,
                error: {
                  code: extractProviderCode(result.error) || "implementer_error",
                  message: result.error || "Implementer failed to generate diff.",
                },
              },
              { status: httpStatus }
            );
          }

          // Check that parsed output exists (JSON parsing may have failed)
          if (!result.parsed) {
            console.error("[CodeCheck API] Implementer returned invalid JSON. Raw content:", result.content?.substring(0, 500));
            return NextResponse.json(
              {
                ok: false,
                error: {
                  code: "implementer_parse_error",
                  message: "Implementer response could not be parsed. The model may have returned invalid JSON.",
                },
              },
              { status: 500 }
            );
          }

          // ============================================
          // AUTO-READ FILES: If implementer needs more files, read them
          // from the project filesystem and retry automatically
          // ============================================
          const parsedDiff = result.parsed as CodeCheckApiResponse["diff"];
          if (
            parsedDiff?.needsMoreFiles &&
            parsedDiff.needsMoreFiles.length > 0 &&
            (!parsedDiff.diff || parsedDiff.diff.trim().length === 0)
          ) {
            if (IS_DEV) {
              console.log("[CodeCheck] Implementer needs files:", parsedDiff.needsMoreFiles);
            }

            // Auto-read the requested files from the project
            const enrichedFiles = autoReadProjectFiles(
              parsedDiff.needsMoreFiles,
              validatedRequest.fileContents
            );

            const newFilesCount = enrichedFiles.length - validatedRequest.fileContents.length;
            if (newFilesCount > 0) {
              if (IS_DEV) {
                console.log(`[CodeCheck] Auto-read ${newFilesCount} file(s), retrying implementer...`);
              }

              // Retry with enriched file contents
              const retryRequest: CodeCheckImplementRequest = {
                ...validatedRequest,
                fileContents: enrichedFiles,
              };

              const retryResult = await runImplementer(retryRequest, ANTHROPIC_API_KEY);

              if (retryResult.ok && retryResult.parsed) {
                result = retryResult;
                if (IS_DEV) {
                  console.log("[CodeCheck] Retry succeeded with auto-read files");
                }
              } else {
                if (IS_DEV) {
                  console.warn("[CodeCheck] Retry with auto-read files failed:", retryResult.error);
                }
                // Fall through with original result
              }
            }
          }

          // ============================================
          // PATH VALIDATION - Auto-correct patches with invalid paths (e.g. tests/ → lib/__tests__/)
          // ============================================
          const diffForValidation = result.parsed as CodeCheckApiResponse["diff"];
          if (diffForValidation) {
            const pathValidation = validateDiffPaths(diffForValidation);
            if (!pathValidation.valid) {
              if (IS_DEV) {
                console.warn("[CodeCheck API] Implementer proposed invalid paths, auto-correcting:", pathValidation.message);
              }
              // Auto-correct the paths using suggestions
              const correctedDiff = autoCorrectDiffPaths(diffForValidation, pathValidation.violations);

              // Validate the corrected diff
              const recheck = validateDiffPaths(correctedDiff);
              if (recheck.valid) {
                // Apply the corrected diff
                result = { ...result, parsed: correctedDiff };
                if (IS_DEV) {
                  console.log("[CodeCheck API] Implementer paths auto-corrected successfully");
                }
              } else {
                // Corrections weren't enough — return error to user
                console.error("[CodeCheck API] Implementer paths still invalid after auto-correction:", recheck.message);
                const errorInfo = buildPathValidationError(recheck);
                return NextResponse.json(
                  {
                    ok: false,
                    error: {
                      code: errorInfo.code,
                      message: errorInfo.message,
                      details: errorInfo.details,
                      hint: errorInfo.hint,
                    },
                  },
                  { status: 400 }
                );
              }
            }
          }

          // ============================================
          // DEPENDENCY POLICY - Reject diffs touching package.json/lockfiles
          // ============================================
          const finalDiff = result.parsed as CodeCheckApiResponse["diff"];
          if (finalDiff?.diff) {
            const depViolation = enforceDependencyPolicy(
              finalDiff.diff,
              validatedRequest.task.acceptanceCriteria,
              validatedRequest.task.goal
            );
            if (depViolation) {
              if (IS_DEV) {
                console.warn("[CodeCheck API] Dependency policy violation:", depViolation.touchedFiles);
              }
              return NextResponse.json(
                {
                  ok: false,
                  error: {
                    code: "dependency_policy_violation",
                    message: "Patch attempts to modify dependency files",
                    details: depViolation.touchedFiles,
                    hint: "Ask CodeCheck to avoid dependency changes or explicitly allow it by adding [ALLOW_DEPS] to acceptance criteria.",
                  },
                },
                { status: 400 }
              );
            }

            // ============================================
            // SENSITIVE FILE POLICY - Reject diffs touching auth/env/payment files
            // ============================================
            const sensitiveViolation = enforceSensitiveFilePolicy(
              finalDiff.diff,
              validatedRequest.task.acceptanceCriteria,
              validatedRequest.task.goal
            );
            if (sensitiveViolation) {
              if (IS_DEV) {
                console.warn("[CodeCheck API] Sensitive file policy violation:", sensitiveViolation.touchedFiles);
              }
              return NextResponse.json(
                {
                  ok: false,
                  error: {
                    code: "sensitive_file_policy_violation",
                    message: "Patch attempts to modify sensitive files",
                    details: sensitiveViolation.touchedFiles,
                    hint: "Add [ALLOW_SENSITIVE] to acceptance criteria or explicitly mention modifying these files in your constraints.",
                  },
                },
                { status: 400 }
              );
            }
          }

          // ============================================
          // EVIDENCE BUNDLE - Create evidence record for this implementation
          // ============================================
          let evidenceId: string | undefined;
          try {
            const repoCtx = buildRepoContext();
            evidenceId = createImplementEvidence({
              userId: uid,
              taskId: validatedRequest.task.id,
              diff: finalDiff?.diff || "",
              repoSha: repoCtx.repoSha,
              verificationCommands: validatedRequest.task.verificationCommands || [],
              provider: {
                primaryModel: CODECHECK_MODEL_ID,
                fallbackUsed: didLastCallUseFallback(),
                latencyMs: result.latencyMs,
              },
            });
            if (IS_DEV) {
              console.log(`[CodeCheck] Evidence stored: ${evidenceId}`);
            }
          } catch (evidenceErr) {
            console.warn("[CodeCheck] Evidence storage failed (non-blocking):", evidenceErr);
          }

          // Build multi-model result
          const multiModel: CodeCheckMultiModel = {
            primary: {
              model: CODECHECK_MODEL_ID,
              latencyMs: result.latencyMs,
            },
          };

          // Run Claude Opus review on the generated diff (non-blocking)
          try {
            const diffContent = finalDiff?.diff || "";
            const claudeReview = await runClaudeReview(
              validatedRequest.task.goal,
              diffContent,
              `Task: ${validatedRequest.task.goal}\nFiles: ${validatedRequest.task.filesTouched.join(", ")}\nAcceptance Criteria: ${validatedRequest.task.acceptanceCriteria.join("; ")}`,
              ANTHROPIC_API_KEY
            );

            if (claudeReview.ok && claudeReview.review) {
              multiModel.claudeReview = claudeReview.review;
            } else {
              multiModel.claudeReviewSkipped = claudeReview.error || "Claude review unavailable";
              console.log("[codecheck] Claude review skipped:", claudeReview.error);
            }
          } catch (reviewError) {
            console.error("[codecheck] Claude review failed:", reviewError);
            multiModel.claudeReviewSkipped = "Claude review failed unexpectedly";
          }

          return NextResponse.json({
            ok: true,
            diff: result.parsed as CodeCheckApiResponse["diff"],
            multiModel,
            evidenceId,
          });
        } catch (implementError) {
          console.error("[CodeCheck API] Implement action threw:", implementError);
          return NextResponse.json(
            {
              ok: false,
              error: {
                code: "implement_failed",
                message: "Implement step failed unexpectedly.",
                ...(IS_DEV && implementError instanceof Error && { details: [implementError.message] }),
              },
            },
            { status: 500 }
          );
        }
      }

      case "verify": {
        const verifyRequest = body.verifyRequest;
        if (!verifyRequest || !isValidVerifyRequest(verifyRequest)) {
          return NextResponse.json(
            {
              ok: false,
              error: {
                code: "invalid_verify_request",
                message: "Missing or invalid verify request. Required: taskId.",
              },
            },
            { status: 400 }
          );
        }

        // Validate that at least one log output is provided
        const hasAnyLogs = 
          (verifyRequest.buildOutput && verifyRequest.buildOutput.trim().length > 0) ||
          (verifyRequest.tscOutput && verifyRequest.tscOutput.trim().length > 0) ||
          (verifyRequest.testOutput && verifyRequest.testOutput.trim().length > 0);

        if (!hasAnyLogs) {
          return NextResponse.json(
            {
              ok: false,
              error: {
                code: "no_logs_provided",
                message: "No verification logs provided. Please run your verification commands (npm run build, npx tsc --noEmit, or npm test) and paste the output.",
              },
            },
            { status: 400 }
          );
        }

        const result = await runVerifier(verifyRequest, ANTHROPIC_API_KEY);

        if (!result.ok) {
          const httpStatus = mapProviderErrorToStatus(result.error);
          return NextResponse.json(
            {
              ok: false,
              error: {
                code: extractProviderCode(result.error) || "verifier_error",
                message: result.error || "Verifier failed to analyze logs.",
              },
            },
            { status: httpStatus }
          );
        }

        // Check that parsed output exists (JSON parsing may have failed)
        if (!result.parsed) {
          console.error("[CodeCheck API] Verifier returned invalid JSON. Raw content:", result.content?.substring(0, 500));
          
          // Try to extract a helpful message from the raw content
          let helpfulMessage = "The verifier could not analyze your logs. ";
          
          if (result.content) {
            // Check if the model is asking for more information
            const lowerContent = result.content.toLowerCase();
            if (lowerContent.includes("need") && lowerContent.includes("more")) {
              helpfulMessage += "The AI needs more context. Please ensure you've pasted the complete build or TypeScript output.";
            } else if (lowerContent.includes("error") || lowerContent.includes("fail")) {
              helpfulMessage += "There may be an issue with the log format. Please paste the raw terminal output from your verification command.";
            } else {
              helpfulMessage += "Please try again with the full output from 'npm run build' or 'npx tsc --noEmit'.";
            }
          } else {
            helpfulMessage += "The AI returned an empty response. Please try again.";
          }

          return NextResponse.json(
            {
              ok: false,
              error: {
                code: "verifier_parse_error",
                message: helpfulMessage,
              },
            },
            { status: 500 }
          );
        }

        // ============================================
        // EVIDENCE BUNDLE - Create evidence record for verification
        // ============================================
        let verifyEvidenceId: string | undefined;
        try {
          const repoCtx = buildRepoContext();
          verifyEvidenceId = createVerifyEvidence({
            userId: uid,
            taskId: verifyRequest.taskId,
            repoSha: repoCtx.repoSha,
            verificationCommands: verifyRequest.verificationCommands ?? [],
            logs: {
              buildOutput: verifyRequest.buildOutput,
              tscOutput: verifyRequest.tscOutput,
              testOutput: verifyRequest.testOutput,
            },
            provider: {
              primaryModel: CODECHECK_MODEL_ID,
              fallbackUsed: didLastCallUseFallback(),
              latencyMs: result.latencyMs,
            },
          });
          if (IS_DEV) {
            console.log(`[CodeCheck] Verify evidence stored: ${verifyEvidenceId}`);
          }
        } catch (evidenceErr) {
          console.warn("[CodeCheck] Verify evidence storage failed (non-blocking):", evidenceErr);
        }

        return NextResponse.json({
          ok: true,
          verification: result.parsed as CodeCheckApiResponse["verification"],
          evidenceId: verifyEvidenceId,
        });
      }

      default:
        // TypeScript exhaustiveness check
        const _exhaustive: never = action;
        return _exhaustive;
    }
  } catch (error) {
    console.error("[CodeCheck API] Unexpected error:", error);
    return NextResponse.json(
      {
        ok: false,
        error: {
          code: "internal_error",
          message: "An unexpected error occurred. Please try again.",
        },
      },
      { status: 500 }
    );
  }
}

// ============================================
// VALIDATION HELPERS
// ============================================

function isValidIntake(intake: unknown): intake is CodeCheckIntake {
  if (!intake || typeof intake !== "object") return false;
  const obj = intake as Record<string, unknown>;
  return (
    typeof obj.requirements === "string" &&
    obj.requirements.trim().length > 0 &&
    typeof obj.stack === "string" &&
    obj.stack.trim().length > 0 &&
    typeof obj.constraints === "string"
  );
}

/**
 * Detailed validation for implement request with specific error messages
 */
function validateImplementRequestDetailed(req: unknown): { valid: boolean; message: string; missing?: string[] } {
  const missing: string[] = [];

  if (!req || typeof req !== "object") {
    return { valid: false, message: "implementRequest is missing or not an object", missing: ["implementRequest"] };
  }

  const obj = req as Record<string, unknown>;

  // Check task exists
  if (!obj.task) {
    missing.push("task");
  } else if (typeof obj.task !== "object") {
    return { valid: false, message: "task must be an object", missing: ["task"] };
  } else {
    const task = obj.task as Record<string, unknown>;

    // Validate task fields
    if (typeof task.id !== "string" || !task.id.trim()) {
      missing.push("task.id");
    }
    if (typeof task.goal !== "string" || !task.goal.trim()) {
      missing.push("task.goal");
    }
    if (!Array.isArray(task.filesTouched)) {
      missing.push("task.filesTouched");
    }
    if (!Array.isArray(task.acceptanceCriteria)) {
      missing.push("task.acceptanceCriteria");
    }
    if (!Array.isArray(task.verificationCommands)) {
      missing.push("task.verificationCommands");
    }
  }

  // Check fileContents (can be empty array for new file tasks)
  if (!Array.isArray(obj.fileContents)) {
    missing.push("fileContents");
  } else {
    // Validate each file content entry
    const fileContents = obj.fileContents as unknown[];
    for (let i = 0; i < fileContents.length; i++) {
      const fc = fileContents[i];
      if (!fc || typeof fc !== "object") {
        missing.push(`fileContents[${i}]`);
        continue;
      }
      const fcObj = fc as Record<string, unknown>;
      if (typeof fcObj.path !== "string") {
        missing.push(`fileContents[${i}].path`);
      }
      if (typeof fcObj.content !== "string") {
        missing.push(`fileContents[${i}].content`);
      }
    }
  }

  // Validate priorTasks if provided (optional, but must be well-formed if present)
  if (obj.priorTasks !== undefined) {
    if (!Array.isArray(obj.priorTasks)) {
      missing.push("priorTasks (must be array)");
    } else {
      const priorTasks = obj.priorTasks as unknown[];
      for (let i = 0; i < priorTasks.length; i++) {
        const pt = priorTasks[i];
        if (!pt || typeof pt !== "object") {
          missing.push(`priorTasks[${i}]`);
          continue;
        }
        const ptObj = pt as Record<string, unknown>;
        // v is required (currently must be 1); allows schema evolution
        if (ptObj.v !== 1) missing.push(`priorTasks[${i}].v (must be 1)`);
        if (typeof ptObj.taskId !== "string") missing.push(`priorTasks[${i}].taskId`);
        if (typeof ptObj.goal !== "string") missing.push(`priorTasks[${i}].goal`);
        if (!Array.isArray(ptObj.filesTouched)) missing.push(`priorTasks[${i}].filesTouched`);
        if (typeof ptObj.diff !== "string") missing.push(`priorTasks[${i}].diff`);
      }
    }
  }

  if (missing.length > 0) {
    return {
      valid: false,
      message: `Missing or invalid fields: ${missing.join(", ")}`,
      missing,
    };
  }

  return { valid: true, message: "Valid" };
}

function isValidVerifyRequest(req: unknown): req is CodeCheckVerifyRequest {
  if (!req || typeof req !== "object") return false;
  const obj = req as Record<string, unknown>;
  return typeof obj.taskId === "string" && obj.taskId.trim().length > 0;
}

/**
 * Map provider error codes embedded in error strings to HTTP status codes.
 */
function mapProviderErrorToStatus(error: string | undefined): number {
  if (!error) return 500;
  if (error.startsWith("provider_forbidden")) return 502;
  if (error.startsWith("provider_rate_limited")) return 503;
  if (error.startsWith("provider_unavailable")) return 503;
  if (error.startsWith("provider_auth")) return 502;
  return 500;
}

function extractProviderCode(error: string | undefined): string | null {
  if (!error) return null;
  const match = error.match(/^(provider_\w+):/);
  return match ? match[1] : null;
}
