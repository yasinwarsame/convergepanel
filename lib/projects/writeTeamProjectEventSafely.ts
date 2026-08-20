/**
 * Team Project Backend, Phase 8C-A.1 — a defensive wrapper around
 * `writeProjectEvent()` for the four Team Project routes (Mutation P
 * hardening). `writeProjectEvent()` already documents "always resolves —
 * never throws, never rejects," and every existing Personal route relies
 * on that contract directly with no wrapper of its own. This wrapper adds
 * a second, redundant layer specifically for Team routes: even if that
 * contract were ever violated by a future bug in `writeProjectEvent()`,
 * an event-write failure must never propagate as an uncaught rejection
 * and turn an already-committed canonical Team Project mutation into a
 * failed HTTP response. Personal routes are intentionally left
 * unmodified — this is a Team-Project-scoped hardening only.
 */

import "server-only";
import { logger } from "@/lib/logger";
import { writeProjectEvent, type WriteProjectEventArgs } from "./projectEvents";

export async function writeTeamProjectEventSafely(args: WriteProjectEventArgs): Promise<void> {
  try {
    await writeProjectEvent(args);
  } catch (err) {
    logger.warn("[projects/writeTeamProjectEventSafely] projectEvent write threw — canonical Team Project mutation is unaffected", {
      eventType: args.eventType,
      projectId: args.projectId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
