import type { EmailAddress } from "@core/domain/email-address";
import { AddressPattern } from "@core/domain/email-address";
import type { MailboxAddress } from "@core/domain/mailbox/mailbox-address";
import type { Ulid } from "@core/domain/ulid";

/**
 * What to do with mail for an address that has no inbox.
 *
 * - `reject`  — refuse it. The safe default.
 * - `store`   — file it under a designated quarantine inbox.
 * - `autocreate` — mint an ephemeral inbox on the fly, if the local part matches
 *   `autocreatePattern`. Powerful for test fleets, and an open door for abuse if
 *   the pattern is loose, which is why it is off unless explicitly configured.
 */
export type CatchAllMode = "reject" | "store" | "autocreate";

export interface DomainRouting {
  readonly domain: string;
  readonly catchAllMode: CatchAllMode;
  /** Required by `store`; where unmatched mail is filed. */
  readonly catchAllInboxId: Ulid | null;
  /** Required by `autocreate`; e.g. `agent-*@mail.example.com`. */
  readonly autocreatePattern: string | null;
}

export type AddressResolution =
  | { readonly kind: "inbox"; readonly inboxId: Ulid; readonly tag: string | null }
  | {
      readonly kind: "catch_all";
      readonly inboxId: Ulid;
      readonly tag: string | null;
    }
  | {
      readonly kind: "autocreate";
      readonly address: EmailAddress;
      readonly tag: string | null;
    }
  | { readonly kind: "unroutable"; readonly reason: UnroutableReason };

export type UnroutableReason =
  | "unknown_domain"
  | "no_such_inbox"
  | "catch_all_not_configured"
  | "autocreate_pattern_mismatch";

export interface ResolveAddressInput {
  readonly recipient: MailboxAddress;
  /** Inbox matching `recipient.matchKey`, if the caller found one. */
  readonly existingInboxId: Ulid | null;
  /** Routing config for `recipient.domain`, or null if we don't own it. */
  readonly routing: DomainRouting | null;
}

/**
 * Turn a recipient address into an inbox.
 *
 * This is what lets us run on a SINGLE Cloudflare catch-all routing rule
 * instead of one rule per address — routing rules cap at 200 per domain
 * (DESIGN.md §2.1), so per-address rules put a hard ceiling on the product.
 *
 * Note there is no separate subaddressing branch: `MailboxAddress.parse` already
 * stripped `+tag` into `matchKey`, so `agent-7+run42@x` and `agent-7@x` produce
 * the same lookup and the tag survives as a label. Pushing that into the value
 * object is what keeps this function down to three cases.
 */
export const AddressResolutionPolicy = {
  resolve(input: ResolveAddressInput): AddressResolution {
    const { recipient, routing } = input;
    const tag = recipient.tag;

    if (input.existingInboxId !== null) {
      return { kind: "inbox", inboxId: input.existingInboxId, tag };
    }

    if (routing === null) {
      return { kind: "unroutable", reason: "unknown_domain" };
    }

    switch (routing.catchAllMode) {
      case "reject":
        return { kind: "unroutable", reason: "no_such_inbox" };

      case "store":
        return routing.catchAllInboxId === null
          ? { kind: "unroutable", reason: "catch_all_not_configured" }
          : { kind: "catch_all", inboxId: routing.catchAllInboxId, tag };

      case "autocreate": {
        if (routing.autocreatePattern === null) {
          return { kind: "unroutable", reason: "catch_all_not_configured" };
        }
        return AddressPattern.matches(routing.autocreatePattern, recipient.matchKey)
          ? { kind: "autocreate", address: recipient.matchKey, tag }
          : { kind: "unroutable", reason: "autocreate_pattern_mismatch" };
      }
    }
  },
} as const;
