import type { Clock, IdGenerator, Secrets } from "@mailworker/core";
import { RfcMessageId, Ulid } from "@mailworker/core";
import { monotonicFactory } from "ulid";

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/**
 * ULIDs from the `ulid` package's MONOTONIC factory, which is the whole reason
 * to take the dependency rather than write twelve lines.
 *
 * ADR-2 makes `messages.id` both the primary key and the keyset pagination
 * cursor, which only works if ids are strictly increasing. A plain
 * `timestamp + random` ULID is not: two messages minted in the same millisecond
 * get independent random tails, so their relative order is a coin flip. That is
 * not a rare case here — a Queues batch, a burst of inbound mail, or `inject`
 * replaying a fixture directory all mint several ids per millisecond, and a
 * cursor that lands between two of them silently skips or repeats a row.
 *
 * `monotonicFactory` increments the random component instead when the clock has
 * not advanced, so ties break in creation order.
 *
 * One factory per isolate is correct and sufficient: monotonicity only has to
 * hold within a millisecond, and two isolates cannot both be minting inside the
 * same one without also disagreeing about the clock.
 */
export class UlidGenerator implements IdGenerator {
  private readonly next = monotonicFactory();

  ulid(): Ulid {
    return Ulid.parse(this.next());
  }

  rfcMessageId(domain: string): RfcMessageId {
    return RfcMessageId.parse(`${this.next()}@${domain}`);
  }
}

export class WebCryptoSecrets implements Secrets {
  generate(byteLength = 24): string {
    const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
    return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  async hash(plaintext: string): Promise<string> {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(plaintext));
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  /**
   * Constant time in the comparison, which is what matters: both sides are
   * fixed-length hex digests of the same digest function, so a length mismatch
   * cannot leak anything about a real secret.
   */
  async verify(plaintext: string, hash: string): Promise<boolean> {
    const actual = await this.hash(plaintext);
    if (actual.length !== hash.length) return false;
    let diff = 0;
    for (let i = 0; i < actual.length; i++) {
      diff |= actual.charCodeAt(i) ^ hash.charCodeAt(i);
    }
    return diff === 0;
  }
}
