export type EnvironmentMode = "live" | "sandbox" | "test";
export type Scope =
  | "inbox:read"
  | "inbox:write"
  | "message:read"
  | "message:send"
  | "message:inject"
  | "message:approve"
  | "admin";

export interface RequestOptions {
  readonly signal?: AbortSignal;
  /** Per HTTP attempt. Defaults to the client-level timeout. */
  readonly timeoutMs?: number;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly cursor: string | null;
}

export interface PageQuery {
  readonly limit?: number;
  readonly cursor?: string;
  readonly order?: "asc" | "desc";
}

export interface PaginatorOptions extends RequestOptions {
  /** Required total bound across every page. */
  readonly maxItems: number;
  readonly pageSize?: number;
}

export interface AgentIdentity {
  readonly id: string;
  readonly name: string;
  readonly sendAs: string | null;
  readonly recipientAllowlist: readonly string[] | null;
  readonly dailySendQuota: number | null;
  readonly requireApproval: boolean;
  readonly createdAt: string;
}

export interface Capabilities {
  readonly apiVersion: "v1";
  readonly serverTime: string;
  readonly environment: { readonly id: string; readonly mode: EnvironmentMode };
  readonly principal: {
    readonly subject: string;
    readonly identityId: string | null;
    readonly identity: AgentIdentity | null;
    readonly scopes: readonly Scope[];
  };
  readonly domains: readonly {
    readonly domain: string;
    readonly sendingStatus: string;
    readonly catchAllMode: "reject" | "store" | "autocreate";
  }[];
  readonly features: {
    readonly receiving: boolean;
    readonly sending: boolean;
    readonly sandboxLoopback: boolean;
    readonly approvals: true;
    readonly longPolling: true;
    readonly deliveryTimeline: true;
    readonly webhooksConfigured: boolean;
    readonly typescriptSdk: true;
    readonly labels: boolean;
    readonly notes: boolean;
  };
  readonly limits: {
    readonly maxPageSize: number;
    readonly maxWaitMs: number;
    readonly maxWaitMatchTextBytes: number;
    readonly maxRecipients: number;
    /** @deprecated Use maxOutboundMessageBytes. */
    readonly maxMessageBytes: number;
    readonly maxInboundMessageBytes: number;
    readonly maxOutboundMessageBytes: number;
    readonly maxAttachments: number;
    readonly maxCustomHeaderBytes: number;
    readonly maxBatchSize: number;
  };
  readonly actions: {
    readonly readInboxes: boolean;
    readonly createInboxes: boolean;
    readonly readMessages: boolean;
    readonly annotateMessages: boolean;
    readonly injectMessages: boolean;
    readonly sendMessages: boolean;
    readonly approveMessages: boolean;
    readonly administer: boolean;
  };
}

