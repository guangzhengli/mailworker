/**
 * Where a blob lives, decided once.
 *
 * This is a domain decision, not a storage-adapter detail: `Message.rawKey`
 * quotes one of these strings back, repositories retain body/attachment keys,
 * and the retention sweep deletes by the same
 * layout. A reader and a sweeper that disagree about the shape of a key leak
 * objects forever, so there is exactly one place that spells it.
 */
export const BlobKeys = {
  rawMessage(accountId: string, messageId: string): string {
    return `raw/${accountId}/${messageId}.eml`;
  },
  messageBody(accountId: string, messageId: string): string {
    return `body/${accountId}/${messageId}.json`;
  },
  attachment(accountId: string, messageId: string, attachmentId: string): string {
    return `att/${accountId}/${messageId}/${attachmentId}`;
  },
  deliveryPayload(accountId: string, deliveryId: string): string {
    return `out/${accountId}/${deliveryId}.json`;
  },
} as const;
