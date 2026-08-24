import type {
  AttachmentMeta,
  DomainEvent,
  InboxKind,
  Message,
  MessageSummary,
  Page,
  ThreadId,
} from "@core/domain";
import {
  Caller,
  DomainError,
  Inbox,
  invalidArgument,
  notFound,
  RetentionPolicy,
  Ulid,
  WaitCriteria,
} from "@core/domain";
import type {
  BlobStore,
  Clock,
  DomainRepository,
  EventBus,
  IdentityRepository,
  IdGenerator,
  InboxRepository,
  ListInboxesQuery,
  ListMessagesQuery,
  MessageRepository,
  Secrets,
  Waiter,
} from "@core/domain/ports";
export interface MailboxDeps {
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly secrets: Secrets;
  readonly inboxes: InboxRepository;
  readonly messages: MessageRepository;
  readonly domains: DomainRepository;
  readonly identities: IdentityRepository;
  readonly blobs: BlobStore;
  readonly events: EventBus;
  readonly waiter: Waiter;
}

/**
 * `activeAt` is not on this: it is the clock, and the caller of a service does
 * not get to lie about what time it is. `includeExpired` is the question a
 * client actually has.
 */
export interface ListInboxesRequest extends Omit<ListInboxesQuery, "activeAt"> {
  readonly includeExpired?: boolean;
}

export interface CreateInboxRequest {
  readonly address?: string;
  readonly localPart?: string;
  readonly prefix?: string;
  readonly domain?: string;
  readonly ttlMs?: number;
  readonly kind?: InboxKind;
  readonly displayName?: string;
  readonly identityName?: string;
  readonly metadata?: Record<string, string>;
}

export const DEFAULT_EPHEMERAL_TTL_MS = 60 * 60 * 1000;
const RANDOM_SUFFIX_BYTES = 6;

export interface WaitForMessageRequest extends WaitCriteria {
  readonly timeoutMs?: number;
}

export type WaitOutcome =
  | {
      readonly outcome: "matched";
      readonly message: Message;
    }
  | { readonly outcome: "timeout"; readonly waitedMs: number };

export const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
export const MAX_WAIT_TIMEOUT_MS = 5 * 60 * 1000;

export const DEFAULT_SWEEP_LIMIT = 200;

export interface SweepExpiredOptions {
  readonly gracePeriodMs?: number;
  readonly limit?: number;
}

export interface SweepExpiredResult {
  readonly examined: number;
  readonly purged: number;
  readonly messagesDeleted: number;
  readonly failed: number;
}

