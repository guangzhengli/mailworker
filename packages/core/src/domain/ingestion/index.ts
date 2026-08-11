/**
 * ingestion — raw mail becomes a stored message.
 *
 * Depends on mailbox and identity. Two decisions live here, both pure: which
 * inbox an address resolves to (`AddressResolutionPolicy`, the reason one
 * catch-all rule is enough), and whether the sender is who they claim
 * (`SenderTrust`).
 */
export * from "@core/domain/ingestion/address-resolution-policy";
export * from "@core/domain/ingestion/sender-trust";
