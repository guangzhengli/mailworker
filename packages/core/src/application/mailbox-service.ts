import type { ExtractKind, InboxKind, Message } from "@core/domain";
import { Caller, DomainError, Extractors, Inbox, invalidArgument, Ulid } from "@core/domain";
import type {
  Clock,
  DomainRepository,
  EventBus,
  IdentityRepository,
  IdGenerator,
  InboxRepository,
  Secrets,
  WaitCriteria,
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
  readonly domains: DomainRepository;
  readonly identities: IdentityRepository;
  readonly events: EventBus;
  readonly waiter: Waiter;
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
