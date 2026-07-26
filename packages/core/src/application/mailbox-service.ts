import type {
  AttachmentMeta,
  ExtractKind,
  InboxKind,
  Message,
  MessageSummary,
  Page,
  ThreadId,
  WaitCriteria,
} from "@core/domain";
import {
  Caller,
  DomainError,
  Extractors,
  Inbox,
  invalidArgument,
  notFound,
  Ulid,
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
/**
 * mailbox — everything a caller does with inboxes and stored messages.
 *
 * One service per bounded context, so "what can this domain do" is answerable
 * by reading one file rather than by listing a directory of loose functions.
 */

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
  /** Full address. Mutually exclusive with `prefix`. */
  readonly address?: string;
  /** Generate `<prefix>-<random>@<domain>`. Defaults to `inbox`. */
  readonly prefix?: string;
  /** Required only when the deployment serves more than one domain. */
  readonly domain?: string;
  /** Omit for `persistent`; defaults to 1 hour for `ephemeral`. */
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
  /** Pull the useful bit out of the body instead of returning the whole message. */
  readonly extract?: ExtractKind;
}

export type WaitOutcome =
  | {
      readonly outcome: "matched";
      readonly message: Message;
      /** Present when `extract` was requested; null when nothing matched. */
      readonly extracted: string | null;
    }
  | { readonly outcome: "timeout"; readonly waitedMs: number };

export const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
export const MAX_WAIT_TIMEOUT_MS = 5 * 60 * 1000;

export function createMailboxService(deps: MailboxDeps) {
  return {
    /**
     * Mint a receiving address.
     *
     * Worth noting what this does NOT do: it never calls the Cloudflare API. Inboxes
     * live behind one catch-all routing rule (DESIGN.md §2.1), so creating one is a
     * single database insert. That is what makes it reasonable for a test suite to
     * create a fresh inbox per case instead of sharing one and cleaning up after.
     */
    async createInbox(ctx: Caller, input: CreateInboxRequest): Promise<Inbox> {
      Caller.require(ctx, "inbox:write");
      const now = deps.clock.now();

      if (input.address !== undefined && input.prefix !== undefined) {
        throw invalidArgument("Pass either `address` or `prefix`, not both.");
      }

      let address = input.address;
      if (address === undefined) {
        const domain = await resolveDomain(deps, ctx, input.domain);
        const suffix = deps.secrets.generate(RANDOM_SUFFIX_BYTES);
        address = `${input.prefix ?? "inbox"}-${suffix}@${domain}`;
      }

      const kind: InboxKind = input.kind ?? "ephemeral";
      const expiresAt =
        kind === "persistent"
          ? null
          : Inbox.expiryFromTtl(now, input.ttlMs ?? DEFAULT_EPHEMERAL_TTL_MS);

      let identityId = null;
      if (input.identityName !== undefined) {
        const identity = await deps.identities.findByName(ctx, input.identityName);
        if (identity === null) {
          throw new DomainError(
            "invalid_argument",
            `No agent identity named "${input.identityName}".`,
            { identityName: input.identityName },
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

      const clash = await deps.inboxes.findByAddress(ctx, inbox.address);
      if (clash !== null) {
        throw new DomainError("address_taken", `Inbox ${inbox.address} already exists.`, {
          address: inbox.address,
        });
      }

      await deps.inboxes.insert(ctx, inbox);
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
     * The inbox row itself is soft-deleted. Its address stays reserved, so a
     * later `createInbox` cannot mint the same address and inherit a stranger's
     * mail from a sender who had not yet noticed.
     */
    async deleteInbox(ctx: Caller, id: Ulid): Promise<void> {
      Caller.require(ctx, "inbox:write");
      const inbox = await deps.inboxes.findById(ctx, id);
      if (inbox === null || Inbox.isDeleted(inbox)) {
        throw notFound("inbox_not_found", `No inbox ${id}.`, { id });
      }

      const { storageKeys } = await deps.messages.deleteByInbox(ctx, id);
      if (storageKeys.length > 0) await deps.blobs.delete(ctx, storageKeys);
      await deps.inboxes.deleteById(ctx, id);
    },

    /** Stored messages, filtered and keyset-paginated. Summaries, not bodies. */
    async listMessages(
      ctx: Caller,
      query: ListMessagesQuery = {},
    ): Promise<Page<MessageSummary>> {
      Caller.require(ctx, "message:read");
      return await deps.messages.list(ctx, query);
    },

    async getMessage(ctx: Caller, id: Ulid): Promise<Message> {
      Caller.require(ctx, "message:read");
      const message = await deps.messages.findById(ctx, id);
      if (message === null) throw notFound("message_not_found", `No message ${id}.`, { id });
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

    /** One attachment's bytes, with the metadata needed to serve them. */
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
      const messages = await deps.messages.listThread(ctx, threadId);
      if (messages.length === 0) {
        throw notFound("message_not_found", `No thread ${threadId}.`, { threadId });
      }
      return messages;
    },

    /**
     * Block until a matching message arrives.
     *
     * This is the operation the whole CLI is shaped around: a test or an agent asks
     * "did the signup email arrive, and what is the code", and gets an answer in one
     * call with no polling loop of its own.
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
        // Compile once, here, so a bad pattern is a clear 400 rather than an
        // exception from inside the waiter after the caller has already blocked.
        try {
          new RegExp(input.match);
        } catch {
          throw invalidArgument(`\`match\` is not a valid regular expression: ${input.match}`, {
            match: input.match,
          });
        }
      }

      const startedAt = deps.clock.now();
      const criteria: WaitCriteria = {
        ...(input.inboxId === undefined ? {} : { inboxId: Ulid.parse(input.inboxId) }),
        ...(input.from === undefined ? {} : { from: input.from }),
        ...(input.subject === undefined ? {} : { subject: input.subject }),
        ...(input.match === undefined ? {} : { match: input.match }),
        ...(input.after === undefined ? {} : { after: Ulid.parse(input.after) }),
      };

      const message = await deps.waiter.wait(ctx, criteria, timeoutMs);
      if (message === null) {
        return {
          outcome: "timeout",
          waitedMs: deps.clock.now().getTime() - startedAt.getTime(),
        };
      }

      return { outcome: "matched", message, extracted: extractFrom(message, input.extract) };
    },
  };
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

function extractFrom(message: Message, kind: ExtractKind | undefined): string | null {
  if (kind === undefined || kind === "none") return null;
  // Prefer the text body; fall back to HTML so a text-free message still yields
  // a code. Tag stripping is crude on purpose — we only need the digits.
  const body = message.bodyText ?? (message.bodyHtml ?? "").replace(/<[^>]+>/g, " ");
  const haystack = `${message.subject}\n${body}`;
  return kind === "otp" ? Extractors.otp(haystack) : Extractors.firstLink(haystack);
}
