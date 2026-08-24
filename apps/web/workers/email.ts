import { MAX_INBOUND_MESSAGE_BYTES } from "@mailworker/core";
import { createContainer } from "@web/workers/container";
import { systemCaller } from "@web/workers/environment";

/**
 * Inbound mail, straight off Cloudflare Email Routing.
 *
 * A catch-all rule on the zone points every address at this Worker, which is
 * what lets an inbox be created by an API call instead of by adding a routing
 * rule — and why the 200-rules-per-domain ceiling never applies (DESIGN §2.1).
 *
 * Thin on purpose. It reads bytes, calls one service method, and translates the
 * outcome into an SMTP-level decision. Every rule about what happens to a
 * message lives in `ingestion.ingest`, where it can be tested without workerd.
 */
export async function email(message: ForwardableEmailMessage, env: Env): Promise<void> {
  // Reject before buffering. Email Routing supplies the exact raw byte count,
  // and a 25 MiB message can otherwise be copied several times by MIME parsing
  // inside a Worker with a finite memory budget.
  if (message.rawSize > MAX_INBOUND_MESSAGE_BYTES) {
    message.setReject(`Message exceeds the ${MAX_INBOUND_MESSAGE_BYTES} byte limit.`);
    return;
  }

  const container = createContainer(env);

  // The recipient's domain is what decides the environment: `dev.mail.example.com`
  // lands in development, `mail.example.com` in production. An unknown hostname
  // falls back to the default environment, where routing will reject it.
  const domain = message.to.split("@")[1]?.toLowerCase() ?? null;
  const accountId =
    (domain === undefined || domain === null
      ? null
      : await container.domains.resolveAccount(domain)) ?? container.defaultAccountId;

  const { services } = container;
  const ctx = await systemCaller(container, accountId, "system:email");

  const raw = new Uint8Array(message.rawSize);
  const reader = message.raw.getReader();
  let offset = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.byteLength > raw.byteLength) {
        message.setReject("Raw message size did not match the routing envelope.");
        await reader.cancel("raw size mismatch");
        return;
      }
      raw.set(value, offset);
      offset += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  if (offset !== raw.byteLength) {
    message.setReject("Raw message size did not match the routing envelope.");
    return;
  }

  const result = await services.ingestion.ingest(ctx, {
    recipient: message.to,
    envelopeFrom: message.from,
    raw,
    origin: "email",
  });

  switch (result.outcome) {
    case "stored":
      return;

    case "duplicate":
      // Email Routing retries, and a retry that we already stored is a success
      // from the sender's point of view. Rejecting here would tell an honest
      // sender their mail bounced when it is sitting in the inbox.
      return;

    case "unroutable":
      // A real SMTP rejection, so the sender learns immediately rather than
      // believing the mail was delivered. Silently dropping unknown addresses
      // is what makes a catch-all domain a spam sink.
      message.setReject(`No inbox accepts mail at ${message.to}.`);
      return;

    case "inbox_unavailable":
      // The address is ours but the inbox is expired or disabled. Same
      // reasoning as above: a bounce is information, a silent drop is not.
      message.setReject(`The inbox at ${message.to} is no longer accepting mail.`);
      return;
  }
}
