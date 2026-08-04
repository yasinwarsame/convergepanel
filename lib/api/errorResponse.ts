/**
 * Standardized Error Response Format
 * 
 * All API routes must return errors in this format for consistent client handling.
 * 
 * Error Response Schema:
 * {
 *   errorCode: string,        // Machine-readable error code (e.g., "RUN_LIMIT_REACHED")
 *   message: string,          // User-friendly error message
 *   requestId?: string,       // Unique request ID for correlation (generated at route entry)
 *   details?: any            // Optional structured details (validation errors, etc.)
 * }
 */

export interface StandardErrorResponse {
  errorCode: string;
  message: string;
  requestId?: string;
  details?: any;
}

/**
 * Create a standardized error response
 * 
 * Ensures all API routes return errors in a consistent format that clients can handle uniformly.
 * 
 * @param errorCode - Machine-readable error code (e.g., "VALIDATION_FAILED", "RUN_LIMIT_REACHED")
 * @param message - User-friendly error message
 * @param requestId - Optional request ID for correlation
 * @param details - Optional structured details (validation errors, etc.)
 * @returns Standardized error response object
 */
export function createErrorResponse(
  errorCode: string,
  message: string,
  requestId?: string,
  details?: any
): StandardErrorResponse {
  const response: StandardErrorResponse = {
    errorCode,
    message,
  };
  
  if (requestId) {
    response.requestId = requestId;
  }
  
  if (details) {
    response.details = details;
  }
  
  return response;
}

/**
 * Common error codes used across API routes
 * 
 * Centralized for consistency - all routes should use these codes.
 */
export const ERROR_CODES = {
  // Client errors (4xx)
  BAD_REQUEST: "BAD_REQUEST",
  UNAUTHORIZED: "UNAUTHORIZED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  RUN_LIMIT_REACHED: "RUN_LIMIT_REACHED",
  MODEL_LIMIT_REACHED: "MODEL_LIMIT_REACHED",
  VALIDATION_FAILED: "VALIDATION_FAILED",
  INVALID_JSON: "INVALID_JSON",
  CLIENT_ABORT: "CLIENT_ABORT",
  RATE_LIMIT_EXCEEDED: "RATE_LIMIT_EXCEEDED",
  REQUEST_TOO_LARGE: "REQUEST_TOO_LARGE",
  EMPTY_MODEL_OUTPUT: "EMPTY_MODEL_OUTPUT",
  /** Query-Routing Redesign, Phase 2A, Step 6 — the run has a valid, persisted Milestone-2 adaptiveOutput; legacy claims-matrix synthesis is not supported for it. */
  ADAPTIVE_RUN_NOT_SUPPORTED: "ADAPTIVE_RUN_NOT_SUPPORTED",
  /** The run's adaptiveOutput marker exists but failed structural validation — never assumed to mean "legacy," fails safe instead. */
  ADAPTIVE_RUN_INVALID: "ADAPTIVE_RUN_INVALID",
  /** The run's adaptiveOutput marker is a version this server doesn't recognize — never assumed to mean "legacy," fails safe instead. */
  ADAPTIVE_RUN_UNSUPPORTED_VERSION: "ADAPTIVE_RUN_UNSUPPORTED_VERSION",

  // Server errors (5xx)
  INTERNAL_ERROR: "INTERNAL_ERROR",
  TIMEOUT: "TIMEOUT",
  NO_CONTENT: "NO_CONTENT",
  OPENAI_API_ERROR: "OPENAI_API_ERROR",
  FIRESTORE_ERROR: "FIRESTORE_ERROR",
  /** Query-Routing Redesign, Phase 2A, Step 6 — the run document could not be read, so whether it has a persisted adaptiveOutput could not be determined. Fails CLOSED (never proceeds to legacy synthesis) rather than assuming absence. */
  RUN_LOOKUP_UNAVAILABLE: "RUN_LOOKUP_UNAVAILABLE",
} as const;

