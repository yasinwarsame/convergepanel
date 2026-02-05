/**
 * Server-only logger utility with log levels and redaction
 * 
 * Log levels: error, warn, info, debug
 * Controlled by LOG_LEVEL env var (default: "info" in production, "debug" in development)
 * 
 * In production, debug logs are not emitted.
 * Sensitive fields are automatically redacted.
 */

import "server-only";

type LogLevel = "error" | "warn" | "info" | "debug";

const LOG_LEVELS: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

// Determine current log level from env var
const getLogLevel = (): LogLevel => {
  const envLevel = process.env.LOG_LEVEL?.toLowerCase();
  if (envLevel && ["error", "warn", "info", "debug"].includes(envLevel)) {
    return envLevel as LogLevel;
  }
  // Default: debug in development, info in production
  return process.env.NODE_ENV === "production" ? "info" : "debug";
};

const currentLogLevel = getLogLevel();
const currentLevelNum = LOG_LEVELS[currentLogLevel];

/**
 * Redact sensitive fields from objects
 * 
 * Masks:
 * - uid (hash or omit)
 * - stripeSubscriptionId / stripeCustomerId (mask all but last 4)
 * - any field name containing "key", "secret", "token" => "[REDACTED]"
 */
export function redact(obj: any): any {
  if (!obj || typeof obj !== "object") {
    return obj;
  }

  // Handle arrays
  if (Array.isArray(obj)) {
    return obj.map((item) => redact(item));
  }

  // Handle objects
  const redacted: any = {};
  
  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();
    
    // Redact uid (hash it)
    if (key === "uid" || key === "userId" || key === "firebaseUid") {
      if (typeof value === "string" && value.length > 0) {
        // Hash the uid (simple hash, not cryptographic - just for logging)
        const hash = value.split("").reduce((acc, char) => {
          return ((acc << 5) - acc + char.charCodeAt(0)) | 0;
        }, 0);
        redacted[key] = `uid:${Math.abs(hash).toString(16).substring(0, 8)}`;
      } else {
        redacted[key] = "[REDACTED]";
      }
      continue;
    }
    
    // Redact Stripe IDs (mask all but last 4)
    if (key === "stripeSubscriptionId" || key === "stripeCustomerId" || key === "customerId" || key === "subscriptionId") {
      if (typeof value === "string" && value.length > 4) {
        redacted[key] = `****${value.slice(-4)}`;
      } else {
        redacted[key] = "[REDACTED]";
      }
      continue;
    }
    
    // Redact fields containing "key", "secret", "token"
    if (
      lowerKey.includes("key") ||
      lowerKey.includes("secret") ||
      lowerKey.includes("token") ||
      lowerKey.includes("password") ||
      lowerKey.includes("api") && lowerKey.includes("key")
    ) {
      redacted[key] = "[REDACTED]";
      continue;
    }
    
    // Recursively redact nested objects
    if (value && typeof value === "object") {
      redacted[key] = redact(value);
      continue;
    }
    
    // Keep non-sensitive values as-is
    redacted[key] = value;
  }
  
  return redacted;
}

/**
 * Logger interface
 */
class Logger {
  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] <= currentLevelNum;
  }

  error(message: string, data?: any): void {
    if (this.shouldLog("error")) {
      const redactedData = data ? redact(data) : undefined;
      console.error(`[${new Date().toISOString()}] ERROR: ${message}`, redactedData || "");
    }
  }

  warn(message: string, data?: any): void {
    if (this.shouldLog("warn")) {
      const redactedData = data ? redact(data) : undefined;
      console.warn(`[${new Date().toISOString()}] WARN: ${message}`, redactedData || "");
    }
  }

  info(message: string, data?: any): void {
    if (this.shouldLog("info")) {
      const redactedData = data ? redact(data) : undefined;
      console.log(`[${new Date().toISOString()}] INFO: ${message}`, redactedData || "");
    }
  }

  debug(message: string, data?: any): void {
    if (this.shouldLog("debug")) {
      const redactedData = data ? redact(data) : undefined;
      console.debug(`[${new Date().toISOString()}] DEBUG: ${message}`, redactedData || "");
    }
  }
}

// Export singleton logger instance
export const logger = new Logger();
