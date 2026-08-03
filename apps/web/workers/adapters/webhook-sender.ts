import type { WebhookRequest, WebhookSender } from "@mailworker/core";
import { WebhookSignature } from "@mailworker/core";

/** Give up on one attempt rather than holding a queue slot on a dead host. */
const TIMEOUT_MS = 10_000;

/**
 * Signed webhook delivery, in the Standard Webhooks format.
 *
 * Implemented directly rather than with the `standardwebhooks` package, and the
 * reason is not the 28 KB: the library ships its own JavaScript SHA-256, and
 * a Worker already has HMAC in WebCrypto. Paying for a second implementation of
 * a primitive the platform provides is what the dependency budget exists to catch.
 *
 * The format is somebody else's on purpose. Svix, Resend, Clerk and Vercel all
 * send these three headers, so a receiver integrating with Mailworker probably
 * already has a verifier, and anyone who does not can reach for an off-the-shelf
 * library instead of reading our documentation. Inventing a signing scheme here
 * would have bought nothing and cost every integrator an afternoon.
 */
export class SigningWebhookSender implements WebhookSender {
  async deliver(request: WebhookRequest): Promise<void> {
    const timestamp = Math.floor(request.timestamp.getTime() / 1000);
    const signature = await sign(
      request.secret,
      WebhookSignature.signingInput(request.messageId, timestamp, request.body),
    );

    const response = await fetch(request.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "webhook-id": request.messageId,
        "webhook-timestamp": String(timestamp),
        "webhook-signature": WebhookSignature.header(signature),
        "User-Agent": "Mailworker/1.0",
      },
      body: request.body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    // Throwing is how the queue is told to retry, and Cloudflare owns the
    // backoff and the dead-letter queue. Any non-2xx retries — including a 4xx,
    // which for a webhook usually means the receiver deployed a bad handler
    // rather than that we sent something wrong, and giving up on it silently
    // would lose events during someone else's rollback.
    if (!response.ok) {
      throw new Error(`${request.url} answered ${response.status}`);
    }
  }
}

/**
 * HMAC-SHA256, base64.
 *
 * The secret is stored with a `whsec_` prefix for the same reason as an API
 * key's prefix — so it is recognisable in a log — and the prefix is stripped
 * before signing, because it is a label rather than key material.
 */
async function sign(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret.replace(/^whsec_/, "")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return btoa(String.fromCharCode(...new Uint8Array(mac)));
}
