import type { BlobMeta, BlobStore, Caller } from "@mailworker/core";

/** R2 refuses a delete of more than a thousand keys in one call. */
const MAX_DELETE_KEYS = 1000;

/**
 * Every original message, verbatim (ADR-3).
 *
 * Keeping the raw MIME is not archival sentiment — it is what makes
 * `mailworker get --raw > fixture.eml` into `mailworker inject fixture.eml` a
 * closed loop, so a strange production message becomes a regression test, and a
 * parser change can be replayed against everything ever received.
 */
export class R2Blobs implements BlobStore {
  constructor(private readonly bucket: R2Bucket) {}

  /**
   * Keys already begin with the account id (see `BlobKeys`), which is what keeps
   * one tenant's objects out of another's reach. `ctx` is still on the signature
   * so the port cannot be implemented by something that forgets to care.
   */
  async put(ctx: Caller, key: string, body: Uint8Array, meta?: BlobMeta): Promise<void> {
    assertOwned(ctx, key);
    await this.bucket.put(key, body, {
      httpMetadata: {
        ...(meta?.contentType === undefined ? {} : { contentType: meta.contentType }),
        ...(meta?.filename === undefined
          ? {}
          : { contentDisposition: contentDisposition(meta.filename) }),
      },
    });
  }

  async get(ctx: Caller, key: string): Promise<Uint8Array | null> {
    assertOwned(ctx, key);
    const object = await this.bucket.get(key);
    if (object === null) return null;
    return new Uint8Array(await object.arrayBuffer());
  }

  async delete(ctx: Caller, keys: readonly string[]): Promise<void> {
    const owned = keys.filter((key) => isOwned(ctx, key));
    for (let i = 0; i < owned.length; i += MAX_DELETE_KEYS) {
      await this.bucket.delete(owned.slice(i, i + MAX_DELETE_KEYS));
    }
  }
}

function isOwned(ctx: Caller, key: string): boolean {
  // `raw/{account}/…`, `att/{account}/…`, `out/{account}/…`
  return key.split("/")[1] === ctx.accountId;
}

/**
 * A key that does not belong to the caller's account is a bug in the layer that
 * built it, not something to serve.
 *
 * Blob keys are constructed from ids that arrive in requests, so this is the
 * point where a path assembled from an attacker-influenced id would otherwise
 * read another tenant's mail. Deletes filter instead of throwing, since a sweep
 * over a mixed key list should remove what it may and leave the rest.
 */
function assertOwned(ctx: Caller, key: string): void {
  if (!isOwned(ctx, key)) {
    throw new Error(`Blob key ${key} does not belong to account ${ctx.accountId}.`);
  }
}

/**
 * Filenames come from senders, so they can contain quotes, newlines and
 * anything else. RFC 6266 `filename*` carries the real name percent-encoded,
 * and the plain `filename` fallback is stripped to characters that cannot break
 * out of the header.
 */
function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\w.\- ]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
