import type { RfcMessageId, ThreadId } from "@/domain/message-id.ts";
import { ThreadId as ThreadIdVO } from "@/domain/message-id.ts";

/**
 * Which conversation does a message belong to?
 *
 * Pure by construction: the caller does ONE repository lookup for all candidate
 * ids and passes the result in as `known`. The policy never touches storage, so
 * every branch below is exhaustively testable with a plain Map.
 *
 * Both directions run through this. An outbound reply has to land in the same
 * thread as the inbound message it answers, and threading only works if there is
 * exactly one implementation deciding it.
 */
export interface ThreadResolutionInput {
  /** The Message-ID of the message being stored. */
  readonly ownMessageId: RfcMessageId;
  readonly inReplyTo: RfcMessageId | null;
  /** The `References` chain, oldest first, as RFC 5322 specifies. */
  readonly references: readonly RfcMessageId[];
  /** Thread id for every candidate id already in the store. */
  readonly known: ReadonlyMap<string, ThreadId>;
}

export type ThreadResolution =
  | { readonly threadId: ThreadId; readonly via: "in_reply_to" | "references" }
  | { readonly threadId: ThreadId; readonly via: "new_thread" };

export const ThreadingPolicy = {
  /**
   * Ids worth looking up, most-likely-parent first. Callers use this to build a
   * single `WHERE rfc_message_id IN (...)` query.
   *
   * `References` is reversed because it runs oldest-first, so its LAST entry is
   * the closest ancestor — that is the thread we want to join when a chain has
   * been forwarded across several conversations.
   */
  candidateIds(
    inReplyTo: RfcMessageId | null,
    references: readonly RfcMessageId[],
  ): RfcMessageId[] {
    const ordered: RfcMessageId[] = [];
    if (inReplyTo !== null) ordered.push(inReplyTo);
    for (let i = references.length - 1; i >= 0; i--) {
      ordered.push(references[i]!);
    }
    // Preserve priority order while removing duplicates.
    return [...new Set(ordered)];
  },

  resolve(input: ThreadResolutionInput): ThreadResolution {
    if (input.inReplyTo !== null) {
      const direct = input.known.get(input.inReplyTo);
      if (direct !== undefined) {
        return { threadId: direct, via: "in_reply_to" };
      }
    }

    for (let i = input.references.length - 1; i >= 0; i--) {
      const referenced = input.known.get(input.references[i]!);
      if (referenced !== undefined) {
        return { threadId: referenced, via: "references" };
      }
    }

    // No known ancestor: this message roots its own thread.
    return { threadId: ThreadIdVO.fromRoot(input.ownMessageId), via: "new_thread" };
  },
} as const;
