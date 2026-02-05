/**
 * Request Size and Input Validation
 * 
 * Validates request body size and input lengths to prevent abuse and ensure
 * API stability. All limits are conservative to avoid blocking normal usage.
 */

import { NextRequest } from "next/server";

// Request size limits (conservative to avoid blocking normal usage)
export const MAX_REQUEST_BODY_SIZE = 10 * 1024 * 1024; // 10 MB JSON body
export const MAX_QUESTION_LENGTH = 10000; // 10k characters for question
export const MAX_RESULT_TEXT_LENGTH = 500000; // 500k chars per result (per model response)
export const MAX_RESULTS_COUNT = 10; // Max 10 models per run (currently supports up to 5, so 10 is very generous)
export const MAX_CLUSTER_COUNT = 100; // Max 100 agreement clusters

export interface RequestValidationResult {
  valid: boolean;
  errorCode?: string;
  message?: string;
  details?: any;
}

/**
 * Validate request body size
 * 
 * Checks if the request body exceeds maximum allowed size.
 * Note: Next.js limits request body size at the framework level, but we
 * validate earlier for better error messages.
 */
export function validateRequestBodySize(
  body: string | undefined,
  maxSize: number = MAX_REQUEST_BODY_SIZE
): RequestValidationResult {
  if (!body) {
    return { valid: true };
  }

  const sizeInBytes = Buffer.byteLength(body, "utf8");
  
  if (sizeInBytes > maxSize) {
    return {
      valid: false,
      errorCode: "REQUEST_TOO_LARGE",
      message: `Request body exceeds maximum size of ${Math.floor(maxSize / 1024 / 1024)} MB`,
      details: {
        sizeBytes: sizeInBytes,
        maxSizeBytes: maxSize,
      },
    };
  }

  return { valid: true };
}

/**
 * Validate synthesis request inputs
 */
export function validateSynthesisRequest(body: any): RequestValidationResult {
  // Validate question length
  if (body.question && typeof body.question === "string") {
    if (body.question.length > MAX_QUESTION_LENGTH) {
      return {
        valid: false,
        errorCode: "QUESTION_TOO_LONG",
        message: `Question exceeds maximum length of ${MAX_QUESTION_LENGTH} characters`,
        details: {
          length: body.question.length,
          maxLength: MAX_QUESTION_LENGTH,
        },
      };
    }
  }

  // Validate results array
  if (body.results && Array.isArray(body.results)) {
    if (body.results.length > MAX_RESULTS_COUNT) {
      return {
        valid: false,
        errorCode: "TOO_MANY_RESULTS",
        message: `Too many model results. Maximum ${MAX_RESULTS_COUNT} allowed`,
        details: {
          count: body.results.length,
          maxCount: MAX_RESULTS_COUNT,
        },
      };
    }

    // Validate each result's text length
    for (let i = 0; i < body.results.length; i++) {
      const result = body.results[i];
      if (result && result.text && typeof result.text === "string") {
        if (result.text.length > MAX_RESULT_TEXT_LENGTH) {
          return {
            valid: false,
            errorCode: "RESULT_TEXT_TOO_LONG",
            message: `Result text at index ${i} exceeds maximum length of ${MAX_RESULT_TEXT_LENGTH} characters`,
            details: {
              index: i,
              modelId: result.modelId || "unknown",
              length: result.text.length,
              maxLength: MAX_RESULT_TEXT_LENGTH,
            },
          };
        }
      }
    }
  }

  // Validate agreement clusters if provided
  if (body.agreementClusters && Array.isArray(body.agreementClusters)) {
    if (body.agreementClusters.length > MAX_CLUSTER_COUNT) {
      return {
        valid: false,
        errorCode: "TOO_MANY_CLUSTERS",
        message: `Too many agreement clusters. Maximum ${MAX_CLUSTER_COUNT} allowed`,
        details: {
          count: body.agreementClusters.length,
          maxCount: MAX_CLUSTER_COUNT,
        },
      };
    }
  }

  return { valid: true };
}

/**
 * Validate run panel request inputs
 */
export function validateRunPanelRequest(body: any): RequestValidationResult {
  // Validate question length
  if (body.question && typeof body.question === "string") {
    if (body.question.length > MAX_QUESTION_LENGTH) {
      return {
        valid: false,
        errorCode: "QUESTION_TOO_LONG",
        message: `Question exceeds maximum length of ${MAX_QUESTION_LENGTH} characters`,
        details: {
          length: body.question.length,
          maxLength: MAX_QUESTION_LENGTH,
        },
      };
    }
  }

  // Validate selectedModels array
  if (body.selectedModels && Array.isArray(body.selectedModels)) {
    if (body.selectedModels.length > MAX_RESULTS_COUNT) {
      return {
        valid: false,
        errorCode: "TOO_MANY_MODELS",
        message: `Too many models selected. Maximum ${MAX_RESULTS_COUNT} allowed`,
        details: {
          count: body.selectedModels.length,
          maxCount: MAX_RESULTS_COUNT,
        },
      };
    }
  }

  return { valid: true };
}

/**
 * Get request body as string for size validation
 * 
 * This reads the request body without consuming it, for size checking.
 * Note: In Next.js, we can't easily peek at body size before parsing,
 * so we validate after parsing in most cases.
 */
export async function getRequestBodySize(req: NextRequest): Promise<number> {
  try {
    // Clone the request to read body without consuming it
    const clonedReq = req.clone();
    const text = await clonedReq.text();
    return Buffer.byteLength(text, "utf8");
  } catch {
    // If we can't read the body, return 0 (will validate after parsing)
    return 0;
  }
}

