import { DomainError } from "@core/domain/errors";

/**
 * An RFC 5322 Message-ID, stored WITHOUT the angle brackets.
 *
 * Normalizing off the brackets at the boundary is what lets threading compare
 * ids from three different sources — an inbound `In-Reply-To` header, an
 * inbound `References` list, and an id we generated ourselves for an outbound
 * message — without every comparison site remembering to strip them.
 */
export type RfcMessageId = string & { readonly __brand: "RfcMessageId" };

/**
 * A thread identifier. By construction (see ThreadingPolicy) it is the
 * RfcMessageId of the thread's root message, so it needs no separate registry.
 */
export type ThreadId = string & { readonly __brand: "ThreadId" };

const MAX_LENGTH = 998; // RFC 5322 line length ceiling

export const RfcMessageId = {
  parse(input: string): RfcMessageId {
    const value = RfcMessageId.normalize(input);
    if (value === null) {
      throw new DomainError("invalid_message_id", `Not a valid Message-ID: ${input}`, {
        input,
      });
    }
    return value;
  },

  tryParse(input: string): RfcMessageId | null {
    return RfcMessageId.normalize(input);
  },

  /** Strip surrounding whitespace and angle brackets. Returns null if unusable. */
  normalize(input: string): RfcMessageId | null {
    let value = input.trim();
    if (value.startsWith("<")) value = value.slice(1);
    if (value.endsWith(">")) value = value.slice(0, -1);
    value = value.trim();
    if (value.length === 0 || value.length > MAX_LENGTH) return null;
    if (/\s/.test(value)) return null;
    if (!value.includes("@")) return null;
    return value as RfcMessageId;
  },

  toHeader(id: RfcMessageId): string {
    return `<${id}>`;
  },

  /**
   * Parse a `References:` header into ordered ids, oldest first.
   * Unparseable entries are dropped rather than failing the whole message —
   * a malformed References must never block ingestion.
   */
  parseReferences(header: string): RfcMessageId[] {
    return header
      .split(/\s+/)
      .map((token) => RfcMessageId.normalize(token))
      .filter((id): id is RfcMessageId => id !== null);
  },

  referencesToHeader(ids: readonly RfcMessageId[]): string {
    return ids.map((id) => RfcMessageId.toHeader(id)).join(" ");
  },
} as const;

export const ThreadId = {
  fromRoot(rootId: RfcMessageId): ThreadId {
    return rootId as string as ThreadId;
  },

  parse(input: string): ThreadId {
    return RfcMessageId.parse(input) as string as ThreadId;
  },
} as const;
