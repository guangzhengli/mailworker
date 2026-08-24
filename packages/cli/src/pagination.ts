import type { Client, Query } from "@cli/client";
import { usage } from "@cli/errors";
import type { PageDto } from "@mailworker/contract";

export interface PaginationOptions {
  readonly cursor?: string;
  readonly all?: boolean;
  readonly maxItems?: string;
}

/**
 * Fetch one page by default, or follow cursors when `--all` is explicit.
 *
 * `--max-items` is required with `--all`: an unattended process should never
 * turn a broad list into an unbounded D1 scan and an unbounded stdout stream.
 */
export async function fetchPage<T>(
  client: Client,
  path: string,
  query: Query,
  options: PaginationOptions,
): Promise<PageDto<T>> {
  if (options.all !== true) {
    if (options.maxItems !== undefined) throw usage("--max-items requires --all.");
    return await client.get<PageDto<T>>(path, { ...query, cursor: options.cursor });
  }

  const maximum = parsePositiveInteger(options.maxItems, "--max-items");
  if (maximum === undefined) {
    throw usage("--all requires --max-items <n> to keep the result bounded.");
  }

  const items: T[] = [];
  let cursor = options.cursor;
  while (items.length < maximum) {
    const remaining = maximum - items.length;
    const requested = numberFromQuery(query["limit"]);
    const limit = Math.min(remaining, requested ?? 200);
    const page = await client.get<PageDto<T>>(path, { ...query, cursor, limit });
    items.push(...page.items.slice(0, remaining));

    if (page.cursor === null || page.items.length === 0) return { items, cursor: null };
    cursor = page.cursor;
  }

  // A non-null cursor says that the caller's own safety bound, rather than the
  // collection, ended the traversal. It can resume with `--cursor` later.
  return { items, cursor: cursor ?? null };
}

function parsePositiveInteger(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw usage(`${flag} must be a positive integer.`);
  }
  return parsed;
}

function numberFromQuery(value: Query[string]): number | undefined {
  if (value === undefined || typeof value === "boolean") return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}
