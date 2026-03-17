"use client";

/**
 * Status Pill Component
 * 
 * Displays the current status of a model during panel execution.
 * Shows different colors and labels based on status:
 * - Queued: Waiting to start
 * - Thinking: Currently processing
 * - Done: Successfully completed
 * - Error: Failed with error
 * - Timeout: Request timed out
 * - Refused: API refused (rate limit, etc.)
 * 
 * Also displays latency (in milliseconds) when status is "ok".
 */

import { ModelStatus } from "@/lib/types";

interface StatusPillProps {
  status: ModelStatus | "queued" | "thinking";
  modelName: string;
  latencyMs?: number; // Optional latency display (shown when status is "ok")
}

export default function StatusPill({
  status,
  modelName,
  latencyMs,
}: StatusPillProps) {
  /**
   * Get color and label configuration for each status
   * 
   * Returns Tailwind CSS classes for styling the pill based on status.
   */
  const getStatusConfig = () => {
    switch (status) {
      case "queued":
        return {
          label: "Queued",
          color: "bg-gray-100 text-gray-700 border-gray-300",
        };
      case "thinking":
        return {
          label: "Thinking...",
          color: "bg-blue-100 text-blue-700 border-blue-300",
        };
      case "ok":
        return {
          label: "Done",
          color: "bg-green-100 text-green-700 border-green-300",
        };
      case "substituted":
        return {
          label: "Substituted",
          color: "bg-amber-100 text-amber-700 border-amber-300",
        };
      case "failed":
        return {
          label: "Failed",
          color: "bg-red-100 text-red-700 border-red-300",
        };
      default:
        return {
          label: "Unknown",
          color: "bg-gray-100 text-gray-700 border-gray-300",
        };
    }
  };

  const config = getStatusConfig();

  return (
    <div
      className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full border text-sm font-medium ${config.color}`}
    >
      <span className="font-semibold">{modelName}:</span>
      <span>{config.label}</span>
      {latencyMs !== undefined && status === "ok" && (
        <span className="text-xs opacity-75">({latencyMs}ms)</span>
      )}
    </div>
  );
}


