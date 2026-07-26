CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `agent_identities` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`name` text NOT NULL,
	`send_as` text,
	`recipient_allowlist` text,
	`daily_send_quota` integer,
	`require_approval` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_identities_account_name` ON `agent_identities` (`account_id`,`name`);--> statement-breakpoint
CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`name` text NOT NULL,
	`prefix` text NOT NULL,
	`hash` text NOT NULL,
	`scopes` text NOT NULL,
	`identity_id` text,
	`last_used_at` text,
	`expires_at` text,
	`revoked_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_api_keys_prefix` ON `api_keys` (`prefix`);--> statement-breakpoint
CREATE TABLE `attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`message_id` text NOT NULL,
	`filename` text,
	`mime` text,
	`content_id` text,
	`size` integer DEFAULT 0 NOT NULL,
	`inline` integer DEFAULT false NOT NULL,
	`r2_key` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_attachments_message` ON `attachments` (`account_id`,`message_id`);--> statement-breakpoint
CREATE TABLE `delivery_events` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`delivery_id` text,
	`provider_msg_id` text,
	`recipient` text,
	`type` text NOT NULL,
	`terminal` integer DEFAULT false NOT NULL,
	`smtp_code` text,
	`smtp_response` text,
	`occurred_at` text NOT NULL,
	`raw` text
);
--> statement-breakpoint
CREATE INDEX `idx_events_delivery` ON `delivery_events` (`account_id`,`delivery_id`,`occurred_at`);--> statement-breakpoint
CREATE TABLE `domains` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`name` text NOT NULL,
	`zone_id` text,
	`inbound_enabled` integer DEFAULT false NOT NULL,
	`sending_status` text DEFAULT 'unverified' NOT NULL,
	`catchall_mode` text DEFAULT 'reject' NOT NULL,
	`catchall_inbox` text,
	`autocreate_pattern` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_domains_account_name` ON `domains` (`account_id`,`name`);--> statement-breakpoint
CREATE TABLE `inboxes` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`address` text NOT NULL,
	`local_part` text NOT NULL,
	`domain` text NOT NULL,
	`display_name` text,
	`kind` text DEFAULT 'ephemeral' NOT NULL,
	`identity_id` text,
	`metadata` text,
	`expires_at` text,
	`deleted_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_inboxes_account_address` ON `inboxes` (`account_id`,`address`);--> statement-breakpoint
CREATE INDEX `idx_inboxes_expiry` ON `inboxes` (`expires_at`) WHERE expires_at IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_inboxes_account` ON `inboxes` (`account_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`inbox_id` text NOT NULL,
	`rfc_message_id` text NOT NULL,
	`thread_id` text NOT NULL,
	`direction` text NOT NULL,
	`from_header` text NOT NULL,
	`from_addr` text,
	`to_header` text NOT NULL,
	`to_addrs` text NOT NULL,
	`cc_addrs` text NOT NULL,
	`bcc_addrs` text NOT NULL,
	`reply_to` text,
	`subject` text DEFAULT '' NOT NULL,
	`body_text` text,
	`body_html` text,
	`in_reply_to` text,
	`references_ids` text NOT NULL,
	`spf` text DEFAULT 'unknown' NOT NULL,
	`dkim` text DEFAULT 'unknown' NOT NULL,
	`dmarc` text DEFAULT 'unknown' NOT NULL,
	`trusted` integer DEFAULT false NOT NULL,
	`injection_risk` integer DEFAULT false NOT NULL,
	`trust_reasons` text NOT NULL,
	`spam_score` real,
	`tag` text,
	`auto_submitted` text,
	`raw_key` text,
	`size` integer DEFAULT 0 NOT NULL,
	`seen` integer DEFAULT false NOT NULL,
	`sent_at` text,
	`received_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_messages_account_rfc_id` ON `messages` (`account_id`,`rfc_message_id`);--> statement-breakpoint
CREATE INDEX `idx_messages_inbox` ON `messages` (`account_id`,`inbox_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_messages_thread` ON `messages` (`account_id`,`thread_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_messages_sent_between` ON `messages` (`account_id`,`direction`,`from_addr`,`received_at`);--> statement-breakpoint
CREATE TABLE `deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`inbox_id` text,
	`identity_id` text,
	`message_id` text,
	`idempotency_key` text,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`recipients` text NOT NULL,
	`payload_key` text,
	`provider_msg_id` text,
	`reject_reason` text,
	`last_error` text,
	`approved_by` text,
	`approved_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`status_changed_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_delivery_idempotency` ON `deliveries` (`account_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_delivery_status` ON `deliveries` (`account_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_delivery_provider_id` ON `deliveries` (`account_id`,`provider_msg_id`);--> statement-breakpoint
CREATE INDEX `idx_delivery_quota` ON `deliveries` (`account_id`,`identity_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `suppressions` (
	`account_id` text NOT NULL,
	`address` text NOT NULL,
	`reason` text NOT NULL,
	`source` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`account_id`, `address`)
);
--> statement-breakpoint
CREATE TABLE `webhooks` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`url` text NOT NULL,
	`secret` text NOT NULL,
	`events` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_webhooks_account` ON `webhooks` (`account_id`);