export function createMailboxService(deps: MailboxDeps) {
  return {
    /**
     * Mint a receiving address.
     *
     * Worth noting what this does NOT do: it never calls the Cloudflare API. Inboxes
     * live behind one catch-all routing rule, so creating one is a
     * single database insert. That is what makes it reasonable for a test suite to
     * create a fresh inbox per case instead of sharing one and cleaning up after.
     */
    async createInbox(ctx: Caller, input: CreateInboxRequest): Promise<Inbox> {
      Caller.require(ctx, "inbox:write");
      const now = deps.clock.now();

      const named = (["address", "localPart", "prefix"] as const).filter(
        (key) => input[key] !== undefined,
      );
      if (named.length > 1) {
        throw invalidArgument(
          `Pass one of \`address\`, \`localPart\` or \`prefix\`, not ${named.join(" and ")}.`,
        );
      }

      let address = input.address;
      if (address === undefined) {
        const domain = await resolveDomain(deps, ctx, input.domain);
        address =
          input.localPart === undefined
            ? `${input.prefix ?? "inbox"}-${deps.secrets.generate(RANDOM_SUFFIX_BYTES)}@${domain}`
            : `${input.localPart}@${domain}`;
      }

      const kind: InboxKind = input.kind ?? "ephemeral";
      const expiresAt =
        kind === "persistent"
          ? null
          : Inbox.expiryFromTtl(now, input.ttlMs ?? DEFAULT_EPHEMERAL_TTL_MS);

      let identityId = null;
      const restrictedIdentityId = resourceIdentity(ctx);
      if (restrictedIdentityId !== null && input.identityName === undefined) {
        // An identity-bound key owns what it creates. Leaving this null would
        // create an account-wide inbox that the same key should not be able to
        // read, and would let it choose an unmetered sending identity later.
        identityId = restrictedIdentityId;
      } else if (input.identityName !== undefined) {
        const identity = await deps.identities.findByName(ctx, input.identityName);
        if (identity === null) {
          throw new DomainError(
            "invalid_argument",
            `No agent identity named "${input.identityName}".`,
            { identityName: input.identityName },
          );
        }
        if (restrictedIdentityId !== null && identity.id !== restrictedIdentityId) {
          throw new DomainError(
            "forbidden",
            "This credential cannot create an inbox for another identity.",
            {
              subject: ctx.subject,
            },
          );
        }
        identityId = identity.id;
      }

      const inbox = Inbox.create({
        id: deps.ids.ulid(),
        accountId: ctx.accountId,
        address,
        kind,
        expiresAt,
        identityId,
        now,
        ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      });

      // The insert is what decides this, not a lookup before it. A read-then-
      // write lets two concurrent creates of one address both see it free, and
      // the loser then fails on the constraint as an opaque 500 rather than the
      // `address_taken` it can act on — which is exactly what a test suite
      // minting one fixture inbox from parallel workers hits.
      const { stored } = await deps.inboxes.insert(ctx, inbox);
      if (!stored) {
        throw new DomainError("address_taken", `${inbox.address} is taken.`, {
          address: inbox.address,
        });
      }

      await deps.events.publish([
        {
          type: "inbox.created",
          accountId: ctx.accountId,
          occurredAt: now,
          inboxId: inbox.id,
          address: inbox.address,
          expiresAt: inbox.expiresAt,
        },
      ]);

      return inbox;
    },

    /** The hostnames an inbox can be created on. */
    async listDomains(ctx: Caller): Promise<string[]> {
      Caller.require(ctx, "inbox:read");
      return (await deps.domains.list(ctx)).map((routing) => routing.domain);
    },

    /**
     * Inboxes, newest first.
     *
     * Expired ones are excluded by passing the clock in as `activeAt` rather
     * than by a flag, so the repository never reads the time and "what was live
     * an hour ago" stays expressible. `includeExpired` is here for the
     * dashboard, which has to be able to show why an address stopped working.
     */
    async listInboxes(ctx: Caller, query: ListInboxesRequest = {}): Promise<Page<Inbox>> {
      Caller.require(ctx, "inbox:read");
      const { includeExpired, ...page } = query;
      return await deps.inboxes.list(ctx, {
        ...page,
        ...(resourceIdentity(ctx) === null ? {} : { identityId: resourceIdentity(ctx)! }),
        ...(includeExpired === true ? {} : { activeAt: deps.clock.now() }),
      });
    },

    /**
     * One inbox.
     *
     * An expired inbox is still returned. It exists, its address is still spoken
     * for, and a caller debugging "why did my mail bounce" needs to see
     * `expiresAt` in the past — which a 404 would hide behind the wrong story.
     * Refusing to *receive* is `Inbox.assertCanReceive`, on the ingest path.
     */
    async getInbox(ctx: Caller, id: Ulid): Promise<Inbox> {
      Caller.require(ctx, "inbox:read");
      const inbox = await deps.inboxes.findById(ctx, id);
      if (inbox === null || Inbox.isDeleted(inbox)) {
        throw notFound("inbox_not_found", `No inbox ${id}.`, { id });
      }
      assertInboxAccess(ctx, inbox);
      return inbox;
    },

    /**
     * Delete an inbox and everything in it.
     *
     * Ordering is the same trade as ingest, mirrored: rows go first, then the
     * blobs they pointed at. A blob that outlives its row is invisible and gets
     * swept; a row that outlives its blob renders as a message whose body
     * cannot be fetched, forever. Deleting the messages before the inbox keeps
     * the same property one level up.
     *
     * The row goes with it, so the address is free to be created again.
     */
    async deleteInbox(ctx: Caller, id: Ulid): Promise<void> {
      Caller.require(ctx, "inbox:write");
      const inbox = await deps.inboxes.findById(ctx, id);
      if (inbox === null || Inbox.isDeleted(inbox)) {
        throw notFound("inbox_not_found", `No inbox ${id}.`, { id });
      }
      assertInboxAccess(ctx, inbox);

      const { storageKeys } = await deps.messages.deleteByInbox(ctx, id);
      if (storageKeys.length > 0) await deps.blobs.delete(ctx, storageKeys);
      await deps.inboxes.deleteById(ctx, id);
    },

    async listMessages(
      ctx: Caller,
      query: ListMessagesQuery = {},
    ): Promise<Page<MessageSummary>> {
      Caller.require(ctx, "message:read");
      const identityId = resourceIdentity(ctx);
      return await deps.messages.list(ctx, {
        ...query,
        ...(identityId === null ? {} : { identityId }),
      });
    },

    async getMessage(ctx: Caller, id: Ulid): Promise<Message> {
      Caller.require(ctx, "message:read");
      const message = await deps.messages.findById(ctx, id);
      if (message === null) throw notFound("message_not_found", `No message ${id}.`, { id });
      assertMessageAccess(ctx, message);
      return message;
    },

    /**
     * The original bytes, exactly as they arrived.
     *
     * Half of the `get --raw > fixture.eml` / `inject fixture.eml` loop that
     * turns a strange production message into a regression test. Verbatim
     * matters: a re-serialized message would reproduce our parser's opinion of
     * the mail rather than the mail.
     */
    async getRawMessage(ctx: Caller, id: Ulid): Promise<Uint8Array> {
      Caller.require(ctx, "message:read");
      const message = await deps.messages.findById(ctx, id);
      if (message === null) throw notFound("message_not_found", `No message ${id}.`, { id });
      assertMessageAccess(ctx, message);

      // Null for a message we composed but have not archived: an outbound send
      // gets its `.eml` written when it is dispatched, not when it is queued.
      const raw = message.rawKey === null ? null : await deps.blobs.get(ctx, message.rawKey);
      if (raw === null) {
        throw notFound(
          "message_not_found",
          `The original bytes of ${id} are no longer stored.`,
          {
            id,
          },
        );
      }
      return raw;
    },

    async getAttachment(
      ctx: Caller,
      messageId: Ulid,
      attachmentId: Ulid,
    ): Promise<{ meta: AttachmentMeta; content: Uint8Array }> {
      Caller.require(ctx, "message:read");
      const message = await deps.messages.findById(ctx, messageId);
      if (message === null) {
        throw notFound("message_not_found", `No message ${messageId}.`, { messageId });
      }
      assertMessageAccess(ctx, message);

      const meta = message.attachments.find((a) => a.id === attachmentId);
      if (meta === undefined) {
        throw notFound(
          "message_not_found",
          `Message ${messageId} has no attachment ${attachmentId}.`,
          {
            messageId,
            attachmentId,
          },
        );
      }

      const content = await deps.blobs.get(ctx, meta.storageKey);
      if (content === null) {
        throw notFound("message_not_found", `Attachment ${attachmentId} is no longer stored.`, {
          messageId,
          attachmentId,
        });
      }
      return { meta, content };
    },

    async markSeen(ctx: Caller, id: Ulid, seen = true): Promise<void> {
      Caller.require(ctx, "message:read");
      const message = await deps.messages.findById(ctx, id);
      if (message === null) throw notFound("message_not_found", `No message ${id}.`, { id });
      assertMessageAccess(ctx, message);
      await deps.messages.setSeen(ctx, id, seen);
    },

    /**
     * A conversation, oldest first, both directions in one list.
     *
     * One shape for inbound and outbound is the whole reason `Message` is not
     * two types: an agent asking "what happened in this thread" should not have
     * to merge two paginated endpoints and sort the result itself.
     */
    async getThread(ctx: Caller, threadId: ThreadId): Promise<Message[]> {
      Caller.require(ctx, "message:read");
      const identityId = resourceIdentity(ctx);
      const messages = (await deps.messages.listThread(ctx, threadId)).filter(
        (message) => identityId === null || message.identityId === identityId,
      );
      if (messages.length === 0) {
        throw notFound("message_not_found", `No thread ${threadId}.`, { threadId });
      }
      return messages;
    },

    /**
     * Block until a matching message arrives.
     *
     * This is the operation the whole CLI is shaped around: a test or an agent asks
     * "did the signup email arrive", and gets the whole message back in one call
     * with no polling loop of its own. The whole message, deliberately — which
     * part of it matters is the caller's judgement, not ours.
     *
     * A timeout is an outcome, not an error. The CLI turns it into exit code 4 so a
     * shell script can branch on it, and an agent can tell "no mail yet" apart from
     * "your request was wrong" without parsing a message.
     */
    async wait(ctx: Caller, input: WaitForMessageRequest): Promise<WaitOutcome> {
      Caller.require(ctx, "message:read");

      const timeoutMs = input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
      if (timeoutMs <= 0 || timeoutMs > MAX_WAIT_TIMEOUT_MS) {
        throw invalidArgument(
          `timeoutMs must be between 1 and ${MAX_WAIT_TIMEOUT_MS} (got ${timeoutMs}).`,
          { timeoutMs, max: MAX_WAIT_TIMEOUT_MS },
        );
      }
      if (input.match !== undefined) {
        // Refuse unsafe patterns before registering the waiter. JavaScript
        // regex evaluation has no deadline and the body is attacker-authored.
        WaitCriteria.assertSafeMatch(input.match);
      }

      const startedAt = deps.clock.now();
      const criteria: WaitCriteria = {
        ...(input.inboxId === undefined ? {} : { inboxId: Ulid.parse(input.inboxId) }),
        ...(input.from === undefined ? {} : { from: input.from }),
        ...(input.subject === undefined ? {} : { subject: input.subject }),
        ...(input.match === undefined ? {} : { match: input.match }),
        ...(input.after === undefined ? {} : { after: Ulid.parse(input.after) }),
        ...(resourceIdentity(ctx) === null ? {} : { identityId: resourceIdentity(ctx)! }),
      };

      const message = await deps.waiter.wait(ctx, criteria, timeoutMs);
      if (message === null) {
        return {
          outcome: "timeout",
          waitedMs: deps.clock.now().getTime() - startedAt.getTime(),
        };
      }

      return { outcome: "matched", message };
    },

    /**
     * Erase inboxes whose grace period has run out. Driven by cron.
     *
     * Nothing else in the system deletes an expired inbox. `Inbox.canReceive`
     * stops it taking new mail the instant it expires, which is what a caller
     * sees — so without this sweep the failure is invisible rather than loud:
     * the product works exactly as advertised while D1 rows and R2 objects
     * accumulate forever. An ephemeral inbox that is never erased is just a
     * persistent inbox that stopped answering.
     *
     * `limit` bounds one run rather than the backlog. `findExpired` returns
     * oldest-expiry-first, so consecutive runs drain in age order and a burst of
     * ten thousand expiries costs many short invocations instead of one that
     * exceeds the CPU limit and accomplishes nothing. The default leaves room
     * under a cron's budget for each inbox to cost a delete of its messages and
     * a delete of its blobs.
     *
     * Per-inbox failures are collected, not thrown: one inbox whose blobs will
     * not delete must not stop the other 199 from being erased, and the sweep
     * runs again in an hour anyway. The count comes back so the caller can log
     * it — a sweep that silently does nothing looks exactly like a sweep that
     * has nothing to do.
     */
    async sweepExpired(
      ctx: Caller,
      options: SweepExpiredOptions = {},
    ): Promise<SweepExpiredResult> {
      Caller.require(ctx, "inbox:write");
      const now = deps.clock.now();
      const gracePeriodMs = options.gracePeriodMs ?? RetentionPolicy.DEFAULT_GRACE_PERIOD_MS;
      const limit = options.limit ?? DEFAULT_SWEEP_LIMIT;

      // Ask only for inboxes already past expiry + grace. Filtering in the query
      // rather than after it keeps a long tail of merely-expired inboxes from
      // consuming the limit and starving the ones actually due for erasure.
      const candidates = await deps.inboxes.findExpired(
        ctx,
        new Date(now.getTime() - gracePeriodMs),
        limit,
      );

      const result = { examined: candidates.length, purged: 0, messagesDeleted: 0, failed: 0 };
      const events: DomainEvent[] = [];

      for (const inbox of candidates) {
        // The query said "past expiry + grace"; the policy is what decides that
        // means purge. Re-asking it here is what keeps the rule in one place
        // instead of half in a WHERE clause.
        if (RetentionPolicy.decide({ inbox, now, gracePeriodMs }).action !== "purge") continue;

        try {
          // Same ordering as deleteInbox, for the same reason: a blob that
          // outlives its row is an orphan the next sweep collects, while a row
          // that outlives its blob is a message that renders as an error forever.
          const { storageKeys } = await deps.messages.deleteByInbox(ctx, inbox.id);
          if (storageKeys.length > 0) await deps.blobs.delete(ctx, storageKeys);
          await deps.inboxes.deleteById(ctx, inbox.id);

          result.purged += 1;
          result.messagesDeleted += storageKeys.length;
          events.push({
            type: "inbox.expired",
            accountId: ctx.accountId,
            occurredAt: now,
            inboxId: inbox.id,
            address: inbox.address,
          });
        } catch {
          // Left in place deliberately: it is still expired, so the next run
          // will find it again. Retrying inside this loop would turn one broken
          // inbox into a sweep that never reaches the rest of the backlog.
          result.failed += 1;
        }
      }

      // Published once, after the loop. The fan-out is a queue write per event,
      // and interleaving those with the deletes would put a network call between
      // a message delete and the blob delete that has to follow it.
      if (events.length > 0) await deps.events.publish(events);

      return result;
    },
  };
}

