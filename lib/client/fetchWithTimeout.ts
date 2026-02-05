/**
 * Client-Side Fetch with Timeout and Abort Support
 * 
 * Wrapper around native fetch() that adds:
 * - Automatic timeout handling
 * - AbortController integration
 * - Consistent error handling
 * - Request ID propagation
 * 
 * Used by all client-side API calls to ensure consistent timeout/abort behavior.
 */

/**
 * Normalized error from fetchWithTimeout
 * 
 * All errors are wrapped in this format for consistent handling.
 */
export interface FetchError {
  message: string;
  name: "AbortError" | "TimeoutError" | "NetworkError" | "HttpError";
  statusCode?: number;
  wasAborted: boolean;
  wasTimeout: boolean;
  requestId?: string;
  cause?: unknown;
}

/**
 * Fetch with timeout and abort support
 * 
 * Automatically aborts the request if it exceeds the timeout duration.
 * Properly handles abort signals and distinguishes between timeouts and user aborts.
 * 
 * @param url - Request URL
 * @param options - Fetch options (headers, body, etc.)
 * @param timeoutMs - Timeout in milliseconds (default: 5 minutes for synthesis)
 * @param abortSignal - Optional external AbortSignal (for React component cleanup)
 * @returns Response object
 * @throws FetchError if request fails or times out
 * 
 * @example
 * ```ts
 * const response = await fetchWithTimeout("/api/synthesize-panel", {
 *   method: "POST",
 *   body: JSON.stringify(data),
 * }, 300000); // 5 minute timeout
 * ```
 */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = 300000, // Default: 5 minutes (synthesis can take longer)
  abortSignal?: AbortSignal
): Promise<Response> {
  // Create abort controller for timeout
  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => {
    timeoutController.abort();
  }, timeoutMs);
  
  // Combine external abort signal with timeout signal
  // If external signal aborts, abort the timeout controller too
  if (abortSignal) {
    abortSignal.addEventListener('abort', () => {
      timeoutController.abort();
      clearTimeout(timeoutId);
    });
  }
  
  // Combine signals: abort if either external signal or timeout triggers
  const combinedSignal = abortSignal 
    ? abortSignal
    : timeoutController.signal;
  
  try {
    const response = await fetch(url, {
      ...options,
      signal: combinedSignal,
    });
    
    clearTimeout(timeoutId);
    return response;
  } catch (error: unknown) {
    clearTimeout(timeoutId);
    
    // Normalize error into FetchError format
    const fetchError: FetchError = {
      message: "Request failed",
      name: "NetworkError",
      wasAborted: false,
      wasTimeout: false,
      cause: error,
    };
    
    // Check if it was an abort (timeout or user abort)
    if (error instanceof Error) {
      if (error.name === "AbortError" || error.message.includes("aborted")) {
        const wasTimeout = timeoutController.signal.aborted && !abortSignal?.aborted;
        fetchError.name = wasTimeout ? "TimeoutError" : "AbortError";
        fetchError.wasAborted = true;
        fetchError.wasTimeout = wasTimeout;
        fetchError.message = wasTimeout
          ? `Request timed out after ${timeoutMs}ms`
          : "Request was aborted";
      } else {
        fetchError.message = error.message || "Network request failed";
      }
    }
    
    // If response has status code, it's an HTTP error (not network/abort)
    if (error && typeof error === 'object' && 'status' in error) {
      fetchError.name = "HttpError";
      fetchError.statusCode = (error as { status: number }).status;
      fetchError.message = `HTTP ${fetchError.statusCode}`;
      fetchError.wasAborted = false;
      fetchError.wasTimeout = false;
    }
    
    throw fetchError;
  }
}

