import type { RfcMessageId, Ulid } from "../domain/index.ts";

/**
 * Time. Injected so that "expires in 10 minutes" is testable without waiting ten
 * minutes, and so that a test can assert on exact timestamps.
 */
export interface ClockPort {
  now(): Date;
}

/**
 * Id generation. ULIDs need a clock and randomness, which is why the domain only
 * validates them (ADR-2) and minting lives out here — the test generator is
 * deterministic, so assertions can name ids literally.
 */
export interface IdGeneratorPort {
  ulid(): Ulid;
  /** A Message-ID for an outbound message, e.g. `<01J…@example.com>` sans brackets. */
  rfcMessageId(domain: string): RfcMessageId;
  /** Opaque random token, used for API keys and webhook secrets. */
  secret(byteLength?: number): string;
}

/** Hashing for API keys and webhook signatures. Needs WebCrypto, so it is a port. */
export interface TokenHasherPort {
  hash(plaintext: string): Promise<string>;
  /** Constant-time comparison. */
  verify(plaintext: string, hash: string): Promise<boolean>;
}