/** Existing unbound keys retain account-wide access; identity keys are scoped. */
function resourceIdentity(ctx: Caller): Ulid | null {
  return Caller.has(ctx, "admin") ? null : ctx.identityId;
}

function assertInboxAccess(ctx: Caller, inbox: Inbox): void {
  const identityId = resourceIdentity(ctx);
  if (identityId !== null && inbox.identityId !== identityId) {
    // 404 rather than 403: the caller must not learn which other identity owns it.
    throw notFound("inbox_not_found", `No inbox ${inbox.id}.`, { id: inbox.id });
  }
}

function assertMessageAccess(ctx: Caller, message: Message): void {
  const identityId = resourceIdentity(ctx);
  if (identityId !== null && message.identityId !== identityId) {
    throw notFound("message_not_found", `No message ${message.id}.`, { id: message.id });
  }
}

export type MailboxService = ReturnType<typeof createMailboxService>;

async function resolveDomain(
  deps: Pick<MailboxDeps, "domains">,
  ctx: Caller,
  requested: string | undefined,
): Promise<string> {
  if (requested !== undefined) {
    const routing = await deps.domains.findRouting(ctx, requested);
    if (routing === null) {
      throw invalidArgument(`This deployment does not serve ${requested}.`, {
        domain: requested,
      });
    }
    return routing.domain;
  }
  const all = await deps.domains.list(ctx);
  if (all.length === 0) {
    throw invalidArgument("No sending domain is configured. Run `mailworker doctor`.");
  }
  if (all.length > 1) {
    throw invalidArgument(
      `This deployment serves ${all.length} domains; pass \`domain\` to pick one.`,
      { domains: all.map((d) => d.domain) },
    );
  }
  return all[0]!.domain;
}
