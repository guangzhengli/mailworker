/**
 * mailbox — the core domain: addresses we own, inboxes, stored messages, threads.
 *
 * Depends on identity (an inbox belongs to an account and may act as an agent
 * identity) and on nothing downstream. Both directions of mail land here: a
 * `Message` is inbound or outbound, one shape, because threading has to resolve
 * across both and an agent asking "what happened in this conversation" should
 * not have to union two schemas.
 */

export * from "@core/domain/mailbox/inbox";
export * from "@core/domain/mailbox/mailbox-address";
export * from "@core/domain/mailbox/message";
export * from "@core/domain/mailbox/message-id";
export * from "@core/domain/mailbox/retention-policy";
export * from "@core/domain/mailbox/sender-auth";
export * from "@core/domain/mailbox/threading-policy";
export * from "@core/domain/mailbox/wait-criteria";
