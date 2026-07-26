import type { Deps, Operation } from "@core/application/deps";
import type { AuthContext, ExtractKind, Message } from "@core/domain";
import { AuthContext as AuthContextVO, Extract, invalidArgument, Ulid } from "@core/domain";
import type { WaitCriteria } from "@core/ports";

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

type Needs = "clock" | "waiter";

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
export function waitForMessage(
  deps: Pick<Deps, Needs>,
): Operation<WaitForMessageRequest, WaitOutcome> {
  return async (ctx: AuthContext, input: WaitForMessageRequest): Promise<WaitOutcome> => {
    AuthContextVO.require(ctx, "message:read");

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
      return { outcome: "timeout", waitedMs: deps.clock.now().getTime() - startedAt.getTime() };
    }

    return { outcome: "matched", message, extracted: extractFrom(message, input.extract) };
  };
}

function extractFrom(message: Message, kind: ExtractKind | undefined): string | null {
  if (kind === undefined || kind === "none") return null;
  // Prefer the text body; fall back to HTML so a text-free message still yields
  // a code. Tag stripping is crude on purpose — we only need the digits.
  const body = message.bodyText ?? (message.bodyHtml ?? "").replace(/<[^>]+>/g, " ");
  const haystack = `${message.subject}\n${body}`;
  return kind === "otp" ? Extract.otp(haystack) : Extract.firstLink(haystack);
}