export interface CreateInboxInput {
  readonly address?: string;
  readonly localPart?: string;
  readonly prefix?: string;
  readonly domain?: string;
  readonly kind?: "ephemeral" | "persistent";
  readonly ttl?: number | string;
  readonly muted?: boolean;
  readonly displayName?: string;
  readonly identity?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface ListInboxesQuery extends PageQuery {
  readonly kind?: "ephemeral" | "persistent";
  readonly domain?: string;
  readonly includeExpired?: boolean;
  readonly muted?: boolean;
}

export interface Inbox {
  readonly id: string;
  readonly address: string;
  readonly localPart: string;
  readonly domain: string;
  readonly displayName: string | null;
  readonly kind: "ephemeral" | "persistent";
  readonly muted: boolean;
  readonly identityId: string | null;
  readonly metadata: Readonly<Record<string, string>> | null;
  readonly expiresAt: string | null;
  readonly createdAt: string;
}

export interface UpdateInboxInput {
  readonly muted?: boolean;
  readonly displayName?: string | null;
}

export interface Attachment {
  readonly id: string;
  readonly filename: string | null;
  readonly mime: string | null;
  readonly contentId: string | null;
  readonly size: number;
  readonly inline: boolean;
}

export interface MessageBase {
  readonly id: string;
  readonly inboxId: string;
  readonly identityId: string | null;
  readonly messageId: string;
  readonly threadId: string;
  readonly direction: "inbound" | "outbound";
  readonly origin: "email" | "injected" | "sandbox" | "outbound";
  /** Always untrusted for inbound content, even when authentication passes. */
  readonly contentTrust: "untrusted" | "authored";
  readonly fromHeader: string;
  readonly from: string | null;
  readonly toHeader: string;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  readonly replyTo: string | null;
  readonly subject: string;
  readonly inReplyTo: string | null;
  readonly references: readonly string[];
  readonly provenance: {
    readonly trusted: boolean;
    readonly reasons: readonly string[];
    readonly spf: string;
    readonly dkim: string;
    readonly dmarc: string;
  };
  readonly tag: string | null;
  readonly autoSubmitted: string | null;
  readonly size: number;
  readonly seen: boolean;
  readonly starred: boolean;
  readonly archivedAt: string | null;
  readonly labels: readonly string[];
  readonly sentAt: string | null;
  readonly receivedAt: string;
}

export interface Unsubscribe {
  readonly https: string | null;
  readonly mailto: string | null;
  readonly oneClick: boolean;
}

export interface Message extends MessageBase {
  readonly listId: string | null;
  readonly unsubscribe: Unsubscribe | null;
  readonly bodyText: string | null;
  readonly bodyHtml: string | null;
  readonly attachments: readonly Attachment[];
}

export interface MessageSummary extends MessageBase {
  readonly attachmentCount: number;
  readonly noteCount: number;
  readonly hasText: boolean;
  readonly hasHtml: boolean;
  readonly preview: string;
}

export interface ListMessagesQuery extends PageQuery {
  readonly inbox?: string;
  readonly thread?: string;
  readonly direction?: "inbound" | "outbound";
  readonly from?: string;
  readonly seen?: boolean;
  readonly label?: string;
  readonly starred?: boolean;
  readonly archived?: boolean;
  readonly muted?: boolean;
  readonly q?: string;
  readonly after?: string;
}

export interface UpdateMessageInput {
  readonly seen?: boolean;
  readonly starred?: boolean;
  readonly archived?: boolean;
  readonly labels?: {
    readonly add?: readonly string[];
    readonly remove?: readonly string[];
  };
}

export interface UpdateMessagesResult {
  readonly updated: number;
}

export interface Label {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
}

export interface LabelUsage extends Label {
  readonly messageCount: number;
  readonly unreadCount: number;
  readonly lastUsedAt: string | null;
}

export interface Note {
  readonly id: string;
  readonly messageId: string;
  readonly authorSubject: string;
  readonly authorIdentityId: string | null;
  readonly body: string;
  readonly createdAt: string;
}

export interface WaitForMessageInput {
  readonly inbox?: string;
  readonly from?: string;
  readonly subject?: string;
  readonly match?: string;
  readonly after?: string;
  readonly timeout?: number | string;
}

export type WaitForMessageResult =
  | { readonly outcome: "matched"; readonly message: Message }
  | { readonly outcome: "timeout"; readonly waitedMs: number };

export interface InjectMessageInput {
  readonly to: string;
  readonly from?: string;
  readonly raw: string | Uint8Array | ArrayBuffer;
}

export type InjectMessageResult =
  | { readonly outcome: "stored"; readonly message: Message }
  | { readonly outcome: "duplicate"; readonly messageId: string };

export interface AttachmentInput {
  readonly filename: string;
  readonly type?: string;
  /** Base64-encoded bytes. */
  readonly content: string;
  readonly contentId?: string;
}

export interface SendInput {
  readonly from: string;
  readonly to: readonly string[];
  readonly cc?: readonly string[];
  readonly bcc?: readonly string[];
  readonly subject: string;
  readonly text?: string;
  readonly html?: string;
  readonly replyTo?: string;
  readonly inReplyTo?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly attachments?: readonly AttachmentInput[];
  readonly metadata?: Readonly<Record<string, string>>;
  readonly idempotencyKey?: string;
  readonly automated?: boolean;
}

export type DeliveryStatus =
  | "draft"
  | "pending_approval"
  | "queued"
  | "dispatching"
  | "dispatched"
  | "deferred"
  | "delivered"
  | "bounced"
  | "complained"
  | "failed"
  | "rejected";

export interface Delivery {
  readonly id: string;
  readonly inboxId: string | null;
  readonly identityId: string | null;
  readonly messageId: string | null;
  readonly idempotencyKey: string | null;
  readonly metadata: Readonly<Record<string, string>>;
  readonly status: DeliveryStatus;
  readonly attempts: number;
  readonly recipients: readonly string[];
  readonly providerMessageId: string | null;
  readonly rejectReason: string | null;
  readonly lastError: string | null;
  readonly approvedBy: string | null;
  readonly approvedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface DeliveryEvent {
  readonly id: string;
  readonly eventId: string | null;
  readonly type: string;
  readonly recipient: string | null;
  readonly sourceDomain: string | null;
  readonly sourceZoneId: string | null;
  readonly terminal: boolean;
  readonly smtpCode: string | null;
  readonly smtpEnhancedCode: string | null;
  readonly smtpResponse: string | null;
  readonly bounceType: "hard" | "soft" | null;
  readonly bounceClassification: string | null;
  readonly bounceReason: string | null;
  readonly occurredAt: string;
  readonly raw: string | null;
}

export interface DeliveryTimeline {
  readonly delivery: Delivery;
  readonly events: readonly DeliveryEvent[];
}

export type SendResult = {
  readonly outcome: "queued" | "pending_approval" | "duplicate";
  readonly delivery: Delivery;
};

export type SendBatchItem =
  | ({ readonly index: number } & SendResult)
  | {
      readonly index: number;
      readonly outcome: "error";
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly details: Readonly<Record<string, unknown>>;
      };
    };

export interface SendBatchResult {
  readonly items: readonly SendBatchItem[];
  readonly accepted: number;
  readonly failed: number;
}

export interface ListDeliveriesQuery extends PageQuery {
  readonly status?: DeliveryStatus;
  readonly identity?: string;
  readonly q?: string;
}

export interface WaitForDeliveryOptions extends RequestOptions {
  /** Default: any successful or failed final delivery status. */
  readonly until?: DeliveryStatus | readonly DeliveryStatus[] | "terminal";
  readonly maxWaitMs?: number;
  readonly pollIntervalMs?: number;
}

export interface Environment {
  readonly id: string;
  readonly projectId: string;
  readonly env: string;
  readonly name: string;
  readonly mode: EnvironmentMode;
  readonly createdAt: string;
}

export interface CreateEnvironmentInput {
  readonly env: string;
  readonly name?: string;
  readonly mode: EnvironmentMode;
  readonly domain?: string;
}

export interface CreateIdentityInput {
  readonly name: string;
  readonly sendAs?: string | null;
  readonly recipientAllowlist?: readonly string[] | null;
  readonly dailySendQuota?: number | null;
  readonly requireApproval?: boolean;
}

export interface ApiKey {
  readonly id: string;
  readonly name: string;
  readonly prefix: string;
  readonly scopes: readonly string[];
  readonly identityId: string | null;
  readonly lastUsedAt: string | null;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
  readonly createdAt: string;
}

export interface CreateKeyInput {
  readonly name: string;
  readonly scopes: readonly Scope[];
  readonly identityName?: string;
  readonly expiresAt?: string;
}

export interface MintedApiKey extends ApiKey {
  /** Returned once. Mailworker does not store the plaintext token. */
  readonly token: string;
}

export interface Webhook {
  readonly id: string;
  readonly url: string;
  readonly events: readonly string[];
  readonly enabled: boolean;
  readonly createdAt: string;
}

export interface CreateWebhookInput {
  readonly url: string;
  readonly events?: readonly string[];
}

export interface CreatedWebhook extends Webhook {
  /** Returned once. */
  readonly secret: string;
}

export interface Suppression {
  readonly address: string;
  readonly reason: "hard_bounce" | "soft_bounce" | "complaint" | "manual";
  readonly source: "cf_sync" | "local";
  readonly createdAt: string;
}

export interface Diagnostics {
  readonly domains: readonly {
    readonly domain: string;
    readonly status: "pass" | "warn" | "fail" | "unknown";
    readonly checks: readonly {
      readonly name: string;
      readonly status: "pass" | "warn" | "fail" | "unknown";
      readonly detail: string;
      readonly fix?: string;
    }[];
  }[];
  readonly deployment: {
    readonly sendingConfigured: boolean;
    readonly dispatchQueueConfigured: boolean;
  };
}
