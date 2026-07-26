import type { Deps, Operation } from "@core/application/deps";
import type { AuthContext, Inbox, InboxKind } from "@core/domain";
import {
  AuthContext as AuthContextVO,
  DomainError,
  Inbox as InboxVO,
  invalidArgument,
} from "@core/domain";

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

type Needs = "clock" | "ids" | "inboxes" | "domains" | "identities" | "events";

/**
 * Mint a receiving address.
 *
 * Worth noting what this does NOT do: it never calls the Cloudflare API. Inboxes
 * live behind one catch-all routing rule (DESIGN.md §2.1), so creating one is a
 * single database insert. That is what makes it reasonable for a test suite to
 * create a fresh inbox per case instead of sharing one and cleaning up after.
 */
export function createInbox(deps: Pick<Deps, Needs>): Operation<CreateInboxRequest, Inbox> {
  return async (ctx: AuthContext, input: CreateInboxRequest): Promise<Inbox> => {
    AuthContextVO.require(ctx, "inbox:write");
    const now = deps.clock.now();

    if (input.address !== undefined && input.prefix !== undefined) {
      throw invalidArgument("Pass either `address` or `prefix`, not both.");
    }

    let address = input.address;
    if (address === undefined) {
      const domain = await resolveDomain(deps, ctx, input.domain);
      const suffix = deps.ids.secret(RANDOM_SUFFIX_BYTES);
      address = `${input.prefix ?? "inbox"}-${suffix}@${domain}`;
    }

    const kind: InboxKind = input.kind ?? "ephemeral";
    const expiresAt =
      kind === "persistent"
        ? null
        : InboxVO.expiryFromTtl(now, input.ttlMs ?? DEFAULT_EPHEMERAL_TTL_MS);

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

    const inbox = InboxVO.create({
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
  };
}

async function resolveDomain(
  deps: Pick<Deps, "domains">,
  ctx: AuthContext,
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
