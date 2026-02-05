/**
 * Performance Instrumentation Utilities
 * 
 * Provides client-side performance tracking for debugging slow loads.
 * Use performance.mark() and performance.measure() to track app lifecycle.
 * 
 * Usage:
 *   import { perf } from '@/lib/utils/performance';
 *   perf.mark('shell_rendered');
 *   perf.measure('time_to_shell', 'app_start', 'shell_rendered');
 */

/**
 * Performance tracking wrapper
 */
export const perf = {
  /**
   * Mark a performance point
   */
  mark(name: string): void {
    if (typeof window !== 'undefined' && 'performance' in window && 'mark' in window.performance) {
      try {
        window.performance.mark(name);
      } catch (e) {
        // Ignore errors in performance tracking
      }
    }
  },

  /**
   * Measure time between two marks
   */
  measure(name: string, startMark: string, endMark: string): PerformanceEntry | null {
    if (typeof window !== 'undefined' && 'performance' in window && 'measure' in window.performance) {
      try {
        window.performance.measure(name, startMark, endMark);
        const entries = window.performance.getEntriesByName(name);
        return entries[entries.length - 1] || null;
      } catch (e) {
        return null;
      }
    }
    return null;
  },

  /**
   * Get measure duration in milliseconds
   */
  getMeasure(name: string): number | null {
    if (typeof window !== 'undefined' && 'performance' in window) {
      try {
        const entries = window.performance.getEntriesByName(name, 'measure');
        if (entries.length > 0) {
          return entries[entries.length - 0].duration;
        }
      } catch (e) {
        // Ignore errors
      }
    }
    return null;
  },

  /**
   * Log performance metrics (dev only)
   */
  logMetrics(): void {
    if (process.env.NODE_ENV !== 'development') return;
    if (typeof window === 'undefined') return;

    try {
      const measures = window.performance.getEntriesByType('measure');
      if (measures.length > 0) {
        console.group('[Performance Metrics]');
        measures.forEach((measure: PerformanceEntry) => {
          if ('duration' in measure) {
            console.log(`${measure.name}: ${measure.duration.toFixed(2)}ms`);
          }
        });
        console.groupEnd();
      }
    } catch (e) {
      // Ignore errors
    }
  },

  /**
   * Clear all performance marks and measures
   */
  clear(): void {
    if (typeof window !== 'undefined' && 'performance' in window) {
      try {
        window.performance.clearMarks();
        window.performance.clearMeasures();
      } catch (e) {
        // Ignore errors
      }
    }
  },
};

/**
 * Track slow load state
 * Logs which state flags are still pending after a timeout
 */
export function trackSlowLoad(pendingStates: Record<string, boolean | undefined | null>): void {
  const pending = Object.entries(pendingStates)
    .filter(([_, value]) => value === true || value === undefined || value === null)
    .map(([key]) => key);

  if (pending.length > 0) {
    console.warn('[Slow Load Detector] Still waiting for:', pending);
  }
}

