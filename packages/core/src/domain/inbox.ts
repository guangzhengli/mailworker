import type { AccountId } from "./account-id.ts";
import type { EmailAddress } from "./address.ts";
import { MailboxAddress } from "./address.ts";
import { DomainError, invalidArgument } from "./errors.ts";
import type { Ulid } from "./ulid.ts";

export type InboxKind = "ephemeral" | "persistent";

/**
 * A receiving address we own.
 *
 * Note what is NOT here: any Cloudflare Email Routing rule. Inboxes are resolved
 * inside the Worker against a single catch-all rule, because routing rules cap
 * at 200 per domain (DESIGN.md §2.1). Creating an inbox is a database write and
 * nothing else — which is also why creating ten thousand of them for a test run
 * is fine.
 */
export interface Inbox {
  readonly id: Ulid;
  readonly accountId: AccountId;
  /** Tag-stripped, lowercased. Unique per account. */
  readonly address: EmailAddress;
  readonly localPart: string;
  readonly domain: string;
  readonly displayName: string | null;
  readonly kind: InboxKind;
  /** The agent identity this inbox sends as, if any. */
  readonly identityId: Ulid | null;
  /** Opaque caller-supplied labels (test run id, ticket, …). */
  readonly metadata: Readonly<Record<string, string>> | null;
  /** Null means never expires. Always null for `persistent`. */
  readonly expiresAt: Date | null;
  readonly deletedAt: Date | null;
  readonly createdAt: Date;
}

export interface CreateInboxInput {
  readonly id: Ulid;
  readonly accountId: AccountId;
  readonly address: string;
  readonly kind: InboxKind;
  readonly now: Date;
  readonly displayName?: string | null;
  readonly identityId?: Ulid | null;
  readonly metadata?: Record<string, string> | null;
  readonly expiresAt?: Date | null;
}

export const Inbox = {
  create(input: CreateInboxInput): Inbox {
    const parsed = MailboxAddress.parse(input.address);
    if (parsed.tag !== null) {
      throw invalidArgument(
        `Cannot create an inbox at a tagged address (${input.address}); ` +
          `tags are a view onto ${parsed.matchKey}, not a separate inbox.`,
        { address: input.address, tag: parsed.tag },
      );
    }

    const expiresAt = input.expiresAt ?? null;
    if (input.kind === "ephemeral" && expiresAt === null) {
      throw invalidArgument("An ephemeral inbox must have an expiry.", { kind: input.kind });
    }
    if (input.kind === "persistent" && expiresAt !== null) {
      throw invalidArgument("A persistent inbox must not have an expiry.", {
        kind: input.kind,
      });
    }
    if (expiresAt !== null && expiresAt.getTime() <= input.now.getTime()) {
      throw invalidArgument("Inbox expiry must be in the future.", {
        expiresAt: expiresAt.toISOString(),
        now: input.now.toISOString(),
      });
    }

    return {
      id: input.id,
      accountId: input.accountId,
      address: parsed.matchKey,
      localPart: parsed.localPart,
      domain: parsed.domain,
      displayName: input.displayName ?? null,
      kind: input.kind,
      identityId: input.identityId ?? null,
      metadata: input.metadata ? Object.freeze({ ...input.metadata }) : null,
      expiresAt,
      deletedAt: null,
      createdAt: input.now,
    };
  },

  expiryFromTtl(now: Date, ttlMs: number): Date {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw invalidArgument("TTL must be a positive number of milliseconds.", { ttlMs });
    }
    return new Date(now.getTime() + ttlMs);
  },

  isExpired(inbox: Inbox, now: Date): boolean {
    return inbox.expiresAt !== null && inbox.expiresAt.getTime() <= now.getTime();
  },

  isDeleted(inbox: Inbox): boolean {
    return inbox.deletedAt !== null;
  },

  /**
   * An expired inbox goes read-only rather than vanishing: a test that times out
   * a second after its inbox expired should get "expired", not "not found", so
   * the failure is diagnosable. RetentionPolicy decides when it truly goes away.
   */
  canReceive(inbox: Inbox, now: Date): boolean {
    return !Inbox.isDeleted(inbox) && !Inbox.isExpired(inbox, now);
  },

  assertCanReceive(inbox: Inbox, now: Date): void {
    if (Inbox.isDeleted(inbox)) {
      throw new DomainError("inbox_not_found", `Inbox ${inbox.address} has been deleted.`, {
        inboxId: inbox.id,
      });
    }
    if (Inbox.isExpired(inbox, now)) {
      throw new DomainError("inbox_expired", `Inbox ${inbox.address} expired.`, {
        inboxId: inbox.id,
        expiresAt: inbox.expiresAt?.toISOString(),
      });
    }
  },

  markDeleted(inbox: Inbox, now: Date): Inbox {
    return { ...inbox, deletedAt: now };
  },
} as const;
