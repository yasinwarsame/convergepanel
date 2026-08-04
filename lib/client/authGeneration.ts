/**
 * Auth Lifecycle Hardening, Step 6.8 — operation-generation guard.
 *
 * A tiny, pure, dependency-free counter used to discard stale async auth
 * results: an old login response arriving after a newer login, a token
 * refresh resolving after logout, a logout's own DELETE resolving after a
 * subsequent login already started, rapid A→B→A account switches, or a
 * duplicate effect firing (React Strict Mode). Every async auth operation
 * captures the generation number active when it STARTS; before applying its
 * result it checks whether that number is still current. If a newer
 * operation has since started, the number has advanced and the stale result
 * is discarded — the state machine only ever reflects the latest intent.
 */

export interface GenerationGuard {
  /** Advances to a new generation and returns its number. Call at the start of every auth operation that may race with a later one. */
  next(): number;
  /** True if `gen` is still the latest generation — call immediately before applying an async result. */
  isCurrent(gen: number): boolean;
  /** The current generation number, for logging/telemetry only (never an identity value). */
  current(): number;
}

export function createGenerationGuard(): GenerationGuard {
  let generation = 0;
  return {
    next(): number {
      generation += 1;
      return generation;
    },
    isCurrent(gen: number): boolean {
      return gen === generation;
    },
    current(): number {
      return generation;
    },
  };
}
