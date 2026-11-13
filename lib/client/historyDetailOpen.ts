/**
 * Opening a saved claim or video verification from the Personal History list (app/page.tsx `openHistoryItem`).
 *
 * The rule, in one place:
 *  - Every open is a new selection. `begin(loadingId)` supersedes every earlier open and REPLACES the page's history
 *    loading indicator with its own value: the item id while it reads the record, or `null` when it commits
 *    synchronously (a cached claim, a research run that navigates, a signed-out video open). So an open that never
 *    reads anything still clears the indicator an earlier, slower open set.
 *  - Only the latest open may commit after an await. A slow, failed or rejected read for an earlier selection never
 *    overwrites the record now selected, never sets an error over it and never clears its loading indicator.
 *  - Every read ends with `settle()`, success or failure, so a selection's own indicator never outlives it.
 *  - `supersede()` is newer intent that is not an open (a tab change, the origin-linked Verify hand-off): it ends
 *    every pending open and clears the indicator.
 *
 * Pure and client-safe: the reads and the page setters are injected, so the control flow is tested behaviourally
 * (lib/__tests__/historyDetailOpen.spec.ts) without mounting the page.
 */

import type { ClaimVerificationClientPayload } from "@/lib/verification/claimVerificationClientPayload";
import type { VideoVerificationClientPayload } from "@/lib/verification/videoVerificationClientPayload";
import {
  claimPayloadRecordsIndependence,
  resolveClaimHistoryPayload,
  type ClaimRecordLookup,
} from "@/lib/verification/cachedClaimProvenance";

export type HistoryDetailOpen = {
  /** True while no later open (or `supersede()`) has replaced this one. */
  isCurrent(): boolean;
  /** Ends this open: clears the loading indicator only while it is still the latest. */
  settle(): void;
};

export type HistoryDetailOpenCoordinator = {
  begin(loadingId: string | null): HistoryDetailOpen;
  supersede(): void;
};

export function createHistoryDetailOpenCoordinator(
  setLoadingId: (id: string | null) => void
): HistoryDetailOpenCoordinator {
  let latest = 0;
  return {
    begin(loadingId) {
      const mine = ++latest;
      setLoadingId(loadingId);
      const isCurrent = () => mine === latest;
      return {
        isCurrent,
        settle() {
          if (isCurrent()) setLoadingId(null);
        },
      };
    },
    supersede() {
      latest++;
      setLoadingId(null);
    },
  };
}

export const VIDEO_HISTORY_LOAD_ERROR = "Could not load this video verification.";

export type VideoRecordRead = () => Promise<{ ok?: boolean; payload?: VideoVerificationClientPayload }>;

/** `read` is null when signed out: nothing can be read, so the open commits nothing and clears the indicator. */
export async function openSavedVideoVerification(
  coordinator: HistoryDetailOpenCoordinator,
  itemId: string,
  read: VideoRecordRead | null,
  sink: {
    setPayload(payload: VideoVerificationClientPayload | null): void;
    setError(message: string): void;
    onRecordRead(payload: VideoVerificationClientPayload): void;
  }
): Promise<void> {
  const open = coordinator.begin(read ? itemId : null);
  if (!read) return;
  try {
    const data = await read();
    if (!open.isCurrent()) return;
    if (data.ok && data.payload) {
      sink.setPayload(data.payload);
      sink.onRecordRead(data.payload);
    } else {
      sink.setPayload(null);
      sink.setError(VIDEO_HISTORY_LOAD_ERROR);
    }
  } catch {
    if (!open.isCurrent()) return;
    sink.setPayload(null);
    sink.setError(VIDEO_HISTORY_LOAD_ERROR);
  } finally {
    open.settle();
  }
}

export type SavedClaimItem = {
  id: string;
  title: string;
  claim?: string;
  payload?: ClaimVerificationClientPayload | null;
};

/**
 * A cached payload that records model independence is presented at once (no read). Otherwise the user's own record is
 * read through `lookup` (null when signed out); when it cannot be read, the cached payload (if any) is presented as
 * cached — independence unrecorded (cachedClaimProvenance.ts).
 */
export async function openSavedClaimVerification(
  coordinator: HistoryDetailOpenCoordinator,
  item: SavedClaimItem,
  lookup: ClaimRecordLookup | null,
  sink: {
    setPayload(payload: ClaimVerificationClientPayload | null): void;
    setClaimInput(claim: string): void;
    onRecordRead(record: ClaimVerificationClientPayload): void;
  }
): Promise<void> {
  if (item.payload && claimPayloadRecordsIndependence(item.payload)) {
    coordinator.begin(null);
    sink.setPayload({ ...item.payload, verificationId: item.payload.verificationId ?? item.id });
    sink.setClaimInput(item.payload.claim);
    return;
  }
  const cachedPayload = item.payload ?? null;
  sink.setClaimInput(cachedPayload?.claim ?? item.claim ?? item.title);
  const open = coordinator.begin(lookup ? item.id : null);
  try {
    const resolved = await resolveClaimHistoryPayload(item.id, cachedPayload, lookup);
    if (!open.isCurrent()) return;
    sink.setPayload(resolved.payload);
    if (resolved.fromRecord && resolved.payload) {
      sink.setClaimInput(resolved.payload.claim);
      sink.onRecordRead(resolved.payload);
    }
  } catch {
    // resolveClaimHistoryPayload already absorbs a failed read; nothing else here can establish a record.
    if (!open.isCurrent()) return;
    sink.setPayload(cachedPayload ? { ...cachedPayload, verificationId: cachedPayload.verificationId ?? item.id } : null);
  } finally {
    open.settle();
  }
}
