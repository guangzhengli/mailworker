/**
 * ingestion — raw mail becomes a stored message.
 *
 * Depends on mailbox and identity. Three decisions live here, all pure: which
 * inbox an address resolves to (`AddressResolutionPolicy`, the reason one
 * catch-all rule is enough), whether the sender is who they claim
 * (`SenderTrust`), and how to pull the useful bit out of a body (`Extractors`,
 * which is what `wait --extract otp` prints).
 */
export * from "@core/domain/ingestion/address-resolution-policy";
export * from "@core/domain/ingestion/extractors";
export * from "@core/domain/ingestion/sender-trust";
