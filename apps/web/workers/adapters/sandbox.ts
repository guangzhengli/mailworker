import type {
  Caller,
  DispatchRequest,
  DispatchResult,
  LoopbackMessage,
  LoopbackSink,
  MailTransport,
} from "@mailworker/core";

/**
 * The transport for a `sandbox` environment: it never touches `send_email`.
 *
 * Everything upstream still runs — the seven gates, the state machine, the sent
 * copy in R2 — so a development send is indistinguishable from a production one
 * right up to the network call that does not happen. That is what makes a
 * development OTP safe: not a rule someone has to remember, but the absence of a
 * binding call.
 *
 * It reports success because the send did succeed at what a sandbox promises.
 * `delivery-service` synthesizes the `delivered` event and loops the bytes back
 * into a local inbox, since there is no provider to hear from later.
 */
export class SandboxTransport implements MailTransport {
  async dispatch(_ctx: Caller, message: DispatchRequest): Promise<DispatchResult> {
    return {
      ok: true,
      // Derived from our own Message-ID rather than randomly: it has to be
      // stable and unique, and this is already both.
      providerMessageId: `sandbox-${message.messageId}`,
      accepted: [...message.to, ...message.cc, ...message.bcc],
      queued: [],
      rejected: [],
    };
  }
}

/**
 * Picks the transport per request from the caller's environment.
 *
 * A wrapper rather than a branch inside `CloudflareTransport`, so that the class
 * that talks to the binding has no way to be reached in sandbox mode at all.
 */
export class ModeAwareTransport implements MailTransport {
  constructor(
    private readonly live: MailTransport,
    private readonly sandbox: MailTransport,
  ) {}

  async dispatch(ctx: Caller, message: DispatchRequest): Promise<DispatchResult> {
    const transport = ctx.mode === "sandbox" ? this.sandbox : this.live;
    return await transport.dispatch(ctx, message);
  }
}

/**
 * Feeds a sandbox send back through the inbound path.
 *
 * Late-bound because the sink calls the ingestion service, which is built from
 * the same dependency set that contains the transport. The composition root
 * constructs this first and binds it immediately after `createServices`, so the
 * cycle exists for the length of one function and never at call time.
 */
export class LateBoundLoopback implements LoopbackSink {
  private sink: LoopbackSink["deliver"] | null = null;

  bind(sink: LoopbackSink["deliver"]): void {
    this.sink = sink;
  }

  async deliver(ctx: Caller, message: LoopbackMessage): Promise<void> {
    if (this.sink === null) return;
    await this.sink(ctx, message);
  }
}

/** A sandbox with nowhere to loop back to — the default outside the Worker. */
export class NoLoopback implements LoopbackSink {
  async deliver(_ctx: Caller, _message: LoopbackMessage): Promise<void> {}
}
