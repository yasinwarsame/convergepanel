/**
 * API error envelope (PRD §9.5). One shape for every data-plane and management-plane error:
 * `{ error: { type, code, message, param, request_id, doc_url } }`, with `X-Request-Id` and no-store.
 * Messages are fixed strings per code: no provider text, stack, key material or internal detail.
 */
export type ApiErrorType =
  | "invalid_request_error"
  | "authentication_error"
  | "permission_error"
  | "not_found"
  | "rate_limit_error"
  | "api_error"
  | "service_unavailable";

interface ErrorSpec {
  readonly status: number;
  readonly type: ApiErrorType;
  readonly message: string;
}

/** The API-1 subset of PRD §9.5. Later stages add codes here (reviewed). */
export const API_ERRORS = Object.freeze({
  invalid_api_key: { status: 401, type: "authentication_error", message: "The API key is invalid." },
  api_key_not_accepted: { status: 401, type: "authentication_error", message: "API keys are not accepted on this endpoint." },
  session_required: { status: 401, type: "authentication_error", message: "A signed-in session is required." },
  insufficient_scope: { status: 403, type: "permission_error", message: "The API key does not have the required scope." },
  org_suspended: { status: 403, type: "permission_error", message: "The organization is suspended." },
  live_key_requires_plan: { status: 403, type: "permission_error", message: "Live keys require an active API plan." },
  insufficient_role: { status: 403, type: "permission_error", message: "Your organization role does not allow this action." },
  fresh_session_required: { status: 403, type: "permission_error", message: "Sign in again to perform this action." },
  identity_not_verified: { status: 403, type: "permission_error", message: "Verify your email address to perform this action." },
  not_found: { status: 404, type: "not_found", message: "Not found." },
  invalid_request: { status: 400, type: "invalid_request_error", message: "The request is invalid." },
  internal_error: { status: 500, type: "api_error", message: "An internal error occurred." },
  api_unavailable: { status: 503, type: "service_unavailable", message: "The API is temporarily unavailable." },
} as const satisfies Record<string, ErrorSpec>);

export type ApiErrorCode = keyof typeof API_ERRORS;

export interface ApiErrorBody {
  error: {
    type: ApiErrorType;
    code: ApiErrorCode;
    message: string;
    param: string | null;
    request_id: string;
    doc_url: string;
  };
}

export const DOC_BASE = "https://docs.convergepanel.com/errors#";

export function apiErrorBody(code: ApiErrorCode, requestId: string, param: string | null = null): ApiErrorBody {
  const spec = API_ERRORS[code];
  return { error: { type: spec.type, code, message: spec.message, param, request_id: requestId, doc_url: `${DOC_BASE}${code}` } };
}

export function apiErrorResponse(code: ApiErrorCode, requestId: string, param: string | null = null): Response {
  return new Response(JSON.stringify(apiErrorBody(code, requestId, param)), {
    status: API_ERRORS[code].status,
    headers: { "content-type": "application/json", "cache-control": "no-store", "x-request-id": requestId },
  });
}
