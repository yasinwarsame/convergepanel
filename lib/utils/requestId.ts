/**
 * Request ID Utilities
 * 
 * Generates unique request IDs for tracing requests across client/server boundary.
 * Used for correlating errors in logs and debugging production issues.
 */

import { randomUUID } from 'crypto';

/**
 * Generate a unique request ID for tracing
 * 
 * Uses UUID v4 for guaranteed uniqueness across distributed systems.
 * 
 * @returns UUID string (e.g., "550e8400-e29b-41d4-a716-446655440000")
 */
export function generateRequestId(): string {
  return randomUUID();
}

/**
 * Get or generate request ID from Next.js request
 * 
 * Checks for existing request ID in headers (X-Request-ID),
 * otherwise generates a new one.
 * 
 * @param req - Next.js request object
 * @returns Request ID string
 */
export function getRequestId(req: { headers: Headers }): string {
  const existingId = req.headers.get('x-request-id');
  if (existingId) {
    return existingId;
  }
  return generateRequestId();
}

