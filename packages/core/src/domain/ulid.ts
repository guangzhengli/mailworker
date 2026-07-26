import { DomainError } from "@core/domain/errors.ts";

/**
 * A ULID: 26 chars of Crockford base32, lexicographically sortable by
 * generation time. Used as the primary key AND the pagination cursor for
 * messages (DESIGN.md ADR-2).
 *
 * This module only *validates and compares*. Generation needs a clock and
 * randomness, so it lives behind `IdGeneratorPort` — that is what keeps the
 * domain pure and the tests deterministic.
 */
export type Ulid = string & { readonly __brand: "Ulid" };

const ULID_LENGTH = 26;
// Crockford base32 excludes I, L, O and U.
const ULID_PATTERN = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export const Ulid = {
  parse(input: string): Ulid {
    const value = input.toUpperCase();
    if (value.length !== ULID_LENGTH || !ULID_PATTERN.test(value)) {
      throw new DomainError("invalid_ulid", `Not a valid ULID: ${input}`, { input });
    }
    return value as Ulid;
  },

  tryParse(input: string): Ulid | null {
    try {
      return Ulid.parse(input);
    } catch {
      return null;
    }
  },

  is(input: string): boolean {
    return Ulid.tryParse(input) !== null;
  },

  /** Milliseconds encoded in the first 10 chars. */
  timestamp(id: Ulid): number {
    let ms = 0;
    for (let i = 0; i < 10; i++) {
      ms = ms * 32 + CROCKFORD.indexOf(id[i]!);
    }
    return ms;
  },

  /** Lexicographic order == arrival order. Suitable for Array.prototype.sort. */
  compare(a: Ulid, b: Ulid): number {
    return a < b ? -1 : a > b ? 1 : 0;
  },
} as const;

export const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
