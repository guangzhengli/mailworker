/**
 * delivery — the gates in front of a send, and the fate of one afterwards.
 *
 * Depends on mailbox (a send comes from an inbox and archives a sent copy) and
 * identity (`SendPolicy` meters an `AgentIdentity`). A `Delivery` is one send
 * attempt plus everything we learn about it; the message body is not here, it
 * is in the blob store, so counting and transitioning stay cheap.
 */
export * from "@core/domain/delivery/delivery";
export * from "@core/domain/delivery/loop-breaker-policy";
export * from "@core/domain/delivery/send-policy";
export * from "@core/domain/delivery/sending-limits";
export * from "@core/domain/delivery/suppression";
