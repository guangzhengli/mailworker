import type { Ulid } from "@core/domain/ulid";

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

/**
 * Keyset pagination. The cursor is a ULID, which is monotonic by arrival — so it
 * is a stable, never-reused position marker even when rows are deleted or a
 * backdated message arrives.
 */
export interface Page<T> {
  readonly items: readonly T[];
  /** ULID of the last item; pass back as `cursor`. Null when exhausted. */
  readonly cursor: Ulid | null;
}

export interface PageRequest {
  readonly limit?: number;
  readonly cursor?: Ulid;
  /** `desc` = newest first (default). `asc` is used for thread rendering. */
  readonly order?: "asc" | "desc";
}

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_PAGE_SIZE;
  if (!Number.isInteger(limit) || limit < 1) return DEFAULT_PAGE_SIZE;
  return Math.min(limit, MAX_PAGE_SIZE);
}

export function emptyPage<T>(): Page<T> {
  return { items: [], cursor: null };
}
