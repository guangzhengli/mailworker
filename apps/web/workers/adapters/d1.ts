import type { Page, PageRequest, Ulid } from "@mailworker/core";
import { clampLimit } from "@mailworker/core";
import * as schema from "@web/workers/adapters/schema";
import type { SQL } from "drizzle-orm";
import { gt, lt } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { drizzle } from "drizzle-orm/d1";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";

export type Db = DrizzleD1Database<typeof schema>;

export function createDb(binding: D1Database): Db {
  return drizzle(binding, { schema });
}

/**
 * Timestamps are ISO 8601 UTC text in D1 (see `schema.ts`), so crossing the
 * boundary is these two functions and nothing else. Always going through
 * `toISOString` is what makes the text form sort chronologically, which several
 * range queries depend on.
 */
export function toIsoText(value: Date): string;
export function toIsoText(value: Date | null): string | null;
export function toIsoText(value: Date | null): string | null {
  return value === null ? null : value.toISOString();
}

export function toDate(value: string): Date;
export function toDate(value: string | null): Date | null;
export function toDate(value: string | null): Date | null {
  return value === null ? null : new Date(value);
}

/**
 * The cursor half of keyset pagination.
 *
 * No OFFSET anywhere: an offset shifts under you when rows are inserted or
 * deleted mid-scan, and inserting is what a mailbox does all day. A ULID cursor
 * stays a valid position regardless — including after the row it names is
 * deleted, since this is a comparison and not a lookup.
 */
export function afterCursor(column: SQLiteColumn, request: PageRequest): SQL | undefined {
  if (request.cursor === undefined) return undefined;
  return request.order === "asc" ? gt(column, request.cursor) : lt(column, request.cursor);
}

export function pageLimit(request: PageRequest): number {
  return clampLimit(request.limit);
}

/**
 * Wrap rows in a page envelope.
 *
 * A cursor is only issued for a FULL page. A short page means the caller has
 * everything, and handing back a cursor there costs one wasted round trip per
 * list call for the rest of the deployment's life.
 */
export function toPage<T extends { readonly id: Ulid }>(
  rows: readonly T[],
  limit: number,
): Page<T> {
  const full = rows.length === limit && rows.length > 0;
  return { items: rows, cursor: full ? rows[rows.length - 1]!.id : null };
}
