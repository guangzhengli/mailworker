import type { RfcMessageId, Ulid } from "@core/domain";

/**
 * Time. Injected so that "expires in 10 minutes" is testable without waiting ten
 * minutes, and so that a test can assert on exact timestamps.
 */
export interface Clock {
  now(): Date;
}

/**
 * Id generation. ULIDs need a clock and randomness, which is why the domain only
 * validates them (ADR-2) and minting lives out here — the test generator is
 * deterministic, so assertions can name ids literally.
 *
 * Ids only. Minting a *credential* is a different concern with a different
 * threat model (it has to be unguessable, and it is immediately hashed), so it
 * lives on `Secrets` next door.
 */
export interface IdGenerator {
  ulid(): Ulid;
  /** A Message-ID for an outbound message, e.g. `<01J…@example.com>` sans brackets. */
  rfcMessageId(domain: string): RfcMessageId;
}

/**
 * Bearer credentials: minting them, hashing them, checking them.
 *
 * One port rather than a generator and a hasher, because the three operations
 * are only ever used together and only make sense together — a token this
 * interface did not mint is a token it cannot promise anything about. Needs
 * WebCrypto, so it cannot live in the domain.
 */
export interface Secrets {
  /** Opaque random token, used for API keys and webhook secrets. */
  generate(byteLength?: number): string;
  hash(plaintext: string): Promise<string>;
  /** Constant-time comparison. */
  verify(plaintext: string, hash: string): Promise<boolean>;
}
