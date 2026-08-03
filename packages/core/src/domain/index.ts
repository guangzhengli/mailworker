/**
 * The domain, as four bounded contexts plus the vocabulary they share.
 *
 * The dependency direction is one-way and enforced by `test/architecture.test.ts`:
 *
 *     identity  ←  mailbox  ←  ingestion
 *                     ↑
 *                  delivery
 *
 * Read a context's own `index.ts` to learn what it is for. Nothing below the
 * contexts may import one, which is what keeps `errors`/`events`/`ulid` from
 * quietly becoming a fifth context.
 */

export * from "@core/domain/blob-keys";
export * from "@core/domain/delivery";
export * from "@core/domain/email-address";
export * from "@core/domain/errors";
// `events` is the one exception: it names facts from every context, so it is
// allowed to import all four. Nothing imports it back.
export * from "@core/domain/events";
export * from "@core/domain/identity";
export * from "@core/domain/ingestion";
export * from "@core/domain/mailbox";
export * from "@core/domain/pagination";
export * from "@core/domain/ports";
export * from "@core/domain/ulid";
